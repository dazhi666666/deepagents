/** Verified multi-file checkpoints taken under a host-owned admission barrier. */
import { DatabaseSync, backup } from 'node:sqlite'
import { constants, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, copyFile, rename, rm, lstat, realpath, appendFile, cp } from 'node:fs/promises'
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { z } from 'zod'
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'

const fileSchema = z.object({ path: z.string(), sha256: z.string().length(64), bytes: z.number().int().nonnegative() })
const manifestSchema = z.object({ version: z.literal(1), id: z.string().uuid(), root: z.string(),
  serial: z.number().int().nonnegative().default(0),
  tick: z.number().int().nonnegative(), cursor: z.number().int().nonnegative(), metadata: z.json(), files: z.array(fileSchema) })
export type CheckpointManifest = z.infer<typeof manifestSchema>
/** A late native lifecycle write invalidates this candidate before publication. */
export class CheckpointChanged extends Error {}
export class CheckpointIOTimeout extends CheckpointChanged {}
/** A timed-out asynchronous copy may still finish; its partial directory must never be published. */
export async function withCheckpointDeadline<T>(label: string, operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CheckpointIOTimeout(`Checkpoint I/O timed out: ${label}`)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
const ignored = (name: string) => ['controller.sqlite', 'clock-owner.sqlite', 'viewer-connection.json'].includes(name) || name.endsWith('-wal') || name.endsWith('-shm') || /\.(?:sqlite|db)-journal$/i.test(name)
function localPath(root: string, path: string) {
  const target = resolve(root, path), rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Checkpoint file outside its root')
  return target
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Pin a WAL read snapshot so autonomous provider observations cannot restart every backup batch.
 * The admission barrier freezes scientific actions, but engine polling may still append observations.
 * Copying only the main file after a checkpoint is unsafe if another connection writes during the copy.
 */
export async function snapshotSqlite(source: string, destination: string, options?: Parameters<typeof backup>[2]) {
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    db.exec('BEGIN')
    // BEGIN is deferred: a read is required to establish the WAL end mark before asynchronous copying.
    db.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get()
    await backup(db, destination, options ?? {})
  } finally {
    try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() }
  }
}

/** Hold a stable lease outside the directory that restoration replaces.
 * @param root Mutable run path.
 * @param exclusive Whether this owner replaces the run; ordinary hosts hold shared leases.
 * @returns Lease whose release permits a new runtime generation.
 */
export function acquireRunLease(root: string, exclusive: boolean) {
  const db = new DatabaseSync(`${resolve(root)}.recovery.sqlite`)
  try {
    db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS guard(id INTEGER PRIMARY KEY)')
    db.exec(exclusive ? 'BEGIN EXCLUSIVE' : 'BEGIN')
    db.prepare('SELECT COUNT(*) FROM guard').get()
  } catch (error) { db.close(); throw error }
  let released = false
  return { close() { if (!released) { released = true; db.exec('ROLLBACK'); db.close() } } }
}

/** A checkpoint repository stays outside the mutable run directory. */
export class Checkpoints {
  readonly root: string
  readonly directory: string
  private serial: number
  constructor(root: string, directory: string, private readonly options: { ioTimeoutMs?: number; restoreGuard?: (manifest: CheckpointManifest) => void } = {}) {
    this.root = resolve(root); this.directory = resolve(directory)
    const sequence = join(this.directory, '.sequence.json')
    this.serial = existsSync(sequence) ? z.number().int().nonnegative().parse(JSON.parse(readFileSync(sequence, 'utf8'))) : 0
    const rel = relative(this.root, this.directory)
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('Keep checkpoints outside the mutable run root')
  }
  /** Save all mutable files while the caller holds and flushes every writer.
   * @param tick Committed logical tick.
   * @param cursor Corresponding viewer event cursor.
   * @param metadata Native membership and restart settings.
   * @returns Atomically published verified manifest.
   */
  async save(tick: number, cursor: number, metadata: Json, verifyFrozen?: () => Promise<void>): Promise<CheckpointManifest> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const id = randomUUID(), temporary = join(this.directory, `.partial-${id}`)
    await mkdir(temporary, { mode: 0o700 })
    const files: CheckpointManifest['files'] = []
    const progress = (phase: string, path: string, status = 'running') => {
      const entry = JSON.stringify({ checkpointId: id, tick, phase, path, status, at: new Date().toISOString() })
      // Synchronous tiny diagnostics do not depend on the libuv pool used by copy/backup.
      writeFileSync(join(this.directory, 'checkpoint-progress.json'), entry, { mode: 0o600 })
      appendFileSync(join(this.directory, 'checkpoint-progress.jsonl'), entry + '\n', { mode: 0o600 })
    }
    const io = async <T>(phase: string, path: string, operation: () => Promise<T>): Promise<T> => {
      progress(phase, path)
      return withCheckpointDeadline(`${phase} ${path}`, operation, this.options.ioTimeoutMs ?? 30000)
    }
    const walk = async (folder: string) => {
      for (const item of await io('enumerate', relative(this.root, folder) || '.', () => readdir(folder, { withFileTypes: true }))) {
        if (ignored(item.name)) continue
        // Manifest paths are forward-slash relative names on every platform;
        // retained checkpoints from earlier runs use this form.
        const source = join(folder, item.name), path = relative(this.root, source).split(sep).join('/')
        if (item.isSymbolicLink()) throw new Error(`Checkpoint refuses symbolic link ${path}`)
        if (item.isDirectory() && path === 'public') continue // immutable, hash-verified history is carried over on restore
        // createApp installs this unrelated Git demo automatically. Mars uses router/mars-run;
        // the demo remains in the archived branch and is recreated by createApp after restoration.
        if (item.isDirectory() && path === 'router/demo') continue
        if (item.isDirectory()) { await walk(source); continue }
        if (!item.isFile()) throw new Error(`Checkpoint refuses special file ${path}`)
        const destination = localPath(join(temporary, 'files'), path)
        await io('mkdir', path, () => mkdir(dirname(destination), { recursive: true, mode: 0o700 }))
        if (path.endsWith('.sqlite') && !path.startsWith('public/')) {
          await io('sqlite-snapshot', path, () => snapshotSqlite(source, destination))
        } else await io('copy', path, () => copyFile(source, destination, constants.COPYFILE_FICLONE))
        const bytes = await io('hash-payload', path, () => readFile(destination))
        files.push({ path, sha256: digest(bytes), bytes: bytes.length })
      }
    }
    try {
      await walk(this.root)
      if (verifyFrozen) await io('verify-frozen', '.', verifyFrozen)
      for (const file of files) if (!file.path.endsWith('.sqlite')) {
        let current: Buffer
        try { current = await io('verify-source', file.path, () => readFile(localPath(this.root, file.path))) }
        catch (error) { if (error instanceof CheckpointIOTimeout) throw error; throw new CheckpointChanged('Native checkpoint source disappeared', { cause: error }) }
        if (digest(current) !== file.sha256) throw new CheckpointChanged('Native checkpoint source changed')
      }
      const serial = ++this.serial
      const sequence = join(this.directory, `.sequence-${id}.tmp`)
      await io('write-sequence', '.sequence.json', () => writeFile(sequence, JSON.stringify(serial), { mode: 0o600 }))
      await io('publish-sequence', '.sequence.json', () => rename(sequence, join(this.directory, '.sequence.json')))
      const manifest = manifestSchema.parse({ version: 1, id, serial, root: this.root, tick, cursor, metadata, files })
      await io('write-manifest', 'manifest.json', () => writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }))
      await io('publish-checkpoint', id, () => rename(temporary, join(this.directory, id)))
      progress('published', id, 'done')
      return manifest
    } catch (error) {
      progress('failed', error instanceof Error ? error.message : String(error), 'error')
      // A timed-out copy/backup still owns its OS handle. Leave the unpublished partial for
      // diagnosis rather than waiting indefinitely to remove an open Windows file.
      if (!(error instanceof CheckpointIOTimeout)) {
        try { await io('cleanup-partial', id, () => rm(temporary, { recursive: true, force: true })) } catch { /* The original failure remains authoritative; partials never enter the catalog. */ }
      }
      progress('failed', error instanceof Error ? error.message : String(error), 'error')
      throw error
    }
  }
  /** Verify every payload before exposing a checkpoint for restoration. */
  async verify(id: string): Promise<CheckpointManifest> {
    z.string().uuid().parse(id)
    const folder = join(this.directory, id)
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')))
    if (manifest.id !== id || manifest.root !== this.root) throw new Error('Checkpoint belongs to another run root')
    const seen = new Set<string>()
    for (const file of manifest.files) {
      if (seen.has(file.path)) throw new Error('Duplicate checkpoint file')
      seen.add(file.path)
      const path = localPath(join(folder, 'files'), file.path)
      const actual = await realpath(path)
      if (actual !== localPath(await realpath(join(folder, 'files')), file.path)) throw new Error('Checkpoint path includes a symbolic link')
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Checkpoint payload is not a regular file')
      const bytes = await readFile(path)
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Checkpoint hash mismatch ${file.path}`)
    }
    return manifest
  }
  /** List published checkpoints; incomplete folders remain excluded. */
  async published() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const manifests: CheckpointManifest[] = []
    for (const item of await readdir(this.directory)) if (z.string().uuid().safeParse(item).success) {
      const manifest = manifestSchema.parse(JSON.parse(await readFile(join(this.directory, item, 'manifest.json'), 'utf8')))
      if (manifest.id !== item || manifest.root !== this.root) throw new Error('Checkpoint catalog identity mismatch')
      manifests.push(manifest)
    }
    return manifests.sort((a, b) => a.serial - b.serial || a.tick - b.tick || a.cursor - b.cursor)
  }
  /** Read only an integrity-checked public viewer frame from a published checkpoint. */
  async frame(id: string) {
    z.string().uuid().parse(id)
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(this.directory, id, 'manifest.json'), 'utf8')))
    if (manifest.id !== id || manifest.root !== this.root) throw new Error('Checkpoint frame identity mismatch')
    const file = manifest.files.find(file => file.path === 'viewer-state.json')
    if (!file) throw new Error('Viewer frame unavailable for this checkpoint')
    const bytes = await readFile(join(this.directory, id, 'files', 'viewer-state.json'))
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('Viewer frame integrity check failed')
    return JSON.parse(bytes.toString('utf8')) as unknown
  }
  /** Independently verify all published payloads when a full integrity audit is requested. */
  async list() { return Promise.all((await this.published()).map(manifest => this.verify(manifest.id))) }
  /** Restore to the original absolute path after all old writers have exited.
   * @param id Verified checkpoint identity.
   * @returns Archive location and the original manifest.
   */
  async restoreStopped(id: string) {
    const manifest = await this.verify(id)
    const lease = acquireRunLease(this.root, true)
    // Both runtime owners hold SQLite exclusive locks throughout their lifetimes.
    const locks: DatabaseSync[] = []
    try {
      this.options.restoreGuard?.(manifest)
      for (const path of ['clock-owner.sqlite', 'execution/controller.sqlite']) {
        const db = new DatabaseSync(join(this.root, path))
        locks.push(db); db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
      }
      const staging = `${this.root}.restoring-${randomUUID()}`, archive = `${this.root}.discarded-${randomUUID()}`
      await mkdir(staging, { mode: 0o700 })
      try {
        for (const file of manifest.files) {
          const target = localPath(staging, file.path)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await copyFile(localPath(join(this.directory, id, 'files'), file.path), target)
          const bytes = await readFile(target)
          if (digest(bytes) !== file.sha256) throw new Error('Restored payload differs')
          if (target.endsWith('.sqlite')) {
            const db = new DatabaseSync(target, { readOnly: true })
            try {
              if (!db.prepare('PRAGMA quick_check').all().every(row => Object.values(row)[0] === 'ok')) throw new Error('Restored SQLite integrity check failed')
            } finally { db.close() }
          }
        }
        if (manifest.files.some(file => file.path === 'run.json')) {
          const identity = z.object({ runId: z.string(), branchId: z.string(), epoch: z.number().int() }).passthrough()
            .parse(JSON.parse(await readFile(join(staging, 'run.json'), 'utf8')))
          const resumed = { ...identity, branchId: randomUUID(), epoch: identity.epoch + 1, checkpointId: id }
          await writeFile(join(staging, 'run.json'), JSON.stringify(resumed), { mode: 0o600 })
          await appendFile(join(this.directory, 'recovery-audit.jsonl'), JSON.stringify({ checkpointId: id, previous: identity, resumed }) + '\n', { mode: 0o600 })
        }
        if (existsSync(join(this.root, 'public'))) await cp(join(this.root, 'public'), join(staging, 'public'), { recursive: true })
        for (const db of locks.splice(0)) { db.exec('ROLLBACK'); db.close() }
        await rename(this.root, archive)
        try { await rename(staging, this.root) }
        catch (error) { await rename(archive, this.root); throw error }
        return { archive, manifest }
      } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
    } finally {
      for (const db of locks) { if (db.isTransaction) db.exec('ROLLBACK'); db.close() }
      lease.close()
    }
  }
}
