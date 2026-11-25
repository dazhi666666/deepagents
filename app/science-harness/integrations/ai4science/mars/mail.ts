/** Durable Mars work mail, native delivery and an optional board-file projection. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Organization, Participant } from '../../../../science-harness/integrations/ai4science/platform/organization.ts'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { canonicalJson, type OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { MarsRecords } from './records.ts'
import { TIER_ONE } from './base.ts'
import { ALERT_ROUTES, guidanceFor, type TeamRole } from './team.ts'
import type { LaboratoryWorld } from '../greenhouse/laboratory/world.ts'
import type {} from '../greenhouse/collaboration.ts'

const envelopeSchema = z.object({ id: z.string(), requestKey: z.string(), senderId: z.string(), senderRole: z.string(),
  targetId: z.string(), targetRole: z.string(), content: z.string(), taskId: z.string().nullable(), tick: z.number() })

/** Runtime relays work messages without requiring a coordinator model to repeat them. */
export class MarsMail {
  private readonly boardPath: string
  /** Operations whose completion is reported by their procedure rather than one by one. */
  internalOperation: (operationId: string) => boolean = () => false
  constructor(private readonly ctx: Context, private readonly engine: ExecutionEngine, private readonly org: Organization,
    private readonly admin: OperationContext, directory: string, private readonly tick: () => number, private readonly single = false, private readonly legacyGuidance = true) {
    this.boardPath = join(directory, 'router', 'mars-run', 'board.json')
    this.project()
  }
  private messages() {
    return this.engine.readFacts(this.admin).filter(fact => fact.kind === 'mars-mail-created').map(fact => envelopeSchema.parse(fact.data))
  }
  /** Read accepted and consumed work-mail state for the authenticated project viewer. */
  snapshot() {
    const facts = this.engine.readFacts(this.admin)
    const accepted = new Set(facts.filter(fact => fact.kind === 'mars-mail-delivered').map(fact => z.object({ id: z.string() }).parse(fact.data).id))
    const read = new Set(facts.filter(fact => fact.kind === 'mars-mail-read').map(fact => z.object({ id: z.string() }).parse(fact.data).id))
    return this.messages().map(message => ({ ...message, accepted: accepted.has(message.id), read: read.has(message.id) }))
  }
  /** Rebuild the display board from authoritative task and message facts. */
  project() {
    const facts = this.engine.readFacts(this.admin)
    const reads = new Set(facts.filter(fact => fact.kind === 'mars-mail-read').map(fact => z.object({ id: z.string() }).parse(fact.data).id))
    const tasks = new MarsRecords(this.engine, this.admin).listTasks().map(task => ({ id: task.id, title: task.title, spec: task.description,
      assignee: task.assignee ?? '', blocked_by: task.dependencies, isolated: false,
      status: task.state === 'completed' ? 'done' : task.state === 'running' ? 'in_progress' : ['failed', 'cancelled'].includes(task.state) ? 'failed' : 'pending',
      result: task.reason, artifacts: task.resultRefs, created_by: task.createdBy, created_at: '', updated_at: '' }))
    const messages = this.messages().map(message => ({ id: message.id,
      from: message.senderRole, to: message.targetRole, task_id: message.taskId, content: message.content, read: reads.has(message.id), ts: `tick:${message.tick}` }))
    mkdirSync(dirname(this.boardPath), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.boardPath}.tmp`, JSON.stringify({ tasks, messages }), { mode: 0o600 })
    renameSync(`${this.boardPath}.tmp`, this.boardPath)
  }
  /** Test whether accepted work mail awaits an explicit mailbox receipt. */
  hasUnread(actorId: string) {
    const facts = this.engine.readFacts(this.admin)
    const read = new Set(facts.filter(fact => fact.kind === 'mars-mail-read').map(fact => z.object({ id: z.string() }).parse(fact.data).id))
    return this.messages().some(message => message.targetId === actorId && !read.has(message.id))
  }
  /** Read one actual participant's work mail and persist explicit consumption. */
  inbox(actor: Agent) {
    this.org.assertActor(actor, 'mars_inbox')
    this.project()
    const messages = this.snapshot().filter(message => message.targetId === actor.id && !message.read).map(message => ({
      id: message.id, from: message.senderRole, to: message.targetRole, task_id: message.taskId,
      content: message.content, read: false, ts: `tick:${message.tick}`,
    }))
    for (const message of messages) this.engine.recordFact(this.admin, 'mars-mail-read', { id: message.id, actorId: actor.id, tick: this.tick() })
    this.project()
    return messages
  }
  private async ensureLive(participant: Participant, signal: AbortSignal): Promise<Agent> {
    const live = this.ctx.agents.get(participant.id)
    if (live) { this.org.assertActor(live); return live }
    const parentInfo = this.org.snapshotParticipants().find(value => value.id === participant.parentId)
    if (!parentInfo) throw new Error('Recipient native parent unavailable')
    const parent = await this.ensureLive(parentInfo, signal)
    await this.org.resumeChild(parent, participant, '应用工作消息到达，正在恢复原有角色会话。', signal)
    return this.ctx.agents.get(participant.id)!
  }
  /** Deliver committed observations to responsible roles, including cold continuations. */
  async notifyEnvironment(events: ReturnType<LaboratoryWorld['events']>, waiting: ReadonlySet<string>, signal: AbortSignal) {
    const grouped = new Map<string, typeof events>()
    const participants = this.org.snapshotParticipants()
    for (const event of events) {
      // v0.4 alerts go to the fixed team's lead and supporting roles (team.ts); the single agent receives them all.
      let roles: string[] = ALERT_ROUTES[event.kind] ?? []
      if (event.kind === 'power-shed' && !z.object({ shed: z.array(z.string()) }).safeParse(event.payload).data?.shed.some(id => TIER_ONE.includes(id))) roles = []
      if (['operation-finished', 'system-operation-settled'].includes(event.kind)) {
        const operation = z.object({ id: z.string() }).parse(event.payload)
        if (this.internalOperation(operation.id)) continue
        const owner = this.engine.get(this.admin, operation.id).actorId
        const participant = participants.find(value => value.id === owner)
        if (participant) roles = [participant.role]
      }
      const targets = new Set(roles.map(role => participants.find(value => value.role === role) ?? participants.find(value => value.role === 'brain')).filter(value => value !== undefined))
      for (const target of targets) {
        if (waiting.has(target.id)) continue
        grouped.set(target.id, [...grouped.get(target.id) ?? [], event])
      }
    }
    for (const [targetId, selected] of grouped) {
      const target = participants.find(value => value.id === targetId)!
      const guidance = this.guidance(target.role, selected.map(event => event.kind))
      const content = JSON.stringify({ kind: 'mars-environment-notice', events: selected, ...(guidance.length ? { guidance } : {}) })
      let nativeMessageId: string
      if (target.parentId) {
        const parent = await this.ensureLive(participants.find(value => value.id === target.parentId)!, signal)
        nativeMessageId = this.ctx.agents.get(target.id) ? await this.ctx.subagents.sendMessage(parent, target.id, [{ type: 'text', text: content }], { signal }) :
          (await this.org.resumeChild(parent, target, content, signal)).messageId
      } else {
        const root = await this.ensureLive(target, signal)
        const message = createUserMessage({ source: { kind: 'greenhouse-coordination', form: 'notice', summary: 'Mars environment observations' }, content: [{ type: 'text', text: content }] })
        root.steer(message); nativeMessageId = message.id
      }
      this.engine.recordFact(this.admin, 'mars-environment-notified', { targetId, eventSeqs: selected.map(event => event.seq), nativeMessageId, tick: this.tick() })
    }
  }
  /** Checklist lines for the alerts one member receives; the single agent holds every role's lines. */
  guidance(role: string, kinds: string[]) { if (!this.legacyGuidance) return []; return guidanceFor(this.single ? 'single' : role as TeamRole, kinds) }

  /** Runtime notice (a duty window opening) as work mail from the host: mars_wait and mars_inbox see it like any message,
   * and delivery wakes an idle member. Idempotent per request key.
   */
  async system(targetRole: string, requestKey: string, content: string, signal: AbortSignal) {
    const participants = this.org.snapshotParticipants()
    const target = participants.find(value => value.role === targetRole) ?? participants.find(value => value.role === 'brain')
    if (!target) return
    let message = this.messages().find(value => value.senderId === 'mars-host' && value.requestKey === requestKey)
    if (!message) {
      message = { id: randomUUID(), requestKey, senderId: 'mars-host', senderRole: 'runtime', targetId: target.id, targetRole: target.role, content, taskId: null, tick: this.tick() }
      this.engine.recordFact(this.admin, 'mars-mail-created', message)
    }
    if (this.engine.readFacts(this.admin).some(fact => fact.kind === 'mars-mail-delivered' && z.object({ id: z.string() }).parse(fact.data).id === message!.id)) return
    const text = JSON.stringify({ kind: 'mars-work-mail', ...message })
    let nativeMessageId: string
    if (target.parentId) {
      const parent = await this.ensureLive(participants.find(value => value.id === target.parentId)!, signal)
      nativeMessageId = this.ctx.agents.get(target.id) ? await this.ctx.subagents.sendMessage(parent, target.id, [{ type: 'text', text }], { signal }) :
        (await this.org.resumeChild(parent, target, text, signal)).messageId
    } else {
      const root = await this.ensureLive(target, signal)
      const input = createUserMessage({ source: { kind: 'greenhouse-coordination', form: 'notice', summary: 'Mars duty window' }, content: [{ type: 'text', text }] })
      root.steer(input); nativeMessageId = input.id
    }
    this.engine.recordFact(this.admin, 'mars-mail-delivered', { id: message.id, nativeMessageId, tick: this.tick() })
    this.project()
  }

  /** Send idempotent project work through the recipient's real native lineage. */
  async send(actor: Agent, context: OperationContext, requestKey: string, targetRole: string, content: string, taskId: string | null, signal: AbortSignal) {
    const sender = this.org.assertActor(actor, 'mars_message')
    z.string().min(1).parse(requestKey); z.string().min(1).parse(content)
    const targets = this.org.snapshotParticipants().filter(value => value.role === targetRole)
    if (targets.length !== 1) throw new Error('Target role must name exactly one registered project member')
    const target = targets[0]!
    if (taskId && !new MarsRecords(this.engine, context).listTasks().some(task => task.id === taskId)) throw new Error('Unknown task reference')
    let message = this.messages().find(value => value.senderId === actor.id && value.requestKey === requestKey)
    if (message && canonicalJson({ targetId: message.targetId, content: message.content, taskId: message.taskId }) !== canonicalJson({ targetId: target.id, content, taskId })) throw new Error('Message request key changed')
    if (!message) {
      message = { id: randomUUID(), requestKey, senderId: actor.id, senderRole: sender.role, targetId: target.id,
        targetRole, content, taskId, tick: this.tick() }
      this.engine.recordFact(context, 'mars-mail-created', message)
    }
    const delivered = this.engine.readFacts(this.admin).find(fact => fact.kind === 'mars-mail-delivered' && z.object({ id: z.string() }).parse(fact.data).id === message!.id)
    if (delivered) return { id: message.id, accepted: true }
    const text = JSON.stringify({ kind: 'mars-work-mail', ...message })
    let nativeMessageId: string
    if (target.parentId) {
      const parentInfo = this.org.snapshotParticipants().find(value => value.id === target.parentId)!
      const parent = await this.ensureLive(parentInfo, signal)
      const existing = this.ctx.agents.get(target.id)
      nativeMessageId = existing ? await this.ctx.subagents.sendMessage(parent, target.id, [{ type: 'text', text }], { signal }) :
        (await this.org.resumeChild(parent, target, text, signal)).messageId
    } else {
      const root = await this.ensureLive(target, signal)
      const input = createUserMessage({ source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId(message.senderId) }, content: [{ type: 'text', text }] })
      root.steer(input); nativeMessageId = input.id
    }
    this.engine.recordFact(context, 'mars-mail-delivered', { id: message.id, nativeMessageId, tick: this.tick() })
    this.project()
    return { id: message.id, accepted: true, nativeMessageId }
  }
}
