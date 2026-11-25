/** Offline-only scorer. The host supplies private targets and immutable execution facts.
 * Never expose this module or its inputs through an Agent tool. Scores are not accepted as answers. */
import { V05_COMPONENT_WEIGHTS, V05_TASK_IDS, V05_TASKS, type TaskId } from './registry.ts'

export type Component = keyof typeof V05_COMPONENT_WEIGHTS
export type Metric = { kind: 'numeric'; target: number; tolerance: number; interval?: boolean }
  | { kind: 'exact'; target: string | boolean | number }
  | { kind: 'set'; target: string[] }
export interface EvidenceRequirement {
  kind: string
  count: number
  purpose: string
  /** Required public metadata, e.g. module, method version, project and units. */
  metadata?: Record<string, string | number | boolean>
  /** Alternative public provenance paths; allows legitimate equivalent physical methods. */
  anyMetadata?: Record<string, string | number | boolean>[]
}
export interface Objective {
  id: string
  /** Same scientific outcome cannot be counted in two components. */
  duplicateKey: string
  component: Component
  taskId?: TaskId | undefined
  branch?: 'accuracy' | 'test' | undefined
  points: number
  metric: Metric
  evidence: EvidenceRequirement[]
  deadline: number
  /** Prediction validation availability comes from the private evaluation manifest. */
  validationAvailableAt?: number
  predictionTarget?: string
}
export interface EvaluationManifest {
  version: 'v0.5'
  horizon: number
  mode: 'slice' | 'core'
  objectives: Objective[]
}
export interface EvidenceFact {
  id: string
  kind: string
  availableAt: number
  completedAt: number
  state: 'succeeded' | 'failed' | 'running'
  metadata: Record<string, string | number | boolean>
  revokedAt?: number
  /** A recalled result can still be used to study bias, with a declared purpose. */
  permittedPurposes?: string[]
}
export interface FrozenPrediction {
  id: string
  target: string
  lockedAt: number
  modelHash: string
  dependencyAvailableAt: number[]
}
export interface Observation {
  objectiveId: string
  id: string
  submittedAt: number
  value: unknown
  evidence: { id: string; purpose: string }[]
  predictionId?: string | undefined
}
export interface EvaluationInput {
  observations: Observation[]
  /** Collected by the host from execution, artifact and access journals, never from answer fields. */
  facts: EvidenceFact[]
  predictions: FrozenPrediction[]
  /** Outputs obtained by the private host executing the frozen model, never submitted answer values. */
  validationResults?: { objectiveId: string; predictionId: string; value: unknown; evaluatedAt: number }[]
}
export interface ObjectiveResult { id: string; points: number; maximum: number; accuracy: number; support: number; reason: string; observationId: string | null }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const tick = (v: number) => Number.isSafeInteger(v) && v >= 0
const close = (a: number, b: number) => Math.abs(a - b) < 1e-8
const clip = (v: number) => Math.max(0, Math.min(1, v))

/** Reject ambiguous scoring before any results are seen. A slice reports its actual maximum, never /100. */
export function validateEvaluationManifest(manifest: EvaluationManifest): void {
  if (manifest.version !== 'v0.5' || !tick(manifest.horizon) || manifest.horizon === 0 || !['slice', 'core'].includes(manifest.mode)) throw new Error('Invalid evaluation manifest')
  if (!manifest.objectives.length) throw new Error('Evaluation requires fixed nonempty objectives')
  const ids = new Set<string>(), duplicateKeys = new Set<string>()
  const totals: Record<Component, number> = { R: 0, K: 0, J: 0, O: 0, Q: 0 }
  for (const o of manifest.objectives) {
    if (!o.id || !o.duplicateKey || ids.has(o.id) || duplicateKeys.has(o.duplicateKey)) throw new Error('Duplicate objective or scientific outcome')
    ids.add(o.id); duplicateKeys.add(o.duplicateKey)
    if (!(o.component in totals) || !finite(o.points) || o.points <= 0 || !tick(o.deadline) || o.deadline > manifest.horizon) throw new Error('Invalid objective weight or deadline')
    totals[o.component] += o.points
    if (o.taskId !== undefined && !V05_TASK_IDS.includes(o.taskId)) throw new Error('Unknown task')
    if (o.component !== 'R' && o.component !== 'J' && o.taskId !== undefined) throw new Error('K/O/Q use independent fixed objectives, not task weights')
    if (o.component === 'R' && (!o.taskId || o.taskId.startsWith('PX') || !['accuracy', 'test'].includes(o.branch ?? ''))) throw new Error('Research objective needs a scientific task and branch')
    if (o.component === 'J' && (!o.taskId || !o.taskId.startsWith('PX'))) throw new Error('Joint objective needs a PX task')
    if (o.component !== 'R' && o.branch !== undefined) throw new Error('Only research has accuracy/test branches')
    if (o.branch === 'test' && (o.validationAvailableAt === undefined || !tick(o.validationAvailableAt))) throw new Error('Test target needs validation visibility time')
    if (!o.evidence.length || o.evidence.some(r => !r.kind || !r.purpose || !Number.isSafeInteger(r.count) || r.count < 1)) throw new Error('Every target needs positive fixed evidence requirements')
    if (o.evidence.some(r => r.anyMetadata !== undefined && r.anyMetadata.length === 0)) throw new Error('Evidence alternatives must not be empty')
    const requirementKeys = o.evidence.map(r => JSON.stringify([r.kind, r.purpose, Object.entries(r.metadata ?? {}).sort(), (r.anyMetadata ?? []).map(option => Object.entries(option).sort())]))
    if (new Set(requirementKeys).size !== requirementKeys.length) throw new Error('Duplicate evidence requirement')
    if (o.metric.kind === 'numeric' && (!finite(o.metric.target) || !finite(o.metric.tolerance) || o.metric.tolerance <= 0)) throw new Error('Numeric target needs a finite positive tolerance')
    if (o.metric.kind === 'exact' && !['string', 'boolean', 'number'].includes(typeof o.metric.target)) throw new Error('Invalid exact target')
    if (o.metric.kind === 'exact' && typeof o.metric.target === 'number' && !finite(o.metric.target)) throw new Error('Invalid exact target')
    if (o.metric.kind === 'set' && (o.metric.target.some(v => typeof v !== 'string') || new Set(o.metric.target).size !== o.metric.target.length)) throw new Error('Invalid set target')
    if (!['numeric', 'exact', 'set'].includes(o.metric.kind)) throw new Error('Unknown metric')
  }
  for (const component of Object.keys(totals) as Component[]) {
    if (totals[component] > V05_COMPONENT_WEIGHTS[component] + 1e-8) throw new Error('Component exceeds published weight')
    if (manifest.mode === 'core' && !close(totals[component], V05_COMPONENT_WEIGHTS[component])) throw new Error('Core needs all component weights')
  }
  for (const taskId of V05_TASK_IDS) {
    const task = V05_TASKS[taskId], objectives = manifest.objectives.filter(o => o.taskId === taskId)
    if (manifest.mode === 'core' && !close(objectives.reduce((n, o) => n + o.points, 0), task.weight)) throw new Error(`Wrong task weight: ${taskId}`)
    if (task.project !== 'PX') for (const branch of ['accuracy', 'test'] as const) {
      const sum = objectives.filter(o => o.branch === branch).reduce((n, o) => n + o.points, 0), maximum = task.weight * (branch === 'accuracy' ? 0.65 : 0.35)
      if (sum > maximum + 1e-8 || manifest.mode === 'core' && !close(sum, maximum)) throw new Error(`Wrong research branch weight: ${taskId}`)
    }
  }
}

function accuracy(metric: Metric, value: unknown): number {
  if (metric.kind === 'exact') return value === metric.target ? 1 : 0
  if (metric.kind === 'set') {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string') || new Set(value).size !== value.length) return 0
    const actual = new Set(value as string[]), expected = new Set(metric.target)
    const union = new Set([...actual, ...expected]).size
    return union === 0 ? 1 : [...actual].filter(v => expected.has(v)).length / union
  }
  const estimate = metric.interval ? (value as { est?: unknown } | null)?.est : value
  if (!finite(estimate)) return 0
  const acc = clip(1 - Math.abs(estimate - metric.target) / metric.tolerance)
  if (!metric.interval) return acc
  const { lo, hi } = value as { lo?: unknown; hi?: unknown }
  if (!finite(lo) || !finite(hi) || lo > estimate || estimate > hi) return 0
  const intervalScore = hi - lo + 20 * Math.max(lo - metric.target, 0) + 20 * Math.max(metric.target - hi, 0)
  return 0.7 * acc + 0.3 * clip(1 - intervalScore / (4 * metric.tolerance))
}

/** Fixed denominators, latest timely submission, independent evidence gate per scientific target. */
export function evaluateV05(manifest: EvaluationManifest, input: EvaluationInput) {
  validateEvaluationManifest(manifest)
  const facts = new Map(input.facts.map(f => [f.id, f])), predictions = new Map(input.predictions.map(p => [p.id, p]))
  if (facts.size !== input.facts.length || predictions.size !== input.predictions.length || new Set(input.observations.map(o => o.id)).size !== input.observations.length) throw new Error('Duplicate immutable fact, commit or observation ID')
  for (const fact of input.facts) if (!tick(fact.availableAt) || !tick(fact.completedAt) || fact.availableAt < fact.completedAt || fact.revokedAt !== undefined && !tick(fact.revokedAt)) throw new Error('Invalid evidence timeline')
  for (const p of input.predictions) if (!p.id || !p.modelHash || !tick(p.lockedAt) || p.dependencyAvailableAt.some(at => !tick(at) || at > p.lockedAt)) throw new Error('Invalid frozen prediction')
  const known = new Set(manifest.objectives.map(o => o.id))
  for (const o of input.observations) if (!o.id || !known.has(o.objectiveId) || !tick(o.submittedAt)) throw new Error('Invalid observation')
  const components: Record<Component, number> = { R: 0, K: 0, J: 0, O: 0, Q: 0 }
  const results: ObjectiveResult[] = manifest.objectives.map(objective => {
    const candidates = input.observations.filter(o => o.objectiveId === objective.id && o.submittedAt <= objective.deadline)
      .sort((a, b) => b.submittedAt - a.submittedAt || b.id.localeCompare(a.id))
    const observation = candidates[0]
    const row: ObjectiveResult = { id: objective.id, points: 0, maximum: objective.points, accuracy: 0, support: 0, reason: 'missing', observationId: observation?.id ?? null }
    if (!observation) return row
    let supportTick = observation.submittedAt, evaluatedValue = observation.value
    if (objective.branch === 'test') {
      const commit = observation.predictionId ? predictions.get(observation.predictionId) : undefined
      if (!commit || commit.lockedAt >= objective.validationAvailableAt! || commit.lockedAt > observation.submittedAt || observation.submittedAt >= objective.validationAvailableAt!) { row.reason = 'prediction_not_locked_before_validation'; return row }
      if (commit.target !== (objective.predictionTarget ?? objective.id)) { row.reason = 'prediction_target_mismatch'; return row }
      const validation = input.validationResults?.find(item => item.objectiveId === objective.id && item.predictionId === commit.id)
      if (!validation || !tick(validation.evaluatedAt) || validation.evaluatedAt < objective.validationAvailableAt!) { row.reason = 'missing_frozen_model_validation'; return row }
      evaluatedValue = validation.value
      supportTick = commit.lockedAt
    }
    const refs = [...new Map(observation.evidence.map(ref => [JSON.stringify([ref.id, ref.purpose]), ref])).values()]
    const supports = objective.evidence.map(requirement => {
      const valid = refs.filter(ref => {
        const fact = facts.get(ref.id)
        return fact !== undefined && fact.kind === requirement.kind && fact.state === 'succeeded' && fact.availableAt <= supportTick && fact.completedAt <= supportTick && ref.purpose === requirement.purpose &&
          (fact.revokedAt === undefined || fact.revokedAt > supportTick || (fact.permittedPurposes ?? []).includes(ref.purpose)) &&
          (fact.permittedPurposes === undefined || fact.permittedPurposes.includes(ref.purpose)) &&
          Object.entries(requirement.metadata ?? {}).every(([key, value]) => fact.metadata[key] === value) &&
          (requirement.anyMetadata === undefined || requirement.anyMetadata.some(option => Object.entries(option).every(([key, value]) => fact.metadata[key] === value)))
      })
      return Math.min(1, new Set(valid.map(ref => ref.id)).size / requirement.count)
    })
    // All required scientific evidence classes must exist. Adding unrelated citations cannot dilute a missing class.
    row.support = Math.min(...supports)
    row.accuracy = accuracy(objective.metric, evaluatedValue)
    row.points = objective.points * row.support * row.accuracy
    row.reason = row.support < 1 ? 'incomplete_evidence' : row.accuracy < 1 ? 'evaluated' : 'correct'
    components[objective.component] += row.points
    return row
  })
  const maximum = manifest.objectives.reduce((total, o) => total + o.points, 0)
  const tasks = Object.fromEntries(V05_TASK_IDS.map(id => {
    const ids = new Set(manifest.objectives.filter(o => o.taskId === id).map(o => o.id))
    return [id, { score: results.filter(r => ids.has(r.id)).reduce((total, r) => total + r.points, 0), maximum: results.filter(r => ids.has(r.id)).reduce((total, r) => total + r.maximum, 0) }]
  }))
  return { version: 'v0.5' as const, mode: manifest.mode, score: Object.values(components).reduce((a, b) => a + b, 0), maximum, components, tasks, objectives: results }
}
