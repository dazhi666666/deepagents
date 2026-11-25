/** Mars system commands (non-laboratory actions): validation, durations and settled effects. */
import { z } from 'zod'
import { LaboratoryRefusal } from '../greenhouse/laboratory/world.ts'
import type { LaboratoryState } from '../greenhouse/laboratory/schema.ts'
import { waterAvailable } from '../greenhouse/laboratory/facilities.ts'
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { CHAMBERS, unit, type Truth } from './truth.ts'
import { cropTemperature, sensorOffset, recordSampleTruth, SPARE_FOR, waterQuality, type BaseState, type CropState } from './base.ts'
import { scan } from './observation.ts'

const chamber = z.enum(CHAMBERS)
const module = z.enum(['reservoir', 'filter', 'pump'])
const point = z.enum(['door', 'duct', 'panel'])
export const systemCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('irrigate'), chamberId: z.string(), volumeUl: z.number().int().positive(), cropId: z.string().optional() }).strict(),
  z.object({ action: z.literal('light'), chamberId: z.string(), level: z.number().min(0).max(100) }).strict(),
  z.object({ action: z.literal('nutrient'), chamberId: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), batchId: z.string() }).strict(),
  z.object({ action: z.literal('charge'), robotId: z.string() }).strict(),
  z.object({ action: z.literal('move'), robotId: z.string(), destination: z.string() }).strict(),
  z.object({ action: z.literal('sample'), sourceId: z.string(), volumeUl: z.number().int().positive(), container: z.enum(['tube', 'vial']) }).strict(),
  z.object({ action: z.literal('co2'), chamberId: chamber, setpoint: z.number().min(400).max(1500) }).strict(),
  z.object({ action: z.literal('scan'), chamberId: chamber }).strict(),
  z.object({ action: z.literal('crop_remove'), cropId: z.string() }).strict(),
  z.object({ action: z.literal('quarantine'), chamberId: chamber, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('water_route'), target: z.enum(['main', 'reserve']) }).strict(),
  z.object({ action: z.literal('power_priority'), order: z.array(z.string()).min(1) }).strict(),
  z.object({ action: z.literal('robot_sanitize'), robotId: z.string() }).strict(),
  z.object({ action: z.literal('panel_clean') }).strict(),
  z.object({ action: z.literal('seal_inspect'), chamberId: chamber, point }).strict(),
  z.object({ action: z.literal('seal_repair'), chamberId: chamber, point }).strict(),
  z.object({ action: z.literal('device_service'), deviceId: z.string() }).strict(),
  z.object({ action: z.literal('device_reference'), targetId: z.union([chamber, module]) }).strict(),
  z.object({ action: z.literal('sensor_calibrate'), targetId: z.union([chamber, module]), channel: z.enum(['temperature', 'moisture', 'doc_inline']) }).strict(),
])
export type SystemCommand = z.infer<typeof systemCommandSchema>

/** Work ticks after arrival for maintenance-robot jobs, and the node the robot must reach. */
export const ROBOT_JOBS: Partial<Record<SystemCommand['action'], { ticks: number; node: (command: SystemCommand) => string }>> = {
  panel_clean: { ticks: 10, node: () => 'solar-array' },
  seal_inspect: { ticks: 4, node: command => (command as { chamberId: string }).chamberId },
  seal_repair: { ticks: 6, node: command => (command as { chamberId: string }).chamberId },
  device_service: { ticks: 5, node: command => (command as { deviceId: string }).deviceId },
  device_reference: { ticks: 3, node: command => (command as { targetId: string }).targetId },
  sensor_calibrate: { ticks: 4, node: command => (command as { targetId: string }).targetId },
}
export const SHORT_TICKS: Partial<Record<SystemCommand['action'], number>> = {
  co2: 1, scan: 2, crop_remove: 1, quarantine: 1, water_route: 1, power_priority: 1, robot_sanitize: 6,
}

export interface SystemContext {
  truth: Truth; state: LaboratoryState; base: BaseState; crops: CropState[]
  light: Record<string, number>; nutrient: Record<string, number>; irrigationDose: Record<string, number>
  sampleSources: Record<string, string>; robots: { id: string; operationId: string | null }[]
  saveRaw: (key: string, raw: Json) => void
  waterReference?: (targetId: string, operationId: string) => Json | undefined
  observationKey?: (operationId: string, channel: string) => string | undefined
  includeScanConditions?: boolean
  event: (kind: string, payload: Json) => void
}

/** Validate a system command that does not use the base robot/sample paths (handled in the world class). */
export function validateSystemCommand(context: SystemContext, command: SystemCommand) {
  const { state, base, crops } = context
  const cropOf = (id: string) => crops.find(value => value.id === id)
  switch (command.action) {
    case 'irrigate': {
      if (command.cropId && !crops.some(value => value.id === command.cropId && value.chamberId === command.chamberId && value.status !== 'lost'))
        throw new LaboratoryRefusal('sample', 'Target crop unavailable in this chamber')
      if (!CHAMBERS.includes(command.chamberId as never)) throw new LaboratoryRefusal('unavailable', 'Unknown chamber')
      if (base.water.route === 'reserve') { if (base.water.reserve < command.volumeUl) throw new LaboratoryRefusal('supply', 'Reserve tank holds too little water') }
      else if (!waterAvailable(state) || state.facilities.waterUl < command.volumeUl) throw new LaboratoryRefusal('supply', 'Insufficient available shared water')
      if (base.atmosphere[command.chamberId]?.quarantine && command.cropId === undefined) throw new LaboratoryRefusal('unavailable', 'Quarantined chamber requires per-crop manual irrigation')
      return
    }
    case 'light':
      if (!CHAMBERS.includes(command.chamberId as never)) throw new LaboratoryRefusal('unavailable', 'Unknown chamber')
      return
    case 'nutrient': {
      if (!CHAMBERS.includes(command.chamberId as never)) throw new LaboratoryRefusal('unavailable', 'Unknown chamber')
      const batch = state.batches.find(value => value.id === command.batchId && value.kind === 'medium')
      if (!batch || batch.disposition !== 'available' || batch.expiresAt < state.tick || batch.units < 2) throw new LaboratoryRefusal('supply', 'Changing nutrient level needs two available medium units')
      return
    }
    case 'crop_remove': {
      const crop = cropOf(command.cropId)
      if (!crop || crop.status === 'lost') throw new LaboratoryRefusal('sample', 'Crop unavailable')
      return
    }
    case 'power_priority': {
      if (new Set(command.order).size !== command.order.length) throw new LaboratoryRefusal('identity', 'Priority entries must be unique')
      return
    }
    case 'robot_sanitize': {
      const robot = context.robots.find(value => value.id === command.robotId)
      if (!robot || robot.operationId) throw new LaboratoryRefusal('busy', 'Robot unavailable; inspect its state')
      return
    }
    case 'seal_repair':
      if ((base.spares.sealant ?? 0) < 1) throw new LaboratoryRefusal('supply', 'No sealant left in stores')
      return
    case 'device_service': {
      const spare = SPARE_FOR[command.deviceId]
      if (!spare || !(command.deviceId in base.wear)) throw new LaboratoryRefusal('method', 'Preventive service applies to monitored wear devices')
      if ((base.spares[spare] ?? 0) < 1) throw new LaboratoryRefusal('supply', `No ${spare} spare left in stores`)
      if (state.operations.some(value => value.state === 'running' && value.command.deviceId === command.deviceId)) throw new LaboratoryRefusal('busy', 'Device has accepted work')
      return
    }
    default: return
  }
}

/** Effects consumed when a system command is accepted (spares are used even if the job targets the wrong object). */
export function acceptSystemCommand(context: SystemContext, command: SystemCommand) {
  if (command.action === 'seal_repair') context.base.spares.sealant = (context.base.spares.sealant ?? 0) - 1
  if (command.action === 'device_service') { const spare = SPARE_FOR[command.deviceId]!; context.base.spares[spare] = (context.base.spares[spare] ?? 0) - 1 }
}

/** Apply a settled system command and return its published result. Robot and sample paths stay in the world class. */
export function finishSystemCommand(context: SystemContext, operationId: string, command: SystemCommand, rules: { waterPerMoisture: number }): Json {
  const { truth, state, base, crops } = context
  const tick = state.tick
  switch (command.action) {
    case 'light': return { chamberId: command.chamberId, level: command.level }
    case 'nutrient': {
      state.batches.find(value => value.id === command.batchId)!.units -= 2
      context.nutrient[command.chamberId] = command.level
      return { chamberId: command.chamberId, level: command.level, batchId: command.batchId, mediumUnits: 2 }
    }
    case 'irrigate': {
      const targets = crops.filter(value => value.chamberId === command.chamberId && value.status !== 'lost' && (!command.cropId || command.cropId === value.id))
      const share = command.volumeUl / (command.cropId ? 1 : Math.max(1, targets.length))
      const reserve = base.water.route === 'reserve'
      if (reserve) base.water.reserve -= command.volumeUl
      else state.facilities.waterUl -= command.volumeUl
      const contaminated = !reserve && waterQuality(truth, base, tick).pump > 2.5
      context.irrigationDose[command.chamberId] = command.volumeUl
      for (const crop of targets) {
        crop.moisture = Math.min(100, crop.moisture + share / rules.waterPerMoisture)
        crop.irrigation.push([tick, share])
        crop.irrigation = crop.irrigation.filter(([at]) => at > tick - 200)
        if (contaminated) crop.contamination.push([tick + 40, tick + 60])
      }
      return { chamberId: command.chamberId, waterUl: command.volumeUl, source: base.water.route, perCropUl: Number(share.toFixed(2)) }
    }
    case 'co2': base.atmosphere[command.chamberId]!.setpoint = command.setpoint; return { chamberId: command.chamberId, setpoint: command.setpoint }
    case 'scan': {
      const lightLevel = context.light[command.chamberId] ?? 70
      const result = scan(truth, context.observationKey?.(operationId, 'scan') ?? operationId, crops.filter(value => value.chamberId === command.chamberId).map(value => ({ id: value.id, growth: value.growth,
        infectedSince: value.infectedSince, lost: value.status === 'lost' })), lightLevel, tick)
      context.saveRaw(`scan:${operationId}`, result.raw)
      return { chamberId: command.chamberId, tick, light: lightLevel, values: result.values,
        ...(context.includeScanConditions ? { conditions: { light: lightLevel, nutrient: context.nutrient[command.chamberId] ?? 1,
          temperature: cropTemperature(state, lightLevel, command.chamberId) + sensorOffset(truth, base, command.chamberId, 'temperature', tick),
          co2: Number(base.atmosphere[command.chamberId]!.co2.toFixed(1)), irrigationByCrop: Object.fromEntries(crops.filter(c => c.chamberId === command.chamberId)
            .map(c => [c.id, c.irrigation.filter(([at]) => at > tick - 100).reduce((n, [, volume]) => n + volume, 0)])) } } : {}),
        rawArtifact: 'raw.json (8 x 8 x 8 cube per crop); analyse with analysis_run' }
    }
    case 'crop_remove': {
      const crop = crops.find(value => value.id === command.cropId)!
      crop.status = 'lost'; crop.removed = true; crop.growth = 0
      context.event('crop-status-changed', { id: crop.id, chamberId: crop.chamberId, status: 'lost', removed: true })
      return { cropId: crop.id, removed: true }
    }
    case 'quarantine': base.atmosphere[command.chamberId]!.quarantine = command.enabled; return { chamberId: command.chamberId, quarantine: command.enabled }
    case 'water_route': base.water.route = command.target; return { route: command.target, reserveUl: base.water.reserve }
    case 'power_priority': {
      const rest = base.energy.priority.filter(value => !command.order.includes(value))
      base.energy.priority = [...command.order, ...rest]
      return { priority: base.energy.priority, note: 'Loads earlier in the list are shed first when demand exceeds supply' }
    }
    case 'robot_sanitize': base.robotsContaminated = base.robotsContaminated.filter(value => value !== command.robotId); return { robotId: command.robotId, sanitized: true }
    case 'panel_clean': base.energy.dust = 1; return { cleaned: true, dustFactor: 1 }
    case 'seal_inspect': {
      const leaking = truth.leak !== null && truth.leak.chamber === command.chamberId && truth.leak.point === command.point && tick >= truth.leak.onset && !base.leak.resolved
      base.leak.inspected.push(`${command.chamberId}:${command.point}`)
      return { chamberId: command.chamberId, point: command.point, leaking }
    }
    case 'seal_repair': {
      const correct = truth.leak !== null && truth.leak.chamber === command.chamberId && truth.leak.point === command.point && tick >= truth.leak.onset && !base.leak.resolved
      if (correct) base.leak.resolved = true
      return { chamberId: command.chamberId, point: command.point, sealantUsed: 1, leakStopped: correct }
    }
    case 'device_service': base.wear[command.deviceId] = 0; return { deviceId: command.deviceId, serviced: true }
    case 'device_reference': {
      if (command.targetId.startsWith('incubator-')) {
        const device = state.devices.find(value => value.id === command.targetId)!
        const light = context.light[command.targetId] ?? 70
        const temperature = (device.temperature ?? 22) + 0.03 * Math.max(0, light - 70)
        return { targetId: command.targetId, reference: { temperature: Number(temperature.toFixed(3)),
          crops: crops.filter(value => value.chamberId === command.targetId).map(value => ({ cropId: value.id, moisture: Number(value.moisture.toFixed(3)), status: value.status })),
          co2: Number(base.atmosphere[command.targetId]!.co2.toFixed(1)), pressure: Number(base.atmosphere[command.targetId]!.pressure.toFixed(3)) }, tick }
      }
      const versioned = context.waterReference?.(command.targetId, operationId)
      if (versioned !== undefined) return versioned
      const quality = waterQuality(truth, base, tick)
      return { targetId: command.targetId, reference: { docInline: Number(quality[command.targetId as 'reservoir'].toFixed(3)) }, tick,
        note: 'Reference inline probe; laboratory confirm remains the method of record' }
    }
    case 'sensor_calibrate': {
      if (command.channel === 'doc_inline') {
        for (const event of truth.contamination) if (event.decoyModule === command.targetId && tick >= event.decoyOnset && !base.water.decoyCleared.includes(event.event)) base.water.decoyCleared.push(event.event)
      } else base.sensorCalibrated[`${command.targetId}:${command.channel}`] = tick
      return { targetId: command.targetId, channel: command.channel, calibratedTick: tick }
    }
    default: throw new Error(`Unhandled system command ${command.action}`)
  }
}

/** Record ground truth and conditions for a newly collected sample. */
export function sampleEffects(context: SystemContext, sampleId: string, sourceId: string) {
  recordSampleTruth(context.truth, context.base, context.crops, sampleId, sourceId, context.state.tick)
  context.sampleSources[sampleId] = sourceId
}

/** A contaminated robot can carry pathogen into the chamber it delivers to. */
export function robotVector(context: SystemContext, robotId: string, destination: string, carriedRoots: string[], operationId: string) {
  const { base, crops, state } = context
  if (carriedRoots.some(root => { const record = base.samples[root]; return record?.kind === 'crop' && record.infectedSince !== null && record.infectedSince <= record.sampledTick }))
    if (!base.robotsContaminated.includes(robotId)) base.robotsContaminated.push(robotId)
  if (!destination.startsWith('incubator-') || !base.robotsContaminated.includes(robotId)) return
  const healthy = crops.filter(value => value.chamberId === destination && value.status !== 'lost' && value.infectedSince === null)
  if (healthy.length && unit(context.truth.seed, 'vector', operationId) < 0.1) healthy[Math.floor(unit(context.truth.seed, 'vector-target', operationId) * healthy.length)]!.infectedSince = state.tick
}
