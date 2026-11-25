import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { canonicalJson } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { modelInputSchema, type ModelArtifact, type PredictionCommit } from './predictions.ts'
import { evaluateV05, type EvaluationInput, type EvaluationManifest } from './evaluator.ts'
import { validateFrozenPredictions } from './validation.ts'

function fixtures() {
  const request = modelInputSchema.parse({ id: 'model-v1', code: 'return { prediction: input.x * parameters.scale }', parameters: { scale: 3 },
    inputSchema: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } }, outputSchema: {}, runtimeVersion: 'mars-model-v1' })
  const model: ModelArtifact = { ...request, hash: createHash('sha256').update(canonicalJson(request)).digest('hex'), schemaVersion: 1, createdBy: 'scientist', createdTick: 10 }
  const body = { id: 'prediction-v1', target: 'PW-01:holdout', modelId: model.id, inputDomain: {}, schemaVersion: 1 as const,
    modelHash: model.hash, lockedTick: 12, validationAvailableAt: 50, policyHash: 'host-policy', createdBy: 'scientist' }
  const commit: PredictionCommit = { ...body, commitmentHash: createHash('sha256').update(canonicalJson(body)).digest('hex') }
  const manifest: EvaluationManifest = { version: 'v0.5', mode: 'slice', horizon: 200, objectives: [{ id: 'water-test', duplicateKey: 'water-test', component: 'R',
    taskId: 'PW-01', branch: 'test', points: 1, metric: { kind: 'numeric', target: 6, tolerance: 1 }, deadline: 100, validationAvailableAt: 50,
    predictionTarget: 'PW-01:holdout', evidence: [{ kind: 'measurement', count: 1, purpose: 'validation' }] }] }
  const data: EvaluationInput = { observations: [{ id: 'obs', objectiveId: 'water-test', submittedAt: 12, value: 999,
    evidence: [{ id: 'measured', purpose: 'validation' }], predictionId: commit.id }],
    facts: [{ id: 'measured', kind: 'measurement', availableAt: 10, completedAt: 10, state: 'succeeded', metadata: {} }],
    predictions: [{ id: commit.id, target: commit.target, lockedAt: commit.lockedTick, modelHash: model.hash, dependencyAvailableAt: [10] }] }
  return { model, commit, manifest, data, cases: [{ objectiveId: 'water-test', predictionId: commit.id, input: { x: 2 }, outputPath: 'prediction', evaluatedAt: 50 }] }
}

it('scores actual frozen code output instead of the submitted answer through the evaluator', async () => {
  const { model, commit, manifest, data, cases } = fixtures()
  expect(evaluateV05(manifest, data).score).toBe(0)
  const validation = await validateFrozenPredictions(manifest, [model], [commit], cases)
  expect(validation.reports[0]).toMatchObject({ status: 'done', modelHash: model.hash, error: null })
  expect(validation.validationResults).toEqual([{ objectiveId: 'water-test', predictionId: commit.id, value: 6, evaluatedAt: 50 }])
  expect(evaluateV05(manifest, { ...data, validationResults: validation.validationResults }).score).toBe(1)
})

it('refuses tampered model and commitment hashes, early validation and unsafe output traversal without fabricating values', async () => {
  const { model, commit, manifest, cases } = fixtures()
  const tampered = await validateFrozenPredictions(manifest, [{ ...model, code: 'return { prediction: 6 }' }], [commit], cases)
  expect(tampered.validationResults).toEqual([])
  expect(tampered.reports[0]?.error).toContain('hash mismatch')
  const changed = await validateFrozenPredictions(manifest, [model], [{ ...commit, lockedTick: 1 }], cases)
  expect(changed.validationResults).toEqual([])
  expect(changed.reports[0]?.error).toContain('commitment hash mismatch')
  const early = await validateFrozenPredictions(manifest, [model], [commit], [{ ...cases[0]!, evaluatedAt: 49 }])
  expect(early.validationResults).toEqual([])
  expect(early.reports[0]?.error).toContain('time')
  const traversal = await validateFrozenPredictions(manifest, [model], [commit], [{ ...cases[0]!, outputPath: '__proto__.prediction' }])
  expect(traversal.validationResults).toEqual([])
  expect(traversal.reports[0]?.error).toContain('Unsafe output path')
})
