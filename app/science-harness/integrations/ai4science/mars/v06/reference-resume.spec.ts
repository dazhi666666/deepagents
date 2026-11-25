/** Opt-in continuation of an already sealed public reference; no research or submissions may be repeated. */
import { expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { boot } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { mountMars } from '../runtime.ts'
import { loadTruth } from '../truth.ts'
import { reportStopped } from '../report.ts'
import { stageProfileSchema } from './contracts.ts'
import { scienceProfileSchema } from './profile.ts'
it.skipIf(!process.env.MARS_V06_REFERENCE_RESUME)('continues frozen validation without reopening published research or replaying completed work', async () => {
  const directory = process.env.MARS_V06_REFERENCE_RESUME!
  const truthFile = `${directory}.evaluator/truth.json`
  const settings = z.object({ scienceProfile: scienceProfileSchema, stageProfile: stageProfileSchema, decisionTicks: z.number(), instanceFile: z.string() })
    .parse(JSON.parse(readFileSync(`${directory}.evaluator/v06-runtime.json`, 'utf8')))
  const manifest = z.object({ sourceHash: z.string(), model: z.object({ provider: z.string(), model: z.string(), maxTokens: z.number() }) })
    .parse(JSON.parse(readFileSync(join(directory, 'manifest.public.json'), 'utf8')))
  const probe = await boot('v06-resume-public-reference', true, async () => ({ withoutScience: true,
    configs: { jsonl: { root: join(directory, 'sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  let runtime: Awaited<ReturnType<typeof mountMars>> | undefined
  try {
    runtime = await mountMars(probe.ctx, { benchmarkVersion: 'v0.6', implementation: 'scientific_candidate', directory, truthFile,
      stageProfile: settings.stageProfile, scienceProfile: settings.scienceProfile, instanceFile: settings.instanceFile, decisionTicks: settings.decisionTicks,
      mode: 'environment', seed: loadTruth(truthFile).seed, port: 0, model: manifest.model, resume: true,
      frozenSourceHash: manifest.sourceHash, pollIntervalMs: 5, providerCallTimeoutMs: 1000 })
    const grant = runtime.engine.issueContext('mars', 'reference-resume-verifier', ['water', 'greenhouse', 'facilities'])
    const original = runtime.engine.readFacts(grant), startTick = runtime.world.observe().tick
    const originalSeals = runtime.science!.stages.seals()
    expect(startTick).toBeGreaterThanOrEqual(settings.stageProfile.finalTick)
    expect(originalSeals.at(-1)?.stage).toBe('final')
    const traceComplete = original.some(f => f.kind === 'mars-v06-reference-progress' && z.object({ event: z.string() }).parse(f.data).event === 'final-models-and-plans')
    expect(traceComplete).toBe(true)
    expect(originalSeals.at(-1)?.selections).toHaveLength(6)
    const researchCount = original.filter(f => f.kind === 'mars-v06-record').length
    const completed = runtime.engine.list(grant).filter(o => o.state === 'succeeded').map(o => o.id)
    runtime.engine.recordFact(grant, 'mars-v06-reference-validation-resumed', { tick: startTick, finalSealHash: originalSeals.at(-1)!.hash })
    await runtime.advanceScientificTo(settings.stageProfile.horizon)
    const score = z.record(z.string(), z.json()).parse(await runtime.finalize())
    expect(runtime.engine.readFacts(grant).filter(f => f.kind === 'mars-v06-record')).toHaveLength(researchCount)
    expect(runtime.science!.stages.seals().slice(0, originalSeals.length)).toEqual(originalSeals)
    expect(completed.every(id => runtime!.engine.get(grant, id).state === 'succeeded')).toBe(true)
    expect(probe.model.requests).toHaveLength(0)
    const report = { version: 'v0.6-reference', modelCalls: 0, sourceHash: manifest.sourceHash,
      referenceCase: { condition: settings.scienceProfile.condition, seed: loadTruth(truthFile).seed },
      policyCompleted: traceComplete, jointFeasibility: score.F === true, resumedFrozenValidation: true, resumedAtTick: startTick,
      scope: 'Original public policy sealed all six submissions; only its previously selected finite validation plan continues.', score }
    writeFileSync(join(directory, 'feasibility-resume-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    await runtime.close(); runtime = undefined
    const offline = await reportStopped({ directory, truthFile })
    expect(offline).toEqual(score)
    expect(report.jointFeasibility, JSON.stringify(score)).toBe(true)
  } finally { await runtime?.close(); await probe.close() }
}, 600000)
