/** Redacted score view for a running mission: observable operations, crisis signals and progress only.
 * Hidden accuracy, truth-derived incident parts and the final score stay evaluator-side until the horizon.
 */
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { ViewerSnapshot } from './protocol.ts'
import type { Truth } from './truth.ts'

export interface ScoreActivity {
  /** Incidents that already emitted a public announcement or alarm. */
  observableIncidents?: number
  /** Incident reports submitted by mission members. */
  reportedIncidents?: number
  /** Deliverable submissions rejected by public evidence checks. */
  rejectedSubmissions?: number
  /** Accepted and rejected submissions per task, for the research progress table. */
  taskSubmissions?: Record<string, { accepted: number; rejected: number }>
}

type Score = Record<string, unknown>

const object = (value: unknown): Score => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Score : {}
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Remove every field that depends on hidden truth or the final total.
 * @param score Cached full or final score object.
 * @param status Mission status; only `completed` exposes the final score unchanged.
 * @param activity Observable submission and incident counts supplied by the runtime.
 * @returns Redacted running view, or the full final score once the mission has completed.
 */
export function redactScore(score: unknown, status: ViewerSnapshot['status'], activity: ScoreActivity = {}): Json {
  if (score === null || score === undefined) return null
  if (status === 'completed' && object(score).provisional !== true) return score as Json
  const full = object(score), O = object(full.O), R = object(full.R), X = object(full.X), D = object(full.D)
  const rows = (value: unknown) => Array.isArray(value) ? value.map(item => {
    const task = object(item), id = typeof task.id === 'string' ? task.id : ''
    const counts = activity.taskSubmissions?.[id]
    return { id, weight: number(task.weight), P: number(task.P), V: number(task.V), d: number(task.d),
      submissions: counts?.accepted ?? 0, rejected: counts?.rejected ?? 0 }
  }) : []
  // Duty slot accuracy depends on hidden truth; only coverage (slots with an accepted submission) is shown.
  const duties = Array.isArray(D.duties) ? D.duties.map(item => {
    const duty = object(item)
    return { id: typeof duty.id === 'string' ? duty.id : '', weight: number(duty.weight), slots: number(duty.slots), submitted: number(duty.submitted) }
  }) : []
  return {
    provisional: true,
    tick: number(full.tick),
    O: { total: number(O.total), crops: number(O.crops), energy: number(O.energy), water: number(O.water),
      atmosphere: number(O.atmosphere), samples: number(O.samples) },
    D: { duties },
    C: { observable: activity.observableIncidents ?? 0, reported: activity.reportedIncidents ?? 0 },
    R: { tasks: rows(R.tasks) },
    X: { tasks: rows(X.tasks) },
    Q: { rejected: activity.rejectedSubmissions ?? 0 },
  } as Json
}

/** A committed world event that every participant could observe. */
export interface ObservableEvent { tick: number; kind: string; payload: Json }

const field = (event: ObservableEvent, key: string) => object(event.payload)[key]
const isDevice = (event: ObservableEvent, deviceId: string) => event.kind === 'device-fault' && field(event, 'deviceId') === deviceId
const after = (event: ObservableEvent, tick: number) => event.tick >= tick

/** Public signs that an incident has started; silent incidents (sensor drift) are never counted. */
const SIGNALS: Record<string, (event: ObservableEvent) => boolean> = {
  E1: event => ['power-shed', 'battery-low'].includes(event.kind),
  E13: event => ['power-shed', 'battery-low'].includes(event.kind),
  E12: event => event.kind === 'battery-low',
  E2: event => isDevice(event, 'cold-1'),
  E7: event => isDevice(event, 'robot-1'),
  E8: event => isDevice(event, 'filter'),
  E3: event => event.kind === 'inline-doc-alarm',
  E11: event => event.kind === 'inline-doc-alarm',
  E5: event => event.kind === 'announcement' && field(event, 'kind') === 'quality-notice',
  E6: event => event.kind === 'announcement' && field(event, 'kind') === 'method-notice',
  E9: event => event.kind === 'chamber-pressure-low',
  E10: event => event.kind === 'crop-status-changed' && ['stressed', 'lost'].includes(String(field(event, 'status'))),
  E4: () => false,
}

/** Count incidents whose public signal has already appeared by the given tick.
 * @param truth Hidden schedule used only to know which incident a signal belongs to; never returned.
 * @param events Committed public world events.
 * @param tick Current logical tick.
 * @returns Number of observable incidents that have started.
 */
export function observableIncidentCount(truth: Truth, events: ObservableEvent[], tick: number) {
  const started = truth.incidents.filter(incident => incident.onset <= tick)
  const lead = (id: string) => id === 'E1' || id === 'E13' || id === 'E8' ? 24 : 0
  return started.filter(incident => {
    const signal = SIGNALS[incident.id]
    if (!signal) return false
    const from = Math.max(0, incident.onset - lead(incident.id))
    return events.some(event => after(event, from) && event.tick <= tick && signal(event))
  }).length
}
