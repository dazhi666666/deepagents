#!/usr/bin/env node
/**
 * DeepAgents 任务控制中心：mission-control 前端的独立服务端。
 *
 * 页面、样式与脚本来自 mission-control，品牌与数据接入已按 DeepAgents 调整：
 * - 科学执行与多智能体编排两部分在本仓库没有对应后端，页面显示离线；
 * - 火星基地各视图从一份已导出的运行记录（viewer/records/*.json）读取，
 *   映射成 Viewer API 的 snapshot / score / sensors / telemetry 形状；
 * - 也可以用 MARS_VIEWER_URL 指向一个正在运行的 Viewer API 后端。
 *
 * 启动：node console/server.mjs [--port 2300] [--record viewer/records/single-v06.json]
 */
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, 'public')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const port = Number(arg('port', process.env.MISSION_CONTROL_PORT || 2300))
const recordPath = resolve(arg('record', process.env.MARS_RECORD || join(here, '..', 'viewer', 'records', 'single-v06.json')))
const viewerUrl = process.env.MARS_VIEWER_URL || ''
const viewerToken = process.env.MARS_VIEWER_TOKEN || ''
const viewerRun = process.env.MARS_VIEWER_RUN || ''
const marsStateUrl = process.env.MARS_STATE_URL || ''

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const cors = ''

const token = randomBytes(32).toString('hex')
const cookieName = `deepagents_console_${port}`
const page = []

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function same(a, b) {
  return a.length === b.length && timingSafeEqual(a, b)
}

const openMode = process.env.CONSOLE_OPEN === '1' || argv.includes('--open')

function authorised(req) {
  if (openMode) return true
  const cookie = req.headers.cookie || ''
  const found = cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`))
  return Boolean(found) && same(Buffer.from(found.slice(cookieName.length + 1)), Buffer.from(token))
}

async function serveFile(res, file) {
  try {
    const info = await stat(file)
    if (!info.isFile()) return json(res, 404, { error: 'Not found' })
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    createReadStream(file).pipe(res)
  } catch {
    json(res, 404, { error: 'Not found' })
  }
}

/* ---------- 运行记录 -> Viewer API 形状 ---------- */
let cached = { at: 0, run: null }
async function loadRun() {
  const info = await stat(recordPath)
  if (cached.run && cached.at === info.mtimeMs) return cached.run
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  const runs = Array.isArray(record) ? record : record.runs ?? []
  const run = (viewerRun && runs.find((item) => item.id === viewerRun)) || runs[0]
  if (!run) throw new Error('运行记录为空')
  cached = { at: info.mtimeMs, run }
  return run
}

function entityPositions(layout) {
  const map = new Map()
  for (const node of layout?.nodes ?? []) map.set(node.id, { x: node.x, y: node.y })
  for (const anchor of layout?.anchors ?? []) if (!map.has(anchor.id)) map.set(anchor.id, { x: anchor.x, y: anchor.y })
  return map
}

async function liveMarsState() {
  if (!marsStateUrl) return null
  try {
    const reply = await fetch(marsStateUrl, { signal: AbortSignal.timeout(800) })
    if (!reply.ok) return null
    return await reply.json()
  } catch {
    return null
  }
}

function buildSnapshot(run, live = null) {
  const positions = entityPositions(run.layout)
  const state = run.snapshot ?? {}
  const entities = [
    ...(state.devices ?? []).map((device) => ({ id: device.id, kind: 'device', position: positions.get(device.id) ?? { x: 0, y: 0 }, state: device })),
    ...(state.robots ?? []).map((robot) => ({ id: robot.id, kind: 'robot', position: { x: robot.x, y: robot.y }, state: robot })),
    ...(state.crops ?? []).map((crop) => ({ id: crop.id, kind: 'crop', position: positions.get(crop.chamberId) ?? { x: 0, y: 0 }, state: crop })),
  ]
  const energy = state.energy ?? {}
  const water = state.water ?? {}
  return {
    schemaVersion: 'v1', stage: 'finished', runId: run.id, branchId: 'main', epoch: 0,
    rootSessionId: '', checkpointId: '', cursor: (run.events ?? []).length,
    tick: live?.tick ?? run.tick, mode: live?.mode ?? run.mode, seed: run.manifest?.seed ?? run.manifest?.historyHash?.slice(0, 8) ?? null,
    status: live ? ((live.tick ?? 0) >= (live.horizon ?? Infinity) ? 'completed' : 'running') : (run.report ? 'completed' : 'running'),
    capabilities: {}, model: { id: run.manifest?.model?.model ?? 'dsv4f-native', model: run.manifest?.model?.model ?? 'dsv4f-native', provider: run.manifest?.model?.provider ?? '' },
    mission: {
      version: 2, title: `Mars ${run.benchmarkVersion ?? 'v0.6'} · ${run.label ?? run.mode}`,
      instructions: '在封闭生态基地内完成水处理、温室与供电任务，并按基准规则结算科研得分与运行指标。',
      planning: '', dataSources: {}, operatingRules: [], scoring: {}, objectives: [],
    },
    map: run.layout ?? {}, rules: {}, history: {},
    utilities: {
      powerCapacity: energy.capacity ?? 12, ambientTemperature: state.atmosphere ? 22 : 22,
      waterUl: water.reserve ?? 0, waterCapacityUl: water.capacity ?? 5000, powerDemand: energy.demand ?? 0,
    },
    entities: live?.robots?.length
      ? entities.map((entity) => {
          const robot = live.robots.find((item) => item.id === entity.id)
          return robot ? { ...entity, state: { ...entity.state, energy: robot.energy, node: robot.node, operationId: robot.operationId } } : entity
        })
      : entities,
    messages: [], agents: (live?.participants?.length ? live.participants.map((person) => ({ actorId: person.actorId ?? person.id, role: person.role })) : (run.participants ?? [])).map((person) => ({
      id: person.actorId, project: 'mars', role: person.role, depth: 0, task: '', parentId: null, status: 'idle', tools: [],
    })), tasks: [], notes: [], operations: run.operations ?? [], objectiveAssessments: [],
    score: scoreOf(run),
  }
}

function scoreOf(run) {
  const report = run.report ?? {}, O = report.O ?? {}, q = report.q ?? {}, joint = report.jointConditions ?? []
  // 把 v0.6 结算字段换算成页面使用的五类运营分项。
  const fraction = (value, limit) => Math.max(0, Math.min(limit, Math.round(value * limit)))
  const crops = fraction(O.cropSurvival ?? 0, 12)
  const energy = Number((3 * (1 - (O.criticalShedFraction ?? 0))).toFixed(2))
  const water = Number((3 * (1 - (O.waterUnavailableTicks ?? 0) / (O.ticks || 1))).toFixed(2))
  const atmosphere = fraction((O.aliveCrops ?? 0) / Math.max(1, O.cropCount ?? 1), 2)
  const samples = fraction((O.samplesAvailable ?? 0) / Math.max(1, (O.samplesAvailable ?? 0) + (O.samplesQuarantined ?? 0)), 2)
  return {
    S: report.R ?? 0, normalized: report.normalized ?? null, tick: report.tick ?? run.tick,
    O: { total: Number((crops + energy + water + atmosphere + samples).toFixed(2)), crops, energy, water, atmosphere, samples },
    C: { total: joint.filter((item) => item.passed).length, incidents: [], observable: 0, reported: 0 },
    R: { total: report.R ?? 0, tasks: [] },
    Q: { total: Object.values(q).reduce((sum, value) => sum + (Number(value) || 0), 0), submissions: 0, efficiency: 0, robustness: 0, reproducibility: 0 },
    F: report.F ?? null,
  }
}


function announcementsOf(run) {
  const kinds = new Set(['battery-low', 'crop-status-changed', 'power-shed', 'device-fault', 'inline-doc-alarm', 'chamber-pressure-low'])
  return (run.events ?? []).filter((event) => kinds.has(event.kind)).slice(-40).map((event) => ({ kind: event.kind, tick: event.tick, payload: event.payload ?? {}, seq: event.seq }))
}

function sensorsOf(run) {
  const state = run.snapshot ?? {}
  const energy = state.energy ?? {}
  return {
    energy: { solar: energy.solar ?? 0, demand: energy.demand ?? 0, soc: energy.soc ?? 0, tau_dust: energy.tauDust ?? 0 },
    chambers: Object.entries(state.atmosphere ?? {}).map(([id, chamber]) => ({ id, co2: chamber.co2, pressure: chamber.pressure, quarantine: Boolean(chamber.quarantine) })),
    co2TankUnits: state.co2Tank ?? 0,
    spares: state.spares ?? {},
  }
}

function telemetryOf(run, channels, from, to, limit) {
  const all = run.telemetry ?? {}
  const picked = channels?.length ? channels : Object.keys(all)
  const out = {}
  for (const channel of picked) {
    const series = all[channel] ?? []
    out[channel] = series.filter(([tick]) => (from === undefined || tick >= from) && (to === undefined || tick <= to)).slice(-limit)
  }
  return out
}

async function marsRoutes(req, res, url) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Read-only Mars endpoint' })
  if (viewerUrl) {
    const target = new URL(`/viewer/api/v1/runs/${encodeURIComponent(viewerRun || 'current')}${url.pathname.slice('/mc/mars'.length)}${url.search}`, viewerUrl)
    const headers = { host: target.host }
    if (viewerToken) headers.authorization = `Bearer ${viewerToken}`
    const upstream = http.request(target, { method: 'GET', headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, { 'content-type': reply.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store' })
      reply.pipe(res)
    })
    upstream.on('error', (error) => json(res, 502, { error: `Viewer API unreachable: ${error.message}` }))
    return upstream.end()
  }
  try {
    const run = await loadRun()
    const live = await liveMarsState()
    const rest = url.pathname.slice('/mc/mars'.length)
    if (rest === '/snapshot') return json(res, 200, buildSnapshot(run, live))
    if (rest === '/score') return json(res, 200, scoreOf(run))
    if (rest === '/sensors') return json(res, 200, sensorsOf(run))
    if (rest === '/telemetry/channels') return json(res, 200, { channels: Object.keys(run.telemetry ?? {}) })
    if (rest === '/telemetry') {
      const channels = (url.searchParams.get('channels') || '').split(',').filter(Boolean)
      const from = url.searchParams.get('from'), to = url.searchParams.get('to')
      return json(res, 200, telemetryOf(run, channels, from === null ? undefined : Number(from), to === null ? undefined : Number(to), Number(url.searchParams.get('limit') || 600)))
    }
    if (rest === '/evaluation') return json(res, 200, { crops: [], water: [], report: run.report ?? null })
    if (rest === '/comparison') return json(res, 200, { runs: [] })
    if (rest === '/deliverables') return json(res, 200, { deliverables: [] })
    if (rest === '/incident-reports') return json(res, 200, { reports: [] })
    if (rest === '/announcements') return json(res, 200, { events: announcementsOf(run) })
    if (rest === '/model-activity') return json(res, 200, { activity: [] })
    if (rest.startsWith('/analysis-runs')) return json(res, 200, { runs: run.analyses ?? [] })
    if (rest === '/measurements') {
      const id = url.searchParams.get('resultId')
      return json(res, 200, (run.measurements ?? []).filter((item) => !id || item.id === id))
    }
    if (rest.startsWith('/raw/')) {
      const key = decodeURIComponent(rest.slice('/raw/'.length))
      const item = (run.raw ?? []).find((entry) => entry.id === key)
      return item ? json(res, 200, item) : json(res, 404, { error: '产物不存在' })
    }
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    return json(res, 503, { error: `运行记录不可用：${error.message}` })
  }
}


/* ---------- AI4Science 平台后端 ---------- */
let platform = null
const platformScript = join(here, 'platform.mjs')
async function startPlatform() {
  if (process.env.DEEPAGENTS_PLATFORM === '0' || argv.includes('--no-platform')) return
  const child = spawn(process.execPath, ['--experimental-transform-types', platformScript, '--port', String(process.env.DEEPAGENTS_PLATFORM_PORT || 8787)], { stdio: ['ignore', 'pipe', 'inherit'] })
  child.on('exit', (code) => { if (code && code !== 0) console.error(`AI4Science 平台退出（${code}）`) })
  const lines = createInterface({ input: child.stdout })
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('AI4Science 平台启动超时')), 30000)
    lines.once('line', (line) => {
      clearTimeout(timer)
      try {
        const value = JSON.parse(line)
        platform = { url: value.url, token: value.token, child }
        console.log(`科研工作台后端：${value.url}`)
        resolveReady()
      } catch (error) { rejectReady(error) }
    })
    child.once('exit', () => { clearTimeout(timer); rejectReady(new Error('AI4Science 平台启动失败')) })
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { try { child.kill(signal) } catch {} })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/workspace') {
    res.writeHead(301, { Location: '/workspace/' })
    return res.end()
  }
  if (req.method === 'GET' && url.pathname === '/workspace/') return serveFile(res, join(here, 'workspace', 'index.html'))
  if (req.method === 'GET' && url.pathname === '/workspace/about') return serveFile(res, join(here, 'workspace', 'about.html'))
  if (req.method === 'GET' && url.pathname.startsWith('/workspace/') && !url.pathname.startsWith('/workspace/api/')) {
    const relative = url.pathname.slice('/workspace/'.length)
    if (!relative.includes('..') && types[extname(relative)]) return serveFile(res, join(here, 'workspace', relative))
  }
  if (url.pathname.startsWith('/workspace/api/')) {
    const upstreamUrl = platform?.url || process.env.DEEPAGENTS_DASHBOARD_URL || ''
    if (!upstreamUrl) return json(res, 503, { error: 'AI4Science 平台后端未启动' })
    const target = new URL(url.pathname.slice('/workspace'.length) + url.search, upstreamUrl)
    const headers = { host: target.host }
    if (platform?.token) headers.authorization = `Bearer ${platform.token}`
    else if (req.headers.authorization) headers.authorization = req.headers.authorization
    if (req.headers.cookie) headers.cookie = req.headers.cookie
    const upstream = http.request(target, { method: req.method, headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, { 'content-type': reply.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store' })
      reply.pipe(res)
    })
    upstream.on('error', (error) => json(res, 502, { error: `Dashboard unreachable: ${error.message}` }))
    req.pipe(upstream)
    return
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveFile(res, join(publicDir, 'shell.html'))
  if (req.method === 'GET' && url.pathname === '/mars') {
    res.writeHead(301, { Location: '/mars/' })
    return res.end()
  }
  if (req.method === 'GET' && url.pathname === '/mars/') return serveFile(res, join(publicDir, 'index.html'))
  if (req.method === 'GET' && types[extname(url.pathname)]) {
    const relative = url.pathname.replace(/^\/+/, '')
    if (!relative.includes('..')) return serveFile(res, join(publicDir, relative))
  }
  if (req.method === 'POST' && url.pathname === '/session') {
    const header = req.headers.authorization || ''
    if (!header.startsWith('Bearer ') || !same(Buffer.from(header.slice(7)), Buffer.from(token))) return json(res, 401, { error: '令牌无效' })
    res.writeHead(204, { 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store' })
    return res.end()
  }
  if (url.pathname.startsWith('/mc/')) {
    if (!authorised(req)) return json(res, 401, { error: '需要启动链接' })
    if (url.pathname === '/mc/status') {
      return json(res, 200, { science: false, router: false, mars: true, harnessUrl: '', scienceError: 'DeepAgents 控制台未接入科学执行后端' })
    }
    if (url.pathname === '/mc/runs') return json(res, 200, { runs: [] })
    if (url.pathname.startsWith('/mc/mars/')) return marsRoutes(req, res, url)
    return json(res, 404, { error: 'Not found' })
  }
  if (url.pathname.startsWith('/science/')) return json(res, 503, { error: '科学执行后端未接入' })
  if (url.pathname.startsWith('/router/')) return json(res, 503, { error: '多智能体编排后端未接入' })
  return json(res, 404, { error: 'Not found' })
})

await startPlatform().catch((error) => console.error(`科研工作台后端未启动：${error.message}`))
server.listen(port, '127.0.0.1', () => {
  console.log(`DeepAgents 任务控制中心：http://127.0.0.1:${port}/#${token}`)
  if (!viewerUrl) console.log(`火星数据来源：${recordPath}`)
})
