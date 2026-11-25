/** Offline terminal adapter: derives outcomes from real world/journals and executes frozen code. */
import { writeFileSync } from 'node:fs'
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { canonicalJson } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { execute, type AnalysisRegistry, type AnalysisBindings } from '../analysis.ts'
import { growthRate, CHAMBERS, CROP_IDS } from '../truth.ts'
import { worldView } from '../scoring-input.ts'
import type { MarsWorld } from '../world.ts'
import { collectEvaluationInput } from './evaluation-input.ts'
import { evaluateV05 } from './evaluator.ts'
import { modelArtifactSchema, predictionCommitSchema } from './predictions.ts'
import { researchRecordSchema } from './research-records.ts'
import { createV05Scenario, type V05Scenario } from './scenario.ts'
import { validateFrozenPredictions } from './validation.ts'

const clamp = (v: number) => Math.max(0, Math.min(1, v)), mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0
export async function finalizeV05(options: { engine: ExecutionEngine; context: OperationContext; analysis: AnalysisRegistry; world: MarsWorld;
  scenario?: V05Scenario; outputFile?: string; analysisBindings?: (asOfTick: number) => AnalysisBindings;
  replay500?: () => Promise<{ researchAttainment: number; constraintAttainment: number; trajectoryHash: string }> }) {
  const { engine, context, analysis, world } = options
  if (world.observe().tick < world.horizon) throw new Error('v0.5 evaluation is terminal-only')
  const scenario = options.scenario ?? createV05Scenario(world.truth, world)
  const manifest = scenario.private.manifest, input = collectEvaluationInput({ engine, context, analysis, world }), facts = engine.readFacts(context)
  const objectiveIds = new Set(manifest.objectives.map(o => o.id))
  const rejectedObservations = input.observations.filter(o => !objectiveIds.has(o.objectiveId)).map(o => ({ id: o.id, objectiveId: o.objectiveId, reason: 'unknown_objective' }))
  input.observations = input.observations.filter(o => objectiveIds.has(o.objectiveId))
  const models = facts.filter(f => f.kind === 'mars-v05-model').map(f => modelArtifactSchema.parse((f.data as { result: unknown }).result))
  const commits = facts.filter(f => f.kind === 'mars-v05-prediction').map(f => predictionCommitSchema.parse((f.data as { result: unknown }).result))
  const records = facts.filter(f => f.kind === 'mars-v05-research').map(f => researchRecordSchema.parse((f.data as { record: unknown }).record))
  const latest = new Map(records.map(r => [r.id, r]))
  const view = worldView(world), H = world.horizon, methodTick = world.truth.methodUpdate.tick
  const doneLab = view.lab.operations.filter(o => o.state === 'succeeded'), doneSystem = view.systemOps.filter(o => o.state === 'succeeded')
  const after = doneLab.filter(o => (o.completedTick ?? 0) >= methodTick)
  const waterRevised = latest.get('handover-water-calibration'), energy = latest.get('handover-independent-energy')
  const plantRevised = latest.get('handover-plant-water-dependency')
  const hasExecutedNewWater = view.lab.results.some(r => r.methodId === 'confirm' && r.methodVersion >= 2 && (r.completedTick ?? 0) >= methodTick)
  const hasRevisedModel = !!waterRevised && waterRevised.revision > 1 && models.some(m => m.createdTick >= methodTick && m.basedOn.some(r => r.id === waterRevised.id && r.revision === waterRevised.revision))
  const sampleRetained = view.lab.samples.some(s => s.volumeUl > 0 && s.disposition === 'available' && view.base.samples[s.id]?.kind === 'water')
  const retain = sampleRetained && doneLab.length > 0 ? 1 : 0
  const update = hasExecutedNewWater && hasRevisedModel && waterRevised && waterRevised.updatedTick >= methodTick && waterRevised.status !== 'withdrawn' ? 1 : 0
  const preserve = energy && energy.status !== 'withdrawn' && energy.status !== 'superseded' &&
    doneSystem.some(o => (o.completedTick ?? 0) >= methodTick && ['panel_clean', 'power_priority', 'device_reference'].includes(o.command.action)) ? 1 : 0
  const operationFraction = (predicate: (o: typeof doneSystem[number]) => boolean) => doneSystem.some(predicate) ? 1 : 0
  const protectedFraction = view.base.metrics.sampleTicks > 0 ? clamp(1 - view.lab.facilityMetrics.unsafeSampleTicks / view.base.metrics.sampleTicks) : 0
  const researchContinuation = mean([after.some(o => o.command.action === 'process' && o.command.methodId === 'confirm') ? 1 : 0,
    doneSystem.some(o => (o.completedTick ?? 0) >= methodTick && ['scan', 'irrigate'].includes(o.command.action)) ? 1 : 0])
  const allResearchModels = ['PW', 'PG', 'PF'].map(project => models.some(m => m.basedOn.some(ref => latest.get(ref.id)?.project === project)) ? 1 : 0)
  const outcomeValues: Record<string, number> = {
    'K-retain': retain, 'K-update': update, 'K-preserve': preserve,
    'O-crops': mean(view.crops.map(c => c.status === 'lost' ? 0 : clamp(1 - c.exposureTicks / Math.max(1, H)))),
    'O-energy': clamp(1 - view.base.metrics.tierOneShedTicks / H),
    'O-water': clamp(1 - view.base.metrics.waterUnavailableTicks / H),
    'O-atmosphere': mean(CHAMBERS.map(id => clamp((view.base.metrics.atmosphereOkTicks[id] ?? 0) / H))),
  }
  const validated = await validateFrozenPredictions(manifest, models, commits, scenario.private.probes.flatMap(probe => {
    const submitted = input.observations.filter(o => o.objectiveId === probe.objectiveId && o.submittedAt < H && o.predictionId).sort((a, b) => b.submittedAt - a.submittedAt)[0]
    return submitted?.predictionId ? [{ ...probe, predictionId: submitted.predictionId }] : []
  }))
  input.validationResults = validated.validationResults
  const reproduction: { id: string; reproduced: boolean }[] = []
  const citedAnalyses = new Set(input.observations.flatMap(o => o.evidence.map(e => e.id)))
  if (options.analysisBindings) for (const id of analysis.ids()) {
    const run = analysis.get(id)
    if (run?.status !== 'done' || !citedAnalyses.has(id) || !input.facts.some(f => f.id === id && f.kind === 'analysis' && f.metadata.hasDataAccess === true)) continue
    const rerun = await execute(run.code, options.analysisBindings(run.asOfTick))
    reproduction.push({ id, reproduced: rerun.status === 'done' && canonicalJson(rerun.output) === canonicalJson(run.output) })
  }
  outcomeValues['Q-reproduce'] = mean(reproduction.map(r => r.reproduced ? 1 : 0))
  outcomeValues['Q-audit'] = input.observations.length ? mean(input.observations.map(o => o.evidence.length > 0 && o.evidence.every(e => input.facts.some(f => f.id === e.id && f.availableAt <= o.submittedAt)) ? 1 : 0)) : 0
  const replay = options.replay500 ? await options.replay500() : null
  if (replay && (!replay.trajectoryHash || !Number.isFinite(replay.researchAttainment) || !Number.isFinite(replay.constraintAttainment))) throw new Error('Invalid replay evidence')
  for (const objective of manifest.objectives) {
    if (objective.component === 'J') {
      if (objective.id.includes('protected_information_fraction')) outcomeValues[objective.id] = protectedFraction
      else if (objective.id.includes('required_research_continuity')) outcomeValues[objective.id] = researchContinuation
      else if (objective.id.includes('water_service_fraction')) {
        const onset = world.truth.contamination[0]?.onset ?? H
        const snapshots = Object.entries(view.base.history.snapshots).filter(([t]) => Number(t) >= onset && Number(t) <= onset + 300)
        outcomeValues[objective.id] = snapshots.length ? mean(snapshots.map(([, s]) => (s.water.pump ?? Infinity) <= 2.5 ? 1 : 0)) : 0
      }
      else if (objective.id.includes('interpretable_experiment_fraction')) outcomeValues[objective.id] = plantRevised && plantRevised.revision > 1 && doneSystem.some(o => o.command.action === 'scan' && (o.completedTick ?? 0) >= plantRevised.updatedTick) ? 1 : 0
      else if (objective.id.includes('affected_workflow_restored')) outcomeValues[objective.id] = mean([hasExecutedNewWater ? 1 : 0, operationFraction(o => o.command.action === 'scan' && (o.completedTick ?? 0) >= methodTick)])
      else if (objective.id.includes('unaffected_commitments_preserved')) outcomeValues[objective.id] = operationFraction(o => o.command.action === 'panel_clean' && (o.completedTick ?? 0) >= methodTick)
      // PX-04 requires an actual 500-tick branch replay. Missing replay earns zero, never proxy credit.
      else if (objective.id.includes('future_research_attainment')) outcomeValues[objective.id] = replay ? clamp(replay.researchAttainment) : 0
      else if (objective.id.includes('future_constraint_attainment')) outcomeValues[objective.id] = replay ? clamp(replay.constraintAttainment) : 0
      else outcomeValues[objective.id] = 0
    }
    if (objective.component !== 'R') {
      input.observations = input.observations.filter(o => o.objectiveId !== objective.id)
      const factId = `host-outcome:${objective.id}`
      input.facts.push({ id: factId, kind: 'host-outcome', availableAt: H, completedAt: H, state: 'succeeded', metadata: { objectiveId: objective.id } })
      input.observations.push({ id: `host-observation:${objective.id}`, objectiveId: objective.id, submittedAt: H, value: outcomeValues[objective.id] ?? 0, evidence: [{ id: factId, purpose: 'validation' }] })
    }
  }
  // Utility is evaluated from actual recommended settings, not a self-reported perfect utility number.
  for (const observation of input.observations.filter(o => o.objectiveId.includes('PG-03:accuracy:recommendation_utility'))) {
    const recommendation = z.object({ nutrient: z.number().min(1).max(3), irrigation: z.number().min(30).max(120), co2: z.number().min(400).max(1500) }).safeParse(observation.value)
    if (!recommendation.success) { observation.value = 0; continue }
    const utility = (settings: { nutrient: number; irrigation: number; co2: number }) => mean(CROP_IDS.map(id => growthRate(world.truth, id, { ...settings, light: 70, temperature: 22 })))
    const best = Math.max(...[1, 2, 3].flatMap(nutrient => [45, 75, 105].flatMap(irrigation => [600, 800, 1100].map(co2 => utility({ nutrient, irrigation, co2 })))))
    observation.value = best > 0 ? clamp(utility(recommendation.data) / best) : 0
  }
  const score = evaluateV05(manifest, input)
  const result = { ...score, calibrationStatus: 'not_frozen', validation: validated.reports, reproduction, rejectedObservations, researchModelCoverage: allResearchModels,
    outcomeSemantics: { PX01: '实际样品不安全暴露与研究操作连续性，尚非信息论科学价值评估', PX02: '污染窗口供水质量与修订后实际扫描', PX03: '补测与跨项目操作恢复，尚非全部结论科学有效性认证', PX04: '真实分支回放的操作与运行目标' },
    replay, limitations: ['PX-04未提供真实500tick回放时固定计零。', '候选容差和目标适用域仍需开发场景辨识与联合可行性验收。', '联合任务的操作性指标在outcomeSemantics中逐项标明，不能单独证明科研信息价值或模型修复正确。'], scenarioHash: scenario.private.scenarioHash }
  if (options.outputFile) writeFileSync(options.outputFile, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return result
}
