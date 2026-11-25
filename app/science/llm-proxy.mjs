#!/usr/bin/env node
/**
 * Local OpenAI-compatible gateway for the lab model pool.
 *
 * - Injects the API key and reasoning effort so neither lives in opencode config.
 * - Keeps one DeepWorks session on one upstream IP (rendezvous hashing), which keeps the
 *   provider-side prefix cache warm across turns.
 * - Fails over to another IP when an upstream refuses or returns 5xx before any body is sent.
 * - Sticks to 127.0.0.1 only.
 *
 * Usage: node llm-proxy.mjs --port 18080 --ips 10.0.0.13,10.0.0.14 --key-file ../../data/secrets.json
 */
import { createServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const port = Number(arg('port', 18080))
const upstreamPort = Number(arg('upstream-port', 18000))
const ips = String(arg('ips', '10.200.201.13,10.200.201.14,10.200.201.15'))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const reasoning = arg('reasoning', 'max')
const keyFile = arg('key-file', join(here, '..', '..', 'data', 'secrets.json'))
const logPath = arg('log', join(here, '..', '..', 'data', 'llm-proxy.log'))
const upstreamTimeoutMs = Number(arg('timeout-ms', 600000))
const maxOutputTokens = Number(arg('max-output-tokens', 30000))
const outputTokenField = String(arg('output-token-field', 'max_tokens'))
const activeExchanges = new Set()
/** Keep a failed node out of rotation long enough that a permanently dead IP costs one stall, not one per minute. */
const DOWN_MS = 300000
const MAX_BODY = 64 * 1024 * 1024

if (!Number.isInteger(port) || port <= 0) throw new Error('Invalid --port')
if (ips.length === 0) throw new Error('At least one upstream IP is required')
if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('Invalid --max-output-tokens')
if (!['max_tokens', 'max_completion_tokens'].includes(outputTokenField)) throw new Error('Invalid --output-token-field')

function readKey() {
  if (process.env.SCIENCE_API_KEY) return process.env.SCIENCE_API_KEY
  if (!existsSync(keyFile)) throw new Error(`Missing API key file: ${keyFile}`)
  const parsed = JSON.parse(readFileSync(keyFile, 'utf8'))
  if (typeof parsed.apiKey !== 'string' || !parsed.apiKey) throw new Error('API key file must contain {"apiKey": "..."}')
  return parsed.apiKey
}
const apiKey = readKey()

function log(line) {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break serving */
  }
}

/** Hash only breaks ties: the primary goal is an even split of live sessions across nodes. */
function score(session, ip) {
  return createHash('sha256').update(`${session}\u0000${ip}`).digest().readUInt32BE(0)
}
const downUntil = new Map()
const isDown = (ip) => (downUntil.get(ip) ?? 0) > Date.now()
/** session -> { ip, lastSeen }; released explicitly by the plugin or after the TTL. */
const assignments = new Map()
const assignmentTtlMs = Math.max(60000, Number(arg('assignment-ttl-ms', 24 * 60 * 60 * 1000)))

function pruneAssignments() {
  const now = Date.now()
  for (const [session, value] of assignments) if (now - value.lastSeen > assignmentTtlMs) assignments.delete(session)
}

function countsByIp() {
  const counts = new Map(ips.map((ip) => [ip, 0]))
  for (const value of assignments.values()) if (counts.has(value.ip)) counts.set(value.ip, counts.get(value.ip) + 1)
  return counts
}

/** Least-loaded healthy node first; a session keeps its node while that node is healthy. */
function choose(session) {
  pruneAssignments()
  const existing = assignments.get(session)
  if (existing && !isDown(existing.ip)) {
    existing.lastSeen = Date.now()
    return existing.ip
  }
  const healthy = ips.filter((ip) => !isDown(ip))
  const pool = healthy.length > 0 ? healthy : ips
  const counts = countsByIp()
  let best = pool[0]
  let bestCount = Number.POSITIVE_INFINITY
  let bestScore = -1
  for (const ip of pool) {
    const count = counts.get(ip) ?? 0
    const value = score(session, ip)
    if (count < bestCount || (count === bestCount && value > bestScore)) {
      best = ip
      bestCount = count
      bestScore = value
    }
  }
  assignments.set(session, { ip: best, lastSeen: Date.now() })
  return best
}

function order(session, preferred) {
  const healthy = ips.filter((ip) => !isDown(ip))
  const pool = healthy.length > 0 ? healthy : ips
  return [preferred, ...pool.filter((ip) => ip !== preferred)]
}

/** Provider tests and other session-less calls use the least-loaded node without taking a session slot. */
function anonymousPick() {
  const healthy = ips.filter((ip) => !isDown(ip))
  const pool = healthy.length > 0 ? healthy : ips
  const counts = countsByIp()
  let best = pool[0]
  let bestCount = Number.POSITIVE_INFINITY
  for (const ip of pool) {
    const count = counts.get(ip) ?? 0
    if (count < bestCount) {
      best = ip
      bestCount = count
    }
  }
  return best
}

function releaseAssignment(session) {
  return assignments.delete(session)
}

function headersFor(req, bodyLength) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) continue
    if (['host', 'content-length', 'authorization', 'connection', 'accept-encoding'].includes(name)) continue
    headers[name] = value
  }
  headers.authorization = `Bearer ${apiKey}`
  headers['content-length'] = String(bodyLength)
  return headers
}

function shapeBody(raw, method, url) {
  if (!raw.length || method !== 'POST' || !url.includes('/chat/completions')) return raw
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return raw
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Chat request must be a JSON object')
  const aliases = ['max_tokens', 'max_completion_tokens', 'max_output_tokens']
  const requested = aliases.filter(key => body[key] !== undefined && body[key] !== null).map(key => body[key])
  if (requested.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Output token limits must be positive integers')
  const effective = Math.min(maxOutputTokens, ...requested)
  for (const key of aliases) delete body[key]
  body[outputTokenField] = effective
  if (reasoning && body.reasoning_effort === undefined) body.reasoning_effort = reasoning
  if (body.stream === true && body.stream_options === undefined) body.stream_options = { include_usage: true }
  return Buffer.from(JSON.stringify(body))
}

/** Inspect bounded response metadata without changing bytes or interpreting tool arguments. */
function responseAudit(contentType) {
  const decoder = new StringDecoder('utf8'), toolIds = new Set()
  let pending = '', tail = '', finish = null, usage = null, truncated = false
  const read = data => {
    if (data?.usage) usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
    for (const choice of data?.choices ?? []) {
      if (choice.finish_reason) finish = choice.finish_reason
      const value = choice.delta ?? choice.message ?? {}
      for (const [i, call] of (value.tool_calls ?? []).entries()) toolIds.add(`${choice.index ?? 0}:${call.index ?? i}`)
      if (typeof value.content === 'string') tail = (tail + value.content).slice(-4096)
    }
  }
  return {
    chunk(chunk) {
      pending += decoder.write(chunk)
      if (pending.length > 1048576) { pending = pending.slice(-4096); truncated = true }
      if (!contentType.includes('text/event-stream')) return
      pending = pending.replace(/\r\n/g, '\n')
      let at
      while ((at = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, at); pending = pending.slice(at + 2)
        const value = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (value && value !== '[DONE]') try { read(JSON.parse(value)) } catch {}
      }
    },
    end() {
      pending += decoder.end()
      if (!contentType.includes('text/event-stream')) try { read(JSON.parse(pending)) } catch {}
      return { finish, toolCalls: toolIds.size, usage, textToolEnvelope: /<\/[｜|]DSML[｜|]tool_calls\s*>/.test(tail), truncated }
    },
  }
}

const server = createServer((req, res) => {
  const started = Date.now()
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        ips,
        down: ips.filter(isDown),
        sessions: assignments.size,
        assignments: Object.fromEntries(countsByIp()),
        port, maxOutputTokens, outputTokenField, inflight: activeExchanges.size,
      }),
    )
    return
  }
  const chunks = []
  req.on('error', error => { log(`request input error: ${error.message}`); res.destroy() })
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY) {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Request body too large' } }))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    const raw = Buffer.concat(chunks)
    if (req.url === '/release') {
      let session = String(req.headers['x-dw-session'] || '')
      try {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (typeof parsed?.sessionId === 'string') session = parsed.sessionId
      } catch {
        /* header fallback is enough */
      }
      const released = session ? releaseAssignment(session) : false
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ released, session }))
      return
    }
    let body
    try { body = shapeBody(raw, req.method, req.url) }
    catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: error.message } }))
      return
    }
    const headerSession = String(req.headers['x-dw-session'] || req.headers['x-session-id'] || '')
    const session = headerSession || null
    const preferred = session ? choose(session) : anonymousPick()
    const candidates = order(session, preferred)
    const label = session ?? 'anonymous'
    try {
      const request = JSON.parse(body.toString('utf8'))
      log(`${label} request ${JSON.stringify({ model: request.model, outputTokenField, outputLimit: request[outputTokenField], tools: request.tools?.length ?? 0, purpose: req.headers['x-mars-request-kind'] ?? 'unspecified' })}`)
    } catch {}
    let index = 0, terminal = false, activeRequest = null, activeResponse = null
    const cancel = (reason = 'client-cancelled') => {
      if (terminal) return
      terminal = true
      activeResponse?.destroy(); activeRequest?.destroy(); res.destroy()
      log(`${label} ${reason} ${Date.now() - started}ms`)
    }
    activeExchanges.add(cancel)
    res.once('close', () => { activeExchanges.delete(cancel); if (!res.writableEnded) cancel() })
    req.once('aborted', () => cancel())
    const attempt = () => {
      if (terminal) return
      if (index >= candidates.length) {
        terminal = true
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'All lab model upstreams failed' } }))
        log(`${label} all-failed ${Date.now() - started}ms`)
        return
      }
      const ip = candidates[index++]
      let settled = false
      const failed = error => {
        if (settled || terminal) return
        settled = true
        downUntil.set(ip, Date.now() + DOWN_MS)
        log(`${label} ${ip} ${res.headersSent ? 'stream-error' : 'error'} ${error.message}`)
        if (res.headersSent) { terminal = true; activeResponse?.destroy(); res.destroy() }
        else attempt()
      }
      const upstream = httpRequest(
        { host: ip, port: upstreamPort, path: req.url, method: req.method, headers: headersFor(req, body.length), timeout: upstreamTimeoutMs },
        upstreamRes => {
          if (terminal) { upstreamRes.destroy(); return }
          activeResponse = upstreamRes
          if ((upstreamRes.statusCode ?? 500) >= 500) downUntil.set(ip, Date.now() + DOWN_MS)
          else downUntil.delete(ip)
          if ((upstreamRes.statusCode ?? 500) >= 500 && index < candidates.length) {
            settled = true; upstreamRes.destroy()
            log(`${label} ${ip} ${upstreamRes.statusCode} retry`)
            attempt(); return
          }
          const headers = { ...upstreamRes.headers, 'x-dw-upstream': ip }
          delete headers['transfer-encoding']
          res.writeHead(upstreamRes.statusCode ?? 502, headers)
          const audit = responseAudit(String(upstreamRes.headers['content-type'] ?? ''))
          upstreamRes.on('data', chunk => { if (!terminal) audit.chunk(chunk) })
          upstreamRes.once('error', failed)
          upstreamRes.once('aborted', () => failed(new Error('upstream response aborted')))
          upstreamRes.once('end', () => {
            if (settled || terminal) return
            settled = true; terminal = true
            log(`${label} ${ip} ${upstreamRes.statusCode} ${Date.now() - started}ms`)
            log(`${label} response ${JSON.stringify(audit.end())}`)
          })
          upstreamRes.pipe(res)
        },
      )
      activeRequest = upstream
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
      upstream.on('error', failed)
      upstream.end(body)
    }
    attempt()
  })
})

server.listen(port, '127.0.0.1', () => {
  log(`listen 127.0.0.1:${port} ips=${ips.join(',')} reasoning=${reasoning}`)
  process.stdout.write(`${JSON.stringify({ event: 'ready', port, ips, reasoning })}\n`)
})

let proxyClosing = false
const close = () => {
  if (proxyClosing) return
  proxyClosing = true
  for (const cancel of activeExchanges) cancel('proxy-shutdown')
  server.close(() => process.exit(0))
  server.closeAllConnections()
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
if (argv.includes('--exit-on-stdin-close')) {
  process.stdin.resume()
  process.stdin.on('end', close)
  process.stdin.on('close', close)
}
