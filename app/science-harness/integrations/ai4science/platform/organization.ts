/** Configured membership and consent policy; Harness owns Agent execution, lineage and inboxes. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ScienceResultExchange, ScienceResultMessage, ScienceResultReader } from '../science/exchange.ts'
import { openOrganizationFacts, readMembership, type OrganizationFacts } from './organization-membership.ts'
import { assertRoleBinding, bindRolePreset, readRoleBindings, resolveRoles, roleSchema,
  type ResolvedRole, type RoleBinding } from './organization-roles.ts'
/** Configuration validates at the file/plugin boundary; no scientific role names are built in. */
export const organizationSchema = z
  .object({
    project: z.string().min(1),
    rootRole: z.string().min(1),
    maxParticipants: z.number().int().positive(),
    maxDepth: z.number().int().nonnegative(),
    roles: z.record(z.string(), roleSchema),
    relations: z.array(z.object({ fromRole: z.string(), toRole: z.string() }).strict()),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const role of [
      value.rootRole,
      ...Object.values(value.roles).flatMap((r) => Object.keys(r.creates)),
      ...value.relations.flatMap((r) => [r.fromRole, r.toRole]),
    ]) {
      if (!value.roles[role]) ctx.addIssue({ code: 'custom', message: `Unknown role ${role}` })
    }
  })
export type OrganizationConfig = z.infer<typeof organizationSchema>
/** Historical associations count against quotas but require current native instances to act. */
export interface Participant {
  id: SessionId
  project: string
  role: string
  parentId?: SessionId
  depth: number
  task: string
}
/** Supply both fact hooks to use an existing journal; omission opens the host storage-domain store. */
export type OrganizationHooks = { resultReader?: ScienceResultReader } &
  (OrganizationFacts | { record?: never; readFacts?: never })

/** Policy over recorded membership, native creation, exact live callers and result relay. */
export class Organization {
  readonly config: OrganizationConfig
  private readonly exchange: ScienceResultExchange
  private readonly participants = new Map<SessionId, Participant>()
  private readonly roots = new Set<Agent>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly configured = new WeakSet<Agent>()
  private roles = new Map<string, ResolvedRole>()
  private bindings = new Map<SessionId, RoleBinding>()
  private closed = false
  private disposal?: Promise<void>
  constructor(
    private readonly ctx: Context,
    config: OrganizationConfig,
    private readonly facts: OrganizationFacts,
    resultReader?: ScienceResultReader,
    closeFacts?: () => Promise<void>,
  ) {
    this.config = organizationSchema.parse(config)
    const exchange = ctx.get('scienceExchange')?.exchange
    if (!exchange || exchange.project !== config.project || !('maxPairs' in exchange) ||
      typeof exchange.assertLiveParticipant !== 'function')
      throw new Error('AI4Science compatible host extension (ai4science-science) with matching project must be explicitly enabled')
    if (!ctx.get('sessionQuery')) throw new Error('Organization requires the sessionQuery service')
    this.exchange = exchange
    if (resultReader) ctx.effect(() => exchange.bindResults(config.project, resultReader), 'ai4science.result-store')
    ctx.on('agent/created', async ({ agent }) => {
      const p = this.participants.get(agent.id)
      if (p) {
        this.assertActor(agent)
        await this.configure(agent, p)
      }
    })
    ctx.effect(() => async () => {
      try { await this.dispose() }
      finally { await closeFacts?.() }
    }, 'ai4science.organization')
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }
  /** Close admission once and drain all started work before its persistence owner may close. */
  dispose(): Promise<void> {
    this.closed = true
    return this.disposal ??= this.drain()
  }
  private async drain(): Promise<void> {
    await Promise.allSettled([...this.pending])
    for (const p of this.participants.values()) {
      const live = this.ctx.agents.get(p.id)
      if (live) this.exchange.parentDisposed(live)
    }
    await this.ctx.subagents.drainDescendants([...this.roots].filter(root => this.ctx.agents.get(root.id) === root))
  }
  /** Enroll an exact live root afresh, then recover only its recorded native tree; IDs confer no authority.
   * Preset enrollment runs after Host Loader activation, before accepting organization work.
   */
  registerRoot(agent: Agent, task: string): Promise<Participant> {
    return this.track(this.enrollRoot(agent, task))
  }
  private async enrollRoot(agent: Agent, task: string): Promise<Participant> {
    if (this.closed || this.roots.size > 0 || this.pending.size > 0 ||
      this.ctx.agents.get(agent.id) !== agent || agent.session.header.parentSession)
      throw new Error('Root enrollment requires a fresh exact live root')
    try {
      this.roles = await resolveRoles(this.ctx, this.config.roles)
      const facts = this.facts.readFacts()
      const members = readMembership(facts, this.config.project)
      this.bindings = readRoleBindings(facts, this.config.project)
      const oldRoot = members.get(agent.id)?.participant
      if (oldRoot && (oldRoot.role !== this.config.rootRole || oldRoot.parentId || oldRoot.depth !== 0))
        throw new Error('Recorded root conflicts with organization policy')
      const root: Participant = { id: agent.id, project: this.config.project, role: this.config.rootRole, depth: 0, task }
      const catalog = new Map((await this.ctx.subagents.listDescendants(agent.id)).map(row => [row.id, row]))
      this.participants.set(root.id, root)
      const ordered = [...members.values()].sort((a, b) => a.participant.depth - b.participant.depth)
      for (const { participant: p, failed } of ordered) {
        if (!p.parentId || !this.participants.has(p.parentId)) continue
        const native = catalog.get(p.id)
        if (failed && !native) continue
        const parent = this.participants.get(p.parentId)!
        if (!this.config.roles[p.role] || p.depth !== parent.depth + 1)
          throw new Error('Recorded membership conflicts with organization policy')
        if (native) {
          if (native.kind !== 'child' || native.mode !== 'continuable' || native.parentId !== p.parentId || native.depth !== p.depth)
            throw new Error('Recorded participant differs from native lineage')
          using observed = await this.ctx.sessionQuery.observeSession(p.id, { projectionMode: 'none' })
          if (observed.header.parentSession !== p.parentId) throw new Error('Participant lineage changed')
        }
        assertRoleBinding(this.bindings.get(p.id), p.role, this.roles.get(p.role)!)
        // An unresolved reservation remains charged even if a crash preceded native publication.
        this.participants.set(p.id, p)
      }
      const rootRole = this.roles.get(root.role)!
      assertRoleBinding(this.bindings.get(root.id), root.role, rootRole)
      await bindRolePreset(this.ctx, agent, rootRole, true)
      await this.facts.record('participant-created', root)
      this.roots.add(agent)
      this.assertActor(agent)
      await this.configure(agent, root)
      this.assertActor(agent)
      return root
    } catch (error) {
      this.participants.clear()
      this.roots.delete(agent)
      throw error
    }
  }
  private async configure(agent: Agent, p: Participant) {
    if (this.configured.has(agent)) return
    const role = this.roles.get(p.role)!
    assertRoleBinding(this.bindings.get(p.id), p.role, role)
    await bindRolePreset(this.ctx, agent, role, this.roots.has(agent))
    this.assertActor(agent)
    if (role.preset !== undefined) {
      const binding: RoleBinding = { id: p.id, project: p.project, role: p.role, preset: role.preset, tools: [...role.tools] }
      await this.facts.record('participant-preset', binding)
      this.bindings.set(p.id, binding)
      this.assertActor(agent)
    }
    Object.assign(agent.options, role.model)
    // Native restrictions intersect with Host safety policy. Preset/local tools also need the CALL guard below.
    const restriction = role.preset === undefined ? { allow: role.tools } : {
      deny: this.ctx.tools.schemas().map(tool => tool.name).filter(name => !role.tools.includes(name)),
    }
    this.ctx.effect(() => agent.ctx.tools.restrict(restriction), 'ai4science.role-tools')
    this.ctx.effect(() => agent.ctx.tools.guard(exec => {
      try {
        if (exec.agent !== agent) throw new Error('Exact live project participant required')
        this.assertActor(agent, exec.name)
        return undefined
      } catch (error) { return error instanceof Error ? error.message : String(error) }
    }), 'ai4science.role-guard')
    this.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: 'ai4science:role', order: 1,
      text: () => `${role.instructions}\nProject: ${p.project}\nRole: ${p.role}\nTask: ${p.task}`,
    }), 'ai4science.role-prompt')
    this.configured.add(agent)
  }
  /** Reject stale objects, expired roots, changed native ancestry and capabilities absent from role configuration. */
  assertActor(agent: Agent, tool?: string): Participant {
    const p = this.participants.get(agent.id)
    if (this.closed || !p || this.ctx.agents.get(agent.id) !== agent)
      throw new Error('Exact live project participant required')
    this.exchange.assertLiveParticipant(agent)
    let ancestor = p
    for (;;) {
      const live = this.ctx.agents.get(ancestor.id)
      if (live) {
        this.exchange.assertLiveParticipant(live)
        if (live.session.header.parentSession !== ancestor.parentId) throw new Error('Participant lineage changed')
      }
      if (!ancestor.parentId) break
      const parent = this.participants.get(ancestor.parentId)
      if (!parent) throw new Error('Missing participant ancestry')
      ancestor = parent
    }
    if (![...this.roots].some(root => root.id === ancestor.id && this.ctx.agents.get(root.id) === root))
      throw new Error('Project root instance expired')
    if (tool && !this.roles.get(p.role)!.tools.includes(tool)) throw new Error(`Role cannot use ${tool}`)
    return p
  }
  private assertCapacity(parent: Participant, role: string, excludedId?: SessionId) {
    const spec = this.config.roles[role]
    const limit = this.config.roles[parent.role]!.creates[role]
    if (!spec || !limit || parent.depth >= this.config.maxDepth) throw new Error('Role/delegation depth denied')
    const all = [...this.participants.values()].filter(p => p.id !== excludedId)
    if (all.length >= this.config.maxParticipants || all.filter(p => p.role === role).length >= spec.maxInstances ||
      all.filter(p => p.parentId === parent.id && p.role === role).length >= limit)
      throw new Error('Participant limit reached')
  }
  /** Reserve quotas before awaiting durability or native creation; a later audit failure retains accepted children. */
  create(parent: Agent, role: string, task: string, signal: AbortSignal): Promise<{ participant: Participant; messageId: MessageId; activation: SubagentActivation }> {
    return this.track(this.createChild(parent, role, task, signal))
  }
  private async createChild(parent: Agent, role: string, task: string, signal: AbortSignal) {
    const owner = this.assertActor(parent, 'org_create')
    this.assertCapacity(owner, role)
    const spec = this.roles.get(role)!
    const p: Participant = { id: SessionId(randomUUID()), project: this.config.project, role,
      parentId: parent.id, depth: owner.depth + 1, task }
    this.participants.set(p.id, p)
    try { await this.facts.record('participant-reserved', p) }
    catch (error) { this.closed = true; throw error }
    let accepted: SubagentActivation & { readonly messageId: MessageId }
    try {
      this.assertActor(parent, 'org_create')
      accepted = await this.ctx.subagents.startActivation({
        provider: 'spawn', childId: p.id, label: role, delivery: 'parent', parent,
        prompt: [{ type: 'text', text: task }],
        agentOptions: spec.model,
        ...(spec.preset === undefined ? {} : { agentPreset: spec.preset }),
        maxDepth: this.config.maxDepth, signal,
      })
    } catch (error) {
      await this.facts.record('participant-create-failed', { ...p, error: String(error) })
      this.participants.delete(p.id)
      throw error
    }
    try { await this.facts.record('participant-created', p) }
    catch (error) {
      throw new Error(`Native child ${p.id} was accepted; participant-created audit failed: ${String(error)}`, { cause: error })
    }
    return { participant: p, messageId: accepted.messageId, activation: accepted }
  }

  /** Resume a recorded member by ID; a legacy checkpoint must agree with the durable record.
   * @param parent Fresh live direct parent in this organization.
   * @param saved Recorded member ID or a compatible historical checkpoint.
   * @param notice Recorded recovery input without task strategy changes.
   * @param signal Restoration cancellation.
   * @returns Current participant and accepted native message identity.
   */
  resumeChild(parent: Agent, saved: Participant | SessionId, notice: string, signal: AbortSignal): Promise<{ participant: Participant; messageId: MessageId }> {
    return this.track(this.resumeMember(parent, saved, notice, signal))
  }
  private async resumeMember(parent: Agent, saved: Participant | SessionId, notice: string, signal: AbortSignal) {
    const owner = this.assertActor(parent, 'org_create')
    const id = typeof saved === 'string' ? saved : saved.id
    const participant = this.participants.get(id)
    if (!participant || participant.parentId !== parent.id || participant.depth !== owner.depth + 1 ||
      participant.depth > this.config.maxDepth || !this.config.roles[owner.role]!.creates[participant.role] ||
      this.ctx.agents.get(id) || (typeof saved !== 'string' &&
        (saved.role !== participant.role || saved.project !== participant.project || saved.parentId !== participant.parentId ||
          saved.depth !== participant.depth || saved.task !== participant.task)))
      throw new Error('Checkpoint member conflicts with current organization policy or durable membership')
    this.assertCapacity(owner, participant.role, participant.id)
    using observed = await this.ctx.sessionQuery.observeSession(id, { projectionMode: 'none', signal })
    if (observed.header.parentSession !== parent.id) throw new Error('Participant lineage changed')
    const messageId = await this.ctx.subagents.sendMessage(parent, id, [{ type: 'text', text: notice }], { signal })
    const live = this.ctx.agents.get(id)
    if (!live) throw new Error('Native checkpoint member did not become live')
    this.assertActor(live)
    await this.facts.record('participant-resumed', participant)
    return { participant, messageId }
  }
  private related(a: Participant, b: Participant): boolean {
    return (
      a.id !== b.id &&
      a.parentId !== b.parentId &&
      this.config.relations.some(
        (r) =>
          (r.fromRole === a.role && r.toRole === b.role) || (r.toRole === a.role && r.fromRole === b.role),
      )
    )
  }
  /** Discovery is bounded to self, direct relatives, and configured collaboration candidates. Discovery grants no consent. */
  discover(actor: Agent) {
    const p = this.assertActor(actor, 'org_discover')
    const children = [...this.participants.values()].filter((q) => q.parentId === p.id)
    return [...this.participants.values()]
      .filter(
        (q) =>
          q.id === p.id ||
          q.id === p.parentId ||
          q.parentId === p.id ||
          this.related(p, q) ||
          children.some((child) => this.related(child, q)),
      )
      .map((q) => ({ ...q, status: this.ctx.agents.get(q.id)?.status ?? 'inactive' }))
  }
  /** Cached inventory recovered from durable facts; historical membership grants no live authority. */
  snapshotParticipants(): Participant[] {
    return [...this.participants.values()].map((value) => ({ ...value }))
  }
  /** Each exact real parent independently consents to one configured child/peer relationship. */
  async authorize(parent: Agent, childId: SessionId, peerChildId: SessionId, signal: AbortSignal) {
    this.assertActor(parent, 'org_authorize')
    const child = this.participants.get(childId), peer = this.participants.get(peerChildId)
    if (!child || !peer || child.parentId !== parent.id || !this.related(child, peer) || !peer.parentId)
      throw new Error('Collaboration target denied')
    const peerParent = this.ctx.agents.get(peer.parentId)
    if (!peerParent) throw new Error('Peer parent is inactive')
    this.assertActor(peerParent)
    await this.exchange.authorize(parent, { childId, peerChildId, peerParent }, signal)
    await this.facts.record('consent', { parentId: parent.id, childId, peerChildId })
  }
  /** Revoke both consents before future acceptance; accepted native inbox messages are not recalled. */
  async revoke(parent: Agent, childId: SessionId, peerChildId: SessionId) {
    this.assertActor(parent, 'org_authorize')
    this.exchange.revoke(parent, childId, peerChildId)
    await this.facts.record('consent-revoked', { parentId: parent.id, childId, peerChildId })
  }
  /** Return an acceptance ID; a correlated reply acknowledges application processing. */
  async send(actor: Agent, target: SessionId, message: ScienceResultMessage, signal: AbortSignal) {
    const p = this.assertActor(actor, 'org_send_result'), peer = this.participants.get(target)
    if (!peer || !this.related(p, peer)) throw new Error('Collaboration target denied')
    return this.exchange.send(actor, target, message, signal)
  }
  /** Stop admission and drain native descendants without canceling Provider equipment. */
  async close(root: Agent): Promise<void> {
    this.assertActor(root, 'org_finish')
    if (!this.roots.has(root)) throw new Error('Only current project root can finish')
    await this.dispose()
    await this.facts.record('organization-closed', { rootId: root.id })
  }
}
/** Open explicit durable fact access and create policy inside the existing host, without a scheduler.
 * @param ctx Host services and owning plugin lifetime.
 * @param config Organization role and consent policy.
 * @param hooks Both journal hooks, or neither to use host storage-domain; optional result reader.
 * @returns Policy ready for fresh live root enrollment.
 */
export async function createOrganization(ctx: Context, config: OrganizationConfig, hooks: OrganizationHooks = {}) {
  if (hooks.record !== undefined)
    return new Organization(ctx, config, hooks, hooks.resultReader)
  const facts = await openOrganizationFacts(ctx, config.project)
  try { return new Organization(ctx, config, facts, hooks.resultReader, facts.close) }
  catch (error) { await facts.close(); throw error }
}
