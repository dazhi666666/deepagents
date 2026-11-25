/** v0.4 situational tools (docs/实验任务重设计v0.4.md, chapter 5): duty windows, the team board and compact domain status.
 * Both arms get them; the single agent sees itself on the board and owns every duty.
 */
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from './world.ts'
import type { Refs } from './refs.ts'
import { dutySlot, dutyWindow, isDuty, nextDutyWindow, type DutyId } from './deliverables.ts'
import { tasksForLoad } from './mission.ts'
import { DUTY_OWNER, TEAM, type TeamRole } from './team.ts'

type Register = (name: string, description: string, parameters: ParameterSchemaSpec, body: (args: Record<string, unknown>, agent: Agent, signal: AbortSignal) => unknown | Promise<unknown>) => void
export interface TeamToolContext {
  register: Register; world: MarsWorld; engine: ExecutionEngine; admin: OperationContext; refs: Refs; load: string; multi: boolean
  /** Role of a live member. */
  roleOf: (agent: Agent) => string
  /** Members with their native status. */
  members: () => { id: string; role: string; status: string }[]
  /** Work mail, newest last. */
  mail: () => { senderRole: string; targetRole: string; content: string; tick: number }[]
  /** Laboratory procedures, all or one member's. */
  procedures: (actorId?: string) => unknown[]
}

const SUBMITTED = z.object({ taskId: z.string(), tick: z.number(), slot: z.number().optional(), actorId: z.string() }).passthrough()
const REJECTED = SUBMITTED.extend({ problems: z.array(z.string()) })
const WATER_DEVICES = ['screen', 'water-prepare', 'confirm', 'heater-1', 'heater-2', 'centrifuge-1', 'centrifuge-2', 'cold-1', 'cold-2', 'freezer']
const ACTIVE = new Set(['accepted', 'running', 'queued', 'waiting'])

export function installTeamTools(context: TeamToolContext) {
  const { register, world, engine, admin, refs, load } = context
  const short = (id: string) => refs.shortOf(id) ?? id
  const accepted = () => engine.readFacts(admin).filter(fact => fact.kind === 'mars-deliverable-accepted').map(fact => SUBMITTED.parse(fact.data))
  const rejected = () => engine.readFacts(admin).filter(fact => fact.kind === 'mars-deliverable-rejected').map(fact => REJECTED.parse(fact.data))
  const duties = (role: string): DutyId[] => tasksForLoad(load).filter(isDuty).filter(task => !context.multi || DUTY_OWNER[task] === role)
  /** One duty as its owner needs it: the open window, whether it is done, the next one and the latest receipt. */
  const dutyView = (task: DutyId) => {
    const tick = world.observe().tick, slot = dutySlot(task, load, tick, world.horizon)
    const window = slot === null ? null : dutyWindow(task, load, slot, world.horizon)
    const done = slot !== null && accepted().some(record => record.taskId === task && record.slot === slot)
    const next = nextDutyWindow(task, load, world.horizon, window ? window[1] : tick)
    const last = [...accepted().filter(record => record.taskId === task).map(record => ({ accepted: true, tick: record.tick, slot: record.slot ?? null, problems: [] as string[] })),
      ...rejected().filter(record => record.taskId === task).map(record => ({ accepted: false, tick: record.tick, slot: record.slot ?? null, problems: record.problems.slice(0, 3) }))]
      .sort((a, b) => a.tick - b.tick).at(-1) ?? null
    return { task, owner: context.multi ? DUTY_OWNER[task] : 'brain', open: window ? { slot, from: window[0], to: window[1] - 1, submitted: done, ticksLeft: window[1] - tick } : null,
      next: next && (!window || next.slot !== slot) ? { slot: next.slot, from: next.from, to: next.to - 1 } : null, lastReceipt: last }
  }
  register('duty_status', 'Your duty windows: the window open now (its ticks, whether you already submitted in it, ticks left), the next one, and your latest receipt.', {}, (_args, agent) => {
    const role = context.roleOf(agent)
    return { tick: world.observe().tick, duties: duties(role).map(dutyView) }
  })
  register('board', 'Team board: every member\'s latest accepted and rejected submissions, its open duty windows still unsubmitted, running operations and the latest messages.', {}, () => {
    const tick = world.observe().tick, roleById = new Map(context.members().map(member => [member.id, member.role]))
    const systems = world.observeSystems().operations.filter(operation => ACTIVE.has(operation.state))
    const labs = world.observe().operations.filter(operation => ACTIVE.has(operation.state))
    const operationsOf = (role: string) => engine.list(admin).filter(operation => roleById.get(operation.actorId) === role && !['succeeded', 'failed', 'cancelled'].includes(operation.state))
      .map(operation => {
        const system = systems.find(value => value.id === operation.id), lab = labs.find(value => value.id === operation.id)
        return { ref: short(operation.id), action: (system?.command as { action?: string } | undefined)?.action ?? (lab?.command as { action?: string; methodId?: string } | undefined)?.methodId ?? 'operation',
          ...(system ? { expectedTick: system.nextTick } : {}) }
      })
    return { tick, sol: Math.floor(tick / 96), members: context.members().map(member => {
      const mine = <T extends { actorId: string }>(records: T[]) => records.filter(record => record.actorId === member.id)
      return { role: member.role, title: TEAM[member.role as TeamRole]?.title ?? member.role, status: member.status,
        accepted: mine(accepted()).slice(-4).map(record => ({ task: record.taskId, tick: record.tick })),
        rejected: mine(rejected()).slice(-2).map(record => ({ task: record.taskId, tick: record.tick, problem: record.problems[0] ?? '' })),
        openDuties: duties(member.role).map(dutyView).filter(view => view.open && !view.open.submitted).map(view => ({ task: view.task, closesAt: view.open!.to, ticksLeft: view.open!.ticksLeft })),
        running: operationsOf(member.role).slice(0, 6),
        procedures: (context.procedures(member.id) as { state: string }[]).filter(procedure => procedure.state !== 'done').slice(-3) }
    }), messages: context.mail().slice(-6).map(message => ({ from: message.senderRole, to: message.targetRole, tick: message.tick, content: message.content.slice(0, 160) })) }
  })
  /** Recent alarm events of the given kinds, newest last. */
  const alarms = (kinds: string[], since: number) => world.events(0).filter(event => kinds.includes(event.kind) && (event.tick ?? 0) >= since).slice(-8)
    .map(event => ({ kind: event.kind, tick: event.tick, payload: event.payload }))
  register('water_status', 'Water loop at a glance: tank and reserve, irrigation source, inline DOC per module, recent alarms, the latest water measurements with their values and refs, stored water samples and water-lab devices.', {}, () => {
    const sensors = world.sensors(), lab = world.observe(), sources = world.observeSystems().sampleSources, tick = sensors.tick
    /** Source module or crop of a sample, following aliquots back to their parent. */
    const sourceOf = (sampleId: string) => {
      for (let id: string | undefined = sampleId, depth = 0; id && depth < 8; id = lab.samples.find(sample => sample.id === id)?.parentId, depth++)
        if (sources[id]) return sources[id]!
      return null
    }
    const water = (sampleId: string) => !String(sourceOf(sampleId) ?? '').startsWith('crop-')
    const results = lab.results.filter(result => ['confirm', 'screen'].includes(result.methodId) && water(result.sampleId))
      .slice(-10).map(result => ({ ref: short(result.id), source: sourceOf(result.sampleId), sample: short(result.sampleId), method: result.methodId,
        version: result.methodVersion, completedTick: result.completedTick ?? null, measurement: world.measurement(result.id) }))
    const samples = lab.samples.filter(sample => sample.volumeUl > 0 && water(sample.id))
      .slice(-12).map(sample => ({ ref: short(sample.id), location: sample.location, volumeUl: sample.volumeUl, source: sourceOf(sample.id) }))
    return { tick, sol: sensors.sol, water: sensors.water, alarms: alarms(['inline-doc-alarm', 'method-revised', 'batch-recalled'], tick - 300), recentResults: results, samples,
      procedures: context.procedures().slice(-6), extraction: lab.batches.filter(batch => batch.kind === 'extraction').map(batch => ({ id: batch.id, units: batch.units, disposition: batch.disposition })),
      devices: lab.devices.filter(device => WATER_DEVICES.includes(device.id)).map(device => ({ id: device.id, enabled: device.enabled, broken: device.broken ?? false, dirty: device.dirty ?? false,
        ...(device.temperature === undefined ? {} : { temperature: device.temperature }),
        ...(['confirm', 'screen'].includes(device.id) ? { calibratedUntil: device.calibratedUntil ?? null, calibrationExpired: (device.calibratedUntil ?? -1) < tick } : {}) })),
      robot: world.observeSystems().robots.find(robot => robot.id === 'robot-1') ?? null }
  })
  register('greenhouse_status', 'Greenhouse at a glance: per-chamber light, nutrient, CO2, pressure and quarantine; per-crop status, moisture reading and irrigation over the last 100 ticks; the latest scan of each chamber.', {}, () => {
    const sensors = world.sensors(), systems = world.observeSystems()
    const scans = Object.fromEntries(sensors.chambers.map(chamber => {
      const scan = systems.operations.filter(operation => operation.state === 'succeeded' && (operation.command as { action?: string; chamberId?: string }).action === 'scan' &&
        (operation.command as { chamberId?: string }).chamberId === chamber.id).at(-1)
      return [chamber.id, scan ? { ref: short(scan.id), tick: scan.completedTick ?? null } : null]
    }))
    return { tick: sensors.tick, sol: sensors.sol, solPhase: sensors.solPhase, chambers: sensors.chambers.map(chamber => ({ ...chamber, latestScan: scans[chamber.id] })),
      crops: sensors.crops.map(crop => ({ id: crop.id, chamber: crop.chamberId, variety: crop.variety, status: crop.status, moisture: crop.moistureReading, irrigationLast100: crop.irrigationLast100 })),
      waterSource: sensors.water.irrigationSource, alarms: alarms(['crop-status-changed', 'chamber-pressure-low'], sensors.tick - 200) }
  })
  register('energy_status', 'Energy and facilities at a glance: solar, demand, battery, dust, load shedding and priority, CO2 tank, spares, robots and broken devices.', {}, () => {
    const sensors = world.sensors(), lab = world.observe()
    return { tick: sensors.tick, sol: sensors.sol, solPhase: sensors.solPhase, energy: sensors.energy, co2TankUnits: sensors.co2TankUnits, spares: sensors.spares,
      robots: world.observeSystems().robots.map(robot => ({ id: robot.id, node: robot.node, energy: robot.energy, busy: robot.operationId !== null })),
      brokenDevices: lab.devices.filter(device => device.broken).map(device => device.id), alarms: alarms(['battery-low', 'power-shed', 'device-fault', 'chamber-pressure-low'], sensors.tick - 200) }
  })
}
