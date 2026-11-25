/** Role-specific capabilities over the same laboratory, crop and robot transactions. */
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import { canonicalJson, type ExecutionProvider, type ProviderOperation, type ProviderObservation } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { openLaboratoryProvider } from '../greenhouse/laboratory/provider.ts'
import { laboratoryCommandSchema, type LaboratoryCommand } from '../greenhouse/laboratory/schema.ts'
import { MarsWorld, systemCommandSchema, type SystemCommand } from './world.ts'
import { LaboratoryRefusal } from '../greenhouse/laboratory/world.ts'

const roleActions: Record<string, string[]> = {
  water: ['transfer', 'aliquot', 'process', 'sample', 'move', 'charge', 'robot_sanitize'],
  greenhouse: ['transfer', 'aliquot', 'process', 'configure', 'sample', 'irrigate', 'light', 'nutrient', 'move', 'charge', 'co2', 'scan', 'crop_remove', 'quarantine', 'robot_sanitize'],
  facilities: ['transfer', 'repair', 'clean', 'calibrate', 'configure', 'refill', 'order', 'move', 'charge', 'water_route', 'power_priority', 'robot_sanitize',
    'panel_clean', 'seal_inspect', 'seal_repair', 'device_service', 'device_reference', 'sensor_calibrate'],
}

/** Validate capability and method selection independently of physical availability. */
export function validateMarsProviderCommand(providerId: string, command: LaboratoryCommand | SystemCommand) {
  if (!Object.hasOwn(roleActions, providerId)) throw new Error('Unknown physical provider. Use water, greenhouse, or facilities in a providerId step.')
  if (!roleActions[providerId]!.includes(command.action)) throw new Error('Action outside provider capability')
  if (command.action === 'sample' && (providerId === 'water') === command.sourceId.startsWith('crop-'))
    throw new Error('Source outside provider capability')
  const robot = command.action === 'transfer' ? command.deviceId : 'robotId' in command ? command.robotId : undefined
  if (robot === 'robot-3' && providerId !== 'facilities') throw new Error('Maintenance robot requires facilities capability')
  if (command.action === 'process') {
    const methods = providerId === 'water' ? ['screen', 'water-prepare', 'confirm', 'review'] : ['culture', 'image', 'separate', 'extract', 'confirm']
    if (!methods.includes(command.methodId)) throw new Error('Method outside provider capability')
  }
}

/** Resource locks for one system command; maintenance-robot jobs reserve robot-3 and their target. */
function resourcesOf(command: SystemCommand): string[] {
  switch (command.action) {
    case 'charge': case 'move': case 'robot_sanitize': return [`laboratory:device:${command.robotId}`]
    // v0.4: the water loop feeds every chamber and module at once; only the chamber or source itself is exclusive.
    // Volumes are still drawn from the shared tank when the operation settles.
    case 'sample': return [`mars:source:${command.sourceId}`]
    case 'irrigate': return [`laboratory:device:${command.chamberId}`]
    case 'nutrient': return [`laboratory:device:${command.chamberId}`, `mars:batch:${command.batchId}`]
    case 'light': case 'co2': case 'scan': case 'quarantine': return [`laboratory:device:${command.chamberId}`]
    case 'crop_remove': return [`mars:crop:${command.cropId}`]
    case 'water_route': return ['mars:water-route']
    case 'power_priority': return ['mars:power-priority']
    case 'panel_clean': return ['laboratory:device:robot-3', 'mars:solar-array']
    case 'seal_inspect': case 'seal_repair': return ['laboratory:device:robot-3', `mars:seal:${command.chamberId}`]
    case 'device_service': return ['laboratory:device:robot-3', `laboratory:device:${command.deviceId}`]
    case 'device_reference': case 'sensor_calibrate': return ['laboratory:device:robot-3', `mars:sensor:${command.targetId}`]
  }
}

/** Construct role Providers whose generic submissions enforce the same physical permissions.
 * @param world Owning physical database.
 * @param scenarioFile Installed laboratory configuration.
 * @param onChange Notify the event driver after admission.
 * @returns Capability providers and connection disposer.
 */
export function openMarsProviders(world: MarsWorld, scenarioFile: string, onChange: () => void) {
  const laboratory = openLaboratoryProvider({ id: 'laboratory', directory: world.directory, scenarioFile }, onChange, world)
  const identity = (operation: ProviderOperation) => canonicalJson({ projectId: operation.projectId, input: operation.input, artifactDirectory: operation.artifactDirectory })
  const observe = (operation: ProviderOperation): ProviderObservation => {
    const job = world.observeSystems().operations.find(value => value.id === operation.operationId)
    if (!job) return { state: 'not_found' }
    if (job.identity !== identity(operation)) throw new Error('System operation identity differs')
    if (job.state !== 'succeeded') return { state: job.state, progress: { nextTick: job.nextTick }, ...(job.detail ? { detail: job.detail } : {}) }
    mkdirSync(operation.artifactDirectory, { recursive: true, mode: 0o700 })
    const path = join(operation.artifactDirectory, 'result.json'), bytes = JSON.stringify(job, null, 2) + '\n'
    if (existsSync(path)) { if (readFileSync(path, 'utf8') !== bytes) throw new Error('Published system result changed') }
    else writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
    const raw = world.rawFor(`scan:${operation.operationId}`)
    if (raw) {
      const rawPath = join(operation.artifactDirectory, 'raw.json'), rawBytes = JSON.stringify(raw) + '\n'
      if (existsSync(rawPath)) { if (readFileSync(rawPath, 'utf8') !== rawBytes) throw new Error('Published raw data changed') }
      else writeFileSync(rawPath, rawBytes, { mode: 0o600, flag: 'wx' })
      return { state: 'succeeded', artifacts: [{ path: 'result.json', mediaType: 'application/json' }, { path: 'raw.json', mediaType: 'application/json' }] }
    }
    return { state: 'succeeded', artifacts: [{ path: 'result.json', mediaType: 'application/json' }] }
  }
  const providers: ExecutionProvider[] = Object.entries(roleActions).map(([capability, actions]) => ({
    describe: () => ({ ...laboratory.provider.describe(), id: capability, configuration: { scenarioHash: world.scenarioHash, capability, rules: z.json().parse(world.rules) },
      inputSchema: z.json().parse(z.toJSONSchema(z.union([laboratoryCommandSchema, systemCommandSchema]))),
      constraints: [...laboratory.provider.describe().constraints, `Allowed actions: ${actions.join(', ')}`] }),
    prepare: input => {
      const system = systemCommandSchema.safeParse(input)
      if (system.success) {
        const command = system.data
        validateMarsProviderCommand(capability, command)
        world.prepareSystem(input)
        const resources = resourcesOf(command)
        return { input, resources, budget: 0 }
      }
      const command = laboratoryCommandSchema.parse(input)
      validateMarsProviderCommand(capability, command)
      const prepared = laboratory.provider.prepare(input)
      if (command.action === 'repair') prepared.resources.push('laboratory:device:robot-3')
      return prepared
    },
    async submit(operation) {
      if (!systemCommandSchema.safeParse(operation.input).success) return laboratory.provider.submit(operation)
      mkdirSync(operation.artifactDirectory, { recursive: true, mode: 0o700 })
      world.bindDomain(realpathSync(dirname(operation.artifactDirectory)))
      try { world.submitSystem(operation.operationId, operation.projectId, identity(operation), operation.input) }
      catch (error) {
        if (!(error instanceof LaboratoryRefusal) || error.code === 'identity') throw error
        world.refuseSystem(operation.operationId, operation.projectId, identity(operation), operation.input, error)
      }
      onChange()
      return observe(operation)
    },
    async query(operation) { return systemCommandSchema.safeParse(operation.input).success ? observe(operation) : laboratory.provider.query(operation) },
    async cancel(operation) {
      if (!systemCommandSchema.safeParse(operation.input).success) return laboratory.provider.cancel(operation)
      return { disposition: 'unsupported', observation: observe(operation), detail: 'Observe the accepted short system cycle until settled' }
    },
  }))
  return { providers, close: laboratory.close }
}
