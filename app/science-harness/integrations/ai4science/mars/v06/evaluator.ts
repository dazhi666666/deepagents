/** R measures final scientific and research-delivery quality; O and joint pass remain separate. */
import { numericQuality, type GroupResult } from './validation.ts'
import type { CaseGroup } from './cases.ts'
import type { ScienceProfile } from './profile.ts'

export interface ServiceOutcome { id: string; measurement: boolean; preserved: boolean; completedTick: number | null; remainingUl: number }
export interface ForecastOutcome { id: string; valid: boolean; timeError: number; timeTolerance: number; quantityError: number; quantityTolerance: number }
export interface ResponseOutcome { id: string; valid: boolean; forecastError: number; tolerance: number; restored: boolean; independentlyValidated: boolean }
export interface OperationalResult { cropSurvival: number; cropCount: number; aliveCrops: number; criticalShedFraction: number;
  waterUnavailableTicks: number; ticks: number; samplesAvailable: number; samplesQuarantined: number; succeededOperations: number; failedOperations: number }
export interface ScientificResults {
  groups: Record<CaseGroup, GroupResult>; intervention: { cropId: string; rate: number; alive: boolean; executed: boolean; validated: boolean }[];
  services: ServiceOutcome[]; commitments: ForecastOutcome[]; response: ResponseOutcome | null;
  diagnosis: string[] | null; actualDiagnosis: string[]; diagnosisEvidence: boolean;
  scope: string[] | null; actualScope: string[]; scopeEvidence: boolean; jointPlanValid: boolean; O: OperationalResult;
}
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
export function setQuality(prediction: string[] | null, target: string[]) {
  if (prediction === null) return 0
  const p = new Set(prediction.filter(x => x !== 'none')), t = new Set(target.filter(x => x !== 'none'))
  const union = new Set([...p, ...t]); return union.size ? [...p].filter(x => t.has(x)).length / union.size : 1
}
/** Denominators and thresholds belong to the frozen task definition, not submitted subsets. */
export function evaluateV06(input: ScientificResults, profile: ScienceProfile, fixedCropIds: string[], fixedCommissionIds: string[]) {
  const { groups: g } = input
  for (const group of Object.values(g)) if (!Number.isFinite(group.quality) || group.quality < 0 || group.quality > 1 || group.caseCount < 1) throw new Error('Invalid scientific group result')
  const interventions = fixedCropIds.map(id => {
    const result = input.intervention.find(r => r.cropId === id)
    if (!result || !Number.isFinite(result.rate) || !result.alive || !result.executed || !result.validated) return 0
    return Math.max(0, Math.min(1, result.rate / profile.interventionTarget))
  })
  const services = fixedCommissionIds.map(id => {
    const service = input.services.find(s => s.id === id)
    return service ? (Number(service.measurement) + Number(service.preserved)) / 2 : 0
  })
  const forecasts = fixedCommissionIds.map(id => {
    const f = input.commitments.find(c => c.id === id)
    return f?.valid ? 0.5 * numericQuality(f.timeError, f.timeTolerance, 3 * f.timeTolerance) + 0.5 * numericQuality(f.quantityError, f.quantityTolerance, 3 * f.quantityTolerance) : 0
  })
  const diagnosis = input.diagnosisEvidence ? setQuality(input.diagnosis, input.actualDiagnosis) : 0
  const scope = input.scopeEvidence ? setQuality(input.scope, input.actualScope) : 0
  const response = input.response
  const responseForecast = response?.valid ? numericQuality(response.forecastError, response.tolerance, 3 * response.tolerance) : 0
  const responseEffect = response?.valid && response.restored && response.independentlyValidated ? 1 : 0
  const q = {
    T1: 0.4 * g.current_accuracy.quality + 0.6 * g.storage_accuracy.quality,
    T2: 0.6 * g.holdout_accuracy.quality + 0.4 * mean(interventions),
    T3: 0.3 * g.energy_forecast.quality + 0.2 * mean(forecasts) + 0.5 * mean(services),
    T4: 0.4 * diagnosis + 0.3 * responseForecast + 0.3 * responseEffect,
    T5: 0.2 * scope + 0.5 * g.dependent_pipeline.quality + 0.3 * g.independent_pipeline.quality,
  }
  const conditions = [
    ...Object.entries(q).map(([task, value]) => ({ id: `${task}:science`, passed: value >= profile.minimumScienceQuality })),
    ...fixedCommissionIds.map((id, i) => ({ id: `${id}:delivery`, passed: services[i] === 1 })),
    ...fixedCommissionIds.map(id => ({ id: `${id}:prospective-commitment`, passed: input.commitments.some(c => c.id === id && c.valid) })),
    ...fixedCropIds.map((id, i) => ({ id: `${id}:intervention`, passed: interventions[i] === 1 })),
    ...Object.entries(g).map(([id, group]) => ({ id: `${id}:required-quality`, passed: group.valid && group.quality >= profile.minimumScienceQuality })),
    { id: 'joint:sealed-plan', passed: input.jointPlanValid },
    { id: 'diagnosis:necessary-causes', passed: diagnosis === 1 },
    { id: 'response:independent-validation', passed: responseEffect === 1 },
    { id: 'operation:crop-survival', passed: input.O.cropSurvival >= profile.minimumCropSurvival },
    { id: 'operation:critical-power', passed: input.O.criticalShedFraction <= profile.maximumCriticalShedFraction },
    { id: 'operation:water', passed: input.O.waterUnavailableTicks / Math.max(1, input.O.ticks) <= profile.maximumWaterUnavailableFraction },
  ]
  return { version: 'v0.6' as const, R: 100 * mean(Object.values(q)), q, O: input.O,
    F: conditions.every(c => c.passed), jointConditions: conditions, failureReasons: conditions.filter(c => !c.passed).map(c => c.id),
    components: { current_accuracy: g.current_accuracy.quality, storage_accuracy: g.storage_accuracy.quality,
      holdout_accuracy: g.holdout_accuracy.quality, intervention_attainment: mean(interventions), energy_forecast: g.energy_forecast.quality,
      commitment_forecast: mean(forecasts), service_attainment: mean(services), diagnosis, response_forecast: responseForecast,
      response_effect: responseEffect, scope_accuracy: scope, dependent_pipeline: g.dependent_pipeline.quality, independent_pipeline: g.independent_pipeline.quality },
    validation: input.groups, services: input.services, commitments: input.commitments, response: input.response,
    calibrationStatus: 'candidate_not_frozen' as const, formalRankingEligible: false }
}
