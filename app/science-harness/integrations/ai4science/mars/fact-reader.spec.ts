/** Incremental reads retain authorization, cross-writer visibility and detached caller values. */
import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { FactReader } from './fact-reader.ts'
import { V05Planning } from './v05/planning.ts'
it('reads newly appended facts once and rechecks revoked authority on a cache hit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mars-fact-reader-'))
  const engine = new ExecutionEngine({ directory, providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  await engine.open(); engine.createProject('mars', null)
  const grant = engine.issueContext('mars', 'reader', []), writer = engine.issueContext('mars', 'writer', [])
  try {
    const events = vi.spyOn(engine, 'events'), facts = new FactReader(engine, grant)
    engine.recordFact(writer, 'fixture', { value: 1 })
    expect(facts.read()).toEqual([{ actorId: 'writer', kind: 'fixture', data: { value: 1 } }])
    const reads = events.mock.calls.length
    facts.read(); expect(events.mock.calls).toHaveLength(reads)
    engine.recordFact(writer, 'fixture', { value: 2 })
    expect(facts.read()).toHaveLength(2)
    const planning = new V05Planning(engine, grant, () => 0, {}, undefined, 'v06')
    const plan = planning.schedule('plan', { title: 'original', steps: [{ id: 'a', providerId: 'water', input: {} }] })
    planning.list()[0]!.steps[0]!.input = { changed: true }
    expect(planning.list()[0]?.steps[0]?.input).toEqual({})
    const retry = planning.schedule('plan', { title: 'original', steps: [{ id: 'a', providerId: 'water', input: {} }] })
    retry.title = 'mutated'
    expect(planning.list()[0]?.title).toBe('original'); expect(plan.id).toBe(retry.id)
    engine.revokeContext(grant)
    expect(() => facts.read()).toThrow()
  } finally { await engine.close(); rmSync(directory, { recursive: true, force: true }) }
})
