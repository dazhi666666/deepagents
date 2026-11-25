/** Owner-local artifact verification diagnostic with real files and fixed metadata; no execution SQL or Provider actions. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { Artifacts, type ProjectArtifact } from './artifacts.ts'
import type { ExecutionEngine } from './execution.ts'
import type { OperationContext } from './sdk.ts'

const { values } = parseArgs({ options: {
  reads: { type: 'string', default: '40' }, reports: { type: 'string', default: '24' }, output: { type: 'string' },
} })
const reads = Number(values.reads), reportCount = Number(values.reports)
if (![reads, reportCount].every(value => Number.isSafeInteger(value) && value > 0))
  throw new Error('reads and reports must be positive integers')
if (!globalThis.gc) throw new Error('Run this diagnostic with --expose-gc')
const root = mkdtempSync(join(tmpdir(), 'ai4s-artifact-perf-'))
const context: OperationContext = { projectId: 'p', actorId: 'diagnostic', allowedProviders: ['fixed'] }
const facts: ReturnType<ExecutionEngine['readFacts']> = []
let metadataReads = 0
const metadata: Pick<ExecutionEngine, 'directory' | 'readFacts' | 'list' | 'recordFact'> = {
  directory: root,
  readFacts(c) {
    if (c !== context) throw new Error('Invalid diagnostic context')
    metadataReads++
    return facts
  },
  list(c) {
    if (c !== context) throw new Error('Invalid diagnostic context')
    metadataReads++
    return []
  },
  recordFact() { throw new Error('Diagnostic metadata is fixed') },
}
try {
  mkdirSync(join(root, 'project-artifacts'))
  const add = (id: string, bytes: number, sources: string[]) => {
    const content = Buffer.alloc(bytes, id.charCodeAt(0))
    const artifact: ProjectArtifact = { id, projectId: 'p', actorId: 'diagnostic', path: `project-artifacts/${id}`,
      sha256: createHash('sha256').update(content).digest('hex'), bytes, mediaType: 'text/plain', sources }
    writeFileSync(join(root, artifact.path), content, { flag: 'wx', mode: 0o600 })
    facts.push({ actorId: 'diagnostic', kind: 'artifact-published', data: { ...artifact } })
  }
  for (let i = 0; i < 4; i++) {
    add(`source-${i}`, 512 * 1024, [])
    add(`analysis-${i}`, 128 * 1024, [`source-${i}`])
  }
  const reports = Array.from({ length: reportCount }, (_, i) => `report-${i}`)
  for (let i = 0; i < reports.length; i++) add(reports[i]!, 256 * 1024, [`analysis-${i % 4}`])
  const artifacts: { read: Artifacts['read']; verify?: (c: OperationContext, id: string) => ProjectArtifact } = new Artifacts(metadata)
  const verify = artifacts.verify?.bind(artifacts) ?? ((c: OperationContext, id: string) => artifacts.read(c, id).artifact)
  for (const id of reports) verify(context, id)
  globalThis.gc()
  const before = process.memoryUsage()
  let peakHeap = before.heapUsed, peakRss = before.rss
  metadataReads = 0
  const started = performance.now()
  for (let i = 0; i < reads; i++) {
    for (const id of reports) {
      verify(context, id)
      const memory = process.memoryUsage()
      peakHeap = Math.max(peakHeap, memory.heapUsed)
      peakRss = Math.max(peakRss, memory.rss)
    }
  }
  const elapsedMs = performance.now() - started
  globalThis.gc()
  const retained = process.memoryUsage()
  const result = { reads, reports: reportCount, verifications: reads * reportCount, bytesPerReport: 256 * 1024,
    sourceBytes: 512 * 1024, analysisBytes: 128 * 1024, sourceDepth: 2, warmupPasses: 1,
    verificationMode: artifacts.verify ? 'verify' : 'strict-read-baseline', elapsedMs, perStateMs: elapsedMs / reads,
    heapBefore: before.heapUsed, peakHeap, retainedHeap: retained.heapUsed,
    rssBefore: before.rss, peakRss, retainedRss: retained.rss, processMaxRss: process.resourceUsage().maxRSS * 1024,
    metadataReads, node: process.version, platform: process.platform, arch: process.arch, providerActions: 0, executionSql: false }
  if (values.output) writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(result))
} finally {
  rmSync(root, { recursive: true, force: true })
}
