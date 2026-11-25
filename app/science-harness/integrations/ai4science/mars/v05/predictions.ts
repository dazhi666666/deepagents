/** Immutable models and host-timed prediction commitments, stored in the execution journal. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type Json, type OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { researchReferenceSchema, V05ResearchRecords } from './research-records.ts'

const text = z.string().trim().min(1), tickSchema = z.number().int().nonnegative()
export const modelInputSchema = z.object({ id: text, code: text, parameters: z.json(), inputSchema: z.json(), outputSchema: z.json(),
  runtimeVersion: text, basedOn: z.array(researchReferenceSchema).default([]) }).strict()
export const modelArtifactSchema = modelInputSchema.extend({ schemaVersion: z.literal(1), hash: text, createdBy: text, createdTick: tickSchema }).strict()
export type ModelArtifact = z.infer<typeof modelArtifactSchema>
export const predictionInputSchema = z.object({ id: text, target: text, modelId: text, inputDomain: z.json() }).strict()
export const predictionCommitSchema = predictionInputSchema.extend({ schemaVersion: z.literal(1), modelHash: text,
  lockedTick: tickSchema, validationAvailableAt: tickSchema, policyHash: text, createdBy: text, commitmentHash: text }).strict()
export type PredictionCommit = z.infer<typeof predictionCommitSchema>
const receipt = z.object({ actor: text, key: text, input: text, result: z.json() }).strict()
export type ValidationPolicyResolver = (target: string) => { availableAt: number; policyHash: string } | null
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value as Json)).digest('hex')

export class V05Predictions {
  constructor(private readonly engine: ExecutionEngine, private readonly context: OperationContext,
    private readonly tick: () => number, private readonly records: V05ResearchRecords,
    private readonly validationPolicy?: ValidationPolicyResolver) {}
  private receipts(kind: string) { return this.engine.readFacts(this.context).filter(fact => fact.kind === kind).map(fact => receipt.parse(fact.data)) }
  models(): ModelArtifact[] { return this.receipts('mars-v05-model').map(row => modelArtifactSchema.parse(row.result)) }
  predictions(): PredictionCommit[] { return this.receipts('mars-v05-prediction').map(row => predictionCommitSchema.parse(row.result)) }
  private mutate(kind: string, key: string, input: Json, make: () => Json): Json {
    text.parse(key)
    const canonical = canonicalJson(input), prior = this.receipts(kind).find(row => row.actor === this.context.actorId && row.key === key)
    if (prior) {
      if (prior.input !== canonical) throw new Error('Request key already used with different input')
      return prior.result
    }
    const result = make()
    this.engine.recordFact(this.context, kind, { actor: this.context.actorId, key, input: canonical, result })
    return result
  }
  registerModel(key: string, input: z.input<typeof modelInputSchema>): ModelArtifact {
    const request = modelInputSchema.parse(input)
    return modelArtifactSchema.parse(this.mutate('mars-v05-model', key, request, () => {
      if (this.models().some(model => model.id === request.id)) throw new Error('Model ID is immutable; register a new model version')
      const now = tickSchema.parse(this.tick())
      for (const dependency of request.basedOn) {
        const record = this.records.read(dependency.id, dependency.revision)
        if (!record || record.availableAt > now) throw new Error('Model dependency unavailable')
      }
      return modelArtifactSchema.parse({ ...request, schemaVersion: 1, hash: hash(request), createdBy: this.context.actorId, createdTick: now })
    }))
  }
  commit(key: string, input: z.input<typeof predictionInputSchema>): PredictionCommit {
    const request = predictionInputSchema.parse(input)
    return predictionCommitSchema.parse(this.mutate('mars-v05-prediction', key, request, () => {
      if (this.predictions().some(item => item.id === request.id)) throw new Error('Prediction is immutable; use a new ID')
      const now = tickSchema.parse(this.tick()), model = this.models().find(item => item.id === request.modelId)
      if (!model || model.createdTick > now) throw new Error('Model unavailable')
      const policy = this.validationPolicy?.(request.target)
      if (!policy || !Number.isInteger(policy.availableAt) || policy.availableAt <= now || !policy.policyHash)
        throw new Error('Validation target unavailable or data already visible; cannot backfill prediction')
      const body = { ...request, schemaVersion: 1 as const, modelHash: model.hash, lockedTick: now,
        validationAvailableAt: policy.availableAt, policyHash: policy.policyHash, createdBy: this.context.actorId }
      return predictionCommitSchema.parse({ ...body, commitmentHash: hash(body) })
    }))
  }
}

