/** Public receipt ownership and bounded change pages for one scientific world. */
import { z } from 'zod'
import { contentHash, identifier, tickSchema } from './contracts.ts'
import type { DeliveryLedger } from './delivery.ts'
import type { MarsWorld } from '../world.ts'
import type { installResearchTools } from './tools.ts'

type Register = Parameters<typeof installResearchTools>[0]['register']
export const followUpParameter = { type: 'object', additionalProperties: false, properties: { task: { type: 'string', required: true }, next: { type: 'string', required: true }, backup: { type: 'string' }, beforeTick: { type: 'integer' } }, description: 'Optional follow-up for this actual write. Name the task, next action, optional backup role and logical deadline.' } as const
export function receiptMail(owner: string, items: ReturnType<DeliveryLedger['list']>['items']) {
  const members = items.map(({ id, revision }) => ({ id, revision })), key = `work:${contentHash({ owner, members })}`
  const text = items.slice(0, 6).map(w => `${w.id} ${w.task} (${w.tool}) — ${w.next} [<${w.beforeTick}]`).join('\n')
  return { key, text: `[科研回执] ${items.length} 项有真实回执。${text}\n用 receipt_work(action=get,id=...) 读原始结果。`, members }
}
const publicEvents = ['operation-finished', 'system-operation-settled', 'result-created', 'crop-status-changed', 'power-shed', 'battery-low', 'sample-preservation-failed', 'method-revised', 'batch-recalled', 'calibration-results-revoked'] as const
export function installDeliveryTools(register: Register, board: DeliveryLedger, world: Pick<MarsWorld, 'observe' | 'events' | 'eventCursor'>,
  roleOf: (id: string) => string, roster: readonly string[], joined: (role:string)=>boolean) {
  register('receipt_work', 'Inspect or transfer a real pending write and its receipt. Use list (optional role, offset), get (id), handoff (id, revision, to, next, request_key), or done (id, revision, request_key). Only the current owner can change it.', {
    action: { type: 'string', required: true, enum: ['list', 'get', 'handoff', 'done'] }, include_input:{type:'boolean',description:'For get, include the original tool input for the author, owner or nominated backup.'}, id: { type: 'string' }, revision: { type: 'integer' }, role: { type: 'string' }, offset: { type: 'integer' }, to: { type: 'string' }, next: { type: 'string' }, request_key: { type: 'string' }
  }, (args, agent) => {
    const role = roleOf(agent.id)
    if (args.action === 'list') return board.list(z.enum(roster as [string, ...string[]]).parse(args.role ?? role), tickSchema.parse(args.offset ?? 0))
    const id = identifier.parse(args.id)
    if (args.action === 'get') return board.get(id, role, args.include_input === true)
    const action = z.enum(['handoff', 'done']).parse(args.action)
    const to = action === 'handoff' ? z.enum(roster as [string, ...string[]]).parse(args.to) : null
    if (to === role) throw new Error('Handoff requires another participant')
    return board.change(role, identifier.parse(args.request_key), id, tickSchema.parse(args.revision), to, to ? z.string().trim().min(1).max(320).parse(args.next) : '', joined)
  })
  register('research_changes', 'Read public receipt, evidence, slot, plan and physical changes after the two returned cursors. Store cursor and device_cursor separately. Both pages contain at most limit rows. Before a decision use the earlier response to request only changes.', {
    cursor: { type: 'integer' }, device_cursor: { type: 'integer' }, limit: { type: 'integer' }
  }, (args, agent) => {
    roleOf(agent.id)
    const limit = z.number().int().min(1).max(50).parse(args.limit ?? 12), device = tickSchema.parse(args.device_cursor ?? 0)
    const latest = world.eventCursor()
    if (device > latest) throw new Error('Device cursor is ahead of this world')
    const events = world.events(device,{kinds:[...publicEvents],limit:limit+1}), page = events.slice(0, limit)
    const physical = page.map(e => {
      const p = z.record(z.string(), z.json()).parse(e.payload)
      const c = z.record(z.string(), z.json()).safeParse(p.command).data
      return {
        seq: e.seq, tick: e.tick, kind: e.kind, id: p.id ?? null,
        status: p.status ?? p.state ?? null, action: c?.action ?? null, resultId: p.resultId ?? null,
        ...(Array.isArray(p.resultIds) ? { resultIds: p.resultIds } : {}),
        ...(Array.isArray(p.shed) ? { shed: p.shed } : {})
      }
    })
    return { ...board.since(tickSchema.parse(args.cursor ?? 0), limit), tick: world.observe().tick, physical, device_cursor: events.length > limit ? page.at(-1)!.seq : latest, morePhysical: events.length > limit }
  })
}
