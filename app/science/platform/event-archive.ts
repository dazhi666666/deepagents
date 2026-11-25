/** Durable audit copies commit independently before their main-journal rows are removed. */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OperationContext } from './sdk.ts'
import type { ExecutionDatabase } from './journal.ts'

/** Immutable raw execution event columns; sequence numbers are shared by both journals. */
export type AuditEvent = {
  seq: number
  operation_id: string | null
  project_id: string | null
  type: string
  data_json: string
  at: string
}
type Scope = Pick<OperationContext, 'projectId' | 'allowedProviders'>
type DomainRow = { value: string }
type CursorRow = { cursor: number }
type ProviderRow = { provider_id: string }

const columns = 'seq,operation_id,project_id,type,data_json,at'
const visible = `e.project_id=? AND (e.operation_id IS NULL OR e.operation_id='' OR EXISTS (
  SELECT 1 FROM operations o WHERE o.id=e.operation_id AND o.project_id=e.project_id
  AND o.provider_id IN (SELECT value FROM json_each(?))))`

function domain(main: ExecutionDatabase): string {
  const row = main.prepare("SELECT value FROM execution_meta WHERE key='domainId'").get() as DomainRow | undefined
  if (!row || typeof row.value !== 'string' || !row.value) throw new Error('Execution domainId is missing')
  return row.value
}

function checkArchive(archive: DatabaseSync, domainId: string): void {
  const version = archive.prepare('PRAGMA user_version').get() as { user_version: number }
  if (version.user_version !== 1) throw new Error(`Unsupported audit archive schema ${version.user_version}`)
  const row = archive.prepare("SELECT value FROM archive_meta WHERE key='domainId'").get() as DomainRow | undefined
  if (!row || row.value !== domainId) throw new Error('Audit archive domainId mismatch')
}

function same(expected: AuditEvent, actual: AuditEvent | undefined): void {
  if (!actual || expected.seq !== actual.seq || expected.operation_id !== actual.operation_id ||
    expected.project_id !== actual.project_id || expected.type !== actual.type ||
    expected.data_json !== actual.data_json || expected.at !== actual.at)
    throw new Error(`Audit archive event collision at sequence ${expected.seq}`)
}

function permission(main: ExecutionDatabase, scope: Scope): (event: AuditEvent) => boolean {
  const providers = new Set(scope.allowedProviders), cache = new Map<string, boolean>()
  const operation = main.prepare('SELECT provider_id FROM operations WHERE id=? AND project_id=?')
  return (event) => {
    if (event.project_id !== scope.projectId) return false
    if (event.operation_id === null || event.operation_id === '') return true
    let allowed = cache.get(event.operation_id)
    if (allowed === undefined) {
      const row = operation.get(event.operation_id, scope.projectId) as ProviderRow | undefined
      allowed = row !== undefined && providers.has(row.provider_id)
      cache.set(event.operation_id, allowed)
    }
    return allowed
  }
}

/** Archives audit history without moving the operation rows that supply current permissions. */
export class EventArchive {
  private readonly path: string
  constructor(directory: string) {
    this.path = resolve(directory, 'events-archive.sqlite')
  }

  /** Copy eligible terminal experiment events durably, then delete their exact main copies.
   * The caller owns controller serialization and an existing BEGIN IMMEDIATE transaction on main.
   * On failure the caller must roll back main; an already committed archive copy remains safe to retry.
   * @param main Schema-v4 execution journal with a stable execution_meta.domainId.
   * @param cutoffIso Canonical UTC ISO timestamp, inclusive for event and experiment closure times.
   * @returns Number of main events removed, including previously copied rows from an interrupted attempt.
   */
  archive(main: ExecutionDatabase, cutoffIso: string): number {
    if (!main.isTransaction) throw new Error('Audit archiving requires an existing main write transaction')
    const cutoff = new Date(cutoffIso)
    if (!Number.isFinite(cutoff.getTime()) || cutoff.toISOString() !== cutoffIso)
      throw new Error('Invalid archive cutoff: expected canonical UTC ISO timestamp')
    const rows = main.prepare(`WITH eligible AS (
      SELECT v.experiment_id,x.project_id FROM experiment_view v JOIN experiments x ON x.id=v.experiment_id
      WHERE v.state IN ('completed','cancelled') AND v.closed_at<=?
    ) SELECT e.* FROM events e WHERE e.at<=? AND e.type<>'fact' AND (
      (e.type GLOB 'experiment-*' AND EXISTS (
        SELECT 1 FROM eligible x WHERE x.project_id=e.project_id
        AND json_type(e.data_json,'$.experimentId')='text'
        AND json_extract(e.data_json,'$.experimentId')=x.experiment_id))
      OR (e.type NOT GLOB 'experiment-*' AND EXISTS (
        SELECT 1 FROM experiment_steps s JOIN eligible x ON x.experiment_id=s.experiment_id
        JOIN operations o ON o.id=s.operation_id
        WHERE s.operation_id=e.operation_id AND x.project_id=e.project_id AND o.project_id=e.project_id))
    ) ORDER BY e.seq`).all(cutoffIso, cutoffIso) as AuditEvent[]
    if (rows.length === 0) return 0
    const domainId = domain(main), exists = statSync(this.path, { throwIfNoEntry: false }) !== undefined
    const archive = new DatabaseSync(this.path)
    try {
      archive.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
      if (!exists) {
        archive.exec(`CREATE TABLE archive_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE events(seq INTEGER PRIMARY KEY,operation_id TEXT,project_id TEXT,
            type TEXT NOT NULL,data_json TEXT NOT NULL,at TEXT NOT NULL);
          CREATE INDEX events_project_seq ON events(project_id,seq);
          PRAGMA user_version=1`)
        archive.prepare("INSERT INTO archive_meta(key,value) VALUES('domainId',?)").run(domainId)
      }
      checkArchive(archive, domainId)
      const insert = archive.prepare(`INSERT INTO events(${columns}) VALUES(?,?,?,?,?,?) ON CONFLICT(seq) DO NOTHING`)
      const copied = archive.prepare(`SELECT ${columns} FROM events WHERE seq=?`)
      for (const row of rows)
        insert.run(row.seq, row.operation_id, row.project_id, row.type, row.data_json, row.at)
      for (const row of rows) same(row, copied.get(row.seq) as AuditEvent | undefined)
      archive.exec('COMMIT')
    } finally {
      archive.close() // Closing rolls back an incomplete archive transaction.
    }
    const remove = main.prepare(`DELETE FROM events WHERE seq=? AND operation_id IS ? AND project_id IS ?
      AND type IS ? AND data_json IS ? AND at IS ?`)
    for (const row of rows) {
      if (remove.run(row.seq, row.operation_id, row.project_id, row.type, row.data_json, row.at).changes !== 1)
        throw new Error(`Archived main event changed at sequence ${row.seq}`)
    }
    return rows.length
  }

  private read<T>(domainId: string, absent: T, body: (archive: DatabaseSync) => T): T {
    if (statSync(this.path, { throwIfNoEntry: false }) === undefined) return absent
    const archive = new DatabaseSync(this.path, { readOnly: true })
    try {
      archive.exec('PRAGMA query_only=ON; BEGIN')
      checkArchive(archive, domainId)
      return body(archive)
    } finally {
      archive.close()
    }
  }

  /** Read both journals in sequence order using current main-operation permissions.
   * The caller validates the live context and holds a synchronous main read snapshot throughout.
   * @param main Schema-v4 journal; it is read before checking whether the archive exists.
   * @param scope Current project and provider permissions.
   * @param afterSeq Exclusive sequence cursor.
   * @returns Raw permitted events with identical copies deduplicated; conflicting copies throw.
   */
  events(main: ExecutionDatabase, scope: Scope, afterSeq: number): AuditEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('Invalid event cursor')
    const rows = main.prepare(`SELECT e.* FROM events e WHERE ${visible} AND e.seq>? ORDER BY e.seq`)
      .all(scope.projectId, JSON.stringify(scope.allowedProviders), afterSeq) as AuditEvent[]
    const domainId = domain(main)
    return this.read(domainId, rows, (archive) => {
      const findCopy = archive.prepare(`SELECT ${columns} FROM events WHERE seq=?`)
      for (const row of rows) {
        const copy = findCopy.get(row.seq) as AuditEvent | undefined
        if (copy) same(row, copy)
      }
      const allowed = permission(main, scope), bySeq = new Map(rows.map((row) => [row.seq, row]))
      const findMain = main.prepare(`SELECT ${columns} FROM events WHERE seq=?`)
      const archived = archive.prepare(`SELECT ${columns} FROM events WHERE project_id=? AND seq>? ORDER BY seq`)
      for (const row of archived.iterate(scope.projectId, afterSeq) as Iterable<AuditEvent>) {
        const live = findMain.get(row.seq) as AuditEvent | undefined
        if (live) same(row, live)
        if (allowed(row) && !bySeq.has(row.seq)) bySeq.set(row.seq, row)
      }
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    })
  }

  /** Read the latest permitted sequence without materializing audit history.
   * The caller validates the live context and holds a synchronous main read snapshot throughout.
   * @param main Schema-v4 journal; its maximum is read before checking for an archive.
   * @param scope Current project and provider permissions.
   * @returns Maximum visible sequence across both journals, or zero when empty.
   */
  cursor(main: ExecutionDatabase, scope: Scope): number {
    const { cursor } = main.prepare(`SELECT COALESCE(MAX(e.seq),0) AS cursor FROM events e WHERE ${visible}`)
      .get(scope.projectId, JSON.stringify(scope.allowedProviders)) as CursorRow
    const domainId = domain(main)
    return this.read(domainId, cursor, (archive) => {
      const findMain = main.prepare(`SELECT ${columns} FROM events WHERE seq=?`)
      const copy = archive.prepare(`SELECT ${columns} FROM events WHERE seq=?`).get(cursor) as AuditEvent | undefined
      if (copy) same(copy, findMain.get(cursor) as AuditEvent | undefined)
      const allowed = permission(main, scope)
      const archived = archive.prepare(`SELECT ${columns} FROM events WHERE project_id=? ORDER BY seq DESC`)
      for (const row of archived.iterate(scope.projectId) as Iterable<AuditEvent>) {
        const live = findMain.get(row.seq) as AuditEvent | undefined
        if (live) same(row, live)
        if (row.seq <= cursor) break
        if (allowed(row)) return row.seq
      }
      return cursor
    })
  }
}
