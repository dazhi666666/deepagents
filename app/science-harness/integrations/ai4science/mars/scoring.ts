/** Benchmark score S = O + D + C + R + X + Q (spec v0.3). */
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { CHAMBERS, type ArchiveAnswers, type Truth } from './truth.ts'
import { activeHypotheses } from './base.ts'
import { clamp, jaccard, mean, resultsWithSource, type Submission, type WorldView } from './scoring-common.ts'
import { accuracy, dutySlotScore } from './scoring-accuracy.ts'
import { evidenceValidity, progress, type EvidenceContext } from './scoring-progress.ts'
import { deadlineOf, DUTY_IDS, dutySlot, dutySlots, isDuty, TASKS, type TaskId } from './deliverables.ts'
import { deadlineFactor, taskWeights } from './mission.ts'
import { initialMarsRules } from './world.ts'
import { SPARES_INITIAL, CO2_TANK_INITIAL } from './base.ts'

export interface IncidentReport { tick: number; entities: string[]; actorId: string; eventClass?: string | undefined; rootCause?: string[] | undefined }
export interface ScoringInput {
  truth: Truth; answers: ArchiveAnswers | null; view: WorldView; submissions: Submission[]; rejections: number
  reports: IncidentReport[]; evidence: EvidenceContext; reproducible: (runId: string, values: number[]) => boolean | null
  /** True when two cited runs with different code reproduce the values; null while unknown. */
  independent?: ((runIds: string[], values: number[]) => boolean | null) | undefined
  /** Live view: score only incidents that have started by this tick. */
  asOfTick?: number | undefined
  baselines?: { null: number; ref: number } | undefined; usageReference?: Record<string, number> | undefined
}

const INCIDENT_ENTITIES = (truth: Truth): Record<string, string[]> => ({
  E1: ['energy', 'solar-array', 'battery'], E13: ['energy', 'solar-array', 'battery'], E12: ['energy', 'battery'],
  E2: ['cold-1'], E3: ['reservoir', 'filter', 'pump', 'water'], E11: ['reservoir', 'filter', 'pump', 'water'],
  E4: truth.drift.map(d => d.chamber), E5: ['extraction', truth.lots.A2, 'A2'], E6: ['confirm'], E7: ['robot-1'], E8: ['filter', 'water'],
  E9: truth.leak ? [truth.leak.chamber] : [], E10: truth.pathogen.index.flatMap(id => [id, `incubator-${id.split('-')[1]}`]),
})

/** Event classes incident_report accepts, and the root-cause tokens each incident is judged on. */
export const EVENT_CLASSES = ['dust-storm', 'cold-chain-failure', 'water-contamination', 'sensor-drift', 'reagent-recall', 'method-change',
  'robot-failure', 'filter-clog', 'chamber-leak', 'pathogen', 'battery-degradation'] as const
const INCIDENT_CLASS: Record<string, string> = { E1: 'dust-storm', E13: 'dust-storm', E2: 'cold-chain-failure', E3: 'water-contamination', E11: 'water-contamination',
  E4: 'sensor-drift', E5: 'reagent-recall', E6: 'method-change', E7: 'robot-failure', E8: 'filter-clog', E9: 'chamber-leak', E10: 'pathogen', E12: 'battery-degradation' }
function rootTokens(truth: Truth, id: string): string[] {
  switch (id) {
    case 'E2': return ['cold-1']
    case 'E3': case 'E11': return truth.contamination.find(c => c.event === id)?.hypotheses ?? []
    case 'E4': return truth.drift.map(d => `${d.chamber}:${d.channel}`)
    case 'E5': return [truth.lots.A2]
    case 'E6': return ['confirm']
    case 'E7': return ['robot-1']
    case 'E8': return ['filter']
    case 'E9': return truth.leak ? [`${truth.leak.chamber}:${truth.leak.point}`] : []
    case 'E10': return truth.pathogen.index
    case 'E12': return ['battery']
    default: return []
  }
}
/** Best structured root-cause report for an incident: half for the class, half for the root-cause tokens. */
function reportScore(truth: Truth, id: string, onset: number, window: number, reports: IncidentReport[]) {
  const tokens = rootTokens(truth, id)
  return Math.max(0, ...reports.filter(report => report.tick >= onset - 30 && report.tick <= onset + 4 * window && report.eventClass).map(report => {
    const classOk = report.eventClass === INCIDENT_CLASS[id] ? 1 : 0
    return 0.5 * classOk + 0.5 * (tokens.length ? jaccard(report.rootCause ?? [], tokens) : classOk)
  }))
}

/** Score one incident: detection, containment, recovery and correctness (spec 8.3). */
function incidentScore(id: string, onset: number, input: ScoringInput) {
  const { truth, view } = input
  const entities = INCIDENT_ENTITIES(truth)[id] ?? []
  const lab = view.lab.operations, sys = view.systemOps
  const actionTicks: number[] = []
  const touches = (target: unknown) => typeof target === 'string' && entities.some(entity => target === entity || target.startsWith(entity))
  for (const op of lab) if (op.acceptedTick >= onset - 30 && (touches(op.command.deviceId) || (op.command.action === 'transfer' && touches(op.command.sampleId)))) actionTicks.push(op.acceptedTick)
  for (const op of sys) if (op.acceptedTick >= onset - 30 && Object.values(op.command).some(touches)) actionTicks.push(op.acceptedTick)
  if (['E1', 'E13', 'E12'].includes(id)) for (const op of sys) if (op.acceptedTick >= onset - 30 && ['power_priority', 'light'].includes(op.command.action)) actionTicks.push(op.acceptedTick)
  if (id === 'E3' || id === 'E11') for (const op of sys) if (op.acceptedTick >= onset && op.command.action === 'water_route') actionTicks.push(op.acceptedTick)
  for (const report of input.reports) if (report.tick >= onset - 30 && report.entities.some(touches)) actionTicks.push(report.tick)
  const first = actionTicks.length ? Math.min(...actionTicks) : Infinity
  const window = { E1: 24, E13: 24, E2: 8, E3: 30, E11: 30, E4: 80, E5: 30, E6: 20, E7: 15, E8: 30, E9: 40, E10: 120, E12: 100 }[id] ?? 30
  const anchor = id === 'E1' || id === 'E13' ? onset - 24 : id === 'E8' ? onset - 30 : onset
  const detect = first === Infinity ? 0 : clamp(1 - Math.max(0, first - anchor) / window)
  const done = (predicate: (op: { command: Record<string, unknown>; state: string; completedTick?: number }) => boolean) =>
    Math.min(...[...lab, ...sys].filter(op => op.state === 'succeeded' && (op.completedTick ?? 0) >= onset && predicate(op as never)).map(op => op.completedTick ?? Infinity))
  const recoveryFrom = (tick: number, window: number) => tick === Infinity ? 0 : clamp(1 - (tick - onset) / window)
  const usedA2After = resultsWithSource(view).filter(r => r.batchIds.includes(truth.lots.A2) && r.completedTick >= onset).length
  let contain = 1, recover: number | null = null, correct = 0
  switch (id) {
    case 'E1': case 'E13': {
      const storm = truth.storms.find(s => s.event === id)!
      const shed = view.base.metrics.tierOneShedTicks
      contain = clamp(1 - shed / Math.max(1, storm.duration)); correct = shed <= 10 ? 1 : shed <= 40 ? 0.5 : 0; break
    }
    case 'E2': {
      const repaired = done(op => op.command.action === 'repair' && op.command.deviceId === 'cold-1')
      const wrong = lab.some(op => op.command.action === 'repair' && ['cold-2', 'freezer'].includes(String(op.command.deviceId)) && op.acceptedTick >= onset)
      recover = recoveryFrom(repaired, 150); correct = repaired !== Infinity && !wrong ? 1 : 0
      contain = clamp(1 - view.lab.facilityMetrics.unsafeSampleTicks / Math.max(1, view.base.metrics.sampleTicks) * 10); break
    }
    case 'E3': case 'E11': {
      const event = truth.contamination.find(c => c.event === id)!
      const resolvedAll = event.hypotheses.every(h => (view.base.water.resolved[id] ?? []).includes(h))
      const fixTick = done(op => (op.command.action === 'repair' && ['filter', 'pump'].includes(String(op.command.deviceId))) || (op.command.action === 'clean' && op.command.deviceId === 'reservoir'))
      const wrong = lab.some(op => op.acceptedTick >= onset && ((op.command.action === 'repair' && op.command.deviceId === 'filter' && !event.hypotheses.includes('membrane')) ||
        (op.command.action === 'repair' && op.command.deviceId === 'pump' && !event.hypotheses.includes('seal'))))
      recover = resolvedAll ? recoveryFrom(fixTick, 200) : 0
      correct = resolvedAll ? (wrong ? 0.5 : 1) : 0
      const exposures = view.crops.reduce((sum, crop) => sum + crop.contamination.filter(([start]) => start >= onset).length, 0)
      contain = clamp(1 - exposures / 8); break
    }
    case 'E4': {
      const fixed = Math.min(...truth.drift.map(d => view.base.sensorCalibrated[`${d.chamber}:${d.channel}`] ?? Infinity))
      recover = recoveryFrom(fixed, 200); correct = truth.drift.every(d => (view.base.sensorCalibrated[`${d.chamber}:${d.channel}`] ?? -1) >= d.onset) ? 1 : 0
      const exposure = view.crops.filter(c => truth.drift.some(d => d.chamber === c.chamberId)).reduce((sum, c) => sum + c.exposureTicks, 0)
      contain = clamp(1 - exposure / 200); break
    }
    case 'E5': contain = clamp(1 - usedA2After / 4); correct = usedA2After === 0 ? 1 : 0; break
    case 'E6': {
      const calibrated = done(op => op.command.action === 'calibrate' && op.command.deviceId === 'confirm')
      const firstConfirm = Math.min(...lab.filter(op => op.command.action === 'process' && op.command.deviceId === 'confirm' && op.acceptedTick >= onset).map(op => op.acceptedTick))
      recover = recoveryFrom(calibrated, 100); correct = calibrated <= firstConfirm ? 1 : 0
      contain = clamp(1 - resultsWithSource(view).filter(r => r.methodId === 'confirm' && r.methodVersion === 1 && r.completedTick >= onset).length / 4); break
    }
    case 'E7': { const fixed = done(op => op.command.action === 'repair' && op.command.deviceId === 'robot-1'); recover = recoveryFrom(fixed, 150); correct = fixed !== Infinity ? 1 : 0; break }
    case 'E8': { const fixed = done(op => op.command.action === 'repair' && op.command.deviceId === 'filter'); recover = recoveryFrom(fixed, 120); correct = fixed !== Infinity ? 1 : 0
      contain = clamp(1 - view.base.metrics.waterUnavailableTicks / 400); break }
    case 'E9': {
      const repairs = sys.filter(op => op.command.action === 'seal_repair' && op.acceptedTick >= onset)
      const fixed = Math.min(...repairs.filter(op => (op.result as { leakStopped?: boolean } | null)?.leakStopped).map(op => op.completedTick ?? Infinity))
      recover = recoveryFrom(fixed, 100); correct = view.base.leak.resolved ? repairs.length <= 1 ? 1 : 0.5 : 0
      contain = clamp(view.base.metrics.atmosphereOkTicks[truth.leak!.chamber]! / Math.max(1, view.base.metrics.ticks) * 1.2); break
    }
    case 'E10': {
      const deaths = view.crops.filter(c => c.status === 'lost' && c.infectedSince !== null && !c.removed).length
      const wrong = view.crops.filter(c => c.removed && c.infectedSince === null).length
      const untreated = view.crops.filter(c => c.status !== 'lost' && c.infectedSince !== null && truth.horizon - c.infectedSince >= 60).length
      contain = clamp(1 - (deaths + wrong) / 6); correct = untreated === 0 && wrong === 0 ? 1 : untreated === 0 || wrong === 0 ? 0.5 : 0; break
    }
    case 'E12': { const shedAfter = view.base.metrics.tierOneShedTicks; contain = clamp(1 - shedAfter / 200); correct = shedAfter === 0 ? 1 : 0; break }
  }
  const rootCause = reportScore(truth, id, onset, window, input.reports)
  const judged = 0.5 * correct + 0.5 * rootCause
  const parts = [detect, contain, judged, ...(recover === null ? [] : [recover])]
  return { id, onset, detect, contain, recover, correct: judged, handling: correct, rootCause, score: mean(parts) }
}

/** Compute the full score breakdown. */
export function score(input: ScoringInput) {
  const { truth, view } = input
  const H = truth.horizon, rules = initialMarsRules(), now = input.asOfTick ?? H
  const crops = view.crops.map(crop => {
    const tolerance = rules.cropProfiles[Number(crop.id.split('-')[2]) - 1]!.exposureToleranceTicks
    return crop.status === 'lost' ? 0 : 1 - 0.5 * Math.min(1, crop.exposureTicks / tolerance)
  })
  const sampleTicks = Math.max(1, view.base.metrics.sampleTicks), k = 15 / 22
  const O = { crops: k * 12 * mean(crops), energy: k * 3 * (1 - view.base.metrics.tierOneShedTicks / H), water: k * 3 * (1 - view.base.metrics.waterUnavailableTicks / H),
    atmosphere: k * 2 * mean(CHAMBERS.map(id => (view.base.metrics.atmosphereOkTicks[id] ?? 0) / H)), samples: k * 2 * clamp(1 - view.lab.facilityMetrics.unsafeSampleTicks / sampleTicks) }
  const incidents = truth.incidents.filter(value => value.onset <= now).map(value => incidentScore(value.id, value.onset, input))
  const C = truth.incidents.length ? 20 * incidents.reduce((sum, value) => sum + value.score, 0) / truth.incidents.length : 0
  const weights = taskWeights(truth.load), onsets = Object.fromEntries(truth.incidents.map(value => [value.id, value.onset]))
  const finals = new Map<string, Submission>(), firsts = new Map<string, Submission>(), byTask = new Map<string, Submission[]>()
  for (const submission of [...input.submissions].sort((a, b) => a.tick - b.tick)) {
    finals.set(submission.taskId, submission)
    if (!firsts.has(submission.taskId)) firsts.set(submission.taskId, submission)
    byTask.set(submission.taskId, [...byTask.get(submission.taskId) ?? [], submission])
  }
  // Duties: every slot is scored on its own from the last accepted submission inside it; empty slots score 0.
  const duties = DUTY_IDS.filter(id => weights[id] !== undefined).map(task => {
    const slots = dutySlots(task, truth.load, H), bySlot = new Map<number, Submission>()
    for (const submission of byTask.get(task) ?? []) {
      const slot = dutySlot(task, truth.load, submission.tick, H)
      if (slot !== null) bySlot.set(slot, submission)
    }
    let total = 0, scored = 0
    for (let slot = 0; slot < slots; slot++) {
      const submission = bySlot.get(slot)
      const value = dutySlotScore(truth, view, task, slot, submission)
      if (value === null) continue
      scored++
      if (submission) total += value * evidenceValidity(submission.evidence, view, input.evidence)
    }
    const weight = weights[task]!
    return { id: task, weight, slots, scored, submitted: bySlot.size, mean: scored ? total / scored : 0, points: weight * total / slots }
  })
  const D = duties.reduce((sum, duty) => sum + duty.points, 0)
  const milestone = (id: string, weight: number) => {
    const task = id as TaskId, final = finals.get(task), first = firsts.get(task)
    const P = progress(task, truth, view, finals, input.evidence)
    if (!final || !first) return { id, weight, P, V: 0, A: 0, d: 0, r: 0.2 * P, points: weight * 0.2 * P }
    const deadline = deadlineOf(task, deadlineFactor(truth.load), onsets, H)
    const d = first.tick <= deadline ? 1 : Math.max(0.5, 1 - 0.5 * (first.tick - deadline) / Math.max(1, H - deadline))
    const V = evidenceValidity(final.evidence, view, input.evidence), A = accuracy(truth, input.answers, view, final, finals, byTask.get(task))
    const r = d * (0.4 * P + 0.6 * V * A)
    return { id, weight, P, V, A, d, r, points: weight * r }
  }
  const blockOf = (id: string) => TASKS[id as TaskId].block
  const research = Object.entries(weights).filter(([id]) => blockOf(id) === 'R').map(([id, weight]) => ({ ...milestone(id, weight), campaign: TASKS[id as TaskId].campaign }))
  const integration = Object.entries(weights).filter(([id]) => blockOf(id) === 'X').map(([id, weight]) => milestone(id, weight))
  const R = research.reduce((sum, task) => sum + task.points, 0), X = integration.reduce((sum, task) => sum + task.points, 0)
  const meanProgress = mean([...research, ...integration].map(task => task.P))
  const lab = view.lab
  const usage: Record<string, number> = {
    medium: lab.operations.flatMap(op => op.consumedBatches).filter(b => b.batchId === truth.lots.medium).reduce((s, b) => s + b.units, 0) +
      view.systemOps.filter(op => op.command.action === 'nutrient' && op.state === 'succeeded').length * 2,
    extraction: lab.operations.flatMap(op => op.consumedBatches).filter(b => b.batchId.startsWith('EX-')).reduce((s, b) => s + b.units, 0),
    cropSample: view.crops.reduce((s, c) => s + (rules.plantSampleCapacityUl - c.availableSampleUl), 0),
    co2: CO2_TANK_INITIAL - view.base.co2Tank,
    spares: Object.entries(SPARES_INITIAL).reduce((s, [key, value]) => s + value - (view.base.spares[key] ?? 0), 0),
  }
  const reference = input.usageReference ?? { medium: 31, extraction: 60, cropSample: 9600, co2: 9600, spares: 4 }
  const efficiency = mean(Object.keys(reference).map(key => usage[key]! <= 0 ? 1 : Math.min(1, reference[key]! / usage[key]!)))
  const numericFinals = [...finals.values()].filter(s => !isDuty(s.taskId) && numbersIn(s.answer).length > 0)
  const runs = numericFinals.flatMap(s => s.evidence.analysisRunIds.map(run => ({ run, values: numbersIn(s.answer) })))
  const repro = runs.map(({ run, values }) => input.reproducible(run, values))
  const known = repro.filter((value): value is boolean => value !== null)
  const independent = numericFinals.map(s => input.independent?.(s.evidence.analysisRunIds, numbersIn(s.answer)) ?? null)
  const judged = independent.filter((value): value is boolean => value !== null)
  const Q = { reproducibility: 2 * (known.length ? known.filter(Boolean).length / known.length : 0), efficiency: 2 * meanProgress * efficiency,
    independent: numericFinals.length ? judged.filter(Boolean).length / numericFinals.length : 0,
    reproducibilityPending: repro.length - known.length, independentPending: independent.length - judged.length, rejections: input.rejections }
  const Ototal = O.crops + O.energy + O.water + O.atmosphere + O.samples
  const Qtotal = Q.reproducibility + Q.efficiency + Q.independent
  const S = Ototal + D + C + R + X + Qtotal
  const normalized = input.baselines && input.baselines.ref - input.baselines.null > 1e-6 ? 100 * (S - input.baselines.null) / (input.baselines.ref - input.baselines.null) : null
  const campaigns = Object.fromEntries(['W', 'G', 'F', 'A'].map(c => [c, research.filter(t => t.campaign === c).reduce((sum, t) => sum + t.points, 0)]))
  return { S, normalized, version: 'v0.3', O: { total: Ototal, ...O }, D: { total: D, duties }, C: { total: C, incidents },
    R: { total: R, campaigns, tasks: research }, X: { total: X, tasks: integration }, Q: { total: Qtotal, ...Q, usage },
    waterStillContaminated: activeHypotheses(truth, view.base, H).size > 0 } as unknown as Json & { S: number }
}

export function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value]
  if (Array.isArray(value)) return value.flatMap(numbersIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(numbersIn)
  return []
}
