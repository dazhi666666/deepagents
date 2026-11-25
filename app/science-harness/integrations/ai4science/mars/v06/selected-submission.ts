/** Resolve caller-selected public references into the fields required by a formal submission. */
import { z } from 'zod'
import { evidenceSchema, identifier, slotIdSchema, taskIdSchema } from './contracts.ts'
import { referenceKinds, type referenceDirectory } from './reference-directory.ts'
import type { V06Records } from './records.ts'

const selection = z.object({ kind: z.enum(referenceKinds), id: identifier, purpose: evidenceSchema.shape.purpose.optional(), revision: evidenceSchema.shape.revision }).strict()
export const selectedSubmissionSchema = z.object({
  taskId: taskIdSchema, slotId: slotIdSchema, rejectionId: identifier.optional(), expectedRevision: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.json()).default({}), references: z.array(selection).max(128).default([]), evidence: z.array(evidenceSchema).max(128).default([])
}).strict()
const fields = { model: 'modelId', pipeline: 'pipelineId', prediction: 'predictionId', plan: 'planId', commitment: 'commitmentIds', response: 'responseIds' } as const
export function materializeSubmission(input: unknown, records: V06Records, pick: (query: Parameters<typeof referenceDirectory>[6]) => ReturnType<typeof referenceDirectory>,
  canonical: (id: string) => string, isEvidence: (id: string, revision?: number) => boolean) {
  const { taskId, slotId, expectedRevision, payload, references, evidence } = selectedSubmissionSchema.parse(input)
  const typedEvidence: z.infer<typeof evidenceSchema>[] = []
  const put = (field: string, id: string) => {
    const current = payload[field]
    if (field === 'commitmentIds' || field === 'responseIds') {
      const ids = z.array(identifier).parse(current ?? []); payload[field] = ids.includes(id) ? ids : [...ids, id]
    } else {
      if (current !== undefined && current !== id) throw new Error(`Conflicting selection for payload.${field}`)
      payload[field] = id
    }
  }
  const selected = references.map(ref => ({ ...ref, id: Object.hasOwn(fields, ref.kind) ? ref.id : canonical(ref.id) }))
  const rows = selected.length ? pick({ taskId, slotId, ids: selected.map(r => r.id), offset: 0, limit: selected.length * referenceKinds.length }).items : []
  const byKind = new Map(rows.map(row => [JSON.stringify([row.kind, row.id]), row]))
  for (const ref of selected) {
    const id = ref.id
    const row = byKind.get(JSON.stringify([ref.kind, id]))
    if (!row) throw new Error(`Public ${ref.kind} unavailable for ${taskId}/${slotId}: ${id}`)
    if (row.field === 'evidence') {
      if (!ref.purpose) throw new Error(`Select the scientific purpose of evidence ${id}`)
      typedEvidence.push(evidenceSchema.parse({ id, purpose: ref.purpose, ...(ref.revision === undefined ? {} : { revision: ref.revision }) }))
    } else {
      if (ref.purpose || ref.revision !== undefined) throw new Error(`Only observations and research notes take an evidence purpose or revision: ${id}`)
      put(row.field.slice('payload.'.length), id)
    }
  }
  if (typeof payload.predictionId === 'string' && payload.modelId === undefined && payload.pipelineId === undefined) {
    const p = records.predictions().find(p => p.id === payload.predictionId && p.taskId === taskId && p.slotId === slotId)
    if (p?.modelId) put('modelId', p.modelId)
    if (p?.pipelineId) put('pipelineId', p.pipelineId)
  }
  // Correct only an exact duplicate of a selected artifact. A real note with the same ID remains evidence.
  const artifactIds = new Set(Object.values(fields).flatMap(field => { const v = payload[field]; return Array.isArray(v) ? v.filter(x => typeof x === 'string') : typeof v === 'string' ? [v] : [] }))
  const observations = evidence.map(e => ({ ...e, id: canonical(e.id) })).filter(e => !artifactIds.has(e.id) || isEvidence(e.id, e.revision))
  return { taskId, slotId, expectedRevision, payload, evidence: [...observations, ...typedEvidence] }
}
