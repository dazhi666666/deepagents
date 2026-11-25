/** Provider calls, immutable observations and lock retirement after actual device-call settlement. */
import { mkdirSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalJson, type ExecutionProvider, type ProviderOperation, type ProviderObservation, type ResultArtifact, type Json } from './sdk.ts'
import type { ExecutionJournal, OperationRow } from './journal.ts'
import type { Ownership } from './lifecycle.ts'

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])

/** One engine owns the real promises; timeout only ends the caller's wait, never the underlying action. */
export class ProviderRuntime {
  private readonly calls = new Map<string, Promise<unknown>>()
  private readonly retirements = new Set<Promise<void>>()
  constructor(
    private readonly db: ExecutionJournal,
    private readonly directory: string,
    private readonly providers: ReadonlyMap<string, ExecutionProvider>,
    private readonly timeoutMs: number,
    private readonly observed: (id: string, data: Json) => void,
  ) {}

  /** Canonical identity retained by existing operation rows; no lifecycle metadata is added.
   * @param provider Registered Provider.
   * @returns Its canonical description, including version and configuration.
   */
  fingerprint(provider: ExecutionProvider): string { return canonicalJson(provider.describe() as unknown as Json) }

  /** Keep operation ownership until any timed-out real call settles.
   * @param id Operation identity whose logical work has returned.
   * @param ownership Lock acquired before registration or observation.
   */
  release(id: string, ownership: Ownership): void {
    const actual = this.calls.get(id)
    if (!actual) return ownership.close()
    const retirement = Promise.allSettled([actual]).then(() => ownership.close())
    this.retirements.add(retirement)
    void retirement.then(() => this.retirements.delete(retirement))
  }

  /** Await real calls and their lock retirement before closing journal or driver handles. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.calls.values()])
    await Promise.all([...this.retirements])
  }

  /** Dispatch only after the engine has committed registration and dispatch intent.
   * @param row Registered operation under its caller-owned operation lock.
   */
  async submit(row: OperationRow): Promise<void> {
    const provider = this.providers.get(row.provider_id)!
    try {
      this.observe(row, await this.call(row.id, () => provider.submit(this.operation(row))), 'submit')
    } catch (error) {
      this.observe(row, { state: 'unknown', detail: `Submit outcome uncertain: ${String(error)}` }, 'submit-error')
    }
  }

  /** Observe originals only; incompatible and missing Providers retain durable resources without replay.
   * @param row Operation under its caller-owned operation lock.
   * @param source Audit observation source.
   */
  async refresh(row: OperationRow, source: string): Promise<void> {
    if (TERMINAL.has(row.state)) return
    const provider = this.providers.get(row.provider_id)
    if (!provider || this.fingerprint(provider) !== row.provider_fingerprint) {
      this.observe(row, { state: 'unknown', detail:
        'Required provider version or configuration unavailable; resource retained and provider submissions blocked' }, source)
      return
    }
    if (row.cancel_requested && this.cancellationPending(row.id)) {
      await this.cancel(row)
      row = this.row(row.id)
      if (TERMINAL.has(row.state) || this.calls.has(row.id)) return
    }
    try {
      this.observe(row, await this.call(row.id, () => provider.query(this.operation(row))), source)
    } catch (error) {
      this.observe(row, { state: 'unknown', detail: `Query outcome uncertain: ${String(error)}` }, source)
    }
  }

  /** Attempt cancellation against the original identity and acknowledge only the captured request sequence.
   * @param row Operation under its caller-owned operation lock.
   */
  async cancel(row: OperationRow): Promise<void> {
    const provider = this.providers.get(row.provider_id)
    if (!provider || this.fingerprint(provider) !== row.provider_fingerprint) {
      this.observe(row, { state: 'unknown', detail: 'Cancellation unavailable: provider version missing' }, 'cancel')
      return
    }
    const requestSeq = (this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE operation_id=? AND type='cancel-requested'")
      .get(row.id) as { seq: number }).seq
    try {
      const response = await this.call(row.id, () => provider.cancel(this.operation(row)))
      this.db.transaction(() => {
        this.db.event(row, 'cancel-response', { requestSeq, disposition: response.disposition, detail: response.detail ?? null })
        if (response.observation) this.observe(this.row(row.id), response.observation, 'cancel-observation')
        else this.db.prepare('UPDATE operations SET detail=? WHERE id=?')
          .run(`Cancellation ${response.disposition}: ${response.detail ?? ''}`, row.id)
      })
    } catch (error) {
      this.observe(row, { state: 'unknown', detail: `Cancellation outcome uncertain: ${String(error)}` }, 'cancel-error')
    }
  }

  private row(id: string): OperationRow {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OperationRow | undefined
    if (!row) throw new Error('Unknown operation')
    return row
  }
  private operation(row: OperationRow): ProviderOperation {
    const artifactDirectory = resolve(this.directory, 'artifacts', row.id)
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 })
    return { operationId: row.id, projectId: row.project_id, input: JSON.parse(row.input_json), artifactDirectory }
  }
  private async call<T>(id: string, call: () => Promise<T>): Promise<T> {
    const actual = Promise.resolve().then(call)
    this.calls.set(id, actual)
    void actual.then(() => this.calls.delete(id), () => this.calls.delete(id))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([actual, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider call timed out; underlying device action may still continue')), this.timeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  private cancellationPending(id: string): boolean {
    const row = this.db.prepare(`SELECT
      COALESCE(MAX(CASE WHEN type='cancel-requested' THEN seq END),0) AS requested,
      COALESCE(MAX(CASE WHEN type='cancel-response' THEN COALESCE(json_extract(data_json,'$.requestSeq'),seq) END),0) AS acknowledged
      FROM events WHERE operation_id=? AND type IN ('cancel-requested','cancel-response')`).get(id) as {
        requested: number; acknowledged: number
      }
    return row.acknowledged === 0 || row.requested > row.acknowledged
  }
  private observe(row: OperationRow, observation: ProviderObservation, source: string): void {
    if (!['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'not_found'].includes(observation.state))
      throw new Error('Invalid provider observation state')
    const artifacts: ResultArtifact[] = []
    if (observation.artifacts?.length) {
      const base = realpathSync(this.operation(row).artifactDirectory)
      for (const artifact of observation.artifacts) {
        const path = realpathSync(resolve(base, artifact.path)), rel = relative(base, path)
        if (rel.startsWith('..') || isAbsolute(rel) || !statSync(path).isFile())
          throw new Error('Provider artifact escapes operation directory')
        const bytes = readFileSync(path)
        const published = { id: createHash('sha256').update(`${row.id}/${rel}`).digest('hex'), operationId: row.id,
          path: relative(realpathSync(this.directory), path), sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length, mediaType: artifact.mediaType }
        const prior = this.db.prepare('SELECT sha256,bytes,media_type FROM artifacts WHERE id=?').get(published.id) as
          { sha256: string; bytes: number; media_type: string } | undefined
        if (prior && (prior.sha256 !== published.sha256 || prior.bytes !== published.bytes || prior.media_type !== published.mediaType))
          throw new Error('Provider changed an already published immutable artifact')
        artifacts.push(published)
      }
    }
    const state = observation.state === 'not_found' ? 'unknown' : observation.state
    const detail = observation.state === 'not_found'
      ? 'Provider reports not_found after durable registration; no automatic replay, resources remain held'
      : (observation.detail ?? null)
    const progressJson = observation.progress === undefined ? null : canonicalJson(observation.progress)
    const priorArtifacts = this.db.prepare('SELECT id FROM artifacts WHERE operation_id=? ORDER BY id').all(row.id) as { id: string }[]
    this.db.transaction(() => {
      this.db.prepare('UPDATE operations SET state=?,progress_json=?,detail=?,updated_at=? WHERE id=?')
        .run(state, progressJson, detail, new Date().toISOString(), row.id)
      for (const a of artifacts)
        this.db.prepare('INSERT OR IGNORE INTO artifacts(id,operation_id,path,sha256,bytes,media_type) VALUES(?,?,?,?,?,?)')
          .run(a.id, a.operationId, a.path, a.sha256, a.bytes, a.mediaType)
      if (TERMINAL.has(state)) this.db.prepare('DELETE FROM resources WHERE operation_id=?').run(row.id)
      this.db.event(row, source, { state, detail, artifacts: artifacts.map(a => a.id) })
      if (row.state !== state || row.progress_json !== progressJson || row.detail !== detail ||
        artifacts.some(a => !priorArtifacts.some(p => p.id === a.id)))
        this.observed(row.id, { state, detail, progress: observation.progress ?? null })
    })
  }
}
