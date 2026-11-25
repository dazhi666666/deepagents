/** Stage seals select the latest accepted submissions at an exact physical-world boundary. */
import { z } from 'zod'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { contentHash, digestSchema, frozenReferenceSchema, taskIdSchema, slotIdSchema, stageProfileSchema,
  submissionCutoff, tickSchema, type StageProfile, type SlotId, type TaskId } from './contracts.ts'
import { taskSlots, V06_TASK_IDS } from './registry.ts'
import { V06Records, type ResearchJournal } from './records.ts'
import { FactReader } from '../fact-reader.ts'
import { draftProgress } from './submission-drafts.ts'

const selectionSchema = z.object({ taskId: taskIdSchema, slotId: slotIdSchema, revision: z.number().int().positive(),
  acceptedSeq: z.number().int().positive(), payloadHash: digestSchema, references: z.array(frozenReferenceSchema) }).strict()
export const phaseSealSchema = z.object({ stage: z.enum(['baseline', 'final', 'horizon']), tick: tickSchema,
  protocolHash: digestSchema, previousSealHash: digestSchema.nullable(), worldHash: digestSchema,
  worldCursor: tickSchema, ledgerCursor: tickSchema, selections: z.array(selectionSchema),
  missing: z.array(z.object({ taskId: taskIdSchema, slotId: slotIdSchema, reason: z.enum(['baseline_missing', 'missing']) }).strict()),
  hash: digestSchema }).strict()
export type PhaseSeal = z.infer<typeof phaseSealSchema>
export interface BoundarySnapshot { worldHash: string; worldCursor: number; ledgerCursor: number }

/** Call after completing/reconciling operations at the boundary and before admitting the next phase. */
export class V06Stages {
  readonly profile: StageProfile
  private readonly facts: FactReader
  constructor(private readonly journal: ResearchJournal, private readonly context: OperationContext,
    profile: StageProfile, readonly protocolHash: string, private readonly tick: () => number,
    private readonly records: V06Records) {
    this.facts = new FactReader(journal, context)
    this.profile = stageProfileSchema.parse(profile)
    digestSchema.parse(protocolHash)
    const seals = this.seals()
    if (seals.length && this.tick() < seals.at(-1)!.tick) throw new Error('World precedes its persisted phase seal')
  }
  private schedule() {
    return [{ stage: 'baseline' as const, tick: this.profile.baselineTick },
      { stage: 'final' as const, tick: this.profile.finalTick }, { stage: 'horizon' as const, tick: this.profile.horizon }]
  }
  seals(): PhaseSeal[] {
    const seals = this.facts.read().filter(f => f.kind === 'mars-v06-seal').map(f => phaseSealSchema.parse(f.data))
    let previous: string | null = null
    for (const [i, seal] of seals.entries()) {
      const { hash, ...body } = seal, expected = this.schedule()[i]
      if (!expected || seal.stage !== expected.stage || seal.tick !== expected.tick || seal.protocolHash !== this.protocolHash ||
        seal.previousSealHash !== previous || contentHash(body) !== hash) throw new Error('Phase seal hash, order or protocol differs')
      previous = hash
    }
    return seals
  }
  nextBoundary(): number { return this.schedule()[this.seals().length]?.tick ?? this.profile.horizon }
  modelAdmissionClosed(): boolean { return this.tick() >= this.profile.finalTick || this.seals().some(s => s.stage === 'final') }
  /** No catch-up sealing: a skipped boundary is an infrastructure error, not a retrospective submission window. */
  synchronize(snapshot: BoundarySnapshot): PhaseSeal | null {
    const seals = this.seals(), next = this.schedule()[seals.length], now = tickSchema.parse(this.tick())
    if (!next || now < next.tick) return null
    if (now > next.tick) throw new Error(`World skipped unsealed stage boundary: ${next.tick}`)
    digestSchema.parse(snapshot.worldHash); tickSchema.parse(snapshot.worldCursor); tickSchema.parse(snapshot.ledgerCursor)
    const selections: z.infer<typeof selectionSchema>[] = [], missing: PhaseSeal['missing'] = []
    if (next.stage !== 'horizon') for (const taskId of V06_TASK_IDS) {
      const slotId: SlotId = next.stage
      if (!taskSlots(taskId, this.profile).includes(slotId)) continue
      const selected = this.records.latest(taskId, slotId)
      if (selected && selected.acceptedTick < next.tick) selections.push({ taskId, slotId,
        revision: selected.revision, acceptedSeq: selected.acceptedSeq, payloadHash: contentHash(selected.payload), references: selected.references })
      else missing.push({ taskId, slotId, reason: slotId === 'baseline' ? 'baseline_missing' : 'missing' })
    }
    const body = { stage: next.stage, tick: next.tick, protocolHash: this.protocolHash,
      previousSealHash: seals.at(-1)?.hash ?? null, ...snapshot, selections, missing }
    const seal = phaseSealSchema.parse({ ...body, hash: contentHash(body) })
    this.journal.recordFact(this.context, 'mars-v06-seal', seal)
    return seal
  }
  selected(taskId: TaskId, slotId: SlotId) { return this.seals().find(s => s.stage === slotId)?.selections.find(s => s.taskId === taskId) ?? null }
  /** Project public receipt metadata for slots whose submission deadlines are still open. */
  view() {
    const tick = this.tick(), seals = this.seals()
    const open = (['baseline', 'final'] as const).filter(slotId =>
      tick < submissionCutoff(this.profile, slotId) && !seals.some(seal => seal.stage === slotId))
    const submissions = open.length ? this.records.submissions() : []
    const predictions = open.length ? this.records.predictions() : []
    const progress = this.profile.researchWorkflow && open.length ? draftProgress(this.facts.read()) : undefined
    const openSlots = open.flatMap(slotId => V06_TASK_IDS.filter(taskId => taskSlots(taskId, this.profile).includes(slotId)).map(taskId => {
      const submission = submissions.findLast(s => s.taskId === taskId && s.slotId === slotId)
      const prediction = predictions.findLast(p => p.taskId === taskId && p.slotId === slotId)
      return { taskId, slotId, acceptBeforeTick: submissionCutoff(this.profile, slotId),
        ...(progress?.get(`${taskId}/${slotId}`) ?? {}),
        expectedRevision: submission?.revision ?? 0,
        accepted: submission ? { tick: submission.acceptedTick, actorId: submission.actorId } : null,
        latestPrediction: prediction ? { id: prediction.id, acceptedTick: prediction.acceptedTick,
          modelId: prediction.modelId ?? null, pipelineId: prediction.pipelineId ?? null } : null }
    }))
    return { profile: this.profile, tick, openSlots, phase: tick < this.profile.baselineTick ? 'research_baseline'
      : tick < this.profile.finalTick ? 'feedback_revision' : tick < this.profile.horizon ? 'validation' : 'ended',
      modelAdmissionClosed: tick >= this.profile.finalTick || seals.some(s => s.stage === 'final'),
      seals: seals.map(s => ({ stage: s.stage, tick: s.tick, hash: s.hash, selections: s.selections, missing: s.missing })) }
  }
}
