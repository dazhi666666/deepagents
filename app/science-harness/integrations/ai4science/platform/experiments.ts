/** Experiment facts and bounded admission over the execution engine's existing transaction database. */
import { randomUUID } from 'node:crypto'
import type { ExecutionDatabase } from './journal.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { canonicalJson, type Json, type OperationContext, type OperationRecord } from './sdk.ts'
import type { ProjectArtifact } from './artifacts.ts'
import type { Ownership } from './lifecycle.ts'
import { ExperimentProjection, type ProviderBindings } from './experiment-projection.ts'

const text = z.string().trim().min(1).max(16000)
const ids = z.array(z.string().min(1)).max(1000).default([])
export const experimentRequestSchema = z
  .object({
    goal: text,
    method: z.object({ id: text, version: text }).strict(),
    context: z.json(),
    inputArtifactIds: ids,
    outputRequirements: text,
    budget: z.number().finite().nonnegative().nullable(),
    maxOperations: z.number().int().min(1).max(1000).nullable(),
    actions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            providerId: text,
            input: z.json(),
            minUses: z.number().int().min(0).max(1000).default(0),
            maxUses: z.number().int().min(1).max(1000).nullable(),
            requiresEvidence: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((r, c) => {
    if (new Set(r.actions.map((a) => a.id)).size !== r.actions.length)
      c.addIssue({ code: 'custom', message: 'Action ids must be unique' })
    if (
      r.actions.some((a) => a.maxUses !== null && a.minUses > a.maxUses) ||
      (r.maxOperations !== null && r.actions.reduce((n, a) => n + a.minUses, 0) > r.maxOperations)
    )
      c.addIssue({ code: 'custom', message: 'Inconsistent action limits' })
  })
export const experimentActionSchema = z
  .object({
    requestKey: z.string().min(1).max(128),
    actionId: z.string().min(1),
    rationale: text,
    evidenceOperationIds: ids,
    evidenceArtifactIds: ids,
  })
  .strict()
export const experimentAssessmentSchema = z
  .object({
    method: text,
    version: text,
    result: z.json(),
    rationale: text,
    operationIds: ids,
    artifactIds: ids,
  })
  .strict()
export type ExperimentRequest = z.infer<typeof experimentRequestSchema>
export type ExperimentAction = z.infer<typeof experimentActionSchema>
export type ExperimentAssessment = z.infer<typeof experimentAssessmentSchema>
export interface ExperimentBinding {
  experimentId: string
  action: ExperimentAction
}
export interface ExperimentView {
  id: string
  projectId: string
  createdBy: string
  requestKey: string
  request: ExperimentRequest
  providerBindings: Record<string, { version: string; sha256: string }>
  budgetUsed: number
  state:
    | 'running'
    | 'awaiting_decision'
    | 'needs_review'
    | 'blocked'
    | 'cancelling'
    | 'cancelled'
    | 'completed'
  reason: string
  cancelRequested: boolean
  /** This store holds live controller authority; persisted actor IDs never activate it. */
  controllerActive: boolean
  cursor: number
  operations: OperationRecord[]
  decisions: Record<string, unknown>[]
  assessments: Record<string, unknown>[]
  completion: Json | null
  projectBudget: { limit: number | null; used: number }
  lastIssue: Json | null
  scientificConclusion: 'not-evaluated-by-platform'
}
export interface ExperimentFeedback {
  reason: 'change' | 'decision' | 'timeout'
  experiment: ExperimentView
}
export interface ExperimentAPI {
  create(c: OperationContext, key: string, request: unknown): ExperimentView
  claim(c: OperationContext, id: string, reason: string): ExperimentView
  requireController(c: OperationContext, id: string): void
  get(c: OperationContext, id: string): ExperimentView
  list(c: OperationContext): ExperimentView[]
  submit(c: OperationContext, id: string, action: unknown): Promise<OperationRecord>
  assess(c: OperationContext, id: string, assessment: unknown): { id: string }
  escalate(c: OperationContext, id: string, reason: string, proposal: Json): ExperimentView
  resolve(c: OperationContext, id: string, reason: string): ExperimentView
  finish(
    c: OperationContext,
    id: string,
    summary: string,
    artifactIds: string[],
    assessmentIds: string[],
  ): ExperimentView
  cancel(c: OperationContext, id: string): Promise<ExperimentView>
  wait(
    c: OperationContext,
    id: string,
    options: { after: number; until: 'change' | 'decision'; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ExperimentFeedback>
}
export const EXPERIMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS experiments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),request_key TEXT NOT NULL,spec_json TEXT NOT NULL,created_by TEXT NOT NULL,budget_used REAL NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,review_required INTEGER NOT NULL DEFAULT 0,completion_json TEXT,UNIQUE(project_id,request_key));
CREATE TABLE IF NOT EXISTS experiment_steps(operation_id TEXT PRIMARY KEY REFERENCES operations(id),experiment_id TEXT NOT NULL REFERENCES experiments(id),action_id TEXT NOT NULL,request_key TEXT NOT NULL,actor_id TEXT NOT NULL,decision_json TEXT NOT NULL,UNIQUE(experiment_id,request_key));
CREATE TABLE IF NOT EXISTS experiment_assessments(id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL REFERENCES experiments(id),actor_id TEXT NOT NULL,data_json TEXT NOT NULL);
`
interface Row {
  id: string
  project_id: string
  request_key: string
  spec_json: string
  created_by: string
  budget_used: number
  cancel_requested: number
  review_required: number
  completion_json: string | null
}
interface Host {
  db: ExecutionDatabase
  binding(providerId: string): { version: string; sha256: string }
  pollMs: number
  signal: AbortSignal
  observing: boolean
  authorize(c: OperationContext, providerId?: string): void
  transaction<T>(body: () => T): T
  snapshot<T>(read: () => T): T
  ownExperiment(id: string): Ownership | null
  submit(
    c: OperationContext,
    r: { providerId: string; requestKey: string; input: Json },
    binding: ExperimentBinding,
  ): Promise<OperationRecord>
  get(c: OperationContext, id: string): OperationRecord
  query(c: OperationContext, id: string): Promise<OperationRecord>
  cancel(c: OperationContext, id: string): Promise<OperationRecord>
  artifact(c: OperationContext, id: string): { artifact: ProjectArtifact; content: string; encoding: string }
}
const terminal = (state: string) => ['succeeded', 'failed', 'cancelled'].includes(state)
interface ExperimentController {
  context: OperationContext
  ownership: Ownership | undefined
}

/** Experiment authority belongs to a live context holding process-owned admission, never a persisted actor ID. */
export class ExperimentStore implements ExperimentAPI {
  private readonly controllers = new Map<string, ExperimentController>()
  private parsedRequest: { id: string; json: string; value: ExperimentRequest } | undefined
  private readonly projection: ExperimentProjection
  constructor(private readonly host: Host) {
    this.projection = new ExperimentProjection(host.db)
  }
  private request(row: Row): ExperimentRequest {
    const cached = this.parsedRequest
    if (cached?.id === row.id && cached.json === row.spec_json) return cached.value
    const value = experimentRequestSchema.parse(JSON.parse(row.spec_json))
    this.parsedRequest = { id: row.id, json: row.spec_json, value }
    return value
  }
  private release(controller: ExperimentController): void {
    controller.ownership?.close()
    controller.ownership = undefined
  }
  /** Release only this exact context's authority; its expired record cannot authorize worker actions. */
  revokeContext(context: OperationContext): void {
    for (const controller of this.controllers.values())
      if (controller.context === context) this.release(controller)
  }
  /** Release live admission ownership; registered operations retain their independent provider-call ownership. */
  close(): void {
    for (const controller of this.controllers.values()) this.release(controller)
  }
  private row(c: OperationContext, id: string): Row {
    this.host.authorize(c)
    const row = this.host.db.prepare('SELECT * FROM experiments WHERE id=?').get(id) as unknown as
      | Row
      | undefined
    if (!row || row.project_id !== c.projectId) throw new Error('Experiment unavailable in this project')
    for (const a of this.request(row).actions) this.host.authorize(c, a.providerId)
    return row
  }
  private emit(row: Row, kind: string, data: Json, bindings?: ProviderBindings) {
    if (!this.host.db.isTransaction) throw new Error('Experiment audit and projection must share the fact transaction')
    const payload = canonicalJson({ experimentId: row.id, ...(data as Record<string, Json>) })
    const at = new Date().toISOString()
    const result = this.host.db.prepare('INSERT INTO events(operation_id,project_id,type,data_json,at) VALUES (?,?,?,?,?)')
      .run('', row.project_id, 'experiment-' + kind, payload, at)
    const sequence = Number(result.lastInsertRowid)
    if (!Number.isSafeInteger(sequence)) throw new Error('Experiment audit sequence exceeds the supported cursor range')
    this.projection.advance(row.id, kind, payload, sequence, at, bindings)
  }
  private active(c: OperationContext, id: string, owner = false): Row {
    const row = this.row(c, id),
      controller = this.controllers.get(id)
    if (!controller) throw new Error('Experiment requires a fresh explicit controller claim')
    this.host.authorize(controller.context)
    if (!controller.ownership) throw new Error('Experiment requires a fresh explicit controller claim')
    if (owner && controller.context !== c) throw new Error('Current experiment controller required')
    return row
  }
  private bindings(row: Row): ProviderBindings {
    return JSON.parse(this.projection.read(row.id).provider_bindings_json) as ProviderBindings
  }
  private bindingChanged(row: Row, expected = this.bindings(row)): boolean {
    const spec = this.request(row)
    return spec.actions.some((a) => expected[a.providerId]?.sha256 !== this.host.binding(a.providerId).sha256)
  }
  private openForAction(c: OperationContext, id: string): Row {
    const row = this.active(c, id)
    if (row.completion_json || row.cancel_requested || row.review_required)
      throw new Error('Experiment is closed, cancelling or awaiting review')
    if (this.bindingChanged(row))
      throw new Error(
        'Experiment Provider version or configuration changed; restore its binding or create a new experiment',
      )
    if (this.get(c, id).operations.some((o) => o.state === 'unknown'))
      throw new Error('Unknown operation blocks further experiment actions')
    return row
  }
  create(c: OperationContext, key: string, input: unknown): ExperimentView {
    this.host.authorize(c)
    text.parse(key)
    const request = experimentRequestSchema.parse(input)
    for (const a of request.actions) this.host.authorize(c, a.providerId)
    for (const id of request.inputArtifactIds) this.host.artifact(c, id)
    const serialized = canonicalJson(request as Json)
    let created: { id: string; controller: ExperimentController } | undefined
    try {
      return this.host.transaction(() => {
        const prior = this.host.db
          .prepare('SELECT id,spec_json FROM experiments WHERE project_id=? AND request_key=?')
          .get(c.projectId, key) as { id: string; spec_json: string } | undefined
        if (prior) {
          if (prior.spec_json !== serialized)
            throw new Error('Experiment request key reused with different requirements')
          return this.get(c, prior.id)
        }
        const providerBindings = Object.fromEntries(
          request.actions.map((a) => [a.providerId, this.host.binding(a.providerId)]),
        )
        const id = randomUUID(), ownership = this.host.ownExperiment(id)
        if (!ownership) throw new Error('Another live experiment controller still owns admission')
        created = { id, controller: { context: c, ownership } }
        this.host.db
          .prepare('INSERT INTO experiments(id,project_id,request_key,spec_json,created_by) VALUES (?,?,?,?,?)')
          .run(id, c.projectId, key, serialized, c.actorId)
        this.emit(this.row(c, id), 'created', { actorId: c.actorId, providerBindings }, providerBindings)
        this.controllers.set(id, created.controller)
        return this.get(c, id)
      })
    } catch (error) {
      if (created) {
        this.controllers.delete(created.id)
        this.release(created.controller)
      }
      throw error
    }
  }
  claim(c: OperationContext, id: string, reason: string): ExperimentView {
    let previous: ExperimentController | undefined, ownership: Ownership | null | undefined
    let updated = false
    try {
      return this.host.transaction(() => {
        const row = this.row(c, id)
        text.parse(reason)
        previous = this.controllers.get(id)
        if (previous?.ownership && previous.context !== c) {
          let live = false
          try {
            this.host.authorize(previous.context)
            live = true
          } catch {
            /* Revoked contexts allow an explicit replacement. */
          }
          if (live) throw new Error('Another live experiment controller still owns admission')
        }
        ownership = previous?.context === c && previous.ownership ? previous.ownership : this.host.ownExperiment(id)
        if (!ownership) throw new Error('Another live experiment controller still owns admission')
        this.emit(row, 'claimed', { actorId: c.actorId, reason })
        this.controllers.set(id, { context: c, ownership })
        updated = true
        return this.get(c, id)
      })
    } catch (error) {
      if (updated) {
        if (previous) this.controllers.set(id, previous)
        else this.controllers.delete(id)
      }
      if (ownership && ownership !== previous?.ownership) ownership.close()
      throw error
    }
  }
  requireController(c: OperationContext, id: string): void {
    this.active(c, id, true)
  }
  get(c: OperationContext, id: string): ExperimentView {
    return this.host.snapshot(() => this.view(c, id))
  }
  private view(c: OperationContext, id: string): ExperimentView {
    const row = this.row(c, id), projected = this.projection.read(id)
    const providerBindings = JSON.parse(projected.provider_bindings_json) as ProviderBindings
    const steps = this.host.db
      .prepare('SELECT * FROM experiment_steps WHERE experiment_id=? ORDER BY rowid')
      .all(id) as unknown as {
      operation_id: string
      action_id: string
      actor_id: string
      decision_json: string
    }[]
    const operations = steps.map((s) => this.host.get(c, s.operation_id))
    const assessments = this.host.db
      .prepare('SELECT * FROM experiment_assessments WHERE experiment_id=? ORDER BY rowid')
      .all(id) as unknown as { id: string; actor_id: string; data_json: string }[]
    let controllerActive = false
    const controller = this.controllers.get(id)
    if (controller?.ownership) {
      try {
        this.host.authorize(controller.context)
        controllerActive = true
      } catch {
        /* Expired live context is never restored from actor id. */
      }
    }
    let state = projected.state, reason = projected.reason
    // Deployment compatibility is connection-specific; readonly observers never rewrite shared state for it.
    if (!row.completion_json && !row.cancel_requested && state !== 'blocked' && this.bindingChanged(row, providerBindings)) {
      state = 'blocked'
      reason = 'Provider version/configuration differs from the approved experiment binding'
    }
    const project = this.host.db
      .prepare('SELECT budget_limit,budget_unlimited,budget_used FROM projects WHERE id=?')
      .get(c.projectId) as { budget_limit: number; budget_unlimited: number; budget_used: number }
    const issue = projected.last_issue_json === null ? null : JSON.parse(projected.last_issue_json) as Json
    return {
      id,
      projectId: row.project_id,
      createdBy: row.created_by,
      requestKey: row.request_key,
      request: structuredClone(this.request(row)),
      providerBindings,
      budgetUsed: projected.budget_used,
      state,
      reason,
      cancelRequested: !!row.cancel_requested,
      controllerActive,
      cursor: projected.cursor,
      operations,
      decisions: steps.map((s) => ({
        operationId: s.operation_id,
        actionId: s.action_id,
        actorId: s.actor_id,
        ...JSON.parse(s.decision_json),
      })),
      assessments: assessments.map((a) => ({ id: a.id, actorId: a.actor_id, ...JSON.parse(a.data_json) })),
      completion: row.completion_json ? JSON.parse(row.completion_json) : null,
      projectBudget: { limit: project.budget_unlimited ? null : project.budget_limit, used: project.budget_used },
      lastIssue: issue,
      scientificConclusion: 'not-evaluated-by-platform',
    }
  }
  list(c: OperationContext): ExperimentView[] {
    this.host.authorize(c)
    return this.host.snapshot(() => (
      this.host.db.prepare('SELECT id FROM experiments WHERE project_id=? ORDER BY rowid').all(c.projectId) as { id: string }[]
    ).map(row => this.get(c, row.id)))
  }
  private evidence(
    c: OperationContext,
    id: string,
    operationIds: string[],
    artifactIds: string[],
  ): Set<string> {
    const view = this.get(c, id),
      owned = new Set(view.operations.map((o) => o.id)),
      inputs = new Set(view.request.inputArtifactIds)
    const related = new Set(operationIds)
    for (const op of operationIds) {
      if (!owned.has(op) || !terminal(this.host.get(c, op).state))
        throw new Error('Evidence must identify an observed terminal operation in this experiment')
    }
    const visit = (aid: string, seen = new Set<string>()): boolean => {
      if (seen.has(aid)) throw new Error('Artifact provenance cycle')
      seen.add(aid)
      const a = this.host.artifact(c, aid).artifact
      if (inputs.has(aid)) return true
      const operation = view.operations.find((o) => o.artifacts.some((x) => x.id === aid))
      if (operation) {
        if (!terminal(operation.state))
          throw new Error('Artifact evidence requires a confirmed terminal operation')
        related.add(operation.id)
        return true
      }
      return a.sources.length > 0 && a.sources.every((source) => visit(source, new Set(seen)))
    }
    for (const artifact of artifactIds)
      if (!visit(artifact))
        throw new Error('Artifact is not sourced from this experiment or its declared inputs')
    return related
  }
  submit(c: OperationContext, id: string, input: unknown): Promise<OperationRecord> {
    const row = this.row(c, id),
      action = experimentActionSchema.parse(input),
      spec = this.request(row)
    const allowed = spec.actions.find((a) => a.id === action.actionId)
    if (!allowed) throw new Error('Action is not in the approved experiment requirements')
    const prior = this.host.db
      .prepare(
        'SELECT operation_id,decision_json FROM experiment_steps WHERE experiment_id=? AND request_key=?',
      )
      .get(id, action.requestKey) as { operation_id: string; decision_json: string } | undefined
    if (prior) {
      if (prior.decision_json !== canonicalJson(action as Json))
        throw new Error('Decision request key changed')
      return Promise.resolve(this.host.get(c, prior.operation_id))
    }
    this.openForAction(c, id)
    try {
      return this.host.submit(
        c,
        {
          providerId: allowed.providerId,
          requestKey: `experiment/${id}/${action.requestKey}`,
          input: allowed.input as Json,
        },
        { experimentId: id, action },
      )
    } catch (error) {
      this.host.transaction(() =>
        this.emit(row, 'action-rejected', {
          actorId: c.actorId,
          actionId: action.actionId,
          reason: String(error),
        }),
      )
      throw error
    }
  }
  /** Engine-only: called inside the same resource/budget/operation registration transaction. */
  register(c: OperationContext, binding: ExperimentBinding, cost: number, operationId: string): void {
    if (!this.host.db.isTransaction)
      throw new Error('Experiment admission must share the operation transaction')
    const row = this.openForAction(c, binding.experimentId),
      view = this.get(c, row.id),
      action = binding.action,
      allowed = view.request.actions.find((a) => a.id === action.actionId)!
    if (
      (view.request.maxOperations !== null && view.operations.length >= view.request.maxOperations) ||
      (allowed.maxUses !== null &&
        view.decisions.filter((d) => d.actionId === action.actionId).length >= allowed.maxUses)
    )
      throw new Error('Experiment operation/action limit exceeded')
    if (view.request.budget !== null && view.budgetUsed + cost > view.request.budget)
      throw new Error('Experiment budget exceeded')
    const related = this.evidence(c, row.id, action.evidenceOperationIds, action.evidenceArtifactIds)
    if (allowed.requiresEvidence && related.size === 0)
      throw new Error('This adjustment requires prior execution evidence')
    this.host.db
      .prepare('INSERT INTO experiment_steps VALUES (?,?,?,?,?,?)')
      .run(operationId, row.id, action.actionId, action.requestKey, c.actorId, canonicalJson(action as Json))
    this.host.db.prepare('UPDATE experiments SET budget_used=budget_used+? WHERE id=?').run(cost, row.id)
    this.emit(row, 'submitted', { actorId: c.actorId, operationId, actionId: action.actionId })
  }
  /** Engine-only: a semantic observation shares the operation update transaction; unchanged query polls stay silent. */
  observed(operationId: string, data: Json): void {
    const row = this.host.db
      .prepare(
        'SELECT e.* FROM experiments e JOIN experiment_steps s ON e.id=s.experiment_id WHERE s.operation_id=?',
      )
      .get(operationId) as unknown as Row | undefined
    if (row) this.emit(row, 'observed', { operationId, observation: data })
  }
  assess(c: OperationContext, id: string, input: unknown): { id: string } {
    const row = this.active(c, id),
      assessment = experimentAssessmentSchema.parse(input)
    if (row.completion_json || row.cancel_requested) throw new Error('Experiment is closed or cancelling')
    if (assessment.operationIds.length + assessment.artifactIds.length === 0)
      throw new Error('Assessment requires execution evidence')
    this.evidence(c, id, assessment.operationIds, assessment.artifactIds)
    const key = randomUUID()
    this.host.transaction(() => {
      this.host.db
        .prepare('INSERT INTO experiment_assessments VALUES (?,?,?,?)')
        .run(key, id, c.actorId, canonicalJson(assessment as Json))
      this.emit(row, 'assessed', { actorId: c.actorId, assessmentId: key })
    })
    return { id: key }
  }
  escalate(c: OperationContext, id: string, reason: string, proposal: Json): ExperimentView {
    const row = this.active(c, id)
    text.parse(reason)
    canonicalJson(proposal)
    if (row.completion_json || row.cancel_requested) throw new Error('Experiment is closed or cancelling')
    this.host.transaction(() => {
      this.host.db.prepare('UPDATE experiments SET review_required=1 WHERE id=?').run(id)
      this.emit(row, 'escalated', { actorId: c.actorId, reason, proposal })
    })
    return this.get(c, id)
  }
  resolve(c: OperationContext, id: string, reason: string): ExperimentView {
    const row = this.active(c, id, true)
    text.parse(reason)
    if (row.completion_json || row.cancel_requested) throw new Error('Experiment is closed or cancelling')
    this.host.transaction(() => {
      this.host.db.prepare('UPDATE experiments SET review_required=0 WHERE id=?').run(id)
      this.emit(row, 'reviewed', {
        actorId: c.actorId,
        reason,
        resolution: 'continue-within-original-requirements',
      })
    })
    return this.get(c, id)
  }
  finish(
    c: OperationContext,
    id: string,
    summary: string,
    artifactIds: string[],
    assessmentIds: string[],
  ): ExperimentView {
    const row = this.active(c, id, true),
      view = this.get(c, id)
    text.parse(summary)
    if (row.completion_json) return view
    if (
      row.cancel_requested ||
      row.review_required ||
      !view.operations.length ||
      view.operations.some((o) => !terminal(o.state))
    )
      throw new Error('Cannot finish with active, unknown, cancelled-admission or unreviewed work')
    for (const action of view.request.actions)
      if (view.decisions.filter((d) => d.actionId === action.id).length < action.minUses)
        throw new Error('Required experiment action missing')
    if (!artifactIds.length) throw new Error('Completion requires sourced artifacts')
    this.evidence(c, id, [], artifactIds)
    if (assessmentIds.some((a) => !view.assessments.some((x) => x.id === a)))
      throw new Error('Unknown experiment assessment')
    const completion = {
      summary,
      artifactIds,
      assessmentIds,
      actorId: c.actorId,
      scientificConclusion: 'not-evaluated-by-platform',
    }
    this.host.transaction(() => {
      this.host.db
        .prepare('UPDATE experiments SET completion_json=? WHERE id=?')
        .run(canonicalJson(completion), id)
      this.emit(row, 'finished', completion)
    })
    return this.get(c, id)
  }
  async cancel(c: OperationContext, id: string): Promise<ExperimentView> {
    const row = this.active(c, id, true)
    if (row.completion_json) return this.get(c, id)
    this.host.transaction(() => {
      this.host.db.prepare('UPDATE experiments SET cancel_requested=1 WHERE id=?').run(id)
      this.emit(row, 'cancel-requested', { actorId: c.actorId })
    })
    for (const op of this.get(c, id).operations) if (!terminal(op.state)) await this.host.cancel(c, op.id)
    return this.get(c, id)
  }
  async wait(
    c: OperationContext,
    id: string,
    options: { after: number; until: 'change' | 'decision'; timeoutMs: number; signal?: AbortSignal },
  ): Promise<ExperimentFeedback> {
    if (
      !Number.isSafeInteger(options.after) ||
      options.after < 0 ||
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 3600000
    )
      throw new Error('Invalid experiment wait bounds')
    const signal = options.signal ? AbortSignal.any([options.signal, this.host.signal]) : this.host.signal
    const deadline = Date.now() + options.timeoutMs
    while (true) {
      signal.throwIfAborted()
      let view = this.get(c, id)
      if (
        options.until === 'decision' &&
        view.state !== 'running' &&
        view.state !== 'cancelling' &&
        view.state !== 'blocked'
      )
        return { reason: 'decision', experiment: view }
      if (options.until === 'change' && view.cursor > options.after)
        return { reason: 'change', experiment: view }
      if (!this.host.observing)
        for (const op of view.operations) if (!terminal(op.state)) await this.host.query(c, op.id)
      view = this.get(c, id)
      if (options.until === 'decision' && view.state !== 'running' && view.state !== 'cancelling')
        return { reason: 'decision', experiment: view }
      if (options.until === 'change' && view.cursor > options.after)
        return { reason: 'change', experiment: view }
      if (Date.now() >= deadline) {
        if (!this.host.observing)
          this.host.transaction(() => this.emit(this.row(c, id), 'wait-timeout', { actorId: c.actorId }))
        return { reason: 'timeout', experiment: this.get(c, id) }
      }
      await delay(Math.min(this.host.pollMs, Math.max(1, deadline - Date.now())), undefined, { signal })
    }
  }
}
