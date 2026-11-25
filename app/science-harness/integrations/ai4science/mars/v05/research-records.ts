/** Versioned Agent-authored research records. Claims are never certified as scientific truth. */
import { z } from 'zod'
import { canonicalJson, type Json, type OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'

const text = z.string().trim().min(1)
export const researchReferenceSchema = z.object({ id: text, revision: z.number().int().positive() }).strict()
export const evidenceReferenceSchema = z.object({ id: text, revision: z.number().int().positive().optional(),
  purpose: z.enum(['calibration', 'bias-study', 'historical', 'current-estimate', 'validation']), usedFields: z.array(text).default([]) }).strict()
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>
export type EvidenceResolver = (reference: EvidenceReference) => { availableAt: number } | null
export const researchPutSchema = z.object({ id: text, expectedRevision: z.number().int().nonnegative(),
  kind: z.enum(['study', 'claim', 'commitment']), project: z.enum(['PW', 'PG', 'PF', 'PX']),
  content: z.json(), basedOn: z.array(researchReferenceSchema).default([]), evidence: z.array(evidenceReferenceSchema).default([]),
  status: z.enum(['provisional', 'supported', 'needs_review', 'superseded', 'withdrawn', 'completed']).default('provisional'),
  reason: text }).strict()
export const researchRecordSchema = researchPutSchema.omit({ expectedRevision: true }).extend({ schemaVersion: z.literal(1), revision: z.number().int().positive(),
  createdBy: text, updatedBy: text, createdTick: z.number().int().nonnegative(), updatedTick: z.number().int().nonnegative(), availableAt: z.number().int().nonnegative() }).strict()
export type ResearchRecord = z.infer<typeof researchRecordSchema>
export type ResearchPut = z.input<typeof researchPutSchema>
const receiptSchema = z.object({ actor: text, key: text, input: text, record: researchRecordSchema }).strict()

export class V05ResearchRecords {
  constructor(private readonly engine: ExecutionEngine, private readonly context: OperationContext,
    private readonly tick: () => number, private readonly resolveEvidence?: EvidenceResolver,
    private readonly factKind = 'mars-v05-research') {}

  private receipts() { return this.engine.readFacts(this.context).filter(fact => fact.kind === this.factKind).map(fact => receiptSchema.parse(fact.data)) }
  history(id: string): ResearchRecord[] { return this.receipts().map(value => value.record).filter(record => record.id === id) }
  read(id: string, revision?: number): ResearchRecord | null {
    const rows = this.history(id)
    return (revision === undefined ? rows.at(-1) : rows.find(row => row.revision === revision)) ?? null
  }
  list(): ResearchRecord[] {
    const records = new Map<string, ResearchRecord>()
    for (const receipt of this.receipts()) records.set(receipt.record.id, receipt.record)
    return [...records.values()]
  }
  search(query: string, project?: ResearchRecord['project']): ResearchRecord[] {
    const needle = query.toLocaleLowerCase()
    return this.list().filter(record => (!project || record.project === project) && canonicalJson(z.json().parse(record)).toLocaleLowerCase().includes(needle))
  }
  /** Check references against host visibility, never against Agent-supplied timestamps. */
  checkEvidence(references: EvidenceReference[], now = this.tick()) {
    for (const reference of references) {
      const found = this.resolveEvidence?.(reference)
      if (!found || !Number.isInteger(found.availableAt) || found.availableAt < 0 || found.availableAt > now)
        throw new Error(`Evidence unavailable at this tick: ${reference.id}`)
    }
  }
  put(key: string, input: ResearchPut): ResearchRecord {
    text.parse(key)
    const request = researchPutSchema.parse(input), canonical = canonicalJson(z.json().parse(request)), receipts = this.receipts()
    const duplicate = receipts.find(value => value.actor === this.context.actorId && value.key === key)
    if (duplicate) {
      if (duplicate.input !== canonical) throw new Error('Request key already used with different input')
      return duplicate.record
    }
    const now = z.number().int().nonnegative().parse(this.tick()), prior = this.read(request.id)
    if ((prior?.revision ?? 0) !== request.expectedRevision) throw new Error('Research revision changed; read before editing')
    if (prior && (prior.kind !== request.kind || prior.project !== request.project)) throw new Error('Record kind and project are immutable')
    for (const reference of request.basedOn) {
      const target = this.read(reference.id, reference.revision)
      if (!target || target.availableAt > now) throw new Error(`Research dependency unavailable: ${reference.id}@${reference.revision}`)
    }
    this.checkEvidence(request.evidence, now)
    const { expectedRevision, ...body } = request
    const record = researchRecordSchema.parse({ ...body, schemaVersion: 1, revision: expectedRevision + 1,
      createdBy: prior?.createdBy ?? this.context.actorId, updatedBy: this.context.actorId,
      createdTick: prior?.createdTick ?? now, updatedTick: now, availableAt: now })
    const receipt = receiptSchema.parse({ actor: this.context.actorId, key, input: canonical, record })
    this.engine.recordFact(this.context, this.factKind, receipt as Json)
    return record
  }
}

