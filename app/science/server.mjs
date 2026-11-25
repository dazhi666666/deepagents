#!/usr/bin/env node
/**
 * DeepWorks science sidecar.
 *
 * Runs the AI4Science platform core on plain Node (not the Bun engine process) and exposes it
 * over newline-delimited JSON on stdio. Each DeepWorks conversation session is registered as one
 * platform participant, so experiment records carry the session identity that produced them.
 *
 * Usage: node --experimental-transform-types server.mjs --home <data-dir> [--project <id>]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { openConfiguredEngine } from './platform/config.ts'
import { Artifacts } from './platform/artifacts.ts'
import { samplingRequest, assessSampling, finishSampling } from './domain.ts'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const home = resolve(arg('home', join(here, '..', '..', 'data')))
const project = arg('project', 'deepworks-science')
const platformDirectory = join(home, 'platform')
const instrumentDirectory = join(home, 'instrument')
const computeDirectory = join(home, 'compute')
for (const directory of [home, platformDirectory, instrumentDirectory, computeDirectory]) mkdirSync(directory, { recursive: true })

const deploymentPath = join(home, 'deployment.json')
const deployment = {
  apiVersion: 1,
  enabled: true,
  hostApi: '0.2',
  directory: './platform',
  pollIntervalMs: 50,
  providerCallTimeoutMs: 10000,
  management: { actorId: 'deepworks-host', projects: [project], allowedProviders: ['instrument', 'compute'] },
  providers: [
    {
      module: join(here, 'platform', 'providers', 'instrument.ts').replaceAll('\\', '/'),
      config: {
        id: 'instrument',
        directory: instrumentDirectory,
        resource: 'instrument-1',
        tickMs: 25,
        reference: 10,
        slope: 0.27,
        drift: 0.012,
        noise: 0.18,
        seed: 123,
      },
    },
    {
      module: join(here, 'platform', 'providers', 'compute.ts').replaceAll('\\', '/'),
      config: { id: 'compute', directory: computeDirectory, resource: 'compute-1', tickMs: 100, chunkSize: 5 },
    },
  ],
}
writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`)

const { engine } = await openConfiguredEngine(deploymentPath, 'controller')
if (!engine.projects().some((value) => value.id === project)) engine.createProject(project, null)
const admin = engine.issueContext(project, 'deepworks-host', ['instrument', 'compute'])
const artifacts = new Artifacts(engine)

/** sessionId -> { context, actorId, agent, title } */
const participants = new Map()
const MAX_PARTICIPANTS = 128

function participant(sessionId, agent = 'unknown', title = '') {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('A live DeepWorks session is required')
  const existing = participants.get(sessionId)
  if (existing) {
    if (agent && agent !== 'unknown' && existing.agent !== agent) existing.agent = agent
    return existing
  }
  if (participants.size >= MAX_PARTICIPANTS) {
    const oldest = participants.keys().next().value
    engine.revokeContext(participants.get(oldest).context)
    participants.delete(oldest)
  }
  const short = sessionId.replace(/^ses_/, '').slice(0, 12)
  const actorId = `${agent || 'agent'}@${short}`
  const context = engine.issueContext(project, actorId, ['instrument', 'compute'])
  const record = { context, actorId, agent: agent || 'unknown', title, openedAt: new Date().toISOString() }
  participants.set(sessionId, record)
  return record
}

function participantOf(params) {
  return participant(params.sessionId, params.agent, params.title)
}

function compactExperiment(view) {
  return {
    id: view.id,
    state: view.state,
    createdBy: view.createdBy,
    goal: view.request.goal,
    budgetUsed: view.budgetUsed,
    budgetLimit: view.projectBudget.limit,
    controllerActive: view.controllerActive,
    operations: view.operations.map((operation) => ({
      id: operation.id,
      providerId: operation.providerId,
      state: operation.state,
      artifacts: operation.artifacts.map((artifact) => ({ id: artifact.id, path: artifact.path, mediaType: artifact.mediaType, bytes: artifact.bytes })),
    })),
    assessments: view.assessments.map((assessment) => ({ id: assessment.id, method: assessment.method, result: assessment.result })),
    completion: view.completion,
    reason: view.reason,
    lastIssue: view.lastIssue,
  }
}

function operationSummary(operation) {
  return {
    id: operation.id,
    providerId: operation.providerId,
    state: operation.state,
    budget: operation.budget,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    artifacts: operation.artifacts.map((artifact) => ({ id: artifact.id, path: artifact.path, mediaType: artifact.mediaType, bytes: artifact.bytes })),
    progress: operation.progress,
    detail: operation.detail,
  }
}

function recordsMarkdown() {
  const experiments = engine.experiments.list(admin)
  const lines = [`# DeepWorks 科研记录`, '', `项目：\`${project}\``, `数据目录：\`${home}\``, '']
  if (experiments.length === 0) lines.push('尚无实验记录。', '')
  for (const view of experiments) {
    lines.push(`## 实验 ${view.id}`, '')
    lines.push(`- 目标：${view.request.goal}`)
    lines.push(`- 状态：${view.state}`)
    lines.push(`- 方法：${view.request.method.id} v${view.request.method.version}`)
    lines.push(`- 创建者：${view.createdBy}`)
    lines.push(`- 预算：已用 ${view.budgetUsed} / 上限 ${view.projectBudget.limit ?? '不限'}`)
    lines.push(`- 操作：`)
    if (view.operations.length === 0) lines.push('  - 无')
    for (const operation of view.operations) {
      const outputs = operation.artifacts.map((a) => a.path).join(', ') || '无产物'
      lines.push(`  - ${operation.id} ${operation.providerId} ${operation.state}；${outputs}`)
    }
    lines.push(`- 评估：${view.assessments.length === 0 ? '无' : view.assessments.map((a) => a.method).join(', ')}`)
    lines.push(`- 完成：${view.completion === null ? '未结束' : JSON.stringify(view.completion)}`)
    lines.push('')
  }
  return lines.join('\n')
}

function writeRecords() {
  writeFileSync(join(home, 'records.md'), `${recordsMarkdown()}\n`)
}

const methods = {
  hello() {
    return {
      version: 'deepworks-science/0.2',
      project,
      home,
      providers: engine.descriptions(admin).map((value) => value.id),
      sessions: participants.size,
    }
  },
  'session.open'(params) {
    const value = participantOf(params)
    return { actorId: value.actorId, role: value.agent, project }
  },
  'session.close'(params) {
    const existing = participants.get(params.sessionId)
    if (existing) {
      engine.revokeContext(existing.context)
      participants.delete(params.sessionId)
    }
    return { closed: Boolean(existing) }
  },
  status(params) {
    const value = participantOf(params)
    return {
      project,
      actorId: value.actorId,
      experiments: engine.experiments.list(value.context).map(compactExperiment),
      operations: engine.list(value.context).map(operationSummary),
    }
  },
  'experiment.start'(params) {
    const value = participantOf(params)
    const request = samplingRequest('instrument')
    if (typeof params.goal === 'string' && params.goal.trim()) request.goal = params.goal.trim().slice(0, 16000)
    if (Number.isInteger(params.minimumReadings)) {
      request.context.minimumReadings = Math.max(1, Math.min(96, params.minimumReadings))
    }
    if (params.budget === null || Number.isFinite(params.budget)) request.budget = params.budget
    if (params.maxOperations === null || Number.isInteger(params.maxOperations)) request.maxOperations = params.maxOperations
    const view = engine.experiments.create(value.context, params.requestKey || randomUUID(), request)
    writeRecords()
    return compactExperiment(view)
  },
  'experiment.get'(params) {
    const value = participantOf(params)
    return compactExperiment(engine.experiments.get(value.context, params.experimentId))
  },
  'experiment.list'(params) {
    const value = participantOf(params)
    return engine.experiments.list(value.context).map(compactExperiment)
  },
  async 'experiment.act'(params) {
    const value = participantOf(params)
    engine.experiments.claim(value.context, params.experimentId, `DeepWorks session ${value.actorId} claims control`)
    const view = engine.experiments.get(value.context, params.experimentId)
    const recipe = view.request.actions.find((action) => action.id === params.actionId)
    if (!recipe) throw new Error(`Unknown action: ${params.actionId}`)
    const succeeded = view.operations.filter((operation) => operation.state === 'succeeded').map((operation) => operation.id)
    const action = {
      requestKey: params.requestKey || randomUUID(),
      actionId: recipe.id,
      rationale: params.rationale || `Execute ${recipe.id} from DeepWorks session ${value.actorId}`,
      evidenceOperationIds:
        params.evidenceOperationIds && params.evidenceOperationIds.length > 0 ? params.evidenceOperationIds : recipe.requiresEvidence ? succeeded : [],
      evidenceArtifactIds: params.evidenceArtifactIds || [],
    }
    let operation = await engine.experiments.submit(value.context, params.experimentId, {
      ...action,
      evidenceOperationIds: action.evidenceOperationIds,
      evidenceArtifactIds: action.evidenceArtifactIds,
    })
    const waitMs = Number.isInteger(params.waitMs) ? Math.max(0, Math.min(60000, params.waitMs)) : 20000
    if (waitMs > 0 && !['succeeded', 'failed', 'cancelled', 'unknown'].includes(operation.state)) {
      operation = await engine.wait(value.context, operation.id, { timeoutMs: waitMs })
    }
    writeRecords()
    return { operation: operationSummary(operation), experiment: compactExperiment(engine.experiments.get(value.context, params.experimentId)) }
  },
  async 'experiment.wait'(params) {
    const value = participantOf(params)
    const view = engine.experiments.get(value.context, params.experimentId)
    const feedback = await engine.experiments.wait(value.context, params.experimentId, {
      after: Number.isInteger(params.after) ? params.after : view.cursor,
      until: params.until === 'change' ? 'change' : 'decision',
      timeoutMs: Number.isInteger(params.timeoutMs) ? Math.max(1, Math.min(60000, params.timeoutMs)) : 20000,
    })
    return { reason: feedback.reason, experiment: compactExperiment(feedback.experiment) }
  },
  /** Creator hands admission to another live session; authorship stays recorded on the experiment. */
  'experiment.release'(params) {
    const value = participantOf(params)
    engine.revokeContext(value.context)
    const replacement = engine.issueContext(project, value.actorId, ['instrument', 'compute'])
    value.context = replacement
    return { released: true, experimentId: params.experimentId, actorId: value.actorId }
  },
  'experiment.assess'(params) {
    const value = participantOf(params)
    return assessSampling(engine, value.context, params.experimentId)
  },
  'experiment.finish'(params) {
    const value = participantOf(params)
    const result = finishSampling(engine, value.context, params.experimentId)
    writeRecords()
    return result
  },
  'operation.get'(params) {
    const value = participantOf(params)
    return operationSummary(engine.get(value.context, params.operationId))
  },
  'operation.list'(params) {
    const value = participantOf(params)
    return engine.list(value.context).map(operationSummary)
  },
  async 'operation.wait'(params) {
    const value = participantOf(params)
    const operation = await engine.wait(value.context, params.operationId, {
      timeoutMs: Number.isInteger(params.timeoutMs) ? Math.max(1, Math.min(60000, params.timeoutMs)) : 20000,
    })
    return operationSummary(operation)
  },
  'artifact.read'(params) {
    const value = participantOf(params)
    const result = artifacts.read(value.context, params.artifactId)
    return { artifact: result.artifact, content: result.content, encoding: result.encoding }
  },
  records(params) {
    participantOf(params)
    writeRecords()
    return { markdown: recordsMarkdown(), file: join(home, 'records.md') }
  },
  shutdown() {
    setTimeout(() => void shutdown(0), 10)
    return { closing: true }
  },
}

let closing = false
async function shutdown(code) {
  if (closing) return
  closing = true
  try {
    for (const value of participants.values()) engine.revokeContext(value.context)
    participants.clear()
    await engine.close()
  } finally {
    process.exit(code)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    process.stderr.write('science-sidecar: invalid JSON request\n')
    return
  }
  const { id, method, params = {} } = request
  const handler = methods[method]
  if (!handler) {
    write({ id, ok: false, error: `Unknown method: ${method}` })
    return
  }
  Promise.resolve()
    .then(() => handler(params))
    .then((result) => write({ id, ok: true, result }))
    .catch((error) => write({ id, ok: false, error: error instanceof Error ? error.message : String(error) }))
})

function write(message) {
  if (closing) return
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
rl.on('close', () => void shutdown(0))
process.stdout.write(`${JSON.stringify({ id: null, ok: true, event: 'ready', result: { project, home } })}\n`)
writeRecords()
