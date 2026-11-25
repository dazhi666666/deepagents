/** Execution database ownership, schema migration, prepared statements, transactions and audit access. */
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalJson, type Json, type OperationContext, type OperationRecord } from './sdk.ts'
import { EXPERIMENT_SCHEMA } from './experiments.ts'
import { ExperimentProjection, EXPERIMENT_PROJECTION_SCHEMA } from './experiment-projection.ts'
import { EventArchive } from './event-archive.ts'
import { Controller, Observer } from './lifecycle.ts'

/** Current fork-owned execution format; older writers must reject this version. */
export const EXECUTION_SCHEMA_VERSION = 4
export type ExecutionMode = 'controller' | 'observer' | 'driver'
/** SQLite operations needed by projections and audit readers, without connection ownership. */
export type ExecutionDatabase = Pick<DatabaseSync, 'prepare' | 'exec' | 'isTransaction'>
/** Stored operation fields shared with the Provider observation layer. */
export interface OperationRow extends Record<string, SQLOutputValue> {
  id: string; project_id: string; actor_id: string; provider_id: string; provider_version: string
  provider_fingerprint: string; request_key: string; request_json: string; input_json: string
  resources_json: string; budget: number; state: OperationRecord['state']; cancel_requested: number
  progress_json: string | null; detail: string | null; created_at: string; updated_at: string
}
type Subject = Pick<OperationRow, 'id' | 'project_id'> | null

/** One connection owns its statements; only SQL programs, never results or grants, are cached. */
export class ExecutionJournal implements ExecutionDatabase {
  private readonly statements = new Map<string, StatementSync>()
  private readonly archive: EventArchive
  private writing = false
  private closed = false
  private constructor(
    private readonly connection: DatabaseSync,
    private readonly controller: Controller | undefined,
    directory: string,
    private readonly logicalTick: (() => number) | undefined,
  ) { this.archive = new EventArchive(directory) }

  /** Open/migrate a writer or attach a readonly observer; failed initialization closes both handles.
   * @param directory Execution domain directory.
   * @param mode Connection purpose; observers never initialize schema or ownership files.
   * @param timeoutMs Controller write-lock wait budget.
   * @param logicalTick Optional domain-owned audit position; omitted leaves event metadata unchanged.
   * @returns The caller-owned journal.
   */
  static open(directory: string, mode: ExecutionMode, timeoutMs: number, logicalTick?: () => number): ExecutionJournal {
    if (mode === 'observer') return new ExecutionJournal(Observer.open(directory, EXECUTION_SCHEMA_VERSION), undefined, directory, logicalTick)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const controller = new Controller(directory, timeoutMs)
    let connection: DatabaseSync | undefined
    try {
      return controller.write(() => {
        connection = new DatabaseSync(resolve(directory, 'execution.sqlite'))
        const journal = new ExecutionJournal(connection, controller, directory, logicalTick)
        journal.migrate()
        return journal
      })
    } catch (error) {
      try { connection?.close() } finally { controller.close() }
      throw error
    }
  }

  /** Compile each owned SQL program once for this connection.
   * @param sql Static SQL program; bound parameters and result data are never cached.
   * @returns The connection's prepared statement.
   */
  prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const statement = this.connection.prepare(sql)
    this.statements.set(sql, statement)
    return statement
  }
  /** Execute connection/schema SQL without preparing a cached program.
   * @param sql SQL to execute.
   */
  exec(sql: string): void { this.connection.exec(sql) }
  /** Whether a read or write transaction is open on this connection. */
  get isTransaction(): boolean { return this.connection.isTransaction }
  /** Fail before any writer-only operation on a readonly connection. */
  assertWritable(): void {
    if (!this.controller) throw new Error('Observer is read-only; use a temporary controller for mutations')
  }
  /** Serialize synchronous facts and projection writes; nested calls join the current write transaction.
   * @param body Synchronous mutation, never an asynchronous callback.
   * @returns Its value after commit.
   */
  transaction<T>(body: () => T): T {
    this.assertWritable()
    if (this.writing) return body()
    if (this.isTransaction) throw new Error('Cannot mutate a read snapshot')
    return this.controller!.write(() => {
      this.exec('BEGIN IMMEDIATE'); this.writing = true
      try { const result = body(); this.exec('COMMIT'); return result }
      catch (error) { this.exec('ROLLBACK'); throw error }
      finally { this.writing = false }
    })
  }
  /** Read a synchronous WAL snapshot; existing write/read transactions are reused.
   * @param read Synchronous reads; asynchronous callbacks are not snapshot-scoped.
   * @returns Its synchronous value.
   */
  snapshot<T>(read: () => T): T {
    if (this.isTransaction) return read()
    this.exec('BEGIN')
    try { return read() } finally { this.exec('ROLLBACK') }
  }
  /** Append audit inside the fact writer's transaction.
   * @param subject Related operation/project, or null for domain metadata.
   * @param type Event discriminator.
   * @param data JSON event payload.
   */
  event(subject: Subject, type: string, data: Json): void {
    if (!this.writing) return this.transaction(() => this.event(subject, type, data))
    const tick = this.logicalTick?.()
    if (tick !== undefined && (!Number.isSafeInteger(tick) || tick < 0)) throw new Error('Invalid domain logical tick')
    const timed = tick !== undefined && data !== null && typeof data === 'object' && !Array.isArray(data) ? { ...data, logicalTick: tick } : data
    this.prepare('INSERT INTO events(operation_id,project_id,type,data_json,at) VALUES(?,?,?,?,?)')
      .run(subject?.id ?? null, subject?.project_id ?? null, type, canonicalJson(timed), new Date().toISOString())
  }
  /** Read both audit stores; the engine has already validated this live scope.
   * @param scope Current project/provider grants.
   * @param after Exclusive audit cursor.
   * @returns Authorized raw events in sequence order.
   */
  events(scope: OperationContext, after: number) { return this.snapshot(() => this.archive.events(this, scope, after)) }
  /** Read the most recent authorized audit sequence.
   * @param scope Current project/provider grants.
   * @returns Latest permitted sequence, or zero.
   */
  cursor(scope: OperationContext): number { return this.snapshot(() => this.archive.cursor(this, scope)) }
  /** Archive only verified terminal audit old enough for retention.
   * @param retentionDays Minimum experiment closure and event age in days.
   * @returns Number of durable main copies removed after archive commit.
   */
  archiveEvents(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()
    return this.transaction(() => this.archive.archive(this, cutoff))
  }
  /** Close only after Provider work settles; no cached statement survives its connection. */
  close(): void {
    if (this.closed) return
    this.closed = true; this.statements.clear()
    try { this.connection.close() } finally { this.controller?.close() }
  }

  private migrate(): void {
    this.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;')
    const version = (this.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (![0, 1, 2, 3, EXECUTION_SCHEMA_VERSION].includes(version)) throw new Error(`Unsupported execution schema ${version}`)
    this.exec('BEGIN IMMEDIATE')
    try {
      this.exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,budget_limit REAL NOT NULL,budget_used REAL NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),actor_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_version TEXT NOT NULL,provider_fingerprint TEXT NOT NULL,request_key TEXT NOT NULL,request_json TEXT NOT NULL,input_json TEXT NOT NULL,resources_json TEXT NOT NULL,budget REAL NOT NULL,state TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,progress_json TEXT,detail TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_key));
        CREATE TABLE IF NOT EXISTS resources(name TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id));
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id),path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,media_type TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,project_id TEXT,type TEXT NOT NULL,data_json TEXT NOT NULL,at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS execution_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        ${EXPERIMENT_SCHEMA}
        ${EXPERIMENT_PROJECTION_SCHEMA}`)
      if (!this.prepare('PRAGMA table_info(projects)').all().some(column => column.name === 'budget_unlimited'))
        this.exec('ALTER TABLE projects ADD COLUMN budget_unlimited INTEGER NOT NULL DEFAULT 0 CHECK(budget_unlimited IN (0,1))')
      if (!this.prepare("SELECT value FROM execution_meta WHERE key='domainId'").get()) {
        if (version === EXECUTION_SCHEMA_VERSION) throw new Error('Execution domain identity is missing')
        this.prepare("INSERT INTO execution_meta(key,value) VALUES('domainId',?)").run(randomUUID())
      }
      if (version < EXECUTION_SCHEMA_VERSION) new ExperimentProjection(this).backfill()
      else if (this.prepare(`SELECT e.id FROM experiments e LEFT JOIN experiment_view v ON v.experiment_id=e.id
        WHERE v.experiment_id IS NULL LIMIT 1`).get()) throw new Error('Experiment projection missing from current execution schema')
      this.exec(`PRAGMA user_version=${EXECUTION_SCHEMA_VERSION}; COMMIT`)
    } catch (error) { if (this.isTransaction) this.exec('ROLLBACK'); throw error }
  }
}
