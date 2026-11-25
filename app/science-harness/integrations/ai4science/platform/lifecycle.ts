/** SQLite ownership files separate write commands, provider calls and the polling process. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** A process-owned transaction; SQLite releases it on process death. */
export class Ownership {
  private closed = false
  private constructor(private readonly db: DatabaseSync) {}

  /** Try once without waiting; null means another owner still holds the file.
   * @param path Dedicated ownership file, separate from execution facts.
   * @returns Exclusive process-owned transaction, or null when busy.
   */
  static acquire(path: string): Ownership | null {
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
      return new Ownership(db)
    } catch (error) {
      db.close()
      if (isBusy(error)) return null
      throw error
    }
  }

  /** Release only after all work protected by this ownership has actually settled. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.exec('ROLLBACK')
    } finally {
      this.db.close()
    }
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && 'errcode' in error && (error.errcode === 5 || error.errcode === 6)
}

/** Short synchronous write commands share a domain lock, including experiment callbacks. */
export class Controller {
  private readonly db: DatabaseSync
  constructor(directory: string, timeoutMs: number) {
    this.db = new DatabaseSync(resolve(directory, 'controller.sqlite'))
    this.db.exec(`PRAGMA busy_timeout=${timeoutMs}`)
  }

  /** Serialize a synchronous command across connections and processes. */
  write<T>(body: () => T): T {
    this.db.exec('BEGIN EXCLUSIVE')
    try {
      return body()
    } finally {
      this.db.exec('ROLLBACK')
    }
  }

  /** Close after the controller's commands and provider work have settled. */
  close(): void {
    this.db.close()
  }
}

/** A WAL reader never initializes or migrates the execution journal. */
export class Observer {
  /** Open an existing current-schema journal; an uninitialized domain fails without creating files. */
  static open(directory: string, schemaVersion: number): DatabaseSync {
    const db = new DatabaseSync(resolve(directory, 'execution.sqlite'), { readOnly: true })
    try {
      db.exec('PRAGMA query_only=ON')
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version !== schemaVersion)
        throw new Error(`Execution schema ${version} requires controller initialization before observation`)
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }
}

function ownObject(directory: string, kind: 'operation-locks' | 'experiment-locks', id: string): Ownership | null {
  const locks = resolve(directory, kind)
  mkdirSync(locks, { recursive: true, mode: 0o700 })
  const key = createHash('sha256').update(id).digest('hex')
  return Ownership.acquire(resolve(locks, `${key}.sqlite`))
}

/** Own one operation from registration through actual provider settlement.
 * @param directory Execution domain containing its dedicated ownership files.
 * @param id Stable operation identity.
 * @returns The exclusive owner, or null while another call owns this operation.
 */
export function ownOperation(directory: string, id: string): Ownership | null {
  return ownObject(directory, 'operation-locks', id)
}

/** Own experiment admission until context revocation, engine close, or process death.
 * @param directory Execution domain containing experiment ownership files.
 * @param id Stable experiment identity.
 * @returns Live controller ownership, or null while a peer controller owns admission.
 */
export function ownExperiment(directory: string, id: string): Ownership | null {
  return ownObject(directory, 'experiment-locks', id)
}

/** Own domain-wide polling; short-lived fallback queries use the same file.
 * @param directory Execution domain containing driver.sqlite.
 * @returns Polling qualification, or null while another owner is active.
 */
export function ownDriver(directory: string): Ownership | null {
  return Ownership.acquire(resolve(directory, 'driver.sqlite'))
}

/** Polling lifetime independent of dashboards and temporary controllers. */
export class Driver {
  private readonly abort = new AbortController()
  private polling = true
  private closing: Promise<void> | undefined
  readonly closed: Promise<void>

  constructor(
    private readonly ownership: Ownership,
    intervalMs: number,
    poll: () => Promise<void>,
    private readonly settle: () => Promise<void>,
  ) {
    this.closed = (async () => {
      try {
        while (!this.abort.signal.aborted) {
          await poll()
          try {
            await delay(intervalMs, undefined, { signal: this.abort.signal })
          } catch (error) {
            if (!this.abort.signal.aborted) throw error
          }
        }
      } finally {
        this.polling = false
        this.ownership.close()
      }
    })()
    // The owner observes failures through closed; retain the rejection until then.
    void this.closed.catch(() => {})
  }

  /** Whether this loop still owns polling qualification. */
  get running(): boolean {
    return this.polling
  }

  /** Stop polling and release driver qualification; disposal still awaits actual provider settlement.
   * Each unresolved provider call retains its separate operation ownership until it settles.
   */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.abort.abort()
      try {
        await this.closed
      } finally {
        await this.settle()
      }
    })())
  }
}
