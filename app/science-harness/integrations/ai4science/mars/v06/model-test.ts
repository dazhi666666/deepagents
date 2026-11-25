/** Run frozen artifacts on caller-supplied JSON only; this does not access scientific validation cases. */
import { z } from 'zod'
import { identifier } from './contracts.ts'
import type { V06Records } from './records.ts'
import { artifactOutputs, EvaluationIntegrityError } from './validation.ts'
import { validateModelValue, FROZEN_MODEL_LIMITS, type FrozenModelOptions } from '../v05/model-execution.ts'
import { scienceProfileSchema } from './profile.ts'

export const modelTestInputSchema = z.object({ modelId: identifier.optional(), pipelineId: identifier.optional(),
  inputs: z.array(z.json()).min(1).max(16) }).strict().refine(v => Boolean(v.modelId) !== Boolean(v.pipelineId), 'Provide exactly one modelId or pipelineId')
export type ModelTestLimits = Pick<FrozenModelOptions, 'timeoutMs' | 'memoryMb' | 'maxOutputBytes'>
const limitsSchema = z.object({ timeoutMs: z.number().int().min(25).max(60000), memoryMb: z.number().int().min(64).max(512),
  maxOutputBytes: z.number().int().min(128).max(16 * 1024 * 1024) }).strict()

/** Explicit limits override profile defaults; validate them while installing the public tool. */
export function modelTestLimits(overrides: ModelTestLimits = {}) {
  const profile = scienceProfileSchema.parse({})
  return limitsSchema.parse({ timeoutMs: profile.modelTimeoutMs, memoryMb: profile.modelMemoryMb, maxOutputBytes: profile.modelOutputBytes, ...overrides })
}

/** Test declared IO and execution within one request deadline; no journal write or scientific acceptance occurs. */
export async function testModel(records: V06Records, input: unknown, limits: ReturnType<typeof modelTestLimits>, callerSignal?: AbortSignal) {
  const request = modelTestInputSchema.parse(input), kind = request.modelId ? 'model' : 'pipeline', id = (request.modelId ?? request.pipelineId)!
  if (Buffer.byteLength(JSON.stringify(request.inputs)) > FROZEN_MODEL_LIMITS.inputBytes) throw new Error('Public test inputs exceed 1 MiB')
  const artifact = kind === 'model' ? records.models().find(m => m.id === id) : records.pipelines().find(p => p.pipelineId === id)
  if (!artifact) throw new Error(`Unknown ${kind}: ${id}; read registration receipts before testing`)
  const metadata = { kind, id, testedInputs: request.inputs.length, inputSource: 'caller_supplied', scientificValidation: 'not_evaluated', limits }
  const deadline = AbortSignal.timeout(limits.timeoutMs), signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline
  try {
    if (signal.aborted) throw new Error('Public model test cancelled')
    for (const [index, value] of request.inputs.entries()) validateModelValue(artifact.inputSchema, value, `inputs[${index}]`)
    const outputs = await artifactOutputs(records, kind, id, request.inputs, { ...limits, signal })
    if (Buffer.byteLength(JSON.stringify(outputs)) > limits.maxOutputBytes) throw new Error('Public model test output limit exceeded')
    for (const [index, value] of outputs.entries()) validateModelValue(artifact.outputSchema, value, `outputs[${index}]`)
    if (signal.aborted) throw new Error('Public model test cancelled')
    return { ...metadata, executionValid: true, outputs, error: null }
  } catch (error) {
    if (error instanceof EvaluationIntegrityError) throw error
    const detail = callerSignal?.aborted ? 'Public model test cancelled' : deadline.aborted ? 'Public model test exceeded time limit'
      : error instanceof Error ? error.message : String(error)
    return { ...metadata, executionValid: false, outputs: [], error: detail }
  }
}
