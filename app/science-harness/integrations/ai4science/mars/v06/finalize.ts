/** Assemble scientific results from sealed submissions and actual shared-world records. */
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { AnalysisRegistry } from '../analysis.ts'
import { V05Planning } from '../v05/planning.ts'
import { V06Actions, planHash, type ActionCommit } from './actions.ts'
import { validateCases, type CaseManifest, type CaseGroup } from './cases.ts'
import { type Submission, contentHash } from './contracts.ts'
import { evaluateV06, type ScientificResults, type ForecastOutcome } from './evaluator.ts'
import { V06Records } from './records.ts'
import { V06Stages } from './stages.ts'
import { artifactOutputs, validateGroup } from './validation.ts'
import { createEvidenceView } from './evidence-view.ts'
import { evaluateJointTrial } from './joint-trial.ts'
import { evaluateChoice } from './pilot-choice.ts'
import { isChoiceTrial, sharedPlanVersion } from './pilot-choice-contract.ts'
import { selectSteps } from './shared-plan.ts'
import type { V06World } from './world.ts'

/** Resolve exactly the version selected by the stage, including an execution-failing newest model. */
export function sealedSubmission(records: V06Records, stages: V06Stages, taskId: Submission['taskId'], slotId: Submission['slotId'] = 'final') {
  const selected = stages.selected(taskId, slotId)
  if (!selected) return null
  const submission = records.submissions().find(s => s.taskId === taskId && s.slotId === slotId && s.acceptedSeq === selected.acceptedSeq && s.revision === selected.revision)
  if (!submission || contentHash(submission.payload) !== selected.payloadHash || contentHash(submission.references) !== contentHash(selected.references))
    throw new Error(`Sealed ${taskId}/${slotId} declaration or frozen references differ from the research ledger`)
  return submission
}
export type EvaluationWorld = Pick<V06World, 'observe' | 'observeSystems' | 'observeBase' | 'quality' | 'scienceProfile' | 'stages' | 'truth' | 'horizon'>
export async function finalizeV06(input: { world: EvaluationWorld; engine: Pick<ExecutionEngine, 'readFacts' | 'recordFact' | 'list' | 'eventCursor'>; context: OperationContext; analysis: AnalysisRegistry;
  records: V06Records; stages: V06Stages; manifest: CaseManifest; stopReason: 'normal' | 'budget_exhausted' | 'model_error' }) {
  const { world, engine, context, records, stages, manifest, analysis } = input, profile = world.scienceProfile
  if (world.observe().tick !== stages.profile.horizon || stages.seals().at(-1)?.stage !== 'horizon') throw new Error('Complete scientific horizon and phase seals are required')
  validateCases(manifest.cases)
  const lab = world.observe(), systems = world.observeSystems(), base = world.observeBase(), quality = world.quality(), plans = new V05Planning(engine, context, () => lab.tick, {}, undefined, 'v06').list()
  const horizonSeal = stages.seals().at(-1)!
  if (horizonSeal.worldHash !== contentHash({ laboratory: lab, systems, base, quality })) throw new Error('Terminal world differs from its published phase seal')
  const actions = new V06Actions(engine, context, () => lab.tick, stages.profile.finalTick, manifest.commissions.map(c => c.id)).list()
  const { waterResults, unknownWater, calibrations, telemetryAnalysis, missingForGroup } = createEvidenceView(world, analysis, manifest.coreCrops)
  const t1 = sealedSubmission(records, stages, 'T1'), t2 = sealedSubmission(records, stages, 'T2'), t3 = sealedSubmission(records, stages, 'T3'), t4 = sealedSubmission(records, stages, 'T4'), t5 = sealedSubmission(records, stages, 'T5'), t6 = sealedSubmission(records, stages, 'T6')
  const groupTask = { current_accuracy: 'T1', storage_accuracy: 'T1', holdout_accuracy: 'T2', energy_forecast: 'T3', dependent_pipeline: 'T5', independent_pipeline: 'T5' } as const
  const empty = (group: CaseGroup) => ({ quality: 0, passed: false, valid: false, errors: [] as (number | null)[], reason: 'not_evaluated', caseCount: manifest.cases.filter(c => c.group === group).length })
  const groups: ScientificResults['groups'] = { current_accuracy: empty('current_accuracy'), storage_accuracy: empty('storage_accuracy'),
    holdout_accuracy: empty('holdout_accuracy'), energy_forecast: empty('energy_forecast'), dependent_pipeline: empty('dependent_pipeline'), independent_pipeline: empty('independent_pipeline') }
  const byTask = { T1: t1, T2: t2, T3: t3, T5: t5 }
  for (const [group, task] of Object.entries(groupTask) as [CaseGroup, keyof typeof byTask][]) {
    const submission = byTask[task], body = submission ? z.record(z.string(), z.json()).parse(submission.payload) : null
    const prediction = records.predictions().find(p => p.id === body?.predictionId)
    const artifact = submission?.references.find(r => r.kind === 'model' || r.kind === 'pipeline')
    const available = Boolean(submission && prediction && artifact && prediction.caseSetHash === manifest.caseHashes[task] && prediction.acceptedTick < stages.profile.finalTick && prediction.validationAvailableAt >= stages.profile.horizon)
    const evidence = missingForGroup(group, submission).length === 0
    groups[group] = await validateGroup(manifest.cases.filter(c => c.group === group), async inputs => {
      if (!artifact) throw new Error('Final artifact missing')
      return artifactOutputs(records, artifact.kind === 'pipeline' ? 'pipeline' : 'model', artifact.id, inputs,
        { timeoutMs: profile.modelTimeoutMs, memoryMb: profile.modelMemoryMb, maxOutputBytes: profile.modelOutputBytes })
    }, available && evidence)
  }
  const allGroups = groups
  const planFor = (submission: Submission | null) => {
    const reference = submission?.references.find(r => r.kind === 'plan')
    return reference ? plans.find(p => p.id === reference.id && planHash(p) === reference.hash) ?? null : null
  }
  const shared = world.stages.jointTrial === sharedPlanVersion
  const t2Full = planFor(t2), jointFull = planFor(t6)
  const t2Plan = shared && t2 && t2Full ? selectSteps(t2Full,t2.payload,world.stages) : t2Full
  const joint = shared && t6 && jointFull ? selectSteps(jointFull,t6.payload,world.stages) : jointFull
  const matched = Boolean(t2Full && jointFull && t2Full.id === jointFull.id)
  const t2Ids = new Set(Object.values(t2Plan?.operations ?? {})), t6Ids = new Set(Object.values(joint?.operations ?? {}))
  const sharedPlan = shared ? { matched, planId:matched ? jointFull!.id : null,
    sharedOperations:[...t2Ids].filter(id=>t6Ids.has(id)).length, distinctClaimedOperations:new Set([...t2Ids,...t6Ids]).size,
    wholePlanSucceeded:matched && jointFull?.state === 'succeeded' } : null
  const finalSnapshot = z.object({ crops: z.array(z.object({ id: z.string(), biomass: z.number() })) }).parse(quality.snapshots[String(stages.profile.finalTick)])
  const intervention = manifest.coreCrops.map(cropId => {
    const crop = systems.crops.find(c => c.id === cropId), start = finalSnapshot.crops.find(c => c.id === cropId), chamberId = `incubator-${cropId.split('-')[1]}`
    const commands = systems.operations.filter(o => t2Ids.has(o.id) && o.state === 'succeeded' && (o.completedTick ?? 0) >= stages.profile.finalTick
      && (!shared || (o.acceptedTick >= stages.profile.finalTick && o.completedTick! > stages.profile.finalTick && o.completedTick! <= stages.profile.horizon)))
    const treatments = commands.filter(o => ['light','irrigate','co2','nutrient'].includes(o.command.action) && 'chamberId' in o.command && o.command.chamberId === chamberId
      && (!shared || !('cropId' in o.command) || !o.command.cropId || o.command.cropId === cropId))
    const lastTreatment = Math.max(-1,...treatments.map(o=>o.completedTick!))
    return { cropId, rate: crop && start ? (crop.biomass - start.biomass) / (stages.profile.horizon - stages.profile.finalTick) : 0,
      alive: Boolean(crop && crop.status !== 'lost' && !crop.removed), executed:treatments.length>0,
      validated: commands.some(o => o.command.action === 'scan' && o.command.chamberId === chamberId && (!shared || (treatments.length>0 && o.acceptedTick>=lastTreatment))) }
  })
  const sourceOf = (sampleId: string) => { const sample = base.samples[sampleId]; return sample?.kind === 'water' ? sample.source : null }
  const remaining = (root: string) => lab.samples.filter(s => s.id === root && s.state === 'raw' && s.disposition === 'available' && s.expiresAt >= lab.tick && (() => { const sample = base.samples[s.id]; return sample?.kind === 'water' && sample.decay >= profile.minimumSampleRetention })()).reduce((n, s) => n + s.volumeUl, 0)
  const services = manifest.commissions.map(c => {
    const results = lab.results.filter(r => r.completedTick <= c.deadline && c.methods.includes(r.methodId) && sourceOf(r.sampleId) === c.sourceId && !lab.revocations.some(v => v.resultId === r.id))
    const roots = [...new Set(results.map(r => r.rootSampleId))], root = roots.find(id => remaining(id) >= c.minimumRemainingUl)
    return { id: c.id, measurement: results.length > 0, preserved: root !== undefined, completedTick: results[0]?.completedTick ?? null, remainingUl: root ? remaining(root) : 0 }
  })
  const selectedActions = (submission: Submission | null, kind: 'commitment' | 'response') => submission?.references.filter(r => r.kind === kind)
    .flatMap(ref => actions.filter(a => a.id === ref.id && a.hash === ref.hash)) ?? []
  const commitments: ForecastOutcome[] = manifest.commissions.map(c => {
    const action = selectedActions(t3, 'commitment').filter(a => a.commissionId === c.id).sort((a, b) => a.acceptedSeq - b.acceptedSeq).at(-1)
    const plan = action ? plans.find(p => p.id === action.planId && planHash(p) === action.planHash) : undefined
    const ids = new Set(Object.values(plan?.operations ?? {})), results = lab.results.filter(r => ids.has(r.operationId) && sourceOf(r.sampleId) === c.sourceId && c.methods.includes(r.methodId))
    const result = results[0]
    return { id: c.id, valid: Boolean(action && plan && result && result.completedTick >= action.acceptedTick),
      timeError: action && result ? Math.abs(action.forecast.completedTick - result.completedTick) : 0, timeTolerance: 24,
      quantityError: action && result ? Math.abs((action.forecast.remainingUl ?? 0) - remaining(result.rootSampleId)) : 0, quantityTolerance: 10 }
  })
  const responseAction = selectedActions(t4, 'response').sort((a, b) => a.acceptedSeq - b.acceptedSeq).at(-1)
  const responsePlan = responseAction ? plans.find(p => p.id === responseAction.planId && planHash(p) === responseAction.planHash) : undefined
  const actionSnapshot = (action: ActionCommit, phase: 'before' | 'after') => {
    const value = quality.snapshots[`action:${action.id}:${phase}`]
    return value === undefined ? null : z.object({ tick: z.number(), water: z.object({ reservoir: z.number(), filter: z.number(), pump: z.number() }), residual: z.number(), inlineOffsets: z.array(z.number()), methodVersion: z.number() }).parse(value)
  }
  const before = responseAction ? actionSnapshot(responseAction, 'before') : null, after = responseAction ? actionSnapshot(responseAction, 'after') : null
  const actualDiagnosis: string[] = [...new Set(world.truth.contamination.filter(e => e.onset < stages.profile.finalTick).flatMap(e => [...e.hypotheses, ...(e.decoyOffset ? ['inline-sensor'] : [])]))]
  const hasCarryoverIncident = lab.operations.some(o => o.state === 'succeeded' && (quality.contacts[o.id]?.used ?? 0) > profile.waterPassMgL)
  if (hasCarryoverIncident) actualDiagnosis.push('carryover')
  const hasMethodIncident = world.truth.methodUpdate.tick < stages.profile.finalTick && lab.results.some(r => r.methodId === 'confirm' && r.methodVersion === 1 && r.completedTick < world.truth.methodUpdate.tick && sourceOf(r.sampleId) !== null)
  if (hasMethodIncident) actualDiagnosis.push('measurement')
  const responseIds = new Set(Object.values(responsePlan?.operations ?? {}))
  const responseOperations = [...systems.operations, ...lab.operations].filter(o => responseIds.has(o.id) && o.state === 'succeeded')
  const interventionEnd = Math.max(responseAction?.acceptedTick ?? 0, ...responseOperations.filter(o => {
    const c = o.command
    return c.action === 'sensor_calibrate' || c.action === 'repair' || c.action === 'clean' && ['confirm', 'reservoir'].includes(c.deviceId) || c.action === 'calibrate' && c.deviceId === 'confirm'
  }).map(o => o.completedTick ?? 0))
  const causalResponse = actualDiagnosis.every(cause => responseOperations.some(o => {
    const c = o.command
    if (cause === 'seal') return c.action === 'repair' && c.deviceId === 'pump'
    if (cause === 'membrane') return c.action === 'repair' && c.deviceId === 'filter'
    if (cause === 'inlet') return c.action === 'clean' && c.deviceId === 'reservoir'
    if (cause === 'carryover') return c.action === 'clean' && c.deviceId === 'confirm'
    if (cause === 'inline-sensor') return c.action === 'sensor_calibrate' && before !== null &&
      ['reservoir', 'filter', 'pump'].some((source, index) => source === c.targetId && before.inlineOffsets[index] !== 0)
    // Correcting a changed analytical method is supported by fresh QC and a separate realized validation.
    if (cause === 'measurement') return (c.action === 'process' && ['screen', 'confirm'].includes(c.methodId) ||
      c.action === 'device_reference' && c.targetId === responseAction?.sourceId) &&
      waterResults(t4).some(r => r.methodId === 'confirm' && r.methodVersion === 2 && r.completedTick >= world.truth.methodUpdate.tick && sourceOf(r.sampleId)?.startsWith('control:'))
    return false
  }))
  const postValidation = causalResponse && responseOperations.some(o => (o.completedTick ?? 0) >= interventionEnd &&
    (o.command.action === 'device_reference' && o.command.targetId === responseAction?.sourceId ||
      o.command.action === 'process' && ['screen', 'confirm'].includes(o.command.methodId) && lab.results.some(r => r.operationId === o.id &&
        (sourceOf(r.sampleId) === responseAction?.sourceId || hasCarryoverIncident && sourceOf(r.sampleId)?.startsWith('control:')))))
  const restored = Boolean(before && after && (hasCarryoverIncident ? before.residual > profile.waterPassMgL && after.residual <= profile.waterPassMgL
    : world.truth.contamination.length ? before.water.pump > 2.5 && after.water.pump <= 2.5 : after.water.pump <= 2.5) &&
    after.inlineOffsets.every(offset => offset === 0) && (world.truth.methodUpdate.tick >= stages.profile.finalTick || after.methodVersion === 2))
  const response = responseAction ? { id: responseAction.id, valid: Boolean(before && after && responsePlan?.state === 'succeeded'),
    forecastError: after ? Math.abs((responseAction.forecast.postResponseMgL ?? 0) - after.water[responseAction.sourceId]) : 0,
    tolerance: profile.waterPassMgL, restored, independentlyValidated: postValidation } : null
  const actualScope = actualDiagnosis.length || world.truth.methodUpdate.tick < stages.profile.finalTick ? ['impact-water', 'impact-irrigation'] : []
  const scopeBody = t5 ? z.object({ scopeIds: z.array(z.string()) }).passthrough().parse(t5.payload) : null
  const diagnosisBody = t4 ? z.object({ diagnosis: z.array(z.string()) }).passthrough().parse(t4.payload) : null
  const alive = systems.crops.filter(c => c.status !== 'lost' && !c.removed).length
  const pilot = isChoiceTrial(world.stages.jointTrial) ? sealedSubmission(records, stages, 'T6', 'baseline') : null
  const trialEvidence = { currentWater: unknownWater(t6).length > 0, measuredEnergy: telemetryAnalysis(t6, isChoiceTrial(world.stages.jointTrial)) }
  const trial = isChoiceTrial(world.stages.jointTrial) ? evaluateChoice(world, pilot, planFor(pilot), t6, joint, trialEvidence)
    : world.stages.jointTrial ? evaluateJointTrial(world, t6, joint, trialEvidence) : null
  const scientific: ScientificResults = { groups: allGroups, intervention, services, commitments, response,
    diagnosis: diagnosisBody?.diagnosis ?? null, actualDiagnosis, diagnosisEvidence: unknownWater(t4).length >= 2 && calibrations(t4),
    scope: scopeBody?.scopeIds ?? null, actualScope, scopeEvidence: unknownWater(t5).length > 0 && telemetryAnalysis(t5),
    jointPlanValid: trial ? trial.passed && (!shared || matched) : Boolean(joint && joint.state === 'succeeded'),
    O: { cropSurvival: alive / systems.crops.length, cropCount: systems.crops.length, aliveCrops: alive,
      criticalShedFraction: base.metrics.tierOneShedTicks / Math.max(1, lab.tick), waterUnavailableTicks: base.metrics.waterUnavailableTicks, ticks: lab.tick,
      samplesAvailable: lab.samples.filter(s => s.volumeUl > 0 && s.disposition === 'available').length, samplesQuarantined: lab.samples.filter(s => s.disposition === 'quarantined').length,
      succeededOperations: [...lab.operations, ...systems.operations].filter(o => o.state === 'succeeded').length,
      failedOperations: [...lab.operations, ...systems.operations].filter(o => o.state === 'failed').length } }
  return { ...evaluateV06(scientific, profile, manifest.coreCrops, manifest.commissions.map(c => c.id)),
    benchmarkVersion: 'v0.6' as const, implementation: 'scientific_candidate' as const, tick: lab.tick, completionStatus: 'finalized' as const,
    stopReason: input.stopReason, caseManifestHash: manifest.hash, phaseSeals: stages.seals().map(s => ({ stage: s.stage, tick: s.tick, hash: s.hash })),
    baselineMissing: stages.seals().find(s => s.stage === 'baseline')?.missing ?? [],
    protocolHash: stages.protocolHash, sourceStatus: 'source_manifest_bound', ...(trial ? { jointTrial: trial } : {}),
    ...(sharedPlan ? {sharedPlan} : {}),
    resultHash: contentHash({ scientific, caseManifestHash: manifest.hash, ...(trial ? { jointTrial: trial } : {}), ...(sharedPlan ? {sharedPlan} : {}) }) }
}
