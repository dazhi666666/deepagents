/** Per-tick v2 base subsystems: energy, atmosphere, water quality, crops, pathogen, sensors, wear, telemetry and incidents. */
import { z } from 'zod'
import type { LaboratoryState } from '../greenhouse/laboratory/schema.ts'
import { powerDemand, waterAvailable } from '../greenhouse/laboratory/facilities.ts'
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { CHAMBERS, chamberOf, decayRate, growthRate, normal, unit, varietyOf, type Truth } from './truth.ts'

export const TIER_ONE = ['incubator-1', 'incubator-2', 'incubator-3', 'incubator-4', 'cold-1', 'cold-2', 'freezer', 'robot-2']
export const VIRTUAL_LOADS = { 'co2-distribution': 1, 'water-recovery': 1.5 } as const
export const RECOVERY_PER_TICK = 12
export const RESERVE_INITIAL = 800
export const CO2_TANK_INITIAL = 12000
export const SPARES_INITIAL = { membrane: 1, seal: 1, compressor: 1, drive: 1, sealant: 2, bearing: 2, lamp: 2, heater_element: 1 }
export const SPARE_FOR: Record<string, keyof typeof SPARES_INITIAL> = {
  filter: 'membrane', pump: 'seal', 'cold-1': 'compressor', 'cold-2': 'compressor', freezer: 'compressor',
  'robot-1': 'drive', 'robot-2': 'drive', 'robot-3': 'drive', 'centrifuge-1': 'bearing', 'centrifuge-2': 'bearing',
  confirm: 'lamp', imager: 'lamp', screen: 'lamp', 'heater-1': 'heater_element', 'heater-2': 'heater_element',
}
export const INLINE_ALARM: Record<string, number> = { reservoir: 7, filter: 2.5, pump: 2.5 }
export const LATENT_TICKS = 60
export const SYMPTOMATIC_TICKS = 200

const sampleTruth = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('water'), source: z.string(), doc: z.number(), lubricant: z.number(), decay: z.number(), sampledTick: z.number() }),
  z.object({ kind: z.literal('crop'), cropId: z.string(), growth: z.number(), infectedSince: z.number().nullable(), sampledTick: z.number() }),
])
export type SampleTruth = z.infer<typeof sampleTruth>

export const baseStateSchema = z.object({
  energy: z.object({ soc: z.number(), capacity: z.number(), dust: z.number(), solar: z.number(), demand: z.number(), tauDust: z.number(),
    priority: z.array(z.string()), shed: z.array(z.string()), lowBattery: z.boolean(), cellFailed: z.boolean() }),
  atmosphere: z.record(z.string(), z.object({ pressure: z.number(), co2: z.number(), setpoint: z.number(), quarantine: z.boolean(), lowPressure: z.boolean() })),
  co2Tank: z.number(),
  water: z.object({ route: z.enum(['main', 'reserve']), reserve: z.number(), resolved: z.record(z.string(), z.array(z.string())),
    decoyCleared: z.array(z.string()), inlineAlarm: z.record(z.string(), z.boolean()) }),
  leak: z.object({ resolved: z.boolean(), inspected: z.array(z.string()) }),
  sensorCalibrated: z.record(z.string(), z.number()),
  wear: z.record(z.string(), z.number()),
  robotsContaminated: z.array(z.string()),
  spares: z.record(z.string(), z.number()),
  samples: z.record(z.string(), sampleTruth),
  metrics: z.object({ ticks: z.number(), tierOneShedTicks: z.number(), waterUnavailableTicks: z.number(),
    atmosphereOkTicks: z.record(z.string(), z.number()), sampleTicks: z.number(), shedTicksByLoad: z.record(z.string(), z.number()) }),
  announced: z.array(z.string()),
  /** Evaluator-only truth history for duty scoring (spec v0.3 section 3). */
  history: z.object({
    snapshots: z.record(z.string(), z.object({ water: z.record(z.string(), z.number()), faultySensors: z.array(z.string()),
      crops: z.record(z.string(), z.enum(['healthy', 'stressed', 'infected', 'lost'])), latent: z.array(z.string()) })).default({}),
    sols: z.record(z.string(), z.object({ solar: z.number(), minSoc: z.number(), tierOneShedTicks: z.number() })).default({}),
    contaminationClean: z.record(z.string(), z.number()).default({}),
  }).default({ snapshots: {}, sols: {}, contaminationClean: {} }),
})
export type BaseState = z.infer<typeof baseStateSchema>

/** Initial base state; alphabetical default shedding order is a deliberate trap (cold-1 is the first drawing load). */
export function initialBase(truth: Truth, deviceIds: string[]): BaseState {
  return {
    energy: { soc: truth.energy.battery * 0.7, capacity: truth.energy.battery, dust: 1, solar: 0, demand: 0, tauDust: 0.5,
      priority: [...deviceIds, ...Object.keys(VIRTUAL_LOADS)].sort(), shed: [], lowBattery: false, cellFailed: false },
    atmosphere: Object.fromEntries(CHAMBERS.map(id => [id, { pressure: 70, co2: 800, setpoint: 800, quarantine: false, lowPressure: false }])),
    co2Tank: CO2_TANK_INITIAL,
    water: { route: 'main', reserve: RESERVE_INITIAL, resolved: {}, decoyCleared: [], inlineAlarm: {} },
    leak: { resolved: false, inspected: [] },
    sensorCalibrated: {},
    wear: Object.fromEntries(Object.entries(truth.wear).map(([id, value]) => [id, value.initial])),
    robotsContaminated: [],
    spares: { ...SPARES_INITIAL },
    samples: {},
    metrics: { ticks: 0, tierOneShedTicks: 0, waterUnavailableTicks: 0, atmosphereOkTicks: Object.fromEntries(CHAMBERS.map(id => [id, 0])), sampleTicks: 0, shedTicksByLoad: {} },
    announced: [],
    history: { snapshots: {}, sols: {}, contaminationClean: {} },
  }
}

export const SNAPSHOT_EVERY = 12
/** Sol index of a stepped tick: ticks 1..96 belong to sol 0. */
export const solOfTick = (tick: number, solTicks = 96) => Math.floor((tick - 1) / solTicks)
/** Duty label of a crop at a tick: lost, infected (latent or symptomatic), stressed or healthy. */
export function cropLabel(crop: CropState, tick: number): 'healthy' | 'stressed' | 'infected' | 'lost' {
  if (crop.status === 'lost') return 'lost'
  const stage = pathogenStage(crop.infectedSince, tick)
  if (stage === 'latent' || stage === 'symptomatic') return 'infected'
  return crop.status
}

/** Record per-tick truth used by duties and integration tasks. */
function recordHistory(truth: Truth, base: BaseState, crops: CropState[], tick: number, quality: ReturnType<typeof waterQuality>, solar: number, tierOneShed: boolean) {
  const sol = String(solOfTick(tick, truth.solTicks))
  const day = base.history.sols[sol] ??= { solar: 0, minSoc: base.energy.soc, tierOneShedTicks: 0 }
  day.solar += solar; day.minSoc = Math.min(day.minSoc, base.energy.soc); if (tierOneShed) day.tierOneShedTicks++
  for (const event of truth.contamination) if (tick >= event.onset && base.history.contaminationClean[event.event] === undefined &&
    event.hypotheses.every(h => (base.water.resolved[event.event] ?? []).includes(h))) base.history.contaminationClean[event.event] = tick
  if (tick % SNAPSHOT_EVERY !== 0) return
  base.history.snapshots[String(tick)] = {
    water: { reservoir: quality.reservoir, filter: quality.filter, pump: quality.pump },
    faultySensors: ['reservoir', 'filter', 'pump'].filter(module => inlineOffset(truth, base, module, tick) !== 0),
    crops: Object.fromEntries(crops.map(crop => [crop.id, cropLabel(crop, tick)])),
    latent: crops.filter(crop => crop.status !== 'lost' && pathogenStage(crop.infectedSince, tick) === 'latent').map(crop => crop.id),
  }
}

export interface CropState {
  id: string; chamberId: string; moisture: number; exposureTicks: number; availableSampleUl: number; status: 'healthy' | 'stressed' | 'lost'
  growth: number; biomass: number; removed: boolean; infectedSince: number | null; contamination: [number, number][]; irrigation: [number, number][]
}
export interface CropProfile { batch: number; minimumMoisture: number; minimumTemperature: number; maximumTemperature: number; exposureToleranceTicks: number; moistureMultiplier: number }

/** Contamination hypotheses currently in effect for the water loop. */
export function activeHypotheses(truth: Truth, base: BaseState, tick: number) {
  const active = new Set<string>()
  for (const event of truth.contamination) {
    if (tick < event.onset) continue
    for (const hypothesis of event.hypotheses) if (!(base.water.resolved[event.event] ?? []).includes(hypothesis)) active.add(hypothesis)
  }
  return active
}
/** True DOC concentration and lubricant at each water module. */
export function waterQuality(truth: Truth, base: BaseState, tick: number) {
  const active = activeHypotheses(truth, base, tick)
  const event = (hypothesis: string) => truth.contamination.find(value => tick >= value.onset && value.hypotheses.includes(hypothesis as never) &&
    !(base.water.resolved[value.event] ?? []).includes(hypothesis))
  const reservoir = truth.water.reservoir + (active.has('inlet') ? event('inlet')!.deltaInlet : 0)
  const removal = active.has('membrane') ? event('membrane')!.membraneRemoval : truth.water.removal
  const filter = reservoir * (1 - removal)
  const seal = active.has('seal') ? event('seal')! : undefined
  const pump = filter + truth.water.pumpIncrement + (seal ? seal.deltaSeal : 0)
  return { reservoir, filter, pump, removal, lubricant: { reservoir: 0, filter: 0, pump: seal ? seal.deltaSeal * seal.lubricantRatio : 0 } as Record<string, number> }
}
/** Inline sensor offset from an uncleared decoy fault. */
export function inlineOffset(truth: Truth, base: BaseState, module: string, tick: number) {
  return truth.contamination.filter(value => value.decoyModule === module && tick >= value.decoyOnset && !base.water.decoyCleared.includes(value.event))
    .reduce((sum, value) => sum + value.decoyOffset, 0)
}
/** Chamber sensor offset from a drifting, uncalibrated sensor. */
export function sensorOffset(truth: Truth, base: BaseState, chamber: string, channel: 'temperature' | 'moisture', tick: number) {
  return truth.drift.filter(value => value.chamber === chamber && value.channel === channel && tick >= value.onset)
    .reduce((sum, value) => (base.sensorCalibrated[`${chamber}:${channel}`] ?? -1) >= value.onset ? sum : sum + value.rate * (tick - value.onset), 0)
}
export function stormFactor(truth: Truth, tick: number) {
  const storm = truth.storms.find(value => tick >= value.onset && tick < value.onset + value.duration)
  return storm ? storm.factor : 1
}
export function tauDust(truth: Truth, tick: number) {
  let tau = 0.5
  for (const storm of truth.storms) {
    if (tick >= storm.onset - 24 && tick < storm.onset) tau = Math.max(tau, 0.5 + 2 * (tick - storm.onset + 24) / 24)
    if (tick >= storm.onset && tick < storm.onset + storm.duration) tau = Math.max(tau, 3)
    if (tick >= storm.onset + storm.duration && tick < storm.onset + storm.duration + 48) tau = Math.max(tau, 3 - 2.5 * (tick - storm.onset - storm.duration) / 48)
  }
  return tau
}
export function solarOutput(truth: Truth, base: BaseState, tick: number) {
  const phase = (tick % truth.solTicks) / truth.solTicks
  return truth.energy.peak * Math.max(0, Math.sin(2 * Math.PI * phase)) * base.energy.dust * stormFactor(truth, tick)
}
export function pathogenStage(infectedSince: number | null, tick: number) {
  if (infectedSince === null || tick < infectedSince) return 'none' as const
  if (tick - infectedSince < LATENT_TICKS) return 'latent' as const
  if (tick - infectedSince < LATENT_TICKS + SYMPTOMATIC_TICKS) return 'symptomatic' as const
  return 'dead' as const
}
export function cropTemperature(state: LaboratoryState, light: number, chamberId: string) {
  const device = state.devices.find(value => value.id === chamberId)!
  return (device.temperature ?? state.facilities.ambientTemperature) + 0.03 * Math.max(0, light - 70)
}
export function irrigationLevel(crop: CropState, tick: number) {
  return crop.irrigation.filter(([at]) => at > tick - 100 && at <= tick).reduce((sum, [, volume]) => sum + volume, 0)
}

export interface StepContext {
  truth: Truth; state: LaboratoryState; crops: CropState[]; profiles: CropProfile[]
  light: Record<string, number>; nutrient: Record<string, number>; base: BaseState
  event: (kind: string, payload: Json) => void
  telemetry: (rows: [string, number | null][]) => void
}

/** Advance base subsystems by exactly one logical tick, after the laboratory has committed that tick. */
export function stepBase(context: StepContext) {
  const { truth, state, base, crops, profiles, event } = context
  const tick = state.tick
  base.metrics.ticks++

  // Incidents scheduled from truth
  for (const index of truth.pathogen.index) {
    const crop = crops.find(value => value.id === index)
    if (tick === truth.pathogen.onset && crop && crop.status !== 'lost' && crop.infectedSince === null) crop.infectedSince = tick
  }
  if (truth.recall && tick === truth.recall.tick && !base.announced.includes('recall')) {
    base.announced.push('recall')
    event('announcement', { kind: 'quality-notice', text: '质量通知：extraction A 系列中生产于 sol -212 的一个子批存在质量问题。请停止使用该子批，并评估已用其处理的结果。' })
  }
  if (tick === truth.methodUpdate.tick && !base.announced.includes('method')) {
    base.announced.push('method')
    event('announcement', { kind: 'method-notice', text: 'confirm 方法已更新为 v2：v1 存在系统性偏差（幅度未公布）。v2 每次处理 12 步，需要重新校准。' })
  }
  if (truth.energy.cellFailure && tick === truth.energy.cellFailure.onset && !base.energy.cellFailed) {
    base.energy.cellFailed = true
    base.energy.capacity *= 1 - truth.energy.cellFailure.fraction
    base.energy.soc = Math.min(base.energy.soc, base.energy.capacity)
  }

  // Energy: solar, dust, battery and priority shedding
  base.energy.dust *= 1 - truth.energy.dustRate * (stormFactor(truth, tick) < 1 ? 5 : 1)
  base.energy.tauDust = tauDust(truth, tick)
  const solar = solarOutput(truth, base, tick)
  const recoveryPossible = ['filter', 'pump'].every(id => { const device = state.devices.find(value => value.id === id)!; return !device.broken && device.enabled && !device.dirty }) &&
    state.facilities.waterUl < state.facilities.waterCapacityUl
  const loads = new Map<string, number>()
  for (const device of state.devices) {
    if (device.broken || !device.enabled) continue
    if (device.conditions || state.operations.some(operation => operation.state === 'running' && operation.command.deviceId === device.id)) loads.set(device.id, device.powerDraw)
  }
  loads.set('co2-distribution', VIRTUAL_LOADS['co2-distribution'])
  if (recoveryPossible) loads.set('water-recovery', VIRTUAL_LOADS['water-recovery'])
  const supply = solar + Math.min(20, base.energy.soc)
  let demand = [...loads.values()].reduce((sum, value) => sum + value, 0)
  const shed: string[] = []
  for (const id of base.energy.priority) {
    if (demand <= supply) break
    const load = loads.get(id)
    if (load === undefined) continue
    shed.push(id); demand -= load
  }
  for (const id of [...loads.keys()]) if (demand > supply && !shed.includes(id)) { shed.push(id); demand -= loads.get(id)! }
  const changed = shed.slice().sort().join() !== base.energy.shed.slice().sort().join()
  base.energy.shed = shed
  for (const device of state.devices) (device as { shed?: boolean }).shed = shed.includes(device.id)
  state.facilities.powerCapacity = Math.max(0.001, supply)
  if (changed) event('power-shed', { shed, supply: Number(supply.toFixed(2)), demand: Number(demand.toFixed(2)), soc: Number(base.energy.soc.toFixed(1)) })
  const net = Math.max(-20, Math.min(20, solar - demand))
  base.energy.soc = Math.max(0, Math.min(base.energy.capacity, base.energy.soc + net))
  base.energy.solar = solar; base.energy.demand = demand
  if (shed.some(id => TIER_ONE.includes(id))) base.metrics.tierOneShedTicks++
  for (const id of shed) base.metrics.shedTicksByLoad[id] = (base.metrics.shedTicksByLoad[id] ?? 0) + 1
  const lowBattery = base.energy.soc < 0.15 * base.energy.capacity
  if (lowBattery && !base.energy.lowBattery) event('battery-low', { soc: Number(base.energy.soc.toFixed(1)) })
  if (base.energy.soc > 0.3 * base.energy.capacity) base.energy.lowBattery = false
  else if (lowBattery) base.energy.lowBattery = true

  // Water recovery and availability
  if (recoveryPossible && !shed.includes('water-recovery'))
    state.facilities.waterUl = Math.min(state.facilities.waterCapacityUl, state.facilities.waterUl + RECOVERY_PER_TICK)
  if (!waterAvailable(state) || state.facilities.waterUl < 300) base.metrics.waterUnavailableTicks++
  const quality = waterQuality(truth, base, tick)

  // Atmosphere
  const powered = powerDemand(state) <= state.facilities.powerCapacity
  const chamberLight = (chamberId: string) => {
    const device = state.devices.find(value => value.id === chamberId)!
    return powered && device.enabled && !device.broken && !(device as { shed?: boolean }).shed ? context.light[chamberId] ?? 70 : 0
  }
  for (const chamber of CHAMBERS) {
    const air = base.atmosphere[chamber]!
    const leaking = truth.leak && truth.leak.chamber === chamber && tick >= truth.leak.onset && !base.leak.resolved
    const uptake = crops.filter(crop => crop.chamberId === chamber && crop.status !== 'lost').reduce((sum, crop) => sum + 2 * crop.growth, 0)
    air.co2 = Math.max(200, air.co2 - uptake - (leaking ? 5 : 0))
    if (leaking) air.pressure = Math.max(50, air.pressure - 0.05)
    else if (air.pressure < 70) air.pressure = Math.min(70, air.pressure + 0.02)
    if (!shed.includes('co2-distribution') && base.co2Tank > 0 && air.co2 < air.setpoint) {
      const added = Math.min(30, air.setpoint - air.co2, base.co2Tank * 10)
      air.co2 += added; base.co2Tank -= added * 0.1
    }
    if (air.pressure >= 65 && air.co2 >= 400 && air.co2 <= 1500) base.metrics.atmosphereOkTicks[chamber] = (base.metrics.atmosphereOkTicks[chamber] ?? 0) + 1
    if (air.pressure < 66 && !air.lowPressure) { air.lowPressure = true; event('chamber-pressure-low', { chamberId: chamber, pressure: Number(air.pressure.toFixed(2)) }) }
    if (air.pressure >= 68) air.lowPressure = false
  }

  // Crops: moisture, stress, growth and pathogen
  const infectedCount = (chamber: string) => crops.filter(crop => crop.chamberId === chamber && crop.status !== 'lost' &&
    ['latent', 'symptomatic'].includes(pathogenStage(crop.infectedSince, tick))).length
  const infections = Object.fromEntries(CHAMBERS.map(chamber => [chamber, infectedCount(chamber)]))
  for (const crop of crops) {
    if (crop.status === 'lost') continue
    const profile = profiles.find(value => value.batch === varietyOf(crop.id))!
    const light = chamberLight(crop.chamberId)
    const temperature = cropTemperature(state, light, crop.chamberId)
    const air = base.atmosphere[crop.chamberId]!
    crop.moisture = Math.max(0, crop.moisture - 0.04 * profile.moistureMultiplier * (0.5 + light / 100))
    const contaminated = crop.contamination.some(([start, end]) => tick >= start && tick < end)
    const stressed = crop.moisture < profile.minimumMoisture || temperature < profile.minimumTemperature || temperature > profile.maximumTemperature ||
      air.pressure < 60 || contaminated
    const initial = crop.status
    if (stressed) crop.exposureTicks++
    const stage = pathogenStage(crop.infectedSince, tick)
    if (crop.exposureTicks > profile.exposureToleranceTicks || stage === 'dead') crop.status = 'lost'
    else crop.status = stressed ? 'stressed' : 'healthy'
    if (crop.status !== initial) event('crop-status-changed', { id: crop.id, chamberId: crop.chamberId, status: crop.status, moisture: Number(crop.moisture.toFixed(2)) })
    if (crop.status === 'lost') { crop.growth = 0; continue }
    const rate = growthRate(truth, crop.id, { light, nutrient: context.nutrient[crop.chamberId] ?? 1, irrigation: irrigationLevel(crop, tick), co2: air.co2, temperature }) *
      (crop.status === 'stressed' ? 0.5 : 1) * (stage === 'symptomatic' ? 0.6 : 1)
    crop.growth += (rate - crop.growth) / 20
    crop.biomass += rate
    if (crop.infectedSince === null) {
      const own = infections[crop.chamberId]! * (air.quarantine ? 0.5 : 1)
      const index = CHAMBERS.indexOf(crop.chamberId as never)
      const neighbours = [CHAMBERS[index - 1], CHAMBERS[index + 1]].filter((value): value is typeof CHAMBERS[number] => value !== undefined)
        .reduce((sum, chamber) => sum + (base.atmosphere[chamber]!.quarantine || air.quarantine ? 0 : infections[chamber]!), 0)
      if (unit(truth.seed, 'infect', crop.id, tick) < truth.pathogen.lambda * (own + 0.1 * neighbours)) crop.infectedSince = tick
    }
  }

  // Sample truth inheritance, degradation and custody metric
  const samples = new Map(state.samples.map(sample => [sample.id, sample]))
  for (const sample of state.samples) {
    if (sample.volumeUl <= 0) continue
    if (!base.samples[sample.id] && sample.parentId && base.samples[sample.parentId]) base.samples[sample.id] = structuredClone(base.samples[sample.parentId]!)
    const record = base.samples[sample.id]
    if (sample.disposition === 'available') base.metrics.sampleTicks++
    if (!record || record.kind !== 'water') continue
    const location = state.devices.find(value => value.id === sample.location)
    const temperature = sample.location === 'robot-2' ? 4 : location?.temperature ?? state.facilities.ambientTemperature
    record.decay *= Math.exp(-decayRate(truth, temperature))
  }
  void samples

  // Inline DOC alarms, including decoy sensors
  for (const module of ['reservoir', 'filter', 'pump']) {
    const reading = quality[module as 'reservoir'] + inlineOffset(truth, base, module, tick)
    const limit = INLINE_ALARM[module]!
    const alarm = reading > limit
    if (alarm && !base.water.inlineAlarm[module]) event('inline-doc-alarm', { module, reading: Number(reading.toFixed(2)), threshold: limit })
    if (alarm) base.water.inlineAlarm[module] = true
    else if (reading < limit - 0.5) base.water.inlineAlarm[module] = false
  }

  // Telemetry
  const rows: [string, number | null][] = []
  const noisy = (channel: string, value: number, sd: number) => [channel, Number((value + sd * normal(truth.seed, 'telemetry', channel, tick)).toFixed(4))] as [string, number]
  rows.push(['energy.solar', Number(solar.toFixed(3))], ['energy.soc', Number(base.energy.soc.toFixed(2))], ['energy.demand', Number(demand.toFixed(3))],
    noisy('energy.tau_dust', base.energy.tauDust, 0.05), ['energy.shed_count', shed.length], ['energy.co2_tank', Number(base.co2Tank.toFixed(1))],
    ['water.tank', state.facilities.waterUl], ['water.reserve', base.water.reserve])
  for (const chamber of CHAMBERS) {
    const light = chamberLight(chamber), air = base.atmosphere[chamber]!
    rows.push(noisy(`${chamber}.temperature`, cropTemperature(state, light, chamber) + sensorOffset(truth, base, chamber, 'temperature', tick), 0.05),
      [`${chamber}.light`, light], noisy(`${chamber}.co2`, air.co2, 5), noisy(`${chamber}.pressure`, air.pressure, 0.02), [`${chamber}.nutrient`, context.nutrient[chamber] ?? 1])
  }
  for (const crop of crops) rows.push(crop.status === 'lost' ? [`${crop.id}.moisture`, null] :
    noisy(`${crop.id}.moisture`, crop.moisture + sensorOffset(truth, base, crop.chamberId, 'moisture', tick), 0.2))
  for (const module of ['reservoir', 'filter', 'pump']) rows.push(noisy(`${module}.doc_inline`, quality[module as 'reservoir'] + inlineOffset(truth, base, module, tick), 0.1))
  const clog = truth.faults.find(value => value.deviceId === 'filter')
  const pressureDiff = 12 + (clog && tick >= clog.tick - 30 ? Math.min(30, tick - clog.tick + 30) * 0.8 : 0)
  rows.push(noisy('filter.pressure_diff', pressureDiff, 0.3))
  const wear = (id: string) => base.wear[id] ?? 0
  rows.push(noisy('confirm.lamp_intensity', 1 - 0.4 * wear('confirm'), 0.01), noisy('imager.lamp_intensity', 1 - 0.4 * wear('imager'), 0.01),
    noisy('centrifuge-1.vibration_rms', 1 + 1.6 * wear('centrifuge-1') ** 1.5, 0.05), noisy('centrifuge-2.vibration_rms', 1 + 1.6 * wear('centrifuge-2') ** 1.5, 0.05),
    noisy('heater-1.heatup_ticks', 10 + 8 * wear('heater-1'), 0.2), noisy('heater-2.heatup_ticks', 10 + 8 * wear('heater-2'), 0.2),
    noisy('robot-1.motor_current', 2 + 1.5 * wear('robot-1'), 0.03))
  for (const id of ['cold-1', 'cold-2', 'freezer']) rows.push(noisy(`${id}.temperature`, state.devices.find(value => value.id === id)?.temperature ?? 22, 0.05))
  for (const [id, load] of loads) rows.push([`power.${id}`, shed.includes(id) ? 0 : load])
  context.telemetry(rows.map(([channel, value]) => [channel, value !== null && unit(truth.seed, 'dropout', channel, tick) < truth.settings.dropout ? null : value]))
  recordHistory(truth, base, crops, tick, quality, solar, shed.some(id => TIER_ONE.includes(id)))
}

/** Record ground truth for a freshly collected sample. */
export function recordSampleTruth(truth: Truth, base: BaseState, crops: CropState[], sampleId: string, sourceId: string, tick: number) {
  if (sourceId.startsWith('crop-')) {
    const crop = crops.find(value => value.id === sourceId)!
    base.samples[sampleId] = { kind: 'crop', cropId: crop.id, growth: crop.growth, infectedSince: crop.infectedSince, sampledTick: tick }
    return
  }
  const quality = waterQuality(truth, base, tick)
  base.samples[sampleId] = { kind: 'water', source: sourceId, doc: quality[sourceId as 'reservoir'], lubricant: quality.lubricant[sourceId] ?? 0, decay: 1, sampledTick: tick }
}
export { chamberOf }
