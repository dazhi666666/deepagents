/** Immutable forecasts bind to an unstarted physical plan, never to a retrospective summary. */
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { Plan } from '../v05/planning.ts'
import { V05Planning } from '../v05/planning.ts'
import { FactReader, type FactSource } from '../fact-reader.ts'
import { contentHash, digestSchema, identifier, tickSchema } from './contracts.ts'

export const actionInputSchema = z.object({ id: identifier, taskId: z.enum(['T3', 'T4']), planId: identifier,
  commissionId: identifier.optional(), reviewId: digestSchema.optional().describe('Current service_review plan receipt when reviewed-v1 is enabled.'), sourceId: z.enum(['reservoir', 'filter', 'pump']).default('pump'),
  forecast: z.object({ completedTick: tickSchema, remainingUl: z.number().nonnegative().optional(), postResponseMgL: z.number().nonnegative().optional() }).strict() }).strict()
export const actionSchema = actionInputSchema.extend({ planHash: digestSchema, acceptedTick: tickSchema,
  acceptedSeq: z.number().int().positive(), actorId: identifier, hash: digestSchema }).strict()
export type ActionCommit = z.infer<typeof actionSchema>
/** Dynamic progress/revision counters do not change the selected immutable step specification. */
export function planHash(plan: Plan) {
  return contentHash({ id: plan.id, actorId: plan.actorId, createdTick: plan.createdTick, title: plan.title, steps: plan.steps,
    ...(plan.service ? { service: plan.service } : {}) })
}
export class V06Actions {
  private readonly facts: FactReader
  constructor(private readonly engine: FactSource & Pick<ExecutionEngine, 'eventCursor'>, private readonly context: OperationContext, private readonly tick: () => number,
    private readonly finalTick: number, private readonly commissionIds: readonly string[],
    private readonly onAccepted?: (action: ActionCommit) => void,
    private readonly review?: (planId: string, reviewId?: string) => void) { this.facts = new FactReader(engine, context) }
  list(): ActionCommit[] {
    return this.facts.read().filter(f => f.kind === 'mars-v06-action').map(f => actionSchema.parse(z.object({ result: actionSchema }).parse(f.data).result))
  }
  commit(key: string, input: unknown): ActionCommit {
    const request = actionInputSchema.parse(input), encoded = contentHash(request)
    const rows = this.facts.read().filter(f => f.kind === 'mars-v06-action')
    const prior = rows.map(r => z.object({ actor: identifier, key: identifier, input: digestSchema, result: actionSchema }).parse(r.data))
      .find(r => r.actor === this.context.actorId && r.key === key)
    if (prior) { if (prior.input !== encoded) throw new Error('Action request key changed'); return prior.result }
    const now = this.tick()
    if (now >= this.finalTick) throw new Error('Action prediction admission closed')
    if (this.list().some(a => a.id === request.id)) throw new Error('Action prediction ID is immutable')
    const plan = new V05Planning(this.engine, this.context, this.tick, {}, undefined, 'v06').list().find(p => p.id === request.planId)
    if (!plan) throw new Error(`Plan ${request.planId} is unavailable. Schedule it with experiment_plan and read the accepted planId from round_receipts.`)
    if (plan.service && (request.taskId !== 'T3' || request.commissionId !== plan.service.commissionId))
      throw new Error(`Service plan requires a T3 commitment for ${plan.service.commissionId}`)
    if (plan.state !== 'scheduled' || Object.keys(plan.operations).length) throw new Error('Prediction must precede every accepted plan operation')
    if (request.forecast.completedTick <= now) throw new Error('Completion forecast must be in the future')
    if (request.taskId === 'T3' && (!request.commissionId || !this.commissionIds.includes(request.commissionId) || request.forecast.remainingUl === undefined)) throw new Error('Commitment must name a fixed commission and sample-preservation forecast')
    if (request.taskId === 'T4' && request.forecast.postResponseMgL === undefined) throw new Error('Response requires a pre-action concentration forecast')
    if (this.review && request.taskId === 'T3' && !plan.service) throw new Error('Reviewed T3 commitments require a plan with a matching service binding')
    if (plan.service && this.review) this.review(plan.id, request.reviewId)
    else if (request.reviewId !== undefined) throw new Error('reviewId belongs to a reviewed service plan')
    const body = { ...request, planHash: planHash(plan), acceptedTick: now, acceptedSeq: this.engine.eventCursor(this.context) + 1, actorId: this.context.actorId }
    const result = actionSchema.parse({ ...body, hash: contentHash(body) })
    this.engine.recordFact(this.context, 'mars-v06-action', z.json().parse({ actor: this.context.actorId, key: identifier.parse(key), input: encoded, result }))
    this.onAccepted?.(result)
    return result
  }
}
