/** Incremental public view of pending native writes, their committed results and responsibility changes. */
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { Json, OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { contentHash, identifier, tickSchema, type StageProfile } from './contracts.ts'

export const deliveryVersion = 'delivery-v2' as const
const followUp = z.object({ task: identifier, next: z.string().trim().min(1).max(320), backup: identifier.optional(), beforeTick: tickSchema.optional() }).strict()
const specification = z.object({ owner: identifier, backup: identifier, task: identifier, next: z.string(), beforeTick: tickSchema, explicit: z.boolean() })
type Spec = z.infer<typeof specification>
const object = (v: Json | undefined) => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const steps: Record<string, string> = {
  analysis_run: 'Read the analysis result and apply it to the experiment.', model_register: 'Test the registered model or correct its registration.',
  pipeline_register: 'Test the registered pipeline.', prediction_commit: 'Use the accepted prediction or commitment in the task submission.',
  action_commit: 'Use the accepted commitment in the task submission.', experiment_plan: 'Check the accepted plan ID and take its next required action.',
  water_assay: 'Check the real assay procedure and coordinate the measurement.', water_split: 'Check the original mother and the storage procedure.',
  research_submit: 'Check the formal slot receipt or correct the rejected submission.', research_draft: 'Review the draft result and confirm the formal slot.'
}
const deputies: Record<string, string> = { brain: 'verifier', verifier: 'brain', service: 'engineer', engineer: 'agronomist', water: 'service', crops: 'agronomist', analyst: 'verifier', agronomist: 'engineer' }
export function deliverySpec(tool: string, args: Record<string, unknown>, role: string, roster: readonly string[], profile: StageProfile,
  commissions: readonly {id:string;deadline:number}[] = []): Spec | undefined {
  if (!Object.hasOwn(steps, tool)) return undefined
  const custom = followUp.optional().parse(args.follow_up)
  let input: Record<string, unknown> = {}
  if (typeof args.input_json === 'string') {
    try { const v: unknown = JSON.parse(args.input_json); input = z.record(z.string(), z.unknown()).safeParse(v).data ?? {} } catch { /* Invalid tool JSON still receives its error receipt. */ }
  }
  const defaultBackup = deputies[role]
  const backup = custom?.backup ?? (defaultBackup && roster.includes(defaultBackup) ? defaultBackup : roster[0])
  if (!backup || !roster.includes(backup)) throw new Error('follow_up.backup must be a participant in this world')
  const slotCutoff = (input.slotId ?? args.slot_id) === 'baseline' ? profile.baselineTick : profile.finalTick
  const service = z.object({commissionId:z.string()}).safeParse(input.service)
  const commission = commissions.find(c => c.id === (service.success ? service.data.commissionId : input.commissionId) || c.id === custom?.task)
  const task = custom?.task ?? String(commission?.id ?? input.taskId ?? args.task_id ?? role).slice(0,160)
  return {
    owner: role, backup, task, next: custom?.next ?? steps[tool]!,
    beforeTick: Math.min(custom?.beforeTick ?? slotCutoff, slotCutoff, commission?.deadline ?? slotCutoff), explicit: custom !== undefined
  }
}
export const followsReceipts = (tool: string) => Object.hasOwn(steps, tool)
const rowSchema = z.object({ seq: tickSchema, type: z.string(), data_json: z.string() })
const factSchema = z.object({ kind: z.string(), logicalTick: tickSchema.optional(), data: z.json() })
const coordinate = (actorId: string, round: number, callId: string) => JSON.stringify([actorId, round, callId])
const refs = z.array(z.object({ id: identifier, revision: tickSchema }))
const changeSchema = z.object({ id: identifier, revision: tickSchema, newOwner: identifier, state: z.enum(['pending', 'ready', 'done', 'paused']), next: z.string(), key: identifier, fingerprint: identifier, actor: identifier })
type Item = Spec & { id: string; actorId: string; author: string; args: Json; round: number; callId: string; tool: string; revision: number; state: 'pending' | 'ready' | 'read' | 'done' | 'paused'; result?: Json; receivedTick?: number; notified: number }
type Change = { seq: number; tick: number; kind: string; id: string; detail: string }
const header = (w: Item) => ({
  id: w.id, revision: w.revision, owner: w.owner, backup: w.backup, task: w.task, next: w.next, beforeTick: w.beforeTick,
  state: w.state, tool: w.tool, round: w.round, callId: w.callId, receivedTick: w.receivedTick ?? null
})
export class DeliveryLedger {
  private cursor = 0
  private readonly items = new Map<string, Item>()
  private readonly byCall = new Map<string, Item>()
  private readonly changes: Change[] = []
  private readonly actions = new Map<string, z.infer<typeof changeSchema>>()
  private readonly cancellations = new Set<string>()
  constructor(private readonly engine: Pick<ExecutionEngine, 'events' | 'eventCursor' | 'recordFact'>, private readonly context: OperationContext, private readonly now: () => number) { }
  private sync() {
    if (this.engine.eventCursor(this.context) === this.cursor) return
    for (const raw of this.engine.events(this.context, this.cursor)) {
      const row = rowSchema.parse(raw)
      if (row.type === 'fact') {
        const f = factSchema.parse(JSON.parse(row.data_json))
        this.fold(row.seq, f.logicalTick ?? 0, f.kind, object(f.data))
      }
      this.cursor = row.seq
    }
  }
  private fold(seq: number, tick: number, kind: string, d: Record<string, Json>) {
    const add = (k: string, id: string, detail: string) => this.changes.push({ seq, tick, kind: k, id, detail: detail.slice(0, 300) })
    if (kind === 'mars-v06-round' && typeof d.key === 'string' && d.key.startsWith('intent:')) {
      const intent = object(d.value), input = object(intent.input)
      if (!input.delivery) return
      const spec = specification.parse(input.delivery), round = Number(d.key.split(':')[1]), actorId = String(intent.actorId), callId = String(input.callId)
      const w: Item = { ...spec, id: `work-${seq}`, round, actorId, author:spec.owner, args:input.args ?? {}, callId, tool: String(input.tool), state: 'pending', revision: 1, notified: 0 }
      this.items.set(w.id, w); this.byCall.set(coordinate(actorId, round, callId), w)
      add('pending', w.id, `${w.owner} ${w.tool} ${w.task}`)
    } else if (kind === 'mars-v06-native-receipt') {
      const w = this.byCall.get(coordinate(String(d.actorId), Number(d.round), String(d.callId)))
      if (!w || d.result === undefined) return
      w.result = d.result; w.receivedTick = tick
      if (w.state === 'pending') w.state = 'ready'
      const result = object(d.result), value = object(result.value ?? d.result)
      add('receipt', w.id, `${w.owner} ${w.tool} ${String(result.error ?? value.error ?? value.runId ?? value.id ?? value.state ?? 'committed')}`)
    } else if (kind === 'mars-v06-work-cancelled') {
      const role = identifier.parse(d.role)
      if (typeof d.cancellationId === 'string') this.cancellations.add(coordinate(role,0,d.cancellationId))
      const items = refs.parse(d.items)
      for (const ref of items) {
        const item = this.items.get(ref.id)
        if (!item || item.revision !== ref.revision || item.owner !== role) throw new Error('Cancellation does not match its recorded work owner')
        item.revision++
        item.owner = item.backup
        if (item.owner === role) item.state = 'paused'
      }
      if (items.length) add('handoff',role,items.map(r=>r.id).join(', '))
    } else if (kind === 'mars-v06-work-change') {
      const a = changeSchema.parse(d), w = this.items.get(a.id)
      if (!w || w.revision + 1 !== a.revision) throw new Error('Receipt-work history has an invalid revision')
      if (w.owner !== a.newOwner) w.explicit = true
      Object.assign(w, { owner: a.newOwner, state: a.state, next: a.next, revision: a.revision })
      this.actions.set(JSON.stringify([a.actor, a.key]), a)
      add('work', w.id, `${w.owner} ${w.state} ${w.next}`)
    } else if (kind === 'mars-v06-work-read' || kind === 'mars-v06-work-notified' || (kind === 'mars-mail' && object(d.handoffRequest).receiptItems)) {
      for (const ref of refs.parse(kind === 'mars-mail' ? object(d.handoffRequest).receiptItems : d.items)) {
        const w = this.items.get(ref.id)
        if (!w || w.revision !== ref.revision) continue
        if (kind !== 'mars-v06-work-read') w.notified = ref.revision
        else if (!w.explicit && w.state === 'ready') w.state = 'read'
      }
    } else if (kind === 'mars-v06-record' || kind === 'mars-v06-action') {
      const r = object(d.result); add('accepted', String(r.id ?? `${r.taskId}/${r.slotId}`), `${String(d.operation ?? 'action')} revision ${String(r.revision ?? 1)}`)
    } else if (kind === 'mars-v06-rejection' || kind === 'mars-v06-draft') {
      const r = kind === 'mars-v06-draft' ? object(d.result) : d
      add(kind === 'mars-v06-draft' ? 'draft' : 'rejection', `${r.taskId}/${r.slotId}`, String(r.problem ?? `revision ${r.revision}`))
    } else if (kind === 'mars-v06-plan-mutation') {
      const r = object(d.result)
      if (typeof r.id === 'string' && Array.isArray(r.steps)) add('plan', r.id, `${r.state} rev ${r.revision} ${Object.values(object(r.blocked)).map(b => object(b).reason).join(', ')}`)
    } else if (kind === 'mars-v06-research') {
      const r = object(d.record); add('note', String(r.id), `revision ${r.revision}`)
    } else if (kind === 'mars-v06-seal') add('seal', String(d.stage), String(d.tick))
  }
  since(after = 0, limit = 20) {
    this.sync(); tickSchema.parse(after); z.number().int().min(1).max(50).parse(limit)
    if (after > this.cursor) throw new Error('Change cursor is ahead of this world')
    const rows = this.changes.filter(r => r.seq > after), page = rows.slice(0, limit)
    return { items: page, cursor: rows.length > limit ? page.at(-1)!.seq : this.cursor, more: rows.length > limit }
  }
  lookup(actorId:string, round:number, callId:string) {
    this.sync()
    const item=this.byCall.get(coordinate(actorId,round,callId))
    if (!item) throw new Error('Queued scientific work is missing its durable intent')
    return {id:item.id,revision:item.revision,owner:item.owner,backup:item.backup,beforeTick:item.beforeTick}
  }
  list(owner: string, offset = 0) {
    this.sync(); tickSchema.parse(offset)
    const open = [...this.items.values()].filter(w => w.owner === owner && w.state !== 'done' && w.state !== 'read' && this.now() < w.beforeTick)
    return { total: open.length, items: open.slice(offset, offset + 20).map(header) }
  }
  get(id: string, viewer: string, includeInput = false) {
    this.sync(); const w = this.items.get(id)
    if (!w) throw new Error('Unknown receipt work in this world')
    if (includeInput && ![w.author,w.owner,w.backup].includes(viewer)) throw new Error('Read the original input as its author, assigned owner or backup')
    if (w.owner === viewer && !w.explicit && w.state === 'ready') {
      this.readReceipts(viewer, w.actorId, [w]); this.sync()
    }
    return { ...header(w), result: w.result ?? null, ...(includeInput ? {input:w.args} : {}) }
  }
  readReceipts(role: string, actorId: string, rows: { round: number; callId: string }[]) {
    this.sync()
    const items = rows.flatMap(r => { const w = this.byCall.get(coordinate(actorId, r.round, r.callId)); return w?.owner === role && !w.explicit && w.state === 'ready' && this.now() < w.beforeTick ? [{ id: w.id, revision: w.revision }] : [] })
    if (items.length) this.engine.recordFact(this.context, 'mars-v06-work-read', { items })
  }
  change(actor: string, key: string, id: string, revision: number, target: string | null, next: string, joined?: (role:string)=>boolean) {
    this.sync(); identifier.parse(key)
    const fingerprint = contentHash({ id, revision, target, next }), prior = this.actions.get(JSON.stringify([actor, key]))
    if (prior) { if (prior.fingerprint !== fingerprint) throw new Error('Work key reused with different input'); return prior }
    const w = this.items.get(id)
    if (!w || w.revision !== revision || w.owner !== actor || this.now() >= w.beforeTick || w.state === 'done') throw new Error('Read the current open work item and owner before changing it')
    if (target && joined && !joined(target)) throw new Error('Handoff recipient must be joined in this world')
    const state = target ? (w.result === undefined ? 'pending' : 'ready') : 'done'
    const action = changeSchema.parse({ id, revision: revision + 1, newOwner: target ?? actor, state, next: next || w.next, key, fingerprint, actor })
    this.engine.recordFact(this.context, 'mars-v06-work-change', action); return action
  }
  wasCancelled(role: string, cancellationId: string) {
    this.sync()
    return this.cancellations.has(coordinate(role,0,cancellationId))
  }
  cancelOwner(role: string, cancellationId?: string) {
    this.sync()
    if (cancellationId && this.wasCancelled(role,cancellationId)) return
    const items = [...this.items.values()].filter(w => w.owner === role && (w.state === 'pending' || w.state === 'ready') && this.now() < w.beforeTick)
      .map(({id,revision})=>({id,revision}))
    if (items.length || cancellationId) this.engine.recordFact(this.context,'mars-v06-work-cancelled',{role,items,...(cancellationId?{cancellationId}:{})})
  }
  due() {
    this.sync(); const groups = new Map<string, ReturnType<typeof header>[]>()
    for (const w of this.items.values()) if (w.state === 'ready' && w.notified !== w.revision && this.now() < w.beforeTick) {
      const group = groups.get(w.owner) ?? []; group.push(header(w)); groups.set(w.owner, group)
    }
    return groups
  }
  notified(items: { id: string; revision: number }[]) { this.engine.recordFact(this.context, 'mars-v06-work-notified', { items: items.map(({ id, revision }) => ({ id, revision })) }) }
}
