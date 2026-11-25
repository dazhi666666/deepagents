/** Agent-facing v0.3 tools: deliverables, incident reports, telemetry, archive SQL and the analysis runtime. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { Artifacts } from '../../../../science-harness/integrations/ai4science/platform/artifacts.ts'
import type { Json, OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from './world.ts'
import type { MarsArchive } from './archive.ts'
import type { AnalysisBindings, AnalysisRegistry } from './analysis.ts'
import { answerSchemas, dutyPeriod, dutySlot, dutyWindow, evidenceSchema, isDuty, nextDutyWindow, type DutyId, type TaskId } from './deliverables.ts'
import { EVENT_CLASSES } from './scoring.ts'
import { Refs } from './refs.ts'
import { tasksForLoad } from './mission.ts'
import { minimumEvidence } from './scoring-progress.ts'
import { worldView } from './scoring-input.ts'

type Register = (name: string, description: string, parameters: ParameterSchemaSpec, body: (args: Record<string, unknown>, agent: Agent, signal: AbortSignal) => unknown | Promise<unknown>) => void
export interface V2ToolContext {
  register: Register; access: (agent: Agent, tool: string) => OperationContext; engine: ExecutionEngine; admin: OperationContext
  world: MarsWorld; archive: MarsArchive; analysis: AnalysisRegistry; load: string; refs: Refs
}

const id = { type: 'string', required: true } as const
const MAX_OUTPUT = 20000
const clip = (value: unknown) => { const text = JSON.stringify(value) ?? 'null'; return text.length <= MAX_OUTPUT ? value : { truncated: true, preview: text.slice(0, MAX_OUTPUT), bytes: text.length } }

/** Bindings for analysis programs; telemetry never extends past the recorded tick. readArtifact accepts short artifact
 * refs (ar-N) as tool outputs show them, and reports each read so live runs count as having read the artifact.
 */
export function analysisBindings(context: Pick<V2ToolContext, 'engine' | 'admin' | 'world' | 'archive'>, grant: OperationContext,
  onRead?: (artifactId: string) => void): (asOf: number) => AnalysisBindings {
  const artifacts = new Artifacts(context.engine)
  const resolve = (artifactId: string) => {
    const short = /^ar-(\d+)$/.exec(artifactId)
    return short ? artifacts.list(grant)[Number(short[1]) - 1]?.id ?? artifactId : artifactId
  }
  return asOf => ({
    readArtifact: artifactId => {
      const read = artifacts.read(grant, resolve(artifactId))
      onRead?.(read.artifact.id)
      return z.json().parse(JSON.parse(read.content))
    },
    telemetry: (channels, from, to) => z.json().parse(context.world.telemetry(channels, Math.max(0, from), Math.min(to, asOf), 100000)),
    archiveSql: sql => z.json().parse(context.archive.sqlAll(sql)),
    readRaw: ref => {
      const world = context.world, refs = new Refs(world), id = refs.resolve(ref.trim()), lab = world.observe(), systems = world.observeSystems()
      const short = (value: string) => refs.shortOf(value) ?? value
      const markRead = (operationId: string) => { if (onRead) for (const artifact of context.engine.get(grant, operationId).artifacts) onRead(artifact.id) }
      const result = lab.results.find(value => value.id === id) ?? lab.results.find(value => value.operationId === id)
      if (result) {
        let source: string | null = null, root = result.sampleId
        for (let sampleId: string | undefined = result.sampleId, depth = 0; sampleId && depth < 8; depth++) {
          if (systems.sampleSources[sampleId]) { source = systems.sampleSources[sampleId]!; root = sampleId; break }
          sampleId = lab.samples.find(sample => sample.id === sampleId)?.parentId
        }
        markRead(result.operationId)
        return z.json().parse({ result: short(result.id), method: result.methodId, methodVersion: result.methodVersion, source, sample: short(result.sampleId),
          sampledTick: (systems.sampleConditions[root] as { tick?: number } | undefined)?.tick ?? null,
          startedTick: lab.operations.find(value => value.id === result.operationId)?.acceptedTick ?? null, completedTick: result.completedTick ?? null,
          measurement: world.measurement(result.id), raw: world.rawFor(result.id) })
      }
      const scan = systems.operations.find(value => value.id === id && value.state === 'succeeded' && (value.command as { action?: string }).action === 'scan')
      if (scan) {
        markRead(scan.id)
        return z.json().parse({ operation: short(scan.id), ...(scan.result as Record<string, Json>), raw: world.rawFor(`scan:${scan.id}`) })
      }
      throw new Error(`readRaw takes a laboratory result (r-N) or a finished greenhouse scan (so-N); ${ref} is neither`)
    },
  })
}

export function installV2Tools(context: V2ToolContext) {
  const { register, access, engine, world, archive, analysis, refs } = context
  const tasks = new Set<string>(tasksForLoad(context.load))
  /** The open window, or the next one, so a rejection tells the Agent where a submission does count. */
  const dutyWindowInfo = (task: DutyId, load: string, horizon: number, tick: number) => {
    const open = dutySlot(task, load, tick, horizon)
    const window = open === null ? nextDutyWindow(task, load, horizon, tick) : { slot: open, from: dutyWindow(task, load, open, horizon)[0], to: dutyWindow(task, load, open, horizon)[1] }
    if (!window) return { open: false, period: dutyPeriod(task, load), acceptsUntilTick: null }
    return { open: open !== null, slot: window.slot, from: window.from, acceptsUntilTick: window.to - 1, period: dutyPeriod(task, load) }
  }
  const check = (agent: Agent, grant: OperationContext, taskId: string, answerJson: unknown, evidenceJson: unknown) => {
    const problems: string[] = []
    let answer: Record<string, unknown> = {}, evidence = evidenceSchema.parse({})
    if (!tasks.has(taskId)) problems.push(`Task ${taskId} is not part of this mission (use the task IDs in mission_read)`)
    else {
      let parsedJson: unknown, evidenceValue: unknown
      try { parsedJson = JSON.parse(String(answerJson)) } catch { problems.push('answer_json is not valid JSON') }
      try { evidenceValue = JSON.parse(String(evidenceJson)) } catch { problems.push('evidence_json is not valid JSON') }
      if (!problems.length) {
        const parsedAnswer = answerSchemas[taskId as TaskId].safeParse(parsedJson)
        if (!parsedAnswer.success) problems.push(`Answer schema: ${parsedAnswer.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
        else answer = parsedAnswer.data as Record<string, unknown>
        const parsedEvidence = evidenceSchema.safeParse(evidenceValue)
        if (!parsedEvidence.success) problems.push('Evidence must be an object of string arrays: resultIds, artifactIds, operationIds, archiveQueryIds, analysisRunIds')
        else evidence = { ...parsedEvidence.data, resultIds: parsedEvidence.data.resultIds.map(value => refs.resolve(value)),
          artifactIds: parsedEvidence.data.artifactIds.map(value => refs.resolve(value)),
          operationIds: parsedEvidence.data.operationIds.map(value => refs.resolve(value)) }
      }
    }
    if (!problems.length) {
      const reads = new Set(engine.readFacts(context.admin).filter(fact => fact.kind === 'mars-artifact-read').flatMap(fact => z.object({ artifactIds: z.array(z.string()) }).parse(fact.data).artifactIds))
      const operations = new Map(engine.list(context.admin).map(operation => [operation.id, operation]))
      const lab = world.observe()
      for (const resultId of evidence.resultIds) {
        const result = lab.results.find(value => value.id === resultId)
        if (!result) { problems.push(`Unknown result ${resultId} (use the r-N refs shown in tool outputs)`); continue }
        if (!(operations.get(result.operationId)?.artifacts ?? []).some(artifact => reads.has(artifact.id))) problems.push(`Read the artifact of result ${refs.shortOf(resultId) ?? resultId} (mars_result or artifact_read) before citing it`)
      }
      const systemIds = new Set(world.observeSystems().operations.map(op => op.id))
      for (const operationId of evidence.operationIds) if (!operations.has(operationId) && !systemIds.has(operationId)) problems.push(`Unknown operation ${operationId}`)
      for (const runId of evidence.analysisRunIds) if (!analysis.get(runId)) problems.push(`Unknown analysis run ${runId}`)
      const known = archive.knownQueries(), facts = new Set(engine.readFacts(context.admin).filter(fact => fact.kind === 'mars-archive-query').map(fact => String((fact.data as { queryId: string }).queryId)))
      for (const queryId of evidence.archiveQueryIds) if (!known.has(queryId) && !facts.has(queryId)) problems.push(`Unknown archive query ${queryId}`)
      const tick = world.observe().tick
      problems.push(...minimumEvidence(taskId as TaskId, evidence, worldView(world), { tick, load: context.load, horizon: world.horizon,
        analysisTick: runId => analysis.get(runId)?.asOfTick, answered: Object.keys(answer).length }))
    }
    void agent; void grant
    const tick = world.observe().tick
    const slot = isDuty(taskId) ? dutySlot(taskId, context.load, tick, world.horizon) : null
    const duty = isDuty(taskId) && tasks.has(taskId) ? dutyWindowInfo(taskId, context.load, world.horizon, tick) : null
    return { problems, answer, evidence, tick, slot, duty }
  }
  register('deliverable_check', 'Free dry run of deliverable_submit: runs every public check (schema, evidence references, minimum evidence, duty window) and reports problems. Nothing is recorded or scored.',
    { task_id: id, answer_json: id, evidence_json: id }, (args, agent) => {
      const grant = access(agent, 'deliverable_check')
      const result = check(agent, grant, String(args.task_id), args.answer_json, args.evidence_json)
      return { wouldAccept: result.problems.length === 0, problems: result.problems, tick: result.tick, ...(result.duty ? { dutyWindow: result.duty } : {}) }
    })
  register('deliverable_submit', 'Submit a deliverable (duty D1-D3, milestone W/G/F/A, integration X). answer_json follows the task schema in mission_read; evidence_json lists resultIds, artifactIds, operationIds, archiveQueryIds and analysisRunIds (short refs r-12, op-8, so-5, ar-4, a-0017, q-0042 are accepted). Public checks run now; correctness is only scored at the end. Use deliverable_check first; rejected submissions cost nothing but time.',
    { request_key: id, task_id: id, answer_json: id, evidence_json: id }, (args, agent) => {
      const grant = access(agent, 'deliverable_submit'), taskId = String(args.task_id), requestKey = String(args.request_key)
      const prior = engine.readFacts(grant).find(fact => ['mars-deliverable-accepted', 'mars-deliverable-rejected'].includes(fact.kind) && fact.actorId === grant.actorId &&
        z.object({ requestKey: z.string() }).passthrough().parse(fact.data).requestKey === requestKey)
      if (prior) return { duplicate: true, kind: prior.kind, record: prior.data }
      const { problems, answer, evidence, tick, slot, duty } = check(agent, grant, taskId, args.answer_json, args.evidence_json)
      const record = { id: `deliverable-${randomUUID()}`, taskId, tick, actorId: grant.actorId, requestKey, answer, evidence, ...(slot === null ? {} : { slot }) }
      if (problems.length) { engine.recordFact(grant, 'mars-deliverable-rejected', z.json().parse({ ...record, problems })); return { accepted: false, problems, ...(duty ? { dutyWindow: duty } : {}) } }
      engine.recordFact(grant, 'mars-deliverable-accepted', z.json().parse(record))
      return { accepted: true, submissionId: record.id, tick: record.tick, ...(slot === null ? {} : { dutySlot: slot }), note: 'Correctness is scored against hidden truth at the end of the time window.' }
    })
  register('deliverable_status', 'List accepted and rejected deliverable submissions so far (no correctness information).', {}, () => {
    const facts = engine.readFacts(context.admin).filter(fact => fact.kind.startsWith('mars-deliverable-'))
    return facts.map(fact => ({ kind: fact.kind, ...(fact.data as Record<string, Json>), answer: undefined }))
  })
  register('incident_report', `Report an anomaly you detected: affected entity IDs (devices, chambers, crops, modules, lots, energy), event_class (${EVENT_CLASSES.join(', ')}), root_cause tokens (e.g. inlet/membrane/seal for water contamination, "incubator-2:temperature" for sensor drift, the index crop for a pathogen, "incubator-3:duct" for a leak, the recalled lot ID), and actions taken. Earlier, accurate reports raise the crisis score.`,
    { entities: { type: 'array', items: { type: 'string' }, required: true }, event_class: { type: 'string', enum: [...EVENT_CLASSES] }, root_cause: { type: 'array', items: { type: 'string' } },
      category: { type: 'string' }, suspected_cause: { type: 'string' }, actions: { type: 'string' } }, (args, agent) => {
      const grant = access(agent, 'incident_report')
      const report = { tick: world.observe().tick, entities: z.array(z.string()).min(1).parse(args.entities),
        ...(args.event_class === undefined ? {} : { eventClass: z.enum(EVENT_CLASSES).parse(args.event_class) }),
        rootCause: z.array(z.string()).optional().parse(args.root_cause) ?? [],
        category: String(args.category ?? args.event_class ?? ''), suspectedCause: String(args.suspected_cause ?? ''), actions: String(args.actions ?? '') }
      engine.recordFact(grant, 'mars-incident-report', z.json().parse(report))
      return { recorded: true, tick: report.tick }
    })
  register('telemetry_query', 'Read sensor telemetry channels over a tick range (downsampled to <= 2000 points per channel). Call with no channels to list available channels.',
    { channels: { type: 'array', items: { type: 'string' } }, from_tick: { type: 'integer' }, to_tick: { type: 'integer' } }, args => {
      const channels = z.array(z.string()).optional().parse(args.channels)
      if (!channels?.length) return { channels: world.telemetryChannels() }
      const now = world.observe().tick
      return clip(world.telemetry(channels, Number(args.from_tick ?? Math.max(0, now - 200)), Math.min(Number(args.to_tick ?? now), now)))
    })
  const logQuery = (agent: Agent, result: { queryId: string }) => { engine.recordFact(access(agent, 'archive_sql'), 'mars-archive-query', { queryId: result.queryId }); return result }
  register('archive_sql', 'Run one read-only SELECT/WITH statement over the historical archive (tables: sensors, corrections, maintenance, experiments, documents, lots, lot_qc, reference_checks, incidents, chromatograms). Returns at most 500 rows and a short queryId (q-NNNN) to cite as evidence.',
    { sql: id }, (args, agent) => clip(logQuery(agent, archive.sql(String(args.sql)))))
  register('archive_schema', 'Describe archive tables and columns.', {}, () => archive.schema())
  register('analysis_run', 'Run a JavaScript/TypeScript async function body in an isolated process. Available async bindings: readRaw(ref) -> raw data of a lab result r-N (chromatogram or hyperspectral cube, with method, methodVersion, source, sampledTick, startedTick, completedTick and measurement incl. calibrationAgeTicks) or of a greenhouse scan so-N (values and cubes); readArtifact(id) -> parsed JSON of an artifact (ar-N); telemetry(channels, fromTick, toTick) -> {channel: [[tick, value|null], ...]}; archiveSql(sql) -> rows. Synchronous helper: chromatogram(rawOrReadRawOutput) -> {doc, lubricant, internalStandard}, the lab peak fit (DOC 5.1 min and lubricant 5.4 min peaks, instrument units before calibration correction). Use console.log for notes; the return value is the output. 30 s limit. The returned short runId (a-NNNN) can be cited as evidence; at scoring the program is re-run and must reproduce the submitted numbers.',
    { code: id }, async (args, agent) => {
      const grant = access(agent, 'analysis_run')
      const record = await analysis.run(grant.actorId, world.observe().tick, String(args.code), analysisBindings(context, grant,
        artifactId => engine.recordFact(grant, 'mars-artifact-read', { artifactIds: [artifactId], tick: world.observe().tick })))
      return { runId: record.id, status: record.status, error: record.error, output: clip(record.output), logs: clip(record.logs.slice(-50)) }
    })
}
