/** Resolve public research entities without confusing note revisions with immutable artifact IDs. */
import { z } from 'zod'
import type { V05ResearchRecords } from '../v05/research-records.ts'
import type { V06Records } from './records.ts'
import type { V06Actions } from './actions.ts'
import { identifier, taskIdSchema, slotIdSchema } from './contracts.ts'

export const researchReadSchema = z.object({ id: identifier.optional(), revision: z.number().int().positive().optional(),
  kind: z.enum(['auto', 'research', 'model', 'pipeline', 'prediction', 'action', 'submission']).default('auto'),
  task_id: taskIdSchema.optional(), slot_id: slotIdSchema.optional() }).strict()
interface ReadStores {
  notes: Pick<V05ResearchRecords, 'read' | 'history' | 'list'>
  records: Pick<V06Records, 'models' | 'pipelines' | 'predictions' | 'submissions'>
  actions?: Pick<V06Actions, 'list'>
}
interface Match { kind: string; current: unknown; history: unknown[]; immutable: boolean }
const view = (match: Match) => z.json().parse({ ...match,
  status: match.current !== null ? 'found' : match.history.length ? 'not_available' : 'not_found' })

/** No selector preserves the aggregate view; an ID resolves by kind, and submissions use task/slot/revision. */
export function readResearch(stores: ReadStores, input: unknown) {
  const request = researchReadSchema.parse(input), { notes, records, actions } = stores
  if (request.task_id !== undefined || request.slot_id !== undefined) {
    if (!request.task_id || !request.slot_id) throw new Error('Submission reads require both task_id and slot_id')
    if (request.id || !['auto', 'submission'].includes(request.kind)) throw new Error('Use task_id/slot_id without id to read a submission')
    const history = records.submissions().filter(s => s.taskId === request.task_id && s.slotId === request.slot_id)
    const current = request.revision === undefined ? history.at(-1) ?? null : history.find(s => s.revision === request.revision) ?? null
    return view({ kind: 'submission', current, history, immutable: false })
  }
  if (request.kind === 'submission') throw new Error('Submission reads use task_id and slot_id, not an artifact id')
  if (!request.id) {
    if (request.kind !== 'auto' || request.revision !== undefined) throw new Error('Provide id for an artifact/note, or task_id and slot_id for a submission')
    return { research: notes.list(), models: records.models(), pipelines: records.pipelines(), predictions: records.predictions(), submissions: records.submissions(), actions: actions?.list() ?? [] }
  }
  const matches: Match[] = []
  if (request.kind === 'auto' || request.kind === 'research') {
    const history = notes.history(request.id)
    if (history.length) matches.push({ kind: 'research', current: notes.read(request.id, request.revision), history, immutable: false })
  }
  const artifacts = [
    { kind: 'model', rows: () => records.models().filter(m => m.id === request.id) },
    { kind: 'pipeline', rows: () => records.pipelines().filter(p => p.pipelineId === request.id) },
    { kind: 'prediction', rows: () => records.predictions().filter(p => p.id === request.id) },
    { kind: 'action', rows: () => (actions?.list() ?? []).filter(a => a.id === request.id) },
  ]
  for (const artifact of artifacts) if (request.kind === 'auto' || request.kind === artifact.kind) {
    const rows = artifact.rows()
    if (rows.length) matches.push({ kind: artifact.kind, current: rows[0], history: rows, immutable: true })
  }
  if (matches.length > 1) throw new Error(`Ambiguous research id ${request.id}; set kind to ${matches.map(m => m.kind).join(' or ')}`)
  const match = matches[0]
  if (!match) return view({ kind: request.kind, current: null, history: [], immutable: false })
  if (match.immutable && request.revision !== undefined && request.revision !== 1)
    throw new Error('This artifact ID is immutable; use a new versioned ID instead of a revision selector')
  return view(match)
}
