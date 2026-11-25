/** Opt-in projection measurement over a synthetic durable operation journal, never a scored attempt. */
import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { truthFor } from '../fixture.ts'
import { MarsWorld, initialMarsRules } from '../world.ts'
import { LaboratoryRefusal } from '../../greenhouse/laboratory/world.ts'
import { V06World } from './world.ts'
import { compileScenario } from './scenario.ts'
import { scienceProfileSchema } from './profile.ts'
it.skipIf(process.env.MARS_V06_WORLD_PERF !== '1')('measures unchanged physical projection reads', () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-world-read-perf-'))
  const profile = scienceProfileSchema.parse({}), stages = { baselineTick: 120, finalTick: 450, horizon: 600 }
  const compiled = compileScenario(truthFor(root).truth, stages, profile)
  const world = new V06World(join(root, 'device'), compiled.scenario, initialMarsRules(), compiled.truth, profile, stages)
  try {
    for (let i = 0; i < 160; i++) world.refuseSystem(`synthetic-refusal-${i}`, 'mars', String(i), { action: 'scan', chamberId: 'incubator-1' }, new LaboratoryRefusal('busy', 'Synthetic projection measurement'))
    const measure = (read: () => ReturnType<MarsWorld['observeSystems']>) => {
      const start = performance.now(), heap = process.memoryUsage().heapUsed
      for (let i = 0; i < 120; i++) expect(read().operations).toHaveLength(160)
      return { elapsedMs: performance.now() - start, heapGrowth: process.memoryUsage().heapUsed - heap,
        residentBytes: process.memoryUsage().rss, maximumResidentKb: process.resourceUsage().maxRSS }
    }
    const uncached = measure(() => MarsWorld.prototype.observeSystems.call(world)), cached = measure(() => world.observeSystems())
    const output = process.env.MARS_V06_WORLD_PERF_OUTPUT
    if (output) writeFileSync(output, JSON.stringify({ measurement: 'unchanged-physical-view', operations: 160, reads: 120, uncached, cached }), { flag: 'wx' })
  } finally { world.close(); rmSync(root, { recursive: true, force: true }) }
}, 60000)
