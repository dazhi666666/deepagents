/** v0.4 laboratory procedures (docs/实验任务重设计v0.4.md, chapter 5): one tool call runs a whole water-lab chain through
 * the real samplers, robots, heaters, confirm and stores. Each step is an ordinary engine operation attributed to the
 * caller, so devices, robots, power, consumables and time are spent exactly as by hand; the procedure only spares the
 * Agent the parameters and the waiting between steps. Devices it dirties are cleaned between uses by the lab itself;
 * calibration stays with the engineer. Progress is persisted as facts, so a restored run resumes every procedure.
 */
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { Json, OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from './world.ts'
import type { Refs } from './refs.ts'
import { fitChromatogram } from './chromatography.ts'

export type ProcedureKind = 'water_assay' | 'water_split'
const STORAGE: Record<string, string> = { 'cold-1': 'cold-1', 'cold-2': 'cold-2', freezer: 'freezer', bench: 'liquid-handler' }
const MODULES = ['reservoir', 'filter', 'pump']
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
const FINISHED = new Set(['confirmed', 'screened', 'reviewed'])
const ASSAY_UL = 200, ALIQUOT_UL = 150, ROBOT_RESERVE = 55, RETURN_RESERVE = 20, GIVE_UP_TICKS = 240

const specSchema = z.object({ id: z.string(), kind: z.enum(['water_assay', 'water_split']), actorId: z.string(), requestKey: z.string(), providers: z.array(z.string()), robot: z.string(),
  taskId: z.string(), tick: z.number(), sourceId: z.string().optional(), sampleId: z.string().optional(), method: z.enum(['confirm', 'screen']).optional(), confirmVolumeUl: z.number().int().positive().optional(),
  storage: z.array(z.string()).optional(), copies: z.number().int().optional(), extractionBatch: z.string().optional() })
export type ProcedureSpec = z.infer<typeof specSchema>
const stepSchema = z.object({ id: z.string(), index: z.number(), phase: z.string(), operationId: z.string(), host: z.boolean() })
const settledSchema = z.object({ id: z.string(), state: z.enum(['done', 'failed']), resultIds: z.array(z.string()), sampleIds: z.array(z.string()), detail: z.string(), tick: z.number() })

interface Procedure {
  spec: ProcedureSpec
  steps: z.infer<typeof stepSchema>[]
  settled?: z.infer<typeof settledSchema>
  /** Tick the procedure last made progress, to give up on a chain that cannot continue. */
  progressTick: number
  blocked?: string
}
type Next = { phase: string; providerId: string; input: Json; host?: boolean } | { wait: string } | { done: { resultIds: string[]; sampleIds: string[]; detail: string } } | { fail: string }

export interface ProcedureDeps {
  engine: ExecutionEngine; world: MarsWorld; admin: OperationContext; refs: Refs
  /** Grant that may clean devices between uses (the lab's own housekeeping). */
  host: OperationContext
  /** When false, only operations already admitted continue; no automatic next step or housekeeping is added. */
  canAdvance?: () => boolean
  /** Omitted preserves legacy environmental sweeping; false confines cleanup to requested procedures. */
  sweepAbandoned?: boolean
  /** Omitted queries Providers directly; a scientific host may observe only changed physical transitions. */
  observeOperation?: ExecutionEngine['query']
  /** Runtime mail to a role: completion to the owner, a blocked calibration to whoever calibrates. */
  notify: (role: string | null, actorId: string, key: string, content: string) => Promise<void>
}

export class Procedures {
  private readonly all = new Map<string, Procedure>()
  private readonly grants = new Map<string, OperationContext>()
  private stepping: Promise<void> | undefined

  constructor(private readonly deps: ProcedureDeps) {
    for (const fact of deps.engine.readFacts(deps.admin)) {
      if (fact.kind === 'mars-procedure-created') { const spec = specSchema.parse(fact.data); this.all.set(spec.id, { spec, steps: [], progressTick: spec.tick }) }
      if (fact.kind === 'mars-procedure-step') { const step = stepSchema.parse(fact.data); this.all.get(step.id)?.steps.push(step) }
      if (fact.kind === 'mars-procedure-settled') { const settled = settledSchema.parse(fact.data); const procedure = this.all.get(settled.id); if (procedure) procedure.settled = settled }
    }
  }

  /** Operations a procedure submitted, whose individual completions should not wake the Agent. */
  internal(operationId: string) { return [...this.all.values()].some(procedure => procedure.steps.some(step => step.operationId === operationId)) }

  /** Resolve sample refs and reject missing samples before persistence; submit the first step when possible. */
  async start(spec: Omit<ProcedureSpec, 'id' | 'tick'>) {
    const lab = this.deps.world.observe(), id = `pr-${this.all.size + 1}`, tick = lab.tick
    const full = specSchema.parse({ ...spec, id, tick })
    if (full.sampleId) full.sampleId = this.deps.refs.resolve(full.sampleId)
    if (full.sampleId && !lab.samples.some(sample => sample.id === full.sampleId))
      throw new Error(`Unknown sample: ${full.sampleId}`)
    this.deps.engine.recordFact(this.deps.admin, 'mars-procedure-created', z.json().parse(full))
    this.all.set(id, { spec: full, steps: [], progressTick: tick })
    await this.step()
    return this.view(id)
  }

  /** The procedure one member started under a request key, so a retried call does not start a second one. */
  byKey(actorId: string, requestKey: string) {
    const found = [...this.all.values()].find(procedure => procedure.spec.actorId === actorId && procedure.spec.requestKey === requestKey)
    return found ? this.view(found.spec.id) : null
  }
  /** Public state of one procedure. */
  view(id: string) {
    const procedure = this.all.get(id)
    if (!procedure) return null
    const short = (value: string) => this.deps.refs.shortOf(value) ?? value
    return { procedure: id, kind: procedure.spec.kind, startedTick: procedure.spec.tick, state: procedure.settled?.state ?? (procedure.blocked ? 'blocked' : 'running'),
      phase: procedure.steps.at(-1)?.phase ?? 'starting', ...(procedure.blocked ? { blockedBy: procedure.blocked } : {}),
      ...(procedure.settled ? { resultIds: procedure.settled.resultIds.map(short), sampleIds: procedure.settled.sampleIds.map(short), detail: procedure.settled.detail } : {}) }
  }
  /** Whether a requested procedure still needs physical progress or a blocked-resource deadline. */
  hasPending() { return [...this.all.values()].some(procedure => !procedure.settled) }

  /** Procedures of one member, newest last. */
  list(actorId?: string) { return [...this.all.values()].filter(procedure => !actorId || procedure.spec.actorId === actorId).slice(-12).map(procedure => this.view(procedure.spec.id)!) }

  /** Advance every running procedure as far as the world allows at the current tick. */
  step(): Promise<void> {
    if (this.deps.canAdvance?.() === false) return Promise.resolve()
    if (this.stepping) return this.stepping
    const work = (async () => {
      if (this.deps.sweepAbandoned !== false) await this.sweep()
      for (const procedure of this.all.values()) if (!procedure.settled) await this.advance(procedure)
    })()
    const tracked = work.finally(() => { if (this.stepping === tracked) this.stepping = undefined })
    this.stepping = tracked
    return tracked
  }

  /** Lab housekeeping: a water module holds one sample, so a raw sample left on one by a procedure that has ended
   * would block every later sampling from that module. Move such leftovers to cold storage. */
  private async sweep() {
    const lab = this.deps.world.observe()
    const live = new Set<string>()
    for (const procedure of this.all.values()) {
      if (procedure.settled) continue
      for (const step of procedure.steps) for (const id of this.operation(step.operationId)?.outputSampleIds ?? []) live.add(id)
      for (const step of procedure.steps) { const output = this.operation(step.operationId)?.outputSampleId; if (output) live.add(output) }
    }
    for (const sample of lab.samples) {
      if (!MODULES.includes(sample.location) || sample.volumeUl <= 0 || live.has(sample.id)) continue
      if (lab.operations.some(operation => !TERMINAL.has(operation.state) && operation.command.deviceId === sample.location)) continue
      // robot-1 is the water line's own robot and is often busy; robot-3 may carry too, on the housekeeping grant.
      for (const robot of ['robot-1', 'robot-3']) {
        try {
          await this.deps.engine.submit(this.deps.host, { providerId: 'facilities', requestKey: `sweep-${sample.id}-${robot}-${lab.tick}`, input: { action: 'transfer', deviceId: robot, sampleId: sample.id, destination: 'cold-2' } })
          break
        } catch { continue }
      }
    }
  }

  private grant(spec: ProcedureSpec) {
    let grant = this.grants.get(spec.actorId)
    if (!grant) { grant = this.deps.engine.issueContext('mars', spec.actorId, spec.providers); this.grants.set(spec.actorId, grant) }
    return grant
  }
  private operation(id: string) {
    const lab = this.deps.world.observe().operations.find(value => value.id === id)
    if (lab) return { state: lab.state, detail: lab.detail ?? null, outputSampleId: lab.outputSampleId ?? null, outputSampleIds: lab.outputSampleIds ?? [], resultId: lab.resultId ?? null }
    const system = this.deps.world.observeSystems().operations.find(value => value.id === id)
    if (system) return { state: system.state, detail: system.detail ?? null, outputSampleId: system.state === 'succeeded' && (system.command as { action?: string }).action === 'sample' ? `sample:${id}` : null, outputSampleIds: [] as string[], resultId: null }
    return null
  }

  private async advance(procedure: Procedure) {
    const tick = this.deps.world.observe().tick
    for (let guard = 0; guard < 8; guard++) {
      const last = procedure.steps.at(-1)
      if (last) {
        // The world settles a step before the execution engine has been told about it: the engine publishes that
        // operation's artifacts and releases its resource locks only when it is queried. Ask every time, or the
        // next step is refused busy and the result's artifacts never reach the evidence record.
        await (this.deps.observeOperation ?? this.deps.engine.query.bind(this.deps.engine))(last.host ? this.deps.host : this.grant(procedure.spec), last.operationId).catch(() => null)
        const operation = this.operation(last.operationId)
        if (!operation || !TERMINAL.has(operation.state)) return
        if (operation.state !== 'succeeded') {
          // A refused or failed housekeeping step is retried; a failed chain step ends the procedure.
          if (last.host || /busy|capacity|unavailable|supply|Charge/i.test(operation.detail ?? '')) {
            if (tick - procedure.progressTick > GIVE_UP_TICKS) return this.settle(procedure, 'failed', [], [], `${last.phase}: ${operation.detail ?? operation.state}`)
            // Refused for now: forget the step and try again at a later tick.
            procedure.blocked = operation.detail ?? last.phase
            procedure.steps.pop()
            return
          }
          return this.settle(procedure, 'failed', [], [], `${last.phase}: ${operation.detail ?? operation.state}`)
        }
      }
      const next = this.next(procedure)
      if ('wait' in next) {
        if (tick - procedure.progressTick > GIVE_UP_TICKS) return this.settle(procedure, 'failed', [], [], `gave up waiting: ${next.wait}`)
        if (procedure.blocked !== next.wait) {
          procedure.blocked = next.wait
          if (/calibration/i.test(next.wait)) await this.deps.notify('engineer', procedure.spec.actorId, `calibrate-${procedure.spec.id}`,
            `[请求] 流程 ${procedure.spec.id} 卡在仪器校准：${next.wait}。请用 device_calibrate 校准该设备（校准有效期 400 步，方法更新后需重新校准）。`)
        }
        return
      }
      if ('done' in next) return this.settle(procedure, 'done', next.done.resultIds, next.done.sampleIds, next.done.detail)
      if ('fail' in next) return this.settle(procedure, 'failed', [], [], next.fail)
      const index = procedure.steps.length
      const grant = next.host ? this.deps.host : this.grant(procedure.spec)
      try {
        const record = await this.deps.engine.submit(grant, { providerId: next.providerId, requestKey: `${procedure.spec.id}:${index}:${tick}`, input: next.input })
        const step = { id: procedure.spec.id, index, phase: next.phase, operationId: record.id, host: next.host ?? false }
        this.deps.engine.recordFact(this.deps.admin, 'mars-procedure-step', z.json().parse(step))
        procedure.steps.push(step); procedure.progressTick = tick; delete procedure.blocked
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A busy resource is usually a finished operation the engine has not been told about yet; reconcile and retry once.
        if (/Resource busy/.test(message)) {
          await this.deps.engine.reconcile(this.deps.admin)
          try {
            const record = await this.deps.engine.submit(grant, { providerId: next.providerId, requestKey: `${procedure.spec.id}:${index}:${tick}:r`, input: next.input })
            const step = { id: procedure.spec.id, index, phase: next.phase, operationId: record.id, host: next.host ?? false }
            this.deps.engine.recordFact(this.deps.admin, 'mars-procedure-step', z.json().parse(step))
            procedure.steps.push(step); procedure.progressTick = tick; delete procedure.blocked
            continue
          } catch (retry) {
            const detail = retry instanceof Error ? retry.message : String(retry)
            if (tick - procedure.progressTick > GIVE_UP_TICKS) return this.settle(procedure, 'failed', [], [], `${next.phase}: ${detail}`)
            procedure.blocked = `${next.phase}: ${detail}`
            return
          }
        }
        if (tick - procedure.progressTick > GIVE_UP_TICKS) return this.settle(procedure, 'failed', [], [], `${next.phase}: ${message}`)
        procedure.blocked = `${next.phase}: ${message}`
        return
      }
    }
  }

  private async settle(procedure: Procedure, state: 'done' | 'failed', resultIds: string[], sampleIds: string[], detail: string) {
    const settled = { id: procedure.spec.id, state, resultIds, sampleIds, detail, tick: this.deps.world.observe().tick }
    this.deps.engine.recordFact(this.deps.admin, 'mars-procedure-settled', z.json().parse(settled))
    procedure.settled = settled
    if (state === 'done') {
      // Results the procedure returns count as read, so they can be cited at once.
      const artifacts = resultIds.flatMap(resultId => {
        const operationId = this.deps.world.observe().results.find(result => result.id === resultId)?.operationId
        return operationId ? this.deps.engine.get(this.deps.admin, operationId).artifacts.map(artifact => artifact.id) : []
      })
      if (artifacts.length) this.deps.engine.recordFact(this.grant(procedure.spec), 'mars-artifact-read', { artifactIds: artifacts, tick: settled.tick })
    }
    const short = (value: string) => this.deps.refs.shortOf(value) ?? value
    // Each result as the lab's data system reports it: a water confirm comes with its chromatogram fit (DOC and
    // lubricant before calibration-age or method correction); other methods with their measurement.
    const values = resultIds.map(resultId => {
      const measurement = this.deps.world.measurement(resultId) as Record<string, Json> | null
      const raw = this.deps.world.rawFor(resultId) as { points?: number[]; dtMinutes?: number } | null
      const fit = measurement?.channel === 'doc' && Array.isArray(raw?.points) ? fitChromatogram(raw.points, raw.dtMinutes) : null
      const completedTick = this.deps.world.observe().results.find(result => result.id === resultId)?.completedTick ?? null
      return { result: short(resultId), ...(procedure.spec.sampleId ? { sample: short(procedure.spec.sampleId) } : {}), completedTick,
        ...(fit ? { doc: fit.doc, lubricant: fit.lubricant, calibrationAgeTicks: measurement?.calibrationAgeTicks ?? null, methodVersion: measurement?.methodVersion ?? null,
          flags: measurement?.flags ?? [] } : { measurement }) }
    })
    await this.deps.notify(null, procedure.spec.actorId, `settled-${procedure.spec.id}`, state === 'done'
      ? `[流程完成] ${procedure.spec.id} ${procedure.spec.kind}（${procedure.spec.taskId}）：${JSON.stringify(procedure.spec.kind === 'water_split' ? { aliquots: detail } : { results: values })}`
      : `[流程失败] ${procedure.spec.id} ${procedure.spec.kind}（${procedure.spec.taskId}）：${detail}`)
  }

  /** The next physical step of a procedure, given what its steps produced so far and the world now. */
  private next(procedure: Procedure): Next {
    const { spec } = procedure, world = this.deps.world, lab = world.observe(), tick = lab.tick
    const done = procedure.steps.map(step => ({ ...step, operation: this.operation(step.operationId)! }))
    const lastOf = (phase: string) => done.filter(step => step.phase === phase).at(-1)
    const sampleOf = (id: string) => lab.samples.find(sample => sample.id === id)
    const device = (id: string) => lab.devices.find(value => value.id === id)!
    const busy = (id: string) => lab.operations.some(operation => !TERMINAL.has(operation.state) && operation.command.deviceId === id) ||
      world.observeSystems().operations.some(operation => !TERMINAL.has(operation.state) && JSON.stringify(operation.command).includes(`"${id}"`))
    const occupied = (id: string) => lab.samples.filter(sample => sample.location === id && sample.volumeUl > 0).length
    const robot = world.observeSystems().robots.find(value => value.id === spec.robot)
    /** Bring a device to a usable state: clean it first if a previous use dirtied it. */
    const ready = (id: string, phase: string): Next | null => {
      const value = device(id)
      if (value.broken || !value.enabled) return { wait: `${id} is out of service; the engineer repairs or enables it` }
      if (busy(id)) return { wait: `${id} is busy` }
      if (value.dirty) return { phase: `clean-${phase}`, providerId: 'facilities', input: { action: 'clean', deviceId: id }, host: true }
      return null
    }
    /** Carry samples with the procedure's robot, keeping its battery well up: a robot that runs down away from its
     * dock can no longer reserve a route home, so it charges whenever it drops below the reserve. A full destination
     * first sends one finished sample (confirmed, screened or reviewed) it holds to cold storage. */
    const carry = (phase: string, sampleIds: string[], destination: string, stow = true): Next => {
      if (!robot) return { fail: `Robot ${spec.robot} is not available` }
      if (robot.operationId) return { wait: `${spec.robot} is busy` }
      if (robot.energy < ROBOT_RESERVE) {
        if (robot.node !== robot.id) {
          if (robot.energy < RETURN_RESERVE) return { wait: `${spec.robot} is stranded at ${robot.node} with ${robot.energy.toFixed(0)} energy` }
          return { phase: `${phase}-dock`, providerId: spec.providers[0]!, input: { action: 'move', robotId: robot.id, destination: robot.id } }
        }
        return { phase: `${phase}-charge`, providerId: spec.providers[0]!, input: { action: 'charge', robotId: robot.id } }
      }
      const target = ready(destination, phase)
      if (target) return target
      if (occupied(destination) + sampleIds.length > device(destination).capacity) {
        const finished = stow ? lab.samples.find(sample => sample.location === destination && sample.volumeUl > 0 && FINISHED.has(sample.state) && !sampleIds.includes(sample.id)) : undefined
        return finished ? carry(`stow-${phase}`, [finished.id], 'cold-2', false) : { wait: `${destination} has no free position` }
      }
      return { phase, providerId: spec.providers[0]!, input: z.json().parse({ action: 'transfer', deviceId: robot.id, sampleId: sampleIds[0], destination,
        ...(sampleIds.length > 1 ? { additionalSampleIds: sampleIds.slice(1) } : {}) }) }
    }
    const version = (methodId: string) => lab.methods.find(method => method.id === methodId)?.version ?? 1
    const process = (phase: string, deviceId: string, sampleId: string, methodId: string, consumables?: { batchId: string; units: number }[]): Next => {
      const target = ready(deviceId, phase)
      if (target) return target
      const value = device(deviceId), method = lab.methods.find(item => item.id === methodId)
      if (method?.requiresCalibration && (!value.calibrationId || (value.calibratedUntil ?? -1) < tick)) return { wait: `${deviceId} needs a current calibration` }
      const sample = sampleOf(sampleId)!
      return { phase, providerId: spec.providers[0]!, input: z.json().parse({ action: 'process', methodId, methodVersion: version(methodId), deviceId, sampleId,
        volumeUl: phase === 'confirm' ? spec.confirmVolumeUl ?? sample.volumeUl : sample.volumeUl, ...(consumables ? { consumables } : {}) }) }
    }
    const extraction = () => {
      const batches = lab.batches.filter(batch => batch.kind === 'extraction' && batch.disposition === 'available' && batch.units >= 1 && batch.expiresAt >= tick)
      return (spec.extractionBatch ? batches.find(batch => batch.id === spec.extractionBatch) : batches.sort((a, b) => b.units - a.units)[0]) ?? null
    }
    const output = (phase: string) => lastOf(phase)?.operation.outputSampleId ?? null
    const housekeeping = (ids: string[]): Next | null => {
      for (const id of ids) if (device(id).dirty && !busy(id)) return { phase: `clean-${id}`, providerId: 'facilities', input: { action: 'clean', deviceId: id }, host: true }
      return null
    }

    if (spec.kind === 'water_split') {
      const mother = output('sample')
      if (!mother) {
        // A module holds one sample: clear any raw sample an earlier chain abandoned there before drawing a new one.
        const stale = lab.samples.find(value => value.location === spec.sourceId && value.volumeUl > 0)
        if (stale) return carry('clear-module', [stale.id], 'cold-2', false)
        return { phase: 'sample', providerId: spec.providers[0]!, input: { action: 'sample', sourceId: spec.sourceId!, container: 'vial',
          volumeUl: (spec.copies ?? 1) * (spec.storage?.length ?? 1) * ALIQUOT_UL + 50 } }
      }
      if (sampleOf(mother)?.location !== 'liquid-handler' && !lastOf('to-handler')) return carry('to-handler', [mother], 'liquid-handler')
      const aliquots = done.filter(step => step.phase.startsWith('aliquot')).map(step => ({ storage: step.phase.slice('aliquot:'.length), sampleId: step.operation.outputSampleId! }))
      const storage = spec.storage ?? []
      for (const name of storage) {
        const mine = aliquots.filter(value => value.storage === name)
        const destination = STORAGE[name]!
        if (mine.length < (spec.copies ?? 1)) {
          if (busy('liquid-handler')) return { wait: 'liquid-handler is busy' }
          if (occupied('liquid-handler') + 1 > device('liquid-handler').capacity) return { wait: 'liquid-handler has no free position' }
          return { phase: `aliquot:${name}`, providerId: spec.providers[0]!, input: { action: 'aliquot', deviceId: 'liquid-handler', sampleId: mother, volumeUl: ALIQUOT_UL, container: 'vial' } }
        }
        const away = mine.filter(value => sampleOf(value.sampleId)?.location !== destination).map(value => value.sampleId)
        if (destination !== 'liquid-handler' && away.length) return carry(`store:${name}`, away.slice(0, 6), destination)
      }
      const refsIn = (name: string) => aliquots.filter(value => value.storage === name).map(value => this.deps.refs.shortOf(value.sampleId) ?? value.sampleId)
      return { done: { resultIds: [], sampleIds: aliquots.map(value => value.sampleId), detail: `tick ${tick}; ${storage.map(name => `${name}: ${refsIn(name).join(' ')}`).join('; ')}` } }
    }

    // water_assay: a fresh module sample, or a stored raw water sample, through prepare and confirm (or straight to screen).
    const method = spec.method ?? 'confirm'
    let raw = spec.sampleId ? this.deps.refs.resolve(spec.sampleId) : output('sample')
    if (!raw) {
      const stale = lab.samples.find(value => value.location === spec.sourceId && value.volumeUl > 0)
      if (stale) return carry('clear-module', [stale.id], 'cold-2', false)
      return { phase: 'sample', providerId: spec.providers[0]!, input: { action: 'sample', sourceId: spec.sourceId!, container: 'vial', volumeUl: ASSAY_UL } }
    }
    if (!sampleOf(raw)) return { fail: `Sample is unavailable: ${raw}` }
    if (method === 'screen') {
      const screened = lastOf('screen')
      if (!screened) {
        if (sampleOf(raw)?.location !== 'screen') return carry('to-screen', [raw], 'screen')
        return process('screen', 'screen', raw, 'screen')
      }
      return housekeeping(['screen']) ?? { done: { resultIds: [screened.operation.resultId!], sampleIds: [], detail: 'screen' } }
    }
    const prepared = output('prepare')
    if (!prepared) {
      const heater = ['heater-2', 'heater-1'].find(id => sampleOf(raw!)?.location === id) ??
        ['heater-2', 'heater-1'].find(id => device(id).containers.includes(sampleOf(raw!)!.container) && !busy(id) && !device(id).broken && occupied(id) < device(id).capacity) ?? 'heater-2'
      if (sampleOf(raw)?.location !== heater) return carry('to-heater', [raw], heater)
      const batch = extraction()
      if (!batch) return { wait: 'no extraction consumables are available; the engineer orders a resupply' }
      return process('prepare', heater, raw, 'water-prepare', [{ batchId: batch.id, units: 1 }])
    }
    raw = null
    const confirmed = lastOf('confirm')
    if (!confirmed) {
      if (sampleOf(prepared)?.location !== 'confirm') return carry('to-confirm', [prepared], 'confirm')
      return process('confirm', 'confirm', prepared, 'confirm')
    }
    // The result is ready. confirm holds two samples: a later chain stows a finished one only when it needs the position
    // and cleans the device before its own use, so robot-1 is not spent on a trip nobody needs yet.
    return { done: { resultIds: [confirmed.operation.resultId!], sampleIds: [], detail: 'confirmed' } }
  }
}

export const isModule = (id: string) => MODULES.includes(id)
export const STORAGE_NAMES = Object.keys(STORAGE)
