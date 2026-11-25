/** Owner-local listing diagnostic with fixed terminal operations and metadata-only artifacts; no Provider work runs. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { ExecutionEngine } from './execution.ts'
import { canonicalJson, type ExecutionProvider } from './sdk.ts'
import { jsonValue } from './tool.ts'

const { values } = parseArgs({ options: {
  operations: { type: 'string', default: '1000' }, artifacts: { type: 'string', default: '2' },
  reads: { type: 'string', default: '20' }, output: { type: 'string' },
} })
const count = Number(values.operations), artifacts = Number(values.artifacts), reads = Number(values.reads)
if (![count, reads].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(artifacts) || artifacts < 0)
  throw new Error('operations/reads must be positive integers and artifacts must be nonnegative')
const directory = mkdtempSync(join(tmpdir(), 'ai4s-list-perf-'))
const unused = (): never => { throw new Error('Listing must not invoke a Provider action') }
const provider: ExecutionProvider = {
  describe: () => ({ apiVersion: 1, id: 'diagnostic', version: '1', configuration: {}, inputSchema: {}, outputSchema: {},
    units: { budget: 'run' }, constraints: [], completion: 'No work runs.', cancellation: 'No work runs.' }),
  prepare: unused, submit: unused, query: unused, cancel: unused,
}
const engine = new ExecutionEngine({ directory, providers: [provider], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
try {
  await engine.open()
  engine.createProject('p', count)
  const context = engine.issueContext('p', 'diagnostic', ['diagnostic'])
  const db = new DatabaseSync(join(directory, 'execution.sqlite'))
  try {
    db.exec('BEGIN IMMEDIATE')
    const operation = db.prepare(`INSERT INTO operations(id,project_id,actor_id,provider_id,provider_version,provider_fingerprint,
      request_key,request_json,input_json,resources_json,budget,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const artifact = db.prepare('INSERT INTO artifacts(id,operation_id,path,sha256,bytes,media_type) VALUES(?,?,?,?,?,?)')
    const at = '2026-01-01T00:00:00.000Z', fingerprint = canonicalJson(jsonValue(provider.describe()))
    for (let i = 0; i < count; i++) {
      const id = `op-${i}`
      operation.run(id, 'p', 'diagnostic', 'diagnostic', '1', fingerprint, id, '{}', 'null', '[]', 1, 'succeeded', at, at)
      for (let j = 0; j < artifacts; j++) artifact.run(`${id}-${j}`, id, `artifacts/${id}/${j}.json`, '0'.repeat(64), 0, 'application/json')
    }
    db.exec('COMMIT')
  } finally { db.close() }
  for (let i = 0; i < 3; i++) engine.list(context)
  globalThis.gc?.()
  const before = process.memoryUsage()
  let peakHeap = before.heapUsed, peakRss = before.rss
  const start = performance.now()
  for (let i = 0; i < reads; i++) {
    const rows = engine.list(context)
    if (rows.length !== count || rows.reduce((n, row) => n + row.artifacts.length, 0) !== count * artifacts)
      throw new Error('Listing changed the workload result')
    const memory = process.memoryUsage()
    peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss)
  }
  const elapsedMs = performance.now() - start
  globalThis.gc?.()
  const retained = process.memoryUsage()
  const result = { operations: count, artifactsPerOperation: artifacts, reads, elapsedMs, perReadMs: elapsedMs / reads,
    heapBefore: before.heapUsed, peakHeap, retainedHeap: retained.heapUsed, rssBefore: before.rss, peakRss, retainedRss: retained.rss,
    node: process.version, platform: process.platform, arch: process.arch, providerActions: 0 }
  if (values.output) writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(result))
} finally { await engine.close(); rmSync(directory, { recursive: true, force: true }) }
