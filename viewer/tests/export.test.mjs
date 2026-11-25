import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { demoBundle } from '../fixtures/demo.mjs'
import { exportRun, exportBundle } from '../scripts/export-run.mjs'

const secret = 'HIDDEN-TRUTH-MUST-NOT-APPEAR'
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
function sourceFixture(root) {
  const run = demoBundle().runs[0], home = join(root, 'source')
  mkdirSync(join(home, 'device'), { recursive: true }); mkdirSync(join(home, 'execution')); mkdirSync(join(home, 'analysis')); mkdirSync(join(home, 'public'))
  writeFileSync(join(home, 'manifest.public.json'), JSON.stringify({ ...run.manifest, mode: 'multi-agent' }))
  writeFileSync(join(home, 'final-report.json'), JSON.stringify(run.report)); writeFileSync(join(home, 'run.json'), JSON.stringify({ runId: run.id }))
  writeFileSync(join(home, 'public', 'science.json'), JSON.stringify(run.catalog))
  writeFileSync(join(home, 'analysis', 'a-0001.json'), JSON.stringify({ ...run.analyses[0], code: 'throw new Error("MUST NOT EXECUTE");' }))
  writeFileSync(join(home, 'credentials.json'), secret); mkdirSync(`${home}.evaluator`); writeFileSync(join(`${home}.evaluator`, 'truth.json'), secret)
  const labFile = join(home, 'device', 'laboratory.sqlite'), executionFile = join(home, 'execution', 'execution.sqlite')
  const lab = new DatabaseSync(labFile), execution = new DatabaseSync(executionFile)
  lab.exec('PRAGMA journal_mode=WAL; CREATE TABLE world(id INTEGER PRIMARY KEY,config TEXT,state TEXT); CREATE TABLE mars_state(id INTEGER PRIMARY KEY,state TEXT); CREATE TABLE mars_base(id INTEGER PRIMARY KEY,state TEXT); CREATE TABLE events(seq INTEGER PRIMARY KEY,tick INTEGER,kind TEXT,payload TEXT); CREATE TABLE mars_v06_quality(id INTEGER PRIMARY KEY,state TEXT); CREATE TABLE mars_telemetry(tick INTEGER,channel TEXT,value REAL); CREATE TABLE mars_raw(key TEXT,data TEXT); CREATE TABLE mars_measurements(result_id TEXT,data TEXT);')
  const laboratory = { tick: run.tick, ...run.snapshot, operations: run.operations.filter(o => !o.id.startsWith('so-')), appliedFaults: [secret] }
  lab.prepare('INSERT INTO world VALUES(1,?,?)').run(JSON.stringify({ faults: secret, seed: secret }), JSON.stringify(laboratory))
  lab.prepare('INSERT INTO mars_state VALUES(1,?)').run(JSON.stringify({ robots: run.snapshot.robots, crops: run.snapshot.crops.map(c => ({ ...c, infectedSince: secret })), operations: run.operations.filter(o => o.id.startsWith('so-')) }))
  lab.prepare('INSERT INTO mars_base VALUES(1,?)').run(JSON.stringify({ ...run.snapshot, samples: secret, history: secret, energy: run.snapshot.energy, water: { ...run.snapshot.water, resolved: secret } }))
  lab.prepare('INSERT INTO mars_v06_quality VALUES(1,?)').run(JSON.stringify({ contacts: secret }))
  for (const e of run.events) lab.prepare('INSERT INTO events VALUES(?,?,?,?)').run(e.seq, e.tick, e.kind, JSON.stringify(e.payload))
  for (const [channel, points] of Object.entries(run.telemetry)) for (const [tick, value] of points) lab.prepare('INSERT INTO mars_telemetry VALUES(?,?,?)').run(tick, channel, value)
  lab.prepare('INSERT INTO mars_telemetry VALUES(?,?,?)').run(240, 'private.truth', 99999)
  for (const r of run.raw) lab.prepare('INSERT INTO mars_raw VALUES(?,?)').run(r.id, JSON.stringify(r.data))
  for (const r of run.measurements) lab.prepare('INSERT INTO mars_measurements VALUES(?,?)').run(r.id, JSON.stringify(r.data))
  execution.exec('PRAGMA journal_mode=WAL; CREATE TABLE operations(id TEXT,project_id TEXT,actor_id TEXT,provider_id TEXT,state TEXT,created_at TEXT,updated_at TEXT,detail TEXT); CREATE TABLE events(seq INTEGER PRIMARY KEY,project_id TEXT,type TEXT,data_json TEXT);')
  for (const op of run.operations) execution.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?)').run(op.id, 'mars', op.actorId, 'facilities', op.state, '2026-11-16', '2026-11-16', null)
  for (const f of run.facts) execution.prepare('INSERT INTO events VALUES(?,?,?,?)').run(f.seq, 'mars', 'fact', JSON.stringify({ kind: f.kind, actorId: f.actorId, data: f.data }))
  execution.prepare('INSERT INTO events VALUES(?,?,?,?)').run(9999, 'mars', 'fact', JSON.stringify({ kind: 'private-evaluator', data: secret }))
  return { home, run, lab, execution, files: [labFile, `${labFile}-wal`, executionFile, `${executionFile}-wal`] }
}

test('SQLite backup includes committed WAL records, leaves source bytes unchanged, and redacts evaluator data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-viewer-export-')), source = sourceFixture(root), temp = join(root, 'working'); mkdirSync(temp)
  try {
    const before = source.files.map(sha)
    const run = await exportRun(source.home, 'multi', temp)
    assert.equal(run.tick, 240); assert.equal(run.operations.length, 10); assert.equal(run.events.length, 36)
    assert.equal(run.operations.find(o => o.id === 'o-dispenser').actorId, 'multi:water')
    assert.equal(run.raw[0].data.points.length, 600)
    assert.equal(run.analyses[0].code, 'throw new Error("MUST NOT EXECUTE");')
    assert(!JSON.stringify(run).includes(secret)); assert(!Object.hasOwn(run.telemetry, 'private.truth'))
    assert.deepEqual(source.files.map(sha), before)
    assert.deepEqual(readdirSync(temp), [])
    const result = await exportBundle([{ directory: source.home, mode: 'multi' }], join(root, 'out', 'viewer.json'))
    assert.equal(result.source, 'fixture')
    const packet = JSON.parse(readFileSync(result.path, 'utf8')); assert.equal(packet.runs[0].id, source.run.id)
    await assert.rejects(() => exportBundle([{ directory: source.home, mode: 'multi' }], result.path), /输出已存在/)
    await assert.rejects(() => exportBundle([{ directory: source.home, mode: 'multi' }], join(source.home, 'viewer.json')), /输出必须/)
  } finally { source.lab.close(); source.execution.close(); rmSync(root, { recursive: true, force: true }) }
})
test('unfinished sources are rejected before any world database is opened', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-viewer-live-'))
  try {
    writeFileSync(join(root, 'manifest.public.json'), JSON.stringify({ benchmarkVersion: 'v0.6', mode: 'multi-agent', horizon: 2400 }))
    writeFileSync(join(root, 'run.json'), JSON.stringify({ runId: 'unfinished' }))
    await assert.rejects(() => exportRun(root, 'multi', root), /不会打开正在运行/)
    writeFileSync(join(root, 'final-report.json'), JSON.stringify({ completionStatus: 'running', tick: 100 }))
    await assert.rejects(() => exportRun(root, 'multi', root), /不会打开正在运行/)
    assert.deepEqual(readdirSync(root).sort(), ['final-report.json', 'manifest.public.json', 'run.json'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
