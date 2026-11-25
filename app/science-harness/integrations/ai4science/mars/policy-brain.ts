/** Brain role line of the scripted reference (team.ts SOPs X1-X3 and the cross-domain incident reports): the storm plan
 * as soon as the dust optical depth climbs, the reports the team owes from the notices and its own findings, the
 * contamination impact assessment and the next-phase plan. The brain has no physical tools; everything it knows comes
 * from telemetry, the alerts, the archive and the other roles' results.
 */
import { CHAMBERS, CROP_IDS } from './truth.ts'
import { SHED_FIRST, est, type ReferencePolicy, type RoleStep } from './policies.ts'
import { lesionOnsets } from './policy-greenhouse.ts'

/** tau_dust sits near 0.5 between storms and climbs for about 24 ticks before one; 0.7 is four noise deviations above it. */
const DUST_HIGH = 0.7

export const BRAIN_STEPS: readonly RoleStep[] = [
  { kind: 'safety', run: stormPlan }, { kind: 'safety', run: reports }, { kind: 'deadline', run: contamination }, { kind: 'deadline', run: nextPhase },
]

/** Start of the dust episode under way (tau_dust high within the last window), or null while the sky is clear. */
export function dustEpisode(p: ReferencePolicy, tick: number) {
  const rows = p.telemetry('energy.tau_dust', Math.max(0, tick - 400), tick)
  if (!rows.some(([at, value]) => at > tick - p.windowTicks && value >= DUST_HIGH)) return null
  let start = tick
  for (let index = rows.length - 1; index >= 0; index--) {
    const [at, value] = rows[index]!
    if (value >= DUST_HIGH) start = at
    else if (start - at > 30) break
  }
  return start
}

/** X2: submit the storm plan as soon as tau_dust begins to rise, which leads the storm by about 24 ticks. */
async function stormPlan(p: ReferencePolicy, tick: number) {
  if (p.done.has('X2')) return
  const episode = dustEpisode(p, tick)
  if (episode === null) return
  // A plan is due before the storm; once the dust has been high for a while the storm has begun and the task is lost.
  if (tick - episode > 30) { p.done.add('X2'); return }
  if (p.submit(tick, 'X2', { targetSoc: 90, powerPriority: [...SHED_FIRST, ...CHAMBERS, 'cold-1', 'cold-2', 'freezer', 'robot-2'],
    chamberLight: Object.fromEntries(CHAMBERS.map(id => [id, 35])) }, { analysisRunIds: [p.analysis(tick)] })) p.done.add('X2')
}

/** Cross-domain reports, one per decision: a dust storm the array telemetry shows, the recalled sub-batch from the quality
 * notice and the archive, the confirm method change from its notice, the pathogen from the earliest lesions the scans
 * saw, and a robot that has run flat. Water, leak and sensor reports come from the roles that find them. */
async function reports(p: ReferencePolicy, tick: number) {
  const episode = dustEpisode(p, tick)
  if (episode !== null && episode - p.slot<number>('report:dust', () => -1000) > 200) {
    p.report(tick, ['energy', 'solar-array', 'battery'], 'dust-storm', ['solar-array', 'dust'])
    p.state['report:dust'] = episode
    return
  }
  if (!p.done.has('report:recall')) {
    const recall = p.recalledLot()
    if (recall.lot) { p.report(tick, ['extraction', recall.lot, recall.subBatch ?? ''], 'reagent-recall', [recall.lot]); p.done.add('report:recall'); return }
  }
  if (!p.done.has('report:method') && p.alert('announcement', data => data.kind === 'method-notice')) {
    p.report(tick, ['confirm'], 'method-change', ['confirm'])
    p.done.add('report:method')
    return
  }
  if (!p.done.has('report:pathogen')) {
    const first = [...lesionOnsets(p, tick).entries()].sort((a, b) => a[1] - b[1])[0]
    if (first) {
      p.report(tick, [first[0], `incubator-${first[0].split('-')[1]}`], 'pathogen', [first[0]])
      p.done.add('report:pathogen')
      return
    }
  }
  // E7: a robot that has stopped answering is a failure the team can see from its own status view.
  for (const robot of p.world.observeSystems().robots) {
    if (robot.energy > 0.05 * 120 || p.done.has(`report:${robot.id}`)) continue
    p.report(tick, [robot.id], 'robot-failure', [robot.id])
    p.done.add(`report:${robot.id}`)
    return
  }
}

/** Water-side incident record the water line keeps: when the contamination was first seen on a real module, what was
 * diagnosed, the pump DOC measured after it, and when the last fix completed. */
export interface WaterIncident { onset: number; hypotheses: string[]; pumpDoc: number | null; fixed: number | null; resultIds: string[] }

/** X1: stress from irrigating with the dirty loop, per variety, and the ticks until the loop ran clean. Every irrigation
 * from the main loop between the first alarm and the last fix, while the pump outlet measured above the 2.5 mg/L
 * irrigation limit, exposed each plant in that chamber for 20 ticks. */
async function contamination(p: ReferencePolicy, tick: number) {
  if (p.done.has('X1')) return
  const incident = p.state['water:incident'] as WaterIncident | undefined
  if (!incident) return
  const deadline = p.after('X1', incident.onset)
  if (tick > deadline) { p.done.add('X1'); return }
  if (incident.fixed === null && tick < deadline - 3 * p.windowTicks) return
  const clean = incident.fixed ?? tick
  const dirty = (incident.pumpDoc ?? 0) > 2.5
  const stress: Record<string, number> = Object.fromEntries([1, 2, 3, 4].map(variety => [`variety-${variety}`, 0]))
  const crops = p.world.sensors().crops
  for (const op of p.ops()) {
    if (!dirty || op.command.action !== 'irrigate' || op.state !== 'succeeded') continue
    const at = op.completedTick ?? 0
    if (at < incident.onset || at >= clean || (op.result as { source?: string } | null)?.source !== 'main') continue
    for (const crop of crops.filter(value => value.chamberId === (op.command as { chamberId?: string }).chamberId && !value.removed)) stress[`variety-${crop.variety}`]! += 20
  }
  const cleanAfter = clean - incident.onset
  const answer = Object.fromEntries(Object.entries(stress).map(([key, value]) => [key, est(value, Math.max(10, 0.25 * value))]))
  // Evidence: the incident's own confirms, or the line's earlier confirms of the loop if those are not in yet.
  const confirms = incident.resultIds.length ? incident.resultIds : p.submissions.filter(submission => ['W1', 'W4'].includes(submission.taskId)).flatMap(submission => submission.evidence.resultIds)
  if (!confirms.length) return
  if (p.submit(tick, 'X1', { stressTicks: answer, cleanAfterTicks: est(cleanAfter, Math.max(20, 0.2 * cleanAfter)) },
    { resultIds: confirms.slice(-3), analysisRunIds: [p.analysis(tick)] })) p.done.add('X1')
}

/** X3: the next-phase plan near the end, from the team's own findings: each chamber's light at the mean of its varieties'
 * fitted optima, the best G3 treatment, the main loop only once the contamination is fixed, and a load the battery and
 * panels measured in F1 can carry through the night. */
async function nextPhase(p: ReferencePolicy, tick: number) {
  if (p.done.has('X3') || tick < p.world.horizon - 200) return
  const growth = p.submissions.filter(submission => ['G1', 'G2', 'G3'].includes(submission.taskId)).flatMap(submission => submission.evidence.operationIds)
  if (!growth.length) return
  const fitted = p.slot<Record<number, number>>('g2:fit', () => ({}))
  const best = p.state['g3:best'] as { nutrient: number; co2: number; irrigation: number } | undefined
  const incident = p.state['water:incident'] as WaterIncident | undefined
  // The main loop is trusted only when no real alarm stands: an open incident, or an inline reading above its limit on
  // a module not found false, keeps irrigation on the reserve.
  const inline = p.world.sensors().water.inlineDoc, limits: Record<string, number> = { reservoir: 7, filter: 2.5, pump: 2.5 }
  const alarming = Object.entries(inline).some(([module, value]) => value > (limits[module] ?? 2.5) && p.state['water:decoy'] !== module)
  const contaminated = (incident !== undefined && incident.fixed === null) || alarming
  const capacity = p.slot<number>('f1:battery', () => 0)
  const crops = p.world.sensors().crops
  const chambers: Record<string, { light: number; nutrient: number; co2: number; temperature: number }> = {}
  for (const chamber of CHAMBERS) {
    const varieties = crops.filter(crop => crop.chamberId === chamber && crop.status !== 'lost').map(crop => crop.variety)
    const optima = varieties.map(variety => fitted[variety]).filter((value): value is number => value !== undefined)
    let light = optima.length ? optima.reduce((sum, value) => sum + value, 0) / optima.length : 70
    light = Math.round(Math.min(90, Math.max(40, light)))
    chambers[chamber] = { light, nutrient: best?.nutrient ?? 1, co2: best?.co2 ?? 800, temperature: 22 }
  }
  // Night load (lights, chambers, cold stores) must fit the battery the F1 identification measured, with a margin.
  const demand = () => CHAMBERS.reduce((sum, id) => sum + 0.5 + 0.5 * chambers[id]!.light / 70, 0) + 6.5
  while (capacity > 0 && demand() * 48 > 0.9 * capacity && CHAMBERS.some(id => chambers[id]!.light > 40))
    for (const id of CHAMBERS) chambers[id]!.light = Math.max(40, chambers[id]!.light - 5)
  // On the reserve, the 500 ticks of irrigation must fit what is left of it.
  const alive = crops.filter(crop => crop.status !== 'lost').length
  const reserve = p.world.sensors().water.reserveUl
  const irrigation = Math.round(Math.min(75, best?.irrigation ?? 75, contaminated ? 0.9 * reserve / 5 / Math.max(1, alive) : 75))
  if (p.submit(tick, 'X3', { chambers, irrigation: Object.fromEntries(CROP_IDS.map(id => [id, irrigation])), waterSource: contaminated ? 'reserve' : 'main',
    powerPriority: [...SHED_FIRST, ...CHAMBERS, 'cold-1', 'cold-2', 'freezer', 'robot-2'], panelCleanEveryTicks: 200, sampleStorage: 'cold' },
    { operationIds: growth.slice(-8) })) p.done.add('X3')
}
