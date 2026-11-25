import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EventArchive, type AuditEvent } from './event-archive.ts'
import type { Json, OperationContext } from './sdk.ts'

const old = '2026-01-01T00:00:00.000Z', cutoff = '2026-01-02T00:00:00.000Z', later = '2026-01-03T00:00:00.000Z'
const scope: Pick<OperationContext, 'projectId' | 'allowedProviders'> = { projectId: 'p', allowedProviders: ['yes'] }
const fixtures: { directory: string; connections: DatabaseSync[] }[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    for (const db of fixture.connections.reverse()) if (db.isOpen) db.close()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'ai4s-event-archive-')), connections: DatabaseSync[] = []
  fixtures.push({ directory, connections })
  const main = new DatabaseSync(join(directory, 'execution.sqlite'))
  connections.push(main)
  main.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE execution_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),provider_id TEXT NOT NULL);
    CREATE TABLE experiments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id));
    CREATE TABLE experiment_view(experiment_id TEXT PRIMARY KEY REFERENCES experiments(id),state TEXT NOT NULL,
      reason TEXT NOT NULL,cursor INTEGER NOT NULL,budget_used REAL NOT NULL,provider_bindings_json TEXT NOT NULL,
      last_issue_json TEXT,projection_seq INTEGER NOT NULL,closed_at TEXT);
    CREATE TABLE experiment_steps(operation_id TEXT PRIMARY KEY REFERENCES operations(id),
      experiment_id TEXT NOT NULL REFERENCES experiments(id));
    CREATE TABLE experiment_assessments(id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL REFERENCES experiments(id),data_json TEXT NOT NULL);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id));
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT,project_id TEXT,
      type TEXT NOT NULL,data_json TEXT NOT NULL,at TEXT NOT NULL);
    INSERT INTO projects VALUES('p'),('q'); PRAGMA user_version=4`)
  main.prepare("INSERT INTO execution_meta VALUES('domainId',?)").run(randomUUID())
  return { directory, main, connections, archive: new EventArchive(directory), path: join(directory, 'events-archive.sqlite') }
}
type Fixture = ReturnType<typeof setup>

function experiment(f: Fixture, id: string, state = 'completed', closedAt: string | null = old, project = 'p') {
  f.main.prepare('INSERT INTO experiments VALUES(?,?)').run(id, project)
  f.main.prepare('INSERT INTO experiment_view VALUES(?,?,?,0,0,?,NULL,0,?)').run(id, state, 'test', '{}', closedAt)
}
function operation(f: Fixture, id: string, experimentId?: string, provider = 'yes', project = 'p') {
  f.main.prepare('INSERT INTO operations VALUES(?,?,?)').run(id, project, provider)
  if (experimentId !== undefined) f.main.prepare('INSERT INTO experiment_steps VALUES(?,?)').run(id, experimentId)
}
function event(f: Fixture, input: { operationId?: string | null; projectId?: string | null; type?: string; data?: Json; at?: string } = {}): AuditEvent {
  const result = f.main.prepare('INSERT INTO events(operation_id,project_id,type,data_json,at) VALUES(?,?,?,?,?)')
    .run(input.operationId === undefined ? null : input.operationId, input.projectId === undefined ? 'p' : input.projectId,
      input.type ?? 'registered', JSON.stringify(input.data ?? {}), input.at ?? old)
  return f.main.prepare('SELECT * FROM events WHERE seq=?').get(result.lastInsertRowid) as AuditEvent
}
function snapshot<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN')
  try { return body() } finally { db.exec('ROLLBACK') }
}
function archive(f: Fixture): number {
  f.main.exec('BEGIN IMMEDIATE')
  try {
    const count = f.archive.archive(f.main, cutoff)
    f.main.exec('COMMIT')
    return count
  } catch (error) {
    f.main.exec('ROLLBACK')
    throw error
  }
}
function audit(f: Fixture, permissions = scope, afterSeq = 0): AuditEvent[] {
  return snapshot(f.main, () => f.archive.events(f.main, permissions, afterSeq))
}
function cursor(f: Fixture, permissions = scope): number {
  return snapshot(f.main, () => f.archive.cursor(f.main, permissions))
}
function mainRows(f: Fixture): AuditEvent[] {
  return f.main.prepare('SELECT * FROM events ORDER BY seq').all() as AuditEvent[]
}
function archivedRows(f: Fixture): AuditEvent[] {
  const db = new DatabaseSync(f.path, { readOnly: true })
  try { return db.prepare('SELECT * FROM events ORDER BY seq').all() as AuditEvent[] } finally { db.close() }
}
function mutateArchive(f: Fixture, body: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(f.path)
  try { body(db) } finally { db.close() }
}
function observer(f: Fixture): DatabaseSync {
  const db = new DatabaseSync(join(f.directory, 'execution.sqlite'), { readOnly: true })
  f.connections.push(db)
  db.exec('PRAGMA query_only=ON')
  return db
}

describe('durable event archive', () => {
  it('archives only closed terminal experiments and linked operation events at the inclusive cutoff', () => {
    const f = setup()
    experiment(f, 'done')
    experiment(f, 'cancelled', 'cancelled', cutoff)
    experiment(f, 'active', 'running')
    experiment(f, 'review', 'review_required')
    experiment(f, 'future', 'completed', later)
    experiment(f, 'no-closure', 'completed', null)
    experiment(f, 'other-project', 'completed', old, 'q')
    for (const id of ['done', 'cancelled', 'active', 'review', 'future', 'no-closure']) operation(f, id, id)
    operation(f, 'standalone')
    operation(f, 'wrong-project', 'done', 'yes', 'q')
    f.main.exec("INSERT INTO artifacts VALUES('artifact','done'); INSERT INTO experiment_assessments VALUES('assessment','done','{}')")
    const expected = [
      event(f, { type: 'experiment-completed', data: { experimentId: 'done' }, at: cutoff }),
      event(f, { operationId: 'done' }),
      event(f, { operationId: '', type: 'experiment-cancelled', data: { experimentId: 'cancelled' }, at: cutoff }),
      event(f, { operationId: 'cancelled', type: 'recovery', at: cutoff }),
    ]
    event(f, { operationId: 'done', at: later })
    event(f, { type: 'experiment-completed', data: { experimentId: 'done' }, at: later })
    for (const id of ['active', 'review', 'future', 'no-closure']) {
      event(f, { operationId: id })
      event(f, { type: 'experiment-progress', data: { experimentId: id } })
    }
    event(f, { operationId: 'standalone' })
    event(f, { operationId: 'wrong-project', projectId: 'q' })
    event(f, { type: 'experiment-progress', data: { experimentId: 'other-project' } })
    event(f, { type: 'experiment-progress', data: { nested: { experimentId: 'done' } } })
    event(f, { operationId: 'done', type: 'experiment-progress', data: { experimentId: 'active' } })
    event(f, { type: 'project-created', operationId: '' })
    event(f, { type: 'artifact-index', operationId: '' })
    event(f, { type: 'member-granted', operationId: null })
    event(f, { operationId: 'done', type: 'fact', data: { experimentId: 'done', kind: 'artifact' } })
    event(f, { type: 'fact', data: { kind: 'member' } })
    const before = mainRows(f)
    const retainedTables = ['operations', 'artifacts', 'experiment_steps', 'experiment_assessments', 'experiments', 'experiment_view']
    const retained = retainedTables.map((table) => f.main.prepare(`SELECT * FROM ${table}`).all())
    expect(archive(f)).toBe(expected.length)
    expect(archivedRows(f)).toEqual(expected)
    expect(mainRows(f)).toEqual(before.filter((row) => !expected.some((copy) => copy.seq === row.seq)))
    expect(retainedTables.map((table) => f.main.prepare(`SELECT * FROM ${table}`).all())).toEqual(retained)
    expect(archive(f)).toBe(0)
  })

  it('keeps readers and empty archive attempts free of file creation', () => {
    const f = setup(), read = observer(f)
    experiment(f, 'active', 'running', null)
    const row = event(f, { type: 'experiment-progress', data: { experimentId: 'active' } })
    const files = readdirSync(f.directory).sort()
    expect(snapshot(read, () => f.archive.events(read, scope, 0))).toEqual([row])
    expect(snapshot(read, () => f.archive.cursor(read, scope))).toBe(row.seq)
    const missingDirectory = join(f.directory, 'not-created'), missing = new EventArchive(missingDirectory)
    expect(snapshot(read, () => missing.events(read, scope, 0))).toEqual([row])
    expect(snapshot(read, () => missing.cursor(read, scope))).toBe(row.seq)
    expect(existsSync(missingDirectory)).toBe(false)
    expect(readdirSync(f.directory).sort()).toEqual(files)
    expect(archive(f)).toBe(0)
    expect(existsSync(f.path)).toBe(false)
    expect(() => f.archive.archive(f.main, cutoff)).toThrow('existing main write transaction')
    expect(() => f.archive.events(read, scope, -1)).toThrow('Invalid event cursor')
    expect(cursor(f, { projectId: 'empty', allowedProviders: [] })).toBe(0)
  })

  it('combines journals under current project/provider permissions and preserves generic visibility', () => {
    const f = setup()
    experiment(f, 'done')
    experiment(f, 'q-done', 'completed', old, 'q')
    operation(f, 'yes', 'done')
    operation(f, 'no', 'done', 'no')
    operation(f, 'changed', 'done')
    operation(f, 'q-op', undefined, 'yes', 'q')
    operation(f, 'standalone-no', undefined, 'no')
    const genericMain = event(f, { type: 'fact', operationId: '' })
    const genericNull = event(f, { type: 'experiment-completed', data: { experimentId: 'done' } })
    const yes = event(f, { operationId: 'yes' })
    event(f, { operationId: 'no' })
    const genericEmpty = event(f, { operationId: '', type: 'experiment-completed', data: { experimentId: 'done' } })
    event(f, { operationId: 'q-op', type: 'experiment-completed', data: { experimentId: 'done' } })
    event(f, { operationId: 'missing', type: 'experiment-completed', data: { experimentId: 'done' } })
    const q = event(f, { projectId: 'q', type: 'experiment-completed', data: { experimentId: 'q-done' } })
    event(f, { operationId: 'standalone-no' })
    const changed = event(f, { operationId: 'changed' })
    event(f, { projectId: null, type: 'fact' })
    const expected = [genericMain, genericNull, yes, genericEmpty]
    expect(archive(f)).toBe(8)
    f.main.prepare("UPDATE operations SET provider_id='no' WHERE id='changed'").run()
    expect(audit(f)).toEqual(expected)
    expect(audit(f, { ...scope, allowedProviders: [] })).toEqual([genericMain, genericNull, genericEmpty])
    expect(audit(f, scope, yes.seq)).toEqual([genericEmpty])
    expect(cursor(f)).toBe(genericEmpty.seq)
    expect(cursor(f, { ...scope, allowedProviders: [] })).toBe(genericEmpty.seq)
    expect(cursor(f, { ...scope, allowedProviders: ['no'] })).toBe(changed.seq)
    expect(audit(f, { projectId: 'q', allowedProviders: [] })).toEqual([q])
    expect(cursor(f, { projectId: 'q', allowedProviders: [] })).toBe(q.seq)
    const manyProviders = { ...scope, allowedProviders: [...Array.from({ length: 40000 }, (_, i) => `provider-${i}`), 'yes'] }
    expect(audit(f, manyProviders)).toEqual(expected)
    expect(cursor(f, manyProviders)).toBe(genericEmpty.seq)
  })

  it.each(['events', 'cursor'] as const)('sees archives created after the readonly observer starts in %s reads', (method) => {
    const f = setup(), read = observer(f)
    experiment(f, 'done')
    const row = event(f, { type: 'experiment-completed', data: { experimentId: 'done' } })
    expect(snapshot(read, () => f.archive[method](read, scope, 0))).toEqual(method === 'events' ? [row] : row.seq)
    expect(existsSync(f.path)).toBe(false)
    expect(archive(f)).toBe(1)
    expect(mainRows(f)).toEqual([])
    const files = readdirSync(f.directory).sort(), copies = archivedRows(f)
    expect(snapshot(read, () => f.archive[method](read, scope, 0))).toEqual(method === 'events' ? [row] : row.seq)
    expect(snapshot(read, () => f.archive.events(read, scope, 0))).toEqual([row])
    expect(snapshot(read, () => f.archive.cursor(read, scope))).toBe(row.seq)
    expect(readdirSync(f.directory).sort()).toEqual(files)
    expect(archivedRows(f)).toEqual(copies)
  })

  it('keeps an old main snapshot complete while a controller archives its rows', () => {
    const f = setup(), read = observer(f)
    experiment(f, 'done')
    const row = event(f, { type: 'experiment-completed', data: { experimentId: 'done' } })
    read.exec('BEGIN')
    try {
      expect(read.prepare('SELECT * FROM events').all()).toEqual([row])
      expect(archive(f)).toBe(1)
      expect(f.archive.events(read, scope, 0)).toEqual([row])
      expect(f.archive.cursor(read, scope)).toBe(row.seq)
    } finally { read.exec('ROLLBACK') }
    expect(mainRows(f)).toEqual([])
  })

  it('retains durable copies across main rollback, deduplicates on retry, and preserves sequence cursors', () => {
    const f = setup()
    experiment(f, 'done')
    operation(f, 'op', 'done')
    event(f, { type: 'fact' })
    event(f, { type: 'experiment-completed', data: { experimentId: 'done' } })
    const last = event(f, { operationId: 'op' }), expected = audit(f)
    f.main.exec('BEGIN IMMEDIATE')
    try {
      expect(f.archive.archive(f.main, cutoff)).toBe(2)
      expect(mainRows(f)).toHaveLength(1)
      expect(archivedRows(f)).toEqual(expected.slice(1))
      expect(f.archive.events(f.main, scope, 0)).toEqual(expected)
      expect(f.archive.cursor(f.main, scope)).toBe(last.seq)
    } finally { f.main.exec('ROLLBACK') }
    expect(mainRows(f)).toEqual(expected)
    expect(audit(f)).toEqual(expected)
    expect(cursor(f)).toBe(last.seq)
    expect(archive(f)).toBe(2)
    expect(mainRows(f)).toHaveLength(1)
    expect(archivedRows(f)).toEqual(expected.slice(1))
    expect(audit(f)).toEqual(expected)
    expect(cursor(f)).toBe(last.seq)
    const next = event(f, { type: 'fact', at: later })
    expect(next.seq).toBe(last.seq + 1)
    expect(audit(f, scope, last.seq)).toEqual([next])
    expect(cursor(f)).toBe(next.seq)
  })

  it('verifies the entire copied batch before committing any archive changes', () => {
    const f = setup()
    experiment(f, 'done')
    const seed = event(f, { type: 'experiment-created', data: { experimentId: 'done' } })
    expect(archive(f)).toBe(1)
    const first = event(f, { type: 'experiment-started', data: { experimentId: 'done' } })
    const last = event(f, { type: 'experiment-completed', data: { experimentId: 'done' } })
    mutateArchive(f, (db) => db.exec(`CREATE TRIGGER change_previous_copy AFTER INSERT ON events WHEN NEW.seq=${last.seq}
      BEGIN UPDATE events SET data_json='{"changed":true}' WHERE seq=${first.seq}; END`))
    expect(() => archive(f)).toThrow('event collision')
    expect(mainRows(f)).toEqual([first, last])
    expect(archivedRows(f)).toEqual([seed])
    mutateArchive(f, (db) => db.exec('DROP TRIGGER change_previous_copy'))
    expect(archive(f)).toBe(2)
    expect(audit(f)).toEqual([seed, first, last])
  })

  it('deletes only exact verified main rows after the archive commit', () => {
    const f = setup()
    experiment(f, 'done')
    const first = event(f, { type: 'experiment-started', data: { experimentId: 'done' } })
    const second = event(f, { type: 'experiment-completed', data: { experimentId: 'done' } })
    f.main.exec(`CREATE TRIGGER change_next_event AFTER DELETE ON events WHEN OLD.seq=${first.seq}
      BEGIN UPDATE events SET data_json='{"changed":true}' WHERE seq=${second.seq}; END`)
    expect(() => archive(f)).toThrow('Archived main event changed')
    expect(mainRows(f)).toEqual([first, second])
    expect(archivedRows(f)).toEqual([first, second])
    f.main.exec('DROP TRIGGER change_next_event')
    expect(archive(f)).toBe(2)
    expect(audit(f)).toEqual([first, second])
  })

  it.each([
    ['operation_id', 'missing'], ['project_id', 'q'], ['type', 'changed'],
    ['data_json', '{"changed":true}'], ['at', later],
  ])('rejects a changed %s copy and rolls back earlier archive inserts', (column, value) => {
    const f = setup()
    experiment(f, 'waiting', 'running')
    experiment(f, 'done')
    const first = event(f, { type: 'experiment-completed', data: { experimentId: 'waiting' } })
    const conflicting = event(f, { type: 'experiment-completed', data: { experimentId: 'done' } })
    f.main.exec('BEGIN IMMEDIATE')
    try { expect(f.archive.archive(f.main, cutoff)).toBe(1) } finally { f.main.exec('ROLLBACK') }
    f.main.exec("UPDATE experiment_view SET state='completed' WHERE experiment_id='waiting'")
    mutateArchive(f, (db) => db.prepare(`UPDATE events SET ${column}=? WHERE seq=?`).run(value!, conflicting.seq))
    const changedCopy = archivedRows(f)
    expect(() => audit(f)).toThrow('event collision')
    expect(() => cursor(f)).toThrow('event collision')
    expect(() => archive(f)).toThrow('event collision')
    expect(mainRows(f)).toEqual([first, conflicting])
    expect(archivedRows(f)).toEqual(changedCopy)
    mutateArchive(f, (db) => db.prepare('UPDATE events SET operation_id=?,project_id=?,type=?,data_json=?,at=? WHERE seq=?')
      .run(conflicting.operation_id, conflicting.project_id, conflicting.type, conflicting.data_json, conflicting.at, conflicting.seq))
    expect(archive(f)).toBe(2)
    expect(archivedRows(f)).toEqual([first, conflicting])
  })

  it('rejects another domain without changing main or rebinding archive metadata', () => {
    const f = setup()
    experiment(f, 'done')
    const row = event(f, { type: 'experiment-completed', data: { experimentId: 'done' } })
    f.main.exec('BEGIN IMMEDIATE')
    try { f.archive.archive(f.main, cutoff) } finally { f.main.exec('ROLLBACK') }
    const foreignDomain = randomUUID()
    mutateArchive(f, (db) => db.prepare("UPDATE archive_meta SET value=? WHERE key='domainId'").run(foreignDomain))
    expect(() => audit(f)).toThrow('domainId mismatch')
    expect(() => cursor(f)).toThrow('domainId mismatch')
    expect(() => archive(f)).toThrow('domainId mismatch')
    expect(mainRows(f)).toEqual([row])
    mutateArchive(f, (db) => expect(db.prepare("SELECT value FROM archive_meta WHERE key='domainId'").get()).toEqual({ value: foreignDomain }))
  })

  it.each(['bytes', 'schema'])('fails loudly on archive %s corruption without deleting main rows', (kind) => {
    const f = setup()
    experiment(f, 'done')
    const row = event(f, { type: 'experiment-completed', data: { experimentId: 'done' } })
    if (kind === 'bytes') writeFileSync(f.path, 'damaged sqlite archive')
    else mutateArchive(f, (db) => {
      db.exec('CREATE TABLE archive_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1')
      const domainId = f.main.prepare("SELECT value FROM execution_meta WHERE key='domainId'").get() as { value: string }
      db.prepare("INSERT INTO archive_meta VALUES('domainId',?)").run(domainId.value)
    })
    expect(() => audit(f)).toThrow()
    expect(() => cursor(f)).toThrow()
    expect(() => archive(f)).toThrow()
    expect(mainRows(f)).toEqual([row])
  })
})
