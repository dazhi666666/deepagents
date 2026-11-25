/** Execute frozen science models with fresh realms for every case and every DAG node. */
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { modelInputSchema as legacyInput } from '../v05/predictions.ts'
import { runFrozenModel, type FrozenModelOptions } from '../v05/model-execution.ts'
import { contentHash, modelInputSchema } from './contracts.ts'
import type { ModelArtifact, V06Records } from './records.ts'
import { bindValue, pipelineInputSchema, validatePipeline } from './pipeline.ts'
import { validateCases, type EvaluationCase } from './cases.ts'

/** A damaged frozen artifact is an evaluator/run fault, not a scientific zero. */
export class EvaluationIntegrityError extends Error {}
export interface GroupResult { quality: number; passed: boolean; valid: boolean; errors: (number | null)[]; reason: string | null; caseCount: number }
/** A tolerance plateau is a pass; a positive continuous score alone is not a pass. */
export function numericQuality(error: number, pass: number, zero: number) {
  if (![error, pass, zero].every(Number.isFinite) || error < 0 || pass < 0 || zero <= pass) throw new Error('Invalid numeric scoring inputs')
  return error <= pass ? 1 : error >= zero ? 0 : (zero - error) / (zero - pass)
}
async function modelOutputs(model: ModelArtifact, inputs: Json[], options: FrozenModelOptions): Promise<Json[]> {
  const { hash: _hash, createdBy: _creator, acceptedTick: _tick, acceptedSeq: _sequence, ...modelInput } = model
  if (contentHash(modelInputSchema.parse(modelInput)) !== model.hash) throw new EvaluationIntegrityError('Frozen scientific model hash changed')
  // The reusable runner validates its own historical artifact format as well.
  const legacy = legacyInput.parse({ id: model.id, code: model.code, parameters: model.parameters,
    inputSchema: model.inputSchema, outputSchema: model.outputSchema, runtimeVersion: model.runtimeVersion === 'mars-model-v06-sync-v1' ? 'mars-model-v1' : model.runtimeVersion, basedOn: model.basedOn })
  const result = await runFrozenModel({ ...legacy, schemaVersion: 1, hash: contentHash(legacy), createdBy: model.createdBy, createdTick: model.acceptedTick }, inputs,
    { timeoutMs: 10000, maxOutputBytes: 2 * 1024 * 1024, ...options, freshContext: true })
  if (result.status !== 'done') throw new Error(result.error ?? 'Scientific model execution failed')
  return result.outputs
}
export async function artifactOutputs(records: V06Records, kind: 'model' | 'pipeline', id: string, inputs: Json[], options: FrozenModelOptions = {}): Promise<Json[]> {
  let models: ReturnType<V06Records['models']>, pipelines: ReturnType<V06Records['pipelines']>
  try { models = records.models(); pipelines = records.pipelines() }
  catch (error) { throw new EvaluationIntegrityError('Frozen artifact journal is invalid') }
  if (kind === 'model') {
    const model = models.find(m => m.id === id)
    if (!model) throw new EvaluationIntegrityError('Frozen model unavailable')
    return modelOutputs(model, inputs, options)
  }
  const pipeline = pipelines.find(p => p.pipelineId === id)
  if (!pipeline) throw new EvaluationIntegrityError('Frozen pipeline unavailable')
  const { hash: _pipelineHash, modelHashes: _models, acceptedTick: _tick, acceptedSeq: _sequence, actorId: _actor, ...pipelineInput } = pipeline
  const specification = pipelineInputSchema.parse(pipelineInput)
  let validated: ReturnType<typeof validatePipeline>
  try { validated = validatePipeline(specification, models) } catch (error) { throw new EvaluationIntegrityError('Frozen pipeline metadata changed') }
  const { order, modelHashes } = validated
  if (contentHash({ ...specification, modelHashes }) !== pipeline.hash) throw new EvaluationIntegrityError('Frozen pipeline hash changed')
  const perCase: Record<string, Json>[] = inputs.map(() => ({}))
  for (const nodeId of order) {
    const node = pipeline.nodes.find(n => n.id === nodeId)!, model = models.find(m => m.id === node.modelId)!
    if (pipeline.modelHashes[model.id] !== model.hash) throw new EvaluationIntegrityError('Pipeline model hash changed')
    const nodeInputs = inputs.map((input, index) => Object.fromEntries(Object.entries(node.bindings).map(([field, ref]) => [field, bindValue(ref, input, perCase[index]!)])))
    const outputs = await modelOutputs(model, nodeInputs, options)
    for (const [index, output] of outputs.entries()) perCase[index]![nodeId] = output
  }
  return inputs.map((input, index) => Object.fromEntries(Object.entries(pipeline.outputs).map(([field, ref]) => [field, bindValue(ref, input, perCase[index]!)])))
}
function field(output: Json, path: string[]): Json | undefined {
  let value: Json | undefined = output
  for (const part of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
    value = Array.isArray(value) ? value[Number(part)] : value[part]
  }
  return value
}
/** One malformed/late/missing output invalidates its fixed group, without dropping difficult cases. */
export async function validateGroup(cases: EvaluationCase[], execute: (inputs: Json[]) => Promise<Json[]>, evidenceValid: boolean): Promise<GroupResult> {
  validateCases(cases)
  if (!cases.length) throw new Error('Scientific group must have a fixed nonempty denominator')
  const invalid = (reason: string): GroupResult => ({ quality: 0, passed: false, valid: false, errors: cases.map(() => null), reason, caseCount: cases.length })
  if (!evidenceValid) return invalid('required_evidence_missing_or_invalid')
  try {
    const outputs = await execute(cases.map(c => c.input))
    if (outputs.length !== cases.length) return invalid('output_count_mismatch')
    const scores: number[] = [], errors: (number | null)[] = [], pass: boolean[] = []
    for (const [i, c] of cases.entries()) {
      const value = field(outputs[i]!, c.outputPath)
      if (c.metric.kind === 'numeric') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return invalid('nonfinite_missing_or_wrong_numeric_output')
        const error = Math.abs(value - c.metric.target)
        scores.push(numericQuality(error, c.metric.pass, c.metric.zero)); errors.push(error); pass.push(error <= c.metric.pass)
      } else {
        if (typeof value !== 'boolean') return invalid('missing_or_wrong_category_output')
        const correct = value === c.metric.target; scores.push(Number(correct)); errors.push(null); pass.push(correct)
      }
    }
    return { quality: scores.reduce((a, b) => a + b, 0) / cases.length, passed: pass.every(Boolean), valid: true, errors, reason: null, caseCount: cases.length }
  } catch (error) {
    if (error instanceof EvaluationIntegrityError) throw error
    return invalid('model_execution_failed_or_invalid_output')
  }
}
