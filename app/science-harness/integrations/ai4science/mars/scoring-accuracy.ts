/** Accuracy A_j against hidden truth for v0.3 deliverables, and per-slot duty scores (spec v0.3). */
import { CHAMBERS, CROP_IDS, growthRate, varietyOf, type ArchiveAnswers, type Truth } from './truth.ts'
import { clamp, f1, jaccard, logNumeric, mean, numeric, resultsWithSource, type Estimate, type Submission, type WorldView } from './scoring-common.ts'
import { scorePlan } from './scoring-plan.ts'
import { TIER_ONE } from './base.ts'
import { dutyPeriod, f2Windows, type DutyId } from './deliverables.ts'

const est = (value: unknown) => value as Estimate | undefined

/** Dust factor history replayed from truth and completed panel cleanings. */
export function dustAt(truth: Truth, view: WorldView, tick: number) {
  const cleanings = new Set(view.systemOps.filter(op => op.command.action === 'panel_clean' && op.state === 'succeeded').map(op => op.completedTick))
  let dust = 1
  for (let t = 1; t <= tick; t++) {
    const storm = truth.storms.some(value => t >= value.onset && t < value.onset + value.duration)
    dust *= 1 - truth.energy.dustRate * (storm ? 5 : 1)
    if (cleanings.has(t)) dust = 1
  }
  return dust
}
/** Remaining successful uses before failure, replayed to a tick. */
export function remainingUses(truth: Truth, view: WorldView, deviceId: string, tick: number) {
  const wear = truth.wear[deviceId]!
  const events: [number, 'use' | 'reset'][] = []
  for (const op of view.lab.operations) if (op.state === 'succeeded' && op.completedTick !== undefined && op.completedTick <= tick) {
    if (op.command.deviceId === deviceId && (op.command.action === 'process' || op.command.action === 'transfer')) events.push([op.completedTick, 'use'])
    if (op.command.deviceId === deviceId && op.command.action === 'repair') events.push([op.completedTick, 'reset'])
  }
  for (const op of view.systemOps) if (op.command.action === 'device_service' && op.command.deviceId === deviceId && op.state === 'succeeded' && (op.completedTick ?? Infinity) <= tick) events.push([op.completedTick!, 'reset'])
  let level = wear.initial
  for (const [, kind] of events.sort((a, b) => a[0] - b[0])) level = kind === 'reset' ? 0 : level + wear.perUse
  return Math.max(0, (1 - level) / wear.perUse)
}
const capacityAt = (truth: Truth, tick: number) => truth.energy.battery * (truth.energy.cellFailure && truth.energy.cellFailure.onset <= tick ? 1 - truth.energy.cellFailure.fraction : 1)

/** F2 accuracy of one submission at its own tick. */
function wearAccuracy(truth: Truth, view: WorldView, submission: Submission) {
  const a = submission.answer as { remainingUses?: Record<string, Estimate> }
  return mean(['confirm', 'imager', 'centrifuge-1', 'centrifuge-2', 'heater-1'].map(id => {
    const remaining = remainingUses(truth, view, id, submission.tick) + 1
    const e = a.remainingUses?.[id]
    return e ? logNumeric({ est: e.est + 1, lo: e.lo + 1, hi: e.hi + 1 }, remaining) : 0
  }))
}

/** X2 storm-plan evaluation: energy balance through the hidden storm with an achievable 90% charge cap. */
export function stormPlan(truth: Truth, view: WorldView, answer: { targetSoc: number; powerPriority: string[]; chamberLight: Record<string, number> }, tick: number) {
  const storm = truth.storms[0]
  if (!storm) return 0
  const capacity = capacityAt(truth, storm.onset), dust = dustAt(truth, view, Math.min(tick, storm.onset))
  const avgSolar = truth.energy.peak * dust * storm.factor / Math.PI
  const demand = (light: number[]) => light.reduce((sum, value) => sum + 0.5 + 0.5 * value / 70, 0) + 6.5
  const survives = (light: number[], soc: number) => Math.min(soc, 90) / 100 * capacity >= Math.max(0, demand(light) - avgSolar) * storm.duration
  const lights = CHAMBERS.map(id => answer.chamberLight[id] ?? 70)
  let best = 0
  for (let level = 100; level >= 0; level -= 5) if (survives(CHAMBERS.map(() => level), 90)) { best = level; break }
  const lightScore = survives(lights, answer.targetSoc) ? best <= 0 ? (mean(lights) <= 0 ? 1 : 0) : Math.min(1, mean(lights) / best) : 0
  const order = answer.powerPriority
  const tierPositions = TIER_ONE.map(id => order.indexOf(id)).filter(index => index >= 0)
  const others = order.filter(id => !TIER_ONE.includes(id)).map(id => order.indexOf(id))
  const priority = others.length === 0 ? 0 : tierPositions.length === 0 ? 1 : others.filter(index => index < Math.min(...tierPositions)).length / others.length
  return 0.5 * lightScore + 0.3 * priority + 0.2 * Math.min(1, answer.targetSoc / 80)
}

/** X1 truth: per-variety contaminated-irrigation stress ticks after E3, and ticks until the loop ran clean. */
export function contaminationImpact(truth: Truth, view: WorldView) {
  const event = truth.contamination.find(value => value.event === 'E3') ?? truth.contamination[0]!
  const next = truth.contamination.find(value => value.onset > event.onset)?.onset ?? truth.horizon
  const stress: Record<string, number> = {}
  for (const crop of view.crops) {
    const key = `variety-${varietyOf(crop.id)}`
    stress[key] = (stress[key] ?? 0) + crop.contamination.filter(([start]) => start >= event.onset && start < next)
      .reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, truth.horizon) - start), 0)
  }
  const clean = view.base.history.contaminationClean[event.event]
  return { stress, cleanAfter: (clean ?? truth.horizon) - event.onset }
}

/** Accuracy of one final submission (all accepted submissions of the task are given for windowed tasks). */
export function accuracy(truth: Truth, answers: ArchiveAnswers | null, view: WorldView, submission: Submission, finals: Map<string, Submission>, all: Submission[] = [submission]): number {
  const a = submission.answer as Record<string, any>
  const w = truth.water
  const rel = (value: unknown, truthValue: number, tolerance: number) => typeof value === 'number' ? clamp(1 - Math.abs(value - truthValue) / tolerance) : 0
  switch (submission.taskId) {
    case 'W1': {
      const filter = w.reservoir * (1 - w.removal), pump = filter + w.pumpIncrement
      return 0.75 * mean([numeric(a.reservoir, w.reservoir, 0.15 * w.reservoir), numeric(a.filter, filter, 0.15 * filter), numeric(a.pump, pump, 0.15 * pump)]) +
        0.25 * numeric(a.removal, w.removal, 0.05)
    }
    case 'W2': return mean([logNumeric(a.k4, w.k4), logNumeric(a.kMinus10, w.kMinus10), logNumeric(a.k22, w.k22)])
    case 'W3': {
      const results = new Map(resultsWithSource(view).map(result => [result.id, result]))
      const affected = ['W1', 'W2', 'W4'].filter(id => (finals.get(id)?.evidence.resultIds ?? []).some(resultId => {
        const result = results.get(resultId)
        return result && (result.methodId === 'confirm' && result.methodVersion === 1 || result.batchIds.includes(truth.lots.A2))
      }))
      return 0.25 * numeric(a.confirmV1Bias, truth.bias.confirmV1, 0.04) + 0.25 * numeric(a.extractionA2Bias, truth.bias.extractionA2, 0.04) +
        0.15 * (a.recalledLot === truth.lots.A2 ? 1 : 0) + 0.35 * f1(a.affectedDeliverables ?? [], affected)
    }
    case 'W4': {
      const event = truth.contamination.filter(value => value.onset <= submission.tick).at(-1) ?? truth.contamination[0]!
      let delta = 0
      if (event.hypotheses.includes('inlet')) delta += event.deltaInlet * (1 - w.removal)
      if (event.hypotheses.includes('membrane')) delta += w.reservoir * (w.removal - event.membraneRemoval)
      if (event.hypotheses.includes('seal')) delta += event.deltaSeal
      return 0.4 * jaccard(a.hypotheses ?? [], event.hypotheses) + 0.25 * numeric(a.increaseAtPump, delta, 0.25 * delta) +
        0.15 * (Boolean(a.lubricantPresent) === event.hypotheses.includes('seal') ? 1 : 0) + 0.2 * (a.faultySensor === event.decoyModule ? 1 : 0)
    }
    case 'G1': return mean(CROP_IDS.map(id => {
      const variety = truth.crops.varieties[varietyOf(id) - 1]!
      const g = growthRate(truth, id, { light: 70, nutrient: 1, irrigation: 75, co2: 800, temperature: variety.tempOpt })
      return numeric(est(a[id]), g, 0.12 * g)
    }))
    case 'G2': return mean(truth.crops.varieties.map(v => 0.8 * numeric(est(a[`variety-${v.variety}`]?.lightOpt), v.lightOpt, 10) + 0.2 * numeric(est(a[`variety-${v.variety}`]?.width), v.lightWidth, 10)))
    case 'G3': {
      const v = truth.crops.varieties[1]!
      const crops = CROP_IDS.filter(id => id.endsWith('-2'))
      const y = (nutrient: number, irrigation: number, co2: number) => mean(crops.map(id => growthRate(truth, id, { light: v.lightOpt, nutrient, irrigation, co2, temperature: v.tempOpt })))
      let best = 0
      for (const n of [1, 2, 3]) for (let i = 30; i <= 120; i++) best = Math.max(best, y(n, i, 1500))
      const chosen = y(a.nutrient, a.irrigation, a.co2), baseline = y(1, 75, 800)
      const regret = best - baseline > 1e-9 ? clamp((best - chosen) / (best - baseline)) : chosen >= best - 1e-9 ? 0 : 1
      return 0.7 * (1 - regret) + 0.3 * numeric(a.predictedGrowth, chosen, 0.1 * chosen)
    }
    case 'G4': return 0.5 * (truth.pathogen.index.includes(a.indexCase) ? 1 : 0) + 0.5 * numeric(a.lambda, truth.pathogen.lambda, 0.001)
    case 'F1': return 0.35 * numeric(a.dustRate, truth.energy.dustRate, 0.0001) + 0.4 * numeric(a.batteryCapacity, capacityAt(truth, submission.tick), 40) + 0.25 * numeric(a.peakOutput, truth.energy.peak, 3)
    case 'F2': {
      const sorted = [...all].sort((x, y) => x.tick - y.tick)
      const first = sorted[0]
      if (!first) return 0
      const windows = f2Windows(truth.horizon), firstWindow = windows.findIndex(end => first.tick <= end)
      const scores = windows.slice(firstWindow).map((end, index) => {
        const start = index === 0 ? -Infinity : windows[firstWindow + index - 1]!
        const last = sorted.filter(value => value.tick > start && value.tick <= end).at(-1)
        return last ? wearAccuracy(truth, view, last) : 0
      })
      return mean(scores)
    }
    case 'F3': {
      const predicted = (a.sensors ?? []) as { chamber: string; channel: string; rate: Estimate }[]
      const keys = truth.drift.map(value => `${value.chamber}:${value.channel}`)
      const rates = truth.drift.map(value => numeric(predicted.find(p => p.chamber === value.chamber && p.channel === value.channel)?.rate, value.rate, 0.015))
      return 0.5 * f1(predicted.map(p => `${p.chamber}:${p.channel}`), keys) + 0.5 * mean(rates)
    }
    case 'A1': return answers ? rel(a.value, answers.Q1, 0.03) : 0
    case 'A2': return answers ? (a.value === answers.Q2 ? 1 : Math.abs(a.value - answers.Q2) === 1 ? 0.5 : 0) : 0
    case 'A3': return answers ? rel(a.value, answers.Q3, 0.2 * Math.abs(answers.Q3)) : 0
    case 'A4': return answers ? mean(Object.entries(answers.Q4).map(([key, value]) => rel(a[key], value, 5))) : 0
    case 'A5': return answers ? mean(Object.entries(answers.Q5).map(([key, value]) => rel(a[key], value, 0.05))) : 0
    case 'A6': return answers ? rel(a.value, answers.Q6, 0.1 * answers.Q6) : 0
    case 'A7': return answers ? rel(a.value, answers.Q7, 0.15 * answers.Q7) : 0
    case 'A8': return answers ? rel(a.value, answers.Q8, 0.05) : 0
    case 'X1': {
      const impact = contaminationImpact(truth, view)
      return 0.6 * mean([1, 2, 3, 4].map(v => { const t = impact.stress[`variety-${v}`] ?? 0; return numeric(a.stressTicks?.[`variety-${v}`], t, Math.max(10, 0.25 * t)) })) +
        0.4 * numeric(a.cleanAfterTicks, impact.cleanAfter, Math.max(20, 0.2 * impact.cleanAfter))
    }
    case 'X2': return stormPlan(truth, view, a as never, submission.tick)
    case 'X3': return scorePlan(truth, view, a as never).accuracy
    case 'D1': case 'D2': case 'D3': return 0
  }
}

/** Score of one duty slot from the last accepted submission in it (null when the slot has no truth yet). */
export function dutySlotScore(truth: Truth, view: WorldView, task: DutyId, slot: number, submission: Submission | undefined): number | null {
  const history = view.base.history
  const capacity = capacityAt(truth, slot * 96)
  if (task === 'D3') {
    const day = history.sols[String(slot)]
    if (!day) return null
    if (!submission) return 0
    const a = submission.answer as { energy: Estimate; minSoc: Estimate }
    return 0.5 * numeric(a.energy, day.solar, Math.max(5, 0.1 * day.solar)) + 0.3 * numeric(a.minSoc, day.minSoc, 0.08 * capacity) + 0.2 * (day.tierOneShedTicks === 0 ? 1 : 0)
  }
  const period = dutyPeriod(task, truth.load)
  const at = task === 'D1' ? slot * period + period / 2 : Math.min((slot + 1) * period, truth.horizon)
  const snapshot = history.snapshots[String(at)]
  if (!snapshot) return null
  if (!submission) return 0
  if (task === 'D1') {
    const a = submission.answer as Record<string, Estimate> & { sensors: Record<string, string> }
    const modules = ['reservoir', 'filter', 'pump']
    return 0.8 * mean(modules.map(m => numeric(a[m], snapshot.water[m]!, 0.15 * snapshot.water[m]!))) +
      0.2 * mean(modules.map(m => (a.sensors[m] === 'faulty') === snapshot.faultySensors.includes(m) ? 1 : 0))
  }
  const a = submission.answer as { crops: Record<string, string>; latent?: string[] }
  const healthy = CROP_IDS.filter(id => snapshot.crops[id] === 'healthy'), other = CROP_IDS.filter(id => snapshot.crops[id] !== 'healthy')
  const accuracyOf = (ids: string[]) => mean(ids.map(id => a.crops[id] === snapshot.crops[id] ? 1 : 0))
  const balanced = healthy.length && other.length ? 0.5 * accuracyOf(healthy) + 0.5 * accuracyOf(other) : accuracyOf(CROP_IDS)
  return 0.8 * balanced + 0.2 * f1(a.latent ?? [], snapshot.latent)
}
