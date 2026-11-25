/** v0.6 public JSON validation. Scientific acceptance is evaluated separately. */
import { createHash } from 'node:crypto'
import { pilotChoiceVersion, sharedPlanVersion, scopedStepIds, isChoiceTrial, pilotSchema, choiceSchema } from './pilot-choice-contract.ts'
import { pairedGrowthVersion, trialDeclaration } from './joint-trial-contract.ts'
import { z } from 'zod'
import { canonicalJson } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'

export const identifier = z.string().trim().min(1).max(160)
export const tickSchema = z.number().int().nonnegative()
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const taskIdSchema = z.enum(['T1', 'T2', 'T3', 'T4', 'T5', 'T6'])
export type TaskId = z.infer<typeof taskIdSchema>
export const slotIdSchema = z.enum(['baseline', 'final'])
export type SlotId = z.infer<typeof slotIdSchema>
export const stageProfileSchema = z.object({
  baselineTick: z.number().int().positive(), finalTick: z.number().int().positive(), horizon: z.number().int().positive(),
  jointTrial: z.enum([pairedGrowthVersion, pilotChoiceVersion, sharedPlanVersion]).optional(),
  researchWorkflow: z.enum(['reviewed-v1','delivery-v2']).optional(),
}).strict().refine(p => p.baselineTick < p.finalTick && p.finalTick < p.horizon, 'Require 0 < baselineTick < finalTick < horizon')
export type StageProfile = z.infer<typeof stageProfileSchema>
export const developmentStages: StageProfile = { baselineTick: 720, finalTick: 1800, horizon: 2400 }

/** The slot accepts new revisions strictly before this tick. */
export function submissionCutoff(profile: StageProfile, slot: SlotId): number {
  return slot === 'baseline' ? profile.baselineTick : profile.finalTick
}

/** Hash only validated finite JSON; undefined, NaN and Infinity are rejected. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(z.json().parse(value))).digest('hex')
}
export const evidenceSchema = z.object({ id: identifier, purpose: z.enum([
  'calibration', 'bias-study', 'historical', 'current-estimate', 'validation', 'intervention', 'preservation',
]), revision: z.number().int().positive().optional() }).strict()
const modelPayload = z.object({ modelId: identifier, predictionId: identifier }).strict()
export const payloadSchemas = {
  T1: modelPayload,
  T2: modelPayload.extend({ planId: identifier.optional() }).strict(),
  T3: modelPayload.extend({ commitmentIds: z.array(identifier).default([]) }).strict(),
  T4: z.object({ diagnosis: z.array(z.enum(['none', 'inlet', 'membrane', 'seal', 'inline-sensor', 'storage', 'measurement', 'carryover'])),
    responseIds: z.array(identifier).default([]) }).strict(),
  T5: z.union([
    modelPayload.extend({ scopeIds: z.array(identifier) }).strict(),
    z.object({ pipelineId: identifier, predictionId: identifier, scopeIds: z.array(identifier) }).strict(),
  ]),
  T6: z.object({ planId: identifier }).strict(),
}
const finalCropPayload = payloadSchemas.T2.required({ planId: true })

/** Payload validation shared by the slot contract and submission parser. */
const trialPayload = payloadSchemas.T6.extend({ trial: trialDeclaration }).strict()
export function submissionPayloadSchema(taskId: TaskId, slotId: SlotId, profile?: StageProfile) {
  if (profile?.jointTrial === sharedPlanVersion && slotId === 'final') {
    if (taskId === 'T2') return finalCropPayload.extend({ stepIds:scopedStepIds })
    if (taskId === 'T6') return payloadSchemas.T6.extend({ choice:choiceSchema,stepIds:scopedStepIds })
  }
  if (taskId === 'T6' && isChoiceTrial(profile?.jointTrial)) return slotId === 'baseline'
    ? payloadSchemas.T6.extend({ pilot: pilotSchema }).strict() : payloadSchemas.T6.extend({ choice: choiceSchema }).strict()
  if (taskId === 'T6' && profile?.jointTrial) return trialPayload
  return taskId === 'T2' && slotId === 'final' ? finalCropPayload : payloadSchemas[taskId]
}

const submissionEnvelope = z.object({ taskId: taskIdSchema, slotId: slotIdSchema, payload: z.json(),
  evidence: z.array(evidenceSchema), expectedRevision: z.number().int().nonnegative() }).strict()
export function submissionInputFor(profile?: StageProfile) {
  return submissionEnvelope.superRefine((v, ctx) => {
    if (v.slotId === 'baseline' && (v.taskId === 'T4' || (v.taskId === 'T6' && !isChoiceTrial(profile?.jointTrial))))
      ctx.addIssue({ code: 'custom', path: ['slotId'], message: 'This task has only a final slot' })
    const parsed = submissionPayloadSchema(v.taskId, v.slotId, profile).safeParse(v.payload)
    if (!parsed.success) for (const issue of parsed.error.issues)
      ctx.addIssue({ code: 'custom', path: ['payload', ...issue.path], message: issue.message })
  })
}
export const submissionInputSchema = submissionInputFor()
export type SubmissionInput = z.infer<typeof submissionInputSchema>
export const modelInputSchema = z.object({ id: identifier, code: z.string().min(1).max(131072).describe('Synchronous JavaScript function BODY using input and parameters. Example: return {value: input.x}; No function/arrow wrapper. Syntax and an outer return are checked at registration; use model_test for public IO checks.'),
  parameters: z.json().describe('Required JSON parameters. Use an empty object when the model has no parameters.'),
  inputSchema: z.json().describe('Supported schema subset: type, properties, required, additionalProperties, items, enum, const and numeric/string/array bounds. $ref/anyOf/oneOf are unsupported, including optional nested fields.'),
  outputSchema: z.json().describe('Same supported schema subset as inputSchema. Output must be finite JSON; runtime testing does not certify scientific quality.'), runtimeVersion: z.enum(['mars-analysis-v1', 'mars-model-v06-sync-v1']).describe('v0.6 frozen predictors are synchronous functions returning finite JSON. No await, filesystem, network or Host callbacks. Preferred: mars-model-v06-sync-v1.'),
  basedOn: z.array(z.object({ id: identifier, revision: z.number().int().positive() }).strict()).default([])
    .describe('ID and revision of each research note used as a dependency. Write or read the note through research_write or research_read.'),
  units: z.object({ input: z.record(z.string(), z.string()), output: z.record(z.string(), z.string()) }).strict().optional() }).strict()
export const predictionInputSchema = z.object({ id: identifier, taskId: taskIdSchema, slotId: slotIdSchema,
  modelId: identifier.optional(), pipelineId: identifier.optional(),
  inputDomain: z.json().describe('Required JSON describing the public input domain. See research_catalog section=interfaces for the task.') }).strict()
export const frozenReferenceSchema = z.object({ kind: z.enum(['model', 'prediction', 'pipeline', 'plan', 'commitment', 'response']),
  id: identifier, hash: digestSchema }).strict()
export type FrozenReference = z.infer<typeof frozenReferenceSchema>
export const submissionSchema = z.object({ taskId: taskIdSchema, slotId: slotIdSchema, payload: z.json(), evidence: z.array(evidenceSchema),
  revision: z.number().int().positive(), acceptedTick: tickSchema, acceptedSeq: z.number().int().positive(),
  actorId: identifier, references: z.array(frozenReferenceSchema) }).strict()
export type Submission = z.infer<typeof submissionSchema>
