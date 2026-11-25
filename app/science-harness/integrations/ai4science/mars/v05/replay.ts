/** Offline deterministic terminal-plan replay from a SQLite backup of the realized laboratory. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { ExecutionEngine as ReplayEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { MarsWorld } from '../world.ts'
import { marsScenario } from '../scenario.ts'
import { openMarsProviders } from '../providers.ts'
import { V05Planning, planInputSchema } from './planning.ts'
import { modelArtifactSchema } from './predictions.ts'
import { runFrozenModel } from './model-execution.ts'

/** Candidate absolute tolerance in simulated growth-index units; requires development calibration before freeze. */
export const REPLAY_GROWTH_TOLERANCE = 0.15

export async function replayTerminalPlan(options: { world: MarsWorld; engine: ExecutionEngine; context: OperationContext; directory: string }) {
  const { world, engine, context } = options
  if (world.observe().tick !== world.horizon) throw new Error('Terminal replay requires actual terminal state')
  const facts = engine.readFacts(context)
  const submissions = facts.flatMap((fact, factIndex) => fact.kind === 'mars-v05-observation' ? [{ ...z.object({ observation: z.object({ objectiveId: z.string(), submittedAt: z.number(), value: z.unknown() }) }).parse(fact.data).observation, factIndex }] : [])
  const proposal = submissions.filter(item => item.objectiveId.startsWith('PX-04:') && item.submittedAt < world.horizon)
    .sort((a, b) => b.submittedAt - a.submittedAt || b.factIndex - a.factIndex)[0]
  if (!proposal) return null
  const proposed = z.object({ planId: z.string(), planRevision: z.number().int().positive(), modelId: z.string().optional() }).safeParse(proposal.value)
  if (!proposed.success) return null
  const { planId, planRevision } = proposed.data
  // The model must exist before the proposal, not merely before terminal evaluation.
  const publishedModels = facts.slice(0, proposal.factIndex).filter(fact => fact.kind === 'mars-v05-model')
    .map(fact => modelArtifactSchema.parse((fact.data as { result: unknown }).result))
  const selectedModels = proposed.data.modelId ? publishedModels.filter(model => model.id === proposed.data.modelId && model.createdTick <= proposal.submittedAt) : []
  const frozenModel = selectedModels.length === 1 ? selectedModels[0] : undefined
  const plan = facts.slice(0, proposal.factIndex).filter(fact => fact.kind === 'mars-v05-plan-mutation')
    .map(fact => (fact.data as unknown as { result: import('./planning.ts').Plan }).result)
    .find(item => item.id === planId && item.revision === planRevision)
  if (!plan || plan.state === 'cancelled') return null
  const remaining = plan.steps.filter(step => step.at >= world.horizon)
  if (!remaining.length) return null
  const ids = new Set(remaining.map(step => step.id))
  for (const step of remaining) for (const dependency of step.dependsOn) if (!ids.has(dependency)) {
    const operation = plan.operations[dependency]
    // A preterminal dependency still running at H needs journal migration, which this adapter does not support.
    // Treat that proposal as unavailable instead of pretending the predecessor completed.
    if (!operation || engine.list(context).find(item => item.id === operation)?.state !== 'succeeded') return null
  }
  const frozen = planInputSchema.parse({ title: plan.title, steps: remaining.map(step => ({ ...step, reservationIds: [], dependsOn: step.dependsOn.filter(id => ids.has(id)) })) })
  const root = join(options.directory, `replay-${randomUUID()}`), device = join(root, 'device')
  mkdirSync(device, { recursive: true, mode: 0o700 })
  const original = new DatabaseSync(join(world.directory, 'laboratory.sqlite'), { readOnly: true })
  try { await backup(original, join(device, 'laboratory.sqlite')) } finally { original.close() }
  const truth = { ...structuredClone(world.truth), horizon: world.horizon + 500 }
  const scenario = marsScenario(truth), scenarioFile = join(root, 'scenario.json')
  writeFileSync(scenarioFile, JSON.stringify(scenario), { mode: 0o600 })
  const clone = new MarsWorld(device, scenario, world.rules, truth)
  const providers = openMarsProviders(clone, scenarioFile, () => {})
  const replay = new ReplayEngine({ directory: join(root, 'execution'), providers: providers.providers, pollIntervalMs: 5, providerCallTimeoutMs: 10000, logicalTick: () => clone.observe().tick })
  try {
    await replay.open(); replay.createProject('mars', null)
    const grant = replay.issueContext('mars', 'terminal-policy', ['water', 'greenhouse', 'facilities'])
    const planning = new V05Planning(replay, grant, () => clone.observe().tick)
    planning.schedule('terminal-plan', frozen)
    const initial = clone.sensors(), initialDevices = clone.observe().devices.map(device => ({ id: device.id, broken: device.broken })), trajectory: unknown[] = []
    const initialGrowth = clone.observeSystems().crops.map(crop => ({ id: crop.id, chamberId: crop.chamberId, growth: crop.growth }))
    // Predictions are executed before any future state is simulated, with public sensor inputs only.
    const forecast = frozenModel ? await runFrozenModel(frozenModel, [z.json().parse({ sensors: initial, elapsedTicks: 500 })]) : null
    while (clone.observe().tick < truth.horizon) {
      await replay.reconcile(grant)
      try { await planning.advance(async (providerId, input, requestKey) => {
        const op = await replay.submit(grant, { providerId, input, requestKey }); return { id: op.id, state: op.state }
      }, id => replay.list(grant).find(op => op.id === id)?.state) } catch { /* real refusals retain their cost; later ticks may retry */ }
      clone.advance(truth.horizon)
      trajectory.push({ tick: clone.observe().tick, sensors: clone.sensors() })
    }
    await replay.reconcile(grant)
    const executed = replay.list(grant), done = executed.filter(op => op.state === 'succeeded')
    const scientific = frozen.steps.filter(step => ['scan', 'sample', 'process'].includes((step.input as { action?: string }).action ?? ''))
    const scienceDone = done.filter(op => ['scan', 'sample', 'process'].includes((op.input as { action?: string }).action ?? ''))
    const final = clone.sensors(), base = clone.observeBase()
    const operationalCompletion = scientific.length ? Math.min(1, scienceDone.length / scientific.length) : 0
    const predictions = forecast?.status === 'done' ? z.object({ growth_increment_by_crop: z.record(z.string(), z.number().finite()) }).safeParse(forecast.outputs[0]) : null
    const scanned = new Set(done.filter(op => (op.input as { action?: string }).action === 'scan').map(op => (op.input as { chamberId: string }).chamberId))
    const finalGrowth = new Map(clone.observeSystems().crops.map(crop => [crop.id, crop.growth]))
    const scientificTargets = initialGrowth.map(crop => {
      const actual = finalGrowth.get(crop.id)! - crop.growth
      const predicted = predictions?.success ? predictions.data.growth_increment_by_crop[crop.id] : undefined
      const evidence = scanned.has(crop.chamberId)
      const accuracy = predicted !== undefined ? Math.max(0, 1 - Math.abs(predicted - actual) / REPLAY_GROWTH_TOLERANCE) : 0
      return { cropId: crop.id, chamberId: crop.chamberId, actual, predicted: predicted ?? null, evidence, accuracy, points: evidence ? accuracy : 0 }
    })
    // The fixed denominator is all crops present in the realized laboratory, not the chosen plan's step count.
    const researchAttainment = scientificTargets.reduce((sum, target) => sum + target.points, 0) / Math.max(1, initialGrowth.length)
    const constraints = [Math.max(0, 1 - (base.metrics.tierOneShedTicks - world.observeBase().metrics.tierOneShedTicks) / 500),
      Math.max(0, 1 - (base.metrics.waterUnavailableTicks - world.observeBase().metrics.waterUnavailableTicks) / 500),
      final.crops.filter(crop => crop.status !== 'lost').length / Math.max(1, initial.crops.filter(crop => crop.status !== 'lost').length)]
    const result = { researchAttainment, operationalCompletion, scientificTargets, modelId: frozenModel?.id ?? null, modelHash: frozenModel?.hash ?? null,
      modelStatus: forecast?.status ?? 'missing', modelError: forecast?.error ?? (frozenModel ? null : 'No immutable model published before proposal'),
      scientificScoring: { status: 'candidate_not_calibrated', metric: 'growth-index increment over500 ticks', tolerance: REPLAY_GROWTH_TOLERANCE, denominator: initialGrowth.length },
      constraintAttainment: done.length ? Math.min(1, constraints.reduce((a, b) => a + b, 0) / constraints.length) : 0,
      trajectoryHash: createHash('sha256').update(JSON.stringify(trajectory)).digest('hex'), startTick: world.horizon, endTick: clone.observe().tick,
      planId, planRevision, operations: executed.map(op => ({ id: op.id, state: op.state, input: op.input })), initialDevices }
    writeFileSync(join(root, 'replay-report.json'), JSON.stringify(result, null, 2), { mode: 0o600 })
    return result
  } finally { await replay.close(); providers.close(); clone.close() }
}
