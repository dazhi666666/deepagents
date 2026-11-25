import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { AnalysisRegistry } from '../analysis.ts'
import { truthFor } from '../fixture.ts'
import { MarsWorld, initialMarsRules } from '../world.ts'
import { marsScenario } from '../scenario.ts'
import { finalizeV05 } from './finalize.ts'
import { openMarsProviders } from '../providers.ts'
import { V05ResearchRecords } from './research-records.ts'
import { V05Predictions } from './predictions.ts'
import { V05Observations } from './evaluation-input.ts'

it('refuses live scientific evaluation and gives no scientific or knowledge credit for doing nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-v05-finalize-')), { truth } = truthFor(join(root, 'run'))
  const shortTruth = { ...truth, horizon: 24 }, world = new MarsWorld(join(root, 'world'), marsScenario(shortTruth), initialMarsRules(), shortTruth)
  const engine = { readFacts: () => [], list: () => [], events: () => [] } as unknown as ExecutionEngine
  const context = { projectId: 'mars', actorId: 'host', allowedProviders: ['water', 'greenhouse', 'facilities'] } as OperationContext
  const analysis = { ids: () => new Set<string>() } as unknown as AnalysisRegistry
  try {
    await expect(finalizeV05({ engine, context, analysis, world })).rejects.toThrow('terminal-only')
    while (world.observe().tick < shortTruth.horizon) world.advance()
    const result = await finalizeV05({ engine, context, analysis, world })
    expect(result.maximum).toBeCloseTo(100)
    expect(result.components.R).toBe(0)
    expect(result.components.K).toBe(0)
    expect(result.components.Q).toBe(0)
    expect(result.objectives.filter(o => o.id.startsWith('PX-04')).every(o => o.points === 0)).toBe(true)
    expect(result.replay).toBeNull()
  } finally { world.close() }
})

it('scores actual physical evidence and frozen code output, ignoring the submitted perfect-looking number', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-v05-real-finalize-')), { truth } = truthFor(join(root, 'run'))
  const shortTruth = { ...truth, horizon: 120 }, world = new MarsWorld(join(root, 'world'), marsScenario(shortTruth), initialMarsRules(), shortTruth)
  const { writeFileSync } = await import('node:fs')
  const scenarioFile = join(root, 'scenario.json'); writeFileSync(scenarioFile, JSON.stringify(marsScenario(shortTruth)))
  const providers = openMarsProviders(world, scenarioFile, () => {})
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: providers.providers, pollIntervalMs: 5, providerCallTimeoutMs: 1000, logicalTick: () => world.observe().tick })
  await engine.open(); engine.createProject('mars', null)
  const context = engine.issueContext('mars', 'scientist', ['water', 'facilities', 'greenhouse']), now = () => world.observe().tick
  const analysis = new AnalysisRegistry(join(root, 'analysis'))
  try {
    const sample = await engine.submit(context, { providerId: 'water', requestKey: 'current-reservoir', input: { action: 'sample', sourceId: 'reservoir', volumeUl: 400, container: 'tube' } })
    const reference = await engine.submit(context, { providerId: 'facilities', requestKey: 'independent-reference', input: { action: 'device_reference', targetId: 'reservoir' } })
    while (world.observeSystems().operations.find(o => o.id === reference.id)?.state !== 'succeeded' && now() < 100) { world.advance(); await engine.reconcile(context) }
    await engine.reconcile(context)
    const referenceResult = world.observeSystems().operations.find(o => o.id === reference.id)!.result
    const artifactId = engine.list(context).find(o => o.id === reference.id)!.artifacts[0]!.id
    const run = await analysis.run(context.actorId, now(), `const result=await readArtifact(${JSON.stringify(artifactId)}); return {doc: result.result.reference.docInline}`, () => ({
      readArtifact: id => { if (id !== artifactId) throw new Error('Unknown public artifact'); return { result: referenceResult! } }, readRaw: () => { throw new Error('Not requested') }, telemetry: () => { throw new Error('Not requested') }, archiveSql: () => { throw new Error('Not requested') },
    }))
    expect(run.status).toBe('done')
    engine.recordFact(context, 'mars-v05-analysis-published', { id: run.id, tick: now() })
    const doc = (run.output as { doc: number }).doc
    const records = new V05ResearchRecords(engine, context, now)
    const predictions = new V05Predictions(engine, context, now, records, () => ({ availableAt: shortTruth.horizon, policyHash: 'terminal-water-probe' }))
    predictions.registerModel('model', { id: 'measured-water-model', code: 'return {holdout_concentration: {reservoir: parameters.measuredDoc}}', parameters: { measuredDoc: doc }, inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-model-v1' })
    predictions.commit('prediction', { id: 'water-commit', target: 'PW-01:holdout', modelId: 'measured-water-model', inputDomain: { source: 'reservoir', condition: 'baseline-no-contamination' } })
    const observations = new V05Observations(engine, context, now, id => [run.id, sample.id].includes(id) ? { availableAt: now() } : null)
    observations.submit('select-prediction', { objectiveId: 'PW-01:test:holdout_concentration:reservoir', value: 999999,
      evidence: [{ id: run.id, purpose: 'validation' }, { id: sample.id, purpose: 'validation' }], predictionId: 'water-commit' })
    while (now() < shortTruth.horizon) { world.advance(); await engine.reconcile(context) }
    const result = await finalizeV05({ engine, context, analysis, world })
    const scientific = result.objectives.find(o => o.id === 'PW-01:test:holdout_concentration:reservoir')!
    expect(scientific.support).toBe(1)
    expect(scientific.points).toBeGreaterThan(0)
    expect(scientific.accuracy).toBeGreaterThan(0.8)
    expect(result.validation.some(v => v.objectiveId === scientific.id && v.status === 'done')).toBe(true)
  } finally { await engine.close(); providers.close(); world.close() }
}, 30000)
