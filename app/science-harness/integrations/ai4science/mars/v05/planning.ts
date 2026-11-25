/** Durable deterministic plans. Scheduling does not bypass the physical execution engine. */
import { z } from 'zod'
import { canonicalJson, type Json, type OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { FactReader, type FactSource } from '../fact-reader.ts'

const text = z.string().trim().min(1), tick = z.number().int().nonnegative()
export const planStepSchema = z.object({ id: text, providerId: text, input: z.json(),
  at: tick.default(0), dependsOn: z.array(text).default([]), reservationIds: z.array(text).default([]) }).strict()
const servicePlanSchema = z.object({ commissionId: text, measurementStepId: text, retentionStepId: text }).strict()
export const planInputSchema = z.object({ title: text, steps: z.array(planStepSchema).min(1), service: servicePlanSchema.optional() }).strict()
export type PlanInput = z.input<typeof planInputSchema>
export type PlanDraft = z.output<typeof planInputSchema>
export interface Plan extends PlanDraft { id: string; actorId: string; revision: number;
  state: 'scheduled' | 'running' | 'succeeded' | 'partial_failed' | 'cancelled'; operations: Record<string, string>; createdTick: number;
  blocked?: Record<string, { reason: string; sinceTick: number }>; failureReason?: string }
/** A settled receipt, failed step or released dependency can require dispatch before the next planned start. */
export function planNeedsDispatch(plan:Plan, now:number, state:(id:string)=>string|undefined) {
  if (plan.state!=='scheduled' && plan.state!=='running') return false
  const admitted=Object.values(plan.operations)
  if (admitted.some(id => {
    const observed = state(id)
    return observed === undefined || ['failed', 'cancelled', 'unknown'].includes(observed)
  })) return true
  if (admitted.length===plan.steps.length) return admitted.every(id=>state(id)==='succeeded')
  return plan.steps.some(step=>!plan.operations[step.id] && step.at<=now && step.dependsOn.every(id=>{
    const predecessor=plan.operations[id]
    return predecessor!==undefined && state(predecessor)==='succeeded'
  }))
}
export interface Reservation { id: string; actorId: string; revision: number; resource: string; start: number; end: number; quantity: number; state: 'committed' | 'active' | 'released' | 'expired'; planId?: string | undefined; stepId?: string | undefined; operationId?: string | undefined }
const reservationInput = z.object({ resource: text, start: tick, end: tick, quantity: z.number().positive().default(1), planId: text.optional(), stepId: text.optional() }).strict()
  .refine(v => v.end > v.start, 'Reservation end must exceed start')
  .refine(v => Boolean(v.planId) === Boolean(v.stepId), 'Supply both planId and stepId')
export interface ResourceNeed { resource: string; quantity: number }
/** Expected physical refusals are separate from infrastructure/programming failures. */
export class PlanAdmissionError extends Error {
  constructor(message: string, readonly permanent = false) { super(message) }
}
export interface PlanningResources {
  resourcesOf(providerId: string, input: Json): ResourceNeed[]
  occupied?(resource: string): number
  /** Provided placeholders belong to declared predecessor outputs; omitted means resolved dispatch input. */
  validateInput?(providerId: string, input: Json, deferred?: ReadonlySet<string>): void
  inspectService?(plan: PlanDraft): Json
  /** Optional synchronous observer of each changed/terminal block; absent observers leave durable status without messaging. */
  onBlocked?(planId: string, actorId: string, stepId: string, reason: string, terminal: boolean): void
}
const outputReference = /^\$step:([^:]+):(outputSampleId|outputSampleIds(?:\.\d+)?|resultId|resultIds(?:\.\d+)?)$/

/** Resolve the syntax of a local output link without reading operation results. */
export function parsePlanOutputReference(value: string) {
  if (!value.startsWith('$step:')) return null
  const match = outputReference.exec(value)
  if (!match) throw new PlanAdmissionError('Invalid local step output reference', true)
  return { stepId: match[1]!, field: match[2]! }
}

function mapReferences(input: Json, replace: (stepId: string, path: string) => Json): Json {
  if (typeof input === 'string') {
    const ref = parsePlanOutputReference(input)
    return ref ? replace(ref.stepId, ref.field) : input
  }
  if (Array.isArray(input)) return input.map(value => mapReferences(value, replace))
  if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, mapReferences(value, replace)]))
  return input
}
type Receipt = { key: string; input: string; result: Json }
export class V05Planning {
  private advancing = false
  private readonly dispatching = new Set<string>()
  private readonly facts: FactReader
  constructor(private readonly engine: FactSource, private readonly context: OperationContext,
    private readonly logicalTick: () => number = () => 0, private readonly capacities: Record<string, number> = {}, private readonly resources?: PlanningResources,
    private readonly namespace: 'v05' | 'v06' = 'v05', private readonly mayDispatch: (plan: Plan) => boolean = () => true) {
    this.facts = new FactReader(engine, context, namespace === 'v06')
  }
  private receipts(): Receipt[] { return this.facts.read().filter(v => v.kind === `mars-${this.namespace}-plan-mutation`).map(v => v.data as unknown as Receipt) }
  /** Last durable step admission determines the next actor's scheduling priority. */
  lastAcceptedActor(): string | undefined {
    return this.facts.read().filter(fact => fact.kind === `mars-${this.namespace}-plan-mutation` && String((fact.data as { key?: string }).key).startsWith('plan-step:')).at(-1)?.actorId
  }
  private mutate<T>(key: string, input: unknown, body: () => T): T {
    text.parse(key)
    const encoded = canonicalJson(z.json().parse(input))
    const previous = this.facts.read().find(v => v.kind === `mars-${this.namespace}-plan-mutation` && v.actorId === this.context.actorId && (v.data as unknown as Receipt).key === key)
    if (previous) { const receipt = previous.data as unknown as Receipt; if (receipt.input !== encoded) throw new Error('Request key used with different input'); return structuredClone(receipt.result) as T }
    const result = body()
    this.engine.recordFact(this.context, `mars-${this.namespace}-plan-mutation`, z.json().parse({ key, input: encoded, result }))
    return result
  }
  list(): Plan[] { const all = new Map<string, Plan>(); for (const r of this.receipts()) { const v = r.result as unknown as Plan; if (v.steps) all.set(v.id, v) } return structuredClone([...all.values()]) }
  reservations(): Reservation[] { const all = new Map<string, Reservation>(); for (const r of this.receipts()) { const v = r.result as unknown as Reservation & { reservations?: Reservation[] }; if (v.resource) all.set(v.id, v); for (const item of v.reservations ?? []) all.set(item.id, item) } return structuredClone([...all.values()]) }
  check(input: unknown) { return this.checked(input).plan }
  /** Read current occupancy and deterministic timing bounds without acquiring resources. */
  inspect(input: unknown, deadlineTick?: number) {
    const needs = new Map<string, ResourceNeed[]>()
    const { plan, service } = this.checked(input, new Set(), (id, resources) => needs.set(id, resources))
    const now = this.logicalTick(), reservations = this.reservations()
    const byId = new Map(plan.steps.map(step => [step.id, step]))
    const starts = new Map<string, number>()
    const earliestStart = (id: string): number => {
      const known = starts.get(id)
      if (known !== undefined) return known
      const step = byId.get(id)!
      const at = Math.max(now, step.at, ...step.dependsOn.map(earliestStart))
      starts.set(id, at)
      return at
    }
    const steps = plan.steps.map(step => {
      const earliestStartTick = earliestStart(step.id)
      const resources = (needs.get(step.id) ?? []).map(need => {
        const capacity = this.capacities[need.resource]!
        const reserved = reservations.filter(r => r.resource === need.resource && r.state === 'committed' &&
          r.start <= earliestStartTick && earliestStartTick < r.end)
        const reservedQuantity = reserved.reduce((total, r) => total + r.quantity, 0)
        return { resource: need.resource,
          occupiedNow: (this.resources?.occupied?.(need.resource) ?? 0) + need.quantity > capacity,
          reservationConflict: reservedQuantity + need.quantity > capacity ? reserved.map(r => r.id) : [] }
      })
      return { id: step.id, earliestStartTick, startsLate: step.at > 0 && step.at < now,
        missesDeadline: deadlineTick !== undefined && earliestStartTick > deadlineTick, resources }
    })
    return { plan, diagnostics: { asOfTick: now, deadlineTick: deadlineTick ?? null, steps, ...(service ? { service } : {}) } }
  }
  private checked(input: unknown, acceptedSteps: ReadonlySet<string> = new Set(),
    onResources?: (stepId: string, needs: ResourceNeed[]) => void) {
    const plan = planInputSchema.parse(input), byId = new Map(plan.steps.map(v => [v.id, v]))
    if (byId.size !== plan.steps.length) throw new Error('Duplicate step id')
    const active = new Set<string>(), visited = new Set<string>()
    const visit = (id: string) => { if (active.has(id)) throw new Error('Dependency cycle'); if (visited.has(id)) return
      const step = byId.get(id); if (!step) throw new Error('Unknown dependency'); active.add(id)
      for (const dependency of step.dependsOn) visit(dependency)
      active.delete(id); visited.add(id) }
    for (const step of plan.steps) visit(step.id)
    for (const step of plan.steps) {
      if (acceptedSteps.has(step.id)) continue
      try {
        const deferred = new Set<string>()
        const shaped = mapReferences(step.input, (id, path) => {
          if (!step.dependsOn.includes(id)) throw new PlanAdmissionError('Output reference must name a declared predecessor', true)
          const placeholder = `v05-deferred-output-${id}-${path}`
          deferred.add(placeholder)
          return ['outputSampleIds', 'resultIds'].includes(path) ? [placeholder] : placeholder
        })
        this.resources?.validateInput?.(step.providerId, shaped, deferred)
        const needs = (this.resources?.resourcesOf(step.providerId, shaped) ?? [])
          .filter(need => ![...deferred].some(id => need.resource.includes(id)))
        for (const need of needs) {
          if (!Object.hasOwn(this.capacities, need.resource)) throw new Error(`Unknown public resource: ${need.resource}`)
          if (need.quantity > this.capacities[need.resource]!) throw new Error(`Step exceeds resource capacity: ${need.resource}`)
        }
        onResources?.(step.id, needs)
      } catch (error) {
        const message = `Step ${step.id}: ${error instanceof Error ? error.message : String(error)}`
        if (error instanceof PlanAdmissionError) throw new PlanAdmissionError(message, error.permanent)
        throw new Error(message, { cause: error })
      }
    }
    if (!plan.service) return { plan }
    if (!this.resources?.inspectService) throw new Error('Service plans require the v0.6 scientific runtime')
    return { plan, service: this.resources.inspectService(plan) }
  }
  schedule(key: string, input: unknown): Plan {
    const plan = planInputSchema.parse(input)
    return this.mutate(key, { action: 'schedule', plan }, () => {
      this.checked(plan)
      return { ...plan, id: `plan-${this.logicalTick()}-${this.receipts().length + 1}`, actorId: this.context.actorId,
        revision: 1, state: 'scheduled' as const, operations: {}, createdTick: this.logicalTick() }
    })
  }
  private owned(id: string, revision: number): Plan {
    const plan = this.list().find(v => v.id === id)
    if (!plan || plan.actorId !== this.context.actorId) throw new Error('Unknown or unowned plan')
    if (plan.revision !== revision) throw new Error('Plan revision changed')
    return plan
  }
  amend(key: string, id: string, revision: number, input: unknown): Plan {
    const changed = planInputSchema.parse(input)
    return this.mutate(key, { action: 'amend', id, revision, changed }, () => {
      const prior = this.owned(id, revision)
      if (this.dispatching.has(id)) throw new Error('Plan dispatch is in progress; retry amendment')
      if (['cancelled', 'succeeded', 'partial_failed'].includes(prior.state)) throw new Error('Plan is terminal')
      if ((prior.service || changed.service) && Object.keys(prior.operations).length)
        throw new Error('A started service plan has a frozen specification. Cancel it to schedule revised work.')
      if (prior.service && changed.service?.commissionId !== prior.service.commissionId)
        throw new Error('Keep the service commissionId when amending the plan')
      for (const step of prior.steps) if (prior.operations[step.id] && canonicalJson(z.json().parse(step)) !== canonicalJson(z.json().parse(changed.steps.find(v => v.id === step.id) ?? null)))
        throw new Error('Cannot amend an accepted step')
      this.checked(changed, new Set(Object.keys(prior.operations)))
      const { blocked: oldBlocks, ...body } = prior
      const blocked = Object.fromEntries(Object.entries(oldBlocks ?? {}).filter(([id]) =>
        canonicalJson(z.json().parse(prior.steps.find(s => s.id === id) ?? null)) === canonicalJson(z.json().parse(changed.steps.find(s => s.id === id) ?? null))))
      return { ...body, ...changed, ...(Object.keys(blocked).length ? { blocked } : {}), revision: revision + 1 }
    })
  }
  cancel(key: string, id: string, revision: number): Plan {
    return this.mutate(key, { action: 'cancel', id, revision }, () => {
      const prior = this.owned(id, revision)
      if (prior.state === 'succeeded' || prior.state === 'partial_failed') throw new Error('Plan is terminal')
      const { blocked: _blocked, ...body } = prior
      return { ...body, revision: revision + 1, state: 'cancelled' as const }
    })
  }
  reserve(key: string, input: unknown): Reservation {
    const request = reservationInput.parse(input)
    return this.mutate(key, { action: 'reserve', request }, () => {
      if (request.start < this.logicalTick()) throw new Error('Cannot reserve the past')
      if (Object.keys(this.capacities).length && !Object.hasOwn(this.capacities, request.resource)) throw new Error('Unknown public resource')
      if (request.planId) {
        const plan = this.list().find(v => v.id === request.planId && v.actorId === this.context.actorId)
        const step = plan?.steps.find(v => v.id === request.stepId)
        if (!step || !plan || !['scheduled', 'running'].includes(plan.state) || plan.operations[step.id]) throw new Error('Unknown or accepted plan step')
        if (this.resources && !this.resources.resourcesOf(step.providerId, step.input).some(v => v.resource === request.resource)) throw new Error('Resource does not belong to plan step')
      }
      const capacity = Object.hasOwn(this.capacities, request.resource) ? this.capacities[request.resource]! : 1
      const overlapping = this.reservations().filter(v => (v.state === 'committed' || v.state === 'active') && v.resource === request.resource && (v.state === 'active' || v.start < request.end && request.start < v.end))
      const points = [request.start, ...overlapping.filter(v => v.start > request.start).map(v => v.start)]
      if (points.some(at => request.quantity + overlapping.filter(v => v.state === 'active' || v.start <= at && at < v.end).reduce((n, v) => n + v.quantity, 0) > capacity)) throw new Error('Resource capacity conflict')
      return { ...request, id: `reservation-${this.logicalTick()}-${this.receipts().length + 1}`, actorId: this.context.actorId, revision: 1, state: 'committed' as const }
    })
  }
  release(key: string, id: string, revision: number): Reservation {
    return this.mutate(key, { action: 'release', id, revision }, () => {
      const prior = this.reservations().find(v => v.id === id)
      if (!prior || prior.actorId !== this.context.actorId) throw new Error('Unknown or unowned reservation')
      if (prior.revision !== revision) throw new Error('Reservation revision changed')
      if (prior.state === 'active') throw new Error('Accepted operation still owns the reservation')
      return { ...prior, revision: revision + 1, state: 'released' as const }
    })
  }
  /** Release completed physical occupancy; cancellation only releases work not yet accepted. */
  settleReservations(operationState: (id: string) => string | undefined) {
    for (const reservation of this.reservations().filter(v => v.actorId === this.context.actorId && (v.state === 'committed' || v.state === 'active'))) {
      const plan = reservation.planId ? this.list().find(v => v.id === reservation.planId) : undefined
      const finished = reservation.operationId && ['succeeded', 'failed', 'cancelled'].includes(operationState(reservation.operationId) ?? '')
      const state = finished || (plan?.state === 'cancelled' || plan?.state === 'partial_failed') && reservation.state !== 'active' ? 'released'
        : reservation.state === 'committed' && this.logicalTick() >= reservation.end ? 'expired' : null
      if (state) this.mutate(`reservation-settle:${reservation.id}:${reservation.revision}`, { id: reservation.id, state }, () => ({ ...reservation, state, revision: reservation.revision + 1 }))
    }
  }
  private blockStep(plan: Plan, stepId: string, error: PlanAdmissionError): Plan {
    const reason = error.message
    if (!error.permanent && plan.blocked?.[stepId]?.reason === reason) return plan
    const updated = this.mutate(`plan-block:${plan.id}:${stepId}:${plan.revision}`, { id: plan.id, stepId, reason, permanent: error.permanent }, () => {
      if (error.permanent) {
        const { blocked: _blocked, ...body } = plan
        return { ...body, revision: plan.revision + 1, state: 'partial_failed' as const, failureReason: reason }
      }
      return { ...plan, revision: plan.revision + 1, blocked: { ...plan.blocked, [stepId]: { reason, sinceTick: this.logicalTick() } } }
    })
    this.resources?.onBlocked?.(plan.id, plan.actorId, stepId, reason, error.permanent)
    return updated
  }
  /** submit MUST be idempotent by requestKey. It is the real engine, not a synthetic completion. */
  async advance(submit: (providerId: string, input: Json, requestKey: string) => Promise<{ id: string; state?: string }>,
    operationState: (id: string) => string | undefined = () => undefined,
    operationOutput: (id: string) => Json | undefined = () => undefined) {
    if (this.advancing) return
    this.advancing = true
    try { this.settleReservations(operationState); for (const plan of this.list().filter(v => v.actorId === this.context.actorId && (v.state === 'scheduled' || v.state === 'running'))) {
      let current = plan
      const states = Object.values(current.operations).map(operationState)
      if (states.some(v => v === 'failed' || v === 'cancelled')) {
        const step = current.steps.find(s => ['failed', 'cancelled'].includes(operationState(current.operations[s.id]!) ?? ''))!
        this.blockStep(current, step.id, new PlanAdmissionError(`Accepted operation ${current.operations[step.id]} ${operationState(current.operations[step.id]!)}`, true)); continue
      }
      for (const step of current.steps) {
        if (current.operations[step.id] || step.at > this.logicalTick() || !step.dependsOn.every(id => current.operations[id] && operationState(current.operations[id]!) === 'succeeded') || !this.mayDispatch(current)) continue
        let resolvedInput: Json
        try {
        resolvedInput = mapReferences(step.input, (id, path) => {
          if (!step.dependsOn.includes(id)) throw new PlanAdmissionError('Output reference must name a declared predecessor', true)
          const output = operationOutput(current.operations[id]!)
          if (output === null || output === undefined || typeof output !== 'object' || Array.isArray(output)) throw new PlanAdmissionError('Predecessor has no published output', true)
          const [field, index] = path.split('.')
          const value = output[field!]
          const result = index === undefined ? value : Array.isArray(value) ? value[Number(index)] : undefined
          if (result === undefined || result === null) throw new PlanAdmissionError('Predecessor output field unavailable', true)
          return result
        })
        this.resources?.validateInput?.(step.providerId, resolvedInput)
        } catch (error) {
          if (!(error instanceof PlanAdmissionError)) throw error
          current = this.blockStep(current, step.id, error)
          if (error.permanent) break
          continue
        }
        const reservations = this.reservations()
        const own = reservations.filter(v => v.planId === current.id && v.stepId === step.id)
        const explicit = step.reservationIds.map(id => reservations.find(v => v.id === id))
        if (explicit.some(v => !v || v.actorId !== this.context.actorId || v.planId !== current.id || v.stepId !== step.id)) {
          current = this.blockStep(current, step.id, new PlanAdmissionError('Invalid reservation for plan step', true)); break
        }
        if (own.some(v => v.state === 'expired' || v.state === 'released')) {
          current = this.blockStep(current, step.id, new PlanAdmissionError('Plan step reservation expired or was released', true))
          break
        }
        if (own.some(v => v.start > this.logicalTick())) continue
        const needs = this.resources?.resourcesOf(step.providerId, resolvedInput) ?? []
        if (needs.some(need => !Object.hasOwn(this.capacities, need.resource))) {
          current = this.blockStep(current, step.id, new PlanAdmissionError('Resolved step names an unknown public resource', true)); break
        }
        // Acquire all requirements together or none; never hold one resource while waiting for another.
        const unavailable = needs.find(need => {
          const foreign = reservations.filter(v => v.resource === need.resource && !(v.planId === current.id && v.stepId === step.id) &&
            (v.state === 'active' || v.state === 'committed' && v.start <= this.logicalTick() && this.logicalTick() < v.end)).reduce((n, v) => n + v.quantity, 0)
          return foreign + need.quantity > this.capacities[need.resource]! || (this.resources?.occupied?.(need.resource) ?? 0) + need.quantity > this.capacities[need.resource]!
        })
        if (unavailable) { current = this.blockStep(current, step.id, new PlanAdmissionError(`Resource unavailable: ${unavailable.resource}`)); continue }
        this.dispatching.add(current.id)
        let operation: { id: string; state?: string }
        try { operation = await submit(step.providerId, resolvedInput, `${this.namespace}:${current.id}:${step.id}`) }
        catch (error) {
          if (!(error instanceof PlanAdmissionError)) throw error
          current = this.blockStep(current, step.id, error)
          if (error.permanent) break
          continue
        } finally { this.dispatching.delete(current.id) }
        // A cancellation may land while physical admission is awaited. Preserve it and
        // record the accepted work without refunding or restarting subsequent steps.
        const prior = this.list().find(v => v.id === current.id)!
        current = this.mutate(`plan-step:${current.id}:${step.id}`, { id: current.id, step: step.id }, () => {
          const { blocked: oldBlocks, ...body } = prior, blocked = { ...oldBlocks }
          delete blocked[step.id]
          return { ...body, ...(Object.keys(blocked).length ? { blocked } : {}),
            revision: prior.revision + 1, state: prior.state === 'cancelled' ? 'cancelled' as const : 'running' as const, operations: { ...prior.operations, [step.id]: operation.id } }
        })
        for (const reservation of own) this.mutate(`reservation-active:${reservation.id}`, { id: reservation.id, operationId: operation.id }, () => ({ ...reservation, revision: reservation.revision + 1, state: 'active', operationId: operation.id }))
        if (current.state === 'cancelled') break
      }
      if (current.state !== 'cancelled' && current.steps.every(step => current.operations[step.id] && operationState(current.operations[step.id]!) === 'succeeded')) {
        const prior = current
        this.mutate(`plan-done:${current.id}`, { id: current.id }, () => ({ ...prior, revision: prior.revision + 1, state: 'succeeded' }))
      }
    } } finally { this.advancing = false }
  }
}
