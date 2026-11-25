import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { truthFor } from '../fixture.ts'
import { MarsWorld, initialMarsRules } from '../world.ts'
import { marsScenario } from '../scenario.ts'
import { openMarsProviders } from '../providers.ts'
import { V05Planning } from './planning.ts'
import { V05Observations } from './evaluation-input.ts'
import { replayTerminalPlan } from './replay.ts'
import { V05ResearchRecords } from './research-records.ts'
import { V05Predictions } from './predictions.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mars-v05-replay-'))
  const generated = truthFor(join(root, 'seed'))
  const truth = { ...generated.truth, horizon: 12, faults: [{ event: 'E2', deviceId: 'cold-1', tick: 2 }] }
  const scenario = marsScenario(truth), path = join(root, 'scenario.json')
  mkdirSync(join(root, 'device'), { recursive: true }); writeFileSync(path, JSON.stringify(scenario))
  const world = new MarsWorld(join(root, 'device'), scenario, initialMarsRules(), truth)
  const providers = openMarsProviders(world, path, () => {})
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: providers.providers, pollIntervalMs: 5, providerCallTimeoutMs: 1000,
    logicalTick: () => world.observe().tick })
  await engine.open(); engine.createProject('mars', null)
  const context = engine.issueContext('mars', 'author', ['water', 'greenhouse', 'facilities'])
  cleanup.push(async () => { await engine.close(); providers.close(); world.close(); rmSync(root, { recursive: true, force: true }) })
  return { world, engine, context, directory: join(root, 'replays') }
}

it('requires actual terminal state and returns no replay when no timely proposal exists', async () => {
  const options = await fixture()
  await expect(replayTerminalPlan(options)).rejects.toThrow('terminal state')
  while (options.world.observe().tick < 12) options.world.advance()
  expect(await replayTerminalPlan(options)).toBeNull()
  expect(options.world.observe().tick).toBe(12)
})

it('treats the latest invalid proposal as authoritative instead of falling back to an earlier valid plan', async () => {
  const options = await fixture(), { world, engine, context } = options
  const plan = new V05Planning(engine, context, () => world.observe().tick).schedule('scheduled', { title: 'Earlier valid plan',
    steps: [{ id: 'scan', at: 13, providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-1' } }] })
  const observations = new V05Observations(engine, context, () => world.observe().tick)
  observations.submit('valid', { objectiveId: 'PX-04:accuracy:policy', value: { planId: plan.id, planRevision: 1 }, evidence: [] })
  world.advance()
  observations.submit('latest-invalid', { objectiveId: 'PX-04:accuracy:policy', value: { planId: 'missing-plan', planRevision: 1 }, evidence: [] })
  while (world.observe().tick < 12) world.advance()
  expect(await replayTerminalPlan(options)).toBeNull()
})

it('replays the exact preterminal proposal revision for500 ticks, preserving actual source faults', async () => {
  const options = await fixture(), { world, engine, context } = options
  const planning = new V05Planning(engine, context, () => world.observe().tick)
  const repair = { id: 'repair-cold', providerId: 'facilities', at: 24, input: { action: 'repair', deviceId: 'cold-1' } }
  const plan = planning.schedule('original', { title: 'Frozen future scan', steps: [{ id: 'scan', providerId: 'greenhouse',
    at: 13, input: { action: 'scan', chamberId: 'incubator-1' } }, repair] })
  new V05Observations(engine, context, () => world.observe().tick).submit('proposal', {
    objectiveId: 'PX-04:accuracy:policy', value: { planId: plan.id, planRevision: 1 }, evidence: [] })
  world.advance()
  planning.amend('later-edit', plan.id, plan.revision, { title: 'Not the proposed revision', steps: [{ id: 'scan', providerId: 'greenhouse',
    at: 13, input: { action: 'scan', chamberId: 'incubator-2' } }, repair] })
  while (world.observe().tick < 12) world.advance()
  expect(world.observe().devices.find(device => device.id === 'cold-1')?.broken).toBe(true)
  const result = await replayTerminalPlan(options)
  expect(result).toMatchObject({ startTick: 12, endTick: 512, planId: plan.id, planRevision: 1 })
  expect(result!.operations).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'succeeded', input: { action: 'scan', chamberId: 'incubator-1' } })]))
  expect(result!.operations).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'succeeded', input: { action: 'repair', deviceId: 'cold-1' } })]))
  expect(result!.initialDevices.find(device => device.id === 'cold-1')?.broken).toBe(true)
  expect(result!.operationalCompletion).toBe(1)
  expect(result!.researchAttainment).toBe(0) // A scan/repair plan without a scientific forecast cannot earn research credit.
  expect(world.observe().tick).toBe(12)
  expect(world.observe().devices.find(device => device.id === 'cold-1')?.broken).toBe(true)
}, 30000)

it('compares an actual preproposal frozen forecast to sixteen fixed crop targets with new scan evidence', async () => {
  const options = await fixture(), { world, engine, context } = options
  const model = new V05Predictions(engine, context, () => world.observe().tick, new V05ResearchRecords(engine, context, () => world.observe().tick)).registerModel('forecast-model', {
    id: 'growth-forecast', code: 'return { growth_increment_by_crop: Object.fromEntries(input.sensors.crops.map(crop => [crop.id, 0])) }', parameters: {},
    inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-model-v1' })
  const plan = new V05Planning(engine, context, () => world.observe().tick).schedule('scan-plan', { title: 'Validate a forecast',
    steps: [{ id: 'scan', at: 13, providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-1' } }] })
  new V05Observations(engine, context, () => world.observe().tick).submit('forecast-proposal', {
    objectiveId: 'PX-04:accuracy:policy', value: { planId: plan.id, planRevision: 1, modelId: model.id }, evidence: [] })
  while (world.observe().tick < 12) world.advance()
  const result = await replayTerminalPlan(options)
  expect(result).toMatchObject({ modelId: model.id, modelHash: model.hash, modelStatus: 'done', operationalCompletion: 1 })
  expect(result!.scientificTargets).toHaveLength(16)
  expect(result!.scientificScoring.denominator).toBe(16)
  for (const target of result!.scientificTargets) {
    expect(target.predicted).toBe(0)
    expect(target.evidence).toBe(target.chamberId === 'incubator-1')
    const expected = target.evidence ? Math.max(0, 1 - Math.abs(target.actual) / result!.scientificScoring.tolerance) : 0
    expect(target.points).toBeCloseTo(expected, 10)
  }
  expect(result!.researchAttainment).toBeCloseTo(result!.scientificTargets.reduce((sum, target) => sum + target.points, 0) / 16, 10)
  expect(result!.researchAttainment).toBeLessThanOrEqual(0.25)
}, 30000)

it('does not use a model first published after the proposal even if it exists before terminal evaluation', async () => {
  const options = await fixture(), { world, engine, context } = options
  const plan = new V05Planning(engine, context, () => world.observe().tick).schedule('scan-plan', { title: 'Late model cannot backfill',
    steps: [{ id: 'scan', at: 13, providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-1' } }] })
  new V05Observations(engine, context, () => world.observe().tick).submit('proposal', {
    objectiveId: 'PX-04:accuracy:policy', value: { planId: plan.id, planRevision: 1, modelId: 'late-model' }, evidence: [] })
  world.advance()
  new V05Predictions(engine, context, () => world.observe().tick, new V05ResearchRecords(engine, context, () => world.observe().tick)).registerModel('late', {
    id: 'late-model', code: 'return { growth_increment_by_crop: {} }', parameters: {}, inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-model-v1' })
  while (world.observe().tick < 12) world.advance()
  const result = await replayTerminalPlan(options)
  expect(result).toMatchObject({ modelId: null, modelStatus: 'missing', researchAttainment: 0, operationalCompletion: 1 })
}, 30000)
