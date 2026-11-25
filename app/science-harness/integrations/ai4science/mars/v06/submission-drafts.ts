/** A team's editable slot and rejected attempts live outside the scored submission ledger. */
import { z } from 'zod'
import { FactReader, type FactSource } from '../fact-reader.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { contentHash, identifier, submissionCutoff, slotIdSchema, taskIdSchema, tickSchema, type StageProfile, type Submission } from './contracts.ts'
import type { V06Records } from './records.ts'

const slot = z.object({ taskId: taskIdSchema, slotId: slotIdSchema })
const revision = z.number().int().nonnegative()
const body = z.record(z.string(), z.json())
const patchSchema = z.object({ removePayloadFields:z.array(identifier).max(32).optional(), payload: body.optional(), evidence: z.array(z.json()).max(128).optional(), expectedRevision: revision.optional(), rejectionId: identifier.optional() }).strict()
const evidenceChecks = z.array(z.object({ group:z.string(), eligible:z.boolean(), missing:z.array(z.string()) }))
const draftSchema = slot.extend({ revision, actorId: identifier, tick: tickSchema, request: body, problem: z.string().nullable(), evidenceChecks:evidenceChecks.optional() })
const rejectionSchema = slot.extend({ id: identifier, actorId: identifier, tick: tickSchema, request: body, problem: z.string() })
export type DraftSlot = z.infer<typeof slot>
type Draft = z.infer<typeof draftSchema>
const saveRow = z.object({ key: identifier, fingerprint: identifier, result: draftSchema })
export function publicProblem(error: unknown) {
  const text = error instanceof z.ZodError ? error.issues.map(i => `${i.path.map(String).join('.') || 'input_json'}: ${i.message}`).join('\n') : error instanceof Error ? error.message : String(error)
  return text.slice(0, 2400)
}

type SlotProgress = { draft?: Pick<Draft,'revision'|'tick'|'actorId'|'problem'>; rejection?: {id:string; tick:number; actorId:string} }
/** Compact, open-slot progress for the coordinator and for resumption after compaction. */
export function draftProgress(facts: ReturnType<FactReader['read']>) {
  const slots = new Map<string,SlotProgress>()
  for (const f of facts) {
    if (f.kind !== 'mars-v06-draft' && f.kind !== 'mars-v06-rejection') continue
    if (f.kind === 'mars-v06-draft') {
      const { result } = saveRow.parse(f.data), key = `${result.taskId}/${result.slotId}`
      slots.set(key, { ...slots.get(key), draft:{revision:result.revision,tick:result.tick,actorId:result.actorId,problem:result.problem?.slice(0, 240) ?? null} })
    } else {
      const r = rejectionSchema.parse(f.data), key = `${r.taskId}/${r.slotId}`
      slots.set(key, { ...slots.get(key), rejection:{id:r.id,tick:r.tick,actorId:r.actorId} })
    }
  }
  return slots
}

export class SubmissionDrafts {
  private readonly facts: FactReader
  constructor(private readonly journal: FactSource, private readonly grant: OperationContext, private readonly tick: () => number,
    private readonly profile: StageProfile, private readonly records: V06Records,
    private readonly inspectEvidence?: (task: Submission['taskId'], draft: Pick<Submission,'acceptedTick'|'evidence'>, slot: Submission['slotId']) => z.infer<typeof evidenceChecks>) {
    this.facts = new FactReader(journal, grant)
  }

  private saves() { return this.facts.read().filter(f => f.kind === 'mars-v06-draft').map(f => saveRow.parse(f.data)) }
  private attempts(s: DraftSlot) {
    return this.facts.read().filter(f => f.kind === 'mars-v06-rejection').map(f => rejectionSchema.parse(f.data))
      .filter(a => a.taskId === s.taskId && a.slotId === s.slotId)
  }
  rejected(s: DraftSlot, id: string) {
    const attempt = this.attempts(s).find(r => r.id === id)
    if (!attempt) throw new Error('Rejected attempt unavailable in this slot')
    return attempt.request
  }
  read(s: DraftSlot) {
    const latest = this.saves().findLast(r => r.result.taskId === s.taskId && r.result.slotId === s.slotId)?.result ?? null
    const accepted = this.records.latest(s.taskId, s.slotId)
    return { draft: latest, lastRejection: this.attempts(s).at(-1) ?? null, acceptBeforeTick: submissionCutoff(this.profile, s.slotId),
      currentTick: this.tick(), accepted: accepted ? { revision: accepted.revision, acceptedTick: accepted.acceptedTick, actorId: accepted.actorId } : null }
  }
  rememberFailure(key: string, request: Record<string, unknown>, problem: string) {
    const target = slot.safeParse(request)
    if (!target.success || this.tick() >= submissionCutoff(this.profile, target.data.slotId) || Buffer.byteLength(JSON.stringify(request)) > 32768) return null
    const id = contentHash([this.grant.actorId, key, request]), prior = this.attempts(target.data)
    if (prior.some(r => r.id === id)) return null
    const result = rejectionSchema.parse({ ...target.data, id, actorId: this.grant.actorId, tick: this.tick(), request, problem })
    this.journal.recordFact(this.grant, 'mars-v06-rejection', result)
    return result
  }
  save(s: DraftSlot, expected: number, key: string, input: unknown) {
    const patch = patchSchema.parse(input), fingerprint = contentHash({ ...s, expected, patch })
    const saved = this.saves(), prior = saved.find(r => r.key === key && r.result.actorId === this.grant.actorId)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('Draft request key already used with different input')
      return { draft: prior.result, replay: true }
    }
    const view = this.read(s)
    if (this.tick() >= view.acceptBeforeTick) throw new Error(`Draft slot closed at ${view.acceptBeforeTick}`)
    if ((view.draft?.revision ?? 0) !== expected) throw new Error('Draft revision changed. Read the shared slot before editing.')
    const rejection = patch.rejectionId ? this.attempts(s).find(r => r.id === patch.rejectionId) : null
    if (patch.rejectionId && !rejection) throw new Error('Rejected attempt unavailable in this slot')
    const base = rejection?.request ?? view.draft?.request
    const basePayload = body.safeParse(base?.payload)
    const retained = Object.entries(basePayload.success ? basePayload.data : {}).filter(([field]) => !patch.removePayloadFields?.includes(field))
    const payload = { ...Object.fromEntries(retained), ...patch.payload }
    if (typeof patch.payload?.predictionId === 'string') {
      const prediction = this.records.predictions().find(p => p.id === patch.payload!.predictionId && p.taskId === s.taskId && p.slotId === s.slotId)
      if (prediction && !Object.hasOwn(patch.payload, 'modelId') && !Object.hasOwn(patch.payload, 'pipelineId')) {
        delete payload.modelId; delete payload.pipelineId
        if (prediction.modelId) payload.modelId = prediction.modelId
        if (prediction.pipelineId) payload.pipelineId = prediction.pipelineId
      }
    }
    const request = { ...s, expectedRevision: patch.expectedRevision ?? base?.expectedRevision ?? view.accepted?.revision ?? 0,
      payload, evidence: patch.evidence ?? base?.evidence ?? [] }
    if (Buffer.byteLength(JSON.stringify(request)) > 32768) throw new Error('Draft exceeds 32 KiB')
    let problem: string | null = null
    let checks: z.infer<typeof evidenceChecks> | undefined
    try {
      const checked = this.records.check(request)
      checks = this.inspectEvidence?.(s.taskId, { acceptedTick: checked.now, evidence: checked.request.evidence }, s.slotId)
    } catch (error) { problem = publicProblem(error) }
    const draft: Draft = draftSchema.parse({ ...s, revision: expected + 1, actorId: this.grant.actorId, tick: this.tick(), request, problem, ...(checks ? {evidenceChecks:checks} : {}) })
    this.journal.recordFact(this.grant, 'mars-v06-draft', z.json().parse(saveRow.parse({ key, fingerprint, result: draft })))
    return { draft, replay: false }
  }
  submit(s: DraftSlot, expected: number, key: string) {
    // Replay of an accepted request must survive a newer draft. New writes must target the current revision.
    const rows = this.saves().filter(r => r.result.taskId === s.taskId && r.result.slotId === s.slotId)
    const selected = rows.find(r => r.result.revision === expected)?.result
    if (!selected) throw new Error('Unknown draft revision')
    const binding = contentHash({ tool: 'research_draft', actor: this.grant.actorId, key })
    const prior = this.facts.read().filter(f => f.kind === 'mars-v06-record').map(f => z.object({ operation: z.string(), actorId: z.string(), key: z.string(), input: z.string() }).parse(f.data))
      .find(r => r.operation === 'submission' && r.actorId === this.grant.actorId && r.key === binding)
    if (!prior && rows.at(-1)?.result.revision !== expected) throw new Error('Draft revision changed. Read the shared slot before submitting.')
    return { ...this.records.submit(binding, selected.request, selected.revision), accepted: true, draftRevision: selected.revision }
  }
}
