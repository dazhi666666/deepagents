/** Scripted reference policies (docs/实验任务重设计v0.4.md, chapter 8) act as the six fixed-team roles, following the same
 * SOPs the team is given. A role's decision is one SOP step: its sub-tasks are tried in priority order (safety events,
 * duties, research with a deadline, the rest — the task book's default order) and the first one that acts (a batch of
 * commands, a procedure, a check or submission of an answer, a report) ends the decision; an answer is checked in one
 * decision and submitted in a later one, as the SOPs' deliverable_check -> deliverable_submit. `serial` takes one decision
 * per window, for the most urgent class of work with a step to take, rotating among roles within the class (one person's
 * attention); `team` takes one decision per role per window. Both act through the real laboratory stack — the same execution engine, procedures,
 * device and robot reservations, consumables and crew time the model-driven arms use — and read only public observations:
 * sensors, telemetry, their own operation results, the archive, the task book and the alerts the runtime mails members.
 * Hidden truth (event onsets, causes, the evaluator's plan) is never read. v0.3 scripted neither the water procedures nor
 * the archive, which is why its reference topped out at 44.
 */
import { z } from 'zod'
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { MarsWorld } from './world.ts'
import type { Submission } from './scoring-common.ts'
import type { IncidentReport } from './scoring.ts'
import { answerSchemas, dutySlot, evidenceSchema, isDuty, TASKS, type TaskId } from './deliverables.ts'
import { deadlineFactor } from './mission.ts'
import { ALERT_ROUTES } from './team.ts'
import { minimumEvidence } from './scoring-progress.ts'
import { worldView } from './scoring-input.ts'
import { fitChromatogram } from './chromatography.ts'
import type { Procedures } from './procedures.ts'
import type { Refs } from './refs.ts'
import { WATER_STEPS } from './policy-water.ts'
import { CROPS_STEPS, AGRONOMIST_STEPS } from './policy-greenhouse.ts'
import { ENGINEER_STEPS } from './policy-facilities.ts'
import { ANALYST_STEPS } from './policy-archive.ts'
import { BRAIN_STEPS } from './policy-brain.ts'

export type PolicyMode = 'serial' | 'team'
export type Line = 'brain' | 'water' | 'crops' | 'agronomist' | 'engineer' | 'analyst'
/** Ticks a role waits after a failed check before checking the same answer again. */
const CHECK_BACKOFF = 48
/** Role rotation of the serial arm within one priority class. */
export const SERIAL_ORDER: Line[] = ['water', 'engineer', 'crops', 'agronomist', 'brain', 'analyst']
export const LINES: Line[] = ['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst']
/** Each role's sub-tasks in priority order (resolved at call time: the line modules import this one). */
const LINE_STEPS: Record<Line, () => readonly RoleStep[]> = { water: () => WATER_STEPS, engineer: () => ENGINEER_STEPS, crops: () => CROPS_STEPS,
  agronomist: () => AGRONOMIST_STEPS, brain: () => BRAIN_STEPS, analyst: () => ANALYST_STEPS }
export const MODULES = ['reservoir', 'filter', 'pump'] as const
export const SHED_FIRST = ['analysis', 'screen', 'confirm', 'imager', 'centrifuge-1', 'centrifuge-2', 'heater-1', 'heater-2', 'liquid-handler', 'robot-1', 'robot-3', 'water-recovery', 'co2-distribution']
export const est = (value: number, spread: number) => ({ est: value, lo: value - Math.abs(spread), hi: value + Math.abs(spread) })
/** One public alert, as the runtime mails it to the roles on its route (team.ts ALERT_ROUTES). */
export interface Alert { seq: number; tick: number; kind: string; data: Record<string, unknown> }
/** One SOP sub-task of a role; the first that acts takes the role's decision for this window. */
export type Step = (p: ReferencePolicy, tick: number) => Promise<unknown> | unknown
/** Priority class of a sub-task, in the default order the task book gives the single agent (4.6): safety events, then
 * duties, then research with a deadline, then the rest. */
export type StepKind = 'safety' | 'duty' | 'deadline' | 'other'
export const STEP_KINDS: readonly StepKind[] = ['safety', 'duty', 'deadline', 'other']
export interface RoleStep { kind: StepKind; run: Step }

/** Public archive surface the reference uses for the A tasks. */
export interface ArchiveSurface {
  query: (input: unknown) => { queryId: string; items: unknown[] }
  statistics: (entityId: string, metric: string) => { queryId: string; items: unknown[] }
  /** Read-only SQL with its logged query ID. */
  sql?: ((statement: string) => { queryId: string; rows: Record<string, unknown>[] }) | undefined
}
export interface PolicyDeps {
  engine: ExecutionEngine
  grant: OperationContext
  procedures: Procedures
  refs: Refs
  archive: ArchiveSurface | null
}

/** One scripted policy run: the six role lines share this instance, its per-window budget and its physical helpers. */
export class ReferencePolicy {
  readonly submissions: Submission[] = []
  readonly rejected: { taskId: string; tick: number; problems: string[] }[] = []
  readonly reports: IncidentReport[] = []
  readonly analysisRuns = new Map<string, number>()
  /** Development log of what the policy did and what the world refused. */
  readonly trace: string[] = []
  readonly done = new Set<string>()
  /** Per-task working state the role lines keep between windows. */
  readonly state: Record<string, unknown> = {}
  /** Public alerts seen so far, oldest first: the notices the runtime mails the team, never hidden truth. */
  readonly alerts: Alert[] = []
  private counter = 0
  private budget = 0
  private round = 0
  private eventCursor = 0
  /** Whether the role deciding now has already taken its step this window. */
  private spent = false
  /** Answers checked in an earlier decision and ready to submit, keyed by task (and duty window). */
  private readonly checked = new Set<string>()
  /** Tick each answer last failed its check. */
  private readonly failedChecks = new Map<string, number>()
  /** Outcome of the latest submit call: a first call only checks the answer. */
  lastSubmit: 'checked' | 'rejected' | 'accepted' = 'checked'
  /** Decisions each role took, per sol (development report of the attention each role needed). */
  readonly decisions: Record<string, number[]> = {}
  private readonly pending = new Map<string, { task: string; method: 'confirm' | 'screen'; startedTick: number; fresh: boolean }>()
  /** Confirm results of procedures that drew a fresh module sample, with the tick the procedure started (no later than
   * the sample was drawn) and the tick the result came back. */
  readonly freshConfirms: { resultId: string; startedTick: number; completedTick: number }[] = []
  private readonly results = new Map<string, string[]>()
  private readonly samples = new Map<string, string[]>()
  /** Whether each settled procedure finished or failed: a failed one never returns its result refs. */
  private readonly settledState = new Map<string, 'done' | 'failed'>()

  constructor(readonly world: MarsWorld, readonly deps: PolicyDeps, private readonly mode: PolicyMode, private readonly decisionTicks = 12, private readonly perStep = 4) {}

  /** Called once per logical tick; decides only on decision ticks: one role in serial mode, all six as a team. */
  async step(tick: number) {
    this.collectSettled()
    this.collectAlerts()
    if (tick % this.decisionTicks !== 0) return
    // The engine holds an operation's resource locks until it is queried, though the world may have settled it
    // ticks ago; ask once per window so the window starts from what is really free.
    if (this.pending.size) await this.deps.engine.reconcile(this.deps.grant)
    if (this.mode === 'team') {
      for (const line of LINES) await this.decide(line, tick, STEP_KINDS)
      return
    }
    // One person's attention, with the task book's default priority: the window goes to the most urgent class of work that
    // has a step to take, and within a class to the next role in rotation after the last one served.
    for (const kind of STEP_KINDS) for (let offset = 0; offset < SERIAL_ORDER.length; offset++) {
      const index = (this.round + offset) % SERIAL_ORDER.length
      if (await this.decide(SERIAL_ORDER[index]!, tick, [kind])) { this.round = index + 1; return }
    }
  }
  /** One role's decision: its sub-tasks of the given classes, most urgent class first, until one acts.
   * @returns Whether the role took a step. */
  private async decide(line: Line, tick: number, kinds: readonly StepKind[]) {
    this.budget = this.perStep
    this.spent = false
    try {
      for (const kind of kinds) {
        for (const task of LINE_STEPS[line]().filter(value => value.kind === kind)) {
          await task.run(this, tick)
          if (this.spent) break
        }
        if (this.spent) break
      }
    } catch (error) { this.trace.push(`t${tick} ${line} failed: ${error instanceof Error ? error.message : String(error)}`) }
    if (this.spent) { const sol = Math.floor(tick / 96), row = this.decisions[line] ??= []; row[sol] = (row[sol] ?? 0) + 1 }
    return this.spent
  }
  /** Whether the role deciding now has taken its step: later sub-tasks wait for its next decision. */
  get used() { return this.spent }
  get windowTicks() { return this.decisionTicks }

  /** Alerts committed since the last tick, filtered to the kinds the runtime routes to members. */
  private collectAlerts() {
    for (const event of this.world.events(this.eventCursor)) {
      this.eventCursor = Math.max(this.eventCursor, event.seq)
      if (!(event.kind in ALERT_ROUTES)) continue
      this.alerts.push({ seq: event.seq, tick: event.tick, kind: event.kind, data: (event.payload ?? {}) as Record<string, unknown> })
    }
  }
  /** First alert of a kind whose payload matches, if one has arrived. */
  alert(kind: string, match: (data: Record<string, unknown>) => boolean = () => true) {
    return this.alerts.find(value => value.kind === kind && match(value.data))
  }
  /** Public absolute deadline of a task from the task book (deadline factor of the load level, capped at the horizon). */
  deadline(task: TaskId) {
    const spec = TASKS[task].deadline
    return typeof spec === 'number' ? Math.min(this.world.horizon, Math.round(spec * deadlineFactor(this.world.truth.load))) : this.world.horizon
  }
  /** Event-relative deadline: `ticks` after an observed anchor tick, scaled like the task book's. */
  after(task: TaskId, anchor: number) {
    const spec = TASKS[task].deadline
    return typeof spec === 'object' && spec !== null ? Math.min(this.world.horizon, Math.round(anchor + spec.ticks * deadlineFactor(this.world.truth.load))) : this.world.horizon
  }

  /** Procedures that settled since the last window; their result refs are the ones their owner may cite. */
  private collectSettled() {
    for (const id of [...this.pending.keys()]) {
      const raw = this.deps.procedures.view(id)
      if (!raw) continue
      const view = z.object({ procedure: z.string(), state: z.string(), detail: z.string().optional(), resultIds: z.array(z.string()).default([]), sampleIds: z.array(z.string()).default([]) }).parse(raw)
      const pending = this.pending.get(view.procedure)
      if (!pending || view.state === 'running' || view.state === 'blocked') continue
      this.pending.delete(view.procedure)
      this.settledState.set(view.procedure, view.state === 'done' ? 'done' : 'failed')
      this.results.set(view.procedure, view.resultIds.map(ref => this.deps.refs.resolve(ref)))
      if (view.state === 'done' && pending.fresh && pending.method === 'confirm') for (const ref of view.resultIds) {
        const resultId = this.deps.refs.resolve(ref)
        this.freshConfirms.push({ resultId, startedTick: pending.startedTick, completedTick: this.world.observe().results.find(result => result.id === resultId)?.completedTick ?? this.world.observe().tick })
      }
      this.samples.set(view.procedure, view.sampleIds.map(ref => this.deps.refs.resolve(ref)))
      this.trace.push(`t${this.world.observe().tick} procedure ${view.procedure} (${pending.task}) ${view.state}: ${view.detail ?? ''} ${view.resultIds.join(' ')} ${view.sampleIds.join(' ')}`)
    }
  }

  // Physical helpers: every action goes through the execution engine, so locks, artifacts, wear and time are the real ones.
  /** Submit one physical command of a provider within this window's budget. */
  async act(provider: string, input: Json): Promise<string | null> {
    if (this.budget <= 0) return null
    const key = `ref-${this.counter++}`
    try {
      const record = await this.deps.engine.submit(this.deps.grant, { providerId: provider, requestKey: key, input })
      this.budget--
      this.spent = true
      return record.id
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The engine holds an operation's resources until it is queried, though the world settled it ticks ago; a
      // refusal therefore usually means a finished operation whose lock was never released. Ask, then try once more.
      if (/Resource busy/.test(message)) {
        try {
          await this.deps.engine.reconcile(this.deps.grant)
          const record = await this.deps.engine.submit(this.deps.grant, { providerId: provider, requestKey: `${key}-r`, input })
          this.budget--
          this.spent = true
          return record.id
        } catch (retry) {
          const detail = retry instanceof Error ? retry.message : String(retry)
          const busy = this.deps.engine.list(this.deps.grant).filter(operation => !['succeeded', 'failed', 'cancelled'].includes(operation.state))
            .map(operation => `${operation.providerId}:${JSON.stringify(operation.input).slice(0, 60)}:${operation.state}`).slice(0, 4)
          this.trace.push(`t${this.world.observe().tick} ${provider} ${JSON.stringify(input).slice(0, 90)} refused: ${detail} | holders ${busy.join(' ; ')}`)
          return null
        }
      }
      this.trace.push(`t${this.world.observe().tick} ${provider} ${JSON.stringify(input).slice(0, 90)} refused: ${message}`)
      return null
    }
  }
  system(input: Json) { return this.act('facilities', z.json().parse(input)) }
  house(input: Json) { return this.act('greenhouse', z.json().parse(input)) }
  water(input: Json) { return this.act('water', z.json().parse(input)) }
  /** A laboratory device command (repair, clean, calibrate, refill, order) through the facilities provider. */
  device(input: Json) { return this.act('facilities', z.json().parse(input)) }
  /** Successful greenhouse scans of the given chambers since `from`, newest per chamber, with their observed values.
   * Both greenhouse lines read these instead of racing each other for the same chamber device. */
  scanObservations(chambers: readonly string[], from: number, tick: number) {
    const found: { chamber: string; id: string; tick: number; light: number; values: { cropId: string; growthIndex?: number; visibleLesions?: boolean; status?: string }[] }[] = []
    for (const op of this.ops()) {
      const command = op.command as { action?: string; chamberId?: string }
      if (command.action !== 'scan' || op.state !== 'succeeded' || !command.chamberId || !chambers.includes(command.chamberId)) continue
      const completed = op.completedTick ?? 0
      if (completed < from || completed > tick) continue
      const result = op.result as { light?: number; values?: { cropId: string; growthIndex?: number; visibleLesions?: boolean; status?: string }[] } | null
      found.push({ chamber: command.chamberId, id: op.id, tick: completed, light: Number(result?.light ?? 70), values: result?.values ?? [] })
    }
    return found
  }
  /** Ask for a fresh scan of each chamber with nothing else running on it, within this window's budget.
   * Scans take the `laboratory:device:<chamber>` lock, which a light, CO2 or nutrient change also holds, so a chamber
   * with any operation in flight is skipped until a later window. */
  async requestScans(chambers: readonly string[], tick: number) {
    const busy = new Set<string>()
    for (const op of this.ops()) {
      if (['succeeded', 'failed', 'cancelled'].includes(op.state)) continue
      const chamber = (op.command as { chamberId?: string }).chamberId
      if (chamber) busy.add(chamber)
    }
    // A laboratory command names the chamber device directly: a process on incubator-2 holds chamber 2's lock.
    for (const op of this.labOperations()) {
      if (['succeeded', 'failed', 'cancelled'].includes(op.state)) continue
      const device = (op.command as { deviceId?: string }).deviceId
      if (device) busy.add(device)
    }
    let asked = 0
    for (const chamber of chambers) {
      if (busy.has(chamber)) continue
      if (await this.house({ action: 'scan', chamberId: chamber })) asked++
    }
    void tick
    return asked
  }
  /** Run one archive query and record it as evidence, exactly as the archive tools do. */
  archiveQuery<T extends { queryId: string }>(run: () => T): T {
    const result = run()
    this.deps.engine.recordFact(this.deps.grant, 'mars-archive-query', { queryId: result.queryId })
    return result
  }

  /** Start one laboratory procedure under this window's budget (the procedure drives its own steps afterwards). */
  async procedure(kind: 'water_assay' | 'water_split', spec: Record<string, unknown>) {
    if (this.budget <= 0) return null
    try {
      const view = z.object({ procedure: z.string(), state: z.string() }).parse(await this.deps.procedures.start({ kind, actorId: this.deps.grant.actorId,
        providers: ['water'], robot: 'robot-1', ...spec } as never))
      this.budget--
      this.spent = true
      this.pending.set(view.procedure, { task: String(spec.taskId), method: (spec.method as 'confirm' | 'screen' | undefined) ?? 'confirm', startedTick: this.world.observe().tick,
        fresh: kind === 'water_assay' && spec.sourceId !== undefined })
      return view.procedure
    } catch (error) {
      this.trace.push(`t${this.world.observe().tick} ${kind} for ${String(spec.taskId)} refused: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
  /** Run one procedure for a named slot, remembering the in-flight or settled one.
   * @param slot Name unique to the plan step (e.g. `W1:reservoir`).
   * @param kind Procedure kind.
   * @param make Spec built only when the procedure still has to start.
   * @param attempts How many times a failed chain may restart before the slot is given up as lost.
   * @returns Whether the slot has no procedure yet, one running, or a settled result set.
   */
  async procedureFor(slot: string, kind: 'water_assay' | 'water_split', make: () => Record<string, unknown>, attempts = 3): Promise<{ state: 'idle' | 'running' | 'done'; id: string | null }> {
    const record = this.slot<{ ids: string[]; attempt: number } | null>(`proc:${slot}`, () => null)
    if (record) {
      const state = this.settledState.get(record.ids.at(-1)!)
      if (state === 'done') return { state: 'done', id: record.ids.at(-1)! }
      if (state !== 'failed') return { state: 'running', id: record.ids.at(-1)! }
      // A failed chain restarts while attempts remain; a refusal (busy device, missing supplies) usually clears.
      if (record.attempt >= attempts) { this.state[`proc:${slot}`] = null; return { state: 'idle', id: null } }
    }
    // robot-1 is exclusive: a chain occupies it from its first step, so a second chain started in the same window
    // is refused here rather than colliding with the first on the module, the heaters or the robot.
    if (this.robotBusy('robot-1')) return { state: 'idle', id: null }
    const id = await this.procedure(kind, make())
    if (!id) return { state: 'idle', id: null }
    const next = record ? { ids: [...record.ids, id], attempt: record.attempt + 1 } : { ids: [id], attempt: 1 }
    this.state[`proc:${slot}`] = next
    return { state: 'running', id }
  }
  settled(procedureId: string) { return this.settledState.get(procedureId) === 'done' }
  /** Whether a procedure is still running, finished well, or failed. */
  procedureState(procedureId: string) { return this.settledState.get(procedureId) ?? 'running' }
  resultIds(procedureId: string) { return this.results.get(procedureId) ?? [] }
  sampleIds(procedureId: string) { return this.samples.get(procedureId) ?? [] }
  /** Module or crop a result came from, following the sample chain back to its collection point. */
  sourceOfResult(resultId: string) {
    const lab = this.world.observe(), sources = this.world.observeSystems().sampleSources
    const result = lab.results.find(value => value.id === resultId)
    for (let id: string | undefined = result?.sampleId, depth = 0; id && depth < 8; id = lab.samples.find(sample => sample.id === id)?.parentId, depth++)
      if (sources[id]) return sources[id]!
    return null
  }
  resolveRef(ref: string) { return this.deps.refs.resolve(ref) }
  /** Lot the quality notice recalls: the notice names the extraction A series and the production sol, and the archive's
   * lots table maps that to one sub-batch (what the analyst's SOP does). Null until the notice has arrived. */
  recalledLot() {
    const known = this.slot<{ lot: string | null; subBatch: string | null; queryIds: string[] }>('archive:recall', () => ({ lot: null, subBatch: null, queryIds: [] }))
    if (known.lot || !this.deps.archive) return known
    const notice = this.alert('announcement', data => data.kind === 'quality-notice')
    const sol = Number(/sol\s*(-?\d+)/.exec(String(notice?.data.text ?? ''))?.[1])
    if (!notice || !Number.isFinite(sol)) return known
    const result = this.archiveQuery(() => this.deps.archive!.query({ kind: 'lots' }))
    known.queryIds.push(result.queryId)
    const rows = result.items as { lot_id?: string; family?: string; sub_batch?: string; production_sol?: number }[]
    const row = rows.find(value => value.family === 'extraction' && String(value.sub_batch ?? '').startsWith('A') && Number(value.production_sol) === sol)
    known.lot = row?.lot_id ?? null
    known.subBatch = row?.sub_batch ?? null
    return known
  }
  /** Confirm values of one settled procedure: DOC fitted from the raw chromatogram and corrected for calibration age. */
  values(procedureId: string) {
    return this.resultIds(procedureId).map(resultId => {
      const measurement = this.world.measurement(resultId) as { channel?: string; calibrationAgeTicks?: number; methodVersion?: number; growthIndex?: number } | null
      const raw = this.world.rawFor(resultId) as { points?: number[]; dtMinutes?: number } | null
      const fit = measurement?.channel === 'doc' && Array.isArray(raw?.points) ? fitChromatogram(raw.points, raw.dtMinutes) : null
      const age = measurement?.calibrationAgeTicks ?? 0
      const completedTick = this.world.observe().results.find(result => result.id === resultId)?.completedTick ?? null
      return { resultId, ref: this.deps.refs.shortOf(resultId) ?? resultId, doc: fit ? fit.doc / (1 + 0.0004 * age) : null, lubricant: fit?.lubricant ?? null,
        age, methodVersion: measurement?.methodVersion ?? 1, growthIndex: measurement?.growthIndex ?? null, completedTick }
    })
  }
  /** Cached per-task state with a default. */
  slot<T>(key: string, create: () => T): T { return (this.state[key] ??= create()) as T }

  /** Cite a member's own analysis run (the run stands for the program the SOP template describes). */
  analysis(tick: number) {
    const id = `a-ref-${String(this.analysisRuns.size + 1).padStart(4, '0')}`
    this.analysisRuns.set(id, tick)
    return id
  }
  /** Whether an answer to this task (in this duty window) has been checked and waits to be submitted. */
  checkedFor(taskId: TaskId, tick: number) {
    return this.checked.has(isDuty(taskId) ? `${taskId}:${dutySlot(taskId, this.world.truth.load, tick, this.world.horizon)}` : taskId)
  }
  /** Check an answer (first call) or submit it (a later call), validating exactly as the deliverable tools do. */
  submit(tick: number, taskId: TaskId, answer: unknown, evidence: Partial<Record<'resultIds' | 'artifactIds' | 'operationIds' | 'archiveQueryIds' | 'analysisRunIds', string[]>>) {
    const parsed = answerSchemas[taskId].safeParse(answer)
    const cited = evidenceSchema.parse(evidence)
    const problems = parsed.success ? minimumEvidence(taskId, cited, worldView(this.world), { tick, load: this.world.truth.load, horizon: this.world.horizon,
      analysisTick: id => this.analysisRuns.get(id), answered: 1 }) : [parsed.error.message]
    // The SOP checks an answer (deliverable_check, on what it has read) one decision before submitting it, as a model must:
    // the check's verdict is a tool result the next request reads. A check holds for its duty window, or until submitted.
    const key = isDuty(taskId) ? `${taskId}:${dutySlot(taskId, this.world.truth.load, tick, this.world.horizon)}` : taskId
    // A check that failed recently has told the role its answer is not ready; it gathers more before checking again.
    if (problems.length && tick - (this.failedChecks.get(key) ?? -1000) < CHECK_BACKOFF) { this.lastSubmit = 'checked'; return false }
    this.spent = true
    if (!this.checked.has(key)) {
      this.lastSubmit = 'checked'
      if (problems.length) { this.failedChecks.set(key, tick); this.trace.push(`t${tick} ${taskId} check failed: ${problems[0]}`); return false }
      this.checked.add(key)
      return false
    }
    this.checked.delete(key)
    if (problems.length) { this.lastSubmit = 'rejected'; this.rejected.push({ taskId, tick, problems }); this.trace.push(`t${tick} ${taskId} rejected: ${problems[0]}`); return false }
    this.lastSubmit = 'accepted'
    this.submissions.push({ id: `ref-${taskId}-${tick}-${this.counter++}`, taskId, tick, actorId: 'ref', answer: parsed.data as Record<string, unknown>, evidence: cited })
    this.trace.push(`t${tick} ${taskId} accepted`)
    return true
  }
  report(tick: number, entities: string[], eventClass: string, rootCause: string[]) {
    this.reports.push({ tick, entities, actorId: 'ref', eventClass, rootCause })
    this.spent = true
  }
  telemetry(channel: string, from: number, to: number) {
    return (this.world.telemetry([channel], Math.max(0, from), Math.max(0, to), 100000)[channel] ?? []).filter((row): row is [number, number] => row[1] !== null)
  }
  solarOfSol(sol: number) { return this.telemetry('energy.solar', sol * 96 + 1, (sol + 1) * 96).reduce((sum, [, value]) => sum + value, 0) }
  minSocOfSol(sol: number) { const rows = this.telemetry('energy.soc', sol * 96 + 1, (sol + 1) * 96).map(([, value]) => value); return rows.length ? Math.min(...rows) : 0 }
  ops() { return this.world.observeSystems().operations }
  labOperations() { return this.world.observe().operations }
  robotBusy(id: string) { return this.world.observeSystems().robots.find(robot => robot.id === id)?.operationId !== null }
  /** Whether a robot is idle with charge to spare for a job and the trip home; below that it is sent to charge first. */
  robotReady(id: string, reserve = 60) {
    const robot = this.world.observeSystems().robots.find(value => value.id === id)
    return robot !== undefined && robot.operationId === null && robot.energy >= reserve
  }
  lastReference(targetId: string) {
    return this.ops().filter(op => op.command.action === 'device_reference' && (op.command as { targetId?: string }).targetId === targetId && op.state === 'succeeded').at(-1)
  }
}
