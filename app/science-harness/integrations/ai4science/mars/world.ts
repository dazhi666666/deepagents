/** Mars crop, energy, atmosphere and logistics state commits atomically with laboratory physical stages. */
import { z } from 'zod'
import { LaboratoryRefusal, LaboratoryWorld } from '../greenhouse/laboratory/world.ts'
import type { LaboratoryCommand, LaboratoryOperation, LaboratoryScenario, LaboratoryState } from '../greenhouse/laboratory/schema.ts'
import { laboratorySampleIds } from '../greenhouse/laboratory/commands.ts'
import { canonicalJson, type Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { marsLayout } from './layout.ts'
import { planRoute, routePosition } from './routing.ts'
import { CHAMBERS, CROP_IDS, chamberOf, varietyOf, type Truth } from './truth.ts'
import { baseStateSchema, cropTemperature, initialBase, inlineOffset, SPARE_FOR, sensorOffset, stepBase, waterQuality, type BaseState, type CropState } from './base.ts'
import { measure } from './observation.ts'
import { ROBOT_CAPACITY } from './scenario.ts'
import { acceptSystemCommand, finishSystemCommand, robotVector, ROBOT_JOBS, sampleEffects, SHORT_TICKS, systemCommandSchema, validateSystemCommand,
  type SystemCommand, type SystemContext } from './world-system.ts'

export { systemCommandSchema, type SystemCommand } from './world-system.ts'

/** Check the declared cargo independently of live route and battery conditions. */
export function validateCarrierCapacity(command: Extract<LaboratoryCommand, { action: 'transfer' }>) {
  const capacity = ROBOT_CAPACITY[command.deviceId] ?? 1
  if (laboratorySampleIds(command).length > capacity)
    throw new LaboratoryRefusal('capacity', `Robot ${command.deviceId} carries at most ${capacity} samples`)
}

const point = z.object({ x: z.number(), y: z.number() })
const segment = z.object({ from: z.string(), to: z.string(), startTick: z.number(), endTick: z.number(),
  fromPosition: point.optional(), toPosition: point.optional(), reservationKey: z.string().optional() })
const robot = z.object({ id: z.string(), node: z.string(), x: z.number(), y: z.number(), energy: z.number(),
  operationId: z.string().nullable(), updatedTick: z.number().default(0), blockedEdge: segment.nullable().default(null), segments: z.array(segment) })
const crop = z.object({ id: z.string(), chamberId: z.string(), moisture: z.number(), exposureTicks: z.number().int(),
  availableSampleUl: z.number().nonnegative(), status: z.enum(['healthy', 'stressed', 'lost']),
  growth: z.number().default(0), biomass: z.number().default(0), removed: z.boolean().default(false), infectedSince: z.number().nullable().default(null),
  contamination: z.array(z.tuple([z.number(), z.number()])).default([]), irrigation: z.array(z.tuple([z.number(), z.number()])).default([]) })
const systemOperation = z.object({ id: z.string(), identity: z.string(), projectId: z.string(), command: systemCommandSchema,
  acceptedTick: z.number(), nextTick: z.number(), state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  completedTick: z.number().optional(), segments: z.array(segment).default([]),
  result: z.json().nullable(), detail: z.string().nullable() })
export const marsSystemStateSchema = z.object({ sampleConditions: z.record(z.string(), z.json()).default({}),
  cropIrrigationDose: z.record(z.string(), z.number()).default({}), cropControlTicks: z.record(z.string(), z.number()).default({}),
  nutrient: z.record(z.string(), z.number()).default({}), irrigationDose: z.record(z.string(), z.number()).default({}),
  controlTicks: z.record(z.string(), z.number()).default({}), robots: z.array(robot), crops: z.array(crop), light: z.record(z.string(), z.number()),
  transports: z.array(z.object({ operationId: z.string(), robotId: z.string(), pickupTick: z.number(), finishTick: z.number(),
    segments: z.array(segment) })), operations: z.array(systemOperation), sampleSources: z.record(z.string(), z.string()) })
type Extension = z.infer<typeof marsSystemStateSchema>

/** Frozen physical parameters are scenario settings and remain public to all participants. */
export const marsRulesSchema = z.object({
  speed: z.number().positive(), energyCapacity: z.number().positive(), energyPerTick: z.number().positive(),
  cropProfiles: z.array(z.object({ batch: z.number().int().min(1).max(4), initialMoisture: z.number().min(0).max(100),
    minimumMoisture: z.number().min(0).max(100), minimumTemperature: z.number(), maximumTemperature: z.number(),
    exposureToleranceTicks: z.number().int().nonnegative(), moistureMultiplier: z.number().positive() }).strict()).length(4),
  maintenanceReachUnits: z.number().positive(),
  chargeTicks: z.number().int().positive(), waterPerMoisture: z.number().positive(),
  lightReference: z.number().positive(), lightPowerFraction: z.number().min(0).max(1),
  moistureLossPerTick: z.number().positive(),
  plantSampleCapacityUl: z.number().int().positive(), sampleLifetimeTicks: z.number().int().positive(), sampleTicks: z.number().int().positive(),
}).strict()
export type MarsRules = z.infer<typeof marsRulesSchema>

/** Public physical parameters, frozen with each run's device configuration. */
export function initialMarsRules(): MarsRules {
  return { cropProfiles: [
    { batch: 1, initialMoisture: 75, minimumMoisture: 30, minimumTemperature: 16, maximumTemperature: 28, exposureToleranceTicks: 80, moistureMultiplier: 0.8 },
    { batch: 2, initialMoisture: 70, minimumMoisture: 35, minimumTemperature: 18, maximumTemperature: 26, exposureToleranceTicks: 60, moistureMultiplier: 1 },
    { batch: 3, initialMoisture: 65, minimumMoisture: 40, minimumTemperature: 19, maximumTemperature: 25, exposureToleranceTicks: 40, moistureMultiplier: 1.2 },
    { batch: 4, initialMoisture: 72, minimumMoisture: 38, minimumTemperature: 17, maximumTemperature: 27, exposureToleranceTicks: 50, moistureMultiplier: 1.1 },
  ], speed: 2, energyCapacity: 120, energyPerTick: 0.5, maintenanceReachUnits: 16, chargeTicks: 12, waterPerMoisture: 10,
    lightReference: 70, lightPowerFraction: 0.5, moistureLossPerTick: 0.04, plantSampleCapacityUl: 9000, sampleLifetimeTicks: 1600, sampleTicks: 3 }
}

/** Shared SQLite transactions preserve robot cargo, water, crop and base-subsystem effects across failures. */
export class MarsWorld extends LaboratoryWorld {
  readonly rules: MarsRules
  readonly truth: Truth
  readonly horizon: number
  private advancementLimit: number | undefined
  /** Execution stopping policy is distinct from the frozen scientific horizon. */
  get stopAtTick(): number { return this.advancementLimit ?? this.horizon }
  setStopAtTick(tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < this.observe().tick || tick > this.horizon) throw new Error('Stop tick must be an integer between current tick and benchmark horizon')
    this.advancementLimit = tick
  }
  constructor(directory: string, scenario: LaboratoryScenario, rules: MarsRules, truth: Truth) {
    super(directory, scenario)
    this.rules = marsRulesSchema.parse(rules)
    this.truth = truth
    this.horizon = truth.horizon
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS mars_state(id INTEGER PRIMARY KEY CHECK(id=1),rules TEXT NOT NULL,state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mars_base(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mars_measurements(result_id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mars_raw(key TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mars_telemetry(tick INTEGER NOT NULL,channel TEXT NOT NULL,value REAL);
        CREATE INDEX IF NOT EXISTS mars_telemetry_lookup ON mars_telemetry(channel,tick);`)
      const existing = this.db.prepare('SELECT rules FROM mars_state WHERE id=1').get()
      if (existing && existing.rules !== canonicalJson(z.json().parse(this.rules))) throw new Error('Mars physical rules changed')
      if (!existing) {
        const robots = marsLayout().anchors.filter(anchor => anchor.id.startsWith('robot-')).map(anchor => ({
          id: anchor.id, node: anchor.id, x: anchor.x, y: anchor.y, energy: rules.energyCapacity, operationId: null, updatedTick: 0, blockedEdge: null, segments: [] }))
        const crops = CROP_IDS.map(id => ({ id, chamberId: chamberOf(id), moisture: rules.cropProfiles[varietyOf(id) - 1]!.initialMoisture, exposureTicks: 0,
          availableSampleUl: rules.plantSampleCapacityUl, status: 'healthy' as const, growth: 0, biomass: 0, removed: false, infectedSince: null,
          contamination: [], irrigation: [[-1, 75] as [number, number]] }))
        this.db.prepare('INSERT INTO mars_state VALUES(1,?,?)').run(canonicalJson(z.json().parse(this.rules)),
          JSON.stringify({ robots, crops, light: Object.fromEntries(CHAMBERS.map(id => [id, 70])), transports: [], operations: [], sampleSources: {} }))
        const base = initialBase(truth, scenario.devices.map(device => device.id))
        this.db.prepare('INSERT INTO mars_base VALUES(1,?)').run(JSON.stringify(base))
      }
    } catch (error) { this.close(); throw error }
  }
  private extension(): Extension {
    const row = z.object({ state: z.string() }).parse(this.db.prepare('SELECT state FROM mars_state WHERE id=1').get())
    return marsSystemStateSchema.parse(JSON.parse(row.state))
  }
  private save(extension: Extension) { this.db.prepare('UPDATE mars_state SET state=? WHERE id=1').run(JSON.stringify(marsSystemStateSchema.parse(extension))) }
  private base(): BaseState {
    const row = z.object({ state: z.string() }).parse(this.db.prepare('SELECT state FROM mars_base WHERE id=1').get())
    return baseStateSchema.parse(JSON.parse(row.state))
  }
  private saveBase(base: BaseState) { this.db.prepare('UPDATE mars_base SET state=? WHERE id=1').run(JSON.stringify(base)) }
  /** Version-specific probe response; undefined preserves the legacy reference specification. */
  protected waterReference(_targetId: string, _operationId: string, _state: LaboratoryState, _base: BaseState): Json | undefined { return undefined }
  /** Undefined preserves legacy result-ID noise; newer versions may normalize physical observations. */
  protected observationKey(_operationId: string, _channel: string, _tick: number): string | undefined { return undefined }
  protected get includeScanConditions(): boolean { return false }
  private context(state: LaboratoryState, extension: Extension, base: BaseState): SystemContext {
    return { truth: this.truth, state, base, waterReference: (targetId, operationId) => this.waterReference(targetId, operationId, state, base),
      observationKey: (operationId, channel) => this.observationKey(operationId, channel, state.tick), includeScanConditions: this.includeScanConditions, crops: extension.crops as CropState[], light: extension.light, nutrient: extension.nutrient,
      irrigationDose: extension.irrigationDose, sampleSources: extension.sampleSources, robots: extension.robots,
      saveRaw: (key, raw) => { this.db.prepare('INSERT OR REPLACE INTO mars_raw VALUES(?,?)').run(key, JSON.stringify(raw)) },
      event: (kind, payload) => this.event(state.tick, kind, payload) }
  }
  /** Return committed crop, robot and additional operation state. */
  observeSystems() { return this.extension() }
  /** Return committed base-subsystem state (evaluator and host view; Agents see sensors instead). */
  observeBase() { return this.base() }

  private travel(state: LaboratoryState, extension: Extension, robotId: string, pickup: string, destination: string) {
    const vehicle = extension.robots.find(value => value.id === robotId)
    const device = state.devices.find(value => value.id === robotId)
    if (!vehicle || !device || device.broken || !device.enabled || vehicle.operationId) throw new LaboratoryRefusal('busy', 'Robot unavailable; inspect its state')
    const traffic = extension.robots.filter(value => value.id !== robotId).flatMap(value => {
      if (value.blockedEdge) return [{ ...value.blockedEdge, startTick: state.tick, endTick: Number.MAX_SAFE_INTEGER }]
      if (!value.operationId) return [{ from: value.node, to: value.node, startTick: state.tick, endTick: Number.MAX_SAFE_INTEGER }]
      const finish = extension.transports.find(route => route.operationId === value.operationId)?.finishTick ??
        extension.operations.find(operation => operation.id === value.operationId)?.nextTick ?? state.tick
      const stops = value.segments.map((segment, index) => ({ from: segment.to, to: segment.to, startTick: segment.endTick,
        endTick: Math.max(segment.endTick + 1, value.segments[index + 1]?.startTick ?? finish) }))
      if (!value.segments.length) stops.push({ from: value.node, to: value.node, startTick: state.tick, endTick: finish })
      return [...value.segments, ...stops]
    })
    const approach = planRoute(vehicle.node, pickup, state.tick, traffic, this.rules.speed, { x: vehicle.x, y: vehicle.y }, vehicle.blockedEdge)
    if (!approach) throw new LaboratoryRefusal('busy', 'Robot approach route conflicts with accepted traffic')
    const pickupTick = (approach.at(-1)?.endTick ?? state.tick) + this.scenario.loadingTicks
    const loaded = planRoute(pickup, destination, pickupTick, traffic, this.rules.speed)
    if (!loaded) throw new LaboratoryRefusal('busy', 'Loaded route conflicts with accepted traffic')
    const finishTick = (loaded.at(-1)?.endTick ?? pickupTick) + this.scenario.handlingTicks
    if (vehicle.energy < (finishTick - state.tick) * this.rules.energyPerTick) throw new LaboratoryRefusal('unavailable', 'Charge robot before reserving this route')
    return { vehicle, pickupTick, finishTick, segments: [...approach, ...loaded] }
  }
  private repairRoute(state: LaboratoryState, extension: Extension, deviceId: string) {
    const target = extension.robots.find(vehicle => vehicle.id === deviceId)
    if (!target) return this.travel(state, extension, 'robot-3', deviceId, deviceId)
    const nodes = marsLayout().nodes
    const adjacent = marsLayout().edges.flatMap(edge => edge.from === target.node ? [edge.to] : edge.to === target.node ? [edge.from] : [])
    const candidates = [...new Set([target.node, ...adjacent, ...(target.blockedEdge ? [target.blockedEdge.from, target.blockedEdge.to] : [])])]
      .filter(id => nodes.some(node => node.id === id && Math.hypot(node.x - target.x, node.y - target.y) <= this.rules.maintenanceReachUnits))
    let refusal: LaboratoryRefusal | undefined
    for (const node of candidates) {
      try { return this.travel(state, extension, 'robot-3', node, node) }
      catch (error) { if (!(error instanceof LaboratoryRefusal)) throw error; refusal = error }
    }
    throw refusal ?? new LaboratoryRefusal('unavailable', 'Maintenance robot cannot reach a safe servicing point')
  }

  protected override validateExtension(state: LaboratoryState, command: LaboratoryCommand): void {
    const base = this.base()
    if (command.action === 'transfer') {
      const sample = state.samples.find(value => value.id === command.sampleId)!
      const carried = laboratorySampleIds(command)
      validateCarrierCapacity(command)
      if (sample.location.startsWith('robot-') && sample.location !== command.deviceId)
        throw new LaboratoryRefusal('sample', 'Recover the original carrier before transferring its onboard cargo')
      if (state.samples.some(value => value.location === command.deviceId && !carried.includes(value.id) && value.volumeUl > 0))
        throw new LaboratoryRefusal('capacity', 'Robot already carries other material; unload it first')
      this.travel(state, this.extension(), command.deviceId, sample.location === command.deviceId ? this.extension().robots.find(value => value.id === command.deviceId)!.node : sample.location, command.destination)
    }
    if (command.action === 'repair') {
      const spare = SPARE_FOR[command.deviceId]
      if (spare && (base.spares[spare] ?? 0) < 1) throw new LaboratoryRefusal('supply', `Repair needs a ${spare} spare; none left in stores`)
      this.repairRoute(state, this.extension(), command.deviceId)
    }
    if (command.action === 'refill' && base.water.reserve < command.volumeUl) throw new LaboratoryRefusal('supply', 'Refill draws on the clean reserve tank, which holds too little water')
    if (command.action === 'order' && state.operations.some(operation => operation.command.action === 'order' && operation.state !== 'failed'))
      throw new LaboratoryRefusal('supply', 'The single resupply shuttle slot has already been used')
    if ((command.action === 'process' || command.action === 'calibrate') && state.devices.find(device => device.id === command.deviceId)?.shed)
      throw new LaboratoryRefusal('supply', 'Device load is currently shed by the power manager')
  }
  protected override acceptExtension(state: LaboratoryState, operation: LaboratoryOperation): void {
    const command = operation.command
    if (command.action === 'repair') {
      const base = this.base(), spare = SPARE_FOR[command.deviceId]
      if (spare) { base.spares[spare] = (base.spares[spare] ?? 0) - 1; this.saveBase(base) }
    }
    if (command.action !== 'transfer' && command.action !== 'repair') return
    const extension = this.extension()
    const robotId = command.action === 'transfer' ? command.deviceId : 'robot-3'
    const sample = command.action === 'transfer' ? state.samples.find(value => value.id === command.sampleId)! : null
    const current = extension.robots.find(value => value.id === robotId)!
    const pickup = sample ? sample.location === robotId ? current.node : sample.location : command.deviceId
    const destination = command.action === 'transfer' ? command.destination : command.deviceId
    const route = command.action === 'repair' ? this.repairRoute(state, extension, command.deviceId) : this.travel(state, extension, robotId, pickup, destination)
    const repairTicks = this.scenario.maintenanceTicks * (command.action === 'repair' && command.deviceId in this.truth.wear ? 3 : 1)
    operation.nextTick = route.pickupTick
    route.vehicle.operationId = operation.id; route.vehicle.segments = route.segments; route.vehicle.updatedTick = state.tick; route.vehicle.blockedEdge = null
    extension.transports.push({ operationId: operation.id, robotId, pickupTick: route.pickupTick,
      finishTick: command.action === 'repair' ? route.pickupTick + repairTicks : route.finishTick, segments: route.segments })
    this.save(extension)
    this.event(state.tick, 'robot-route-accepted', z.json().parse(extension.transports.at(-1)))
  }
  protected override processingDuration(_state: LaboratoryState, operation: LaboratoryOperation, duration: number): number {
    const transport = this.extension().transports.find(value => value.operationId === operation.id)
    return transport ? transport.finishTick - transport.pickupTick : duration
  }
  protected override operationFailureExtension(state: LaboratoryState, operation: LaboratoryOperation): string | undefined {
    const vehicle = this.extension().robots.find(value => value.operationId === operation.id)
    if (vehicle && state.devices.find(device => device.id === vehicle.id)?.broken) return 'Assigned robot failed; position and cargo retained'
    if (operation.command.action === 'process' && state.devices.find(device => device.id === operation.command.deviceId)?.shed) return 'Device lost power (load shed); consumed material is retained'
    return undefined
  }
  protected override finishExtension(state: LaboratoryState, operation: LaboratoryOperation): void {
    const extension = this.extension(), base = this.base(), command = operation.command
    const vehicle = extension.robots.find(value => value.operationId === operation.id)
    if (vehicle) {
      const position = routePosition(vehicle.node, vehicle.segments, state.tick)
      const blockedEdge = vehicle.segments.find(segment => segment.startTick < state.tick && segment.endTick > state.tick) ?? null
      Object.assign(vehicle, position, { energy: Math.max(0, vehicle.energy - (state.tick - vehicle.updatedTick) * this.rules.energyPerTick), updatedTick: state.tick, blockedEdge, operationId: null, segments: [] })
      this.event(state.tick, 'robot-operation-settled', z.json().parse({ robotId: vehicle.id, operationId: operation.id,
        position, state: operation.state, cargo: state.samples.filter(sample => sample.location === vehicle.id).map(sample => sample.id) }))
    }
    if (operation.state === 'succeeded') {
      const wearUp = (deviceId: string) => {
        if (!(deviceId in base.wear)) return
        base.wear[deviceId] = (base.wear[deviceId] ?? 0) + this.truth.wear[deviceId]!.perUse
        const device = state.devices.find(value => value.id === deviceId)!
        if (base.wear[deviceId]! >= 1 && !device.broken) { device.broken = true; this.event(state.tick, 'device-fault', { deviceId, observed: 'Device stopped responding after its last cycle' }) }
      }
      if (command.action === 'process') {
        const device = state.devices.find(value => value.id === command.deviceId)!
        const calibrationAge = device.calibrationId && device.calibratedUntil !== undefined ? state.tick - (device.calibratedUntil - this.scenario.calibrationLifetimeTicks) : null
        for (const resultId of operation.resultIds ?? []) {
          const result = state.results.find(value => value.id === resultId)!
          const output = measure(this.truth, base, { resultId, methodId: result.methodId, methodVersion: result.methodVersion, sampleId: result.sampleId,
            batchIds: result.batchIds, calibrationAge, tick: state.tick })
          this.db.prepare('INSERT OR REPLACE INTO mars_measurements VALUES(?,?)').run(resultId, JSON.stringify(output.measurement))
          if (output.raw) this.db.prepare('INSERT OR REPLACE INTO mars_raw VALUES(?,?)').run(resultId, JSON.stringify(output.raw))
        }
        for (const resultId of operation.resultIds ?? []) {
          const result = state.results.find(value => value.id === resultId)!, output = result.outputSampleId
          if (output && base.samples[result.sampleId] && !base.samples[output]) base.samples[output] = structuredClone(base.samples[result.sampleId]!)
        }
        wearUp(command.deviceId)
      }
      if (command.action === 'transfer') {
        const roots = laboratorySampleIds(command).map(id => {
          let sample = state.samples.find(value => value.id === id)!
          while (sample.parentId) sample = state.samples.find(value => value.id === sample.parentId)!
          return sample.id
        })
        robotVector(this.context(state, extension, base), command.deviceId, command.destination, roots, operation.id)
        wearUp(command.deviceId)
      }
      if (command.action === 'repair') {
        if (command.deviceId in base.wear) base.wear[command.deviceId] = 0
        for (const event of this.truth.contamination) {
          const resolved = base.water.resolved[event.event] ?? []
          if (command.deviceId === 'filter' && event.hypotheses.includes('membrane') && state.tick >= event.onset && !resolved.includes('membrane')) resolved.push('membrane')
          if (command.deviceId === 'pump' && event.hypotheses.includes('seal') && state.tick >= event.onset && !resolved.includes('seal')) resolved.push('seal')
          base.water.resolved[event.event] = resolved
        }
      }
      if (command.action === 'clean' && command.deviceId === 'reservoir') for (const event of this.truth.contamination) {
        const resolved = base.water.resolved[event.event] ?? []
        if (event.hypotheses.includes('inlet') && state.tick >= event.onset && !resolved.includes('inlet')) resolved.push('inlet')
        base.water.resolved[event.event] = resolved
      }
      if (command.action === 'refill') base.water.reserve -= command.volumeUl
    }
    this.save(extension); this.saveBase(base)
  }
  protected override extensionTicks(state: LaboratoryState): number[] {
    return state.tick < this.horizon ? [state.tick + 1] : []
  }
  /** Never advance past either the scientific horizon or the explicit execution stopping limit. */
  override advance(horizonTick?: number): number | null {
    if (this.observe().tick >= this.stopAtTick) return null
    return super.advance(Math.min(horizonTick ?? this.stopAtTick, this.stopAtTick))
  }
  protected override advanceExtension(state: LaboratoryState, _previous: LaboratoryState): void {
    const extension = this.extension(), base = this.base()
    for (const vehicle of extension.robots) if (vehicle.operationId && !extension.operations.some(operation => operation.id === vehicle.operationId && operation.command.action === 'charge')) {
      const position = routePosition(vehicle.node, vehicle.segments, state.tick)
      Object.assign(vehicle, { x: position.x, y: position.y, energy: Math.max(0, vehicle.energy - (state.tick - vehicle.updatedTick) * this.rules.energyPerTick), updatedTick: state.tick })
    }
    for (const vehicle of extension.robots) if (vehicle.operationId && state.devices.find(device => device.id === vehicle.id)?.broken) {
      const lab = state.operations.find(operation => operation.id === vehicle.operationId && operation.state === 'running')
      const system = extension.operations.find(operation => operation.id === vehicle.operationId && operation.state === 'running')
      if (lab) {
        lab.state = 'failed'; lab.stage = 'finished'; lab.completedTick = state.tick; lab.detail = 'Assigned robot failed; retained physical effects'
        this.event(state.tick, 'operation-finished', z.json().parse(lab))
      }
      if (system) { system.state = 'failed'; system.completedTick = state.tick; system.detail = 'Assigned robot failed'; this.event(state.tick, 'system-operation-settled', z.json().parse(system)) }
      vehicle.blockedEdge = vehicle.segments.find(segment => segment.startTick < state.tick && segment.endTick > state.tick) ?? null
      vehicle.node = routePosition(vehicle.node, vehicle.segments, state.tick).node
      vehicle.operationId = null; vehicle.segments = []
    }
    const rows: [string, number | null][] = []
    stepBase({ truth: this.truth, state, crops: extension.crops as CropState[], profiles: this.rules.cropProfiles, light: extension.light, nutrient: extension.nutrient, base,
      event: (kind, payload) => this.event(state.tick, kind, payload), telemetry: values => rows.push(...values) })
    const insert = this.db.prepare('INSERT INTO mars_telemetry VALUES(?,?,?)')
    for (const [channel, value] of rows) insert.run(state.tick, channel, value)
    const context = this.context(state, extension, base)
    for (const operation of extension.operations.filter(value => value.state === 'running' && value.nextTick <= state.tick)) {
      try {
        operation.result = this.finishSystem(state, extension, context, operation)
        operation.state = 'succeeded'
      } catch (error) {
        if (!(error instanceof LaboratoryRefusal)) throw error
        operation.state = 'failed'; operation.detail = error.message
      }
      const vehicle = extension.robots.find(value => value.operationId === operation.id)
      if (vehicle) {
        Object.assign(vehicle, routePosition(vehicle.node, vehicle.segments, state.tick), { operationId: null, segments: [], updatedTick: state.tick })
        vehicle.node = routePosition(vehicle.node, operation.segments, state.tick).node
      }
      operation.completedTick = state.tick
      this.event(state.tick, 'system-operation-settled', z.json().parse(operation))
    }
    this.save(extension); this.saveBase(base)
  }

  private validateSystem(state: LaboratoryState, extension: Extension, base: BaseState, command: SystemCommand) {
    if (command.action === 'move') {
      const vehicle = extension.robots.find(value => value.id === command.robotId)
      if (!vehicle) throw new LaboratoryRefusal('unavailable', 'Unknown robot')
      this.travel(state, extension, command.robotId, vehicle.node, command.destination)
      return
    }
    if (command.action === 'charge') {
      const vehicle = extension.robots.find(value => value.id === command.robotId)
      const home = marsLayout().anchors.find(anchor => anchor.id === command.robotId)
      if (!vehicle || !home || vehicle.operationId || vehicle.node !== vehicle.id || vehicle.x !== home.x || vehicle.y !== home.y) throw new LaboratoryRefusal('unavailable', 'Charge needs an idle robot at its home dock')
      return
    }
    if (command.action === 'sample') {
      const crop = extension.crops.find(value => value.id === command.sourceId)
      const deviceId = crop?.chamberId ?? command.sourceId
      const device = state.devices.find(value => value.id === deviceId)
      if (!device || !device.containers.includes(command.container) || crop?.status === 'lost' || crop && crop.availableSampleUl < command.volumeUl || !crop && device.kind !== 'water-module')
        throw new LaboratoryRefusal('sample', 'Source unavailable or incompatible container')
      if (!crop && (!state.devices.filter(value => value.kind === 'water-module').every(value => !value.broken && value.enabled) || state.facilities.waterUl < command.volumeUl))
        throw new LaboratoryRefusal('supply', 'Water sampling requires a working water loop and available shared water')
      if (device.broken || !device.enabled || state.samples.filter(value => value.location === deviceId && value.volumeUl > 0).length >= device.capacity)
        throw new LaboratoryRefusal('capacity', 'Sampling location unavailable or full')
      return
    }
    const job = ROBOT_JOBS[command.action]
    if (job) this.travel(state, extension, 'robot-3', job.node(command), job.node(command))
    validateSystemCommand(this.context(state, extension, base), command)
  }
  private finishSystem(state: LaboratoryState, extension: Extension, context: SystemContext, operation: z.infer<typeof systemOperation>): Json {
    const command = operation.command
    if (command.action === 'move') {
      const vehicle = extension.robots.find(value => value.id === command.robotId)!
      return { robotId: vehicle.id, position: routePosition(vehicle.node, vehicle.segments, state.tick) }
    }
    if (command.action === 'charge') {
      const vehicle = extension.robots.find(value => value.id === command.robotId)!
      vehicle.energy = this.rules.energyCapacity
      return { robotId: vehicle.id, energy: vehicle.energy }
    }
    if (command.action === 'light') {
      extension.light[command.chamberId] = command.level; extension.controlTicks[command.chamberId] = state.tick
      const device = state.devices.find(value => value.id === command.chamberId)!
      const baseline = this.scenario.devices.find(value => value.id === command.chamberId)!.powerDraw
      device.powerDraw = baseline * (1 - this.rules.lightPowerFraction + this.rules.lightPowerFraction * command.level / this.rules.lightReference)
    }
    if (command.action !== 'sample') {
      if (!ROBOT_JOBS[command.action] && command.action !== 'robot_sanitize') this.validateSystem(state, extension, context.base, command)
      return finishSystemCommand(context, operation.id, command, this.rules)
    }
    this.validateSystem(state, extension, context.base, command)
    const source = extension.crops.find(value => value.id === command.sourceId)
    const location = source?.chamberId ?? command.sourceId, id = `sample:${operation.id}`
    state.samples.push({ id, projectId: operation.projectId, container: command.container, location, volumeUl: command.volumeUl,
      state: 'raw', expiresAt: state.tick + this.rules.sampleLifetimeTicks, disposition: 'available', batchIds: [], exposureTicks: 0,
      preservation: { minimumTemperature: source ? -15 : -30, maximumTemperature: source ? 35 : 22, maximumExposureTicks: 400 } })
    if (source) source.availableSampleUl -= command.volumeUl
    else state.facilities.waterUl -= command.volumeUl
    sampleEffects(context, id, command.sourceId)
    const chamberId = source?.chamberId
    extension.sampleConditions[id] = chamberId ? { tick: state.tick, chamberId, light: extension.light[chamberId] ?? 70, nutrient: extension.nutrient[chamberId] ?? 1,
      co2Setpoint: context.base.atmosphere[chamberId]!.setpoint, irrigationLast100: source!.irrigation.filter(([at]) => at > state.tick - 100).reduce((sum, [, volume]) => sum + volume, 0),
      temperatureTarget: state.devices.find(value => value.id === chamberId)!.targetTemperature ?? 22 } : { tick: state.tick, sourceId: command.sourceId }
    return { sampleId: id, sourceId: command.sourceId, tick: state.tick }
  }

  /** Validate a system command before the execution engine registers it. */
  prepareSystem(input: Json) {
    const command = systemCommandSchema.parse(input)
    this.validateSystem(this.load(), this.extension(), this.base(), command)
    return command
  }
  /** Accept idempotent system operations, reserving the maintenance robot for site work. */
  submitSystem(id: string, projectId: string, identity: string, input: Json) {
    const command = systemCommandSchema.parse(input)
    return this.update(state => {
      const extension = this.extension(), base = this.base(), prior = extension.operations.find(value => value.id === id)
      if (prior) {
        if (prior.identity !== identity || prior.projectId !== projectId) throw new LaboratoryRefusal('identity', 'System operation identity differs')
        return prior
      }
      this.validateSystem(state, extension, base, command)
      const short = SHORT_TICKS[command.action]
      const operation: z.infer<typeof systemOperation> = { id, projectId, identity, command, acceptedTick: state.tick,
        nextTick: state.tick + (command.action === 'charge' ? this.rules.chargeTicks : short ?? this.rules.sampleTicks), state: 'running', segments: [], result: null, detail: null }
      const job = ROBOT_JOBS[command.action]
      if (command.action === 'move' || job) {
        const robotId = command.action === 'move' ? command.robotId : 'robot-3'
        const vehicle = extension.robots.find(value => value.id === robotId)!
        const target = command.action === 'move' ? command.destination : job!.node(command)
        const route = this.travel(state, extension, robotId, command.action === 'move' ? vehicle.node : target, target)
        vehicle.operationId = id; vehicle.segments = route.segments; vehicle.updatedTick = state.tick; vehicle.blockedEdge = null
        operation.nextTick = command.action === 'move' ? route.finishTick : route.pickupTick + job!.ticks
        operation.segments = route.segments
      }
      if (command.action === 'charge' || command.action === 'robot_sanitize') extension.robots.find(value => value.id === command.robotId)!.operationId = id
      acceptSystemCommand(this.context(state, extension, base), command)
      extension.operations.push(operation); this.save(extension); this.saveBase(base)
      this.event(state.tick, 'system-operation-accepted', z.json().parse(operation))
      return operation
    })
  }
  /** Persist a known no-effect refusal after platform registration. */
  refuseSystem(id: string, projectId: string, identity: string, input: Json, reason: LaboratoryRefusal) {
    const command = systemCommandSchema.parse(input)
    return this.update(state => {
      const extension = this.extension(), prior = extension.operations.find(operation => operation.id === id)
      if (prior) {
        if (prior.identity !== identity || prior.projectId !== projectId) throw new LaboratoryRefusal('identity', 'System operation identity differs')
        return prior
      }
      const operation: z.infer<typeof systemOperation> = { id, projectId, identity, command, acceptedTick: state.tick,
        nextTick: state.tick, completedTick: state.tick, state: 'failed', segments: [], result: null, detail: `${reason.code}: ${reason.message}` }
      extension.operations.push(operation); this.save(extension)
      this.event(state.tick, 'system-operation-refused', z.json().parse(operation))
      return operation
    })
  }

  /** Measured values published with laboratory results. */
  override artifactExtras(resultIds: string[]) {
    const measurements: Record<string, Json> = {}
    let raw: Record<string, Json> | null = null
    for (const id of resultIds) {
      const row = this.db.prepare('SELECT data FROM mars_measurements WHERE result_id=?').get(id) as { data: string } | undefined
      if (row) measurements[id] = JSON.parse(row.data)
      const rawRow = this.db.prepare('SELECT data FROM mars_raw WHERE key=?').get(id) as { data: string } | undefined
      if (rawRow) (raw ??= {})[id] = JSON.parse(rawRow.data)
    }
    return Object.keys(measurements).length ? { measurements, raw } : null
  }
  /** Raw data stored under a key (result ID or scan:operationId). */
  rawFor(key: string): Json | null {
    const row = this.db.prepare('SELECT data FROM mars_raw WHERE key=?').get(key) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }
  measurement(resultId: string): Json | null {
    const row = this.db.prepare('SELECT data FROM mars_measurements WHERE result_id=?').get(resultId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }
  /** Telemetry rows for channels within a tick range, downsampled to at most `limit` points per channel. */
  telemetry(channels: string[], fromTick: number, toTick: number, limit = 2000) {
    const result: Record<string, [number, number | null][]> = {}
    for (const channel of channels) {
      const rows = this.db.prepare('SELECT tick,value FROM mars_telemetry WHERE channel=? AND tick>=? AND tick<=? ORDER BY tick').all(channel, fromTick, toTick) as { tick: number; value: number | null }[]
      const stride = Math.max(1, Math.ceil(rows.length / limit))
      result[channel] = rows.filter((_, index) => index % stride === 0).map(row => [row.tick, row.value])
    }
    return result
  }
  telemetryChannels() { return (this.db.prepare('SELECT DISTINCT channel FROM mars_telemetry').all() as { channel: string }[]).map(row => row.channel).sort() }

  /** What Agents can observe: sensor readings (with any drift), never hidden truth. */
  sensors() {
    const state = this.observe(), extension = this.extension(), base = this.base(), tick = state.tick
    const light = (chamberId: string) => {
      const device = state.devices.find(value => value.id === chamberId)!
      return device.enabled && !device.broken && !device.shed ? extension.light[chamberId] ?? 70 : 0
    }
    const quality = waterQuality(this.truth, base, tick)
    return {
      tick, sol: Math.floor(tick / this.truth.solTicks), solPhase: Number(((tick % this.truth.solTicks) / this.truth.solTicks).toFixed(3)), horizon: this.horizon,
      chambers: CHAMBERS.map(id => ({ id, temperatureReading: Number((cropTemperature(state, light(id), id) + sensorOffset(this.truth, base, id, 'temperature', tick)).toFixed(2)),
        targetTemperature: state.devices.find(value => value.id === id)!.targetTemperature, light: light(id), lightSetting: extension.light[id] ?? 70,
        nutrient: extension.nutrient[id] ?? 1, co2: Number(base.atmosphere[id]!.co2.toFixed(0)), co2Setpoint: base.atmosphere[id]!.setpoint,
        pressure: Number(base.atmosphere[id]!.pressure.toFixed(2)), quarantine: base.atmosphere[id]!.quarantine })),
      crops: extension.crops.map(value => ({ id: value.id, chamberId: value.chamberId, variety: varietyOf(value.id), status: value.status, removed: value.removed,
        moistureReading: value.status === 'lost' ? null : Number((value.moisture + sensorOffset(this.truth, base, value.chamberId, 'moisture', tick)).toFixed(2)),
        irrigationLast100: value.irrigation.filter(([at]) => at > tick - 100).reduce((sum, [, volume]) => sum + volume, 0), availableSampleUl: value.availableSampleUl })),
      water: { tankUl: state.facilities.waterUl, capacityUl: state.facilities.waterCapacityUl, reserveUl: base.water.reserve, irrigationSource: base.water.route,
        inlineDoc: Object.fromEntries(['reservoir', 'filter', 'pump'].map(id => [id, Number((quality[id as 'reservoir'] + inlineOffset(this.truth, base, id, tick)).toFixed(2))])) },
      energy: { solar: Number(base.energy.solar.toFixed(2)), demand: Number(base.energy.demand.toFixed(2)), batteryCharge: Number(base.energy.soc.toFixed(1)),
        batteryNameplate: 800, tauDust: Number(base.energy.tauDust.toFixed(2)), shed: base.energy.shed, priority: base.energy.priority,
        tierOneShedTicks: base.metrics.tierOneShedTicks, shedTicksByLoad: base.metrics.shedTicksByLoad },
      co2TankUnits: Number(base.co2Tank.toFixed(0)), spares: base.spares,
    }
  }
}
