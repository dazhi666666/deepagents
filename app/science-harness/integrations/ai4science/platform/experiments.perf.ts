/** Owner-local diagnostic for fixed-size experiment reads as audit history grows; never executes a Provider action. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { ExecutionEngine } from './execution.ts'
import type { ExecutionProvider } from './sdk.ts'

const { values } = parseArgs({ options: {
  events: { type: 'string', default: '20000' }, reads: { type: 'string', default: '100' }, output: { type: 'string' },
} })
const eventCount = Number(values.events), reads = Number(values.reads)
if (!Number.isSafeInteger(eventCount) || eventCount < 0 || !Number.isSafeInteger(reads) || reads < 1)
  throw new Error('events must be nonnegative and reads must be positive integers')
const root = mkdtempSync(join(tmpdir(), 'ai4s-experiment-perf-'))
const unused = (): never => { throw new Error('This diagnostic must not execute Provider actions') }
const provider: ExecutionProvider = {
  describe: () => ({ apiVersion: 1, id: 'diagnostic', version: '1', configuration: {}, inputSchema: {}, outputSchema: {},
    units: { budget: 'run' }, constraints: [], completion: 'Diagnostic has no work.', cancellation: 'No work runs.' }),
  prepare: unused, submit: unused, query: unused, cancel: unused,
}
const engine = new ExecutionEngine({ directory: root, providers: [provider], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
try {
  await engine.open()
  engine.createProject('p', 1)
  const context = engine.issueContext('p', 'diagnostic', ['diagnostic'])
  const experiment = engine.experiments.create(context, 'fixed', {
    goal: 'Read a fixed experiment without work', method: { id: 'diagnostic', version: '1' }, context: {},
    inputArtifactIds: [], outputRequirements: 'No work', budget: 1, maxOperations: 1,
    actions: [{ id: 'action', providerId: 'diagnostic', input: null, minUses: 0, maxUses: 1, requiresEvidence: false }],
  })
  const setup = new DatabaseSync(join(root, 'execution.sqlite'))
  try {
    setup.exec('BEGIN IMMEDIATE')
    const insert = setup.prepare('INSERT INTO events(operation_id,project_id,type,data_json,at) VALUES(NULL,?,?,?,?)')
    for (let i = 0; i < eventCount; i++) insert.run('p', 'diagnostic-history', '{}', '2026-01-01T00:00:00.000Z')
    setup.exec('COMMIT')
  } finally { setup.close() }
  for (let i = 0; i < 10; i++) engine.experiments.get(context, experiment.id)
  globalThis.gc?.()
  const before = process.memoryUsage()
  let peakHeap = before.heapUsed, peakRss = before.rss
  const started = performance.now()
  for (let i = 0; i < reads; i++) {
    engine.experiments.get(context, experiment.id)
    const memory = process.memoryUsage()
    peakHeap = Math.max(peakHeap, memory.heapUsed)
    peakRss = Math.max(peakRss, memory.rss)
  }
  const elapsedMs = performance.now() - started
  globalThis.gc?.()
  const retained = process.memoryUsage()
  const result = { events: eventCount, reads, elapsedMs, perReadMs: elapsedMs / reads,
    heapBefore: before.heapUsed, peakHeap, retainedHeap: retained.heapUsed, rssBefore: before.rss, peakRss, retainedRss: retained.rss,
    node: process.version, platform: process.platform, arch: process.arch, providerActions: 0 }
  if (values.output) writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(result))
} finally {
  await engine.close()
  rmSync(root, { recursive: true, force: true })
}
