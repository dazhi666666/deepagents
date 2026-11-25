/** Single-writer v0.6 submissions and immutable executable-model references. */
import { z } from 'zod'
import { FactReader, type FactSource } from '../fact-reader.ts'
import { canonicalJson, type Json, type OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { contentHash, digestSchema, identifier, tickSchema, modelInputSchema, predictionInputSchema, submissionInputFor,
  submissionCutoff, submissionSchema, type FrozenReference, type SlotId, type StageProfile, type Submission, type TaskId } from './contracts.ts'

import { pipelineSchema, validatePipeline, type Pipeline } from './pipeline.ts'
import { assertSynchronousModelProgram } from '../program-validation.ts'
import { assertModelSchema, FROZEN_MODEL_LIMITS } from '../v05/model-execution.ts'

export type ResearchJournal = FactSource
const receiptSchema = z.object({ sequence: z.number().int().positive(), actorId: identifier, key: identifier,
  operation: z.enum(['model', 'pipeline', 'prediction', 'submission']), input: z.string(), result: z.json() }).strict()
export const modelArtifactSchema = modelInputSchema.extend({ hash: digestSchema, createdBy: identifier,
  acceptedTick: tickSchema, acceptedSeq: z.number().int().positive() }).strict()
export type ModelArtifact = z.infer<typeof modelArtifactSchema>
export const predictionSchema = predictionInputSchema.extend({ modelHash: digestSchema, caseSetHash: digestSchema,
  validationAvailableAt: tickSchema, acceptedTick: tickSchema, acceptedSeq: z.number().int().positive(),
  actorId: identifier, hash: digestSchema }).strict()
export type PredictionCommit = z.infer<typeof predictionSchema>
export interface RecordResolvers {
  /** Must refer to completed public evidence; scientific purpose/lineage checks run at evaluation. */
  evidence?(id: string, revision: number | undefined): { availableAt: number; revision?: number } | null
  /** Omitted until actual validation cases are installed; no synthetic scientific case hash is invented. */
  validation?(task: TaskId, slot: SlotId): { caseSetHash: string; availableAt: number } | null
  reference?(kind: FrozenReference['kind'], id: string): FrozenReference | null
  dependency?(id: string, revision: number): { availableAt: number } | null
  checkJointTrial?(payload: Json, slot: SlotId, evidence: Submission['evidence']): void
  checkCropPlan?(payload:Json):void
  draftReceipt?(taskId: TaskId, slotId: SlotId): { revision:number; tick:number; actorId:string; problem:string | null } | null
  serviceReviewReceipt?(reviewId:string): { planId:string; reviewId:string; deadline:number; eligible:boolean; firstBlocker:{stepId:string; code:string; detail:string} | null } | null
  serviceStep?(planId: string, stepId: string): { commissionId: string; stepId: string; state: string;
    operationId: string | null; acceptedTick: number | null; completedTick: number | null; blockedReason: string | null } | null
}

/** Synchronous checks and append share the engine's single writable owner; no await may separate them. */
export class V06Records {
  private readonly facts: FactReader
  constructor(private readonly journal: ResearchJournal, private readonly context: OperationContext,
    private readonly tick: () => number, private readonly profile: StageProfile, private readonly resolvers: RecordResolvers = {}) {
    this.facts = new FactReader(journal, context)
  }
  private receipts() {
    return this.facts.read().filter(f => f.kind === 'mars-v06-record').map(f => receiptSchema.parse(f.data))
  }
  models(): ModelArtifact[] { return this.receipts().filter(r => r.operation === 'model').map(r => modelArtifactSchema.parse(r.result)) }
  pipelines(): Pipeline[] { return this.receipts().filter(r => r.operation === 'pipeline').map(r => pipelineSchema.parse(r.result)) }
  registerPipeline(key: string, input: unknown): Pipeline {
    const { request, modelHashes } = validatePipeline(input, this.models())
    return pipelineSchema.parse(this.mutate('pipeline', key, request, sequence => {
      const now = this.assertOpen('final')
      if (this.pipelines().some(p => p.pipelineId === request.pipelineId)) throw new Error('Pipeline ID is immutable')
      assertModelSchema(request.inputSchema, 'inputSchema')
      assertModelSchema(request.outputSchema, 'outputSchema')
      const body = { ...request, modelHashes }
      return { ...body, hash: contentHash(body), acceptedTick: now, acceptedSeq: sequence, actorId: this.context.actorId }
    }))
  }
  predictions(): PredictionCommit[] { return this.receipts().filter(r => r.operation === 'prediction').map(r => predictionSchema.parse(r.result)) }
  submissions(): Submission[] { return this.receipts().filter(r => r.operation === 'submission').map(r => submissionSchema.parse(r.result)) }
  latest(task: TaskId, slot: SlotId): Submission | null {
    return this.submissions().filter(s => s.taskId === task && s.slotId === slot).at(-1) ?? null
  }
  private assertOpen(slot: SlotId) {
    const now = tickSchema.parse(this.tick()), cutoff = submissionCutoff(this.profile, slot)
    const sealed = this.facts.read().some(f => f.kind === 'mars-v06-seal' &&
      z.object({ stage: z.string() }).parse(f.data).stage === slot)
    if (now >= cutoff || sealed) throw new Error(`Submission slot closed: ${slot}; acceptedTick must be < ${cutoff}`)
    return now
  }
  private mutate(operation: z.infer<typeof receiptSchema>['operation'], key: string, input: unknown,
    make: (sequence: number) => unknown): Json {
    identifier.parse(key)
    const encoded = canonicalJson(z.json().parse(input)), receipts = this.receipts()
    const old = receipts.find(r => r.operation === operation && r.actorId === this.context.actorId && r.key === key)
    if (old) {
      if (old.input !== encoded) throw new Error('Request key already used with different input')
      return old.result
    }
    const sequence = receipts.reduce((n, r) => Math.max(n, r.sequence), 0) + 1
    const result = z.json().parse(make(sequence))
    this.journal.recordFact(this.context, 'mars-v06-record', receiptSchema.parse({ sequence, actorId: this.context.actorId, key, operation, input: encoded, result }))
    return result
  }
  registerModel(key: string, input: unknown): ModelArtifact {
    const request = modelInputSchema.parse(input)
    return modelArtifactSchema.parse(this.mutate('model', key, request, sequence => {
      const now = this.assertOpen('final')
      if (this.models().some(m => m.id === request.id)) throw new Error('Model ID is immutable; use a new version')
      if (Buffer.byteLength(request.code) > FROZEN_MODEL_LIMITS.codeBytes) throw new Error('Model code exceeds 200 kB')
      if (Buffer.byteLength(JSON.stringify(request.parameters)) > FROZEN_MODEL_LIMITS.parameterBytes) throw new Error('Model parameter limit exceeded')
      assertSynchronousModelProgram(request.code)
      assertModelSchema(request.inputSchema, 'inputSchema')
      assertModelSchema(request.outputSchema, 'outputSchema')
      for (const dependency of request.basedOn) {
        const resolved = this.resolvers.dependency?.(dependency.id, dependency.revision)
        if (!resolved || resolved.availableAt > now) throw new Error('Research dependency unavailable')
      }
      return modelArtifactSchema.parse({ ...request, hash: contentHash(request), createdBy: this.context.actorId,
        acceptedTick: now, acceptedSeq: sequence })
    }))
  }
  commitPrediction(key: string, input: unknown): PredictionCommit {
    const request = predictionInputSchema.parse(input)
    return predictionSchema.parse(this.mutate('prediction', key, request, sequence => {
      const now = this.assertOpen(request.slotId)
      if (['T4', 'T6'].includes(request.taskId)) throw new Error('This slot does not accept a science-model prediction')
      if (this.predictions().some(p => p.id === request.id)) throw new Error('Prediction ID is immutable')
      if (Boolean(request.modelId) === Boolean(request.pipelineId)) throw new Error('Prediction requires exactly one modelId or pipelineId')
      const model = request.modelId ? this.models().find(m => m.id === request.modelId) : this.pipelines().find(p => p.pipelineId === request.pipelineId)
      if (!model || model.acceptedTick > now) throw new Error('Model or pipeline unavailable')
      const policy = this.resolvers.validation?.(request.taskId, request.slotId)
      if (!policy) throw new Error('Scientific validation cases are not installed for this slot')
      digestSchema.parse(policy.caseSetHash)
      if (tickSchema.parse(policy.availableAt) <= now) throw new Error('Validation data already available; cannot backfill prediction')
      const body = { ...request, modelHash: model.hash, caseSetHash: policy.caseSetHash, validationAvailableAt: policy.availableAt,
        acceptedTick: now, acceptedSeq: sequence, actorId: this.context.actorId }
      return predictionSchema.parse({ ...body, hash: contentHash(body) })
    }))
  }
  private references(task: TaskId, slot: SlotId, payload: Json): FrozenReference[] {
    const body = z.record(z.string(), z.json()).parse(payload), references: FrozenReference[] = []
    if (typeof body.modelId === 'string') {
      const model = this.models().find(m => m.id === body.modelId)
      const prediction = this.predictions().find(p => p.id === body.predictionId)
      if (!model || !prediction || prediction.taskId !== task || prediction.slotId !== slot ||
        prediction.modelId !== model.id || prediction.modelHash !== model.hash) throw new Error('Model/prediction reference differs from task or slot')
      references.push({ kind: 'model', id: model.id, hash: model.hash }, { kind: 'prediction', id: prediction.id, hash: prediction.hash })
    }
    const resolve = (kind: FrozenReference['kind'], id: string) => {
      const ref = this.resolvers.reference?.(kind, id)
      if (!ref || ref.kind !== kind || ref.id !== id) throw new Error(`Frozen reference unavailable: ${kind}:${id}`)
      digestSchema.parse(ref.hash); references.push(ref)
    }
    if (typeof body.pipelineId === 'string') {
      const pipeline = this.pipelines().find(p => p.pipelineId === body.pipelineId)
      const prediction = this.predictions().find(p => p.id === body.predictionId)
      if (!pipeline || !prediction || prediction.pipelineId !== pipeline.pipelineId || prediction.modelHash !== pipeline.hash ||
        prediction.taskId !== task || prediction.slotId !== slot) throw new Error('Pipeline/prediction reference differs from task or slot')
      references.push({ kind: 'pipeline', id: pipeline.pipelineId, hash: pipeline.hash }, { kind: 'prediction', id: prediction.id, hash: prediction.hash })
      for (const [id, hash] of Object.entries(pipeline.modelHashes)) references.push({ kind: 'model', id, hash })
    }
    if (typeof body.planId === 'string') resolve('plan', body.planId)
    for (const id of z.array(identifier).parse(body.commitmentIds ?? [])) resolve('commitment', id)
    for (const id of z.array(identifier).parse(body.responseIds ?? [])) resolve('response', id)
    return references
  }
  /** Format-only preflight: checks IDs and visibility, never executes or scores scientific code. */
  check(input: unknown) {
    const request = submissionInputFor(this.profile).parse(input), now = this.assertOpen(request.slotId)
    const current = this.latest(request.taskId, request.slotId)
    if ((current?.revision ?? 0) !== request.expectedRevision) throw new Error('Submission revision changed; read before editing')
    const problems = request.evidence.flatMap((evidence, index) => {
      const resolved = this.resolvers.evidence?.(evidence.id, evidence.revision)
      if (resolved && tickSchema.parse(resolved.availableAt) <= now) return []
      const body = z.record(z.string(), z.json()).parse(request.payload)
      const field = ['modelId', 'pipelineId', 'predictionId', 'planId', 'commitmentIds', 'responseIds'].find(name => {
        const value = body[name]
        return value === evidence.id || (Array.isArray(value) && value.includes(evidence.id))
      })
      return [`evidence[${index}].id: Evidence unavailable: ${evidence.id}. ${field ? `Keep this ID in payload.${field}. ` : ''}Choose an available result, completed operation, analysis or research note from research_catalog(section=references).`]
    })
    if (problems.length) throw new Error(problems.join('\n'))
    if (this.profile.jointTrial === 'shared-plan-v3' && request.taskId === 'T2' && request.slotId === 'final') {
      if (!this.resolvers.checkCropPlan) throw new Error('Shared T2 plan requires the scientific runtime')
      this.resolvers.checkCropPlan(request.payload)
    }
    if (this.profile.jointTrial && request.taskId === 'T6') {
      if (!this.resolvers.checkJointTrial) throw new Error('T6 trial requires the scientific runtime')
      this.resolvers.checkJointTrial(request.payload, request.slotId, request.evidence)
    }
    return { request, references: this.references(request.taskId, request.slotId, request.payload), now }
  }
  submit(key: string, input: unknown, draftRevision?: number): Submission {
    const parsed = submissionInputFor(this.profile).parse(input)
    const identity = draftRevision === undefined ? parsed : { draftRevision, request: parsed }
    return this.submitResolved(key, identity, () => parsed)
  }
  /** Replay the original request key before consulting mutable reference directories. */
  submitResolved(key: string, identity: unknown, resolve: () => unknown): Submission {
    return submissionSchema.parse(this.mutate('submission', key, z.json().parse(identity), sequence => {
      const { request, references, now } = this.check(resolve())
      const { expectedRevision, ...body } = request
      return submissionSchema.parse({ ...body, revision: expectedRevision + 1, acceptedTick: now,
        acceptedSeq: sequence, actorId: this.context.actorId, references })
    }))
  }
}
