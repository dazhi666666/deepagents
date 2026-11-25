#!/usr/bin/env node
/** Real original history generation, public queries, isolation, checkpoint/restart and corruption rejection. No model. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = join(root, 'demo', '.checks')
mkdirSync(checks, { recursive: true })
const fixture = mkdtempSync(join(checks, 'history-'))
const homes = { multi: join(fixture, 'multi'), single: join(fixture, 'single') }
const args = (mode, home = homes[mode]) => ['--experimental-transform-types', join(root, 'app', 'mars-server.mjs'),
  '--home', home, '--truth', join(root, 'data', 'mars', 'truth.json'), '--mode', mode, '--auto-clock', '0', '--checkpoint-interval', '0', '--model-source', 'scripted-integration']
const command = argv => new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('close', code => resolvePromise({ code, stdout, stderr }))
})
const prepare = (mode, home) => command([...args(mode, home), '--prepare-only'])
const manifest = home => JSON.parse(readFileSync(join(home, 'public/history/manifest.json'), 'utf8'))
const expectedTables = ['chromatograms','corrections','documents','experiments','incidents','lot_qc','lots','maintenance','reference_checks','sensors']
let rpc
try {
  for (const mode of ['multi', 'single']) {
    const result = await prepare(mode)
    assert.equal(result.code, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.prepared, true)
    assert.ok(report.counts.sensors > 10000)
    assert.equal(manifest(homes[mode]).seed, 0)
    assert.ok(existsSync(`${homes[mode]}.evaluator/archive-answers.json`))
    assert.ok(!existsSync(join(homes[mode], 'public/archive-answers.json')))
    assert.ok(!existsSync(join(homes[mode], 'device/laboratory.sqlite')), 'Preparation must not start the clock')
    const effective = JSON.parse(readFileSync(`${homes[mode]}.evaluator/v06-effective-truth.json`, 'utf8'))
    const db = new DatabaseSync(join(homes[mode], 'public/history/history.sqlite'), { readOnly: true })
    try {
      for (const table of expectedTables) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, report.counts[table])
      assert.ok(db.prepare('SELECT lot_id FROM lots').all().some(row => row.lot_id === effective.lots.A1), 'History must use salted effective lots')
    } finally { db.close() }
  }
  assert.equal(manifest(homes.multi).sha256, manifest(homes.single).sha256)
  console.log('PASS full original archives generated from effective truth; all table counts match; paired bytes match; seed/answers stay private')

  const start = () => connectSidecar(spawn(process.execPath, args('multi'), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } }), { label: 'History regression' })
  rpc = start()
  const hello = await rpc.call('hello')
  assert.equal(hello.status.history.installed, true)
  assert.equal(hello.status.tick, 0)
  for (const role of ['brain','water','crops','agronomist','engineer','analyst']) await rpc.call('login', { sessionId: `history_${role}`, role })
  await rpc.call('run.start', { sessionId: 'history_brain' })
  const tool = async (name, args = {}) => (await rpc.call('tools.call', { sessionId: 'history_brain', name, args })).result
  assert.deepEqual(Object.keys(await tool('archive_schema')).sort(), expectedTables)
  const sql = await tool('archive_sql', { sql: 'SELECT COUNT(*) AS n FROM sensors' })
  assert.equal(sql.rows[0].n, manifest(homes.multi).counts.sensors)
  assert.ok((await tool('archive_search', { query: '色谱', limit: 3 })).items.length > 0)
  assert.equal((await tool('archive_query', { kind: 'reference_checks', limit: 2 })).items.length, 2)
  assert.ok((await tool('archive_stats', { entity_id: 'filter', metric: 'removal_rate' })).items.length > 0)
  await assert.rejects(tool('archive_sql', { sql: 'DELETE FROM sensors' }), /single SELECT/)
  const pending = await tool('analysis_run', { code: 'const rows = await archiveSql("SELECT COUNT(*) AS n FROM sensors"); return { n: rows[0].n };' })
  await rpc.call('advance', { steps: 12 }, 300000)
  const receipt = (await tool('round_receipts')).find(item => item.callId === pending.callId)
  assert.equal(receipt.result.status, 'done', JSON.stringify(receipt))
  assert.equal(receipt.result.output.n, manifest(homes.multi).counts.sensors)
  const cp = await rpc.call('checkpoint', { sessionId: 'history_brain', label: 'history' })
  const cpFile = join(fixture, 'checkpoints', cp.id, 'public/history/history.sqlite')
  assert.equal(createHash('sha256').update(readFileSync(cpFile)).digest('hex'), manifest(homes.multi).sha256)
  const before = await tool('archive_sql', { sql: 'SELECT COUNT(*) AS n FROM documents' })
  await rpc.close()
  rpc = start()
  await rpc.call('hello')
  const after = await tool('archive_sql', { sql: 'SELECT COUNT(*) AS n FROM documents' })
  assert.notEqual(after.queryId, before.queryId)
  await rpc.close()
  const restore = await command([join(root, 'app/mars-checkpoint.mjs'), 'restore', cp.id, '--home', homes.multi])
  assert.equal(restore.code, 0, restore.stderr)
  rpc = start()
  assert.equal((await rpc.call('hello')).status.history.installed, true)
  assert.ok((await tool('archive_sql', { sql: 'SELECT COUNT(*) AS n FROM documents' })).rows[0].n > 0)
  console.log('PASS schema/search/query/stats/SQL/isolated analysis; writes refused; checkpoints preserve exact archive bytes; restore resumes query IDs')
  await rpc.close()

  const file = join(homes.single, 'public/history/history.sqlite')
  const bytes = statSync(file).size
  chmodSync(file, 0o600)
  appendFileSync(file, 'x')
  const corrupt = await prepare('single')
  assert.notEqual(corrupt.code, 0)
  assert.match(corrupt.stderr, /integrity check failed/)
  assert.equal(statSync(file).size, bytes + 1, 'Corrupt published history must not be silently replaced')
  copyFileSync(join(homes.multi, 'public/history/history.sqlite'), file)
  rmSync(join(homes.multi, 'public/history'), { recursive: true })
  const late = await prepare('multi')
  assert.notEqual(late.code, 0)
  assert.match(late.stderr, /Cannot add historical data to an existing experiment/)
  const partialHome = join(fixture, 'partial')
  mkdirSync(join(partialHome, 'public/history'), { recursive: true })
  writeFileSync(join(partialHome, 'public/history/manifest.json'), '{}')
  const partial = await prepare('multi', partialHome)
  assert.notEqual(partial.code, 0)
  assert.match(partial.stderr, /Incomplete historical archive/)
  console.log('PASS corrupt/partial history and mid-run archive injection are refused')
  console.log(JSON.stringify({ passed: true, fixture, historyHash: manifest(homes.single).sha256, sensors: manifest(homes.single).counts.sensors, modelCalls: 0 }))
} finally { await rpc?.close() }
