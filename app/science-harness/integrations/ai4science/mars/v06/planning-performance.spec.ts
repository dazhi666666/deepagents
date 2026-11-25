/** Opt-in measurement uses the same SQLite journal and large finite plan as live scheduling. */
import { it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { V05Planning } from '../v05/planning.ts'
import { V06Records } from './records.ts'
import { V06Stages } from './stages.ts'
import { contentHash } from './contracts.ts'
it.skipIf(process.env.MARS_V06_PLANNING_PERF !== '1')('measures repeated durable reads of an unchanged large plan', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mars-planning-perf-'))
  const engine = new ExecutionEngine({ directory, providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  await engine.open(); engine.createProject('mars', null)
  const grant = engine.issueContext('mars', 'fixture', [])
  try {
    const plan = { id: 'plan', actorId: grant.actorId, createdTick: 0, title: 'Finite crossed coverage', steps: Array.from({ length: 160 }, (_, i) => ({ id: String(i), providerId: 'greenhouse', at: i * 4, input: { action: 'scan', chamberId: `incubator-${i % 4 + 1}` }, dependsOn: [], reservationIds: [] })) }
    for (let revision = 1; revision <= 160; revision++) engine.recordFact(grant, 'mars-v06-plan-mutation', { key: `plan-step:${revision}`, input: '{}', result: { ...plan, revision, operations: {}, state: 'running' } })
    const planning = new V05Planning(engine, grant, () => 0, {}, undefined, 'v06')
    const start = performance.now(), memory = process.memoryUsage().heapUsed
    for (let i = 0; i < 120; i++) expect(planning.list()[0]?.revision).toBe(160)
    const result = { measurement: 'large-plan-stable-reads', reads: 120, elapsedMs: performance.now() - start,
      heapGrowth: process.memoryUsage().heapUsed - memory, residentBytes: process.memoryUsage().rss, maximumResidentKb: process.resourceUsage().maxRSS }
    const profile = { baselineTick: 720, finalTick: 1800, horizon: 2400 }, hash = contentHash('performance-protocol')
    const oldJournal = { readFacts: engine.readFacts.bind(engine), recordFact: engine.recordFact.bind(engine) }
    const beforeStages = new V06Stages(oldJournal, grant, profile, hash, () => 0, new V06Records(oldJournal, grant, () => 0, profile))
    const afterStages = new V06Stages(engine, grant, profile, hash, () => 0, new V06Records(engine, grant, () => 0, profile))
    const boundaries = (stages: V06Stages) => {
      const started = performance.now()
      for (let i = 0; i < 120; i++) { engine.recordFact(grant, 'performance-progress', { tick: i }); expect(stages.nextBoundary()).toBe(720) }
      return performance.now() - started
    }
    const stageReads = { fullReadMs: boundaries(beforeStages), incrementalMs: boundaries(afterStages) }
    const output = process.env.MARS_V06_PLANNING_PERF_OUTPUT
    if (output) writeFileSync(output, JSON.stringify({ ...result, stageReads }), { flag: 'wx' })
    console.log(JSON.stringify(result))
  } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }) }
}, 60000)
