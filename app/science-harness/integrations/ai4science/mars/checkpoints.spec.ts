/** Checkpoints restore real device state, journals and text as one verified file set. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Checkpoints, acquireRunLease, snapshotSqlite, CheckpointIOTimeout, withCheckpointDeadline } from './checkpoints.ts'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mars-checkpoint-')); roots.push(root)
  const run = join(root, 'run'); await mkdir(join(run, 'execution'), { recursive: true })
  await mkdir(join(run, 'workspace'))
  await writeFile(join(run, 'workspace', 'notes.md'), '原始计划\noperation-1')
  const db = new DatabaseSync(join(run, 'execution', 'execution.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE facts(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO facts VALUES(1,\'before\')')
  return { root, run, db, checkpoints: new Checkpoints(run, join(root, 'snapshots')) }
}
it('restores SQLite WAL contents and notes while retaining the failed branch', async () => {
  const { run, db, checkpoints } = await setup()
  const checkpoint = await checkpoints.save(12, 45, { members: ['brain'], rootSessionId: 'session-1' })
  db.exec("UPDATE facts SET value='after'")
  await writeFile(join(run, 'workspace', 'notes.md'), '被回退的计划')
  db.close()
  const restored = await checkpoints.restoreStopped(checkpoint.id)
  const current = new DatabaseSync(join(run, 'execution', 'execution.sqlite'))
  expect(current.prepare('SELECT value FROM facts').get()?.value).toBe('before'); current.close()
  expect(await readFile(join(run, 'workspace', 'notes.md'), 'utf8')).toContain('operation-1')
  expect(await readFile(join(restored.archive, 'workspace', 'notes.md'), 'utf8')).toBe('被回退的计划')
  expect((await checkpoints.list())[0]!.metadata).toEqual({ members: ['brain'], rootSessionId: 'session-1' })
})
it('refuses a live owner and corrupted checkpoint before replacing any state', async () => {
  const { run, db, checkpoints } = await setup()
  const checkpoint = await checkpoints.save(1, 1, {})
  const lease = acquireRunLease(run, false)
  await expect(checkpoints.restoreStopped(checkpoint.id)).rejects.toThrow()
  lease.close(); db.close()
  await writeFile(join(checkpoints.directory, checkpoint.id, 'files', 'workspace', 'notes.md'), 'corrupted')
  await expect(checkpoints.restoreStopped(checkpoint.id)).rejects.toThrow('hash mismatch')
  expect(await readFile(join(run, 'workspace', 'notes.md'), 'utf8')).toContain('原始计划')
})

it('backs up a pinned WAL snapshot while another connection writes after every copied page', async () => {
  const { run, db } = await setup()
  const source = join(run, 'execution', 'execution.sqlite'), destination = join(run, 'pinned.sqlite')
  db.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE padding(id INTEGER PRIMARY KEY,payload BLOB)')
  const insert = db.prepare('INSERT INTO padding(payload) VALUES(zeroblob(16384))')
  db.exec('BEGIN'); for (let i = 0; i < 80; i++) insert.run(); db.exec('COMMIT')
  let writes = 0
  try {
    await snapshotSqlite(source, destination, { rate: 1, progress: () => {
      // A realistic independent poller both updates the operation and appends an observation.
      writes++
      db.prepare('UPDATE facts SET value=? WHERE id=1').run(`poll-${writes}`)
      db.prepare('INSERT INTO facts(value) VALUES(?)').run(`observation-${writes}`)
    } })
    expect(writes).toBeGreaterThan(3)
    const snapshot = new DatabaseSync(destination, { readOnly: true })
    try {
      expect(snapshot.prepare('SELECT value FROM facts WHERE id=1').get()?.value).toBe('before')
      expect(snapshot.prepare('SELECT COUNT(*) AS count FROM facts').get()?.count).toBe(1)
      expect(snapshot.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok')
    } finally { snapshot.close() }
    expect(db.prepare('SELECT COUNT(*) AS count FROM facts').get()?.count).toBe(writes + 1)
    expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0)
  } finally { db.close() }
}, 10000)

it('releases the pinned read transaction when backup fails', async () => {
  const { run, db } = await setup()
  try {
    await expect(snapshotSqlite(join(run, 'execution', 'execution.sqlite'), join(run, 'missing', 'destination.sqlite'))).rejects.toThrow()
    db.exec("UPDATE facts SET value='still-writable' WHERE id=1")
    expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0)
  } finally { db.close() }
})

it('omits only the unrelated router demo fixture and preserves real mail and scientific workspaces', async () => {
  const { run, db, checkpoints } = await setup()
  await mkdir(join(run, 'router', 'demo', 'todo-cli', '.git', 'objects'), { recursive: true })
  await writeFile(join(run, 'router', 'demo', 'todo-cli', '.git', 'objects', 'demo-object'), 'unrelated dashboard template')
  await mkdir(join(run, 'router', 'mars-run'), { recursive: true })
  await writeFile(join(run, 'router', 'mars-run', 'board.json'), '{"messages":["scientific handoff"]}')
  await mkdir(join(run, 'workspace', '.git'), { recursive: true })
  await writeFile(join(run, 'workspace', '.git', 'HEAD'), 'actual agent work must not be excluded')
  const checkpoint = await checkpoints.save(840, 100, { boundary: 'committed' })
  expect(checkpoint.files.some(file => file.path.startsWith('router/demo/'))).toBe(false)
  expect(checkpoint.files.map(file => file.path)).toContain('router/mars-run/board.json')
  expect(checkpoint.files.map(file => file.path)).toContain('workspace/.git/HEAD')
  const progress = JSON.parse(await readFile(join(checkpoints.directory, 'checkpoint-progress.json'), 'utf8'))
  expect(progress).toMatchObject({ checkpointId: checkpoint.id, tick: 840, phase: 'published', status: 'done' })
  db.close()
  const restored = await checkpoints.restoreStopped(checkpoint.id)
  expect(await readFile(join(run, 'router', 'mars-run', 'board.json'), 'utf8')).toContain('scientific handoff')
  expect(await readFile(join(restored.archive, 'router', 'demo', 'todo-cli', '.git', 'objects', 'demo-object'), 'utf8')).toContain('unrelated dashboard')
})

it('reports a bounded stalled phase and never publishes its incomplete checkpoint', async () => {
  const { root, run, db } = await setup()
  const checkpoints = new Checkpoints(run, join(root, 'timed-checkpoints'), { ioTimeoutMs: 50 })
  try {
    await expect(checkpoints.save(840, 100, {}, () => new Promise<void>(() => {}))).rejects.toBeInstanceOf(CheckpointIOTimeout)
    expect(await checkpoints.published()).toHaveLength(0)
    expect((await readdir(checkpoints.directory)).some(name => name.startsWith('.partial-'))).toBe(true)
    const progress = JSON.parse(await readFile(join(checkpoints.directory, 'checkpoint-progress.json'), 'utf8'))
    expect(progress).toMatchObject({ tick: 840, phase: 'failed', status: 'error' })
    expect(progress.path).toContain('verify-frozen')
    await expect(withCheckpointDeadline('responsive', async () => 42, 50)).resolves.toBe(42)
  } finally { db.close() }
})

it('excludes SQLite rollback sidecars without dropping real research journal notes', async () => {
  const { run, db, checkpoints } = await setup()
  try {
    await writeFile(join(run, 'clock-owner.sqlite-journal'), 'control database rollback journal')
    await writeFile(join(run, 'workspace', 'legacy.sqlite-journal'), 'source rollback journal')
    await writeFile(join(run, 'workspace', 'history.db-journal'), 'database rollback journal')
    await writeFile(join(run, 'workspace', 'research-journal'), 'real scientific notes')
    const checkpoint = await checkpoints.save(840, 100, {})
    expect(checkpoint.files.map(file => file.path)).toContain('workspace/research-journal')
    expect(checkpoint.files.some(file => /\.(?:sqlite|db)-journal$/i.test(file.path))).toBe(false)
    expect(checkpoint.files.map(file => file.path)).toContain('execution/execution.sqlite')
  } finally { db.close() }
})
