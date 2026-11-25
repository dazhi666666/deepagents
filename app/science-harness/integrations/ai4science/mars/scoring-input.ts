/** Builds scoring inputs from persisted facts and the physical world, for live snapshots and offline reports. */
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from './world.ts'
import type { CropState } from './base.ts'
import { archiveAnswersSchema, type ArchiveAnswers, type Truth } from './truth.ts'
import { evidenceSchema, type TaskId } from './deliverables.ts'
import type { Submission, WorldView } from './scoring-common.ts'
import type { IncidentReport } from './scoring.ts'
import type { EvidenceContext } from './scoring-progress.ts'
import type { AnalysisRegistry } from './analysis.ts'

export const submissionFact = z.object({ id: z.string(), taskId: z.string(), tick: z.number(), actorId: z.string(), requestKey: z.string(),
  answer: z.record(z.string(), z.unknown()), evidence: evidenceSchema })

/** Current physical view for scoring. */
export function worldView(world: MarsWorld): WorldView {
  const systems = world.observeSystems()
  return { lab: world.observe(), crops: systems.crops as CropState[], base: world.observeBase(), systemOps: systems.operations as WorldView['systemOps'],
    sampleConditions: systems.sampleConditions, sampleSources: systems.sampleSources, measurement: id => world.measurement(id) }
}
export function loadAnswers(path: string | undefined): ArchiveAnswers | null {
  return path && existsSync(path) ? archiveAnswersSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : null
}

/** Independent replication: two cited runs with different code whose outputs each contain at least half of the submitted numbers (relative 1e-3). */
export function independentCheck(analysis: AnalysisRegistry) {
  return (runIds: string[], values: number[]) => {
    if (!values.length) return false
    const records = runIds.map(id => analysis.get(id)).filter(record => record?.status === 'done')
    const covers = (output: unknown) => {
      const found: number[] = []
      const walk = (value: unknown) => { if (typeof value === 'number') found.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk) }
      walk(output)
      return values.filter(value => found.some(candidate => Math.abs(candidate - value) <= 1e-3 * Math.max(1, Math.abs(value)))).length >= values.length / 2
    }
    const hashes = new Set(records.filter(record => covers(record!.output)).map(record => record!.codeSha256))
    return hashes.size >= 2
  }
}

/** Facts recorded by the deliverable, incident and archive tools. */
export function collectFacts(engine: ExecutionEngine, admin: OperationContext, analysis: AnalysisRegistry) {
  const facts = engine.readFacts(admin)
  const submissions: Submission[] = facts.filter(fact => fact.kind === 'mars-deliverable-accepted').map(fact => {
    const value = submissionFact.parse(fact.data)
    return { ...value, taskId: value.taskId as TaskId }
  })
  const rejections = facts.filter(fact => fact.kind === 'mars-deliverable-rejected').length
  const reports: IncidentReport[] = facts.filter(fact => fact.kind === 'mars-incident-report')
    .map(fact => z.object({ tick: z.number(), entities: z.array(z.string()), actorId: z.string(), eventClass: z.string().optional(), rootCause: z.array(z.string()).optional() })
      .parse({ ...(fact.data as object), actorId: fact.actorId }))
  const readArtifacts = new Set(facts.filter(fact => fact.kind === 'mars-artifact-read').flatMap(fact => z.object({ artifactIds: z.array(z.string()) }).parse(fact.data).artifactIds))
  const archiveQueries = new Set(facts.filter(fact => fact.kind === 'mars-archive-query').map(fact => z.object({ queryId: z.string() }).parse(fact.data).queryId))
  const operations = new Map(engine.list(admin).map(operation => [operation.id, operation.artifacts.map(artifact => artifact.id)]))
  const evidence: EvidenceContext = { analysisRuns: analysis.ids(), archiveQueries, readArtifacts, artifactsOf: id => operations.get(id) ?? [] }
  return { submissions, rejections, reports, evidence }
}

export function loadBaselines(path: string | undefined) {
  if (!path || !existsSync(path)) return undefined
  return z.object({ null: z.number(), ref: z.number() }).parse(JSON.parse(readFileSync(path, 'utf8')))
}
export type { Truth }
