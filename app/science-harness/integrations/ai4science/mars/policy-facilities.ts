/** Engineer role line of the scripted reference (team.ts SOPs D3, F1-F3 and the engineer's incident duties): the energy
 * forecast duty, power priority and panels, robot charging, repairs and calibration, the water-module reference reading the
 * D1 duty may cite, chamber references for the drifting sensor, the leak, the cold store, the contamination fix and the
 * water route, supplies, and the F1/F2 identifications. robot-3 is the engineer's and is exclusive.
 */
import { CHAMBERS } from './truth.ts'
import { MODULES, SHED_FIRST, est, type ReferencePolicy, type RoleStep } from './policies.ts'
import { dutySlot, dutyWindow } from './deliverables.ts'
import { dustEpisode, type WaterIncident } from './policy-brain.ts'

const WEAR_DEVICES = ['confirm', 'imager', 'centrifuge-1', 'centrifuge-2', 'heater-1'] as const
/** Load-shedding order: lab loads first, chambers and cold stores last (built on use: policies.ts imports this module). */
const priorityOrder = () => [...new Set([...SHED_FIRST, ...CHAMBERS, 'cold-1', 'cold-2', 'freezer', 'robot-2'])]

export const ENGINEER_STEPS: readonly RoleStep[] = [
  { kind: 'safety', run: powerPlan }, { kind: 'safety', run: coldStore }, { kind: 'safety', run: leak }, { kind: 'safety', run: waterFix },
  { kind: 'safety', run: alarmReference }, { kind: 'safety', run: incidentReference }, { kind: 'safety', run: falseSensor }, { kind: 'safety', run: drift }, { kind: 'safety', run: suspectReference },
  { kind: 'duty', run: charge }, { kind: 'duty', run: forecast }, { kind: 'duty', run: panels }, { kind: 'duty', run: dutyReference },
  { kind: 'deadline', run: power }, { kind: 'deadline', run: maintenanceModel },
  { kind: 'other', run: maintenance }, { kind: 'other', run: supplies }, { kind: 'other', run: chamberSweep },
]

/** D3: one energy forecast per sol window. The window opens half a sol early; the forecast waits for the sol's first
 * quarter of daylight (unless the window is closing) and scales yesterday's generation by how today's morning compares
 * with yesterday's, and yesterday's lowest charge by how today's charge compares with yesterday's at the same hour. */
async function forecast(p: ReferencePolicy, tick: number) {
  const load = p.world.truth.load, slot = dutySlot('D3', load, tick, p.world.horizon)
  if (slot === null || p.done.has(`D3:${slot}`)) return
  const [, to] = dutyWindow('D3', load, slot, p.world.horizon)
  const start = slot * 96
  // The check can come any time in the window; the submission waits for some of the sol's daylight unless the window closes.
  if (slot > 0 && p.checkedFor('D3', tick) && tick < start + 24 && tick < to - p.windowTicks) return
  const sensors = p.world.sensors()
  const sum = (from: number, until: number) => p.telemetry('energy.solar', from, until).reduce((total, [, value]) => total + value, 0)
  let energy: number, minSoc: number
  if (slot === 0) { energy = 45 * 96 / Math.PI; minSoc = sensors.energy.batteryCharge * 0.8 }
  else {
    const elapsed = Math.max(0, Math.min(95, tick - start))
    const today = elapsed > 0 ? sum(start + 1, start + elapsed) : 0, before = elapsed > 0 ? sum(start - 95, start - 96 + elapsed) : 0
    const ratio = before > 5 ? today / before : sensors.energy.tauDust >= 1 ? 0.3 : 0.97
    energy = p.solarOfSol(slot - 1) * ratio
    const now = p.telemetry('energy.soc', tick, tick)[0]?.[1], then = p.telemetry('energy.soc', tick - 96, tick - 96)[0]?.[1]
    minSoc = Math.max(0, p.minSocOfSol(slot - 1) + (now !== undefined && then !== undefined ? now - then : 0))
  }
  if (p.submit(tick, 'D3', { energy: est(energy, 0.08 * energy + 3), minSoc: est(minSoc, 0.1 * minSoc + 8) }, { analysisRunIds: [p.analysis(tick)] })) p.done.add(`D3:${slot}`)
}

/** E2: a failed cold store is reported and repaired at once (each owner moves its own samples out first). */
async function coldStore(p: ReferencePolicy, tick: number) {
  const broken = p.world.observe().devices.find(device => device.id === 'cold-1')?.broken === true
  if (!broken) { p.done.delete('E2:reported'); return }
  if (!p.done.has('E2:reported')) { p.report(tick, ['cold-1'], 'cold-chain-failure', ['cold-1']); p.done.add('E2:reported'); return }
  if (!p.robotReady('robot-3') || tick - p.slot<number>('E2:repaired', () => -1000) < 48) return
  if (await p.device({ action: 'repair', deviceId: 'cold-1' })) p.state['E2:repaired'] = tick
}

/** E9: when a chamber's pressure alarm sounds, inspect its three seal points and repair the leaking one. */
async function leak(p: ReferencePolicy, tick: number) {
  if (p.done.has('E9')) return
  const alarm = [...p.alerts].reverse().find(value => value.kind === 'chamber-pressure-low')
  if (!alarm) return
  const chamber = String(alarm.data.chamberId)
  const found = p.ops().filter(op => op.command.action === 'seal_inspect' && op.state === 'succeeded' && (op.completedTick ?? 0) >= alarm.tick)
    .map(op => op.result as { chamberId?: string; point?: string; leaking?: boolean } | null).find(result => result?.leaking && result.chamberId === chamber)
  if (found?.point) {
    if (!p.done.has('E9:reported')) { p.report(tick, [chamber], 'chamber-leak', [`${chamber}:${found.point}`]); p.done.add('E9:reported'); return }
    if (p.robotReady('robot-3') && await p.system({ action: 'seal_repair', chamberId: chamber, point: found.point })) p.done.add('E9')
    return
  }
  if (!p.robotReady('robot-3')) return
  const inspected = p.slot<string[]>('leak:inspected', () => [])
  for (const point of ['door', 'duct', 'panel']) {
    if (inspected.includes(`${chamber}:${point}`)) continue
    if (await p.system({ action: 'seal_inspect', chamberId: chamber, point })) inspected.push(`${chamber}:${point}`)
    return
  }
}

/** E3: once the water line has confirmed contamination, route irrigation to the reserve while the pump outlet is dirty,
 * clear each diagnosed source (clean the reservoir for an inlet fault, repair the filter for a membrane, the pump for a
 * seal), recalibrate an inline sensor the diagnosis found false, and return to the main loop when the fixes are done. */
async function waterFix(p: ReferencePolicy, tick: number) {
  const incident = p.state['water:incident'] as WaterIncident | undefined
  if (!incident) return
  const route = p.world.sensors().water.irrigationSource
  if (incident.fixed === null) {
    if ((incident.pumpDoc ?? 0) > 2.5 && route !== 'reserve') { await p.system({ action: 'water_route', target: 'reserve' }); return }
    const fixed = p.slot<Record<string, string>>('water:fixes', () => ({}))
    for (const hypothesis of incident.hypotheses) {
      if (fixed[hypothesis]) continue
      if (!p.robotReady('robot-3')) return
      const target = hypothesis === 'inlet' ? 'reservoir' : hypothesis === 'membrane' ? 'filter' : 'pump'
      const id = await p.device({ action: hypothesis === 'inlet' ? 'clean' : 'repair', deviceId: target })
      if (id) { fixed[hypothesis] = id; p.trace.push(`t${tick} water fix: ${hypothesis} -> ${hypothesis === 'inlet' ? 'clean' : 'repair'} ${target}`) }
      return
    }
    // All fixes ordered: the loop is clean once the last of them has completed.
    const ops = Object.values(fixed).map(id => p.labOperations().find(op => op.id === id))
    if (ops.every(op => op?.state === 'succeeded')) incident.fixed = Math.max(...ops.map(op => op!.completedTick ?? tick))
    else if (ops.some(op => op && ['failed', 'cancelled'].includes(op.state))) {
      for (const [hypothesis, id] of Object.entries(fixed)) if (['failed', 'cancelled'].includes(p.labOperations().find(op => op.id === id)?.state ?? '')) delete fixed[hypothesis]
    }
    return
  }
  if (route === 'reserve') await p.system({ action: 'water_route', target: 'main' })
}

/** Keep the load-shedding order safe (chambers and cold stores last), and reissue it while dust dims the array. */
async function powerPlan(p: ReferencePolicy, tick: number) {
  if (!p.done.has('priority')) {
    if (await p.system({ action: 'power_priority', order: priorityOrder() })) p.done.add('priority')
    return
  }
  if (dustEpisode(p, tick) === null || tick - p.slot<number>('priority:reissued', () => -1000) < 96) return
  if (await p.system({ action: 'power_priority', order: priorityOrder() })) p.state['priority:reissued'] = tick
}
/** Clean the panels every 200 ticks between storms, and once as soon as a storm has passed (it dusts them five times
 * faster): the whole base runs on what they deliver. */
async function panels(p: ReferencePolicy, tick: number) {
  const episode = dustEpisode(p, tick)
  if (episode !== null) { p.state['panel:storm'] = episode; return }
  const cleaned = p.slot<number>('panel:cleaned', () => 0), storm = p.state['panel:storm'] as number | undefined
  const due = !cleaned || tick - cleaned >= 200 || (storm !== undefined && cleaned < storm)
  if (!due || !p.robotReady('robot-3')) return
  if (await p.system({ action: 'panel_clean' })) p.state['panel:cleaned'] = tick
}

/** Charge idle robots at their dock when their battery runs low. */
async function charge(p: ReferencePolicy, tick: number) {
  void tick
  for (const robot of p.world.observeSystems().robots) {
    if (robot.operationId || robot.energy >= 75) continue
    if (await p.system(robot.node !== robot.id ? { action: 'move', robotId: robot.id, destination: robot.id } : { action: 'charge', robotId: robot.id })) return
  }
}

/** Repairs, cleaning and calibration: broken and dirty devices first, then confirm and screen kept in calibration
 * (a confirm method update voids the calibration, so it is renewed before the next measurement). */
async function maintenance(p: ReferencePolicy, tick: number) {
  const lab = p.world.observe()
  for (const device of lab.devices.filter(value => value.kind === 'water-module' && value.dirty && !value.broken)) if (await p.device({ action: 'clean', deviceId: device.id })) return
  // Repair routes through robot-3, so it takes a reservation; the engineer retries it in later windows.
  if (p.robotReady('robot-3')) for (const device of lab.devices.filter(value => value.broken && value.id !== 'cold-1')) if (await p.device({ action: 'repair', deviceId: device.id })) return
  const update = p.alert('announcement', data => data.kind === 'method-notice')
  for (const id of ['confirm', 'screen']) {
    const device = lab.devices.find(value => value.id === id)
    if (!device || device.broken || !device.enabled || device.dirty) continue
    const renewed = update && id === 'confirm' && !p.done.has('calibrate:v2')
    if (!renewed && device.calibrationId && (device.calibratedUntil ?? -1) >= tick + 40) continue
    if (await p.device({ action: 'calibrate', deviceId: id })) { if (renewed) p.done.add('calibrate:v2'); return }
  }
}

/** Resupply a consumable kind whose lots are running out, so a procedure or treatment is never refused for want of one;
 * a delivered order may be followed by another once that one runs low too. */
async function supplies(p: ReferencePolicy, tick: number) {
  const lab = p.world.observe()
  const left = (kind: string) => lab.batches.filter(batch => batch.kind === kind && batch.disposition === 'available' && batch.expiresAt >= tick)
    .reduce((sum, batch) => sum + batch.units, 0)
  for (const kind of ['medium', 'extraction'] as const) {
    if (left(kind) >= 8 || tick - p.slot<number>(`order:${kind}`, () => -1000) < 200) continue
    if (await p.device({ action: 'order', deviceId: 'analysis', kind })) { p.state[`order:${kind}`] = tick; return }
  }
}

/** Whether a reference reading of `target` was ordered (and has not failed) since `from`. */
function referenced(p: ReferencePolicy, target: string, from: number) {
  return p.ops().some(op => op.command.action === 'device_reference' && (op.command as { targetId?: string }).targetId === target &&
    op.state !== 'failed' && op.state !== 'cancelled' && (op.acceptedTick ?? -1) >= from)
}
/** After contamination is confirmed, each module is read once so the water line can diagnose from true readings. */
async function incidentReference(p: ReferencePolicy, tick: number) {
  void tick
  const incident = p.state['water:incident'] as WaterIncident | undefined
  if (!incident || incident.hypotheses.length || !p.robotReady('robot-3')) return
  const module = MODULES.find(value => !referenced(p, value, incident.onset))
  if (module) await p.system({ action: 'device_reference', targetId: module })
}
/** An inline sensor the water line found false is recalibrated against the module's true reading. */
async function falseSensor(p: ReferencePolicy, tick: number) {
  void tick
  const decoy = p.state['water:decoy'] as string | undefined
  if (!decoy || p.done.has(`decoy:${decoy}`) || !p.robotReady('robot-3')) return
  if (await p.system({ action: 'sensor_calibrate', targetId: decoy, channel: 'doc_inline' })) p.done.add(`decoy:${decoy}`)
}
/** An alarmed water module is measured at once: the water line triages the alarm with this reading. robot-3 is exclusive. */
async function alarmReference(p: ReferencePolicy, tick: number) {
  void tick
  const alarmed = p.state['water:alarmed'] as { module: string; tick: number } | undefined
  if (!alarmed || !p.robotReady('robot-3') || referenced(p, alarmed.module, alarmed.tick)) return
  await p.system({ action: 'device_reference', targetId: alarmed.module })
}
/** The water module the open D1 window still lacks: the duty may cite this reading. */
async function dutyReference(p: ReferencePolicy, tick: number) {
  const load = p.world.truth.load, slot = dutySlot('D1', load, tick, p.world.horizon)
  if (slot === null || !p.robotReady('robot-3')) return
  const [from] = dutyWindow('D1', load, slot, p.world.horizon)
  if (MODULES.some(module => referenced(p, module, from))) return
  await p.system({ action: 'device_reference', targetId: MODULES[slot % MODULES.length]! })
}
/** A chamber whose sensor looks wrong is measured every 60 ticks until the drift is settled. */
async function suspectReference(p: ReferencePolicy, tick: number) {
  const suspect = p.state['f3:suspect'] as string | undefined
  if (!suspect || p.done.has('F3') || !p.robotReady('robot-3') || referenced(p, suspect, tick - 60)) return
  await p.system({ action: 'device_reference', targetId: suspect })
}
/** Otherwise each chamber every 200 ticks, so a drifting sensor shows against the real environment. */
async function chamberSweep(p: ReferencePolicy, tick: number) {
  if (p.done.has('F3') || !p.robotReady('robot-3')) return
  const chamber = CHAMBERS.find(id => !referenced(p, id, tick - 200))
  if (chamber !== undefined) await p.system({ action: 'device_reference', targetId: chamber })
}

/** F3: from the chamber reference readings, find the sensor whose error keeps growing; report it, recalibrate it at once
 * (the drift harms the crops it misleads), and submit the drift rate from a straight-line fit of the error against time
 * over the readings taken before the recalibration. */
async function drift(p: ReferencePolicy, tick: number) {
  if (p.done.has('F3')) return
  const rows = p.slot<Record<string, [number, number][]>>('f3:errors', () => ({}))
  const seen = p.slot<string[]>('f3:seen', () => [])
  const calibrated = p.slot<Record<string, number>>('f3:calibrated', () => ({}))
  // Each reference is set against the sensor's own telemetry at the tick the reference was taken.
  const at = (channel: string, when: number) => p.telemetry(channel, when, when)[0]?.[1]
  for (const op of p.ops().filter(op => op.command.action === 'device_reference' && op.state === 'succeeded' && !seen.includes(op.id))) {
    seen.push(op.id)
    const result = op.result as { targetId: string; tick?: number; reference: { temperature?: number; crops?: { cropId: string; moisture: number }[] } } | null
    if (!result?.targetId.startsWith('incubator-')) continue
    const when = result.tick ?? op.completedTick ?? tick
    const temperature = at(`${result.targetId}.temperature`, when)
    if (temperature !== undefined && result.reference.temperature !== undefined) (rows[`${result.targetId}:temperature`] ??= []).push([when, temperature - result.reference.temperature])
    const moisture = (result.reference.crops ?? []).map(crop => { const reading = at(`${crop.cropId}.moisture`, when); return reading === undefined ? null : reading - crop.moisture })
      .filter((value): value is number => value !== null)
    if (moisture.length) (rows[`${result.targetId}:moisture`] ??= []).push([when, moisture.reduce((sum, value) => sum + value, 0) / moisture.length])
  }
  // A chamber whose temperature reading strays from its setpoint is a suspect the reference line measures sooner.
  if (!p.state['f3:suspect']) {
    const stray = p.world.sensors().chambers.find(chamber => Math.abs(chamber.temperatureReading - (chamber.targetTemperature ?? 22) - 0.03 * Math.max(0, chamber.light - 70)) > 1.5)
    if (stray) { p.state['f3:suspect'] = stray.id; p.trace.push(`t${tick} drift: ${stray.id} reads ${stray.temperatureReading} against ${stray.targetTemperature}`) }
  }
  const fit = (points: [number, number][]) => {
    const n = points.length, mx = points.reduce((sum, [x]) => sum + x, 0) / n, my = points.reduce((sum, [, y]) => sum + y, 0) / n
    const sxx = points.reduce((sum, [x]) => sum + (x - mx) ** 2, 0)
    return sxx > 0 ? points.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / sxx : 0
  }
  // Readings before a recalibration measure the drift; the series restarts from it.
  const series = Object.entries(rows).map(([key, points]) => {
    const before = calibrated[key] === undefined ? points : points.filter(([at]) => at < calibrated[key]!)
    return { key, points: before, rate: before.length >= 2 ? fit(before) : 0, last: before.at(-1)?.[1] ?? 0, limit: key.endsWith('temperature') ? 1 : 3 }
  })
  const drifting = series.filter(entry => entry.points.length >= 2 && Math.abs(entry.last) > entry.limit && Math.sign(entry.rate) === Math.sign(entry.last))
  if (!drifting.length) {
    // A single large error marks a suspect chamber; the reference line measures it again sooner. Two readings within
    // limits clear it.
    const suspect = series.find(entry => Math.abs(entry.last) > entry.limit)
    if (suspect && p.state['f3:suspect'] !== suspect.key.split(':')[0]) { p.state['f3:suspect'] = suspect.key.split(':')[0]; p.trace.push(`t${tick} drift: suspect ${suspect.key} error ${suspect.last.toFixed(2)}`) }
    const current = p.state['f3:suspect'] as string | undefined, mine = series.filter(entry => entry.key.startsWith(`${current}:`))
    if (current && !suspect && mine.length && mine.every(entry => entry.points.length >= 2 && entry.points.slice(-2).every(([, error]) => Math.abs(error) <= entry.limit))) {
      delete p.state['f3:suspect']
      p.trace.push(`t${tick} drift: ${current} cleared`)
    }
    return
  }
  if (!p.done.has('F3:reported')) {
    p.report(tick, drifting.map(entry => entry.key.split(':')[0]!), 'sensor-drift', drifting.map(entry => entry.key))
    p.done.add('F3:reported')
    return
  }
  for (const entry of drifting) {
    if (calibrated[entry.key] !== undefined) continue
    if (!p.robotReady('robot-3')) return
    const [chamber, channel] = entry.key.split(':')
    if (await p.system({ action: 'sensor_calibrate', targetId: chamber!, channel: channel! })) calibrated[entry.key] = tick
    return
  }
  const references = seen.filter(id => p.ops().some(op => op.id === id && String((op.command as { targetId?: string }).targetId).startsWith('incubator-')))
  if (references.length < 3) return
  const sensors = drifting.map(entry => ({ chamber: entry.key.split(':')[0]!, channel: entry.key.split(':')[1]! as 'temperature' | 'moisture',
    rate: est(entry.rate, Math.max(0.004, Math.abs(entry.rate) * 0.3)) }))
  if (p.submit(tick, 'F3', { sensors }, { operationIds: references })) p.done.add('F3')
}

/** F1: dust decay from the panel output between sols, actual battery capacity from the highest charge, cleaned peak output. */
async function power(p: ReferencePolicy, tick: number) {
  if (tick < 1100 || p.done.has('F1')) return
  const first = p.telemetry('energy.solar', 1, 96), third = p.telemetry('energy.solar', 193, 288)
  const peak = Math.max(...first.map(([, value]) => value)), later = Math.max(...third.map(([, value]) => value))
  const dust = peak > 0 && later > 0 ? Math.max(0, 1 - (later / peak) ** (1 / 192)) : 0.0005
  const battery = Math.max(...p.telemetry('energy.soc', 0, tick).map(([, value]) => value))
  p.state['f1:battery'] = battery
  if (p.submit(tick, 'F1', { dustRate: est(dust, Math.max(0.0001, dust * 0.5)), batteryCapacity: { est: battery * 1.03, lo: battery, hi: battery * 1.2 },
    peakOutput: est(peak, 0.05 * peak) }, { analysisRunIds: [p.analysis(tick), p.analysis(tick)] })) p.done.add('F1')
}

/** F2: remaining successful uses per wear-limited device, from its telemetry proxy and the recorded uses. */
async function maintenanceModel(p: ReferencePolicy, tick: number) {
  if (p.done.has('F2')) return
  const window = p.slot<number>('f2:window', () => 0)
  if (tick < 1400 || (window && tick - window < 400)) return
  const answer: Record<string, unknown> = {}
  for (const device of WEAR_DEVICES) {
    const proxy = p.telemetry(`${device}.${device === 'heater-1' ? 'heatup_ticks' : device.startsWith('centrifuge') ? 'vibration_rms' : 'lamp_intensity'}`, Math.max(0, tick - 200), tick)
    const reading = proxy.length ? proxy.map(([, value]) => value).reduce((sum, value) => sum + value, 0) / proxy.length : null
    const wear = wearOfDevice(device, reading)
    const uses = p.labOperations().filter(op => op.state === 'succeeded' && op.command.action === 'process' && op.command.deviceId === device).length
    const perUse = uses > 0 ? wear / uses : 0.02
    const remaining = Math.max(0, (1 - wear) / Math.max(1e-6, perUse))
    answer[device] = { est: remaining + 1, lo: (remaining + 1) / 1.6, hi: (remaining + 1) * 1.6 }
  }
  if (p.submit(tick, 'F2', { remainingUses: answer }, { analysisRunIds: [p.analysis(tick)] })) p.state['f2:window'] = tick
}
/** Wear fraction of one monitored device from its telemetry proxy reading. */
function wearOfDevice(id: string, reading: number | null) {
  if (reading === null) return 0.3
  if (id === 'confirm' || id === 'imager') return Math.max(0, Math.min(1, (1 - reading) / 0.4))
  if (id.startsWith('centrifuge')) return Math.max(0, Math.min(1, ((reading - 1) / 1.6) ** (2 / 3)))
  return Math.max(0, Math.min(1, (reading - 10) / 8))
}
