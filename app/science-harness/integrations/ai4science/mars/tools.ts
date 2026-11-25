/** Structured role tools reuse the same Provider admission and physical journals. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from './compat.ts'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext, Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { canonicalJson } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from './world.ts'
import { MarsRecords } from './records.ts'
import type { Refs } from './refs.ts'
import { TASK_IDS } from './deliverables.ts'

const robotTools = ['sample_transfer', 'robot_move', 'robot_charge', 'robot_sanitize']
export const physicalToolGroups = {
  water: ['water_sample', 'water_screen', 'water_prepare', 'water_confirm', 'sample_aliquot', ...robotTools],
  greenhouse: ['crop_sample', 'greenhouse_light', 'greenhouse_irrigate', 'greenhouse_nutrient', 'greenhouse_co2', 'greenhouse_scan', 'crop_remove', 'chamber_quarantine',
    'culture_batch', 'greenhouse_image', 'greenhouse_separate', 'greenhouse_extract', 'pathogen_confirm', 'sample_aliquot', ...robotTools],
  facilities: ['device_diagnose', 'device_clean', 'device_calibrate', 'device_repair', 'device_configure', 'device_service', 'device_reference', 'sensor_calibrate',
    'water_refill', 'water_route', 'power_priority', 'panel_clean', 'seal_inspect', 'seal_repair', 'supply_order', ...robotTools],
}
export const queryTools = ['mars_samples', 'mars_measurements', 'mars_history', 'robot_status']
const id = { type: 'string', required: true } as const, integer = { type: 'integer', required: true } as const, number = { type: 'number', required: true } as const

export interface PhysicalPlanTools {
  names(): string[]
  schema(name: string): Json
  compile(name: string, args: unknown, agent: Agent): { providerId: string; input: Json }
}

function actionArgument(spec: ValueSchemaSpec): z.ZodType {
  if (!('type' in spec)) throw new Error('Unsupported union in physical action arguments')
  switch (spec.type) {
    case 'string': return spec.enum ? z.enum(spec.enum) : z.string().trim().min(1)
    case 'integer': return z.number().int()
    case 'number': return z.number()
    case 'boolean': return z.boolean()
    case 'array': return z.array(spec.items ? actionArgument(spec.items) : z.json())
    case 'object': {
      const shape = actionArguments(spec.properties ?? {})
      return spec.additionalProperties ? z.object(shape).passthrough() : z.strictObject(shape)
    }
    case 'json': return z.json()
    case 'null': return z.null()
  }
}

function actionArguments(parameters: ParameterSchemaSpec) {
  return Object.fromEntries(Object.entries(parameters).map(([key, spec]) => {
    const schema = actionArgument(spec)
    return [key, spec.required ? schema : schema.optional()]
  }))
}

export interface PhysicalToolOptions {
  /** Robots one member may drive; the single agent drives all of them. */
  objectiveIds?: readonly string[]
  robotsFor?: (agent: Agent) => string[]
  /** Team role of an actor, so a busy-resource receipt can name who holds it. */
  roleOf?: (actorId: string) => string | undefined
  /** Version-specific public precision statement; omitted retains the legacy instrument wording. */
  referenceSpecification?: string
}

/** Register differentiated tools while retaining generic experiment execution semantics. */
export function installPhysicalTools(ctx: Context, engine: ExecutionEngine, world: MarsWorld,
  access: (agent: Agent, tool: string) => OperationContext, refs?: Refs, options: PhysicalToolOptions = {}) {
  const register = (name: string, description: string, parameters: ParameterSchemaSpec,
    execute: (args: Record<string, unknown>, grant: OperationContext, agent: Agent) => unknown | Promise<unknown>) => {
    ctx.tools.register(defineTool({ name, description, parameters,
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, execution) {
        if (!execution.agent) throw new Error('Native participant required')
        const request = z.record(z.string(), z.unknown()).parse(args)
        return z.json().parse(await execute(refs ? refs.resolveArgs(request) : request, access(execution.agent, name), execution.agent))
      } }))
  }
  /** Explain a busy resource: who holds it and when it is expected back, instead of a bare refusal. */
  const busy = (grant: OperationContext) => (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error)
    const resource = /^Resource busy: (.+)$/.exec(message)?.[1]
    if (!resource) throw error
    const holder = engine.list(grant).find(operation => operation.resources.includes(resource) && !['succeeded', 'failed', 'cancelled'].includes(operation.state))
    const system = holder ? world.observeSystems().operations.find(operation => operation.id === holder.id) : undefined
    const lab = holder ? world.observe().operations.find(operation => operation.id === holder.id) : undefined
    const role = holder ? options.roleOf?.(holder.actorId) : undefined
    const ref = holder ? refs?.shortOf(holder.id) ?? holder.id : null
    const until = system?.nextTick ?? null
    throw new Error(`Resource busy: ${resource}${holder ? ` (held by ${ref}${role ? ` of ${role}` : ''}, state ${holder.state}${until !== null ? `, expected free around tick ${until}` : lab ? ', a laboratory step in progress' : ''})` : ''}. Retry after it settles; do not resubmit at once.`)
  }
  const robotOf = (input: Json) => {
    const command = z.object({ action: z.string(), deviceId: z.string().optional(), robotId: z.string().optional() }).passthrough().safeParse(input)
    if (!command.success) return null
    const robot = command.data.action === 'transfer' ? command.data.deviceId : command.data.robotId
    return robot?.startsWith('robot-') ? robot : null
  }
  /** Scientific stages may name the mission task directly (e.g. W2); the runtime keeps one bound task per member and objective. */
  const boundTask = (grant: OperationContext, taskId: string) => {
    const records = new MarsRecords(engine, grant, () => world.observe().tick, options.objectiveIds)
    const authored = records.listTasks().find(task => task.id === taskId)
    if (authored || !(options.objectiveIds ?? TASK_IDS).includes(taskId as never)) return authored
    return records.listTasks().find(task => task.createdBy === grant.actorId && task.title === `${taskId} 科研处理` && task.objectiveIds.includes(taskId))
      ?? records.createTask(`bind-${taskId}`, { title: `${taskId} 科研处理`, objectiveIds: [taskId] })
  }
  const planActions = new Map<string, {
    schema: z.ZodType<Record<string, unknown>>
    command: (args: Record<string, unknown>, grant: OperationContext, agent: Agent) => { providerId: string; input: Json }
  }>()
  const action = (name: string, description: string, provider: string | null | ((grant: OperationContext) => string), parameters: ParameterSchemaSpec,
    command: (args: Record<string, unknown>) => Json, scientific = false) => {
    const prepare = (args: Record<string, unknown>, grant: OperationContext, agent: Agent) => {
      const providerId = typeof provider === 'function' ? provider(grant) : provider ?? grant.allowedProviders[0]!
      const input = command(args)
      const robot = robotOf(input), allowed = options.robotsFor?.(agent)
      if (robot && allowed && !allowed.includes(robot)) throw new Error(`${robot} is not yours to drive; your robots: ${allowed.join(', ') || 'none'}. Ask its owner with mars_message.`)
      return { providerId, input }
    }
    planActions.set(name, { schema: z.strictObject(actionArguments(parameters)), command: prepare })
    register(name, description, { request_key: id, ...(scientific ? { task_id: id } : {}), ...parameters }, async (args, grant, agent) => {
      const { providerId, input } = prepare(args, grant, agent)
      const requestKey = String(args.request_key)
      if (!scientific) return await engine.submit(grant, { providerId, requestKey, input }).catch(busy(grant))
      const taskId = String(args.task_id)
      const previous = engine.readFacts(grant).filter(fact => fact.kind === 'mars-stage-binding' && fact.actorId === grant.actorId)
        .map(fact => z.object({ requestKey: z.string(), taskId: z.string(), providerId: z.string(), input: z.json(), experimentId: z.string() }).parse(fact.data))
        .find(binding => binding.requestKey === requestKey)
      if (previous && (previous.taskId !== taskId || previous.providerId !== providerId || canonicalJson(previous.input) !== canonicalJson(input))) throw new Error('Scientific stage request key changed')
      let experimentId = previous?.experimentId
      if (!experimentId) {
        const task = boundTask(grant, taskId)
        if (!task || !task.objectiveIds.length || ['completed', 'cancelled', 'failed'].includes(task.state)) throw new Error('Scientific processing needs task_id: a mission task ID (e.g. W1, G2, D1) or an active task you created')
        const method = z.object({ methodId: z.string(), methodVersion: z.number() }).parse(input)
        const experiment = engine.experiments.create(grant, `stage/${grant.actorId}/${requestKey}`, {
          goal: task.title, method: { id: method.methodId, version: String(method.methodVersion) },
          context: { taskId: task.id, taskRevision: task.revision, objectiveIds: task.objectiveIds }, inputArtifactIds: [],
          outputRequirements: 'Return actual physical output and integrity-checked result artifacts for the authored task.',
          budget: null, maxOperations: null, actions: [{ id: 'perform', providerId, input, minUses: 1, maxUses: null }],
        })
        experimentId = experiment.id
        engine.recordFact(grant, 'mars-stage-binding', { requestKey, taskId, providerId, input, experimentId })
      }
      if (!engine.experiments.get(grant, experimentId).controllerActive)
        engine.experiments.claim(grant, experimentId, 'Continue the persisted scientific stage with the current native participant')
      try {
        return await engine.experiments.submit(grant, experimentId, { requestKey, actionId: 'perform',
          rationale: `Execute the scientific stage for task ${taskId}`, evidenceOperationIds: [], evidenceArtifactIds: [] })
      } catch (error) { return busy(grant)(error) }
    })
  }
  const sample = (name: string, provider: string) => action(name, 'Collect material from an actual source (water module or crop) and preserve source and condition records.', provider,
    { source_id: id, volume_ul: integer, container: { type: 'string', enum: ['tube', 'vial'], required: true } },
    args => ({ action: 'sample', sourceId: String(args.source_id), volumeUl: Number(args.volume_ul), container: String(args.container) }))
  sample('water_sample', 'water'); sample('crop_sample', 'greenhouse')
  const supplies = { type: 'array', items: { type: 'object', additionalProperties: false, properties: { batchId: id, units: integer } } } as const
  for (const [name, method, provider] of [
    ['water_screen', 'screen', 'water'], ['water_prepare', 'water-prepare', 'water'], ['water_confirm', 'confirm', 'water'],
    ['culture_batch', 'culture', 'greenhouse'], ['greenhouse_image', 'image', 'greenhouse'], ['greenhouse_separate', 'separate', 'greenhouse'],
    ['greenhouse_extract', 'extract', 'greenhouse'], ['pathogen_confirm', 'confirm', 'greenhouse'],
  ]) action(name!, `Perform ${method} with the current method version. Volume applies to each sample; per-batch consumables are listed in mars_catalog methods.`, provider!,
    { device_id: id, sample_id: id, volume_ul: integer, method_version: integer, additional_sample_ids: { type: 'array', items: { type: 'string' } }, consumables: supplies }, args => z.json().parse({
      action: 'process', methodId: method, deviceId: args.device_id, sampleId: args.sample_id, volumeUl: args.volume_ul, methodVersion: args.method_version,
      ...(args.additional_sample_ids === undefined ? {} : { additionalSampleIds: args.additional_sample_ids }),
      ...(args.consumables === undefined ? {} : { consumables: args.consumables }),
    }), true)
  const robotProvider = (grant: OperationContext) => grant.allowedProviders.includes('facilities') ? 'facilities' : grant.allowedProviders[0]!
  action('sample_transfer', 'Reserve a robot and route, collect one or more samples at the same location and deliver them. R1 carries 6, R2 (4°C box) 2.', robotProvider,
    { robot_id: id, sample_id: id, destination: id, additional_sample_ids: { type: 'array', items: { type: 'string' } } },
    args => z.json().parse({ action: 'transfer', deviceId: args.robot_id, sampleId: args.sample_id, destination: args.destination, ...(args.additional_sample_ids === undefined ? {} : { additionalSampleIds: args.additional_sample_ids }) }))
  action('sample_aliquot', 'Split material at the delivered liquid handler. Consumed volume is retained after failure.', null,
    { device_id: id, sample_id: id, volume_ul: integer, container: id }, args => ({ action: 'aliquot', deviceId: String(args.device_id), sampleId: String(args.sample_id), volumeUl: Number(args.volume_ul), container: String(args.container) }))
  for (const [name, command, note] of [['device_clean', 'clean', ''], ['device_calibrate', 'calibrate', ''], ['device_repair', 'repair', ' Consumes the matching spare part; R3 must reach the device.']])
    action(name!, `Execute physical ${command}.${note}`, 'facilities', { device_id: id }, args => ({ action: command!, deviceId: String(args.device_id) }))
  action('device_configure', 'Enable/disable a device or set its target temperature; actual temperature follows over logical time.', 'facilities',
    { device_id: id, enabled: { type: 'boolean', required: true }, temperature: { type: 'number' } }, args => z.json().parse({ action: 'configure', deviceId: args.device_id, enabled: args.enabled,
      ...(args.temperature === undefined ? {} : { targetTemperature: args.temperature }) }))
  action('greenhouse_light', 'Set chamber light (0-100). Raises chamber temperature above 70 and changes power draw.', 'greenhouse',
    { chamber_id: id, level: number }, args => ({ action: 'light', chamberId: String(args.chamber_id), level: Number(args.level) }))
  action('greenhouse_irrigate', 'Irrigate one crop or a whole chamber (split evenly) from the current water source.', 'greenhouse',
    { chamber_id: id, volume_ul: integer, crop_id: { type: 'string' } }, args => z.json().parse({ action: 'irrigate', chamberId: args.chamber_id, volumeUl: args.volume_ul, ...(args.crop_id === undefined ? {} : { cropId: args.crop_id }) }))
  action('greenhouse_nutrient', 'Set chamber nutrient level 1, 2 or 3; consumes two units of a medium batch.', 'greenhouse',
    { chamber_id: id, level: integer, batch_id: id }, args => ({ action: 'nutrient', chamberId: String(args.chamber_id), level: Number(args.level), batchId: String(args.batch_id) }))
  action('greenhouse_co2', 'Set chamber CO2 setpoint (400-1500 ppm); supply draws on the shared CO2 tank.', 'greenhouse',
    { chamber_id: id, setpoint: number }, args => ({ action: 'co2', chamberId: String(args.chamber_id), setpoint: Number(args.setpoint) }))
  action('greenhouse_scan', 'In-chamber hyperspectral scan (2 ticks): noisy, light-biased growth index per crop plus an 8x8x8 cube per crop in raw.json.', 'greenhouse',
    { chamber_id: id }, args => ({ action: 'scan', chamberId: String(args.chamber_id) }))
  action('crop_remove', 'Remove a crop permanently (it counts as lost) to stop disease spread.', 'greenhouse', { crop_id: id }, args => ({ action: 'crop_remove', cropId: String(args.crop_id) }))
  action('chamber_quarantine', 'Isolate a chamber from the shared irrigation loop (halves in-chamber spread, blocks neighbour spread; chamber needs per-crop irrigation).', 'greenhouse',
    { chamber_id: id, enabled: { type: 'boolean', required: true } }, args => ({ action: 'quarantine', chamberId: String(args.chamber_id), enabled: Boolean(args.enabled) }))
  action('water_refill', 'Move clean water from the non-renewable 800 uL reserve tank into the main tank.', 'facilities',
    { device_id: id, volume_ul: integer }, args => ({ action: 'refill', deviceId: String(args.device_id), volumeUl: Number(args.volume_ul) }))
  action('water_route', 'Choose the irrigation source: main (recycled loop) or reserve (clean, non-renewable).', 'facilities',
    { target: { type: 'string', enum: ['main', 'reserve'], required: true } }, args => ({ action: 'water_route', target: String(args.target) }))
  action('power_priority', 'Reorder load shedding: listed loads are shed FIRST when demand exceeds supply; unlisted keep their current order after them.', 'facilities',
    { order: { type: 'array', items: { type: 'string' }, required: true } }, args => ({ action: 'power_priority', order: z.array(z.string()).parse(args.order) }))
  action('panel_clean', 'R3 cleans the solar array (10 ticks on site).', 'facilities', {}, () => ({ action: 'panel_clean' }))
  action('seal_inspect', 'R3 inspects one chamber seal point (door, duct or panel).', 'facilities', { chamber_id: id, point: { type: 'string', enum: ['door', 'duct', 'panel'], required: true } },
    args => ({ action: 'seal_inspect', chamberId: String(args.chamber_id), point: String(args.point) }))
  action('seal_repair', 'R3 reseals one chamber point using one sealant from stores.', 'facilities', { chamber_id: id, point: { type: 'string', enum: ['door', 'duct', 'panel'], required: true } },
    args => ({ action: 'seal_repair', chamberId: String(args.chamber_id), point: String(args.point) }))
  action('device_service', 'Preventive maintenance by R3: consumes the matching spare and resets wear.', 'facilities', { device_id: id }, args => ({ action: 'device_service', deviceId: String(args.device_id) }))
  action('device_reference', options.referenceSpecification ?? 'R3 takes an independent reference measurement at a chamber (true temperature, crop moisture, CO2, pressure) or water module (inline DOC).', 'facilities',
    { target_id: id }, args => ({ action: 'device_reference', targetId: String(args.target_id) }))
  action('sensor_calibrate', 'R3 recalibrates a chamber temperature/moisture sensor or a water module doc_inline sensor.', 'facilities',
    { target_id: id, channel: { type: 'string', enum: ['temperature', 'moisture', 'doc_inline'], required: true } }, args => ({ action: 'sensor_calibrate', targetId: String(args.target_id), channel: String(args.channel) }))
  action('supply_order', 'Use the single resupply shuttle slot: one order of a catalog kind (30 units, arrives after 120 ticks).', 'facilities',
    { device_id: id, kind: id }, args => ({ action: 'order', deviceId: String(args.device_id), kind: String(args.kind) }))
  action('robot_move', 'Move an idle robot along an available route, including return to its home dock.', robotProvider,
    { robot_id: id, destination: id }, args => ({ action: 'move', robotId: String(args.robot_id), destination: String(args.destination) }))
  action('robot_charge', 'Charge an idle robot at its home dock.', robotProvider, { robot_id: id }, args => ({ action: 'charge', robotId: String(args.robot_id) }))
  action('robot_sanitize', 'Sanitize an idle robot (6 ticks) so it cannot carry pathogen between chambers.', robotProvider, { robot_id: id }, args => ({ action: 'robot_sanitize', robotId: String(args.robot_id) }))
  register('device_diagnose', 'Read observed device state and its recent failed operations.', { device_id: id }, args => {
    const state = world.observe(), device = state.devices.find(value => value.id === args.device_id)
    if (!device) throw new Error('Unknown device')
    const { temperature: _hidden, ...visible } = device
    return { device: device.kind === 'incubator' ? visible : device, failures: state.operations.filter(value => value.command.deviceId === device.id && value.state === 'failed').slice(-20) }
  })
  register('robot_status', 'Read robot positions, cargo, energy and accepted trajectories.', {}, () => ({ robots: world.observeSystems().robots,
    cargo: world.observe().samples.filter(sample => sample.location.startsWith('robot-') && sample.volumeUl > 0).map(sample => ({ id: sample.id, location: sample.location })), rules: world.rules }))
  const page = { offset: { type: 'integer' }, limit: { type: 'integer' } } as const
  const slice = <T>(values: T[], args: Record<string, unknown>) => {
    const offset = z.number().int().nonnegative().parse(args.offset ?? 0), limit = z.number().int().min(1).max(200).parse(args.limit ?? 50)
    return { total: values.length, offset, limit, items: values.slice(offset, offset + limit) }
  }
  register('mars_samples', 'Query actual samples by location or ID, with paging.', { ...page, location: { type: 'string' }, sample_id: { type: 'string' } }, args =>
    slice(world.observe().samples.filter(sample => (!args.location || sample.location === args.location) && (!args.sample_id || sample.id === args.sample_id)), args))
  register('mars_measurements', 'Query measurement records with their published values (not raw data), by root sample or method.',
    { ...page, root_sample_id: { type: 'string' }, method_id: { type: 'string' } }, args => {
      const page = slice(world.observe().results.filter(result => (!args.root_sample_id || result.rootSampleId === args.root_sample_id) && (!args.method_id || result.methodId === args.method_id)), args)
      return { ...page, items: page.items.map(result => ({ ...result, measurement: world.measurement(result.id) })), revocations: world.observe().revocations }
    })
  register('mars_history', 'Query committed physical events by cursor, event kind or object identifier.',
    { ...page, after_seq: { type: 'integer' }, kind: { type: 'string' }, entity_id: { type: 'string' } }, args => {
      const after = z.number().int().nonnegative().parse(args.after_seq ?? 0)
      return slice(world.events(after).filter(event => (!args.kind || event.kind === args.kind) && (!args.entity_id || JSON.stringify(event.payload).includes(String(args.entity_id)))), args)
    })

  const getPlanAction = (name: string) => {
    const action = planActions.get(name)
    if (!action) throw new Error(`Unknown plan tool: ${name}. See research_catalog with contract=experiment_plan for supported tools.`)
    return action
  }
  const physicalPlanTools: PhysicalPlanTools = {
    names: () => [...planActions.keys()],
    schema: name => z.json().parse(z.toJSONSchema(getPlanAction(name).schema, { io: 'input' })),
    compile: (name, raw, agent) => {
      const action = getPlanAction(name)
      const args = action.schema.parse(raw)
      const operation = action.command(args, access(agent, name), agent)
      return { ...operation, input: refs ? refs.resolveArgs(operation.input) : operation.input }
    },
  }
  return physicalPlanTools
}
