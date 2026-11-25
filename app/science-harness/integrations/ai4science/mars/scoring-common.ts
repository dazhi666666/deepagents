/** Shared scoring types and helpers. */
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { LaboratoryState } from '../greenhouse/laboratory/schema.ts'
import type { BaseState, CropState } from './base.ts'
import type { Evidence, TaskId } from './deliverables.ts'

export interface Estimate { est: number; lo: number; hi: number }
export interface Submission { id: string; taskId: TaskId; tick: number; actorId: string; answer: Record<string, unknown>; evidence: Evidence }
export interface SystemOp { id: string; command: Record<string, unknown> & { action: string }; state: string; completedTick?: number; acceptedTick: number; result: Json | null }
export interface WorldView {
  lab: LaboratoryState; crops: CropState[]; base: BaseState; systemOps: SystemOp[]
  sampleConditions: Record<string, Json>; sampleSources: Record<string, string>
  measurement: (resultId: string) => Json | null
}

export const clamp = (value: number) => Math.max(0, Math.min(1, value))
export const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0

/** Point accuracy plus a 90% interval score (spec 7.1). */
export function numeric(estimate: Estimate | undefined, truth: number, tolerance: number) {
  if (!estimate || !Number.isFinite(estimate.est) || tolerance <= 0) return 0
  const accuracy = clamp(1 - Math.abs(estimate.est - truth) / tolerance)
  const interval = (estimate.hi - estimate.lo) + 20 * Math.max(0, estimate.lo - truth) + 20 * Math.max(0, truth - estimate.hi)
  return 0.7 * accuracy + 0.3 * clamp(1 - interval / (4 * tolerance))
}
/** Numeric score on the log scale for strictly positive quantities. */
export function logNumeric(estimate: Estimate | undefined, truth: number, factor = 1.5) {
  if (!estimate || !(estimate.est > 0) || !(estimate.lo > 0) || !(truth > 0)) return 0
  return numeric({ est: Math.log(estimate.est), lo: Math.log(estimate.lo), hi: Math.log(Math.max(estimate.hi, estimate.lo)) }, Math.log(truth), Math.log(factor))
}
export function f1(predicted: string[], actual: string[]) {
  const p = new Set(predicted), a = new Set(actual)
  if (!p.size && !a.size) return 1
  const hits = [...p].filter(value => a.has(value)).length
  return hits ? 2 * hits / (p.size + a.size) : 0
}
export const jaccard = (predicted: string[], actual: string[]) => {
  const p = new Set(predicted), a = new Set(actual)
  const union = new Set([...p, ...a]).size
  return union ? [...p].filter(value => a.has(value)).length / union : 1
}

/** Root sample of any sample in the laboratory state. */
export function rootOf(lab: LaboratoryState, sampleId: string) {
  let sample = lab.samples.find(value => value.id === sampleId)
  while (sample?.parentId) sample = lab.samples.find(value => value.id === sample!.parentId)
  return sample?.id ?? sampleId
}
/** Confirm/image results of successful operations, with their root source. */
export function resultsWithSource(view: WorldView) {
  const succeeded = new Set(view.lab.operations.filter(op => op.state === 'succeeded').map(op => op.id))
  return view.lab.results.filter(result => succeeded.has(result.operationId)).map(result => {
    const root = rootOf(view.lab, result.sampleId)
    return { ...result, root, source: view.sampleSources[root] ?? null }
  })
}
