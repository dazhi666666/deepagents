/** Shared mechanics for the reference providers' independent, per-call SQLite journals. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalJson, type Json, type ProviderOperation } from '../sdk.ts'

interface JournalOptions {
  path: string
  schema: string
  configuration: Json
  versionError: string
  configurationError: string
}

function controlDomain(db: DatabaseSync, root: string) {
  const owner = db.prepare('SELECT root FROM control_domain WHERE id=1').get() as
    | { root: string }
    | undefined
  if (owner && owner.root !== root) throw new Error('Device journal belongs to another management domain')
  return owner
}

/** Open and bind a journal for one synchronous call, rolling back failures and always closing it.
 * @param options Device file, adapter schema, configuration and existing diagnostics.
 * @param operation Operation whose real artifact parent must match any claimed management domain.
 * @param run Synchronous adapter work, with transaction boundaries owned by the adapter.
 * @returns The adapter's result after closing its connection.
 */
export function openJournal<T>(options: JournalOptions, operation: ProviderOperation, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(options.path)
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== 0 && version !== 1) throw new Error(options.versionError)
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS config(value TEXT NOT NULL);' +
        options.schema +
        'CREATE TABLE IF NOT EXISTS starts(operation_id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS control_domain(id INTEGER PRIMARY KEY CHECK(id=1), root TEXT NOT NULL);',
    )
    mkdirSync(operation.artifactDirectory, { recursive: true, mode: 0o700 })
    const root = realpathSync(resolve(operation.artifactDirectory, '..'))
    db.exec('BEGIN IMMEDIATE')
    const current = db.prepare('SELECT value FROM config').get() as { value: string } | undefined
    const fingerprint = canonicalJson(options.configuration)
    if (current && current.value !== fingerprint) throw new Error(options.configurationError)
    if (!current) db.prepare('INSERT INTO config VALUES (?)').run(fingerprint)
    controlDomain(db, root)
    db.exec('PRAGMA user_version=1; COMMIT')
    return run(db)
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}

/** Permanently claim the real artifact parent inside the adapter's submission transaction.
 * @param db Open journal in the submission transaction.
 * @param operation Submission whose management domain will own this device.
 * @param historic Read prior adapter output directories only when no domain has been claimed.
 */
export function claimControlDomain(
  db: DatabaseSync,
  operation: ProviderOperation,
  historic: () => { directory: string }[],
): void {
  const root = realpathSync(resolve(operation.artifactDirectory, '..'))
  if (!controlDomain(db, root)) {
    if (historic().some((row) => realpathSync(resolve(row.directory, '..')) !== root))
      throw new Error('Existing device actions belong to another management domain')
    db.prepare('INSERT INTO control_domain VALUES (1,?)').run(root)
  }
}

/** Canonicalize project, input and real output directory for durable operation deduplication.
 * @param operation Operation with an existing artifact directory.
 * @returns Stable identity shared by submission and later checks.
 */
export function stableIdentity(operation: ProviderOperation): string {
  return canonicalJson({
    projectId: operation.projectId,
    input: operation.input,
    artifactDirectory: realpathSync(operation.artifactDirectory),
  })
}

/** Reject reuse of an operation ID with a different stable identity.
 * @param row Persisted operation identity.
 * @param operation Submitted, queried or cancelled operation.
 * @param diagnostic Adapter-specific error text retained for identity mismatches.
 */
export function checkIdentity(row: { identity: string }, operation: ProviderOperation, diagnostic: string): void {
  if (row.identity !== stableIdentity(operation)) throw new Error(diagnostic)
}

/** Publish terminal output bytes through sibling temporary files and atomic renames.
 * @param directory Operation's real output directory.
 * @param files Adapter filenames and their immutable terminal contents, in publication order.
 */
export function publishAtomic(directory: string, files: Record<string, string>): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const [filename, content] of Object.entries(files)) {
    const path = join(directory, filename)
    writeFileSync(path + '.tmp', content, { mode: 0o600 })
    renameSync(path + '.tmp', path)
  }
}

/** Identify the two terminal states emitted by these reference journals.
 * @param state Persisted adapter state.
 * @returns Whether terminal outputs must be published.
 */
export function terminalState(state: string): boolean {
  return state === 'succeeded' || state === 'cancelled'
}
