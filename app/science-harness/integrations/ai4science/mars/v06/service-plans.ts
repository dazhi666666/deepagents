/** Read-only checks for a declared service's physical sample lineage and time bounds. */
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { laboratorySampleIds } from '../../greenhouse/laboratory/commands.ts'
import { laboratoryCommandSchema } from '../../greenhouse/laboratory/schema.ts'
import { validateProcessSupplies } from '../../greenhouse/laboratory/world.ts'
import { parsePlanOutputReference, type PlanDraft } from '../v05/planning.ts'
import { systemCommandSchema, type MarsWorld } from '../world.ts'
import { ROBOT_JOBS, SHORT_TICKS } from '../world-system.ts'
import type { Commission } from './cases.ts'

type ServicePlanningWorld = Pick<MarsWorld, 'observe' | 'observeSystems' | 'rules'> & {
  scenario: Pick<MarsWorld['scenario'], 'loadingTicks' | 'handlingTicks' | 'maintenanceTicks' | 'calibrationLifetimeTicks'>
}

interface SampleProjection {
  motherId: string
  volumeUl: number
  state: string
  container: string
  location: string
}
interface MotherSample {
  sample: SampleProjection
  sourceId: string | undefined
  expiresAt: number
  drawStepId: string | null
}

/** Inspect one declared service using only the public inventory and planned steps. */
export function inspectServicePlan(world: ServicePlanningWorld, commissions: readonly Commission[], plan: PlanDraft, resolve: (input: Json) => Json) {
  const service = plan.service
  if (!service) throw new Error('Supply a service binding')
  const commission = commissions.find(item => item.id === service.commissionId)
  if (!commission) throw new Error(`Unknown service commission: ${service.commissionId}. See research_catalog section=services.`)
  const lab = world.observe()
  const devices = new Map(lab.devices.map(device => [device.id, device]))
  const methods = new Map(lab.methods.map(method => [method.id, method]))
  const systems = world.observeSystems()
  const sources = systems.sampleSources
  const steps = new Map(plan.steps.map(step => {
    const input = resolve(step.input)
    const system = systemCommandSchema.safeParse(input)
    return [step.id, { step, command: system.success ? system.data : laboratoryCommandSchema.parse(input) }] as const
  }))
  const measurement = steps.get(service.measurementStepId)
  if (measurement?.command.action !== 'process' || !commission.methods.includes(measurement.command.methodId))
    throw new Error(`Step ${service.measurementStepId}: choose a measurement with an allowed method for ${commission.id}`)
  const retention = steps.get(service.retentionStepId)
  if (retention?.command.action !== 'transfer') throw new Error(`Step ${service.retentionStepId}: schedule transfer of the original mother sample to storage`)

  const dependsOn = new Map<string, Set<string>>()
  const ends = new Map<string, number>()
  const starts = new Map<string, number>()
  const order: string[] = []
  const visit = (id: string): number => {
    const cached = ends.get(id)
    if (cached !== undefined) return cached
    const { step, command } = steps.get(id)!
    const start = Math.max(lab.tick, step.at, ...step.dependsOn.map(visit))
    const ancestors = new Set(step.dependsOn.flatMap(dep => [dep, ...dependsOn.get(dep)!]))
    let duration = 0
    switch (command.action) {
      case 'sample': duration = world.rules.sampleTicks; break
      case 'charge': duration = world.rules.chargeTicks; break
      case 'transfer': case 'aliquot': duration = world.scenario.loadingTicks + world.scenario.handlingTicks; break
      case 'process': duration = world.scenario.loadingTicks + (methods.get(command.methodId)?.processingTicks ?? 0); break
      case 'clean': case 'calibrate': case 'repair': case 'configure': case 'order': case 'refill':
        duration = world.scenario.loadingTicks + world.scenario.maintenanceTicks; break
      default: duration = ROBOT_JOBS[command.action]?.ticks ?? SHORT_TICKS[command.action] ?? 0
    }
    const finish = start + duration
    starts.set(id, start)
    ends.set(id, finish)
    dependsOn.set(id, ancestors)
    order.push(id)
    return finish
  }
  for (const step of plan.steps) visit(step.id)

  const outputs = new Map<string, SampleProjection[]>()
  const observed = new Map(lab.samples.map(sample => [sample.id, sample]))
  const samples = new Map<string, SampleProjection>()
  const mothers = new Map<string, MotherSample>()
  const makeMother = (motherId: string, sample: Omit<SampleProjection, 'motherId'>, sourceId: string | undefined,
    expiresAt: number, drawStepId: string | null) => {
    const projection = { ...sample, motherId }
    mothers.set(motherId, { sample: projection, sourceId, expiresAt, drawStepId })
    return projection
  }
  const resolveSample = (ref: string): SampleProjection | undefined => {
    const link = parsePlanOutputReference(ref)
    if (link) {
      if (link.field === 'outputSampleId') return outputs.get(link.stepId)?.[0]
      if (/^outputSampleIds\.\d+$/.test(link.field)) return outputs.get(link.stepId)?.[Number(link.field.split('.')[1])]
      return undefined
    }
    const cached = samples.get(ref)
    if (cached) return cached
    const sample = observed.get(ref)
    if (!sample) return undefined
    const spec = { volumeUl: sample.volumeUl, container: sample.container, state: sample.state, location: sample.location }
    const parent = sample.parentId ? resolveSample(sample.parentId) : undefined
    const projected = parent ? { ...spec, motherId: parent.motherId } : makeMother(ref, spec, sources[ref], sample.expiresAt, null)
    samples.set(ref, projected)
    return projected
  }
  const warnings: string[] = []
  const inventory = { ...lab, batches: lab.batches.map(batch => ({ ...batch })) }
  const moved = new Map<SampleProjection, { stepId: string; destination: string }[]>()
  const consumed = new Map<SampleProjection, number>()
  const stepInputs = new Map<string, SampleProjection[]>()
  for (const id of order) {
    const { command } = steps.get(id)!
    if (command.action === 'sample') {
      const location = systems.crops.find(crop => crop.id === command.sourceId)?.chamberId ?? command.sourceId
      const sample = makeMother(`$step:${id}:outputSampleId`, { volumeUl: command.volumeUl, container: command.container,
        state: 'raw', location }, command.sourceId, ends.get(id)! + world.rules.sampleLifetimeTicks, id)
      outputs.set(id, [sample])
      continue
    }
    if (command.action !== 'transfer' && command.action !== 'aliquot' && command.action !== 'process') continue
    const inputs = laboratorySampleIds(command).map(ref => {
      const sample = resolveSample(ref)
      if (!sample) throw new Error(`Step ${id}: ${ref} does not identify a sample output`)
      return sample
    })
    if (new Set(inputs).size !== inputs.length) throw new Error(`Step ${id}: use distinct samples in a batch`)
    stepInputs.set(id, inputs)
    const device = devices.get(command.deviceId)!
    const move = command.action === 'transfer'
    const destination = move ? devices.get(command.destination)! : device
    const ancestors = dependsOn.get(id)!
    const inputLocations = inputs.map(sample => moved.get(sample)?.findLast(transfer => ancestors.has(transfer.stepId))?.destination ?? sample.location)
    if (move && new Set(inputLocations).size !== 1) throw new Error(`Step ${id}: transported samples must share a pickup location named by the dependencies`)
    if (!move && inputLocations.some(location => location !== device.id))
      throw new Error(`Step ${id}: transport the input to ${device.id} and declare the transport as a dependency`)
    if (inputs.some(sample => !device.containers.includes(sample.container) || !destination.containers.includes(sample.container)))
      throw new Error(`Step ${id}: an input container is incompatible with ${device.id} or ${destination.id}`)
    if (move) {
      for (const sample of inputs) moved.set(sample, [...(moved.get(sample) ?? []), { stepId: id, destination: destination.id }])
      outputs.set(id, [inputs[0]!])
      continue
    }
    const method = command.action === 'process' ? methods.get(command.methodId) : undefined
    if (command.action === 'process' && method) {
      if (inputs.some(sample => sample.state !== method.inputState))
        throw new Error(`Step ${id}: ${method.id} needs input in ${method.inputState} state`)
      const chain = order.filter(predecessor => ancestors.has(predecessor)).map(key => ({ key, command: steps.get(key)!.command }))
      const lastSurfaceStep = chain.findLast(({ command: earlier }) => 'deviceId' in earlier && earlier.deviceId === device.id
        && (earlier.action === 'clean' || earlier.action === 'process' && methods.get(earlier.methodId)?.dirtiesDevice))
      if (lastSurfaceStep ? lastSurfaceStep.command.action === 'process' : device.dirty)
        warnings.push(`Step ${id}: ${device.id} needs a cleaning dependency before processing`)
      const calibration = chain.findLast(({ command: earlier }) => earlier.action === 'calibrate' && earlier.deviceId === device.id)
      const calibratedUntil = calibration ? ends.get(calibration.key)! + world.scenario.calibrationLifetimeTicks : device.calibratedUntil ?? -1
      if (method.requiresCalibration && calibratedUntil < ends.get(id)!)
        warnings.push(`Step ${id}: plan a calibration for ${device.id} that lasts through measurement`)
      try {
        validateProcessSupplies(inventory, command, method, starts.get(id)! + world.scenario.loadingTicks)
      } catch (error) {
        throw new Error(`Step ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      for (const supply of command.consumables ?? []) inventory.batches.find(batch => batch.id === supply.batchId)!.units -= supply.units
    }
    for (const sample of inputs) {
      const amount = (consumed.get(sample) ?? 0) + command.volumeUl
      if (amount > sample.volumeUl) throw new Error(`Step ${id}: planned ${amount} µL exceeds the sample's ${sample.volumeUl} µL`)
      consumed.set(sample, amount)
    }
    outputs.set(id, inputs.map(sample => ({ motherId: sample.motherId, volumeUl: command.volumeUl, location: device.id,
      state: method?.outputState ?? sample.state, container: command.action === 'aliquot' ? command.container : sample.container })))
  }

  const measured = stepInputs.get(measurement.step.id)!
  const retained = stepInputs.get(retention.step.id)!
  const root = measured.map(sample => mothers.get(sample.motherId)!).find(mother =>
    mother.sourceId === commission.sourceId && retained.includes(mother.sample))
  if (!root || root.sample.state !== 'raw')
    throw new Error(`Step ${retention.step.id}: retain the original raw mother sample of the ${commission.sourceId} measurement in step ${measurement.step.id}`)
  const remainingUl = root.sample.volumeUl - (consumed.get(root.sample) ?? 0)
  if (remainingUl < commission.minimumRemainingUl)
    throw new Error(`Step ${retention.step.id}: plan leaves ${remainingUl} µL of mother sample, below ${commission.minimumRemainingUl} µL required`)
  const { drawStepId } = root
  if (!drawStepId && root.expiresAt < commission.preserveUntil)
    throw new Error(`Step ${retention.step.id}: mother sample expires at tick ${root.expiresAt} before required tick ${commission.preserveUntil}`)
  const measurementFinish = ends.get(measurement.step.id)!
  const retentionFinish = ends.get(retention.step.id)!
  const storage = devices.get(retention.command.destination)!
  if (storage.kind !== 'cold-store' && storage.kind !== 'freezer') warnings.push(`Step ${retention.step.id}: use controlled storage and check the sample's preservation evidence`)
  if (measurementFinish > commission.deadline) warnings.push(`Step ${measurement.step.id}: earliest completion tick ${measurementFinish} exceeds the measurement deadline ${commission.deadline}`)
  if (retentionFinish > commission.preserveUntil) warnings.push(`Step ${retention.step.id}: earliest completion tick ${retentionFinish} exceeds the retention check at tick ${commission.preserveUntil}`)
  if (drawStepId && root.expiresAt < commission.preserveUntil) warnings.push(`Step ${drawStepId}: an early draw could expire at tick ${root.expiresAt}; schedule collection at or after tick ${commission.preserveUntil - world.rules.sampleLifetimeTicks - world.rules.sampleTicks}`)
  const firstStartTick = Math.min(...starts.values())
  return { commissionId: commission.id, sourceId: commission.sourceId, drawStepId, measurementStepId: measurement.step.id, retentionStepId: retention.step.id,
    minimumRemainingUl: commission.minimumRemainingUl, remainingUl, firstStartTick, earliestMeasurementCompletionTick: measurementFinish,
    earliestRetentionCompletionTick: retentionFinish, earliestMotherExpiryTick: root.expiresAt, deadlineTick: commission.deadline, preserveUntil: commission.preserveUntil,
    timing: 'Lower bounds before route and resource waits. Preservation quality is evaluated using the actual storage history.', warnings }
}
