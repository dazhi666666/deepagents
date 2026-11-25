/** Offline, read-only objective recomputation over retained physical and platform evidence. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { finalizeV05 } from './v05/finalize.ts'
import { protocolReport } from './v06/protocol.ts'
import { sourceManifest } from './v06/source-manifest.ts'
import { reportScientificStopped } from './v06/offline.ts'
import { replayTerminalPlan } from './v05/replay.ts'
import { buildEarlyStopReport } from './v05/early-stop.ts'
import { MarsAudit } from './audit.ts'
import { acquireRunLease } from './checkpoints.ts'
import { laboratoryStateSchema } from '../greenhouse/laboratory/schema.ts'
import { experimentRequestSchema, type ExperimentView } from '../../../../science-harness/integrations/ai4science/platform/experiments.ts'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { Json, OperationContext, OperationRecord } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { marsSystemStateSchema, MarsWorld, initialMarsRules } from './world.ts'
import { marsScenario } from './scenario.ts'
import { loadTruth } from './truth.ts'
import { MarsArchive } from './archive.ts'
import { AnalysisRegistry } from './analysis.ts'
import { analysisBindings } from './v2-tools.ts'
import { collectFacts, independentCheck, loadAnswers, loadBaselines, worldView } from './scoring-input.ts'
import { score } from './scoring.ts'
import { canonicalJson } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { Artifacts } from '../../../../science-harness/integrations/ai4science/platform/artifacts.ts'

export const name = 'science-mars-offline-report'
export const inject: string[] = []
const row = z.object({ id: z.string(), project_id: z.string(), actor_id: z.string(), provider_id: z.string(), provider_version: z.string(),
  request_key: z.string(), input_json: z.string(), resources_json: z.string(), budget: z.number(), state: z.enum(['registered', 'dispatching', 'accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']),
  cancel_requested: z.number(), progress_json: z.string().nullable(), detail: z.string().nullable(), created_at: z.string(), updated_at: z.string() })

/** Recompute stopped-run scores without opening Providers or granting live Agent capabilities.
 * @param directory Stopped mutable run root, protected by the recovery lease.
 * @returns Scores, evidence checks and original outcome classification.
 */
export function evaluateStopped(directory: string, leaseHeld = false) {
  const root = resolve(directory), lease = leaseHeld ? undefined : acquireRunLease(root, true)
  const dispose: (() => void)[] = lease ? [() => lease.close()] : []
  try {
    const db = new DatabaseSync(join(root, 'execution/execution.sqlite'), { readOnly: true }); dispose.unshift(() => db.close())
    const device = new DatabaseSync(join(root, 'device/laboratory.sqlite'), { readOnly: true }); dispose.unshift(() => device.close())
    db.exec('BEGIN'); device.exec('BEGIN')
    const state = laboratoryStateSchema.parse(JSON.parse(z.object({ state: z.string() }).parse(device.prepare('SELECT state FROM world WHERE id=1').get()).state))
    // Extension parsing is delegated to the same versioned public read schema as runtime snapshots.
    const systems = z.object({ state: z.string() }).parse(device.prepare('SELECT state FROM mars_state WHERE id=1').get())
    const extension = marsSystemStateSchema.parse(JSON.parse(systems.state))
    const facts = db.prepare("SELECT data_json FROM events WHERE type='fact' AND project_id='mars' ORDER BY seq").all()
      .map(value => z.object({ actorId: z.string(), kind: z.string(), data: z.json() }).parse(JSON.parse(String(value.data_json))))
    const operations: OperationRecord[] = db.prepare("SELECT * FROM operations WHERE project_id='mars'").all().map(raw => {
      const value = row.parse(raw)
      const artifacts = db.prepare('SELECT * FROM artifacts WHERE operation_id=?').all(value.id).map(raw => {
        const artifact = z.object({ id: z.string(), operation_id: z.string(), path: z.string(), sha256: z.string(), bytes: z.number(), media_type: z.string() }).parse(raw)
        return { id: artifact.id, operationId: artifact.operation_id, path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes, mediaType: artifact.media_type }
      })
      return { id: value.id, runId: value.id, projectId: value.project_id, actorId: value.actor_id, providerId: value.provider_id, providerVersion: value.provider_version,
        requestKey: value.request_key, input: z.json().parse(JSON.parse(value.input_json)), resources: z.array(z.string()).parse(JSON.parse(value.resources_json)),
        budget: value.budget, state: value.state, cancelRequested: value.cancel_requested !== 0,
        progress: value.progress_json ? z.json().parse(JSON.parse(value.progress_json)) : null, detail: value.detail, createdAt: value.created_at, updatedAt: value.updated_at, artifacts }
    })
    const retainedEvents = db.prepare("SELECT * FROM events WHERE project_id='mars' ORDER BY seq").all()
    const context: OperationContext = { projectId: 'mars', actorId: 'offline-verifier', allowedProviders: ['water', 'greenhouse', 'facilities'] }
    const source: Pick<ExecutionEngine, 'readFacts' | 'list' | 'events' | 'eventCursor' | 'directory' | 'recordFact'> & { experiments: { get(context: OperationContext, id: string): Pick<ExperimentView, 'id' | 'request' | 'operations'> } } = {
      directory: join(root, 'execution'), readFacts: () => facts, list: () => operations,
      events: () => retainedEvents,
      eventCursor: () => retainedEvents.reduce((cursor, raw) => Math.max(cursor, z.object({ seq: z.number() }).parse(raw).seq), 0),
      recordFact: () => { throw new Error('Offline evaluation cannot modify execution facts') },
      experiments: { get: (_context, id) => {
        const record = z.object({ id: z.string(), spec_json: z.string() }).parse(db.prepare('SELECT id,spec_json FROM experiments WHERE id=?').get(id))
        const ids = new Set(db.prepare('SELECT operation_id FROM experiment_steps WHERE experiment_id=?').all(id).map(value => String(value.operation_id)))
        // Only declared requirements and actual bound operation membership are consumed by assessment.
        return { id: record.id, request: experimentRequestSchema.parse(JSON.parse(record.spec_json)), operations: operations.filter(operation => ids.has(operation.id)) }
      } },
    }
    const checks: { name: string; passed: boolean }[] = []
    const check = (name: string, passed: boolean) => checks.push({ name, passed })
    const artifacts = new Artifacts(source)
    let artifactsValid = true
    for (const operation of operations) for (const artifact of operation.artifacts) {
      try { artifacts.read(context, artifact.id) } catch (error) {
        if (!(error instanceof Error)) throw error
        artifactsValid = false
      }
    }
    check('all_committed_artifact_hashes', artifactsValid)
    const physical = [...state.operations, ...extension.operations]
    check('operation_identities_and_physical_effects', operations.every(operation => operation.state === 'failed' && operation.detail?.startsWith('Resource reserved:') && operation.artifacts.length === 0 || physical.some(value => value.id === operation.id && value.projectId === operation.projectId && canonicalJson(z.json().parse(value.command)) === canonicalJson(operation.input))))
    const members = new Map<string, { id: string; parentId?: string | undefined }>()
    for (const fact of facts.filter(fact => fact.kind === 'mars-organization')) {
      const event = z.object({ kind: z.string(), data: z.json() }).parse(fact.data)
      if (['participant-created', 'participant-resumed'].includes(event.kind)) {
        const participant = z.object({ id: z.string(), parentId: z.string().optional() }).parse(event.data)
        members.set(participant.id, participant)
      }
    }
    const files: string[] = []
    const walk = (path: string) => { if (!existsSync(path)) return; for (const item of readdirSync(path)) { const file = join(path, item); if (statSync(file).isDirectory()) walk(file); else if (/session\.v\d+\.jsonl$/.test(item)) files.push(file) } }
    walk(join(root, 'sessions'))
    const sessions = new Map<string, { parentSession?: string; roles: string[] }>()
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      const header = z.object({ id: z.string(), parentSession: z.string().optional() }).parse(lines[0])
      sessions.set(header.id, { ...(header.parentSession ? { parentSession: header.parentSession } : {}), roles: lines.slice(1).map(line => String(line.type)) })
    }
    check('real_native_member_lineage', members.size > 0 && [...members.values()].every(member => sessions.has(member.id) && sessions.get(member.id)?.parentSession === member.parentId))
    check('tasks_authored_by_actual_native_participants', facts.filter(fact => fact.kind === 'mars-record-mutation').every(fact => members.has(fact.actorId)))
    const audit = new MarsAudit(`${root}.audit.jsonl`)
    const requests = facts.filter(fact => fact.kind === 'mars-model-request').map(fact => z.object({ model: z.string() }).parse(fact.data))
    return { source, context, facts, operations, checks, physical, audit, state,
      modelSource: requests.length ? requests.every(request => ['intern-s2', 'dsv4f-native'].includes(request.model)) ? 'real-model' : 'scripted-integration' : 'environment',
      identity: JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')) as Json, evidenceValid: checks.every(check => check.passed), usage: audit.usage() }
  } finally { for (const close of dispose) close() }
}

/** Offline score recomputation (with analysis re-runs) for a stopped run. */
async function reportStoppedWithLease(input: { directory: string; truthFile: string; answersFile?: string | undefined; baselinesFile?: string | undefined; benchmarkVersion?: 'v0.4' | 'v0.5' | 'v0.6' | undefined }) {
  const evidence = evaluateStopped(input.directory, true)
  if (input.benchmarkVersion === 'v0.6') {
    const manifest = z.object({ benchmarkVersion: z.literal('v0.6'), implementation: z.enum(['protocol_only', 'scientific_candidate']).default('protocol_only'),
      stopAtTick: z.number().int().positive(), sourceHash: z.string(), nodeVersion: z.string() })
      .parse(JSON.parse(readFileSync(join(resolve(input.directory), 'manifest.public.json'), 'utf8')))
    if (manifest.sourceHash !== sourceManifest().hash || manifest.nodeVersion !== process.version) throw new Error('Offline protocol source or Node version differs from run')
    if (manifest.implementation === 'scientific_candidate') return reportScientificStopped({ directory: resolve(input.directory), truthFile: input.truthFile,
      engine: evidence.source, context: evidence.context, identity: evidence.identity, usage: z.json().parse(evidence.usage), checks: evidence.checks })
    return protocolReport(evidence.source, evidence.context, evidence.state.tick, manifest.stopAtTick)
  }
  const truth = loadTruth(input.truthFile)
  const identityFile = join(`${resolve(input.directory)}.evaluator`, 'v05-source.json')
  if (input.benchmarkVersion === 'v0.5' && existsSync(identityFile)) {
    const identity = z.object({ truthHash: z.string() }).parse(JSON.parse(readFileSync(identityFile, 'utf8')))
    if (identity.truthHash !== createHash('sha256').update(JSON.stringify(truth)).digest('hex')) throw new Error('Private scenario identity changed before offline report')
  }
  const world = new MarsWorld(join(resolve(input.directory), 'device'), marsScenario(truth), initialMarsRules(), truth)
  const archive = new MarsArchive(join(resolve(input.directory), 'public/history'))
  try {
    const analysis = new AnalysisRegistry(join(resolve(input.directory), 'analysis'))
    const engineLike = { ...evidence.source, issueContext: () => evidence.context } as unknown as ExecutionEngine
    if (input.benchmarkVersion === 'v0.5') {
      if (evidence.state.tick < truth.horizon) {
        const root = resolve(input.directory), publicManifest = join(root, 'manifest.public.json')
        const savedManifest = existsSync(publicManifest) ? JSON.parse(readFileSync(publicManifest, 'utf8')) as { stopAtTick?: number } : {}
        const savedFile = ['early-stop-report.json', 'early-stop.json'].map(name => join(root, name)).find(existsSync)
        const saved = savedFile ? JSON.parse(readFileSync(savedFile, 'utf8')) as { terminationReason?: string; stopAtTick?: number } : {}
        const configuredTarget = savedManifest.stopAtTick ?? saved.stopAtTick
        const stopAtTick = typeof configuredTarget === 'number' && Number.isSafeInteger(configuredTarget) && configuredTarget >= 0 && configuredTarget < truth.horizon ? configuredTarget : evidence.state.tick
        const requested = saved.terminationReason === 'user_requested_stop' || configuredTarget !== undefined && evidence.state.tick >= stopAtTick
        const partial = buildEarlyStopReport({ engine: engineLike, context: evidence.context, analysis, world, audit: evidence.audit, stopAtTick,
          reason: requested ? 'user_requested_stop' : 'incomplete_run' })
        return { ...partial, identity: evidence.identity, modelSource: evidence.modelSource, usage: evidence.usage, evidenceValid: evidence.evidenceValid, checks: evidence.checks }
      }
      const scored = await finalizeV05({ engine: engineLike, context: evidence.context, analysis, world, analysisBindings: analysisBindings({ engine: engineLike, admin: evidence.context, world, archive }, evidence.context),
        replay500: async () => { const replay = await replayTerminalPlan({ world, engine: engineLike, context: evidence.context, directory: `${input.directory}.evaluator` }); return replay ? { researchAttainment: replay.researchAttainment, constraintAttainment: replay.constraintAttainment, trajectoryHash: replay.trajectoryHash } : { researchAttainment: 0, constraintAttainment: 0, trajectoryHash: 'no-timely-valid-plan' } } })
      return { schemaVersion: 5, identity: evidence.identity, modelSource: evidence.modelSource, tick: evidence.state.tick, score: scored, usage: evidence.usage, evidenceValid: evidence.evidenceValid, checks: evidence.checks }
    }
    const facts = collectFacts(engineLike, evidence.context, analysis)
    const results = new Map<string, boolean>()
    for (const submission of facts.submissions) for (const run of submission.evidence.analysisRunIds) {
      const numbers: number[] = []
      const walk = (value: unknown) => { if (typeof value === 'number') numbers.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk) }
      walk(submission.answer)
      if (!results.has(run)) results.set(run, await analysis.reproduces(run, numbers, analysisBindings({ engine: engineLike, admin: evidence.context, world, archive }, evidence.context)))
    }
    const scored = score({ truth, answers: loadAnswers(input.answersFile), view: worldView(world), ...facts, baselines: loadBaselines(input.baselinesFile), reproducible: run => results.get(run) ?? null,
      independent: independentCheck(analysis) })
    return { schemaVersion: 3, identity: evidence.identity, modelSource: evidence.modelSource, tick: evidence.state.tick, score: scored, usage: evidence.usage, evidenceValid: evidence.evidenceValid, checks: evidence.checks }
  } finally { archive.close(); world.close() }
}

export async function reportStopped(input: Parameters<typeof reportStoppedWithLease>[0]) {
  const lease = acquireRunLease(resolve(input.directory), true)
  try {
    const publicManifest = join(resolve(input.directory), 'manifest.public.json')
    const stored = existsSync(publicManifest) ? z.object({ benchmarkVersion: z.enum(['v0.4', 'v0.5', 'v0.6']) }).parse(JSON.parse(readFileSync(publicManifest, 'utf8'))).benchmarkVersion : undefined
    if (stored && input.benchmarkVersion && stored !== input.benchmarkVersion) throw new Error('Report benchmark version differs from run')
    return await reportStoppedWithLease({ ...input, benchmarkVersion: input.benchmarkVersion ?? stored })
  } finally { lease.close() }
}

/** Standard dsh report profile entry, with output outside the stopped run. */
export async function apply(_ctx: object, input: { directory: string; output: string; truthFile: string; answersFile?: string; baselinesFile?: string; benchmarkVersion?: 'v0.4' | 'v0.5' | 'v0.6' }) {
  const config = z.object({ benchmarkVersion: z.enum(['v0.4', 'v0.5', 'v0.6']).optional(), directory: z.string(), output: z.string(), truthFile: z.string(), answersFile: z.string().optional(), baselinesFile: z.string().optional() }).strict().parse(input)
  const report = await reportStopped(config)
  writeFileSync(resolve(config.output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  if ('R' in report) console.log(JSON.stringify({ R: report.R, F: report.F, completionStatus: report.completionStatus }))
  else console.log(JSON.stringify({ S: report.score === null ? null : 'score' in report.score ? report.score.score : (report.score as { S: number }).S,
    status: 'status' in report ? report.status : 'completed', evidenceValid: report.evidenceValid }))
}
