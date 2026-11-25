/** Durable execution management. Harness remains the owner of agents and sessions. */
import type { SQLOutputValue } from 'node:sqlite'
import { mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  canonicalJson,
  validateProvider,
  type ExecutionProvider,
  type OperationContext,
  type OperationRecord,
  type ResultArtifact,
  type Json,
} from './sdk.ts'

import { ExperimentStore, type ExperimentAPI, type ExperimentBinding } from './experiments.ts'
import { Artifacts } from './artifacts.ts'
import { ExecutionJournal, type OperationRow as Row } from './journal.ts'
import { ProviderRuntime } from './provider-runtime.ts'
import { Driver, ownDriver, ownExperiment, ownOperation, type Ownership } from './lifecycle.ts'

export { EXECUTION_SCHEMA_VERSION } from './journal.ts'
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
type ArtifactRow = Record<string, SQLOutputValue> & {
  id: string; operation_id: string; path: string; sha256: string; bytes: number; media_type: string
}
function artifactRecord(row: ArtifactRow): ResultArtifact {
  return { id: row.id, operationId: row.operation_id, path: row.path, sha256: row.sha256, bytes: row.bytes, mediaType: row.media_type }
}

export interface ExecutionOptions {
  directory: string
  providers: ExecutionProvider[]
  pollIntervalMs: number
  providerCallTimeoutMs: number
  /** Wait for a short controller write lock; omitted uses 5000 ms. */
  controllerLockTimeoutMs?: number
  /** Minimum terminal experiment/event age for explicit audit archival; omitted uses 30 days. */
  retentionDays?: number
  /** Optional domain-owned logical position attached to object event metadata. */
  logicalTick?: () => number
}
export interface SubmitOperation {
  providerId: string
  requestKey: string
  input: Json
}

/** Concurrent controllers share short write transactions; observers never query providers or write state. */
export class ExecutionEngine {
  readonly directory: string
  private experimentStore!: ExperimentStore
  private experimentAPI: ExperimentAPI | undefined
  private db!: ExecutionJournal
  private driver: Driver | undefined
  private readonly providers = new Map<string, ExecutionProvider>()
  private readonly contexts = new WeakSet<OperationContext>()
  private readonly managementAbort = new AbortController()
  private ready = false
  private closing = false
  private opening = false
  private openingFinished: PromiseWithResolvers<void> | undefined
  private closePromise: Promise<void> | undefined
  private mode: 'controller' | 'observer' | 'driver' = 'controller'
  private runtime!: ProviderRuntime
  private readonly pending = new Set<Promise<unknown>>()
  constructor(private readonly options: ExecutionOptions) {
    if (!Number.isSafeInteger(options.providerCallTimeoutMs) || options.providerCallTimeoutMs < 1)
      throw new Error('providerCallTimeoutMs must be a positive integer')
    if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1)
      throw new Error('pollIntervalMs must be a positive integer')
    if (options.controllerLockTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.controllerLockTimeoutMs) || options.controllerLockTimeoutMs < 1 ||
        options.controllerLockTimeoutMs > 300000))
      throw new Error('controllerLockTimeoutMs must be an integer in 1..300000')
    if (options.retentionDays !== undefined && (!Number.isSafeInteger(options.retentionDays) ||
      options.retentionDays < 0 || options.retentionDays > 36500))
      throw new Error('retentionDays must be an integer in 0..36500')
    this.directory = resolve(options.directory)
    for (const provider of options.providers) {
      validateProvider(provider)
      const id = provider.describe().id
      if (this.providers.has(id)) throw new Error(`Duplicate provider: ${id}`)
      this.providers.set(id, provider)
    }
  }
  /** Open a controller by default; recovery observes originals only while no independent driver owns progress.
   * Observer mode requires an initialized current-schema journal and performs no recovery or writes.
   * Driver mode owns continuous observation until close; recover:false skips the controller's initial observations.
   */
  async open(options: { mode?: 'controller' | 'observer' | 'driver'; recover?: boolean } = {}): Promise<void> {
    if (this.ready || this.opening || this.closing) throw new Error('Engine already opened or closed')
    this.opening = true
    this.openingFinished = Promise.withResolvers<void>()
    this.mode = options.mode ?? 'controller'
    let ownership: Ownership | null = null
    try {
      this.db = ExecutionJournal.open(this.directory, this.mode,
        this.options.controllerLockTimeoutMs ?? 5000, this.options.logicalTick)
      this.runtime = new ProviderRuntime(this.db, this.directory, this.providers, this.options.providerCallTimeoutMs,
        (id, data) => this.experimentStore.observed(id, data))
      this.experimentStore = new ExperimentStore({
        db: this.db,
        pollMs: this.options.pollIntervalMs,
        signal: this.managementAbort.signal,
        observing: this.observing,
        binding: (providerId) => {
          const d = this.providers.get(providerId)!.describe()
          return {
            version: d.version,
            sha256: createHash('sha256')
              .update(canonicalJson(d as unknown as Json))
              .digest('hex'),
          }
        },
        authorize: (context, providerId) => this.authorize(context, providerId),
        transaction: (body) => this.transaction(body),
        snapshot: read => this.snapshot(read),
        ownExperiment: (id) => ownExperiment(this.directory, id),
        submit: (context, request, binding) => this.submitBound(context, request, binding),
        get: (context, id) => this.get(context, id),
        query: (context, id) => this.query(context, id),
        cancel: (context, id) => this.cancel(context, id),
        artifact: (context, id) => new Artifacts(this).read(context, id),
      })
      if (this.mode !== 'observer' && (this.mode === 'driver' || options.recover !== false)) {
        ownership = ownDriver(this.directory)
        if (!ownership && this.mode === 'driver') throw new Error('Another driver owns this execution domain')
        if (ownership) await this.poll('recovery')
      }
      this.ready = true
      if (!this.closing && this.mode === 'driver' && ownership) {
        this.driver = new Driver(ownership, this.options.pollIntervalMs, () => this.poll('driver'),
          () => this.settleProviderWork())
        ownership = null
      }
    } catch (error) {
      await this.settleProviderWork()
      this.db?.close()
      throw error
    } finally {
      ownership?.close()
      this.opening = false
      this.openingFinished.resolve()
    }
  }
  /** Open a read-only WAL observer without migration, recovery, or provider calls. */
  openObserver(): Promise<void> {
    return this.open({ mode: 'observer' })
  }
  /** Start the independent polling lifetime; reject if another driver owns progress. */
  openDriver(): Promise<void> {
    return this.open({ mode: 'driver' })
  }
  /** A new WAL observer shares configuration but holds no write or driver ownership. */
  async observer(): Promise<ExecutionEngine> {
    this.assertReady()
    const engine = new ExecutionEngine(this.options)
    await engine.openObserver()
    return engine
  }
  /** A temporary local controller shares providers and skips initial recovery. Its caller must close it. */
  async commandController(): Promise<ExecutionEngine> {
    this.assertReady()
    const engine = new ExecutionEngine(this.options)
    await engine.open({ recover: false })
    return engine
  }
  /** Whether this connection is restricted to persisted observations. */
  get observing(): boolean {
    return this.mode === 'observer'
  }
  /** Driver loop completion after releasing polling qualification; controllers and observers have no loop. */
  get driverClosed(): Promise<void> {
    if (!this.driver) throw new Error('Engine does not own a driver')
    return this.driver.closed
  }
  /** Read one consistent WAL snapshot; nested reads reuse the existing transaction.
   * @param read Synchronous reads; asynchronous callbacks are not snapshot-scoped.
   * @returns The callback's synchronous value.
   */
  snapshot<T>(read: () => T): T {
    this.assertReady()
    return this.db.snapshot(read)
  }
  private async poll(source: string): Promise<void> {
    await Promise.all(this.unfinished().map((row) => {
      if (this.closing) return
      const ownership = ownOperation(this.directory, row.id)
      return ownership ? this.owned(row.id, ownership, () => this.runtime.refresh(this.row(row.id), source)) : undefined
    }))
  }
  /** Synchronous experiment mutations serialize their reads and writes in one controller transaction.
   * Operation submission retains its own registration transaction before provider dispatch.
   */
  get experiments(): ExperimentAPI {
    this.assertReady()
    return (this.experimentAPI ??= {
      create: (...args) => this.experimentStore.create(...args),
      claim: (...args) => this.experimentStore.claim(...args),
      requireController: (...args) => this.experimentStore.requireController(...args),
      get: (...args) => this.experimentStore.get(...args),
      list: (...args) => this.experimentStore.list(...args),
      submit: (...args) => this.experimentStore.submit(...args),
      assess: (...args) => this.transaction(() => this.experimentStore.assess(...args)),
      escalate: (...args) => this.transaction(() => this.experimentStore.escalate(...args)),
      resolve: (...args) => this.transaction(() => this.experimentStore.resolve(...args)),
      finish: (...args) => this.transaction(() => this.experimentStore.finish(...args)),
      cancel: (...args) => this.experimentStore.cancel(...args),
      wait: (...args) => this.experimentStore.wait(...args),
    })
  }
  private assertReady(): void {
    if (!this.ready || this.closing) throw new Error('Execution engine is not active')
  }
  private assertWritable(): void { this.db.assertWritable() }
  private transaction<T>(fn: () => T): T { return this.db.transaction(fn) }
  private event(row: Pick<Row, 'id' | 'project_id'> | null, type: string, data: Json): void {
    this.db.event(row, type, data)
  }
  /** Trusted adapters issue fresh contexts only after validating their actual caller instance. */
  issueContext(projectId: string, actorId: string, allowedProviders: readonly string[]): OperationContext {
    this.assertReady()
    if (!this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))
      throw new Error('Unknown project')
    if (!actorId || allowedProviders.some((id) => !this.providers.has(id)))
      throw new Error('Invalid actor or provider scope')
    const context = Object.freeze({
      projectId,
      actorId,
      allowedProviders: Object.freeze([...allowedProviders]),
    })
    this.contexts.add(context)
    return context
  }
  /** Revocation releases this exact context's experiment authority; registered operations remain managed. */
  revokeContext(context: OperationContext): void {
    this.contexts.delete(context)
    this.experimentStore?.revokeContext(context)
  }
  private authorize(context: OperationContext, providerId?: string): void {
    this.assertReady()
    if (!this.contexts.has(context)) throw new Error('Invalid or expired execution context')
    if (providerId && !context.allowedProviders.includes(providerId))
      throw new Error('Provider capability not authorized')
  }
  /** Creates a project or verifies the existing immutable budget limit; null admits unlimited cumulative budget. */
  createProject(id: string, budgetLimit: number | null): void {
    this.assertReady()
    if (!id || (budgetLimit !== null && (!Number.isFinite(budgetLimit) || budgetLimit < 0)))
      throw new Error('Invalid project or budget')
    this.transaction(() => {
      const prior = this.db.prepare('SELECT budget_limit,budget_unlimited FROM projects WHERE id=?').get(id) as
        | { budget_limit: number; budget_unlimited: number }
        | undefined
      if (prior) {
        if ((prior.budget_unlimited ? null : prior.budget_limit) !== budgetLimit)
          throw new Error('Existing project budget differs')
        return
      }
      this.db
        .prepare('INSERT INTO projects(id,budget_limit,budget_unlimited) VALUES(?,?,?)')
        .run(id, budgetLimit ?? 0, Number(budgetLimit === null))
      this.event({ id: '', project_id: id }, 'project-created', { budgetLimit })
    })
  }
  /** Trusted management inventory; model-facing adapters must expose only their scoped project. */
  projects(): { id: string; budgetLimit: number | null; budgetUsed: number }[] {
    this.assertReady()
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY id').all() as unknown as {
        id: string
        budget_limit: number
        budget_unlimited: number
        budget_used: number
      }[]
    ).map((x) => ({ id: x.id, budgetLimit: x.budget_unlimited ? null : x.budget_limit, budgetUsed: x.budget_used }))
  }
  private row(id: string): Row {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('Unknown operation')
    return row
  }
  private scoped(context: OperationContext, id: string): Row {
    this.authorize(context)
    const row = this.row(id)
    if (row.project_id !== context.projectId) throw new Error('Operation belongs to another project')
    this.authorize(context, row.provider_id)
    return row
  }
  private unfinished(): Row[] {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE state NOT IN ('succeeded','failed','cancelled') ORDER BY created_at",
      )
      .all() as Row[]
  }
  private operationArtifacts(id: string): ResultArtifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE operation_id=? ORDER BY id').all(id) as ArtifactRow[])
      .map(artifactRecord)
  }
  private record(row: Row, artifacts = this.operationArtifacts(row.id)): OperationRecord {
    return {
      id: row.id,
      runId: row.id,
      projectId: row.project_id,
      actorId: row.actor_id,
      providerId: row.provider_id,
      providerVersion: row.provider_version,
      requestKey: row.request_key,
      input: JSON.parse(row.input_json),
      resources: JSON.parse(row.resources_json),
      budget: row.budget,
      state: row.state,
      cancelRequested: Boolean(row.cancel_requested),
      progress: row.progress_json ? JSON.parse(row.progress_json) : null,
      detail: row.detail,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      artifacts,
    }
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    )
    return promise
  }
  private owned<T>(id: string, ownership: Ownership, fn: () => Promise<T>): Promise<T> {
    return this.track((async () => {
      try { return await fn() }
      finally { this.runtime.release(id, ownership) }
    })())
  }
  private async settleProviderWork(): Promise<void> { await this.runtime?.settle() }
  /** Resource reservation, budget charge and registration commit together before any provider action. */
  submit(context: OperationContext, request: SubmitOperation): Promise<OperationRecord> {
    return this.submitBound(context, request)
  }
  private duplicate(
    context: OperationContext, requestKey: string, requestJson: string, binding?: ExperimentBinding,
  ): Row | undefined {
    const existing = this.db.prepare('SELECT * FROM operations WHERE project_id=? AND request_key=?')
      .get(context.projectId, requestKey) as Row | undefined
    if (!existing) return
    if (existing.request_json !== requestJson) throw new Error('Request key reused with different input')
    if (binding) {
      const linked = this.db.prepare('SELECT experiment_id,action_id,decision_json FROM experiment_steps WHERE operation_id=?')
        .get(existing.id) as { experiment_id: string; action_id: string; decision_json: string } | undefined
      if (!linked || linked.experiment_id !== binding.experimentId || linked.action_id !== binding.action.actionId)
        throw new Error('Request key belongs to another operation scope')
      if (linked.decision_json !== canonicalJson(binding.action as Json))
        throw new Error('Decision request key changed')
    }
    return existing
  }
  private submitBound(
    context: OperationContext,
    request: SubmitOperation,
    binding?: ExperimentBinding,
  ): Promise<OperationRecord> {
    this.authorize(context, request.providerId)
    if (!request.requestKey) throw new Error('Request key must be nonempty')
    const provider = this.providers.get(request.providerId)!
    const requestJson = canonicalJson({ providerId: request.providerId, input: request.input })
    this.assertWritable()
    const prior = this.duplicate(context, request.requestKey, requestJson, binding)
    if (prior) return Promise.resolve(this.record(prior))
    const prepared = provider.prepare(request.input)
    const inputJson = canonicalJson(prepared.input)
    if (
      !Number.isFinite(prepared.budget) ||
      prepared.budget < 0 ||
      !Array.isArray(prepared.resources) ||
      prepared.resources.some((x) => typeof x !== 'string' || !x) ||
      new Set(prepared.resources).size !== prepared.resources.length
    )
      throw new Error('Invalid provider resource or budget requirements')
    const id = randomUUID(),
      at = new Date().toISOString(),
      ownership = ownOperation(this.directory, id)
    if (!ownership) throw new Error('New operation ownership unavailable')
    let duplicate: Row | undefined
    try {
      this.transaction(() => {
        duplicate = this.duplicate(context, request.requestKey, requestJson, binding)
        if (duplicate) return
        if (this.unfinished().some((row) => row.provider_id === request.providerId &&
          row.provider_fingerprint !== this.runtime.fingerprint(provider)))
          throw new Error('Provider configuration differs from an unfinished operation; new submissions blocked')
        for (const resource of prepared.resources)
          if (this.db.prepare('SELECT operation_id FROM resources WHERE name=?').get(resource))
            throw new Error(`Resource busy: ${resource}`)
        const project = this.db
          .prepare('SELECT budget_limit,budget_unlimited,budget_used FROM projects WHERE id=?')
          .get(context.projectId) as { budget_limit: number; budget_unlimited: number; budget_used: number }
        if (!project.budget_unlimited && project.budget_used + prepared.budget > project.budget_limit)
          throw new Error('Project budget exceeded')
        this.db
          .prepare(
            'INSERT INTO operations(id,project_id,actor_id,provider_id,provider_version,provider_fingerprint,request_key,request_json,input_json,resources_json,budget,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            context.projectId,
            context.actorId,
            request.providerId,
            provider.describe().version,
            this.runtime.fingerprint(provider),
            request.requestKey,
            requestJson,
            inputJson,
            canonicalJson(prepared.resources),
            prepared.budget,
            'registered',
            at,
            at,
          )
        if (binding) this.experimentStore.register(context, binding, prepared.budget, id)
        for (const resource of prepared.resources)
          this.db.prepare('INSERT INTO resources(name,operation_id) VALUES(?,?)').run(resource, id)
        this.db
          .prepare('UPDATE projects SET budget_used=budget_used+? WHERE id=?')
          .run(prepared.budget, context.projectId)
        this.event({ id, project_id: context.projectId }, 'registered', {
          resources: prepared.resources,
          budget: prepared.budget,
          actorId: context.actorId,
        })
      })
    } catch (error) {
      ownership.close()
      throw error
    }
    if (duplicate) {
      ownership.close()
      return Promise.resolve(this.record(duplicate))
    }
    return this.owned(id, ownership, async () => {
      const row = this.row(id)
      this.transaction(() => {
        this.db
          .prepare("UPDATE operations SET state='dispatching',updated_at=? WHERE id=?")
          .run(new Date().toISOString(), id)
        this.event(row, 'dispatch-intent', {})
      })
      await this.runtime.submit(row)
      return this.record(this.row(id))
    })
  }
  /** Observe the original provider when temporary progress ownership is available; otherwise read persisted state.
   * Terminal or busy operations are never queried; an independent driver supplies their next observation.
   */
  query(context: OperationContext, id: string): Promise<OperationRecord> {
    const row = this.scoped(context, id)
    this.assertWritable()
    if (TERMINAL.has(row.state)) return Promise.resolve(this.record(row))
    const driving = this.driver?.running === true
    const progress = driving ? null : ownDriver(this.directory)
    if (!driving && !progress) return Promise.resolve(this.record(row))
    const ownership = ownOperation(this.directory, id)
    if (!ownership) {
      progress?.close()
      return Promise.resolve(this.record(this.row(id)))
    }
    return this.owned(id, ownership, async () => {
      try {
        await this.runtime.refresh(this.row(id), 'query')
        return this.record(this.row(id))
      } finally {
        progress?.close()
      }
    })
  }
  /** Reads persisted facts only. */
  get(context: OperationContext, id: string): OperationRecord {
    return this.snapshot(() => this.record(this.scoped(context, id)))
  }
  /** Read scoped operations and their artifacts in two queries within one WAL snapshot. */
  list(context: OperationContext): OperationRecord[] {
    this.authorize(context)
    if (context.allowedProviders.length === 0) return []
    return this.snapshot(() => {
      const providers = JSON.stringify(context.allowedProviders)
      const rows = this.db.prepare(`SELECT * FROM operations WHERE project_id=?
        AND provider_id IN (SELECT value FROM json_each(?)) ORDER BY created_at`).all(context.projectId, providers) as Row[]
      const outputs = this.db.prepare(`SELECT a.* FROM artifacts a JOIN operations o ON o.id=a.operation_id
        WHERE o.project_id=? AND o.provider_id IN (SELECT value FROM json_each(?)) ORDER BY a.operation_id,a.id`)
        .all(context.projectId, providers) as ArtifactRow[]
      const grouped = new Map<string, ResultArtifact[]>()
      for (const output of outputs) {
        const bucket = grouped.get(output.operation_id)
        if (bucket) bucket.push(artifactRecord(output))
        else grouped.set(output.operation_id, [artifactRecord(output)])
      }
      return rows.map(row => this.record(row, grouped.get(row.id) ?? []))
    })
  }
  /** Public capability descriptions, restricted to the current context's registered Providers. */
  descriptions(context: OperationContext) {
    this.authorize(context)
    return context.allowedProviders.map((id) => this.providers.get(id)!.describe())
  }
  /** Reconciles scoped unfinished records; never implicitly submits an uncertain operation. */
  async reconcile(context: OperationContext): Promise<OperationRecord[]> {
    this.authorize(context)
    for (const row of this.list(context)) if (!TERMINAL.has(row.state)) await this.query(context, row.id)
    return this.list(context)
  }
  /** Persist intent even during a busy submit; the driver honors it after operation ownership is released. */
  cancel(context: OperationContext, id: string): Promise<OperationRecord> {
    this.scoped(context, id)
    this.transaction(() => {
      const row = this.scoped(context, id)
      if (TERMINAL.has(row.state)) return
      this.db.prepare('UPDATE operations SET cancel_requested=1 WHERE id=?').run(id)
      this.event(row, 'cancel-requested', { actorId: context.actorId })
    })
    const row = this.row(id)
    if (TERMINAL.has(row.state)) return Promise.resolve(this.record(row))
    const ownership = ownOperation(this.directory, id)
    if (!ownership) return Promise.resolve(this.record(row))
    return this.owned(id, ownership, async () => {
      const latest = this.row(id)
      if (!TERMINAL.has(latest.state)) await this.runtime.cancel(latest)
      return this.record(this.row(id))
    })
  }
  /** Observe persisted driver state, or temporarily query originals when no driver owns progress.
   * Read-only observers only wait on persisted rows. Timeout or caller abort never cancels equipment.
   */
  wait(
    context: OperationContext,
    id: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<OperationRecord> {
    this.scoped(context, id)
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.managementAbort.signal])
      : this.managementAbort.signal
    return this.track(this.waitLoop(context, id, { ...options, signal }))
  }
  private async waitLoop(
    context: OperationContext,
    id: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<OperationRecord> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error('Invalid timeout')
    const deadline = Date.now() + options.timeoutMs
    while (true) {
      options.signal?.throwIfAborted()
      const operation = this.observing ? this.get(context, id) : await this.query(context, id)
      if (TERMINAL.has(operation.state) || operation.state === 'unknown') return operation
      if (Date.now() >= deadline) throw new Error('Operation wait timed out; equipment state unchanged')
      await delay(Math.min(this.options.pollIntervalMs, Math.max(1, deadline - Date.now())), undefined, {
        signal: options.signal,
      })
    }
  }
  /** Exports a verified artifact by identity; refuses altered or missing original bytes. */
  exportArtifact(context: OperationContext, artifactId: string, destination: string): ResultArtifact {
    this.authorize(context)
    const match = this.db.prepare('SELECT operation_id FROM artifacts WHERE id=?').get(artifactId) as
      | { operation_id: string }
      | undefined
    if (!match) throw new Error('Unknown artifact')
    const artifact = this.get(context, match.operation_id).artifacts.find((a) => a.id === artifactId)!
    const base = realpathSync(this.directory),
      path = realpathSync(resolve(base, artifact.path)),
      rel = relative(base, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact escapes execution domain')
    const bytes = readFileSync(path)
    if (
      bytes.length !== artifact.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    )
      throw new Error('Artifact integrity check failed')
    mkdirSync(dirname(resolve(destination)), { recursive: true })
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
    return artifact
  }
  /** Appends project/task facts; these records never restore process-local authorization. */
  recordFact(context: OperationContext, kind: string, data: Json): void {
    this.authorize(context)
    if (!kind) throw new Error('Fact kind must be nonempty')
    this.event({ id: '', project_id: context.projectId }, 'fact', { actorId: context.actorId, kind, data })
  }
  /** Reads durable project/task facts for a currently authorized project participant. */
  readFacts(context: OperationContext): { actorId: string; kind: string; data: Json }[] {
    this.authorize(context)
    return (
      this.db
        .prepare("SELECT data_json FROM events WHERE project_id=? AND type='fact' ORDER BY seq")
        .all(context.projectId) as { data_json: string }[]
    ).map((row) => JSON.parse(row.data_json))
  }
  /** Durable event audit restricted to the same project and allowed operation capabilities. */
  events(context: OperationContext, afterSeq = 0): unknown[] {
    this.authorize(context)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('Invalid event cursor')
    return this.db.events(context, afterSeq)
  }
  /** Read the most recent authorized event position without materializing history. */
  eventCursor(context: OperationContext): number {
    this.authorize(context)
    return this.db.cursor(context)
  }
  /** Move eligible settled audit history into the durable archive; scientific facts remain in the main store.
   * @returns Number of verified main event copies removed after the archive commit.
   */
  archiveEvents(): number {
    this.assertReady()
    return this.db.archiveEvents(this.options.retentionDays ?? 30)
  }
  /** Stops management after actual in-flight calls settle; a hung provider requires external process termination. It never cancels equipment or frees persistent resources. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (!this.ready && !this.opening) return Promise.resolve()
    this.closing = true
    this.experimentStore?.close()
    this.managementAbort.abort(new Error('Execution management stopped; equipment state unchanged'))
    return (this.closePromise = (async () => {
      if (this.opening) await this.openingFinished!.promise
      if (!this.ready) return
      try {
        await this.driver?.close()
      } finally {
        await Promise.allSettled([...this.pending])
        await this.settleProviderWork()
        this.ready = false
        this.db.close()
      }
    })())
  }
}
