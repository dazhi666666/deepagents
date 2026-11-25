/** Greenhouse role lines of the scripted reference: the crops line (irrigation, removal of symptomatic plants, quarantine,
 * D2 inspection) and the agronomist line (G1 baseline, G2 light response, G3 nutrient x irrigation x CO2, G4 disease
 * parameters, then the growth-friendly light). Scans and chamber settings are chamber-exclusive, so both lines go through
 * the shared scan helper, which never issues a second scan for a chamber that already has one in flight. Both lines read
 * every scan in the base, whoever asked for it, and only what the scans, sensors and alerts show.
 */
import { CHAMBERS, CROP_IDS } from './truth.ts'
import { est, type ReferencePolicy, type RoleStep } from './policies.ts'
import { dutySlot, dutyWindow } from './deliverables.ts'
import { HOLD_TICKS } from './scoring-progress.ts'
import { dustEpisode } from './policy-brain.ts'

const MIN_MOISTURE = [30, 35, 40, 38]
const BASELINE_LIGHT = 70
/** Chamber light during a dust storm (the X2 plan's setting). */
const STORM_LIGHT = 35
const G2_ROUNDS = [{ start: 120, lights: [35, 55, 75, 95] }, { start: 420, lights: [95, 75, 55, 35] }, { start: 760, lights: [55, 35, 95, 75] }]
const G2_HOLD = 56
/** One G3 treatment per chamber, tried in order; the best variety-2 growth wins. */
const G3_TREATMENTS = [{ nutrient: 2 as const, co2: 800, irrigation: 75 }, { nutrient: 3 as const, co2: 1000, irrigation: 75 }, { nutrient: 2 as const, co2: 1000, irrigation: 60 }]

export const CROPS_STEPS: readonly RoleStep[] = [{ kind: 'safety', run: removeSymptomatic }, { kind: 'duty', run: irrigate }, { kind: 'duty', run: inspection }]
export const AGRONOMIST_STEPS: readonly RoleStep[] = [
  { kind: 'safety', run: stormLights },
  { kind: 'deadline', run: baseline }, { kind: 'deadline', run: lightRounds }, { kind: 'deadline', run: nutrients }, { kind: 'deadline', run: disease },
  { kind: 'other', run: restoreLight },
]

/** First tick each crop showed visible lesions in any scan so far. */
export function lesionOnsets(p: ReferencePolicy, tick: number) {
  const first = new Map<string, number>()
  for (const scan of p.scanObservations(CHAMBERS, 0, tick).sort((a, b) => a.tick - b.tick))
    for (const value of scan.values) if (value.visibleLesions && !first.has(value.cropId)) first.set(value.cropId, scan.tick)
  return first
}
/** Tick since which a chamber's settings have matched `target`, as the line saw them at its own decisions. */
function heldSince(p: ReferencePolicy, chamber: string, key: string, matches: boolean, tick: number) {
  const record = p.slot<Record<string, number | null>>(`held:${key}`, () => ({}))
  if (!matches) { record[chamber] = null; return null }
  record[chamber] ??= tick
  return record[chamber]!
}

/** Water every chamber whose driest plant is running low, in one batch; a chamber in flight is skipped. */
async function irrigate(p: ReferencePolicy, tick: number) {
  void tick
  const busy = new Set(p.ops().filter(op => op.state === 'running' && (op.command as { action?: string }).action === 'irrigate').map(op => (op.command as { chamberId: string }).chamberId))
  for (const chamber of CHAMBERS) {
    if (busy.has(chamber)) continue
    const crops = p.world.sensors().crops.filter(crop => crop.chamberId === chamber && crop.status !== 'lost' && crop.moistureReading !== null)
    if (!crops.length) continue
    const driest = Math.min(...crops.map(crop => crop.moistureReading!))
    const needs = crops.some(crop => crop.moistureReading! < MIN_MOISTURE[crop.variety - 1]! + 14)
    if (!needs && driest > MIN_MOISTURE[crops[0]!.variety - 1]! + 20) continue
    await p.house({ action: 'irrigate', chamberId: chamber, volumeUl: 300 })
  }
}

/** E10: remove the plants the scans show with visible lesions, in one decision. */
async function removeSymptomatic(p: ReferencePolicy, tick: number) {
  const removed = p.slot<string[]>('crops:removed', () => [])
  for (const [cropId] of lesionOnsets(p, tick)) {
    if (removed.includes(cropId)) continue
    if (await p.house({ action: 'crop_remove', cropId })) removed.push(cropId)
  }
}

/** D2: scan all four chambers in the window's second quarter, then classify every plant from those scans. */
async function inspection(p: ReferencePolicy, tick: number) {
  const load = p.world.truth.load, slot = dutySlot('D2', load, tick, p.world.horizon)
  if (slot === null || p.done.has(`D2:${slot}`)) return
  const [from, to] = dutyWindow('D2', load, slot, p.world.horizon)
  if (tick < from + (to - from) / 4) return
  const scans = p.scanObservations(CHAMBERS, from, tick)
  if (new Set(scans.map(scan => scan.chamber)).size < CHAMBERS.length) { await p.requestScans(CHAMBERS.filter(chamber => !scans.some(scan => scan.chamber === chamber)), tick); return }
  const status = new Map(p.world.sensors().crops.map(crop => [crop.id, crop.status]))
  const stored = new Map(p.world.observeSystems().crops.map(crop => [crop.id, crop.removed] as const))
  const labels: Record<string, string> = {}, latent: string[] = []
  for (const scan of scans) for (const value of scan.values) {
    const state = status.get(value.cropId) ?? 'healthy'
    labels[value.cropId] = stored.get(value.cropId) || value.status === 'lost' || state === 'lost' ? 'lost' : value.visibleLesions ? 'infected' : state
  }
  if (Object.keys(labels).length < CROP_IDS.length) return
  if (p.submit(tick, 'D2', { crops: labels, latent }, { operationIds: scans.map(scan => scan.id) })) p.done.add(`D2:${slot}`)
}

/** E1: while dust dims the array, hold every chamber at the storm plan's light so the chambers and cold stores keep power;
 * when the sky clears, put back the setting each chamber had. */
async function stormLights(p: ReferencePolicy, tick: number) {
  const settings = p.world.sensors().chambers
  const saved = p.slot<Record<string, number> | null>('storm:lights', () => null)
  const busy = (chamber: string) => p.ops().some(op => !['succeeded', 'failed', 'cancelled'].includes(op.state) && (op.command as { chamberId?: string }).chamberId === chamber)
  if (dustEpisode(p, tick) !== null) {
    if (!saved) p.state['storm:lights'] = Object.fromEntries(settings.map(chamber => [chamber.id, chamber.lightSetting]))
    for (const chamber of settings) if (chamber.lightSetting > STORM_LIGHT && !busy(chamber.id)) await p.house({ action: 'light', chamberId: chamber.id, level: STORM_LIGHT })
    return
  }
  if (!saved) return
  for (const chamber of settings) if (Math.abs(chamber.lightSetting - saved[chamber.id]!) >= 1 && !busy(chamber.id)) await p.house({ action: 'light', chamberId: chamber.id, level: saved[chamber.id]! })
  if (settings.every(chamber => Math.abs(chamber.lightSetting - saved[chamber.id]!) < 1)) p.state['storm:lights'] = null
}

/** After the light experiments, hold the growth-friendly setting on every chamber. */
async function restoreLight(p: ReferencePolicy, tick: number) {
  if (!p.done.has('G2') && !p.done.has('G3')) return
  if (tick < 1500) return
  const busy = new Set(p.ops().filter(op => !['succeeded', 'failed', 'cancelled'].includes(op.state)).map(op => (op.command as { chamberId?: string }).chamberId))
  for (const chamber of CHAMBERS) {
    if (busy.has(chamber)) continue
    const setting = p.world.sensors().chambers.find(value => value.id === chamber)!.lightSetting
    if (Math.abs(setting - BASELINE_LIGHT) < 1) continue
    if (await p.house({ action: 'light', chamberId: chamber, level: BASELINE_LIGHT })) return
  }
}

/** G1: hold the baseline settings, scan each chamber at least twice after the hold, and report the mean growth per crop. */
async function baseline(p: ReferencePolicy, tick: number) {
  if (p.done.has('G1')) return
  if (tick > p.deadline('G1') - 80) { p.done.add('G1'); return }
  const start = p.slot<number>('g1:start', () => tick)
  if (tick < start + HOLD_TICKS) return
  const scans = p.scanObservations(CHAMBERS, start + HOLD_TICKS, tick)
  p.state['g1:scans'] = [...new Set([...p.slot<string[]>('g1:scans', () => []), ...scans.map(scan => scan.id)])]
  const rounds = new Set(scans.map(scan => Math.floor((scan.tick - start) / 60)))
  if (rounds.size < 2) {
    const round = Math.floor((tick - start) / 60)
    await p.requestScans(CHAMBERS.filter(chamber => !scans.some(scan => scan.chamber === chamber && Math.floor((scan.tick - start) / 60) === round)), tick)
    return
  }
  const answer = growthByCrop(p, p.slot<string[]>('g1:scans', () => []), 0.12)
  if (!answer) return
  if (p.submit(tick, 'G1', answer, { operationIds: p.slot<string[]>('g1:scans', () => []) })) p.done.add('G1')
}

/** G2: hold each of three light rounds for 56 ticks, scan every chamber, then fit the per-variety response. */
async function lightRounds(p: ReferencePolicy, tick: number) {
  if (p.done.has('G2')) return
  if (tick > p.deadline('G2')) { p.done.add('G2'); return }
  const index = p.slot<number>('g2:round', () => 0)
  const round = G2_ROUNDS[index]
  if (!round) { fit(p, tick); return }
  // G1 comes first: changing the chamber lights invalidates the baseline G1 measures. The rounds start once G1 has
  // reported, or once its deadline has passed.
  if (tick < round.start || !p.done.has('G1') || p.state['storm:lights']) return
  const settings = p.world.sensors().chambers
  const since = CHAMBERS.map((chamber, position) => heldSince(p, chamber, `g2:${index}`, settings[position]!.lightSetting === round.lights[position], tick))
  const pending = CHAMBERS.filter((_, position) => since[position] === null)
  if (pending.length) {
    for (const chamber of pending) {
      if (p.ops().some(op => op.state === 'running' && (op.command as { action?: string }).action === 'light' && (op.command as { chamberId?: string }).chamberId === chamber)) continue
      await p.house({ action: 'light', chamberId: chamber, level: round.lights[CHAMBERS.indexOf(chamber)]! })
    }
    return
  }
  const held = Math.max(...since.map(value => value!))
  if (tick - held < G2_HOLD) return
  const scans = p.scanObservations(CHAMBERS, held + G2_HOLD, tick)
  p.state['g2:scans'] = [...new Set([...p.slot<string[]>('g2:scans', () => []), ...scans.map(scan => scan.id)])]
  if (new Set(scans.map(scan => scan.chamber)).size < CHAMBERS.length) { await p.requestScans(CHAMBERS.filter(chamber => !scans.some(scan => scan.chamber === chamber)), tick); return }
  p.state['g2:round'] = index + 1
}
/** Fit growth against light per variety from the G2 scans (a quadratic in light on the log scale) and submit. */
function fit(p: ReferencePolicy, tick: number) {
  const scans = p.scanObservations(CHAMBERS, 0, tick).filter(scan => p.slot<string[]>('g2:scans', () => []).includes(scan.id))
  const points: Record<number, [number, number][]> = {}
  for (const scan of scans) for (const value of scan.values) {
    if (!(value.growthIndex! > 0)) continue
    const variety = Number(value.cropId.split('-').at(-1))
    points[variety] = [...points[variety] ?? [], [scan.light, Math.log(value.growthIndex! / (1 + 0.004 * (scan.light - BASELINE_LIGHT)))]]
  }
  if (Object.keys(points).length < 4) return
  const answer: Record<string, unknown> = {}
  for (const variety of [1, 2, 3, 4]) {
    const data = points[variety] ?? []
    if (data.length < 4) return
    const n = data.length, sx = (k: number) => data.reduce((sum, [x]) => sum + x ** k, 0), sxy = (k: number) => data.reduce((sum, [x, y]) => sum + x ** k * y, 0)
    const matrix = [[sx(4), sx(3), sx(2)], [sx(3), sx(2), sx(1)], [sx(2), sx(1), n]], vector = [sxy(2), sxy(1), sxy(0)]
    const det = (a: number[][]) => a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) - a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) + a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!)
    const d = det(matrix), solve = (column: number) => det(matrix.map((row, i) => row.map((value, j) => j === column ? vector[i]! : value))) / d
    const a = d ? solve(0) : 0, b = d ? solve(1) : 0
    const lightOpt = a < 0 ? Math.min(100, Math.max(30, -b / (2 * a))) : 65, width = a < 0 ? Math.min(60, Math.max(15, Math.sqrt(-1 / a))) : 35
    answer[`variety-${variety}`] = { lightOpt: est(lightOpt, 10), width: est(width, 10) }
  }
  p.state['g2:fit'] = Object.fromEntries(Object.entries(answer).map(([key, value]) => [Number(key.split('-')[1]), (value as { lightOpt: { est: number } }).lightOpt.est]))
  if (p.submit(tick, 'G2', answer, { operationIds: p.slot<string[]>('g2:scans', () => []) })) p.done.add('G2')
}

/** G3: try one treatment per chamber, scan variety 2 after it is held, and submit the best combination found. */
async function nutrients(p: ReferencePolicy, tick: number) {
  if (p.done.has('G3')) return
  if (tick > p.deadline('G3')) { p.done.add('G3'); return }
  if (tick < 900) return
  const done = p.slot<number>('g3:done', () => 0)
  const treatment = G3_TREATMENTS[done]
  if (!treatment) { submitG3(p, tick); return }
  const chamber = CHAMBERS[done]!
  const current = p.world.sensors().chambers.find(value => value.id === chamber)!
  const since = heldSince(p, chamber, `g3:${done}`, current.nutrient === treatment.nutrient && current.co2Setpoint === treatment.co2, tick)
  if (since === null) {
    if (p.ops().some(op => op.state === 'running' && (op.command as { chamberId?: string }).chamberId === chamber && ['nutrient', 'co2'].includes(String(op.command.action)))) return
    if (current.nutrient !== treatment.nutrient) {
      const medium = p.world.observe().batches.find(batch => batch.kind === 'medium' && batch.disposition === 'available' && batch.units >= 2 && batch.expiresAt >= tick)
      if (medium) await p.house({ action: 'nutrient', chamberId: chamber, level: treatment.nutrient, batchId: medium.id })
    } else await p.house({ action: 'co2', chamberId: chamber, setpoint: treatment.co2 })
    return
  }
  if (tick - since < HOLD_TICKS) return
  const scans = p.scanObservations([chamber], since + HOLD_TICKS, tick)
  if (scans.length < 2) { await p.requestScans([chamber], tick); return }
  const values = scans.flatMap(scan => scan.values.filter(value => value.cropId.endsWith('-2')).map(value => value.growthIndex!)).filter(value => value > 0)
  if (!values.length) return
  p.state['g3:done'] = done + 1
  p.slot<number[]>('g3:growth', () => []).push(values.reduce((sum, value) => sum + value, 0) / values.length)
  const stored = p.slot<Record<string, string[]>>('g3:scans', () => ({}))
  stored[chamber] = [...stored[chamber] ?? [], ...scans.map(scan => scan.id)]
}
function submitG3(p: ReferencePolicy, tick: number) {
  const growth = p.slot<number[]>('g3:growth', () => [])
  if (!growth.length) return
  const best = growth.indexOf(Math.max(...growth))
  const treatment = G3_TREATMENTS[best]!
  p.state['g3:best'] = treatment
  const ops = Object.values(p.slot<Record<string, string[]>>('g3:scans', () => ({}))).flat()
  const observed = Math.max(0.1, growth[best]!)
  if (p.submit(tick, 'G3', { nutrient: treatment.nutrient, irrigation: treatment.irrigation, co2: treatment.co2,
    predictedGrowth: est(observed, 0.12 * observed + 0.05) }, { operationIds: ops })) p.done.add('G3')
}

/** G4: once at least two plants have shown lesions, the earliest is the index case; lambda from how fast symptoms spread
 * among the plants scanned before it. More scans are asked for while the evidence is thin. */
async function disease(p: ReferencePolicy, tick: number) {
  if (p.done.has('G4')) return
  const onsets = [...lesionOnsets(p, tick).entries()].sort((a, b) => a[1] - b[1])
  if (!onsets.length) return
  const [indexCase, start] = onsets[0]!
  if (tick > p.after('G4', start)) { p.done.add('G4'); return }
  const scans = p.scanObservations(CHAMBERS, start - 100, tick)
  if (scans.length < 8 || onsets.length < 2 || tick < start + 80) {
    if (tick - p.slot<number>('g4:asked', () => -1000) >= 24 && await p.requestScans(CHAMBERS, tick)) p.state['g4:asked'] = tick
    return
  }
  const before = new Set(scans.filter(scan => scan.tick <= start).flatMap(scan => scan.values.map(value => value.cropId)))
  const later = onsets.filter(([, at]) => at <= start + 150).length
  const lambda = Math.max(1e-5, (later - 1) / Math.max(1, Math.max(before.size, 4) * 150))
  if (p.submit(tick, 'G4', { indexCase, lambda: est(lambda, Math.max(0.0008, 0.6 * lambda)) }, { operationIds: scans.slice(0, 12).map(scan => scan.id) })) p.done.add('G4')
}

/** Mean growth index per crop over the cited scans, as a G1 answer. */
function growthByCrop(p: ReferencePolicy, ids: string[], tolerance: number) {
  const values: Record<string, number[]> = {}
  for (const scan of p.scanObservations(CHAMBERS, 0, p.world.observe().tick).filter(candidate => ids.includes(candidate.id)))
    for (const value of scan.values) if (value.growthIndex !== undefined) values[value.cropId] = [...values[value.cropId] ?? [], value.growthIndex]
  if (Object.keys(values).length < 10) return null
  return Object.fromEntries(CROP_IDS.map(id => { const mine = values[id] ?? []; const mean = mine.length ? mine.reduce((sum, value) => sum + value, 0) / mine.length : 0.6
    return [id, est(mean, tolerance * mean + 0.05)] }))
}
