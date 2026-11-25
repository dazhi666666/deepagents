/** Real Cordis Loader composition and owned workspace teardown for AI4Science tests. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Llm, { ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Subagents from '@deepseek-ai/dsh-subagent'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import TeamService from '@deepseek-ai/dsh-agent-team'
import * as TeamTools from '@deepseek-ai/dsh-tool-agent-team'
import * as Science from '../plugin.ts'
import { ScriptedModel, signal, text } from './test-model.ts'

export { Gate, maxTokensResponse, ScriptedModel, SequentialModel, signal, text, textResponse, toolCallResponse } from './test-model.ts'
export type { ScriptStep } from './test-model.ts'

/** Ordered host observations and explicit fixture notes. */
export interface Trace {
  ordinal: number
  stage: string
  sessionId?: string
  seq?: number
  data?: unknown
}

/** A real Loader host and the temporary workspace it owns until close settles. */
export interface Probe {
  ctx: Context
  model: ScriptedModel
  root: string
  trace: Trace[]
  report: Record<string, unknown>
  note(stage: string, data?: unknown): void
  close(): Promise<void>
}

/** Fixture-specific Loader entries and configuration written inside the owned workspace. */
export interface HostCustomization {
  modules?: Record<string, unknown>
  configs?: Record<string, unknown>
  /** Importable by nested Loader compositions without mounting on the Host. */
  resolveModules?: Record<string, unknown>
  entries?: EntryOptions[]
  withoutScience?: boolean
}

/** Differences between the platform, cross-branch and team fixture compositions. */
export interface TestHostOptions {
  label: string
  workspace: 'platform' | 'cross-branch' | 'teams'
  actorMarker?: 'exact' | 'line'
  report: Record<string, unknown>
  modules?: Record<string, unknown>
  configs?: Record<string, unknown>
  omit?: readonly string[]
  customize?: (root: string) => Promise<HostCustomization>
}

/** Load real source plugins, recording host events and retaining persistence until descendants settle.
 * @param options Fixture modules, configuration, report fields and optional workspace customization.
 * @returns An isolated host whose close drains descendants, disposes Cordis, then removes its workspace.
 */
export async function bootHost(options: TestHostOptions): Promise<Probe> {
  const root = await mkdtemp(join(tmpdir(), `ai4science-${options.workspace}-${options.label}-`))
  const ctx = new Context()
  const model = new ScriptedModel(options.actorMarker)
  const trace: Trace[] = []
  const report: Record<string, unknown> = { label: options.label, ...options.report, status: 'incomplete', root }
  const note = (stage: string, data?: unknown) => { trace.push({ ordinal: trace.length, stage, data }) }
  const modules = new Map<string, unknown>([
    ['llm', Llm], ['sessions', Sessions], ['prompt', SystemPrompt], ['tools', Tools], ['tool-executor', NativeExecutor],
    ['agents', Agents], ['projections', Projections], ['jsonl', Jsonl], ['query', SessionQuery],
    ['loop', AgentLoop], ['subagents', Subagents], ['subagent-control', SubagentControl], ['fs-local', LocalFs], ['working-directory', WorkingDirectory], ['spawn', Spawn],
    ['storage', Storage], ['storage-json', StorageJson], ['storage-domain', StorageDomain], ['science', Science],
    ...Object.entries(options.modules ?? {}),
    ['teams', TeamService], ['team-tools', TeamTools],
    ['observation', { name: 'observation', inject: ['llm', 'sessions', 'agents'], apply(observed: Context) {
      observed.llm.registerAdapter(['teams-probe'], model)
      observed.on('session/event', (session, event) => {
        trace.push({ ordinal: trace.length, stage: event.type, sessionId: session.id, seq: event.seq, data: event.data })
      })
      observed.on('agent/status', ({ agent, status }) => {
        trace.push({ ordinal: trace.length, stage: 'agent/status', sessionId: agent.id, data: { status } })
      })
      observed.on('agent/disposed', ({ agent }) => {
        trace.push({ ordinal: trace.length, stage: 'agent/disposed', sessionId: agent.id })
      })
    } }],
  ])
  const configs: Record<string, unknown> = {
    jsonl: { root: join(root, 'sessions'), compression: 'none' },
    query: { path: ':memory:', openAt: 'never' }, loop: { agents: [] },
    spawn: { providerName: 'spawn' }, 'fs-local': { cwd: root }, 'working-directory': { defaultDirectory: root },
    'storage-json': { root: join(root, 'records') }, 'storage-domain': { backend: 'json' },
    science: { project: 'teams-probe-project', provider: 'spawn', maxDepth: 3 },
    teams: { maxMembers: 8, maxTasks: 16, maxPendingMessagesPerMember: 8, maxMessageBytes: 4096, disposalTimeoutMs: 5000 },
    'team-tools': { freshProvider: 'spawn', forkProvider: 'fork' },
    ...options.configs,
  }
  const dispose = async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
  }
  const resolveModules = new Map<string, unknown>()
  const entries: EntryOptions[] = []
  try {
    if (options.customize) {
      const extra = await options.customize(root)
      if (extra.withoutScience) modules.delete('science')
      for (const [key, value] of Object.entries(extra.modules ?? {})) modules.set(key, value)
      Object.assign(configs, extra.configs)
      for (const [key, value] of Object.entries(extra.resolveModules ?? {})) resolveModules.set(key, value)
      entries.push(...extra.entries ?? [])
    }
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify([...modules.keys()]
      .filter(name => !options.omit?.includes(name))
      .map(name => ({ id: name, name, ...(configs[name] ? { config: configs[name] } : {}) }))
      .concat(entries), null, 2))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    const unsupportedHmr = (): never => { throw new Error('The fixture module resolver does not support Node HMR') }
    ctx.loader.internal = {
      version: 'v2',
      async import(name: string) {
        if (resolveModules.has(name)) return resolveModules.get(name)
        if (!modules.has(name)) throw new Error(`unexpected Loader import ${name}`)
        return modules.get(name)
      },
      get loadCache() { return unsupportedHmr() },
      register: unsupportedHmr,
      getOrCreateModuleJob: unsupportedHmr,
      resolveSync: unsupportedHmr,
      load: unsupportedHmr,
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const unloaded = [...ctx.loader.entries()].filter(entry => !entry.disabled && !entry.fiber)
    if (unloaded.length) throw new Error(`unloaded entries: ${unloaded.map(entry => entry.options.name)}`)
  } catch (error) {
    await dispose()
    throw error
  }
  return { ctx, model, root, trace, report, note, async close() {
    try { await ctx.subagents.drainDescendants(ctx.agents.list().filter(agent => agent.session.header.origin !== 'subagent')) }
    finally { await dispose() }
  } }
}

/** Create a root Agent using the scripted external model.
 * @param probe Loaded host.
 * @param name Root session identifier.
 * @returns The native Agent handle.
 */
export async function lead(probe: Probe, name: string) {
  return probe.ctx.agents.create({ sessionId: SessionId(name), agentOptions: { provider: 'teams-probe', model: 'script' } })
}

/** Start a named continuable child through the native spawn provider.
 * @param probe Loaded host.
 * @param owner Parent Agent.
 * @param name Child name.
 * @param actor Script key; defaults to the child name.
 * @returns The child identifier and native activation.
 */
export async function spawn(probe: Probe, owner: Agent, name: string, actor = name) {
  const activation = await probe.ctx.subagents.startActivation({
    provider: 'spawn', name, label: `Probe ${actor}`, delivery: 'parent',
    parent: owner, prompt: text(`ACTOR ${actor}`), signal: signal(),
  })
  return { member: { id: activation.childId }, activation }
}

/** Start a child with an explicit session identifier and delegation depth of three.
 * @param probe Loaded host.
 * @param owner Parent Agent.
 * @param id Child identifier and script key.
 * @returns The native activation.
 */
export function branch(probe: Probe, owner: Agent, id: string) {
  return probe.ctx.subagents.startActivation({
    provider: 'spawn', childId: SessionId(id), label: id, delivery: 'parent',
    parent: owner, prompt: text(`ACTOR ${id}`), maxDepth: 3, signal: signal(),
  })
}

/** Execute one real registered tool.
 * @param probe Loaded host.
 * @param name Tool name.
 * @param args JSON-serializable arguments.
 * @param agent Caller identity; absent exercises a call without an Agent.
 * @returns The native tool result.
 */
export async function execute(probe: Probe, name: string, args: unknown, agent?: Agent) {
  const batch = await probe.ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId(`probe-${name}`), name, arguments: JSON.stringify(args) }],
    signal: signal(), ...(agent ? { agent } : {}),
  })
  return batch.results[0]!.result
}

/** Read a persisted session and release its reader before returning.
 * @param probe Loaded host.
 * @param id Session identifier.
 * @returns The persisted header and events.
 */
export async function stored(probe: Probe, id: SessionId) {
  const handle = await probe.ctx.sessionPersistence.open(id, 'read')
  try { return { header: handle.header, events: (await handle.read()).events } }
  finally { await handle.close() }
}

/** Read rendered tool JSON from the real model history.
 * @param options Recorded model request.
 * @param callId Tool-call identifier.
 * @param detailedErrors Include failed tool content when true; otherwise report a missing successful result.
 * @returns The parsed successful tool value.
 */
export function toolValue(options: GenerateOptions, callId: string, detailedErrors = false): unknown {
  const message = options.messages.findLast(message => message.role === 'tool' && message.toolCallId === callId)
  if (message?.role === 'tool' && message.isError && detailedErrors)
    throw new Error(`tool ${callId} failed: ${JSON.stringify(message.content)}`)
  if (message?.role !== 'tool' || message.isError) throw new Error(`missing successful tool result ${callId}`)
  return JSON.parse(message.content.filter(part => part.type === 'text').map(part => part.text).join(''))
}

/** Find the latest explicitly typed fixture message in the real model history.
 * @param options Recorded model request.
 * @param kind Expected payload kind.
 * @returns The parsed matching payload.
 */
export function payload(options: GenerateOptions, kind: string): Record<string, unknown> {
  for (const block of options.messages.flatMap(message => message.content).toReversed()) {
    if (block.type !== 'text' || !block.text.startsWith('{')) continue
    const value: unknown = JSON.parse(block.text)
    if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === kind) return value as Record<string, unknown>
  }
  throw new Error(`missing message payload ${kind}`)
}
