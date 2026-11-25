/** Transactional experiment state derived from current execution facts; events remain the audit history. */
import type { SQLOutputValue } from 'node:sqlite'
import type { ExecutionDatabase } from './journal.ts'
import type { ExperimentView } from './experiments.ts'

export type ProviderBindings = Record<string, { version: string; sha256: string }>
export const EXPERIMENT_PROJECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS experiment_view(
  experiment_id TEXT PRIMARY KEY REFERENCES experiments(id),
  state TEXT NOT NULL CHECK(state IN ('running','awaiting_decision','needs_review','blocked','cancelling','cancelled','completed')),
  reason TEXT NOT NULL, cursor INTEGER NOT NULL CHECK(cursor>=0), budget_used REAL NOT NULL CHECK(budget_used>=0),
  provider_bindings_json TEXT NOT NULL CHECK(json_valid(provider_bindings_json)),
  last_issue_json TEXT CHECK(last_issue_json IS NULL OR json_valid(last_issue_json)),
  projection_seq INTEGER NOT NULL CHECK(projection_seq>=0), closed_at TEXT);
CREATE INDEX IF NOT EXISTS experiment_view_closed ON experiment_view(state,closed_at);
CREATE INDEX IF NOT EXISTS experiment_steps_experiment ON experiment_steps(experiment_id);
CREATE INDEX IF NOT EXISTS execution_artifacts_operation ON artifacts(operation_id,id);
CREATE INDEX IF NOT EXISTS execution_events_operation ON events(operation_id,type,seq);
CREATE INDEX IF NOT EXISTS execution_events_project ON events(project_id,type,seq);
`

type SqlRow = Record<string, SQLOutputValue>
type ExperimentRow = SqlRow & {
  id: string; project_id: string; budget_used: number; cancel_requested: number
  review_required: number; completion_json: string | null
}
export type ProjectionRow = SqlRow & {
  experiment_id: string; state: ExperimentView['state']; reason: string; cursor: number; budget_used: number
  provider_bindings_json: string; last_issue_json: string | null; projection_seq: number; closed_at: string | null
}
const terminal = (state: string) => state === 'succeeded' || state === 'failed' || state === 'cancelled'

/** Own the materialized row; every update must share the fact writer's SQLite transaction. */
export class ExperimentProjection {
  constructor(private readonly db: ExecutionDatabase) {}

  /** Read the existing materialized state without consulting historical events.
   * @param id Experiment identity.
   * @returns Its persisted projection; absence is a migration/integrity failure.
   */
  read(id: string): ProjectionRow {
    const row = this.db.prepare('SELECT * FROM experiment_view WHERE experiment_id=?').get(id) as ProjectionRow | undefined
    if (!row) throw new Error('Experiment projection missing; initialize the current execution schema with a controller')
    return row
  }

  /** Advance from an audit event after its facts have changed.
   * @param id Experiment identity.
   * @param kind Experiment event suffix.
   * @param payload Exact persisted event JSON, including experimentId.
   * @param sequence Inserted audit sequence.
   * @param at Event time used when execution first reaches a terminal state.
   * @param bindings Initial approved bindings for creation; omission retains the existing bindings.
   */
  advance(id: string, kind: string, payload: string, sequence: number, at: string, bindings?: ProviderBindings): void {
    this.assertTransaction()
    const previous = this.db.prepare('SELECT * FROM experiment_view WHERE experiment_id=?').get(id) as ProjectionRow | undefined
    if (!previous && bindings === undefined) throw new Error('Cannot advance a missing experiment projection')
    const issue = kind === 'action-rejected' ? payload
      : ['submitted', 'finished', 'reviewed'].includes(kind) ? null : previous?.last_issue_json ?? null
    this.write(id, bindings === undefined ? previous!.provider_bindings_json : JSON.stringify(bindings),
      issue, sequence, at, previous?.closed_at ?? null)
  }

  /** Build projections once during a monotonic schema migration; no Provider or live grant is consulted.
   * @returns after all prior experiments have a projection in the caller's migration transaction.
   */
  backfill(): void {
    this.assertTransaction()
    const rows = this.db.prepare('SELECT id,project_id FROM experiments ORDER BY rowid').all() as (SqlRow & { id: string; project_id: string })[]
    for (const row of rows) {
      const events = this.db.prepare(`SELECT seq,type,data_json,at FROM events
        WHERE project_id=? AND type LIKE 'experiment-%' AND json_extract(data_json,'$.experimentId')=? ORDER BY seq`)
        .all(row.project_id, row.id) as (SqlRow & { seq: number; type: string; data_json: string; at: string })[]
      let bindings: ProviderBindings = {}, issue: string | null = null, cursor = 0, at: string | null = null
      let hasBindings = false
      for (const event of events) {
        cursor = event.seq
        if (event.type === 'experiment-created') {
          if (hasBindings) throw new Error('Duplicate experiment creation audit prevents safe projection migration')
          const data = JSON.parse(event.data_json) as { providerBindings?: ProviderBindings }
          bindings = data.providerBindings ?? {}
          hasBindings = true
        }
        if (event.type === 'experiment-action-rejected') issue = event.data_json
        else if (['experiment-submitted', 'experiment-finished', 'experiment-reviewed'].includes(event.type)) issue = null
        if (['experiment-finished', 'experiment-cancel-requested', 'experiment-observed'].includes(event.type)) at = event.at
      }
      this.write(row.id, JSON.stringify(bindings), issue, cursor, at ?? new Date().toISOString(), null)
    }
  }

  private assertTransaction(): void {
    if (!this.db.isTransaction) throw new Error('Experiment projection must share the fact transaction')
  }

  private write(id: string, bindings: string, issue: string | null, cursor: number, at: string, closedAt: string | null): void {
    const row = this.db.prepare('SELECT * FROM experiments WHERE id=?').get(id) as ExperimentRow | undefined
    if (!row) throw new Error('Cannot project an unknown experiment')
    const operations = this.db.prepare(`SELECT o.state FROM operations o JOIN experiment_steps s ON s.operation_id=o.id
      WHERE s.experiment_id=?`).all(id) as (SqlRow & { state: string })[]
    let state: ExperimentView['state'], reason: string
    if (row.completion_json) {
      state = 'completed'; reason = 'Execution settled and sourced completion recorded'
    } else if (operations.some(o => o.state === 'unknown')) {
      state = 'blocked'; reason = 'An operation outcome is unknown; resources and budget remain reserved'
    } else if (row.cancel_requested) {
      state = operations.every(o => terminal(o.state)) ? 'cancelled' : 'cancelling'
      reason = state === 'cancelled' ? 'All accepted operations have observed terminal states'
        : 'Cancellation requested; at least one operation is not confirmed stopped'
    } else if (row.review_required) {
      state = 'needs_review'; reason = 'An adjustment needs the current controller decision; existing work is not presumed stopped'
    } else if (operations.some(o => !terminal(o.state))) {
      state = 'running'; reason = 'Accepted operations are still active'
    } else {
      state = 'awaiting_decision'
      reason = issue ? 'Last action was not admitted; inspect lastIssue and remaining limits'
        : 'No active operation; select an allowed action, escalate or finish'
    }
    const closed = state === 'completed' || state === 'cancelled' ? closedAt ?? at : null
    this.db.prepare(`INSERT INTO experiment_view(experiment_id,state,reason,cursor,budget_used,provider_bindings_json,last_issue_json,projection_seq,closed_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(experiment_id) DO UPDATE SET
      state=excluded.state,reason=excluded.reason,cursor=excluded.cursor,budget_used=excluded.budget_used,
      provider_bindings_json=excluded.provider_bindings_json,last_issue_json=excluded.last_issue_json,
      projection_seq=excluded.projection_seq,closed_at=excluded.closed_at`)
      .run(id, state, reason, cursor, row.budget_used, bindings, issue, cursor, closed)
  }
}
