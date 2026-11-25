/** Deterministic external-model scripts through the real Loader and native continuable Agent tree. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { textResponse, toolCallResponse } from './test-host.ts'
import { boot, Gate, lead, signal, execute, type Probe } from './organization-fixture.ts'
import { createOrganization, organizationSchema, type OrganizationConfig } from './organization.ts'
import { parseScienceResultPayload } from '../science/exchange.ts'
import * as OrganizationPlugin from './host-plugin.ts'
import { installOrganizationTools } from './host-plugin.ts'
import { openOrganizationFacts } from './organization-membership.ts'
const worlds: Probe[] = []
const directories: string[] = []
afterEach(async () => {
  for (const p of worlds.splice(0)) await p.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 5 })
})
const tools = [
  'org_create',
  'org_discover',
  'org_authorize',
  'org_revoke',
  'org_send_result',
  'send_message',
  'list_agents',
  'wait_agent',
  'org_finish',
  'science_measure',
  'science_read',
]
const role = (creates: Record<string, number> = {}) => ({
  instructions: 'Deterministic organization fixture',
  model: { provider: 'teams-probe', model: 'script' },
  tools,
  creates,
  maxInstances: 10,
})
function config(shape: 'fork' | 'chain'): OrganizationConfig {
  return {
    project: 'cross-branch-project',
    rootRole: 'coordinator',
    maxParticipants: 12,
    maxDepth: 3,
    roles:
      shape === 'fork'
        ? { coordinator: role({ supervisor: 3 }), supervisor: role({ worker: 2 }), worker: role() }
        : {
            coordinator: role({ relay: 1 }),
            relay: role({ supervisor: 1 }),
            supervisor: role({ worker: 1 }),
            worker: role(),
          },
    relations: [{ fromRole: 'worker', toRole: 'worker' }],
  }
}
async function setup(shape: 'fork' | 'chain') {
  const p = await boot(`organization-${shape}`)
  worlds.push(p)
  const org = await createOrganization(p.ctx, config(shape))
  installOrganizationTools(p.ctx, org)
  const root = await lead(p, 'root')
  await org.registerRoot(root.agent, 'Configured test organization')
  return { p, org, root }
}
async function held(w: Awaited<ReturnType<typeof setup>>, parent: Agent, role: string, label: string) {
  const gate = new Gate()
  w.p.model.queue(label, gate.step())
  const created = await w.org.create(parent, role, `ACTOR ${label}`, signal())
  await vi.waitFor(() => expect(w.p.model.requests.some((r) => r.actor === label)).toBe(true))
  return { agent: w.p.ctx.agents.get(created.participant.id)!, gate, created }
}
for (const shape of ['fork', 'chain'] as const)
  it(`${shape} config creates real parents dynamically, waits on native inbox, and drains without changing organization code`, async () => {
    const w = await setup(shape)
    let owner = w.root.agent
    const parents: Agent[] = []
    for (const [index, r] of (shape === 'fork' ? ['supervisor'] : ['relay', 'supervisor']).entries()) {
      const node = await held(w, owner, r, `parent-${index}`)
      parents.push(node.agent)
      owner = node.agent
    }
    const worker = await held(w, owner, 'worker', 'worker')
    expect(worker.agent.session.header.parentSession).toBe(owner.id)
    expect(w.org.discover(worker.agent).map((p) => p.id)).toContain(owner.id)
    const waiting = execute(w.p, 'wait_agent', { timeout_ms: 10000 }, worker.agent)
    const sent = await execute(w.p, 'send_message', { agent: worker.agent.id, message: 'Wake from native message' }, owner)
    expect(sent.isError).toBe(false)
    expect(await waiting).toMatchObject({ isError: false, value: { timedOut: false } })
    const discovered = await execute(w.p, 'list_agents', {}, worker.agent)
    expect(discovered).toMatchObject({ isError: false, value: expect.arrayContaining([
      expect.objectContaining({ name: `agent-1${shape === 'fork' ? '' : '/agent-1'}/agent-1`, description: 'worker', status: 'running' }),
    ]) })
    const log = worker.agent.session.snapshotEvents()
    expect(
      log.some(
        (e) =>
          e.type === 'agent/inbox/spliced' &&
          e.data.inserted.some((m) =>
            m.content.some((b) => b.type === 'text' && b.text === 'Wake from native message'),
          ),
      ),
    ).toBe(true)
    await expect(w.org.create(worker.agent, 'supervisor', 'forbidden', signal())).rejects.toThrow('denied')
    await w.org.close(w.root.agent)
    expect(parents.every((p) => w.p.ctx.agents.get(p.id) === undefined)).toBe(true)
    expect(w.p.ctx.agents.get(worker.agent.id)).toBeUndefined()
    w.p.report.status = 'passed'
    w.p.report.participants = w.org.snapshotParticipants()
  })
it('model tool calls create a configured role at runtime with configured model and tool visibility', async () => {
  const w = await setup('fork')
  const gate = new Gate()
  w.p.model.queue('child-from-tool', gate.step())
  w.p.model.queue(
    'lead',
    toolCallResponse('dynamic', 'org_create', { role: 'supervisor', task: 'ACTOR child-from-tool' }),
    textResponse('Delegated'),
  )
  w.root.agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: 'Create the permitted participant now.' }],
      source: { kind: 'user' },
    }),
  )
  await vi.waitFor(() => expect(w.p.model.requests.some((r) => r.actor === 'child-from-tool')).toBe(true))
  const child = w.org.discover(w.root.agent).find((p) => p.role === 'supervisor')!
  expect(w.p.ctx.agents.get(child.id)?.session.header.parentSession).toBe(w.root.agent.id)
  expect(w.p.ctx.agents.get(child.id)?.options).toMatchObject({ provider: 'teams-probe', model: 'script' })
  expect(
    w.root.agent.session
      .snapshotEvents()
      .some(
        (e) =>
          e.type === 'tool/result' &&
          e.data.message.toolCallId === 'dynamic' && !e.data.message.isError,
      ),
  ).toBe(true)
  await w.org.close(w.root.agent)
  w.p.report.status = 'passed'
})
it('multiple explicit pairs retain provenance, scoped revoke, old-instance and project rejection', async () => {
  const w = await setup('fork')
  const parents = await Promise.all(
    [0, 1, 2].map((i) => held(w, w.root.agent, 'supervisor', `supervisor-${i}`)),
  )
  const workers = await Promise.all(parents.map((p, i) => held(w, p.agent, 'worker', `worker-${i}`)))
  const [a, b, c] = workers.map((x) => x.agent) as [Agent, Agent, Agent]
  const measured = await execute(w.p, 'science_measure', { samples: [1, 2, 3] }, a)
  expect(measured.isError).toBe(false)
  const resultId = (measured.value as { id: string }).id
  await expect(w.org.send(a, b.id, { kind: 'reference', resultId }, signal())).rejects.toMatchObject({
    code: 'SCIENCE_NO_GRANT',
  })
  for (const index of [1, 2]) {
    await w.org.authorize(parents[0]!.agent, a.id, workers[index]!.agent.id, signal())
    await w.org.authorize(parents[index]!.agent, workers[index]!.agent.id, a.id, signal())
  }
  const accepted = await w.org.send(a, b.id, { kind: 'reference', resultId }, signal())
  expect(
    b.session
      .snapshotEvents()
      .some(
        (e) =>
          e.type === 'agent/inbox/spliced' &&
          e.data.inserted.some(
            (m) =>
              m.id === accepted &&
              m.content.some((block) => block.type === 'text' && parseScienceResultPayload(block.text)?.senderSessionId === a.id),
          ),
      ),
  ).toBe(true)
  await w.org.revoke(parents[0]!.agent, a.id, b.id)
  await expect(w.org.send(a, b.id, { kind: 'reference', resultId }, signal())).rejects.toMatchObject({
    code: 'SCIENCE_TARGET_DENIED',
  })
  expect(await w.org.send(a, c.id, { kind: 'reference', resultId }, signal())).toBeTruthy()
  await expect(
    w.org.send({ ...a } as Agent, c.id, { kind: 'reference', resultId }, signal()),
  ).rejects.toThrow('Exact live')
  await expect(
    w.org.send(a, SessionId('unrelated-project'), { kind: 'reference', resultId }, signal()),
  ).rejects.toThrow('denied')
  await expect(
    w.org.send(a, c.id, { kind: 'reference', resultId: 'foreign-result' }, signal()),
  ).rejects.toMatchObject({ code: 'SCIENCE_RESULT_UNAVAILABLE' })
  await w.p.ctx.subagents.drainDescendants([parents[2]!.agent])
  // Releasing one participant goes through its exact activation handle; worker children
  // stay published until their own disposal.
  await parents[2]!.created.activation.dispose()
  expect(w.p.ctx.agents.get(parents[2]!.agent.id)).toBeUndefined()
  await expect(w.org.send(a, c.id, { kind: 'reference', resultId }, signal())).rejects.toMatchObject({
    code: 'SCIENCE_NO_GRANT',
  })
  await w.org.close(w.root.agent)
  w.p.report.status = 'passed'
  w.p.report.participants = w.org.snapshotParticipants()
})
it('configuration and unconfigured capability calls fail closed', async () => {
  expect(() => organizationSchema.parse({ ...config('fork'), rootRole: 'absent' })).toThrow('Unknown role')
  const w = await setup('fork')
  expect(() => w.org.assertActor(w.root.agent, 'shell')).toThrow('cannot use')
  const foreign = await lead(w.p, 'foreign')
  expect(() => w.org.discover(foreign.agent)).toThrow('Exact live')
  await expect(createOrganization(w.p.ctx, { ...config('fork'), project: 'foreign' })).rejects.toThrow('matching project')
  await w.org.close(w.root.agent)
  w.p.report.status = 'passed'
})
it('unloading organization drains participants and revokes inner-parent consent without stopping unrelated host state', async () => {
  const p = await boot('organization-unload')
  worlds.push(p)
  let org: Awaited<ReturnType<typeof createOrganization>> | undefined
  const scope = p.ctx.plugin({
    name: 'unloadable-organization',
    inject: ['agents', 'subagents', 'tools', 'systemPrompt'],
    async apply(ctx) {
      org = await createOrganization(ctx, config('fork'))
      installOrganizationTools(ctx, org)
    },
  })
  await scope
  const root = await lead(p, 'unload-root')
  await org!.registerRoot(root.agent, 'Unload fixture')
  const w = { p, org: org!, root }
  const pa = await held(w, root.agent, 'supervisor', 'parent-a'),
    pb = await held(w, root.agent, 'supervisor', 'parent-b')
  const a = await held(w, pa.agent, 'worker', 'child-a'),
    b = await held(w, pb.agent, 'worker', 'child-b')
  await org!.authorize(pa.agent, a.agent.id, b.agent.id, signal())
  await org!.authorize(pb.agent, b.agent.id, a.agent.id, signal())
  const invalidTimeout = await execute(p, 'wait_agent', { timeout_ms: 10 }, a.agent)
  expect(invalidTimeout).toMatchObject({ isError: true, error: { info: { code: 'WAIT_INVALID_TIMEOUT' } } })
  const staleWait = await execute(p, 'wait_agent', { timeout_ms: 10000 }, Object.create(a.agent))
  expect(staleWait.isError).toBe(true)
  expect(a.agent.status).toBe('running')
  await scope.dispose()
  expect(p.ctx.agents.get(root.agent.id)).toBe(root.agent)
  expect([pa, pb, a, b].every((v) => p.ctx.agents.get(v.agent.id) === undefined)).toBe(true)
  await expect(
    p.ctx.get('scienceExchange')!.exchange.send(
      a.agent,
      b.agent.id,
      { kind: 'reference', resultId: 'any' },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'SCIENCE_NO_GRANT' })
  expect(() => org!.assertActor(root.agent)).toThrow('Exact live')
  p.report.status = 'passed'
})

it.each(['total', 'role', 'creator'] as const)('standalone Loader restart retains the %s quota from disk and ignores native role labels', async (quota) => {
  const directory = await mkdtemp(join(tmpdir(), 'ai4science-organization-restart-'))
  directories.push(directory)
  const policy = config('fork')
  if (quota === 'total') policy.maxParticipants = 2
  if (quota === 'role') policy.roles.supervisor!.maxInstances = 1
  if (quota === 'creator') policy.roles.coordinator!.creates.supervisor = 1
  const load = async (label: string) => {
    const p = await boot(label, true, async () => ({
      modules: { organization: OrganizationPlugin },
      configs: {
        jsonl: { root: join(directory, 'sessions'), compression: 'none' },
        'storage-json': { root: join(directory, 'facts') },
        organization: { ...policy, task: 'Restart quota fixture' },
      },
    }))
    worlds.push(p)
    return p
  }
  const first = await load(`quota-${quota}-before`)
  const root = await lead(first, `quota-root-${quota}`)
  first.model.queue('recorded-child', new Gate().step())
  const created = await execute(first, 'org_create', { role: 'supervisor', task: 'ACTOR recorded-child' }, root.agent)
  if (created.isError) throw new Error(created.error.message)
  const saved = (created.value as { participant: { id: string } }).participant
  await first.close()
  worlds.splice(worlds.indexOf(first), 1)

  const second = await load(`quota-${quota}-after`)
  const resumed = await second.ctx.agents.resume({ resumeSessionId: root.agent.id })
  expect(resumed.agent).not.toBe(root.agent)
  const denied = await execute(second, 'org_create', { role: 'supervisor', task: 'ACTOR excess-child' }, resumed.agent)
  expect(denied.isError && denied.error.message).toContain('Participant limit')
  expect(await execute(second, 'org_discover', {}, root.agent)).toMatchObject({ isError: true })
  second.model.queue('recorded-child', new Gate().step())
  await second.ctx.subagents.sendMessage(resumed.agent, SessionId(saved.id), [{ type: 'text', text: 'Continue recorded work.' }], { signal: signal() })
  const child = second.ctx.agents.get(SessionId(saved.id))!
  expect(await execute(second, 'org_discover', {}, child)).toMatchObject({ isError: false })
  expect(child.options).toMatchObject(policy.roles.supervisor!.model!)

  second.model.queue('unrecorded-child', new Gate().step())
  const outsider = await second.ctx.subagents.startActivation({ provider: 'spawn', parent: resumed.agent,
    childId: SessionId(`unrecorded-${quota}`), label: 'supervisor', delivery: 'parent',
    prompt: [{ type: 'text', text: 'ACTOR unrecorded-child' }], maxDepth: 3, signal: signal() })
  const outsiderAgent = second.ctx.agents.get(outsider.childId)!
  expect(await execute(second, 'org_discover', {}, outsiderAgent)).toMatchObject({ isError: true })
  await second.close()
  worlds.splice(worlds.indexOf(second), 1)

  if (quota === 'total') {
    const third = await load('quota-new-root')
    const fresh = await lead(third, 'different-organization-root')
    third.model.queue('fresh-child', new Gate().step())
    expect(await execute(third, 'org_create', { role: 'supervisor', task: 'ACTOR fresh-child' }, fresh.agent))
      .toMatchObject({ isError: false })
  }
})

it('reload recovers members without a checkpoint, requires fresh root enrollment and rejects forged roles', async () => {
  const p = await boot('membership-reload')
  worlds.push(p)
  let org!: Awaited<ReturnType<typeof createOrganization>>
  const mount = async () => {
    const scope = p.ctx.plugin({ name: 'reloadable-membership', inject: OrganizationPlugin.inject,
      async apply(ctx: Context) {
        org = await createOrganization(ctx, config('fork'))
        installOrganizationTools(ctx, org)
      } })
    await scope
    return scope
  }
  const first = await mount()
  const root = await lead(p, 'reload-root')
  await org!.registerRoot(root.agent, 'Reload fixture')
  p.model.queue('resumable-parent', new Gate().step())
  const created = await org!.create(root.agent, 'supervisor', 'ACTOR resumable-parent', signal())
  await first.dispose()
  await root.dispose()
  const second = await mount()
  const fresh = await p.ctx.agents.resume({ resumeSessionId: root.agent.id })
  expect(() => org!.assertActor(fresh.agent)).toThrow('Exact live')
  await org!.registerRoot(fresh.agent, 'Fresh enrollment')
  expect(() => org!.assertActor(root.agent)).toThrow('Exact live')
  await expect(org!.resumeChild(fresh.agent, { ...created.participant, role: 'worker' }, 'forged', signal()))
    .rejects.toThrow('durable membership')
  await expect(org!.resumeChild(fresh.agent, { ...created.participant, id: SessionId('checkpoint-only') }, 'forged', signal()))
    .rejects.toThrow('durable membership')
  p.model.queue('resumable-parent', new Gate().step())
  const resumed = await org!.resumeChild(fresh.agent, created.participant.id, 'Continue recorded work.', signal())
  expect(resumed.participant).toEqual(created.participant)
  expect(org!.assertActor(p.ctx.agents.get(created.participant.id)!)).toEqual(created.participant)
  await second.dispose()
})

it('pending durable reservations serialize admission, native failure frees capacity, and accepted audit failure keeps it charged', async () => {
  const p = await boot('membership-failures')
  worlds.push(p)
  const policy = config('fork')
  policy.maxParticipants = 2
  const facts = await openOrganizationFacts(p.ctx, policy.project)
  const reserved = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let block = false
  let failCreated = false
  let org!: Awaited<ReturnType<typeof createOrganization>>
  const mount = async () => {
    const scope = p.ctx.plugin({ name: 'audit-failure-organization', inject: OrganizationPlugin.inject,
      async apply(ctx: Context) {
        org = await createOrganization(ctx, policy, {
          readFacts: facts.readFacts,
          async record(kind, data) {
            if (kind === 'participant-reserved' && block) { reserved.resolve(); await release.promise }
            if (kind === 'participant-created' && 'parentId' in data && failCreated) throw new Error('Audit disk unavailable')
            await facts.record(kind, data)
          },
        })
        installOrganizationTools(ctx, org)
      },
    })
    await scope
    return scope
  }
  const first = await mount()
  p.ctx.effect(() => async () => { await org!.dispose(); await facts.close() }, 'test.organization-facts')
  const root = await lead(p, 'failure-root')
  await org.registerRoot(root.agent, 'Failure fixture')
  const canceled = new AbortController()
  canceled.abort(new Error('Native creation canceled'))
  await expect(org.create(root.agent, 'supervisor', 'Canceled before acceptance', canceled.signal)).rejects.toThrow()
  expect(org.snapshotParticipants()).toHaveLength(1)

  block = true
  failCreated = true
  p.model.queue('accepted-child', new Gate().step())
  const creating = org.create(root.agent, 'supervisor', 'ACTOR accepted-child', signal())
  const rejected = expect(creating).rejects.toThrow('Audit disk unavailable')
  await reserved.promise
  await expect(org.create(root.agent, 'supervisor', 'Over capacity while persisting', signal())).rejects.toThrow('Participant limit')
  release.resolve()
  await rejected
  const child = org.snapshotParticipants().find(value => value.parentId === root.agent.id)!
  expect(p.ctx.agents.get(child.id)).toBeDefined()
  await expect(org.create(root.agent, 'supervisor', 'Over capacity after acceptance', signal())).rejects.toThrow('Participant limit')
  expect(facts.readFacts().filter(fact => fact.kind === 'participant-create-failed')).toHaveLength(1)
  expect(facts.readFacts().some(fact => fact.kind === 'participant-reserved' &&
    (fact.data as { id: string }).id === child.id)).toBe(true)
  await first.dispose()
  await root.dispose()
  block = false
  failCreated = false
  const second = await mount()
  const fresh = await p.ctx.agents.resume({ resumeSessionId: root.agent.id })
  await org!.registerRoot(fresh.agent, 'Recover accepted child from reservation and native catalog')
  expect(org!.snapshotParticipants()).toHaveLength(2)
  await expect(org!.create(fresh.agent, 'supervisor', 'Over capacity after reload', signal())).rejects.toThrow('Participant limit')
  p.model.queue('accepted-child', new Gate().step())
  expect((await org!.resumeChild(fresh.agent, child.id, 'Continue accepted work.', signal())).participant).toEqual(child)
  await second.dispose()
})

it('native inbox wait reports timeout and cancellation without changing execution or waiting in real time', async () => {
  const w = await setup('fork')
  const child = await held(w, w.root.agent, 'supervisor', 'waiting-child')
  const start = async (signal: AbortSignal) => {
    const entered = Promise.withResolvers<void>()
    const off = w.p.ctx.on('tools/execute', (exec, next) => {
      const result = next()
      if (exec.name === 'wait_agent' && exec.agent === child.agent) entered.resolve()
      return result
    })
    const result = w.p.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('native-wait'), name: 'wait_agent', arguments: '{"timeout_ms":10000}' }],
      signal, agent: child.agent,
    })
    await entered.promise
    off()
    return { result }
  }
  const cancel = new AbortController()
  const canceled = await start(cancel.signal)
  cancel.abort(new Error('Wait canceled'))
  expect((await canceled.result).results[0]!.result.isError).toBe(true)
  expect(child.agent.status).toBe('running')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const timed = await start(signal())
    await vi.advanceTimersByTimeAsync(10000)
    expect((await timed.result).results[0]!.result).toMatchObject({ isError: false, value: { timedOut: true } })
  } finally { vi.useRealTimers() }
  await w.org.close(w.root.agent)
})
