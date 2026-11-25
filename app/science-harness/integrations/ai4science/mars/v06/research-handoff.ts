/** Validate a team handoff against accepted public research records. */
import { z } from 'zod'
import { identifier, slotIdSchema, submissionCutoff, taskIdSchema, type StageProfile } from './contracts.ts'
import { taskSlots } from './registry.ts'
import type { V06Records, RecordResolvers } from './records.ts'
import type { V06Actions } from './actions.ts'

export const handoffReferenceKinds = ['model', 'pipeline', 'prediction', 'plan', 'commitment', 'response', 'evidence'] as const
export const workflowHandoffKinds = [...handoffReferenceKinds, 'draft', 'service-review'] as const
export const researchHandoffSchema = z.object({
  taskId: taskIdSchema,
  slotId: slotIdSchema,
  references: z.array(z.object({ kind: z.enum(workflowHandoffKinds), id: identifier,
    revision: z.number().int().positive().optional(), stepId: identifier.optional() }).strict()).min(1).max(8),
}).strict()
type ResearchHandoff = z.infer<typeof researchHandoffSchema>

/** Attach a bounded snapshot of the references that exist at the sending tick. */
export function resolveResearchHandoff(handoff: ResearchHandoff, tick: number, profile: StageProfile,
  records: V06Records, actions: V06Actions, resolvers: RecordResolvers, resolveEvidenceId: (id: string) => string) {
  const { taskId, slotId } = handoff
  if (!taskSlots(taskId, profile).includes(slotId)) throw new Error(`${taskId} has no ${slotId} slot`)
  const acceptBeforeTick = submissionCutoff(profile, slotId)
  if (tick >= acceptBeforeTick) throw new Error(`${taskId} ${slotId} closed at tick ${acceptBeforeTick}`)
  const references = handoff.references.map(({ kind, id, revision, stepId }) => {
    if (stepId && (kind !== 'plan' || taskId !== 'T3')) throw new Error('stepId belongs to a T3 service plan reference')
    if (kind === 'draft') {
      if (!profile.researchWorkflow || id !== `${taskId}/${slotId}` || revision === undefined) throw new Error('Draft handoff requires the reviewed workflow, task/slot ID and exact draft revision')
      const draft = resolvers.draftReceipt?.(taskId, slotId)
      if (!draft || draft.revision !== revision) throw new Error('Draft revision changed or unavailable')
      return { kind, id, ...draft }
    }
    if (kind === 'service-review') {
      if (!profile.researchWorkflow || taskId !== 'T3' || revision !== undefined) throw new Error('Use a current reviewId for a T3 service review handoff')
      const review = resolvers.serviceReviewReceipt?.(id)
      if (!review) throw new Error('Service review changed or unavailable')
      const {planId, deadline, eligible, firstBlocker} = review
      return { kind, id, planId, deadline, eligible, firstBlocker, asOfTick:tick }
    }
    if (kind === 'evidence') {
      const canonicalId = resolveEvidenceId(id)
      const evidence = resolvers.evidence?.(canonicalId, revision)
      if (!evidence || evidence.availableAt > tick) throw new Error(`Evidence unavailable: ${id}`)
      return { kind, id: canonicalId, availableAt: evidence.availableAt, revision: evidence.revision ?? revision ?? 1 }
    }
    if (revision !== undefined) throw new Error(`Use revision only for an evidence reference: ${id}`)
    if (kind === 'model') {
      const model = records.models().find(item => item.id === id && item.acceptedTick <= tick)
      if (model) return { kind, id, hash: model.hash, acceptedTick: model.acceptedTick }
    } else if (kind === 'pipeline') {
      const pipeline = records.pipelines().find(item => item.pipelineId === id && item.acceptedTick <= tick)
      if (pipeline) return { kind, id, hash: pipeline.hash, acceptedTick: pipeline.acceptedTick }
    } else if (kind === 'prediction') {
      const prediction = records.predictions().find(item => item.id === id && item.acceptedTick <= tick)
      if (prediction) {
        if (prediction.taskId !== taskId || prediction.slotId !== slotId) throw new Error(`Prediction belongs to another task or slot: ${id}`)
        return { kind, id, hash: prediction.hash, acceptedTick: prediction.acceptedTick,
          ...(prediction.modelId ? { modelId: prediction.modelId } : { pipelineId: prediction.pipelineId }) }
      }
    } else if (kind === 'plan') {
      const plan = resolvers.reference?.(kind, id)
      if (plan && stepId) {
        const stepReceipt = resolvers.serviceStep?.(id, stepId)
        if (!stepReceipt) throw new Error(`Service step unavailable: ${id}/${stepId}`)
        return { ...plan, stepReceipt }
      }
      if (plan) return plan
    } else {
      const action = actions.list().find(item => item.id === id && item.acceptedTick <= tick)
      if (action) {
        const actionTask = kind === 'commitment' ? 'T3' : 'T4'
        if (action.taskId !== taskId || taskId !== actionTask) throw new Error(`Action belongs to another task or kind: ${id}`)
        if (resolvers.reference?.('plan', action.planId)?.hash !== action.planHash) throw new Error(`Action plan specification changed: ${id}`)
        return { kind, id, hash: action.hash, acceptedTick: action.acceptedTick, planId: action.planId, planHash: action.planHash,
          ...(action.commissionId ? { commissionId: action.commissionId } : {}) }
      }
    }
    throw new Error(`Accepted ${kind} unavailable: ${id}`)
  })
  return { taskId, slotId, acceptBeforeTick, references }
}
