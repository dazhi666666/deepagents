#!/usr/bin/env node
/**
 * Mars v0.6 sidecar for DeepWorks.
 *
 * Owns the world, execution engine, scientific core, session host and NDJSON RPC lifecycle.
 * The optional local dashboard is disabled unless an HTTP port is supplied.
 *
 * Usage: node --experimental-transform-types mars-server.mjs --home <dir> --truth <truth.json>
 */
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { createMarsHost, SCHEDULING_PROTOCOL } from './mars-host/host.mjs'
import { prepareMarsHistory } from './mars-host/history.mjs'
import { assertMarsRoster, marsRoster } from './science/mars-roster.mjs'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const ai4science = join(here, 'science-harness', 'integrations', 'ai4science')
const marsDir = join(ai4science, 'mars')
const platformDir = join(ai4science, 'platform')

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const home = resolve(arg('home', join(here, '..', 'data', 'mars')))
const truthPath = resolve(arg('truth', join(home, 'truth.json')))
const salt = String(arg('salt', 'a'.repeat(64)))
const mode = String(arg('mode', 'multi'))
const teamSize = Number(arg('team-size', 6))
const roles = marsRoster(mode, teamSize)
const manifestPath = join(home, 'manifest.public.json')
const savedManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
if (savedManifest) {
  assertMarsRoster(savedManifest, mode, roles)
  if (savedManifest.schedulingProtocol !== SCHEDULING_PROTOCOL) throw new Error('Scheduler protocol differs; preserve the old run and start a fresh experiment')
}
const httpPort = Number(arg('http-port', 0))
const checkpointInterval = Number(arg('checkpoint-interval', 240))
const modelBarrier = String(arg('model-barrier', '1')) !== '0'
if (!/^[a-f0-9]{64}$/i.test(salt)) throw new Error('--salt must be 64 hex characters')
mkdirSync(home, { recursive: true })

const [{ loadTruth }, { compileScenario }, { developmentStages, stageProfileSchema, contentHash }, { scienceProfileSchema }, { V06World }, { initialMarsRules }, { openMarsProviders }, { ExecutionEngine }, { AnalysisRegistry }, { openScience, scienceInstance }, { MarsArchive }] = await Promise.all([
  import(pathToFileURL(join(marsDir, 'truth.ts')).href),
  import(pathToFileURL(join(marsDir, 'v06/scenario.ts')).href),
  import(pathToFileURL(join(marsDir, 'v06/contracts.ts')).href),
  import(pathToFileURL(join(marsDir, 'v06/profile.ts')).href),
  import(pathToFileURL(join(marsDir, 'v06/world.ts')).href),
  import(pathToFileURL(join(marsDir, 'world.ts')).href),
  import(pathToFileURL(join(marsDir, 'providers.ts')).href),
  import(pathToFileURL(join(platformDir, 'execution.ts')).href),
  import(pathToFileURL(join(marsDir, 'analysis.ts')).href),
  import(pathToFileURL(join(marsDir, 'v06/science.ts')).href),
  import(pathToFileURL(join(marsDir, 'archive.ts')).href),
])

const truth = loadTruth(truthPath)
const profile = scienceProfileSchema.parse({})
const modelSource = String(arg('model-source', 'real-model'))
const stageOverride = arg('stage-profile', null)
if (stageOverride && modelSource !== 'scripted-integration') throw new Error('Custom stages are only allowed in keyless scripted-integration fixtures')
const declaredStages = stageOverride ? stageProfileSchema.parse(JSON.parse(stageOverride)) : developmentStages
const trialVersion = arg('joint-trial', null)
if (trialVersion && declaredStages.jointTrial && trialVersion !== declaredStages.jointTrial) throw new Error('Conflicting joint trial versions')
const workflow = arg('research-workflow', null)
if (workflow && declaredStages.researchWorkflow && workflow !== declaredStages.researchWorkflow) throw new Error('Conflicting research workflow versions')
const runStages = stageProfileSchema.parse({ ...declaredStages, ...(trialVersion ? { jointTrial: trialVersion } : {}), ...(workflow ? { researchWorkflow: workflow } : {}) })
if (savedManifest?.stages && contentHash(savedManifest.stages) !== contentHash(runStages))
  throw new Error('Existing run uses different stages or a different T6 trial version. Select a fresh pair.')
const compiled = compileScenario(truth, runStages, profile, salt)
const scenarioFile = join(home, 'device-scenario.json')
const serialized = JSON.stringify(compiled.scenario)
if (existsSync(scenarioFile) && (await import('node:fs')).readFileSync(scenarioFile, 'utf8') !== serialized) {
  throw new Error('Existing Mars scenario differs from this truth/stage/profile')
}
if (!existsSync(scenarioFile)) writeFileSync(scenarioFile, serialized, { mode: 0o600 })

const { archive, manifest: historyManifest } = await prepareMarsHistory({
  home, effectiveTruth: compiled.truth, effectiveTruthHash: contentHash(compiled.truth),
})
if (argv.includes('--prepare-only')) {
  archive.close()
  await new Promise(resolveWrite => process.stdout.write(JSON.stringify({ prepared: true, home, mode, roles,
    historyHash: historyManifest.sha256, bytes: historyManifest.bytes, counts: historyManifest.counts }) + '\n', resolveWrite))
  process.exit(0)
}
const world = new V06World(join(home, 'device'), compiled.scenario, initialMarsRules(), compiled.truth ?? truth, profile, runStages)
world.setStopAtTick(world.horizon)
let wakeClock = () => {}
const opened = openMarsProviders(world, scenarioFile, () => wakeClock())
const engine = new ExecutionEngine({
  directory: join(home, 'execution'),
  providers: opened.providers,
  pollIntervalMs: 100,
  providerCallTimeoutMs: 10000,
  logicalTick: () => world.currentTick(),
})
await engine.open()
engine.createProject('mars', null)
const context = engine.issueContext('mars', 'mars-host', ['water', 'greenhouse', 'facilities'])
const analysis = new AnalysisRegistry(join(home, 'analysis'), false, {
  isolatedRealm: true,
  timeoutMs: profile.analysisTimeoutMs,
  maxOutputBytes: profile.analysisOutputBytes,
})
const evaluatorDir = `${home}.evaluator`
mkdirSync(evaluatorDir, { recursive: true })
const instancePath = join(evaluatorDir, 'v06-instance.json')
const instanceBody = { version: 1, sourceHash: contentHash(truth), profileHash: contentHash(profile), stagesHash: contentHash(runStages), salt }
if (existsSync(instancePath)) {
  if (JSON.stringify(JSON.parse(readFileSync(instancePath, 'utf8'))) !== JSON.stringify(instanceBody))
    throw new Error('Existing scientific instance differs from this run')
} else {
  writeFileSync(instancePath, `${JSON.stringify(instanceBody, null, 2)}
`, { mode: 0o600 })
}
const science = openScience({ world, engine, context, analysis, directory: home, salt, decisionTicks: 12 })
const manifest = {
  schemaVersion: 1,
  benchmarkVersion: 'v0.6',
  schedulingProtocol: SCHEDULING_PROTOCOL,
  mode: mode === 'single' ? 'single-agent' : 'multi-agent',
  roles,
  truthHash: createHash('sha256').update(readFileSync(truthPath)).digest('hex'),
  saltHash: createHash('sha256').update(salt).digest('hex'),
  scenarioHash: contentHash(compiled.scenario),
  historyHash: historyManifest.sha256,
  historyManifestHash: contentHash(historyManifest),
  caseManifestHash: science.manifest.hash,
  protocolHash: science.config.protocolHash,
  model: { provider: String(arg('model-provider', 'dspark')), model: String(arg('model', 'dsv4f-native')), maxTokens: Number(arg('max-tokens', 30000)) },
  modelSource,
  stages: runStages,
  horizon: world.horizon,
  decisionTicks: 12,
  nodeVersion: process.version,
}
if (savedManifest) {
  const keys = ['benchmarkVersion', 'truthHash', 'saltHash', 'horizon', 'decisionTicks', 'scenarioHash', 'caseManifestHash', 'protocolHash', 'historyHash', 'historyManifestHash']
  for (const key of keys) {
    if (savedManifest[key] !== undefined && JSON.stringify(savedManifest[key]) !== JSON.stringify(manifest[key]))
      throw new Error(`Existing Mars run manifest differs: ${key}`)
  }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}
`)
writeFileSync(join(evaluatorDir, 'v06-runtime.json'), `${JSON.stringify({
  implementation: 'scientific_candidate', sourceTruthHash: contentHash(truth), scienceProfile: profile,
  stageProfile: runStages, decisionTicks: 12, instanceFile: instancePath, budget: null, stopAtTick: world.horizon,
}, null, 2)}
`)
let dashboardServer
const runFile = join(home, 'run.json')
const runId = existsSync(runFile) ? JSON.parse(readFileSync(runFile, 'utf8')).runId : randomUUID()
writeFileSync(runFile, `${JSON.stringify({ runId })}
`)
let controlRevision = 0
let host
const controlSnapshot = () => ({ revision: controlRevision, round: host.controlInfo(), notices: structuredClone(host.notices()) })
const publishControl = () => {
  if (!host) return
  controlRevision++
  process.stdout.write(`${JSON.stringify({ id: null, ok: true, event: 'mars.control', result: controlSnapshot() })}\n`)
}
host = createMarsHost({ directory: home, world, engine, science, admin: context, analysis, project: 'mars', decisionTicks: 12,
  onControlChange: publishControl,
  archive, load: (compiled.truth ?? truth).load, mode, teamSize, checkpointIntervalTicks: Number.isInteger(checkpointInterval) ? checkpointInterval : 240,
  runId, protocolHash: science.config.protocolHash, modelBarrier, autoAdvance: String(arg('auto-clock', '1')) !== '0' })
writeFileSync(join(home, 'mars-server.pid'), `${process.pid}
`)
wakeClock = () => host.wake()

function dashboardState() {
  const state = world.observe(), systems = world.observeSystems()
  return {
    mode,
    tick: state.tick,
    horizon: world.horizon,
    stages: science.stages.view(),
    participants: host.participants(),
    samples: state.samples.length,
    devices: state.devices.length,
    operations: engine.list(context).slice(-40).map((operation) => ({
      id: operation.id, providerId: operation.providerId, state: operation.state, actorId: operation.actorId,
      updatedAt: operation.updatedAt, artifacts: operation.artifacts.length,
    })),
    robots: systems.robots.map((robot) => ({ id: robot.id, node: robot.node, energy: robot.energy, operationId: robot.operationId ?? null })),
  }
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Mars v0.6</title>
<style>
 body{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:24px;background:#0f1115;color:#e6e6e6}
 h1{font-size:18px;margin:0 0 4px} .sub{color:#8b93a1;margin-bottom:16px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
 .card{background:#171b22;border:1px solid #242a35;border-radius:10px;padding:12px}
 .card .k{color:#8b93a1;font-size:12px} .card .v{font-size:22px;font-weight:600;margin-top:4px}
 table{width:100%;border-collapse:collapse;background:#171b22;border:1px solid #242a35;border-radius:10px;overflow:hidden;margin-bottom:20px}
 th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #242a35;font-size:13px} th{color:#8b93a1;font-weight:500}
 .ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24} .muted{color:#8b93a1}
 code{color:#93c5fd}
</style></head><body>
<h1>Mars v0.6 · <span id="mode">-</span></h1>
<div class="sub">共享实验室实时状态 · 每 2 秒刷新 · <a href="http://127.0.0.1:18081" style="color:#93c5fd">multi</a> / <a href="http://127.0.0.1:18082" style="color:#93c5fd">single</a></div>
<div class="grid">
 <div class="card"><div class="k">Tick</div><div class="v"><span id="tick">-</span> / <span id="horizon">-</span></div></div>
 <div class="card"><div class="k">阶段</div><div class="v" id="phase">-</div></div>
 <div class="card"><div class="k">封印</div><div class="v" id="seals">-</div></div>
 <div class="card"><div class="k">在线角色</div><div class="v" id="roles">-</div></div>
 <div class="card"><div class="k">样品 / 设备</div><div class="v" id="counts">-</div></div>
</div>
<h2 style="font-size:15px">角色</h2><table><thead><tr><th>role</th><th>actor</th><th>session</th></tr></thead><tbody id="participants"></tbody></table>
<h2 style="font-size:15px">机器人</h2><table><thead><tr><th>id</th><th>node</th><th>电量</th><th>操作</th></tr></thead><tbody id="robots"></tbody></table>
<h2 style="font-size:15px">最近操作</h2><table><thead><tr><th>id</th><th>provider</th><th>状态</th><th>actor</th></tr></thead><tbody id="operations"></tbody></table>
<script>
const esc=(s)=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function refresh(){
 try{
  const s=await (await fetch('/api/state',{cache:'no-store'})).json();
  document.getElementById('mode').textContent=s.mode;
  document.getElementById('tick').textContent=s.tick;
  document.getElementById('horizon').textContent=s.horizon;
  document.getElementById('phase').textContent=s.stages.phase;
  document.getElementById('seals').textContent=s.stages.seals.map(x=>x.stage).join(' → ')||'—';
  document.getElementById('roles').textContent=s.participants.length;
  document.getElementById('counts').textContent=s.samples+' / '+s.devices;
  document.getElementById('participants').innerHTML=s.participants.map(p=>'<tr><td>'+esc(p.role)+'</td><td><code>'+esc(p.actorId)+'</code></td><td class="muted">'+esc(p.sessionId)+'</td></tr>').join('');
  document.getElementById('robots').innerHTML=s.robots.map(r=>'<tr><td>'+esc(r.id)+'</td><td>'+esc(r.node)+'</td><td>'+esc(r.energy)+'</td><td class="muted">'+esc(r.operationId||'—')+'</td></tr>').join('');
  document.getElementById('operations').innerHTML=s.operations.slice().reverse().map(o=>'<tr><td><code>'+esc(o.id.slice(0,8))+'</code></td><td>'+esc(o.providerId)+'</td><td class="'+(o.state==='succeeded'?'ok':o.state==='failed'?'bad':'warn')+'">'+esc(o.state)+'</td><td class="muted">'+esc(o.actorId)+'</td></tr>').join('');
 }catch(e){document.getElementById('mode').textContent='disconnected'}
}
refresh(); setInterval(refresh, 2000);
</script></body></html>`

function status() {
  const state = world.observe()
  return {
    tick: state.tick,
    horizon: world.horizon,
    stages: science.stages.profile,
    samples: state.samples.length,
    devices: state.devices.length,
    operations: engine.list(context).length,
    tools: host.listTools().length,
    requiredRoles: roles,
    participants: host.participants(),
    round: host.roundInfo(),
    history: { installed: true, sha256: historyManifest.sha256, bytes: historyManifest.bytes, counts: historyManifest.counts },
    catalog: Object.keys(science.catalog()),
  }
}

const methods = {
  hello: () => ({ version: 'mars-v0.6-sidecar/0.1', home, truth: truthPath, status: status() }),
  status: () => status(),
  'control.snapshot': () => controlSnapshot(),
  'context.record': (params) => host.recordContext(params),
  catalog: () => science.catalog(),
  operations: () => engine.list(context).map((operation) => ({
    id: operation.id, providerId: operation.providerId, state: operation.state, progress: operation.progress, detail: operation.detail,
    nextTick: operation.progress && typeof operation.progress === 'object' ? operation.progress.nextTick ?? null : null,
  })),
  login: (params) => host.login(params.sessionId, params.role),
  'session.close': (params) => host.logout(params.sessionId),
  'session.idle': (params) => host.sessionIdle(params.sessionId, { cancelled: params.cancelled === true, cancellationId: params.cancellationId }),
  'run.start': (params) => host.startRun(params.sessionId),
  'decision.enter': (params) => host.enterDecision(params),
  'model.close': (params) => host.closeModels(params.reason ?? 'model_error'),
  'model.aux': (params) => host.auxModel(params.sessionId, params.active),
  'model.aux-failure': (params) => host.recordCompactionFailure(params),
  'model.retry': (params) => host.retryModel(params),
  'model.verify': (params) => host.verifyModel(params),
  'notices.list': () => host.notices(),
  'notices.ack': (params) => host.acknowledgeNotice(params.id, params.messageId),
  'tools.list': () => host.listTools(),
  'tools.call': async (params) => {
    if (typeof params.name !== 'string' || !params.name) throw new Error('Tool name required')
    const result = await host.callTool(params.sessionId, params.name, params.args ?? {}, undefined, params.callId)
    return { tool: params.name, result }
  },
  advance: async (params) => {
    const steps = Number.isInteger(params.steps) ? Math.max(1, Math.min(10000, params.steps)) : 1
    const advanced = await host.advance(steps)
    return { ...status(), advanced }
  },
  stages: () => host.stages(),
  'busy.set': (params) => host.setBusy(params.sessions),
  'inbox.peek': (params) => host.peekInbox(params.role),
  wait: (params) => host.waitFor(params),
  'wait.cancel': (params) => host.cancelWait(params.sessionId),
  checkpoint: (params) => {
    const role = host.roleOf(params.sessionId)
    if (role !== 'brain' && role !== 'single') throw new Error('Only the brain may checkpoint the Mars run')
    return host.checkpoint(params.label)
  },
  finalize: async (params) => {
    const role = host.roleOf(params.sessionId)
    if (role !== 'brain' && role !== 'single') throw new Error('Only the brain may finalize the Mars run')
    const report = await host.finalize()
    writeFileSync(join(home, 'final-report.json'), `${JSON.stringify(report, null, 2)}
`)
    return report
  },
  shutdown: () => {
    setTimeout(() => void shutdown(0), 10)
    return { closing: true }
  },
}

let closing = false
async function shutdown(code) {
  if (closing) return
  closing = true
  try {
    dashboardServer?.close()
    await host.close()
    archive.close()
    try { rmSync(join(home, 'mars-server.pid'), { force: true }) } catch {}
    await engine.close()
    opened.close()
    world.close()
  } finally {
    process.exit(code)
  }
}

if (Number.isInteger(httpPort) && httpPort > 0) {
  const dashboard = createServer((req, res) => {
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(dashboardState()))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(DASHBOARD_HTML)
  })
  dashboard.on('error', (error) => process.stderr.write(`mars dashboard: ${error.message}
`))
  dashboardServer = dashboard
  dashboard.listen(httpPort, '127.0.0.1')
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const handler = methods[request.method]
  const reply = (message) => !closing && process.stdout.write(`${JSON.stringify(message)}\n`)
  if (!handler) return reply({ id: request.id, ok: false, error: `Unknown method: ${request.method}` })
  Promise.resolve()
    .then(() => handler(request.params ?? {}))
    .then((result) => reply({ id: request.id, ok: true, result }))
    .catch((error) => reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }))
})
rl.on('close', () => void shutdown(0))
process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
process.stdout.write(`${JSON.stringify({ id: null, ok: true, event: 'ready', result: { home, tick: world.observe().tick } })}\n`)
