/** Host-owned observation journal and offline evidence collection. No answer can certify its own evidence. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { canonicalJson, type Json, type OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { AnalysisRegistry } from '../analysis.ts'
import type { MarsWorld } from '../world.ts'
import { modelArtifactSchema, predictionCommitSchema } from './predictions.ts'
import { researchRecordSchema } from './research-records.ts'
import type { EvaluationInput, EvidenceFact, Observation } from './evaluator.ts'

const text = z.string().trim().min(1), tick = z.number().int().nonnegative()
export const observationInputSchema = z.object({ objectiveId: text, value: z.json(),
  evidence: z.array(z.object({ id: text, purpose: text }).strict()).default([]), predictionId: text.optional() }).strict()
export const observationSchema = observationInputSchema.extend({ id: text, submittedAt: tick, actorId: text }).strict()
const receiptSchema = z.object({ key: text, canonical: text, observation: observationSchema }).strict()
export class V05Observations {
  constructor(private readonly engine: ExecutionEngine, private readonly context: OperationContext, private readonly tick: () => number,
    private readonly resolveEvidence?: (id: string) => { availableAt: number } | null) {}
  list() { return this.engine.readFacts(this.context).filter(f => f.kind === 'mars-v05-observation').map(f => receiptSchema.parse(f.data).observation) }
  submit(key: string, input: z.input<typeof observationInputSchema>) {
    text.parse(key)
    const request = observationInputSchema.parse(input), canonical = canonicalJson(request as Json)
    const receipts = this.engine.readFacts(this.context).filter(f => f.kind === 'mars-v05-observation').map(f => receiptSchema.parse(f.data))
    const prior = receipts.find(r => r.observation.actorId === this.context.actorId && r.key === key)
    if (prior) { if (prior.canonical !== canonical) throw new Error('Request key already used with different input'); return prior.observation }
    const now = tick.parse(this.tick())
    for (const evidence of request.evidence) {
      const fact = this.resolveEvidence?.(evidence.id)
      if (!fact || !Number.isSafeInteger(fact.availableAt) || fact.availableAt < 0 || fact.availableAt > now) throw new Error(`Evidence unavailable: ${evidence.id}`)
    }
    if (request.predictionId) {
      const commit = this.engine.readFacts(this.context).filter(f => f.kind === 'mars-v05-prediction')
        .map(f => predictionCommitSchema.parse((f.data as { result: Json }).result)).find(p => p.id === request.predictionId)
      if (!commit || commit.lockedTick > now) throw new Error('Prediction commitment unavailable')
    }
    const observation = observationSchema.parse({ ...request, id: `v05-answer-${randomUUID()}`, submittedAt: now, actorId: this.context.actorId })
    this.engine.recordFact(this.context, 'mars-v05-observation', { key, canonical, observation } as Json)
    return observation
  }
}

const metadata = (value: unknown): Record<string, string | number | boolean> => value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v))) as Record<string, string | number | boolean> : {}

/** Takes authorized engine/analysis/public-world views; no truth, scoring answers or submitted evidence status. */
export function collectEvaluationInput(context: { engine: ExecutionEngine; context: OperationContext; analysis: AnalysisRegistry;
  world?: Pick<MarsWorld, 'observe'> }): EvaluationInput {
  const { engine, analysis } = context, grant = context.context
  const journal = engine.readFacts(grant)
  const operations = engine.list(grant), completed = new Map<string, number>()
  for (const raw of engine.events(grant)) {
    const event = raw as { operation_id?: string; data_json?: string }
    if (!event.operation_id || !event.data_json) continue
    const data = JSON.parse(event.data_json) as { state?: string; logicalTick?: number }
    if (data.state === 'succeeded' && Number.isSafeInteger(data.logicalTick) && !completed.has(event.operation_id)) completed.set(event.operation_id, data.logicalTick!)
  }
  const facts: EvidenceFact[] = []
  for (const operation of operations) {
    const at = completed.get(operation.id)
    if (operation.state !== 'succeeded' || at === undefined) continue // old journals without logical time cannot certify evidence
    const meta = { ...metadata(operation.input), provider: operation.providerId }
    facts.push({ id: operation.id, kind: 'operation', availableAt: at, completedAt: at, state: 'succeeded', metadata: meta })
    for (const artifact of operation.artifacts) facts.push({ id: artifact.id, kind: 'artifact', availableAt: at, completedAt: at, state: 'succeeded', metadata: { ...meta, sha256: artifact.sha256, operationId: operation.id } })
  }
  for (const id of analysis.ids()) {
    const run = analysis.get(id)
    const publication = journal.filter(f => f.kind === 'mars-v05-analysis-published')
      .map(f => z.object({ id: text, tick }).parse(f.data)).find(f => f.id === id)
    const accesses = (run as typeof run & { dataAccesses?: { kind: string; id: string }[] })?.dataAccesses ?? []
    if (run?.status === 'done' && publication && publication.tick >= run.asOfTick) facts.push({ id, kind: 'analysis', availableAt: publication.tick, completedAt: publication.tick, state: 'succeeded', metadata: {
      actorId: run.actorId, codeHash: run.codeSha256, hasDataAccess: accesses.length > 0,
      accessedIds: JSON.stringify([...new Set(accesses.map(a => a.id))]),
    } })
  }
  for (const result of context.world?.observe().results ?? []) {
    if (result.completedTick === null || result.completedTick === undefined) continue
    facts.push({ id: result.id, kind: 'measurement', availableAt: result.completedTick, completedAt: result.completedTick, state: 'succeeded', metadata: metadata(result) })
  }
  const models = journal.filter(f => f.kind === 'mars-v05-model').map(f => modelArtifactSchema.parse((f.data as { result: Json }).result))
  const research = journal.filter(f => f.kind === 'mars-v05-research').map(f => researchRecordSchema.parse((f.data as { record: Json }).record))
  const predictions = journal.filter(f => f.kind === 'mars-v05-prediction').map(f => {
    const commit = predictionCommitSchema.parse((f.data as { result: Json }).result), model = models.find(m => m.id === commit.modelId && m.hash === commit.modelHash)
    if (!model) throw new Error('Prediction references missing or different immutable model')
    return { id: commit.id, target: commit.target, lockedAt: commit.lockedTick, modelHash: commit.modelHash,
      dependencyAvailableAt: [model.createdTick, ...model.basedOn.map(ref => {
        const record = research.find(r => r.id === ref.id && r.revision === ref.revision)
        if (!record) throw new Error('Model dependency missing from immutable journal')
        return record.availableAt
      })] }
  })
  const observations: Observation[] = journal.filter(f => f.kind === 'mars-v05-observation').map(f => receiptSchema.parse(f.data).observation)
  return { facts, predictions, observations }
}
