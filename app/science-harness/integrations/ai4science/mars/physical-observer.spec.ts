/** Real providers retain all state transitions and locks while repeated unchanged polls are bounded. */
import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { truthFor } from './fixture.ts'
import { initialMarsRules } from './world.ts'
import { openMarsProviders } from './providers.ts'
import { V06World } from './v06/world.ts'
import { scienceProfileSchema } from './v06/profile.ts'
import { compileScenario } from './v06/scenario.ts'
import { PhysicalObserver } from './physical-observer.ts'
it('publishes physical completion once and still rejects a revoked context on an unchanged cache hit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-physical-observer-'))
  const { truth } = truthFor(root), stages = { baselineTick: 8, finalTick: 16, horizon: 24 }, profile = scienceProfileSchema.parse({})
  const compiled = compileScenario(truth, stages, profile), path = join(root, 'scenario.json')
  writeFileSync(path, JSON.stringify(compiled.scenario))
  const world = new V06World(join(root, 'device'), compiled.scenario, initialMarsRules(), compiled.truth, profile, stages)
  const providers = openMarsProviders(world, path, () => {})
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: providers.providers, pollIntervalMs: 5, providerCallTimeoutMs: 1000 })
  try {
    await engine.open(); engine.createProject('mars', null)
    const grant = engine.issueContext('mars', 'fixture', ['greenhouse'])
    const first = await engine.submit(grant, { providerId: 'greenhouse', requestKey: 'scan', input: { action: 'scan', chamberId: 'incubator-1' } })
    const query = vi.spyOn(engine, 'query'), observer = new PhysicalObserver(engine, world)
    for (let i = 0; i < 120; i++) expect((await observer.query(grant, first.id)).state).toBe('running')
    expect(query).toHaveBeenCalledTimes(1)
    while (world.observeSystems().operations.find(o => o.id === first.id)?.state === 'running') world.advance()
    const done = await observer.query(grant, first.id)
    expect(done.state).toBe('succeeded'); expect(done.artifacts.length).toBeGreaterThan(0)
    expect(query).toHaveBeenCalledTimes(2)
    expect((await observer.query(grant, first.id)).state).toBe('succeeded')
    engine.revokeContext(grant)
    await expect(observer.query(grant, first.id)).rejects.toThrow()
  } finally { await engine.close(); providers.close(); world.close(); rmSync(root, { recursive: true, force: true }) }
})
