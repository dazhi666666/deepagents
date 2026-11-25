import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { validateCarrierCapacity, type MarsWorld } from '../world.ts'
import { systemCommandSchema } from '../world-system.ts'
import { laboratoryCommandSchema } from '../../greenhouse/laboratory/schema.ts'
import { laboratorySampleIds } from '../../greenhouse/laboratory/commands.ts'
import { V05Planning, PlanAdmissionError, planInputSchema, planStepSchema, type Plan } from './planning.ts'
import { LaboratoryRefusal, validateProcessSupplies } from '../../greenhouse/laboratory/world.ts'
import type { PhysicalPlanTools } from '../tools.ts'
import { validateMarsProviderCommand } from '../providers.ts'
import type { Commission } from '../v06/cases.ts'
import { inspectServicePlan } from '../v06/service-plans.ts'
import { inspectServicePortfolio, type ServiceReceipt } from '../v06/service-portfolio.ts'

const portfolioRequest = z.object({ planIds: z.array(z.string().min(1)).max(32).optional(),
  drafts: z.array(z.record(z.string(), z.json())).max(8).default([]) }).strict()

export const V05_PLAN_TOOLS = ['experiment_plan', 'resource_reservation']
const toolPlanStepSchema = planStepSchema.omit({ providerId: true, input: true }).extend({
  tool: z.string().trim().min(1), args: z.record(z.string(), z.json()).default({}),
})
const planEnvelopeSchema = planInputSchema.extend({ steps: z.array(z.record(z.string(), z.json())).min(1) })
const planContractSchema = planInputSchema.extend({ steps: z.array(z.union([toolPlanStepSchema, planStepSchema])).min(1) })

/** Expose the accepted plan layout and the exact argument schema for a physical tool. */
export function publicPlanContract(physical: PhysicalPlanTools, tool?: string) {
  return { ...z.toJSONSchema(planContractSchema, { io: 'input' }),
    'x-mars-call': { tool: 'experiment_plan', requiredByAction: { check: ['input_json'], schedule: ['input_json', 'request_key'],
      amend: ['input_json', 'request_key', 'id', 'revision'], cancel: ['request_key', 'id', 'revision'], list: [], portfolio: [] },
      optionalForCheck: { deadline_tick: 'Inclusive completion deadline. The check reports timing bounds, current locks and reservation conflicts.' } },
    'x-mars-service': {
      binding: 'Set service={commissionId,measurementStepId,retentionStepId} in input_json. The measurement must use the retained original mother sample or a descendant of it.',
      start: 'Schedule, read the plan ID in round_receipts, then lock prediction_commit with taskId=T3 and the matching commissionId. The host holds the first operation until a commitment matches the plan specification.',
      diagnostics: 'check returns mother volume and lifetime. action=portfolio projects shared equipment, dock energy, cleaning, sample positions, deadline slack and actual operation IDs. Optional input_json={drafts:[plans],planIds:[saved IDs]}. Defaults to active service plans.',
    },
    'x-mars-step-tools': physical.names(),
    ...(tool === undefined ? {} : { 'x-mars-step': { tool, argsSchema: physical.schema(tool) } }),
    'x-mars-example': { title: 'Schedule a chamber scan', steps: [
      { id: 'scan', tool: 'greenhouse_scan', args: { chamber_id: 'incubator-1' }, at: 0 },
    ] },
  }
}

function inputProblem(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue =>
    `${issue.path.map(String).join('.') || 'input_json'}: ${issue.message}`).join('; ')
  return error instanceof Error ? error.message : String(error)
}
/** Same public resource identities as the native providers, without performing admission. */
export function planResources(_providerId: string, input: Json): { resource: string; quantity: number }[] {
  if (!['water', 'greenhouse', 'facilities'].includes(_providerId)) throw new Error('Unknown physical provider. Use water, greenhouse, or facilities in a providerId step.')
  if (!systemCommandSchema.safeParse(input).success) laboratoryCommandSchema.parse(input)
  const c = z.record(z.string(), z.unknown()).parse(input), action = String(c.action)
  let ids: string[]
  if (['charge', 'move', 'robot_sanitize'].includes(action)) ids = [`laboratory:device:${String(c.robotId)}`]
  else if (action === 'sample' && c.sourceId) ids = [`mars:source:${String(c.sourceId)}`]
  else if (['irrigate', 'light', 'co2', 'scan', 'quarantine'].includes(action)) ids = [`laboratory:device:${String(c.chamberId)}`]
  else if (action === 'nutrient') ids = [`laboratory:device:${String(c.chamberId)}`, `mars:batch:${String(c.batchId)}`]
  else if (action === 'crop_remove') ids = [`mars:crop:${String(c.cropId)}`]
  else if (action === 'water_route') ids = ['mars:water-route']
  else if (action === 'power_priority') ids = ['mars:power-priority']
  else if (action === 'panel_clean') ids = ['laboratory:device:robot-3', 'mars:solar-array']
  else if (['seal_inspect', 'seal_repair'].includes(action)) ids = ['laboratory:device:robot-3', `mars:seal:${String(c.chamberId)}`]
  else if (['device_reference', 'sensor_calibrate'].includes(action)) ids = ['laboratory:device:robot-3', `mars:sensor:${String(c.targetId)}`]
  else if (action === 'device_service') ids = ['laboratory:device:robot-3', `laboratory:device:${String(c.deviceId)}`]
  else if (c.deviceId) ids = [`laboratory:device:${String(c.deviceId)}`, ...(c.sampleId ? [`laboratory:sample:${String(c.sampleId)}`] : []),
    ...(Array.isArray(c.additionalSampleIds) ? c.additionalSampleIds.map(id => `laboratory:sample:${String(id)}`) : []), ...(action === 'repair' ? ['laboratory:device:robot-3'] : [])]
  else throw new Error('Unknown public operation resource identity')
  return [...new Set(ids)].sort().map(resource => ({ resource, quantity: 1 }))
}
type Register = (name: string, description: string, parameters: ParameterSchemaSpec,
  body: (args: Record<string, unknown>, agent: Agent, signal: AbortSignal) => unknown | Promise<unknown>) => void
export function installPlanningTools(context: { register: Register; engine: ExecutionEngine; world: MarsWorld;
  access: (agent: Agent, tool: string) => OperationContext; namespace?: 'v05' | 'v06';
  mayDispatch?: (plan: Plan) => boolean; admissionOpen?: () => boolean; actorKey?: (id: string) => string; currentTick?: () => number;
  observeOperation?: ExecutionEngine['query']; resolveArgs?: (input: Json) => Json; physicalPlanTools?: PhysicalPlanTools;
  servicePlans?: { commissions: readonly Commission[]; isCommitted(plan: Plan): boolean; receipts?(plan: Plan): ServiceReceipt[] };
  onPlanBlocked?: (change: { planId: string; actorId: string; stepId: string; reason: string; terminal: boolean }) => void }) {
  const { engine, world, register, access, servicePlans } = context
  const namespace = context.namespace ?? 'v05'
  const queryOperation = context.observeOperation ?? engine.query.bind(engine)
  const assertAdmission = () => { if (context.admissionOpen?.() === false) throw new Error('Plan admission closed') }
  const capacities: Record<string, number> = {}
  const refresh = () => {
    const state = world.observe(), systems = world.observeSystems()
    for (const device of state.devices) capacities[`laboratory:device:${device.id}`] = 1
    for (const sample of state.samples) capacities[`laboratory:sample:${sample.id}`] = 1
    for (const batch of state.batches) capacities[`mars:batch:${batch.id}`] = 1
    for (const crop of systems.crops) { capacities[`mars:crop:${crop.id}`] = 1; capacities[`mars:source:${crop.id}`] = 1 }
    for (const chamber of ['incubator-1', 'incubator-2', 'incubator-3', 'incubator-4']) { capacities[`mars:seal:${chamber}`] = 1; capacities[`mars:sensor:${chamber}`] = 1 }
    for (const source of ['reservoir', 'filter', 'pump']) { capacities[`mars:source:${source}`] = 1; capacities[`mars:sensor:${source}`] = 1 }
    for (const id of ['mars:water-route', 'mars:power-priority', 'mars:solar-array']) capacities[id] = 1
  }
  refresh()
  const resolve = (input: Json) => context.resolveArgs ? context.resolveArgs(input) : input
  const validateInput = (grant: OperationContext, providerId: string, raw: Json, deferred?: ReadonlySet<string>) => {
    const value = resolve(raw)
    try { planResources(providerId, value) }
    catch (error) { throw new PlanAdmissionError(inputProblem(error), true) }
    const command = z.record(z.string(), z.unknown()).parse(value), state = world.observe()
    for (const field of ['deviceId', 'robotId', 'chamberId']) if (typeof command[field] === 'string' && !state.devices.some(d => d.id === command[field]))
      throw new PlanAdmissionError(`Unknown device in plan: ${command[field]}`, true)
    const samples = [command.sampleId, ...(Array.isArray(command.additionalSampleIds) ? command.additionalSampleIds : [])]
    for (const id of samples) if (typeof id === 'string' && !deferred?.has(id)) {
      const sample = state.samples.find(s => s.id === id)
      if (!sample || sample.projectId !== grant.projectId) throw new PlanAdmissionError(`Unknown or inaccessible sample in plan: ${id}`, true)
      if (sample.volumeUl <= 0) throw new PlanAdmissionError(`Sample has no remaining volume: ${id}`, true)
      if (sample.expiresAt < state.tick) throw new PlanAdmissionError(`Sample has expired: ${id}`, true)
    }
    // The full provider admission remains authoritative when an operation actually starts.
    if (namespace !== 'v06' || !deferred) return
    const system = systemCommandSchema.safeParse(value)
    if (system.success) { validateMarsProviderCommand(providerId, system.data); return }
    const c = laboratoryCommandSchema.parse(value)
    validateMarsProviderCommand(providerId, c)
    const device = state.devices.find(d => d.id === c.deviceId)!
    if (c.action === 'transfer') {
      if (device.kind !== 'robot') throw new PlanAdmissionError('Transfer requires a robot', true)
      const destination = state.devices.find(d => d.id === c.destination)
      if (!destination || destination.kind === 'robot') throw new PlanAdmissionError(`Invalid sample destination: ${c.destination}`, true)
      validateCarrierCapacity(c)
    } else if (c.action === 'process') {
      const method = state.methods.find(m => m.id === c.methodId && m.version === c.methodVersion)
      if (!method || !device.methods.includes(c.methodId))
        throw new PlanAdmissionError(`Method ${c.methodId} v${c.methodVersion} is incompatible with ${device.id}. Check the current methods catalog.`, true)
      const n = laboratorySampleIds(c).length
      if (n > device.maximumBatchSamples || n % device.batchMultiple !== 0)
        throw new PlanAdmissionError(`Batch of ${n} exceeds capacity or balancing requirements for ${device.id}`, true)
      validateProcessSupplies(state, c, method)
    } else if (c.action === 'aliquot' && (device.kind !== 'liquid-handler' || !device.containers.includes(c.container))) {
      throw new PlanAdmissionError('Aliquot requires a compatible liquid handler and output container', true)
    }
    if ((c.action === 'process' || c.action === 'transfer') && new Set(laboratorySampleIds(c)).size !== laboratorySampleIds(c).length)
      throw new PlanAdmissionError('Use distinct sample references in a batch', true)
  }
  const stores = new Map<string, V05Planning>()
  const store = (grant: OperationContext) => {
    let planning = stores.get(grant.actorId)
    if (!planning) {
      const durableGrant = engine.issueContext('mars', grant.actorId, ['water', 'greenhouse', 'facilities'])
      planning = new V05Planning(engine, durableGrant, context.currentTick ?? (() => world.observe().tick), capacities, {
        resourcesOf: (provider, input) => planResources(provider, resolve(input)),
        validateInput: (provider, input, deferred) => validateInput(durableGrant, provider, input, deferred),
        ...(servicePlans ? { inspectService: (plan: z.output<typeof planInputSchema>) =>
          inspectServicePlan(world, servicePlans.commissions, plan, resolve) } : {}),
        onBlocked: (planId, actorId, stepId, reason, terminal) => context.onPlanBlocked?.({ planId, actorId, stepId, reason, terminal }),
        occupied: resource => engine.list(durableGrant).filter(op => !['succeeded', 'failed', 'cancelled'].includes(op.state) && op.resources.includes(resource)).length }, namespace, context.mayDispatch)
      stores.set(grant.actorId, planning)
    }
    return planning
  }
  const commitmentInfo = (plan: Plan) => {
    const commitmentReceipts = servicePlans?.receipts?.(plan)
    const commitmentRecorded = commitmentReceipts ? commitmentReceipts.length > 0 : servicePlans?.isCommitted(plan) ?? false
    return { commitmentRecorded, commitmentReceipts: commitmentReceipts ?? [] }
  }
  const portfolioEntries = (saved: Plan[]) => saved.map(plan => {
    const info = commitmentInfo(plan)
    return { id: plan.id, draft: plan, saved: plan, committed: info.commitmentRecorded, commitmentReceipts: info.commitmentReceipts }
  })
  const parameters = { action: { type: 'string', required: true }, request_key: { type: 'string' },
    id: { type: 'string' }, revision: { type: 'integer' }, input_json: { type: 'string' } } as const
  const requiredText = (args: Record<string, unknown>, name: string) => {
    const parsed = z.string().trim().min(1).safeParse(args[name])
    if (!parsed.success) throw new Error(`${name} is required for action=${String(args.action)}`)
    // Preserve the caller's bytes for existing idempotency keys.
    return String(args[name])
  }
  const jsonInput = (args: Record<string, unknown>) => {
    const encoded = requiredText(args, 'input_json')
    try { return z.json().parse(JSON.parse(encoded)) }
    catch (error) { throw new Error(`input_json: ${inputProblem(error)}`) }
  }
  const planInput = (args: Record<string, unknown>, agent: Agent) => {
    const envelope = planEnvelopeSchema.safeParse(jsonInput(args))
    if (!envelope.success) throw new Error(inputProblem(envelope.error))
    let hasToolSteps = false
    const steps = envelope.data.steps.map((step, index) => {
      try {
        if (Object.hasOwn(step, 'tool') || Object.hasOwn(step, 'args')) {
          hasToolSteps = true
          const { tool, args: toolArgs, ...layout } = toolPlanStepSchema.parse(step)
          if (!context.physicalPlanTools) throw new Error('Public tool steps are unavailable in this runtime')
          return { ...layout, ...context.physicalPlanTools.compile(tool, toolArgs, agent) }
        }
        const raw = planStepSchema.parse(step)
        // Preserve accepted legacy step inputs during amendment.
        return args.action === 'amend' ? raw : { ...raw, input: resolve(raw.input) }
      } catch (error) {
        const id = typeof step.id === 'string' ? step.id : `#${index + 1}`
        throw new Error(`Step ${id}: ${inputProblem(error)}`, { cause: error })
      }
    })
    return { plan: { title: envelope.data.title, steps, ...(envelope.data.service ? { service: envelope.data.service } : {}) }, hasToolSteps }
  }
  const input = (args: Record<string, unknown>): unknown => {
    const value = jsonInput(args)
    if (!value || Array.isArray(value) || typeof value !== 'object') return value
    if (typeof value.resource === 'string' && value.resource.startsWith('laboratory:sample:')) {
      const suffix = value.resource.slice('laboratory:sample:'.length), resolved = z.object({ sampleId: z.string() }).parse(resolve({ sampleId: suffix }))
      return { ...value, resource: `laboratory:sample:${resolved.sampleId}` }
    }
    return value
  }
  const key = (args: Record<string, unknown>) => requiredText(args, 'request_key')
  const revision = (args: Record<string, unknown>) => {
    const parsed = z.number().int().positive().safeParse(args.revision)
    if (!parsed.success) throw new Error(`revision must be the current positive revision for action=${String(args.action)}`)
    return parsed.data
  }
  const toolStep = 'Use steps {id,tool,args,at?,dependsOn?,reservationIds?}. See research_catalog({contract:"experiment_plan",tool:"<name>"}) for schemas. '
  const serviceHelp = context.servicePlans ? 'Use read-only action=portfolio to check all active service plans and optional input_json={drafts,planIds}. For a service supply service={commissionId,measurementStepId,retentionStepId} in input_json. Read the accepted plan ID, then lock the T3 commitment to release the first step. ' : ''
  register('experiment_plan', `Persistent action DAG. action=list/check/schedule/amend/cancel. ${context.physicalPlanTools ? toolStep : ''}${serviceHelp}input_json contains title and steps. Legacy steps use providerId and input. Physical args can reference declared predecessors with $step:<id>:outputSampleId or outputSampleIds.0/resultId/resultIds.0. check reports known resources and timing bounds for tool or service steps or when deadline_tick is supplied. schedule/amend/cancel require request_key. amend/cancel also require id and revision. Accepted steps are immutable.`,
    { ...parameters, deadline_tick: { type: 'integer' } }, (args, agent) => {
      refresh()
      const plans = store(access(agent, 'experiment_plan'))
      if (!['list', 'check', 'portfolio'].includes(String(args.action))) assertAdmission()
      switch (args.action) {
        case 'portfolio': {
          if (!servicePlans) throw new Error('Portfolio requires the scientific service catalog')
          const query = portfolioRequest.parse(args.input_json === undefined ? {} : jsonInput(args))
          const saved = plans.list().filter(p => p.service && (query.planIds ? query.planIds.includes(p.id) : ['scheduled', 'running'].includes(p.state)))
          if (query.planIds?.some(id => !saved.some(p => p.id === id))) throw new Error('Unknown service plan ID in portfolio')
          const drafts = query.drafts.map((value, index) => {
            const { plan } = planInput({ action: 'check', input_json: JSON.stringify(value) }, agent)
            if (!plan.service) throw new Error(`Draft ${index + 1} needs a service binding`)
            return { id: `draft-${index + 1}`, draft: plans.check(plan), committed: false }
          })
          return inspectServicePortfolio(world, servicePlans.commissions, [...portfolioEntries(saved), ...drafts], resolve)
        }
        case 'list': return plans.list().map(plan => plan.service && context.servicePlans
          ? { ...plan, ...commitmentInfo(plan) } : plan)
        case 'check': {
          const { plan, hasToolSteps } = planInput(args, agent)
          const deadline = z.number().int().nonnegative().optional().safeParse(args.deadline_tick)
          if (!deadline.success) throw new Error('deadline_tick must be a non-negative integer')
          return hasToolSteps || plan.service || deadline.data !== undefined ? plans.inspect(plan, deadline.data) : plans.check(plan)
        }
        case 'schedule': return plans.schedule(key(args), planInput(args, agent).plan)
        case 'amend': return plans.amend(key(args), requiredText(args, 'id'), revision(args), planInput(args, agent).plan)
        case 'cancel': return plans.cancel(key(args), requiredText(args, 'id'), revision(args))
        default: throw new Error('Unknown plan action')
      }
    })
  register('resource_reservation', 'Scheduler-enforced reservations; native physical locks also remain authoritative. action=list/reserve/release. input_json={resource,start,end,quantity,planId?,stepId?}. Linked reservations activate only for that plan step, retain accepted occupancy until completion. Half-open windows.', parameters, (args, agent) => {
    refresh(); const plans = store(access(agent, 'resource_reservation'))
    if (args.action !== 'list') assertAdmission()
    switch (args.action) {
      case 'list': return { semantics: 'scheduler-enforced', capacities, reservations: plans.reservations() }
      case 'reserve': {
        const request = z.object({ resource: z.string() }).passthrough().parse(input(args))
        if (!(Object.hasOwn(capacities, request.resource))) throw new Error('Unknown public resource')
        return plans.reserve(key(args), request)
      }
      case 'release': return plans.release(key(args), String(args.id), revision(args))
      default: throw new Error('Unknown reservation action')
    }
  })
  return async () => {
    refresh()
    const host = engine.issueContext('mars', `${namespace}-scheduler-index`, ['water', 'greenhouse', 'facilities'])
    try {
    // Publish all settled native operations before any actor competes for newly freed locks.
    for (const operation of engine.list(host).filter(operation => !['succeeded', 'failed', 'cancelled'].includes(operation.state))) await queryOperation(host, operation.id)
    const operations = new Map(engine.list(host).map(operation => [operation.id, operation]))
    const actorKey = context.actorKey ?? ((id: string) => id)
    const participants = [...new Set([...store(host).list().map(plan => plan.actorId), ...store(host).reservations().map(reservation => reservation.actorId)])]
      .sort((a, b) => actorKey(a) < actorKey(b) ? -1 : actorKey(a) > actorKey(b) ? 1 : 0)
    const lastAccepted = store(host).lastAcceptedActor()
    const offset = lastAccepted && participants.includes(lastAccepted) ? (participants.indexOf(lastAccepted) + 1) % participants.length : 0
    const actors = [...participants.slice(offset), ...participants.slice(0, offset)]
    for (const actor of actors) {
      const grant = engine.issueContext('mars', actor, ['water', 'greenhouse', 'facilities'])
      try {
        for (const operation of operations.values()) if (operation.actorId === actor && !['succeeded', 'failed', 'cancelled'].includes(operation.state))
          operations.set(operation.id, await queryOperation(grant, operation.id))
        await store(grant).advance(async (providerId, input, requestKey) => {
          try {
            const operation = await engine.submit(grant, { providerId, input: resolve(input), requestKey })
            operations.set(operation.id, operation)
            return { id: operation.id, state: operation.state }
          } catch (error) {
            if (error instanceof LaboratoryRefusal || error instanceof Error && /^Resource busy:/.test(error.message)) throw new PlanAdmissionError(error.message)
            throw error
          }
        }, id => operations.get(id)?.state, id => {
          const lab = world.observe().operations.find(operation => operation.id === id && operation.state === 'succeeded')
          if (lab) {
            const sampleIds = lab.outputSampleIds ?? (lab.outputSampleId ? [lab.outputSampleId] :
              lab.command.action === 'transfer' ? [lab.command.sampleId] : [])
            const resultIds = lab.resultIds ?? (lab.resultId ? [lab.resultId] : [])
            return { outputSampleIds: sampleIds, resultIds, ...(sampleIds[0] ? { outputSampleId: sampleIds[0] } : {}), ...(resultIds[0] ? { resultId: resultIds[0] } : {}) }
          }
          const system = world.observeSystems().operations.find(operation => operation.id === id && operation.state === 'succeeded')
          if (system?.command.action === 'sample') {
            const sampleId = `sample:${system.id}`
            if (world.observe().samples.some(sample => sample.id === sampleId)) return { outputSampleId: sampleId, outputSampleIds: [sampleId], resultIds: [] }
          }
          return undefined
        })
      } catch (error) {
        engine.recordFact(grant, `mars-${namespace}-plan-infrastructure-error`, { tick: world.observe().tick, reason: error instanceof Error ? error.message : String(error) })
        throw error
      } finally { engine.revokeContext(grant) }
    }
    } finally { engine.revokeContext(host) }
  }
}
