#!/usr/bin/env node
/** Real-engine initialization and default-agent test. noReply prevents every model request. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const executable = process.argv[2]
if (!executable) throw new Error('Pass the installed opencode executable path')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = join(root, 'demo', '.checks')
mkdirSync(checks, { recursive: true })
const fixture = mkdtempSync(join(checks, 'bootstrap-'))
const workspace = join(fixture, 'workspace')
mkdirSync(join(workspace, '.opencode', 'agents'), { recursive: true })
cpSync(join(root, 'app', 'workspace', '.opencode', 'agents', 'mars.md'), join(workspace, '.opencode', 'agents', 'mars.md'))
// Reuse installed dependencies so package installation does not obscure plugin initialization.
for (const target of [join(workspace, '.opencode'), join(fixture, 'xdg', 'config', 'opencode')]) {
  mkdirSync(target, { recursive: true })
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(root, 'app', 'workspace', '.opencode', file), join(target, file))
  cpSync(join(root, 'app', 'workspace', '.opencode', 'node_modules'), join(target, 'node_modules'), { recursive: true })
}
const scienceConfig = join(fixture, 'science.json')
writeFileSync(scienceConfig, JSON.stringify({ home: join(fixture, 'sampling'), server: join(root, 'app', 'science', 'server.mjs'),
  llmProxy: { enabled: false }, mars: { enabled: true, dual: true, modelBarrier: true, modelSource: 'scripted-integration',
    server: join(root, 'app', 'mars-server.mjs'), checkpointIntervalTicks: 0, home: join(fixture, 'multi'), singleHome: join(fixture, 'single'),
    truth: join(root, 'data', 'mars', 'truth.json'), salt: 'a'.repeat(64) } }))
const prepared = spawnSync(process.execPath, [join(root, 'demo', 'mars-prepare.mjs'), '--config', scienceConfig], {
  windowsHide: true, encoding: 'utf8', timeout: 360000, env: { ...process.env, NODE_NO_WARNINGS: '1' },
})
assert.equal(prepared.status, 0, prepared.error?.message ?? prepared.stderr)
writeFileSync(join(workspace, 'opencode.json'), JSON.stringify({
  default_agent: 'mars', model: 'fixture/bootstrap', small_model: 'fixture/bootstrap', snapshot: false,
  plugin: [pathToFileURL(join(root, 'app', 'workspace', '.opencode', 'plugin', 'science.js')).href],
  agent: { title: { disable: true } },
  provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'keyless-fixture' },
    models: { bootstrap: { limit: { context: 131072, output: 1000 } } } } },
}))
const freePort = createServer()
freePort.listen(0, '127.0.0.1')
await once(freePort, 'listening')
const port = freePort.address().port
await new Promise(resolve => freePort.close(resolve))
const child = spawn(executable, ['--print-logs', '--log-level', 'DEBUG', 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
    SCIENCE_CONFIG: scienceConfig, SCIENCE_HOME: join(fixture, 'sampling'), SCIENCE_MARS_HOME: join(fixture, 'multi'), SCIENCE_MARS_SINGLE_HOME: join(fixture, 'single'),
    XDG_CONFIG_HOME: join(fixture, 'xdg', 'config'), XDG_DATA_HOME: join(fixture, 'xdg', 'data'), XDG_STATE_HOME: join(fixture, 'xdg', 'state'),
    OPENCODE_CONFIG_CONTENT: '{"agent":{"title":{"disable":false}}}', OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: 'keyless-fixture',
    OPENCODE_DISABLE_MODELS_FETCH: '1', NODE_NO_WARNINGS: '1',
  },
})
let output = ''
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const headers = { authorization: 'Basic ' + Buffer.from('opencode:keyless-fixture').toString('base64'), 'content-type': 'application/json' }
const origin = `http://127.0.0.1:${port}`
const request = async (path, body, timeoutMs = 60000) => {
  const url = new URL(path, origin)
  url.searchParams.set('directory', workspace)
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  assert.equal(response.status, 200, `${path}: ${response.status} ${text.slice(0, 250)}`)
  return text ? JSON.parse(text) : null
}
try {
  const deadline = Date.now() + 120000
  while (true) {
    try { await request('/global/health', undefined, 500); break }
    catch (error) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error('Engine did not listen: ' + output.slice(-1000), { cause: error })
      await delay(100)
    }
  }
  const session = await request('/session', {})
  const sent = await request(`/session/${session.id}/message`, { noReply: true, parts: [{ type: 'text', text: 'Keyless bootstrap: store this message without a model reply.' }] })
  assert.equal(sent.info.agent, 'mars')
  const pluginLog = join(fixture, 'multi', 'mars-plugin.log')
  assert.ok(existsSync(pluginLog), 'Mars tools must finish registration before the request returns')
  assert.match(readFileSync(pluginLog, 'utf8'), /registered \d+ Mars tools/)
  const configuration = await request('/config')
  assert.equal(configuration.default_agent, 'mars')
  await request('/session/status')
  console.log(JSON.stringify({ passed: true, fixture, defaultAgent: sent.info.agent, toolsRegistered: true, modelCalls: 0 }))
} catch (error) {
  console.error(JSON.stringify({ passed: false, fixture, error: error.message, name: error.name,
    toolsRegistered: existsSync(join(fixture, 'multi', 'mars-plugin.log')) }))
  process.exitCode = 1
} finally {
  writeFileSync(join(fixture, 'engine.log'), output)
  await request('/instance/dispose', {}, 1000).catch(() => {})
  child.kill()
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), delay(3000)])
}
