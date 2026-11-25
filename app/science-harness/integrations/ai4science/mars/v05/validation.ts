/** Private adapter from immutable commitments to actual frozen-model validation values.
 * This module accepts host-owned cases only; it is never exposed as an Agent tool. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { validateEvaluationManifest, type EvaluationInput, type EvaluationManifest } from './evaluator.ts'
import { modelArtifactSchema, predictionCommitSchema, type ModelArtifact, type PredictionCommit } from './predictions.ts'
import { runFrozenModel, type FrozenModelOptions } from './model-execution.ts'

export interface ValidationCase {
  objectiveId: string
  predictionId: string
  input: Json
  /** Dot-separated keys or explicit key/index sequence. Prototype traversal is always rejected. */
  outputPath?: string | readonly (string | number)[]
  evaluatedAt: number
}
export interface ValidationReport {
  objectiveId: string
  predictionId: string
  status: 'done' | 'error'
  modelHash: string | null
  inputHash: string | null
  error: string | null
}
export interface ValidationResult {
  validationResults: NonNullable<EvaluationInput['validationResults']>
  reports: ValidationReport[]
}
function outputAt(value: Json, path: ValidationCase['outputPath']): Json {
  if (path === undefined) return value
  const keys = typeof path === 'string' ? path.split('.') : [...path]
  if (!keys.length) throw new Error('Output path must not be empty')
  let current = value
  for (const key of keys) {
    if ((typeof key !== 'string' && typeof key !== 'number') || String(key) === '' || ['__proto__', 'constructor', 'prototype'].includes(String(key))) throw new Error('Unsafe output path')
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new Error('Output path does not exist')
    current = (current as Record<string, Json>)[String(key)]!
  }
  return current
}

/** Failed cases produce diagnostics, never synthetic validation values or submitted answer fallbacks. */
export async function validateFrozenPredictions(manifest: EvaluationManifest, models: ModelArtifact[], commits: PredictionCommit[],
  cases: ValidationCase[], options: FrozenModelOptions = {}): Promise<ValidationResult> {
  validateEvaluationManifest(manifest)
  const validationResults: ValidationResult['validationResults'] = [], reports: ValidationReport[] = []
  const seen = new Set<string>()
  for (const item of cases) {
    const report: ValidationReport = { objectiveId: item.objectiveId, predictionId: item.predictionId, status: 'error', modelHash: null, inputHash: null, error: null }
    reports.push(report)
    try {
      const key = canonicalJson([item.objectiveId, item.predictionId])
      if (seen.has(key)) throw new Error('Duplicate validation case for objective and prediction')
      seen.add(key)
      const objective = manifest.objectives.find(value => value.id === item.objectiveId)
      if (!objective || objective.branch !== 'test') throw new Error('Validation requires a fixed test objective')
      const matches = commits.filter(value => value.id === item.predictionId)
      if (matches.length !== 1) throw new Error('Missing or ambiguous immutable prediction')
      const commit = predictionCommitSchema.parse(matches[0])
      const { commitmentHash, ...body } = commit
      if (createHash('sha256').update(canonicalJson(body)).digest('hex') !== commitmentHash) throw new Error('Prediction commitment hash mismatch')
      if (commit.target !== (objective.predictionTarget ?? objective.id)) throw new Error('Prediction target mismatch')
      if (objective.validationAvailableAt !== commit.validationAvailableAt) throw new Error('Validation availability differs from the committed host policy')
      if (!Number.isSafeInteger(item.evaluatedAt) || item.evaluatedAt < commit.validationAvailableAt || commit.lockedTick >= commit.validationAvailableAt)
        throw new Error('Invalid validation or prediction time')
      const modelMatches = models.filter(value => value.id === commit.modelId)
      if (modelMatches.length !== 1) throw new Error('Missing or ambiguous immutable model')
      const model = modelArtifactSchema.parse(modelMatches[0])
      report.modelHash = model.hash
      if (model.hash !== commit.modelHash || model.createdTick > commit.lockedTick) throw new Error('Prediction model hash or creation time mismatch')
      const result = await runFrozenModel(model, [z.json().parse(item.input)], options)
      report.inputHash = result.inputHash
      if (result.status !== 'done') throw new Error(result.error ?? 'Frozen model failed')
      const value = outputAt(result.outputs[0]!, item.outputPath)
      validationResults.push({ objectiveId: item.objectiveId, predictionId: item.predictionId, value, evaluatedAt: item.evaluatedAt })
      report.status = 'done'
    } catch (error) { report.error = error instanceof Error ? error.message : 'Validation failed' }
  }
  return { validationResults, reports }
}
