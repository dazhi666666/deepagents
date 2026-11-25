#!/usr/bin/env node
/** Read only finalized Mars runs. Source databases are copied with SQLite backup, never DB/WAL file concatenation. */
import { DatabaseSync, backup } from 'node:sqlite'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { marsLayout } from '../src/layout.js'
import { BUNDLE_VERSION, MAX_BUNDLE_BYTES, pick, publicSnapshot, publicOperation, publicEvent, publicReport, compileOperations, validateBundle } from '../src/data.js'

const viewerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex')
function hasTable(db, table) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) }
function storedState(db, table, required = false) {
  if (!hasTable(db, table)) { if (required) throw new Error(`缺少状态表 ${table}`); return {} }
  const row = db.prepare(`SELECT state FROM ${table} WHERE id=1`).get()
  if (!row) throw new Error(`状态表 ${table} 没有已提交记录`)
  return JSON.parse(row.state)
}
async function readOnlyCopy(source, target) {
  const db = new DatabaseSync(source, { readOnly: true })
  try { await backup(db, target) } finally { db.close() }
  const copy = new DatabaseSync(target, { readOnly: true })
  copy.exec('PRAGMA query_only=ON;')
  return copy
}
const allowedFacts = new Set(['mars-organization', 'mars-native-decision', 'mars-native-admission-closed', 'mars-native-start',
  'mars-mail', 'mars-mail-read', 'mars-mail-created', 'mars-v06-record', 'mars-v06-seal', 'mars-v06-research', 'mars-v06-plan-mutation', 'mars-v06-action',
  'mars-model-request', 'mars-model-usage', 'mars-record-mutation', 'mars-v06-config'])
function publicFact(row) {
  const fact = JSON.parse(row.data_json), d = fact.data ?? {}
  if (!allowedFacts.has(fact.kind)) return null
  let data
  if (fact.kind === 'mars-v06-record') data = pick(d, ['sequence', 'actorId', 'operation', 'result'])
  else if (fact.kind === 'mars-v06-research') data = pick(d, ['actor', 'record'])
  else if (fact.kind === 'mars-v06-plan-mutation' || fact.kind === 'mars-v06-action') data = pick(d, ['actor', 'result'])
  else if (fact.kind === 'mars-record-mutation') data = pick(d, ['result', 'tick'])
  else if (fact.kind === 'mars-organization') data = pick(d, ['kind', 'actorId', 'role', 'tick'])
  else if (fact.kind.startsWith('mars-native-')) data = pick(d, ['actorId', 'tick', 'reason', 'protocol', 'resumed'])
  else if (fact.kind === 'mars-mail') data = { role: d.role, message: pick(d.message, ['id', 'from', 'tick', 'text', 'read']) }
  else if (fact.kind === 'mars-mail-created') data = pick(d, ['id', 'senderId', 'senderRole', 'targetId', 'targetRole', 'content', 'taskId', 'tick'])
  else if (fact.kind.startsWith('mars-model-')) data = pick(d, ['provider', 'model', 'purpose', 'tick', 'actorId', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cost', 'usage'])
  else if (fact.kind === 'mars-v06-config') data = pick(d, ['version', 'implementation', 'stages', 'decisionTicks', 'protocolHash', 'caseManifestHash'])
  else data = pick(d, ['stage', 'tick', 'hash', 'protocolHash', 'selections', 'missing', 'id', 'role', 'ids', 'record', 'task', 'state', 'title', 'assignee', 'revision'])
  return { source: 'execution', seq: row.seq, kind: fact.kind, actorId: fact.actorId ?? null,
    tick: d.tick ?? d.result?.acceptedTick ?? d.result?.updatedTick ?? d.record?.availableAt ?? null, data }
}
function readAnalyses(home) {
  const directory = join(home, 'analysis')
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => /^(a-\d{4,}|analysis-[\w-]+)\.json$/.test(name)).sort().map(name => {
    const value = readJson(join(directory, name))
    return pick(value, ['id', 'actorId', 'asOfTick', 'code', 'codeSha256', 'status', 'output', 'logs', 'error', 'dataAccesses', 'runtimeVersion'])
  })
}
/** Extract one completed source without importing or instantiating the simulation. */
export async function exportRun(directory, expectedMode, temporaryRoot) {
  const home = realpathSync(resolve(directory))
  if (!existsSync(join(home, 'final-report.json'))) throw new Error('实验尚未生成结算报告；不会打开正在运行的世界数据库')
  const manifest = readJson(join(home, 'manifest.public.json')), report = readJson(join(home, 'final-report.json')), identity = readJson(join(home, 'run.json'))
  const mode = { multi: 'multi', 'multi-agent': 'multi', single: 'single', 'single-agent': 'single' }[manifest.mode]
  if (manifest.benchmarkVersion !== 'v0.6' || mode !== expectedMode) throw new Error('运行版本或 Multi / Single 模式与参数不匹配')
  if (report.completionStatus !== 'finalized' || report.tick !== manifest.horizon || !report.phaseSeals?.some(s => s.stage === 'horizon' && s.tick === report.tick))
    throw new Error('实验尚未完成 horizon 结算；不会打开正在运行的世界数据库')
  if (report.protocolHash !== manifest.protocolHash || report.caseManifestHash !== manifest.caseManifestHash) throw new Error('结算与公开运行清单不匹配')
  const working = mkdtempSync(join(temporaryRoot, 'run-')), open = []
  try {
    const labPath = join(working, 'laboratory.sqlite'), executionPath = join(working, 'execution.sqlite')
    const labDb = await readOnlyCopy(join(home, 'device', 'laboratory.sqlite'), labPath); open.push(labDb)
    const executionDb = await readOnlyCopy(join(home, 'execution', 'execution.sqlite'), executionPath); open.push(executionDb)
    const lab = storedState(labDb, 'world', true), systems = storedState(labDb, 'mars_state', true), base = storedState(labDb, 'mars_base', true)
    if (lab.tick !== report.tick) throw new Error('世界快照 tick 与结算报告不同')
    const allEvents = labDb.prepare('SELECT seq,tick,kind,payload FROM events ORDER BY seq').all().map(row => publicEvent({ ...row, payload: JSON.parse(row.payload) }))
    const executions = executionDb.prepare("SELECT id,actor_id,provider_id,state,created_at,updated_at,detail FROM operations WHERE project_id='mars' ORDER BY created_at,id").all()
      .map(r => ({ id: r.id, actorId: r.actor_id, providerId: r.provider_id, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at, detail: r.detail }))
    const facts = executionDb.prepare("SELECT seq,data_json FROM events WHERE project_id='mars' AND type='fact' ORDER BY seq").all().map(publicFact).filter(Boolean)
    const operations = compileOperations(lab.operations ?? [], systems.operations ?? [], executions, allEvents)
    for (const op of operations) if (!op.deviceId) op.deviceId = systems.crops?.find(c => c.id === (op.command.cropId ?? op.command.sourceId))?.chamberId ?? null
    const routes = allEvents.filter(e => e.kind === 'robot-route-accepted').map(e => ({ ...e.payload, tick: e.tick }))
    for (const op of systems.operations ?? []) if (op.segments?.length && !routes.some(r => r.operationId === op.id)) {
      const robotId = op.command.robotId ?? (['panel_clean', 'seal_inspect', 'seal_repair', 'device_service', 'device_reference', 'sensor_calibrate'].includes(op.command.action) ? 'robot-3' : null)
      if (robotId) routes.push({ operationId: op.id, robotId, tick: op.acceptedTick, finishTick: op.completedTick ?? op.nextTick, segments: publicEvent({ seq: 0, tick: 0, kind: '', payload: { segments: op.segments } }).payload.segments })
    }
    routes.sort((a, b) => a.tick - b.tick)
    const telemetry = {}
    if (hasTable(labDb, 'mars_telemetry')) for (const row of labDb.prepare('SELECT tick,channel,value FROM mars_telemetry ORDER BY tick,rowid').all()) {
      if (!/^(energy\.(solar|soc|demand|tau_dust|shed_count|co2_tank)|water\.(tank|reserve)|incubator-[1-4]\.(temperature|light|co2|pressure|nutrient)|[A-Za-z0-9_-]+\.moisture|(?:reservoir|filter|pump)\.doc_inline|filter\.pressure_diff|(?:confirm|imager)\.lamp_intensity|centrifuge-[12]\.vibration_rms|heater-[12]\.heatup_ticks|robot-1\.motor_current|(?:cold-[12]|freezer)\.temperature|power\.[\w-]+)$/.test(row.channel)) continue
      ;(telemetry[row.channel] ??= []).push([row.tick, row.value])
    }
    const participants = [...new Map(facts.filter(f => f.kind === 'mars-organization' && f.data.kind === 'member-joined').map(f => [f.data.actorId, pick(f.data, ['actorId', 'role', 'tick'])])).values()]
    const catalogPath = join(home, 'public', 'science.json')
    const catalog = existsSync(catalogPath) ? pick(readJson(catalogPath), ['version', 'horizon', 'stages', 'commissions', 'tasks', 'scoring', 'instructions', 'limitations', 'instruments', 'services', 'handover']) : null
    const measurements = hasTable(labDb, 'mars_measurements') ? labDb.prepare('SELECT result_id,data FROM mars_measurements ORDER BY result_id').all().map(r => ({ id: r.result_id, data: JSON.parse(r.data) })) : []
    const raw = hasTable(labDb, 'mars_raw') ? labDb.prepare('SELECT key,data FROM mars_raw ORDER BY key').all().map(r => ({ id: r.key, data: JSON.parse(r.data) })) : []
    const complete = allEvents[0]?.kind === 'laboratory-created' && allEvents[0]?.seq === 1 && allEvents.every((e, i) => e.seq === i + 1) && operations.every(o => o.phases.some(p => p.phase === 'loading' || p.phase === 'processing'))
    const warnings = []
    if (!complete) warnings.push('物理事件不完整，未记录区间不还原为完整历史。')
    if (operations.some(o => !o.actorId)) warnings.push('部分物理操作缺少执行账本中的调用角色关联。')
    if (!catalog) warnings.push('没有公开任务目录；按 v0.6 固定任务定义展示。')
    return { id: identity.runId, mode, label: mode === 'multi' ? 'Multi 团队' : 'Single 单体', benchmarkVersion: 'v0.6', tick: lab.tick, horizon: manifest.horizon,
      manifest: pick(manifest, ['benchmarkVersion', 'mode', 'truthHash', 'saltHash', 'scenarioHash', 'historyHash', 'caseManifestHash', 'protocolHash', 'model', 'modelSource', 'stages', 'horizon', 'decisionTicks', 'schedulingProtocol']),
      layout: marsLayout(), snapshot: publicSnapshot(lab, systems, base), events: allEvents, operations, routes, telemetry, participants, facts,
      analyses: readAnalyses(home), measurements, raw, catalog, report: publicReport(report),
      coverage: { operationHistory: Boolean(complete), fromTick: complete ? 0 : (allEvents[0]?.tick ?? lab.tick), toTick: lab.tick,
        snapshotTick: lab.tick, historicalHealth: false, historicalInventory: false, warnings },
      sources: [{ file: 'device/laboratory.sqlite', sha256: hashFile(labPath) }, { file: 'execution/execution.sqlite', sha256: hashFile(executionPath) }],
    }
  } finally { for (const db of open.reverse()) db.close(); rmSync(working, { recursive: true, force: true }) }
}
export async function exportBundle(inputs, output) {
  if (!inputs.length) throw new Error('需要 --multi 或 --single 的已结束运行目录')
  const target = resolve(output)
  for (const input of inputs) {
    const source = realpathSync(resolve(input.directory)), rel = relative(source, target)
    if (rel === '' || !rel.startsWith('..') && !isAbsolute(rel)) throw new Error('输出必须与实验源目录分离')
  }
  if (existsSync(target)) throw new Error('输出已存在，请使用新文件名，避免覆盖已有记录')
  const workRoot = join(viewerRoot, '.work'); mkdirSync(workRoot, { recursive: true })
  const runs = []
  for (const { directory, mode } of inputs) runs.push(await exportRun(directory, mode, workRoot))
  const kinds = new Set(runs.map(run => run.manifest.modelSource === 'scripted-integration' ? 'fixture' : 'experiment'))
  if (kinds.size !== 1) throw new Error('不能将设计/集成样例与正式实验混成一个数据包')
  const bundle = validateBundle({ version: BUNDLE_VERSION, source: [...kinds][0], createdAt: new Date().toISOString(), runs })
  const body = JSON.stringify(bundle)
  if (Buffer.byteLength(body) > MAX_BUNDLE_BYTES) throw new Error('数据包超过 200 MiB，请按运行分别导出')
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body + '\n', { flag: 'wx' })
  return { path: target, runs: runs.map(r => ({ id: r.id, mode: r.mode, tick: r.tick, operations: r.operations.length })), source: bundle.source, bytes: statSync(target).size }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), inputs = []; let output
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1]
      if (!value || !['--multi', '--single', '--out'].includes(flag)) throw new Error('用法：node viewer/scripts/export-run.mjs --multi <已结束目录> --single <已结束目录> --out <新文件.json>')
      if (flag === '--out') output = value; else inputs.push({ directory: value, mode: flag.slice(2) })
    }
    if (!output) throw new Error('缺少 --out')
    console.log(JSON.stringify(await exportBundle(inputs, output)))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
