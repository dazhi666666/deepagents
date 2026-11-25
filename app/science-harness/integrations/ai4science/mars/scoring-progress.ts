/** Progress P_j, evidence validity V_j and public minimum-evidence checks (spec v0.4). */
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { CHAMBERS, CROP_IDS, chamberOf, type Truth } from './truth.ts'
import { mean, resultsWithSource, rootOf, type Submission, type WorldView } from './scoring-common.ts'
import { dutyPeriod, dutySlot, dutyWindow, nextDutyWindow, type Evidence, type TaskId } from './deliverables.ts'

export interface EvidenceContext { analysisRuns: Set<string>; archiveQueries: Set<string>; readArtifacts: Set<string>; artifactsOf: (operationId: string) => string[] }
/** W2 series: distinct measuring times must start at least this many ticks apart and span at least W2_MIN_SPAN. */
export const W2_MIN_GAP = 20
export const W2_MIN_SPAN = 150
export const HOLD_TICKS = 48
/** G1 baseline conditions: light, nutrient level and CO2 setpoint. */
const BASELINE = { light: 70, nutrient: 1, co2: 800 }
const MODULES = ['reservoir', 'filter', 'pump']

const sampledAt = (view: WorldView, sampleId: string) => (view.sampleConditions[sampleId] as { tick?: number } | undefined)?.tick ?? 0

/** Ticks since the last completed change of the given chamber controls, as seen at `tick`. */
export function heldTicks(view: WorldView, chamberId: string, tick: number, actions: string[]) {
  let last = 0
  for (const op of view.systemOps) if (op.state === 'succeeded' && actions.includes(op.command.action) && op.command.chamberId === chamberId &&
    op.completedTick !== undefined && op.completedTick <= tick) last = Math.max(last, op.completedTick)
  return tick - last
}
/** Chamber control in effect at a tick, replayed from completed system operations. */
function controlAt(view: WorldView, chamberId: string, tick: number, action: string, field: string, fallback: number) {
  let value = fallback, at = -1
  for (const op of view.systemOps) if (op.state === 'succeeded' && op.command.action === action && op.command.chamberId === chamberId &&
    op.completedTick !== undefined && op.completedTick <= tick && op.completedTick >= at) { at = op.completedTick; value = Number(op.command[field]) }
  return value
}
function irrigationAt(view: WorldView, cropId: string, tick: number) {
  const crop = view.crops.find(value => value.id === cropId)
  return Math.round((crop?.irrigation ?? []).filter(([at]) => at > tick - 100 && at <= tick).reduce((sum, [, volume]) => sum + volume, 0) / 10) * 10
}

export interface GrowthObservation { cropId: string; light: number; nutrient: number; irrigation: number; co2: number; tick: number; lightHeld: number; treatmentHeld: number }
/** Growth observations: lab image results and chamber scans, with the conditions in effect at sampling. */
export function growthObservations(view: WorldView, resultIds: string[], operationIds: string[]): GrowthObservation[] {
  const results = new Map(resultsWithSource(view).map(result => [result.id, result]))
  const observations: GrowthObservation[] = []
  const held = (chamber: string, tick: number) => ({ lightHeld: heldTicks(view, chamber, tick, ['light']), treatmentHeld: heldTicks(view, chamber, tick, ['light', 'nutrient', 'co2']) })
  for (const id of resultIds) {
    const result = results.get(id)
    if (!result || result.methodId !== 'image' || !result.source?.startsWith('crop-')) continue
    const condition = view.sampleConditions[result.root] as Record<string, number> | undefined
    const tick = condition?.tick ?? 0, chamber = chamberOf(result.source)
    observations.push({ cropId: result.source, light: condition?.light ?? 70, nutrient: condition?.nutrient ?? 1, irrigation: Math.round((condition?.irrigationLast100 ?? 0) / 10) * 10,
      co2: condition?.co2Setpoint ?? 800, tick, ...held(chamber, tick) })
  }
  for (const id of operationIds) {
    const op = view.systemOps.find(value => value.id === id && value.command.action === 'scan' && value.state === 'succeeded')
    if (!op) continue
    const chamberId = String(op.command.chamberId), tick = op.completedTick ?? op.acceptedTick
    for (const cropId of CROP_IDS.filter(crop => chamberOf(crop) === chamberId))
      observations.push({ cropId, light: Number((op.result as Record<string, Json> | null)?.light ?? 70), nutrient: controlAt(view, chamberId, tick, 'nutrient', 'level', 1),
        irrigation: irrigationAt(view, cropId, tick), co2: controlAt(view, chamberId, tick, 'co2', 'setpoint', 800), tick, ...held(chamberId, tick) })
  }
  return observations
}

/** Confirm series of each mother water sample (a water_split mother and its aliquots), best first: how many results, how
 * many distinct measuring times (confirm starts at least W2_MIN_GAP ticks apart) and the span from the first start to the last. */
export function kineticSeries(view: WorldView, resultIds?: string[]) {
  const operations = new Map(view.lab.operations.map(op => [op.id, op]))
  const byRoot = new Map<string, number[]>()
  for (const result of resultsWithSource(view)) {
    if (result.methodId !== 'confirm' || !result.source || result.source.startsWith('crop-')) continue
    if (resultIds && !resultIds.includes(result.id)) continue
    const start = operations.get(result.operationId)?.acceptedTick
    if (start !== undefined) byRoot.set(result.root, [...byRoot.get(result.root) ?? [], start])
  }
  return [...byRoot.entries()].map(([root, starts]) => {
    const sorted = starts.sort((a, b) => a - b)
    let times = 0, anchor = -Infinity
    for (const value of sorted) if (value - anchor >= W2_MIN_GAP) { times++; anchor = value }
    const series = { root, results: sorted.length, times, span: sorted.at(-1)! - sorted[0]! }
    return { ...series, score: mean([series.results >= 2 ? 1 : 0, Math.min(1, series.results / 8), Math.min(1, series.times / 5), Math.min(1, series.span / W2_MIN_SPAN)]) }
  }).sort((a, b) => b.score - a.score)
}
/** Growth observations taken at the G1 baseline after the treatment was held HOLD_TICKS ticks. */
export const baselineObservations = (observations: GrowthObservation[]) => observations.filter(value => value.light === BASELINE.light &&
  value.nutrient === BASELINE.nutrient && value.co2 === BASELINE.co2 && value.treatmentHeld >= HOLD_TICKS)

export interface CheckContext { tick: number; load: string; horizon: number; analysisTick: (runId: string) => number | undefined; answered: number }

/** Results cited by result ID, or through the laboratory operation that produced them (op-N). */
export function citedResults(view: WorldView, evidence: Evidence) {
  const operations = new Set(evidence.operationIds)
  return resultsWithSource(view).filter(result => evidence.resultIds.includes(result.id) || operations.has(result.operationId))
}

/** Public-layer minimum evidence; returns problems (empty when acceptable). */
export function minimumEvidence(task: TaskId, evidence: Evidence, view: WorldView, check: CheckContext): string[] {
  const results = citedResults(view, evidence)
  const confirms = results.filter(result => result.methodId === 'confirm' && result.source && !result.source.startsWith('crop-'))
  const sources = new Set(confirms.map(result => result.source))
  const growth = growthObservations(view, evidence.resultIds, evidence.operationIds)
  const cited = view.systemOps.filter(op => evidence.operationIds.includes(op.id) && op.state === 'succeeded')
  const problems: string[] = []
  const need = (ok: boolean, message: string) => { if (!ok) problems.push(message) }
  switch (task) {
    case 'D1': case 'D2': {
      const slot = dutySlot(task, check.load, check.tick, check.horizon)
      if (slot === null) {
        const next = nextDutyWindow(task, check.load, check.horizon, check.tick)
        problems.push(next ? `No ${task} window is open at tick ${check.tick}; the next one is ${next.from}-${next.to - 1}` : `No ${task} window remains before the horizon`)
        break
      }
      const [from, to] = dutyWindow(task, check.load, slot, check.horizon)
      if (task === 'D1') {
        const recent = confirms.some(result => sampledAt(view, result.root) >= from - dutyPeriod(task, check.load) && sampledAt(view, result.root) < to)
        const reference = cited.some(op => op.command.action === 'device_reference' && MODULES.includes(String(op.command.targetId)) && (op.completedTick ?? -1) >= from && (op.completedTick ?? -1) < to)
        need(recent || reference, `Cite one water confirm result sampled since tick ${from - dutyPeriod(task, check.load)} or one water-module device_reference completed in ${from}-${to - 1}; one source is enough, unanswered modules score 0 individually`)
      } else {
        const scanned = new Set(cited.filter(op => op.command.action === 'scan' && (op.completedTick ?? -1) >= from && (op.completedTick ?? -1) < to).map(op => String(op.command.chamberId)))
        need(CHAMBERS.every(chamber => scanned.has(chamber)),
          `Cite greenhouse_scan operations completed in ${from}-${to - 1} for every chamber; missing ${CHAMBERS.filter(chamber => !scanned.has(chamber)).join(', ') || 'none'}`)
      }
      break
    }
    case 'D3': {
      const slot = dutySlot('D3', check.load, check.tick, check.horizon)
      if (slot === null) {
        const next = nextDutyWindow('D3', check.load, check.horizon, check.tick)
        problems.push(next ? `D3 accepts submissions in sol ${next.slot}: ${next.from}-${next.to - 1}` : 'No D3 window remains before the horizon')
        break
      }
      need(evidence.analysisRunIds.some(id => { const at = check.analysisTick(id); return at !== undefined && at >= check.tick - 120 }), 'Cite an analysis_run made within the last 120 ticks')
      break
    }
    case 'W1': case 'W4':
      need(MODULES.every(source => sources.has(source)), 'Cite at least one confirm result from each of reservoir, filter and pump')
      need(evidence.analysisRunIds.length > 0, 'Cite at least one analysis_run that processed raw chromatograms'); break
    case 'W2':
      need(kineticSeries(view, evidence.resultIds).some(series => series.results >= 8 && series.times >= 4 && series.span >= W2_MIN_SPAN),
        `Cite at least 8 confirm results of one mother sample (water_split aliquots) measured at 4 or more times at least ${W2_MIN_GAP} ticks apart (by confirm start), the first and last at least ${W2_MIN_SPAN} ticks apart`); break
    case 'W3': need(confirms.length >= 4, 'Cite at least 4 confirm results'); break
    case 'G1': need(new Set(baselineObservations(growth).map(value => value.cropId)).size >= 10,
      `Cite growth observations (greenhouse_scan operations or image results) of at least 10 distinct crops, taken at the baseline (light 70, nutrient 1, CO2 800) held ${HOLD_TICKS} ticks`); break
    case 'G2': {
      const held = growth.filter(value => value.lightHeld >= HOLD_TICKS)
      need(held.length >= 8 && new Set(held.map(value => value.light)).size >= 3, `Cite at least 8 growth observations taken after the chamber light was held ${HOLD_TICKS} ticks, spanning 3 light settings`); break
    }
    case 'G3': {
      const variety = growth.filter(value => value.cropId.endsWith('-2') && value.treatmentHeld >= HOLD_TICKS)
      need(variety.length >= 5 && new Set(variety.map(value => `${value.nutrient}/${value.irrigation}/${value.co2}`)).size >= 3,
        `Cite at least 5 variety-2 growth observations taken after the treatment was held ${HOLD_TICKS} ticks, across 3 treatment combinations`); break
    }
    case 'G4': {
      const covered = new Set([...growth.map(value => value.cropId), ...results.filter(result => result.methodId === 'confirm' && result.source?.startsWith('crop-')).map(result => result.source!)])
      need(covered.size >= 8, 'Cite hyperspectral or pathogen evidence covering at least 8 crops'); break
    }
    case 'F1': need(evidence.analysisRunIds.length >= 2, 'Cite at least 2 analysis_run IDs'); break
    case 'F2': case 'X2': need(evidence.analysisRunIds.length >= 1, 'Cite at least 1 analysis_run ID'); break
    case 'F3': need(cited.filter(op => op.command.action === 'device_reference').length >= 3, 'Cite at least 3 device_reference operations'); break
    case 'A1': case 'A2': case 'A3': case 'A4': case 'A5': case 'A6': case 'A7': case 'A8':
      need(evidence.archiveQueryIds.length + evidence.analysisRunIds.length >= 1, 'Cite at least one archive query or analysis run'); break
    case 'X1': need(confirms.length >= 1 && evidence.analysisRunIds.length >= 1, 'Cite at least one water confirm result and one analysis_run'); break
    case 'X3': need(growth.length >= 1, 'Cite at least one of your own growth observations'); break
  }
  return problems
}

/** Fraction of cited evidence that exists, succeeded, was read and is traceable. */
export function evidenceValidity(evidence: Evidence, view: WorldView, context: EvidenceContext) {
  const checks: boolean[] = []
  const operations = new Map(view.lab.operations.map(op => [op.id, op]))
  for (const id of evidence.resultIds) {
    const result = view.lab.results.find(value => value.id === id)
    const op = result && operations.get(result.operationId)
    checks.push(Boolean(op && op.state === 'succeeded' && context.artifactsOf(op.id).some(artifact => context.readArtifacts.has(artifact)) && view.sampleSources[rootOf(view.lab, result!.sampleId)]))
  }
  for (const id of evidence.operationIds) checks.push(view.systemOps.some(op => op.id === id && op.state === 'succeeded') || operations.get(id)?.state === 'succeeded')
  for (const id of evidence.analysisRunIds) checks.push(context.analysisRuns.has(id))
  for (const id of evidence.archiveQueryIds) checks.push(context.archiveQueries.has(id))
  for (const id of evidence.artifactIds) checks.push(context.readArtifacts.has(id))
  return checks.length ? checks.filter(Boolean).length / checks.length : 0
}

/** Progress milestones from the physical record, independent of what was claimed. */
export function progress(task: TaskId, truth: Truth, view: WorldView, finals: Map<string, Submission>, context: EvidenceContext): number {
  const submitted = finals.has(task) ? 1 : 0
  const results = resultsWithSource(view)
  const sampled = (source: string, before: number, after = -1) => Object.entries(view.sampleSources).some(([id, value]) => value === source &&
    sampledAt(view, id) < before && sampledAt(view, id) >= after)
  const confirmed = (source: string, before: number, after = -1) => results.some(result => result.methodId === 'confirm' && result.source === source &&
    sampledAt(view, result.root) < before && sampledAt(view, result.root) >= after)
  const all = growthObservations(view, results.map(result => result.id), view.systemOps.map(op => op.id))
  const contamination = truth.contamination[0]!.onset
  switch (task) {
    case 'W1': return mean([...MODULES.map(m => sampled(m, contamination) ? 1 : 0), ...MODULES.map(m => confirmed(m, contamination) ? 1 : 0), submitted])
    case 'W2': return mean([kineticSeries(view)[0]?.score ?? 0, submitted])
    case 'W3': {
      const byRoot = (predicate: (r: typeof results[number]) => boolean) => new Set(results.filter(r => r.methodId === 'confirm' && predicate(r)).map(r => r.root))
      const v1 = byRoot(r => r.methodVersion === 1), v2 = byRoot(r => r.methodVersion === 2)
      const a2 = new Set(results.filter(r => r.batchIds.includes(truth.lots.A2)).map(r => r.root)), b = new Set(results.filter(r => r.batchIds.includes(truth.lots.B)).map(r => r.root))
      return mean([Math.min(1, [...v1].filter(r => v2.has(r)).length / 2), Math.min(1, [...a2].filter(r => b.has(r)).length / 2), submitted])
    }
    case 'W4': return mean([...MODULES.map(m => sampled(m, Infinity, contamination) ? 1 : 0), ...MODULES.map(m => confirmed(m, Infinity, contamination) ? 1 : 0), submitted])
    case 'G1': {
      const baseline = baselineObservations(all)
      return mean([...CROP_IDS.map(id => Math.min(1, baseline.filter(value => value.cropId === id).length / 3)), submitted])
    }
    case 'G2': return mean([...[1, 2, 3, 4].map(v => Math.min(1, new Set(all.filter(o => o.cropId.endsWith(`-${v}`) && o.lightHeld >= HOLD_TICKS).map(o => o.light)).size / 4)), submitted])
    case 'G3': return mean([Math.min(1, new Set(all.filter(o => o.cropId.endsWith('-2') && o.treatmentHeld >= HOLD_TICKS).map(o => `${o.nutrient}/${o.irrigation}/${o.co2}`)).size / 6), submitted])
    case 'G4': return mean([new Set(all.filter(o => o.tick >= truth.pathogen.onset).map(o => o.cropId)).size / 16, results.some(r => r.methodId === 'confirm' && r.source?.startsWith('crop-')) ? 1 : 0, submitted])
    case 'F1': return mean([context.analysisRuns.size >= 1 ? 1 : 0, view.systemOps.some(op => op.command.action === 'panel_clean' && op.state === 'succeeded') ? 1 : 0, submitted])
    case 'F2': return mean([context.analysisRuns.size >= 1 ? 1 : 0, submitted])
    case 'F3': {
      const references = view.systemOps.filter(op => op.command.action === 'device_reference' && op.state === 'succeeded')
      return mean([references.length ? 1 : 0, mean(truth.drift.map(d => references.filter(op => op.command.targetId === d.chamber).length >= 2 ? 1 : 0)), submitted])
    }
    case 'A1': case 'A2': case 'A3': case 'A4': case 'A5': case 'A6': case 'A7': case 'A8': return mean([context.archiveQueries.size > 0 ? 1 : 0, submitted])
    case 'X1': return mean([MODULES.some(m => confirmed(m, Infinity, contamination)) ? 1 : 0, context.analysisRuns.size > 0 ? 1 : 0, submitted])
    case 'X2': {
      const storm = truth.storms[0]
      const prepared = storm ? view.systemOps.some(op => op.command.action === 'power_priority' && op.state === 'succeeded' && op.acceptedTick < storm.onset) : false
      return mean([context.analysisRuns.size > 0 ? 1 : 0, prepared ? 1 : 0, submitted])
    }
    case 'X3': return mean(['G2', 'G3', 'W4', 'F1'].map(id => finals.has(id) ? 1 : 0))
    case 'D1': case 'D2': case 'D3': return submitted
  }
}
