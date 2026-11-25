/** Opt-in role templates exercised through real Loader trees, native spawn and persisted sessions. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import RoleDefaults from './preset-defaults.ts'
import { boot, execute, Gate, lead, signal, type Probe } from './organization-fixture.ts'
import { createOrganization, organizationSchema, type OrganizationConfig } from './organization.ts'
import { installOrganizationTools } from './host-plugin.ts'
import { createJsonToolRegistrar } from './tool.ts'
import type { HostCustomization } from './test-host.ts'

const worlds: Probe[] = []
const directories: string[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5 })
})
const nativeTools = ['org_create', 'org_discover', 'org_finish', 'send_message', 'list_agents', 'wait_agent']
const legacy = (creates: Record<string, number> = {}) => ({
  instructions: 'Legacy explicit role', model: { provider: 'teams-probe', model: 'script' },
  tools: nativeTools, creates, maxInstances: 4,
})
const preset = (id = 'ai4science-midbrain', overrides: Partial<OrganizationConfig['roles'][string]> = {}) => ({
  preset: id, creates: {}, maxInstances: 4, ...overrides,
})
function policy(root = legacy({ worker: 3 }), worker: OrganizationConfig['roles'][string] = legacy()): OrganizationConfig {
  return { project: 'cross-branch-project', rootRole: 'lead', maxParticipants: 6, maxDepth: 2,
    roles: { lead: root, worker }, relations: [] }
}
const nativeContributions = {
  inject: ['tools', 'systemPrompt'],
  apply(ctx: Context) {
    const register = createJsonToolRegistrar(ctx, () => undefined)
    for (const name of ['preset_allowed', 'preset_hidden']) register(name, name, {}, () => ({ called: name }))
    ctx.systemPrompt.section({ name: 'custom:preset', order: 0, text: 'Custom native preset prompt' })
  },
}
async function world(label: string, options: { registry?: boolean; templates?: boolean; directory?: string; extra?: HostCustomization } = {}) {
  const result = await boot(label, true, async () => ({
    modules: { ...(options.registry === false ? {} : { 'preset-registry': AgentPresets }), ...options.extra?.modules },
    configs: { 'preset-registry': { default: 'ai4science-cerebrum' },
      ...(options.directory ? { jsonl: { root: join(options.directory, 'sessions'), compression: 'none' },
        'storage-json': { root: join(options.directory, 'facts') } } : {}), ...options.extra?.configs },
    resolveModules: { '@deepseek-ai/dsh-agent-preset': AgentPreset, '../preset-defaults.ts': RoleDefaults,
      'role-defaults': RoleDefaults, 'custom-contributions': nativeContributions, ...options.extra?.resolveModules },
    entries: [...(options.templates === false ? [] : ['cerebrum', 'midbrain', 'cerebellum'].map(id => ({
      id: `template-${id}`, name: 'cordis:include', config: { path: new URL(`./presets/${id}.yml`, import.meta.url).href },
    }))), ...options.extra?.entries ?? []],
  }))
  worlds.push(result)
  return result
}
async function declaration(p: Probe, id: string, plugins: Parameters<typeof p.ctx.agentPresets.register>[0]['plugins'] = []) {
  const off = await p.ctx.agentPresets.register({ id, plugins })
  p.ctx.effect(() => off, 'test.preset-declaration')
}
async function enroll(p: Probe, config: OrganizationConfig, name = 'preset-root') {
  const org = await createOrganization(p.ctx, config)
  installOrganizationTools(p.ctx, org)
  const root = await lead(p, name)
  await org.registerRoot(root.agent, 'Preset test organization')
  return { org, root }
}
async function held(p: Probe, org: Awaited<ReturnType<typeof createOrganization>>, parent: Agent, actor = 'preset-child') {
  p.model.queue(actor, new Gate().step())
  const created = await org.create(parent, 'worker', `ACTOR ${actor}`, signal())
  await vi.waitFor(() => expect(p.model.requests.some(request => request.actor === actor)).toBe(true))
  return { created, agent: p.ctx.agents.get(created.participant.id)! }
}

it.each([false, true])('keeps preset-free roles unchanged with registry mounted: %s', async registry => {
  const p = await world('preset-free', { registry, templates: registry })
  const { org, root } = await enroll(p, policy())
  const { agent } = await held(p, org, root.agent)
  expect(agent.options).toMatchObject(legacy().model)
  expect(agent.session.header.agentPreset).toBeUndefined()
  expect(agent.session.snapshotEvents().some(event => event.type === 'agent-preset/selected')).toBe(false)
  expect(p.ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual([...nativeTools].sort())
  expect(() => organizationSchema.parse({ ...policy(), roles: { lead: { creates: {}, maxInstances: 1 } } })).toThrow('without preset')
})

it.each(['cerebrum', 'midbrain', 'cerebellum'])('loads optional %s recommendations in a native isolated realm without prescribing a model or topology', async id => {
  const p = await world(`template-${id}`)
  const config = policy()
  config.roles.lead = preset(`ai4science-${id}`, { creates: { worker: 3 } })
  const { root } = await enroll(p, config)
  const registry = p.ctx.agentPresets
  expect(registry.presetForSession(root.agent.session)).toBe(`ai4science-${id}`)
  expect(registry.composedPreset(root.agent.ctx)).toBe(`ai4science-${id}`)
  expect(root.agent.options).toMatchObject({ provider: 'teams-probe', model: 'script' })
  expect(p.ctx.get('ai4scienceRoleDefaults')).toBeUndefined()
  expect(root.agent.ctx.get('ai4scienceRoleDefaults')).toBeUndefined()
  const defaults = registry.serviceFor(root.agent, 'ai4scienceRoleDefaults')!.defaults
  expect(defaults.model).toBeUndefined()
  expect(defaults.tools).toContain(id === 'cerebellum' ? 'execution_result' : 'experiment_create')
  if (id === 'midbrain') expect(defaults.tools).toContain('execution_submit')
  expect(registry.inspectCompositions(root.agent.ctx)[0]?.leakedServices).toEqual([])
  const prompt = await p.ctx.systemPrompt.assemble(assembleContextFor(root.agent))
  expect(prompt.sections.find(section => section.name === 'ai4science:role')?.text).toContain(defaults.instructions)
  expect(config.maxDepth).toBe(2)
  expect(config.roles.lead.creates).toEqual({ worker: 3 })
})

it('applies explicit instructions, tool widening and model fields over custom preset defaults', async () => {
  const p = await world('override-defaults')
  await declaration(p, 'custom-defaults', [{ name: 'cordis:group', group: true, isolate: { ai4scienceRoleDefaults: true }, config: [
    { name: 'role-defaults', config: { instructions: 'Recommended instructions', tools: ['org_discover'],
      model: { provider: 'teams-probe', model: 'recommended', maxTokens: 41 } } },
  ] }])
  const info = vi.spyOn(p.ctx.logger, 'info')
  const config = policy()
  config.roles.lead = preset('custom-defaults', { instructions: 'Explicit role instructions', tools: nativeTools,
    model: { model: 'explicit-model', maxTokens: 73 }, creates: { worker: 3 } })
  const { org, root } = await enroll(p, config)
  expect(root.agent.options).toMatchObject({ provider: 'teams-probe', model: 'explicit-model', maxTokens: 73 })
  expect(info).toHaveBeenCalledWith(expect.stringContaining('explicit tools override preset'))
  const prompt = await p.ctx.systemPrompt.assemble(assembleContextFor(root.agent))
  const instructions = prompt.sections.find(section => section.name === 'ai4science:role')!.text
  expect(instructions).toContain('Explicit role instructions')
  expect(instructions).not.toContain('Recommended instructions')
  expect(org.assertActor(root.agent, 'org_create').role).toBe('lead')
  root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the explicit role route.' }], source: { kind: 'user' } }))
  await root.agent.whenIdle()
  expect(p.model.requests[0]?.options).toMatchObject({ provider: 'teams-probe', model: 'explicit-model', maxTokens: 73 })
})

it('treats an explicit empty tool list as final and denies native preset-local calls', async () => {
  const p = await world('empty-tool-override')
  await declaration(p, 'native-tools', [{ name: 'custom-contributions' }])
  const config = policy()
  config.roles.lead = preset('native-tools', { instructions: '', tools: [] })
  const { org, root } = await enroll(p, config)
  expect(p.ctx.tools.schemas(root.agent).map(tool => tool.name)).toContain('preset_hidden')
  expect(await execute(p, 'preset_hidden', {}, root.agent)).toMatchObject({ isError: true, error: { message: expect.stringContaining('Role cannot use') } })
  expect(() => org.assertActor(root.agent, 'org_discover')).toThrow('Role cannot use')
})

it('supports native custom presets with explicit role fields and guards all local tools with exact live actor checks', async () => {
  const p = await world('custom-local-tools')
  const id = ' custom/native-tools '
  await declaration(p, id, [{ name: 'custom-contributions' }])
  const config = policy()
  config.roles.lead = preset(id, { instructions: 'Custom role', tools: ['preset_allowed', 'agent_local'] })
  const org = await createOrganization(p.ctx, config)
  const root = await p.ctx.agents.create({ sessionId: SessionId('custom-root'), agentOptions: legacy().model,
    setup(ctx) { createJsonToolRegistrar(ctx, () => undefined)('agent_local', 'Local registered tool', {}, () => true) } })
  await org.registerRoot(root.agent, 'Local tool checks')
  expect(p.ctx.agentPresets.presetForSession(root.agent.session)).toBe(id)
  expect(await execute(p, 'preset_allowed', {}, root.agent)).toMatchObject({ isError: false, value: { called: 'preset_allowed' } })
  expect(await execute(p, 'agent_local', {}, root.agent)).toMatchObject({ isError: false, value: true })
  expect(await execute(p, 'preset_hidden', {}, root.agent)).toMatchObject({ isError: true })
  expect(await execute(p, 'agent_local', {}, Object.create(root.agent))).toMatchObject({ isError: true })
  const prompt = await p.ctx.systemPrompt.assemble(assembleContextFor(root.agent))
  expect(prompt.sections.some(section => section.text.includes('Custom native preset prompt'))).toBe(true)
  await org.dispose()
  expect(await execute(p, 'agent_local', {}, root.agent)).toMatchObject({ isError: true })
})

it('explicit role widening preserves inherited Host restrictions and authorization guards', async () => {
  const p = await world('host-restrictions')
  await declaration(p, 'native-tools', [{ name: 'custom-contributions' }])
  const config = policy()
  config.roles.lead = preset('native-tools', { instructions: 'Host restricted', tools: ['science_read', 'preset_allowed'] })
  const org = await createOrganization(p.ctx, config)
  const root = await p.ctx.agents.create({ sessionId: SessionId('restricted-root'), agentOptions: legacy().model,
    setup(ctx) {
      ctx.tools.restrict({ deny: ['science_read'] })
      ctx.tools.guard(exec => exec.name === 'preset_allowed' ? 'Host authorization required' : undefined)
    } })
  await org.registerRoot(root.agent, 'Host policy remains authoritative')
  expect(p.ctx.tools.schemas(root.agent).map(tool => tool.name)).not.toContain('science_read')
  expect(await execute(p, 'science_read', { result_id: 'none' }, root.agent)).toMatchObject({ isError: true })
  expect(await execute(p, 'preset_allowed', {}, root.agent)).toMatchObject({ isError: true, error: { message: 'Host authorization required' } })
})

it.each(['missing-registry', 'unknown', 'broken', 'missing-service', 'missing-defaults', 'leaked-service'] as const)('rejects %s before accepting organization work', async failure => {
  const p = await world(`failure-${failure}`, { registry: failure !== 'missing-registry', templates: failure !== 'missing-registry',
    extra: { resolveModules: { 'needs-service': { inject: ['ai4scienceRoleDefaults'], apply() {} } } } })
  if (failure === 'broken') await declaration(p, 'broken', [{ name: 'unavailable-preset-plugin' }])
  if (failure === 'missing-service') await declaration(p, failure, [{ name: 'needs-service' }])
  if (failure === 'missing-defaults') await declaration(p, 'missing-defaults')
  if (failure === 'leaked-service') await declaration(p, 'leaked-service', [{ name: 'role-defaults', config: { instructions: 'Leaked', tools: [] } }])
  const config = policy()
  config.roles.worker = preset(failure === 'missing-registry' ? 'ai4science-midbrain' : failure)
  const org = await createOrganization(p.ctx, config)
  const root = await lead(p, 'failed-root')
  const reasons = {
    'missing-registry': /explicitly mounted agentPresets/,
    unknown: /Unknown agent preset/,
    broken: /unavailable-preset-plugin/,
    'missing-service': /waiting for ai4scienceRoleDefaults/,
    'missing-defaults': /requires explicit instructions\/tools/,
    'leaked-service': /isolate realms/,
  }
  await expect(org.registerRoot(root.agent, 'Must fail before acceptance')).rejects.toThrow(reasons[failure])
  expect(org.snapshotParticipants()).toEqual([])
  expect(p.model.requests).toEqual([])
  expect(() => org.assertActor(root.agent)).toThrow('Exact live')
})

it('rejects preset enrollment inside a loading Host row instead of waiting for its own activation', async () => {
  let organization: Awaited<ReturnType<typeof createOrganization>> | undefined
  const config = policy()
  config.roles.lead = preset('ai4science-midbrain')
  const p = await world('enrollment-during-load', { extra: { modules: {
    'premature-enrollment': { inject: ['agents', 'subagents', 'sessionQuery', 'scienceExchange', 'storageDomain', 'agentPresets'],
      async apply(ctx: Context) {
        organization = await createOrganization(ctx, config)
        const root = await ctx.agents.create({ sessionId: SessionId('premature-root'), agentOptions: legacy().model })
        await organization.registerRoot(root.agent, 'Cannot await Host settlement from this row')
      } },
  } } })
  const entry = [...p.ctx.loader.entries()].find(entry => entry.options.name === 'premature-enrollment')!
  await expect(entry.fiber!.await()).rejects.toThrow('settled Host activation')
  expect(organization?.snapshotParticipants()).toEqual([])
  expect(p.model.requests).toEqual([])
})

it('selects a blank root durably and rejects an incompatible locked root', async () => {
  const p = await world('root-selection')
  const config = policy()
  config.roles.lead = preset('ai4science-midbrain')
  const { root } = await enroll(p, config)
  expect(root.agent.session.header.agentPreset).toBeUndefined()
  expect(root.agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected')).toMatchObject([
    { data: { agentPreset: 'ai4science-midbrain' } },
  ])
  const other = await world('root-locked')
  const locked = await lead(other, 'locked-root')
  locked.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete one turn before enrollment.' }], source: { kind: 'user' } }))
  await locked.agent.whenIdle()
  const org = await createOrganization(other.ctx, config)
  await expect(org.registerRoot(locked.agent, 'Locked root cannot switch')).rejects.toThrow('locked root')
  expect(other.ctx.agentPresets.presetForSession(locked.agent.session)).toBeNull()
})

it('accepts a locked root whose native session and mounted preset already agree', async () => {
  const p = await world('root-preselected')
  const root = await lead(p, 'preselected-root')
  await p.ctx.agentPresets.select(root.agent, 'ai4science-midbrain')
  root.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Complete the first turn.' }], source: { kind: 'user' } }))
  await root.agent.whenIdle()
  const selected = root.agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected').length
  const config = policy()
  config.roles.lead = preset('ai4science-midbrain')
  const org = await createOrganization(p.ctx, config)
  await org.registerRoot(root.agent, 'Validate an existing selection')
  expect(root.agent.session.snapshotEvents().filter(event => event.type === 'agent-preset/selected')).toHaveLength(selected)
})

it('preserves selected root/child identities across cold resume, retains quotas, and rejects stale local-tool grants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai4science-preset-resume-'))
  directories.push(directory)
  const config = policy()
  config.maxParticipants = 2
  config.roles.lead = preset('ai4science-cerebrum', { creates: { worker: 1 } })
  config.roles.worker = preset('native-tools', { instructions: 'Native worker', tools: ['preset_allowed', 'wait_agent'] })
  const load = async (label: string, defaultPreset = 'ai4science-cerebrum') => {
    const p = await world(label, { directory, extra: { configs: { 'preset-registry': { default: defaultPreset } } } })
    await declaration(p, 'native-tools', [{ name: 'custom-contributions' }])
    return p
  }
  const first = await load('cold-before')
  const { org, root } = await enroll(first, config, 'cold-root')
  const before = await held(first, org, root.agent)
  expect(before.agent.session.header.agentPreset).toBe('native-tools')
  expect(first.ctx.agentPresets.presetForSession(before.agent.session)).toBe('native-tools')
  expect(await execute(first, 'preset_allowed', {}, before.agent)).toMatchObject({ isError: false })
  await first.close()
  worlds.splice(worlds.indexOf(first), 1)

  const second = await load('cold-after', 'ai4science-midbrain')
  const recovered = await createOrganization(second.ctx, config)
  installOrganizationTools(second.ctx, recovered)
  const resumed = await second.ctx.agents.resume({ resumeSessionId: root.agent.id, agentOptions: legacy().model })
  await recovered.registerRoot(resumed.agent, 'Recover selected root')
  expect(second.ctx.agentPresets.presetForSession(resumed.agent.session)).toBe('ai4science-cerebrum')
  expect(second.ctx.agentPresets.composedPreset(resumed.agent.ctx)).toBe('ai4science-cerebrum')
  second.model.queue('preset-child', new Gate().step())
  await recovered.resumeChild(resumed.agent, before.created.participant.id, 'Continue recorded native preset work.', signal())
  const child = second.ctx.agents.get(before.agent.id)!
  expect(second.ctx.agentPresets.presetForSession(child.session)).toBe('native-tools')
  expect(second.ctx.agentPresets.composedPreset(child.ctx)).toBe('native-tools')
  expect(await execute(second, 'preset_allowed', {}, child)).toMatchObject({ isError: false })
  expect(await execute(second, 'preset_allowed', {}, before.agent)).toMatchObject({ isError: true })
  await expect(recovered.create(resumed.agent, 'worker', 'Excess work', signal())).rejects.toThrow('Participant limit')
})

it('rejects wider recommendations published under the same custom preset id after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai4science-preset-defaults-'))
  directories.push(directory)
  const config = policy()
  config.roles.lead = preset('evolving-defaults')
  const load = async (label: string, tools: string[]) => {
    const p = await world(label, { directory })
    await declaration(p, 'evolving-defaults', [{ name: 'cordis:group', group: true,
      isolate: { ai4scienceRoleDefaults: true }, config: [
        { name: 'role-defaults', config: { instructions: 'Versioned recommendations', tools } },
        { name: 'custom-contributions' },
      ] }])
    return p
  }
  const first = await load('defaults-before', ['preset_allowed'])
  const { root } = await enroll(first, config, 'defaults-root')
  await first.close()
  worlds.splice(worlds.indexOf(first), 1)
  const second = await load('defaults-after', ['preset_allowed', 'preset_hidden'])
  const org = await createOrganization(second.ctx, config)
  const resumed = await second.ctx.agents.resume({ resumeSessionId: root.agent.id, agentOptions: legacy().model })
  await expect(org.registerRoot(resumed.agent, 'Same id cannot expand tools')).rejects.toThrow('cannot widen')
  expect(second.model.requests).toEqual([])
})

it.each(['preset', 'remove', 'tools'] as const)('rejects recovery that changes the recorded %s grant', async change => {
  const directory = await mkdtemp(join(tmpdir(), 'ai4science-preset-ceiling-'))
  directories.push(directory)
  const config = policy()
  config.roles.lead = preset('ai4science-midbrain', { tools: ['org_discover'] })
  const first = await world(`ceiling-${change}-before`, { directory })
  const { root } = await enroll(first, config, `ceiling-root-${change}`)
  await first.close()
  worlds.splice(worlds.indexOf(first), 1)
  const updated = structuredClone(config)
  if (change === 'preset') updated.roles.lead!.preset = 'ai4science-cerebrum'
  if (change === 'remove') updated.roles.lead = legacy()
  if (change === 'tools') updated.roles.lead!.tools = ['org_discover', 'org_create']
  const second = await world(`ceiling-${change}-after`, { directory })
  const org = await createOrganization(second.ctx, updated)
  const resumed = await second.ctx.agents.resume({ resumeSessionId: root.agent.id, agentOptions: legacy().model })
  await expect(org.registerRoot(resumed.agent, 'No authority expansion')).rejects.toThrow(change === 'tools' ? 'cannot widen' : 'preset conflicts')
  expect(org.snapshotParticipants()).toEqual([])
  expect(second.model.requests).toEqual([])
})
