/** Public, typed reference picker. Only completed, currently visible observations may appear as evidence. */
import { CERTIFICATES, type V06World } from './world.ts'
import type { AnalysisRegistry } from '../analysis.ts'
import type { V06Records } from './records.ts'
import type { V06Actions } from './actions.ts'
import type { V05ResearchRecords } from '../v05/research-records.ts'
import type { V05Planning } from '../v05/planning.ts'
import { isChoiceTrial } from './pilot-choice-contract.ts'
import { submissionCutoff, type TaskId, type SlotId } from './contracts.ts'

export const referenceKinds = ['result', 'operation', 'analysis', 'note', 'model', 'pipeline', 'prediction', 'plan', 'commitment', 'response'] as const
type Kind = typeof referenceKinds[number]
type Row = { kind: Kind; id: string; field: string; tick: number; detail: string; revision?: number }
export function referenceDirectory(world: Pick<V06World, 'observe' | 'observeSystems' | 'stages'>, analysis: AnalysisRegistry,
  records: V06Records, notes: V05ResearchRecords, planning: V05Planning, actions: V06Actions,
  query: { taskId: TaskId; slotId: SlotId; kind?: Kind | undefined; ids?: readonly string[]; offset: number; limit: number }) {
  const { taskId, slotId, kind, offset, limit } = query
  const lab = world.observe(), systems = world.observeSystems(), rows: Row[] = []
  const selected = query.ids && new Set(query.ids)
  const add = (row: Row) => { if (row.tick <= lab.tick && (!kind || row.kind === kind) && (!selected || selected.has(row.id))) rows.push(row) }
  const cutoff = submissionCutoff(world.stages, slotId)
  for (const r of lab.results) {
    if (lab.revocations.some(v => v.resultId === r.id && v.tick <= lab.tick)) continue
    const water = ['confirm', 'screen'].includes(r.methodId)
    if (taskId === 'T2' ? r.methodId !== 'image' : !water) continue
    const certificate = CERTIFICATES.find(control => control.id === r.rootSampleId)
    const source = certificate ? `certified ${certificate.concentrationMgL} mg/L` : systems.sampleSources[r.rootSampleId] ?? 'sample'
    add({ kind: 'result', id: r.id, field: 'evidence', tick: r.completedTick, detail: `${r.methodId} v${r.methodVersion}, ${source}, mother ${r.rootSampleId}` })
  }
  for (const op of systems.operations) {
    if (op.state !== 'succeeded' || op.completedTick == null) continue
    const scan = (taskId === 'T2' || taskId === 'T6') && op.command.action === 'scan'
    const probe = taskId === 'T4' && op.command.action === 'device_reference'
    if (!scan && !probe) continue
    const chamber = 'chamberId' in op.command ? op.command.chamberId : ''
    const light = scan && op.result && typeof op.result === 'object' && !Array.isArray(op.result) ? op.result.light : null
    add({ kind: 'operation', id: op.id, field: 'evidence', tick: op.completedTick,
      detail: `${op.command.action} ${chamber}${typeof light === 'number' ? `, light ${light}` : ''}`.trim() })
  }
  if (!kind || kind === 'analysis') for (const id of analysis.ids()) {
    const r = analysis.get(id)
    if (r?.status === 'done') add({ kind: 'analysis', id, field: 'evidence', tick: r.asOfTick,
      detail: isChoiceTrial(world.stages.jointTrial) && r.dataAccesses?.some(a => a.kind === 'telemetry' && a.id.includes('"energy.demand"')) ? 'analysis of measured whole-base energy.demand' : r.dataAccesses?.some(a => a.kind === 'telemetry' && /energy\.(solar|soc)/.test(a.id)) ? 'analysis of measured energy telemetry' : 'completed analysis' })
  }
  if (!kind || kind === 'note') for (const n of notes.list()) add({ kind: 'note', id: n.id, field: 'evidence', tick: n.availableAt, detail: `research note (${n.status})`, revision: n.revision })
  if (!['T4', 'T6'].includes(taskId)) {
    if (!kind || kind === 'model') for (const m of records.models()) add({ kind: 'model', id: m.id, field: 'payload.modelId', tick: m.acceptedTick, detail: 'registered model' })
    if (taskId === 'T5' && (!kind || kind === 'pipeline')) for (const p of records.pipelines()) add({ kind: 'pipeline', id: p.pipelineId, field: 'payload.pipelineId', tick: p.acceptedTick, detail: 'registered pipeline' })
    if (!kind || kind === 'prediction') for (const p of records.predictions()) if (p.taskId === taskId && p.slotId === slotId)
      add({ kind: 'prediction', id: p.id, field: 'payload.predictionId', tick: p.acceptedTick, detail: `bound to ${p.modelId ?? p.pipelineId}` })
  }
  if ((taskId === 'T2' || taskId === 'T6') && (!kind || kind === 'plan')) for (const p of planning.list()) add({ kind: 'plan', id: p.id, field: 'payload.planId', tick: p.createdTick, detail: p.state })
  if (taskId === 'T3' || taskId === 'T4') for (const a of actions.list()) if (a.taskId === taskId) add({ kind: taskId === 'T3' ? 'commitment' : 'response',
    field: taskId === 'T3' ? 'payload.commitmentIds' : 'payload.responseIds', id: a.id, tick: a.acceptedTick, detail: a.planId })
  rows.sort((a,b) => b.tick - a.tick || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
  const latest = records.latest(taskId, slotId)
  return { taskId, slotId, asOfTick: lab.tick, acceptBeforeTick: cutoff, open: lab.tick < cutoff,
    expectedRevision: latest?.revision ?? 0, accepted: latest ? { revision: latest.revision, acceptedTick: latest.acceptedTick } : null,
    total: rows.length, offset, limit, items: rows.slice(offset, offset + limit), scientificValidation: 'not_evaluated' }
}
