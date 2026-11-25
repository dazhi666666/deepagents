import { expect, it } from 'vitest'
import { evaluateV06, type ScientificResults } from './evaluator.ts'
import { scienceProfileSchema } from './profile.ts'
import { validateCases, type EvaluationCase } from './cases.ts'
const profile = scienceProfileSchema.parse({}), crops = ['c1', 'c2', 'c3', 'c4'], commissions = ['s1', 's2', 's3']
function complete(): ScientificResults {
  const group = () => ({ quality: 1, passed: true, valid: true, errors: [0, 0], reason: null, caseCount: 2 })
  return { groups: { current_accuracy: group(), storage_accuracy: group(), holdout_accuracy: group(), energy_forecast: group(), dependent_pipeline: group(), independent_pipeline: group() },
    intervention: crops.map(cropId => ({ cropId, rate: profile.interventionTarget, alive: true, executed: true, validated: true })),
    services: commissions.map(id => ({ id, measurement: true, preserved: true, completedTick: 10, remainingUl: 20 })),
    commitments: commissions.map(id => ({ id, valid: true, timeError: 0, timeTolerance: 2, quantityError: 0, quantityTolerance: 5 })),
    response: { id: 'response', valid: true, forecastError: 0, tolerance: 0.2, restored: true, independentlyValidated: true },
    diagnosis: ['none'], actualDiagnosis: [], diagnosisEvidence: true,
    scope: ['impact-water', 'impact-irrigation'], actualScope: ['impact-water', 'impact-irrigation'], scopeEvidence: true, jointPlanValid: true,
    O: { cropSurvival: 1, cropCount: 16, aliveCrops: 16, criticalShedFraction: 0, waterUnavailableTicks: 0, ticks: 100,
      samplesAvailable: 4, samplesQuarantined: 0, succeededOperations: 10, failedOperations: 0 } }
}
it('reports a single scientific R and a separate joint pass without adding T6 points', () => {
  const input = complete(), success = evaluateV06(input, profile, crops, commissions)
  expect(success.R).toBeCloseTo(100); expect(success.F).toBe(true)
  input.jointPlanValid = false
  const missingPlan = evaluateV06(input, profile, crops, commissions)
  expect(missingPlan.R).toBe(success.R); expect(missingPlan.F).toBe(false)
  expect(missingPlan.failureReasons).toContain('joint:sealed-plan')
})
it('keeps omitted entities and services in the original denominators', () => {
  const input = complete(); input.services.pop(); input.commitments.pop(); input.intervention.pop()
  const result = evaluateV06(input, profile, crops, commissions)
  expect(result.components.service_attainment).toBeCloseTo(2 / 3)
  expect(result.components.commitment_forecast).toBeCloseTo(2 / 3)
  expect(result.components.intervention_attainment).toBe(0.75)
  expect(result.F).toBe(false)
})
it('does not replace an invalid required group with the other task subscore', () => {
  const input = complete(); input.groups.current_accuracy = { quality: 0, valid: false, passed: false, errors: [null, null], caseCount: 2, reason: 'invalid' }
  const result = evaluateV06(input, profile, crops, commissions)
  expect(result.q.T1).toBe(0.6)
  expect(result.F).toBe(false)
  expect(result.failureReasons).toContain('current_accuracy:required-quality')
})
it('penalizes false positive causes and uses actual recovery, rather than maintenance-call counts', () => {
  const input = complete(); input.diagnosis = ['inlet', 'seal', 'carryover']; input.response!.restored = false
  const result = evaluateV06(input, profile, crops, commissions)
  expect(result.components.diagnosis).toBe(0); expect(result.components.response_effect).toBe(0)
  expect(result.F).toBe(false)
  input.O.succeededOperations = 100000
  expect(evaluateV06(input, profile, crops, commissions).R).toBe(result.R)
})
it('requires a valid prospective commitment for every delivered commission', () => {
  const input = complete(); input.commitments = []
  const result = evaluateV06(input, profile, crops, commissions)
  expect(result.R).toBeGreaterThan(90); expect(result.F).toBe(false)
  expect(result.failureReasons).toContain('s1:prospective-commitment')
})
it('rejects the same scientific outcome counted under two task names', () => {
  const one: EvaluationCase = { id: 'one', scoreKey: 'same-outcome', taskId: 'T1', group: 'current_accuracy', input: {}, outputPath: ['value'], metric: { kind: 'numeric', target: 1, pass: 0.1, zero: 0.3 } }
  expect(() => validateCases([one, { ...one, taskId: 'T5', group: 'dependent_pipeline' }])).toThrow('Duplicate')
})
