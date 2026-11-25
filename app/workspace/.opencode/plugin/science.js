/**
 * DeepWorks science bridge.
 *
 * Each DeepWorks conversation session becomes one AI4Science platform participant. The science
 * platform itself runs in a Node sidecar (the engine process is Bun and cannot load node:sqlite),
 * so this file only forwards tool calls and carries the real session identity with them.
 */
import { tool } from '@opencode-ai/plugin'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSidecar } from '../../../science/sidecar-rpc.mjs'
import { createBusySender, MarsNoticePump } from '../../../science/mars-control.mjs'
import { adaptSessionGet } from '../../../science/opencode-client-compat.mjs'
import { strandedToolEnvelope } from '../../../science/mars-model-format.mjs'
import { assertMarsRoster, marsRoster } from '../../../science/mars-roster.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..', '..')
const configPath = process.env.SCIENCE_CONFIG || join(workspace, 'science.json')
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
const serverPath = resolve(workspace, process.env.SCIENCE_SERVER || config.server || '../science/server.mjs')
const home = resolve(workspace, process.env.SCIENCE_HOME || config.home || '../../data')
const nodeBinary = process.env.SCIENCE_NODE || 'node'
const systemPrompt = config.systemPrompt ?? ''
const delegateConfig = config.delegate ?? {}
const delegateAgents =
  Array.isArray(delegateConfig.agents) && delegateConfig.agents.length > 0 ? delegateConfig.agents : ['midbrain', 'cerebellum']
const delegateTimeoutMs = Number.isInteger(delegateConfig.timeoutMs)
  ? Math.max(5000, Math.min(1800000, delegateConfig.timeoutMs))
  : 300000
/** Sessions started by science_delegate may not delegate again; entries are also the wake registry. */
const delegatedSessions = new Map()
const llmProxyConfig = config.llmProxy ?? {}
const llmProxyEnabled = llmProxyConfig.enabled !== false
const llmProviderId = llmProxyConfig.providerId ?? 'dspark'
const llmProxyPort = Number.isInteger(llmProxyConfig.port) ? llmProxyConfig.port : 18080
const llmProxyIps = Array.isArray(llmProxyConfig.ips) ? llmProxyConfig.ips : []
const llmProxyPath = resolve(workspace, llmProxyConfig.server ?? '../science/llm-proxy.mjs')
const seenProviders = new Set()
const marsConfig = config.mars ?? {}
const marsEnabled = marsConfig.enabled === true
const marsServerPath = resolve(workspace, marsConfig.server ?? '../mars-server.mjs')
const marsMultiHome = resolve(workspace, process.env.SCIENCE_MARS_HOME || marsConfig.home || '../../data/mars-multi')
const marsSingleHome = resolve(workspace, process.env.SCIENCE_MARS_SINGLE_HOME || marsConfig.singleHome || '../../data/mars-single')
const marsDual = marsEnabled && marsConfig.dual === true
const marsMode = marsDual ? 'multi' : (marsConfig.mode ?? 'multi')
const marsTeamSize = marsConfig.teamSize ?? 6
const marsPrimaryRoles = marsRoster(marsMode, marsTeamSize)
const marsLoginRoles = marsDual ? [...marsPrimaryRoles, ...marsRoster('single', marsTeamSize)] : marsPrimaryRoles
if (marsEnabled) {
  if (marsDual && marsMultiHome === marsSingleHome) throw new Error('Mars Multi and Single homes must differ')
  const worlds = [[marsMultiHome, marsMode], ...(marsDual ? [[marsSingleHome, 'single']] : [])]
  for (const [directory, mode] of worlds) {
    const manifestPath = join(directory, 'manifest.public.json')
    if (existsSync(manifestPath)) assertMarsRoster(JSON.parse(readFileSync(manifestPath, 'utf8')), mode, marsRoster(mode, marsTeamSize))
  }
}
const marsBudgetUsd = typeof marsConfig.budgetUsd === 'number' && marsConfig.budgetUsd > 0 ? marsConfig.budgetUsd : null
const marsBudgetTokens = typeof marsConfig.budgetTokens === 'number' && marsConfig.budgetTokens > 0 ? marsConfig.budgetTokens : null
const marsModelBarrier = marsConfig.modelBarrier !== false
const marsAgent = typeof marsConfig.agent === 'string' ? marsConfig.agent : 'mars'
const controlRetryMs = marsConfig.controlRetryMs ?? 250
if (!Number.isSafeInteger(controlRetryMs) || controlRetryMs < 10 || controlRetryMs > 30000) throw new Error('mars.controlRetryMs must be 10..30000')
const controlRetryMaxMs = marsConfig.controlRetryMaxMs ?? Math.max(controlRetryMs, 5000)
if (!Number.isSafeInteger(controlRetryMaxMs) || controlRetryMaxMs < controlRetryMs || controlRetryMaxMs > 30000) throw new Error('mars.controlRetryMaxMs must be >= controlRetryMs and <=30000')
const marsBusyMarks = new Set()
const marsWaiting = new Set()
const marsWakeClaims = new Set()
const marsEngineBusy = new Map()
const lastBusySnapshot = new Map()
const marsBusySenders = new Map()
const marsNoticePumps = new Map()
const marsEngineVersions = new Map()
let marsStatusPrimed = false
let disposed = false

function markMarsBusy(sessionId) {
  if (marsModelBarrier && typeof sessionId === 'string') marsBusyMarks.add(sessionId)
}
function clearMarsBusy(sessionId) { marsBusyMarks.delete(sessionId) }

function noteMarsEngineState(sessionId, state) {
  if (!marsModelBarrier || typeof sessionId !== 'string') return
  const busy = state?.type === 'busy' || state?.type === 'retry'
  marsEngineVersions.set(sessionId, (marsEngineVersions.get(sessionId) ?? 0) + 1)
  const changed = marsEngineBusy.get(sessionId) !== busy || !busy && marsBusyMarks.has(sessionId)
  marsEngineBusy.set(sessionId, busy)
  if (!busy) clearMarsBusy(sessionId)
  const binding = marsBindings.get(sessionId)
  if (changed && binding) return syncMarsBusy(clientForMars, binding.rpc).catch(() => {})
}

/** Events own busy transitions. Only the initial sparse REST snapshot is queried, without overwriting newer events. */
async function primeMarsEngineState(client) {
  const versions = new Map(marsEngineVersions)
  try {
    const response = await client.session.status()
    if (response?.error) throw new Error(JSON.stringify(response.error))
    const states = response?.data ?? response
    if (!states || typeof states !== 'object' || Array.isArray(states)) throw new Error('Session status unavailable')
    for (const id of new Set([...marsBindings.keys(), ...Object.keys(states)])) if ((marsEngineVersions.get(id) ?? 0) === (versions.get(id) ?? 0)) {
      const state = states[id]
      marsEngineBusy.set(id, state?.type === 'busy' || state?.type === 'retry')
    }
  } catch (error) { appendFileSync(join(marsHome, 'mars-plugin.log'), `initial engine status unavailable; keeping acknowledged busy states: ${error.message}\n`) }
}

async function syncMarsBusy(_client, onlyRpc) {
  if (!marsModelBarrier || disposed) return
  const rpcs = onlyRpc ? [onlyRpc] : [...marsBusySenders.keys()]
  await Promise.all(rpcs.map(async rpc => {
    const sessions = [...marsBindings].filter(([id, binding]) => binding.rpc === rpc && (marsEngineBusy.get(id) === true || marsBusyMarks.has(id))).map(([id]) => id)
    try {
      const sender = marsBusySenders.get(rpc)
      if (!sender) throw new Error('Busy sender is not initialized')
      await sender.update(sessions)
    }
    catch (error) {
      appendFileSync(join(marsHome, 'mars-plugin.log'), `busy synchronization [${rpc.mode}] failed; keeping acknowledged state: ${error.message}\n`)
      throw new Error(`Mars control unavailable [${rpc.mode}]: ${error.message}`)
    }
  }))
}
const marsRunStates = new Map()
const marsModelKeys = new Map()
const marsCompactionRetries = new Map()
const marsCompacting = new Set()
const marsGrants = new Map()
const marsResumePending = new Set()
const marsCompactionFinishing = new Map()
const marsDeferredKeys = new Map()
const marsRetryNotices = new Map()
const marsActiveNotices = new Map()
const marsTextCandidates = new Map()
const marsLastAbortIds = new Map()
const MARS_COMPACTION_OUTPUT_LIMIT = 4096
const hash = value => createHash('sha256').update(value).digest('hex')

async function controlCall(rpc, method, params, timeout = 30000) {
  try { return await rpc.call(method, params, timeout, { lane: 'control' }) }
  catch (error) {
    if (/Mars .*cancelled|Mars model admission closed|Model admission.*closed|Use mars_start/.test(error.message)) throw error
    throw new Error(`Mars control unavailable [${rpc.mode}] ${method}: ${error.message}`)
  }
}
function clearMarsRetry(sessionId) {
  marsCompactionRetries.delete(sessionId); marsRetryNotices.delete(sessionId); marsDeferredKeys.delete(sessionId)
}

function isMarsContextOverflow(error) {
  const detail = error?.data?.message ?? error?.message ?? ''
  return error?.name === 'ContextOverflowError'
    || /maximum context length|context[_ ]length[_ ]exceeded|prompt (?:is )?too long/i.test(detail)
}

async function reportFailedMarsCompaction(info) {
  const sessionId = info.sessionID, binding = marsBindings.get(sessionId)
  if (!binding || !info.summary || !isMarsContextOverflow(info.error)) return
  const result = await controlCall(binding.rpc, 'model.aux-failure', { sessionId, messageId: info.id, reason: 'context_overflow' })
  if (result.recorded) {
    marsCompacting.delete(sessionId)
    marsResumePending.delete(sessionId)
    marsModelKeys.delete(sessionId)
    marsGrants.delete(sessionId)
    clearMarsRetry(sessionId)
  }
}

async function finishMarsCompaction(sessionId) {
  if (marsCompactionFinishing.has(sessionId)) return marsCompactionFinishing.get(sessionId)
  if (!marsCompacting.has(sessionId)) return
  const binding = marsBindings.get(sessionId)
  const task = (async () => {
    if (binding) await controlCall(binding.rpc, 'model.aux', { sessionId, active: false })
    marsCompacting.delete(sessionId)
    if (binding) marsResumePending.add(sessionId)
  })()
  marsCompactionFinishing.set(sessionId, task)
  try { await task } finally { if (marsCompactionFinishing.get(sessionId) === task) marsCompactionFinishing.delete(sessionId) }
}

async function enterMarsDecision(input) {
  const sessionId = input?.sessionID
  const binding = marsBindings.get(sessionId)
  if (!binding) return null
  const state = marsRunStates.get(binding.rpc)
  if (!state?.started || state.suspended) return null
  if (state.clock?.failure) throw new Error(`Mars infrastructure failure: ${state.clock.failure}`)
  if (state.modelAdmissionClosed) throw new DOMException('Mars model admission closed; the host finalizes automatically', 'AbortError')
  const agent = typeof input.agent === 'string' ? input.agent : input.agent?.name
  if (agent === 'compaction' || marsCompacting.has(sessionId)) return null
  const key = marsModelKeys.get(sessionId) ?? hash(`${input.message?.id ?? sessionId}:first`)
  markMarsBusy(sessionId)
  await syncMarsBusy(clientForMars, binding.rpc)
  let grant
  try { grant = await controlCall(binding.rpc, 'decision.enter', { sessionId, key, messageId: input.message?.id, noticeId: marsActiveNotices.get(sessionId) }, 0) }
  catch (error) {
    if (/Mars (model admission closed|decision cancelled)/.test(error.message)) throw new DOMException(error.message, 'AbortError')
    throw error
  }
  marsGrants.set(sessionId, grant)
  return grant
}
let clientForMars

function setMarsStepKey(sessionId, stepKey) {
  const retry = marsCompactionRetries.get(sessionId)
  if (retry?.step && retry.step !== stepKey) { marsCompactionRetries.delete(sessionId); marsRetryNotices.delete(sessionId) }
  else if (retry) retry.step = stepKey
  marsModelKeys.set(sessionId, marsCompactionRetries.get(sessionId)?.key ?? stepKey)
}

async function retryStrandedToolText(info, client) {
  const candidate = marsTextCandidates.get(info.id)
  if (!candidate || !info.time?.completed) return
  marsTextCandidates.delete(info.id)
  const binding = marsBindings.get(info.sessionID)
  try {
    if (disposed || !binding || !candidate.key || info.finish !== 'stop' || info.error || info.summary) return
    const result = client.session.message
      ? await client.session.message({ path: { id: info.sessionID, messageID: info.id } })
      : await client.session.messages({ path: { id: info.sessionID } })
    if (result?.error) throw new Error(JSON.stringify(result.error))
    const data = result?.data ?? result
    const message = Array.isArray(data) ? data.find(row => row.info?.id === info.id) : data
    if (disposed || message?.info?.id !== info.id || message.info.error || message.parts?.some(part => part.type === 'tool')) return
    const retry = await binding.rpc.call('model.retry', { sessionId: info.sessionID, key: candidate.key, messageId: info.id, reason: 'text_tool_call' }, 30000, { lane: 'control' })
    appendFileSync(join(marsHome, 'mars-plugin.log'), `tool protocol [${binding.mode}] ${info.sessionID}: ${retry.accepted ? 'same-step retry accepted' : retry.reason}\n`)
  } finally {
    if (!disposed && binding) await binding.rpc.call('model.verify', { sessionId: info.sessionID, messageId: info.id, active: false }, 30000, { lane: 'control' })
  }
}

/** Drain only pending durable events; each world owns its own delivery and transport retries. */
async function deliverMarsNotices() {
  if (!disposed) await Promise.all([...marsNoticePumps.values()].map(pump => pump.deliverPending()))
}
const marsTruth = resolve(workspace, process.env.SCIENCE_MARS_TRUTH || marsConfig.truth || '../../data/mars/truth.json')
const marsSalt = String(marsConfig.salt ?? 'a'.repeat(64))
const marsHome = marsMultiHome
function budgetFile(sessionId) { return join(marsBindings.get(sessionId)?.rpc.home ?? marsHome, 'budget.json') }
function readBudget(sessionId) {
  try { return JSON.parse(readFileSync(budgetFile(sessionId), 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { costUsd: 0, inputTokens: 0, outputTokens: 0, requests: 0, messages: {}, updatedAt: null }
  }
}
function assertBudget(sessionId) {
  if (!marsBindings.has(sessionId)) return
  const ledger = readBudget(sessionId)
  if (marsBudgetUsd && ledger.costUsd >= marsBudgetUsd) throw new Error(`Mars budget exhausted: ${ledger.costUsd} / ${marsBudgetUsd} USD`)
  const tokens = ledger.inputTokens + ledger.outputTokens
  if (marsBudgetTokens && tokens >= marsBudgetTokens) throw new Error(`Mars token budget exhausted: ${tokens} / ${marsBudgetTokens}`)
}
/** Assistant updates are incremental; persist deltas and separate the two worlds. */
function recordCost(info) {
  if (!info?.time?.completed || !marsBindings.has(info.sessionID) || typeof info.id !== 'string') return
  const ledger = readBudget(info.sessionID)
  ledger.messages ??= {}
  const previous = ledger.messages[info.id] ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 }
  const next = { costUsd: info.cost ?? 0, inputTokens: (info.tokens?.input ?? 0) + (info.tokens?.cache?.read ?? 0) + (info.tokens?.cache?.write ?? 0),
    outputTokens: (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0) }
  for (const key of ['costUsd', 'inputTokens', 'outputTokens']) ledger[key] = Math.max(0, (ledger[key] ?? 0) + next[key] - previous[key])
  if (!ledger.messages[info.id]) ledger.requests += 1
  ledger.messages[info.id] = next
  ledger.updatedAt = new Date().toISOString()
  writeFileSync(budgetFile(info.sessionID), `${JSON.stringify(ledger, null, 2)}\n`)
}

function startMarsSidecar(home, mode, httpPort) {
  if (!marsEnabled) return null
  mkdirSync(home, { recursive: true })
  const logPath = join(home, 'mars-sidecar.log')
  const child = spawn(
    nodeBinary,
    ['--experimental-transform-types', marsServerPath, '--home', home, '--truth', marsTruth, '--salt', marsSalt,
      '--mode', mode, '--team-size', String(marsTeamSize), '--http-port', String(httpPort ?? 0),
      '--checkpoint-interval', String(Number.isInteger(marsConfig.checkpointIntervalTicks) ? marsConfig.checkpointIntervalTicks : 240),
      '--model-barrier', marsConfig.modelBarrier === false ? '0' : '1', '--model-source', marsConfig.modelSource ?? 'real-model',
      ...(marsConfig.jointTrial ? ['--joint-trial', marsConfig.jointTrial] : []),
      ...(marsConfig.researchWorkflow ? ['--research-workflow', marsConfig.researchWorkflow] : []),
      ...(marsConfig.stageProfile ? ['--stage-profile', JSON.stringify(marsConfig.stageProfile)] : [])],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  )
  return { ...connectSidecar(child, { label: `Mars ${mode} sidecar`, log: chunk => appendFileSync(logPath, chunk) }), home, mode }
}

const marsDashboard = marsConfig.dashboard === true
const marsMultiPort = marsDashboard ? (Number.isInteger(marsConfig.multiPort) ? marsConfig.multiPort : 18081) : 0
const marsSinglePort = marsDashboard ? (Number.isInteger(marsConfig.singlePort) ? marsConfig.singlePort : 18082) : 0
const marsRpc = marsEnabled ? startMarsSidecar(marsMultiHome, marsMode, marsMultiPort) : null
const marsSingleRpc = marsDual ? startMarsSidecar(marsSingleHome, 'single', marsSinglePort) : null
/** sessionId -> sidecar binding, chosen by the role passed to mars_login. */
const marsBindings = new Map()
const marsSelectedSessions = new Set()
for (const rpc of [marsRpc, marsSingleRpc].filter(Boolean)) {
  marsBusySenders.set(rpc, createBusySender(rpc, { onAccepted: sessions => lastBusySnapshot.set(rpc, sessions) }))
  marsNoticePumps.set(rpc, new MarsNoticePump(rpc, {
    getClient: () => clientForMars,
    onState: round => marsRunStates.set(rpc, round),
    agent: marsAgent, retryDelayMs: controlRetryMs, maxRetryDelayMs: controlRetryMaxMs,
    prepareNotice: async notice => {
      if (notice.kind === 'report') return
      if (notice.kind === 'retry') {
        marsCompactionRetries.set(notice.sessionId, { key: notice.retryKey, step: null })
        marsRetryNotices.set(notice.sessionId, notice.id)
      }
      markMarsBusy(notice.sessionId)
      await syncMarsBusy(clientForMars, rpc)
    },
    log: error => appendFileSync(join(marsHome, 'mars-plugin.log'), `notice delivery [${rpc.mode}]: ${error.message}\n`),
  }))
}

function marsRpcFor(context) {
  const { sessionId } = identity(context)
  const binding = marsBindings.get(sessionId)
  if (!binding) throw new Error('Call mars_login before using Mars tools')
  return { rpc: binding.rpc, sessionId }
}

function marsSchema(spec) {
  const z = tool.schema
  if (!spec || typeof spec !== 'object') return z.any()
  switch (spec.type) {
    case 'string':
      return Array.isArray(spec.enum) && spec.enum.length > 0 ? z.enum(spec.enum) : z.string()
    case 'integer':
      return z.number().int()
    case 'number':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'array':
      return z.array(marsSchema(spec.items ?? { type: 'any' }))
    case 'object': {
      const shape = {}
      for (const [key, value] of Object.entries(spec.properties ?? {})) {
        const schema = marsSchema(value)
        shape[key] = value.required === true ? schema : schema.optional()
      }
      return spec.additionalProperties === false ? z.object(shape).strict() : z.object(shape).passthrough()
    }
    default:
      return z.any()
  }
}

function marsArgs(parameters) {
  const shape = {}
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    const base = marsSchema(spec)
    shape[name] = spec && spec.required === true ? base : base.optional()
  }
  return shape
}

async function buildMarsTools(client) {
  if (!marsRpc && !marsSingleRpc) return {}
  for (const rpc of [marsRpc, marsSingleRpc].filter(Boolean)) {
    const status = await rpc.call('status', {}, 60000)
    marsRunStates.set(rpc, status.round)
    for (const participant of status.participants ?? []) marsBindings.set(participant.sessionId, { rpc, role: participant.role, mode: rpc.mode })
    await marsNoticePumps.get(rpc).initialize()
  }
  // Engine APIs wait for plugin initialization; only the sidecars may be queried before hooks are returned.
  const listed = await (marsRpc ?? marsSingleRpc).call('tools.list', {}, 60000)
  const tools = {
    mars_login: tool({
      description:
        'Join a configured Mars v0.6 world. A team role joins the shared team world. Role single joins the independent control. Call this before other Mars tools.',
      args: {
        role: tool.schema.enum(marsLoginRoles).describe('Role in the configured Mars roster'),
      },
      async execute(args, context) {
        const who = identity(context)
        if (!who.sessionId) throw new Error('Mars login requires a live DeepWorks conversation session')
        const prior = marsBindings.get(who.sessionId)
        if (prior && prior.role !== args.role) throw new Error(`Session already joined as ${prior.role}`)
        const rpc = marsDual ? (args.role === 'single' ? marsSingleRpc : marsRpc) : marsRpc
        if (!rpc)
          throw new Error(
            args.role === 'single'
              ? 'Single-agent Mars world is not enabled; set mars.dual=true in science.json'
              : 'Multi-agent Mars world is not enabled',
          )
        const joined = await rpc.call('login', { sessionId: who.sessionId, role: args.role }, 30000)
        marsBindings.set(who.sessionId, { rpc, role: args.role, mode: args.role === 'single' ? 'single' : 'multi' })
        marsRunStates.set(rpc, (await rpc.call('status')).round)
        if (!prior && client?.session?.update) await client.session.update({ path: { id: who.sessionId },
          body: { title: args.role === 'single' ? 'S-single' : `M-${args.role}` } }).catch(error =>
            appendFileSync(join(marsHome, 'mars-plugin.log'), `role title: ${error.message}\n`))
        markMarsBusy(who.sessionId)
        await syncMarsBusy(client, rpc)
        return json(joined)
      },
    }),
  }
  for (const entry of listed) {
    tools[entry.name] = tool({
      description: entry.description,
      args: marsArgs(entry.parameters),
      async execute(args, context) {
        const { rpc, sessionId } = marsRpcFor(context)
        const result = await rpc.call('tools.call', { sessionId, name: entry.name, args, callId: hash(`${context.messageID}:${entry.name}:${JSON.stringify(args)}`) }, 180000)
        const value = result?.result
        return typeof value === 'string' ? value : json(value)
      },
    })
  }
  tools.mars_budget = tool({
    description: 'Read the approximate DeepWorks model cost ledger for this run (USD, tokens, requests).',
    args: {},
    async execute(_args, context) {
      const { sessionId } = marsRpcFor(context)
      const { messages, ...ledger } = readBudget(sessionId)
      const tokens = (ledger.inputTokens ?? 0) + (ledger.outputTokens ?? 0)
      return json({
        ...ledger,
        limitUsd: marsBudgetUsd,
        remainingUsd: marsBudgetUsd === null ? null : Math.max(0, Number((marsBudgetUsd - ledger.costUsd).toFixed(6))),
        limitTokens: marsBudgetTokens,
        remainingTokens: marsBudgetTokens === null ? null : Math.max(0, marsBudgetTokens - tokens),
      })
    },
  })
  tools.mars_start = tool({
    description: 'Brain/single: start the scientific run after all roles have logged in. The host activates the fixed team once and controls subsequent model decision windows. Also explicitly resumes an interrupted run.',
    args: {},
    async execute(_args, context) {
      const { rpc, sessionId } = marsRpcFor(context)
      const result = await rpc.call('run.start', { sessionId }, 30000)
      marsRunStates.set(rpc, (await rpc.call('status')).round)
      void deliverMarsNotices(client)
      return json(result)
    },
  })
  tools.mars_wait = tool({
    description: 'Yield to the simulation until an original meaningful physical event, unread mail or until_tick. Internal procedure steps and mechanical noise stay quiet. There is no wall-clock timeout and no self-wake is required.',
    args: { until_tick: tool.schema.number().int().optional() },
    async execute(args, context) {
      const { rpc, sessionId } = marsRpcFor(context)
      if (marsWaiting.has(sessionId)) throw new Error('This session already has a pending mars_wait')
      if (context.abort?.aborted) throw new Error('Mars wait cancelled')
      marsWaiting.add(sessionId)
      const abort = () => { void rpc.call('wait.cancel', { sessionId }, 5000).catch(() => {}) }
      context.abort?.addEventListener('abort', abort, { once: true })
      try {
        const result = await rpc.call('wait', { sessionId, untilTick: args.until_tick }, 0)
        if (context.abort?.aborted || result.cancelled) throw new Error('Mars wait cancelled')
        return json(result)
      } finally {
        context.abort?.removeEventListener('abort', abort)
        marsWaiting.delete(sessionId)
        markMarsBusy(sessionId)
        await syncMarsBusy(client, rpc)
      }
    },
  })
  tools.mars_wake = tool({
    description:
      'Wake an idle joined role asynchronously. A busy target receives inbox mail without an extra model turn. Blocking wait:true is unavailable with common round barriers; use mars_wake_status for replies.',
    args: {
      role: tool.schema.enum(marsLoginRoles).describe('Joined role to wake in this world'),
      message: tool.schema.string().describe('Complete instruction for the other agent'),
      agent: tool.schema.string().optional().describe('Optional opencode agent name for the target session'),
      wait: tool.schema.boolean().optional().describe('Must be false; blocking wake is incompatible with common rounds'),
    },
    async execute(args, context) {
      const { rpc, sessionId } = marsRpcFor(context)
      const binding = marsBindings.get(sessionId)
      const status = await rpc.call('status', {}, 30000)
      const target = (status.participants ?? []).find((participant) => participant.role === args.role)
      if (!target) throw new Error(`Role ${args.role} has not joined this Mars world`)
      if (target.sessionId === sessionId) throw new Error('Cannot wake your own session')
      if (args.wait === true) throw new Error('Blocking mars_wake would hold the model barrier; use async wake and mars_wake_status')
      if (!client?.session?.promptAsync) throw new Error('DeepWorks client is unavailable for waking')
      if (marsWakeClaims.has(target.sessionId)) {
        await rpc.call('tools.call', { sessionId, name: 'mars_send', args: { to: args.role, text: args.message } })
        return json({ role: args.role, sessionId: target.sessionId, queued: false, delivered: true, running: true })
      }
      marsWakeClaims.add(target.sessionId)
      try {
        if (marsEngineBusy.get(target.sessionId) === true || marsBusyMarks.has(target.sessionId)) {
          await rpc.call('tools.call', { sessionId, name: 'mars_send', args: { to: args.role, text: args.message } })
          return json({ role: args.role, sessionId: target.sessionId, queued: false, delivered: true, running: true, note: 'Target is already running; instruction delivered to its inbox.' })
        }
        markMarsBusy(target.sessionId)
        await syncMarsBusy(client, rpc)
        const text = `[Mars ${binding?.role ?? 'peer'} 唤醒] ${args.message}`
        appendFileSync(join(marsHome, 'mars-plugin.log'), `${new Date().toISOString()} wake ${binding?.role ?? '?'} -> ${args.role} ${target.sessionId}\n`)
        const started = await client.session.promptAsync({ path: { id: target.sessionId }, body: { agent: args.agent ?? marsAgent, parts: [{ type: 'text', text }] } })
        if (started?.error) throw new Error(`Could not wake ${args.role}: ${JSON.stringify(started.error)}`)
        markMarsBusy(target.sessionId)
        await syncMarsBusy(client, rpc)
        return json({
          role: args.role,
          sessionId: target.sessionId,
          queued: true,
          note: 'Target started in its own conversation. Use mars_wake_status with this sessionId to read its reply.',
        })
      } finally { marsWakeClaims.delete(target.sessionId) }
    },
  })
  tools.mars_wake_status = tool({
    description: 'Read the last assistant reply of a Mars role session started by mars_wake: running flag and completed text.',
    args: { sessionId: tool.schema.string().describe('Target session id returned by mars_wake') },
    async execute(args, context) {
      const { rpc } = marsRpcFor(context)
      const status = await rpc.call('status', {}, 30000)
      if (!(status.participants ?? []).some((participant) => participant.sessionId === args.sessionId))
        throw new Error('Session is not a joined role in this Mars world')
      if (!client?.session?.messages) throw new Error('DeepWorks client is unavailable')
      const listed = await client.session.messages({ path: { id: args.sessionId } })
      if (listed?.error) throw new Error(JSON.stringify(listed.error))
      const messages = listed?.data ?? listed ?? []
      const lastAssistant = [...messages].reverse().find((message) => message.info?.role === 'assistant')
      if (!lastAssistant) return json({ sessionId: args.sessionId, running: false, text: null })
      const running = marsEngineBusy.get(args.sessionId) === true || marsBusyMarks.has(args.sessionId)
      const completed = Boolean(lastAssistant.info?.time?.completed) && !running
      const text = (lastAssistant.parts ?? [])
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim()
      return json({ sessionId: args.sessionId, running: !completed, error: lastAssistant.info?.error ?? null, text: completed ? text : null })
    },
  })
  tools.mars_status = tool({
    description: 'Read this run’s Mars world tick, sample/device counts, operations and joined participants.',
    args: {},
    async execute(_args, context) {
      const { rpc } = marsRpcFor(context)
      return json(await rpc.call('status', {}, 30000))
    },
  })
  tools.mars_checkpoint = tool({
    description:
      'Brain or single: snapshot this session’s Mars world at the current tick. Restore later with node app/mars-checkpoint.mjs restore <id> --home <run-home> while the sidecar is stopped.',
    args: { label: tool.schema.string().optional().describe('Optional checkpoint label') },
    async execute(args, context) {
      const { rpc, sessionId } = marsRpcFor(context)
      return json(await rpc.call('checkpoint', { sessionId, label: args.label }, 120000))
    },
  })
  tools.mars_stages = tool({
    description: 'Read the current Mars tick, open submission slots with deadlines, accepted revisions and latest predictions, and immutable phase seals. Use expectedRevision from an open slot when submitting.',
    args: {},
    async execute(_args, context) {
      const { rpc } = marsRpcFor(context)
      return json(await rpc.call('stages', {}, 30000))
    },
  })
  tools.mars_finalize = tool({
    description:
      'Brain or single: finalize this session’s Mars run and produce the scientific R/O/F report. The horizon must be sealed; returns failure reasons when incomplete.',
    args: {},
    async execute(_args, context) {
      const { rpc, sessionId } = marsRpcFor(context)
      return json(await rpc.call('finalize', { sessionId }, 300000))
    },
  })
  appendFileSync(join(marsHome, 'mars-plugin.log'), `${new Date().toISOString()} registered ${Object.keys(tools).length} Mars tools (dual=${marsDual})\n`)
  for (const definition of Object.values(tools)) {
    const execute = definition.execute
    definition.execute = async (args, context) => {
      if (context.abort?.aborted) throw new Error('Mars tool cancelled')
      const sessionId = identity(context).sessionId
      markMarsBusy(sessionId)
      const binding = marsBindings.get(sessionId)
      if (binding) await syncMarsBusy(client, binding.rpc)
      marsResumePending.delete(sessionId)
      return execute(args, context)
    }
  }
  return tools
}

function startLlmProxy() {
  if (!llmProxyEnabled || llmProxyIps.length === 0) return null
  const keyFile = resolve(workspace, llmProxyConfig.keyFile ?? '../../data/secrets.json')
  const child = spawn(
    nodeBinary,
    [
      llmProxyPath,
      '--port', String(llmProxyPort),
      '--ips', llmProxyIps.join(','),
      '--reasoning', llmProxyConfig.reasoning ?? 'max',
      '--max-output-tokens', String(llmProxyConfig.maxOutputTokens ?? 30000),
      '--output-token-field', llmProxyConfig.outputTokenField ?? 'max_tokens',
      '--key-file', keyFile,
      '--log', join(home, 'llm-proxy.log'),
      '--exit-on-stdin-close',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  )
  child.stdout.on('data', (chunk) => appendFileSync(join(home, 'llm-proxy.log'), chunk))
  child.stderr.on('data', (chunk) => appendFileSync(join(home, 'llm-proxy.log'), chunk))
  child.on('error', error => appendFileSync(join(home, 'llm-proxy.log'), `llm proxy failed: ${error.message}\n`))
  child.stdin.on('error', error => appendFileSync(join(home, 'llm-proxy.log'), `llm proxy pipe: ${error.message}\n`))
  child.on('exit', (code) => appendFileSync(join(home, 'llm-proxy.log'), `llm proxy exited: ${code}\n`))
  return child
}

const llmProxy = startLlmProxy()

function startSidecar() {
  mkdirSync(home, { recursive: true })
  const logPath = join(home, 'sidecar.log')
  const child = spawn(nodeBinary, ['--experimental-transform-types', serverPath, '--home', home], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  return connectSidecar(child, { label: 'Science sidecar', log: chunk => appendFileSync(logPath, chunk) })
}

const sidecar = startSidecar()

function identity(context) {
  const sessionId = typeof context?.sessionID === 'string' ? context.sessionID : ''
  const agent = typeof context?.agent === 'string' && context.agent ? context.agent : 'agent'
  return { sessionId, agent }
}

async function callAs(method, args, context, timeoutMs = 60000) {
  const { sessionId, agent } = identity(context)
  if (!sessionId) throw new Error('Science tools require a live DeepWorks conversation session')
  return sidecar.call(method, { ...args, sessionId, agent }, timeoutMs)
}

const json = (value) => JSON.stringify(value, null, 2)

async function promptSession(client, sessionId, agent, text) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Session timed out after ${delegateTimeoutMs} ms`)), delegateTimeoutMs)
  })
  try {
    const result = await Promise.race([
      client.session.prompt({ path: { id: sessionId }, body: { agent, parts: [{ type: 'text', text }] } }),
      timeout,
    ])
    if (result?.error) throw new Error(`Session failed: ${JSON.stringify(result.error)}`)
    const payload = result?.data ?? result
    const parts = Array.isArray(payload?.parts) ? payload.parts : []
    const answer = parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    return { error: payload?.info?.error ?? null, text: answer || '(no text returned)' }
  } catch (error) {
    await client.session.abort({ path: { id: sessionId } }).catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const experimentId = tool.schema.string().describe('Experiment id returned by science_experiment_start')

export const Science = async ({ client } = {}) => {
  clientForMars = client
  const restoreSessionGet = adaptSessionGet(client)
  let marsTools
  try { marsTools = marsRpc || marsSingleRpc ? await buildMarsTools(client) : {} }
  catch (error) { restoreSessionGet(); throw error }
  return ({
  config: async configuration => {
    if (marsEnabled) {
      configuration.agent ??= {}
      configuration.agent.title = { ...configuration.agent.title, disable: true }
    }
  },
  lastBusySnapshot: () => new Map([...lastBusySnapshot].map(([rpc, sessions]) => [rpc === marsSingleRpc ? 'single' : 'multi', [...sessions]])),
  dispose: async () => {
    disposed = true
    for (const pump of marsNoticePumps.values()) pump.dispose()
    restoreSessionGet()
    await Promise.all([sidecar, marsRpc, marsSingleRpc].filter(Boolean).map(rpc => rpc.close()))
    llmProxy?.stdin.end()
  },
  tool: {
    ...marsTools,
    science_status: tool({
      description:
        'List this DeepWorks science project: experiments, their state, operations and artifacts. Use it first to see what exists before acting.',
      args: {},
      async execute(_args, context) {
        return json(await callAs('status', {}, context, 30000))
      },
    }),
    science_records: tool({
      description:
        'Write and return the durable Markdown research record (experiments, operations, assessments, completion) stored in the project data directory.',
      args: {},
      async execute(_args, context) {
        const result = await callAs('records', {}, context, 30000)
        return `${result.markdown}\n\n(file: ${result.file})`
      },
    }),
    science_experiment_start: tool({
      description:
        'Register a bounded sampling experiment on the shared instrument. The calling session becomes its controller until it explicitly releases control.',
      args: {
        goal: tool.schema.string().optional().describe('Scientific goal of this run; omit for the default completeness goal'),
        minimumReadings: tool.schema.number().int().optional().describe('Required unique observations (1-96, default 6)'),
      },
      async execute(args, context) {
        return json(await callAs('experiment.start', args, context, 30000))
      },
    }),
    science_experiment_get: tool({
      description: 'Read one experiment with its operations, artifacts, assessments and completion.',
      args: { experimentId },
      async execute(args, context) {
        return json(await callAs('experiment.get', args, context, 30000))
      },
    }),
    science_experiment_release: tool({
      description:
        'Hand admission to another session: releases this session’s live control so a different conversation can claim and execute the experiment. Authorship stays on the record.',
      args: { experimentId },
      async execute(args, context) {
        return json(await callAs('experiment.release', args, context, 30000))
      },
    }),
    science_experiment_act: tool({
      description:
        'Claim the experiment for this session and submit one allowed action. Waits for a terminal operation state by default and returns the real artifacts.',
      args: {
        experimentId,
        actionId: tool.schema.enum(['measure', 'supplement']).describe('Recipe action id'),
        rationale: tool.schema.string().optional().describe('Why this action is taken now'),
        waitMs: tool.schema.number().int().optional().describe('Wait for completion, 0-60000 ms; default 20000'),
      },
      async execute(args, context) {
        return json(await callAs('experiment.act', args, context, 90000))
      },
    }),
    science_experiment_wait: tool({
      description: 'Wait for the experiment to change or reach a decision point without submitting anything.',
      args: {
        experimentId,
        timeoutMs: tool.schema.number().int().optional().describe('Wait bound in ms; default 20000'),
      },
      async execute(args, context) {
        return json(await callAs('experiment.wait', args, context, 70000))
      },
    }),
    science_assess: tool({
      description:
        'Count unique observations in the actual completed instrument outputs and persist a sourced data-completeness assessment. Suggests supplement or finish.',
      args: { experimentId },
      async execute(args, context) {
        return json(await callAs('experiment.assess', args, context, 60000))
      },
    }),
    science_finish: tool({
      description:
        'Publish the execution report and complete the experiment. Refuses when the declared observation requirement is not met.',
      args: { experimentId },
      async execute(args, context) {
        return json(await callAs('experiment.finish', args, context, 60000))
      },
    }),
    science_operation: tool({
      description: 'Read one operation by id, including its current state, progress and artifacts.',
      args: { operationId: tool.schema.string().describe('Operation id') },
      async execute(args, context) {
        return json(await callAs('operation.get', args, context, 30000))
      },
    }),
    science_artifact: tool({
      description: 'Read a verified artifact by id. Text artifacts are returned directly; binary is returned base64-encoded.',
      args: { artifactId: tool.schema.string().describe('Artifact id') },
      async execute(args, context) {
        const result = await callAs('artifact.read', args, context, 30000)
        return result.encoding === 'utf8' ? result.content : json({ mediaType: result.artifact.mediaType, encoding: 'base64', content: result.content })
      },
    }),
    science_delegate: tool({
      description:
        'Start another DeepWorks conversation as a child session with the given agent, send it a task prompt, wait for it to finish, and return its final text. Use it to hand an experiment to the midbrain without switching conversations manually.',
      args: {
        agent: tool.schema.string().describe(`Target agent; one of: ${delegateAgents.join(', ')}`),
        prompt: tool.schema.string().describe('Complete task text for the child session, including the experiment id and what to report back'),
        title: tool.schema.string().optional().describe('Child session title'),
      },
      async execute(args, context) {
        const { sessionId } = identity(context)
        if (!sessionId) throw new Error('Delegation requires a live DeepWorks conversation session')
        if (delegatedSessions.has(sessionId)) throw new Error('Delegation depth exceeded: a delegated session cannot delegate again')
        if (!delegateAgents.includes(args.agent))
          throw new Error(`Delegation to "${args.agent}" is not allowed; use one of ${delegateAgents.join(', ')}`)
        if (!client?.session?.create || !client?.session?.prompt)
          throw new Error('DeepWorks client is unavailable for delegation')
        const created = await client.session.create({
          body: { parentID: sessionId, title: args.title || `delegated: ${args.agent}` },
        })
        if (created?.error) throw new Error(`Could not create delegated session: ${JSON.stringify(created.error)}`)
        const child = created?.data ?? created
        const childId = child?.id
        if (!childId) throw new Error('Delegated session creation returned no id')
        delegatedSessions.set(childId, {
          agent: args.agent,
          title: args.title || `delegated: ${args.agent}`,
          parentID: sessionId,
          createdAt: Date.now(),
        })
        const result = await promptSession(client, childId, args.agent, args.prompt)
        return json({ childSessionId: childId, agent: args.agent, wakeable: true, ...result })
      },
    }),
    science_sessions: tool({
      description:
        'List DeepWorks conversations in this workspace with ids, titles and parent ids, marking which ones this plugin can wake. Use it to find the session id returned by an earlier science_delegate.',
      args: {},
      async execute(_args, context) {
        if (!client?.session?.list) throw new Error('DeepWorks client is unavailable')
        const caller = identity(context).sessionId
        const listed = await client.session.list()
        if (listed?.error) throw new Error(`Could not list sessions: ${JSON.stringify(listed.error)}`)
        const rows = (listed?.data ?? listed ?? []).map((session) => ({
          id: session.id,
          title: session.title,
          parentID: session.parentID ?? null,
          updated: session.time?.updated ?? null,
          delegatedAgent: delegatedSessions.get(session.id)?.agent ?? null,
          wakeable: delegatedSessions.has(session.id) || (Boolean(caller) && session.parentID === caller),
        }))
        return json(rows)
      },
    }),
    science_wake: tool({
      description:
        'Send another message to a session created by science_delegate, waking it for the next step and returning its reply. Use it to re-activate the midbrain after new evidence, a wait, or an assessment.',
      args: {
        sessionId: tool.schema.string().describe('Session id returned by science_delegate or science_sessions'),
        message: tool.schema.string().describe('Complete instruction for the next step, including the experiment id and what to report'),
        agent: tool.schema.string().optional().describe('Agent for a recovered child session whose registration was lost'),
      },
      async execute(args, context) {
        const { sessionId } = identity(context)
        if (!sessionId) throw new Error('Waking a session requires a live DeepWorks conversation session')
        if (delegatedSessions.has(sessionId)) throw new Error('A delegated session cannot wake other sessions')
        if (!client?.session?.prompt) throw new Error('DeepWorks client is unavailable for waking')
        let agent = delegatedSessions.get(args.sessionId)?.agent
        if (!agent) {
          const listed = await client.session.list()
          if (listed?.error) throw new Error(`Could not list sessions: ${JSON.stringify(listed.error)}`)
          const found = (listed?.data ?? listed ?? []).find((session) => session.id === args.sessionId)
          if (!found || found.parentID !== sessionId)
            throw new Error('Only sessions started by this conversation can be woken; use science_sessions to find them')
          agent = args.agent || delegateAgents[0]
          if (!delegateAgents.includes(agent))
            throw new Error(`Delegation to "${agent}" is not allowed; use one of ${delegateAgents.join(', ')}`)
          delegatedSessions.set(args.sessionId, { agent, title: found.title, parentID: sessionId, createdAt: Date.now() })
        }
        const result = await promptSession(client, args.sessionId, agent, args.message)
        return json({ sessionId: args.sessionId, agent, ...result })
      },
    }),
  },
  'tool.execute.before': async (input, output) => {
    const sessionId = input?.sessionID
    if (!sessionId || !marsBindings.has(sessionId) && !marsSelectedSessions.has(sessionId)) return
    if (!Object.hasOwn(marsTools, input.tool)) {
      appendFileSync(join(marsHome, 'mars-plugin.log'), `${new Date().toISOString()} blocked ${input.tool} for ${sessionId}
`)
      throw new Error(`Tool ${input.tool} is disabled in a Mars run; use Mars tools and mars_wait instead`)
    }
    marsResumePending.delete(sessionId)
    // Native execution confirms this resumed step. Keep its grant for the tools in this response;
    // the next model request derives a new key from the updated conversation.
    if (!marsCompacting.has(sessionId)) clearMarsRetry(sessionId)
    void output
  },
  'chat.message': async (input, output) => {
    if (input?.agent === marsAgent || output?.message?.agent === marsAgent) marsSelectedSessions.add(input.sessionID)
    if (!output?.parts?.some(part => part.metadata?.kind === 'report')) assertBudget(input?.sessionID)
    const noticeId = output?.parts?.find(part => part.metadata?.marsNotice)?.metadata.marsNotice
    if (noticeId) marsActiveNotices.set(input.sessionID, noticeId)
    else marsActiveNotices.delete(input.sessionID)
    markMarsBusy(input?.sessionID)
    const binding = marsBindings.get(input?.sessionID)
    if (binding) await syncMarsBusy(client, binding.rpc)
  },
  'experimental.chat.messages.transform': async (_input, output) => {
    const lastUser = [...output.messages].reverse().find(message => message.info?.role === 'user')
    const sessionId = lastUser?.info?.sessionID
    if (!sessionId || !marsBindings.has(sessionId)) return
    const noticeId = lastUser.parts?.find(part => part.metadata?.marsNotice)?.metadata.marsNotice
    if (noticeId) marsActiveNotices.set(sessionId, noticeId)
    else marsActiveNotices.delete(sessionId)
    const previous = [...output.messages].reverse().find(message => message.info?.role === 'assistant'
      && (message.info?.time?.completed || message.parts?.some(part => part.type === 'tool')))
    const stepKey = hash(`${lastUser.info.id}:${previous?.info.id ?? 'initial'}`)
    if (marsCompacting.has(sessionId)) { marsDeferredKeys.set(sessionId, stepKey); return }
    marsDeferredKeys.delete(sessionId)
    setMarsStepKey(sessionId, stepKey)
    const grant = await enterMarsDecision({ sessionID: sessionId, agent: lastUser.info.agent, message: lastUser.info })
    if (!grant?.noticeIds?.some(id => !output.messages.some(message => message.info.id === id))) return
    const latest = await client.session.messages({ path: { id: sessionId } })
    if (latest?.error) throw new Error(JSON.stringify(latest.error))
    const known = new Set(output.messages.map(message => message.info.id))
    for (const message of latest?.data ?? latest ?? []) if (message.info?.role === 'user' && !known.has(message.info.id)) output.messages.push(message)
  },
  'chat.params': async (input, output) => {
    assertBudget(input.sessionID)
    if (input.agent === marsAgent && !marsBindings.has(input.sessionID) && marsBindings.size && [...marsBusySenders.keys()].every(rpc => marsRunStates.get(rpc)?.started))
      throw new Error('Mars fixed-role sessions are already running; use the original bound conversations, not an auxiliary/new session')
    if (input.agent !== 'compaction' && marsCompacting.has(input.sessionID)) {
      await finishMarsCompaction(input.sessionID)
      setMarsStepKey(input.sessionID, marsDeferredKeys.get(input.sessionID) ?? hash(`${input.message?.id ?? input.sessionID}:after-compaction`))
      marsDeferredKeys.delete(input.sessionID)
    }
    const limit = input.model?.limit?.output
    const modelLimit = Number.isFinite(limit) && limit > 0 ? limit : Infinity
    const cap = input.agent === 'compaction' ? Math.min(modelLimit, MARS_COMPACTION_OUTPUT_LIMIT) : modelLimit
    if ((marsBindings.has(input.sessionID) || input.agent === marsAgent) && Number.isFinite(cap)) {
      output.maxOutputTokens = output.maxOutputTokens === undefined ? cap : Math.min(output.maxOutputTokens, cap)
    }
    await enterMarsDecision(input)
  },
  'experimental.session.compacting': async (input) => {
    const binding = marsBindings.get(input.sessionID)
    if (binding) await controlCall(binding.rpc, 'model.aux', { sessionId: input.sessionID, active: true })
    marsCompacting.add(input.sessionID)
    markMarsBusy(input.sessionID)
    if (binding) await syncMarsBusy(client, binding.rpc)
  },
  'experimental.compaction.autocontinue': async (input) => { await finishMarsCompaction(input.sessionID) },
  'chat.headers': async (input, output) => {
    assertBudget(input.sessionID)
    await enterMarsDecision(input)
    markMarsBusy(input.sessionID)
    const binding = marsBindings.get(input.sessionID)
    if (binding) await syncMarsBusy(client, binding.rpc)
    const options = input?.provider?.options ?? {}
    const baseURL = String(options.baseURL ?? options.baseUrl ?? '')
    const providerId = input?.provider?.info?.id ?? 'unknown'
    if (!seenProviders.has(providerId)) {
      seenProviders.add(providerId)
      appendFileSync(
        join(home, 'plugin.log'),
        `${new Date().toISOString()} provider ${providerId} baseURL=${baseURL || '(none)'} source=${input?.provider?.source ?? '?'}\n`,
      )
    }
    const viaGateway = baseURL.includes(`127.0.0.1:${llmProxyPort}`) || baseURL.includes(`localhost:${llmProxyPort}`)
    if (providerId !== llmProviderId && !viaGateway) return
    output.headers['x-dw-session'] = input.sessionID
    output.headers['x-mars-request-kind'] = input.agent === 'compaction' ? 'compaction' : 'science'
    const grant = marsGrants.get(input.sessionID)
    if (grant) output.headers['x-mars-decision-tick'] = String(grant.tick)
  },
  'experimental.text.complete': async (input, output) => {
    if (!marsBindings.has(input.sessionID) || marsCompacting.has(input.sessionID)) return
    const candidate = strandedToolEnvelope(output.text, new Set(Object.keys(marsTools)))
    if (!candidate) return
    output.text += '\n\n[工具协议诊断：以上普通文本中的工具标记未执行，请以原生工具调用和真实回执为准。]'
    const binding = marsBindings.get(input.sessionID), state = marsRunStates.get(binding.rpc)
    if (!state?.started || state.suspended || state.modelAdmissionClosed || !marsGrants.has(input.sessionID)) return
    await binding.rpc.call('model.verify', { sessionId: input.sessionID, messageId: input.messageID, active: true }, 30000, { lane: 'control' })
    marsTextCandidates.set(input.messageID, { ...candidate, key: marsModelKeys.get(input.sessionID), sessionId: input.sessionID })
  },
  'experimental.chat.system.transform': async (input, output) => {
    if (marsCompacting.has(input.sessionID)) return
    if (systemPrompt) output.system.push(systemPrompt)
    const binding = marsBindings.get(input.sessionID)
    if (binding && marsResumePending.has(input.sessionID)) {
      const text = '[MARS_RESUME_AFTER_COMPACTION] 上下文压缩已完成。摘要是已发生工作的记录，不是本回合要输出的答案。请从原科研任务继续，先用已注册工具读取真实状态/回执，再处理未完成工作；不要重写 Objective/Work State/Next Move，不要在普通文本里写 DSML/invoke 工具标记。没有立即可执行工作时，用 mars_wait 等真实事件。'
      const workflow = marsConfig.researchWorkflow ?? marsConfig.stageProfile?.researchWorkflow
      const guidance = workflow === 'delivery-v2' ? `${text} 读取 receipt_work(action=list) 和 research_changes 的上次游标，按真实回执继续；静态契约需要重读时用 refresh=true。` : workflow === 'reviewed-v1'
        ? `${text} 当前启用共享草稿：用 mars_stages 查看本岗位开放槽位的 draft、rejection 和 accepted，再用 research_draft 读取目标版本，按真实错误修订或确认接纳。` : text
      await controlCall(binding.rpc, 'context.record', { sessionId: input.sessionID, kind: 'compaction-resume', text: guidance })
      output.system.push(guidance)
    }
  },
  event: async ({ event }) => {
    let stateWork
    const stateSession = event.properties?.sessionID
    if (event.type === 'session.status' && stateSession) stateWork = noteMarsEngineState(stateSession, event.properties.status)
    if (event.type === 'session.idle' && stateSession) {
      const observed = noteMarsEngineState(stateSession, { type: 'idle' })
      marsCompacting.delete(stateSession); marsDeferredKeys.delete(stateSession)
      if (!marsRetryNotices.has(stateSession)) marsCompactionRetries.delete(stateSession)
      const binding = marsBindings.get(stateSession)
      const idle = binding?.rpc.call('session.idle', { sessionId: stateSession }, 30000, { lane: 'control' }).catch(error => appendFileSync(join(marsHome, 'mars-plugin.log'), `idle [${binding.mode}]: ${error.message}\n`))
      stateWork = Promise.all([observed, idle])
    }
    if (!marsStatusPrimed && marsModelBarrier && (marsRpc || marsSingleRpc) && typeof event.type === 'string' && event.type.startsWith('session.')) {
      marsStatusPrimed = true
      await primeMarsEngineState(client)
      await syncMarsBusy(client)
      for (const pump of marsNoticePumps.values()) void pump.start()
    }
    if (stateWork) await stateWork
    if (event.type === 'message.updated' && event.properties?.info?.role === 'assistant') {
      recordCost(event.properties.info)
      if (event.properties.info.time?.completed) void retryStrandedToolText(event.properties.info, client).catch(error => {
        if (!disposed) appendFileSync(join(marsHome, 'mars-plugin.log'), `tool protocol verification: ${error.message}\n`)
      })
      const info = event.properties.info
      if (info.summary && isMarsContextOverflow(info.error)) {
        await reportFailedMarsCompaction(info).catch(error => {
          if (!disposed) appendFileSync(join(marsHome, 'mars-plugin.log'), `compaction failure report: ${error.message}\n`)
        })
      }
      if (info.error?.name === 'MessageAbortedError' && marsLastAbortIds.get(info.sessionID) !== info.id) {
        marsLastAbortIds.set(info.sessionID, info.id); clearMarsRetry(info.sessionID)
        await marsBindings.get(info.sessionID)?.rpc.call('session.idle', { sessionId: info.sessionID, cancelled: true, cancellationId: info.id }, 30000, { lane: 'control' }).catch(() => {})
      }
    }
    if (event.type === 'session.compacted' && event.properties?.sessionID) await finishMarsCompaction(event.properties.sessionID)
    if (event.type === 'session.error' && event.properties?.sessionID) {
      const sessionId = event.properties.sessionID
      const binding = marsBindings.get(sessionId)
      const detail = event.properties.error?.data?.message ?? event.properties.error?.message ?? ''
      if (isMarsContextOverflow(event.properties.error)) {
        // The engine compacts and retries this step; keep its model hold and decision key.
        const key = marsModelKeys.get(sessionId)
        if (binding && key) marsCompactionRetries.set(sessionId, { key, step: null })
      } else {
        const cancelled = event.properties.error?.name === 'MessageAbortedError' || /Mars .*cancelled|Mars model admission closed/.test(detail)
        const infrastructure = /Mars (?:control unavailable|infrastructure failure)/.test(detail)
        if (!cancelled && !infrastructure) await binding?.rpc.call('model.close', { reason: /Mars (token )?budget exhausted/.test(detail) ? 'budget_exhausted' : 'model_error' }, 30000, { lane: 'control' }).catch(() => {})
        await binding?.rpc.call('session.idle', { sessionId }, 30000, { lane: 'control' }).catch(() => {})
      }
    }
    if (event.type === 'session.deleted' && event.properties?.info?.id) {
      const sessionId = event.properties.info.id
      clearMarsBusy(sessionId)
      marsEngineBusy.delete(sessionId); marsEngineVersions.delete(sessionId); marsLastAbortIds.delete(sessionId)
      marsActiveNotices.delete(sessionId); marsResumePending.delete(sessionId); clearMarsRetry(sessionId)
      for (const [id, candidate] of marsTextCandidates) if (candidate.sessionId === sessionId) marsTextCandidates.delete(id)
      marsWaiting.delete(sessionId)
      await marsBindings.get(sessionId)?.rpc.call('session.close', { sessionId }, 5000).catch(() => {})
      marsBindings.delete(sessionId)
      marsModelKeys.delete(sessionId); marsGrants.delete(sessionId); marsCompactionRetries.delete(sessionId)
      await sidecar.call('session.close', { sessionId }, 5000).catch(() => {})
      if (llmProxyEnabled && llmProxyIps.length > 0) {
        void fetch(`http://127.0.0.1:${llmProxyPort}/release`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        }).catch(() => {})
      }
    }
  },
  })
}
