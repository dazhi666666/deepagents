/** Migration, rollback and readonly behavior of the experiment's materialized state. */
import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { ExecutionEngine, EXECUTION_SCHEMA_VERSION } from './execution.ts'
import { Artifacts } from './artifacts.ts'
import type { ExecutionProvider, ExperimentRequest, ExperimentView } from './index.ts'

const roots: string[] = [], engines: ExecutionEngine[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const engine of engines.splice(0)) await engine.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ai4s-projection-'))
  roots.push(root)
  const calls = { submit: 0, query: 0 }
  const provider = (generation = 0): ExecutionProvider => ({
    describe: () => ({ apiVersion: 1, id: 'work', version: '1', configuration: { generation }, inputSchema: {}, outputSchema: {},
      units: { budget: 'run' }, constraints: [], completion: 'Observed terminal state.', cancellation: 'Observed cancellation.' }),
    prepare: input => ({ input, resources: [], budget: 1 }),
    submit: async () => { calls.submit++; return { state: 'running' } },
    query: async () => { calls.query++; return { state: 'running' } },
    cancel: async () => ({ disposition: 'requested', observation: { state: 'cancelled' } }),
  })
  const make = (generation = 0, retentionDays = 30) => {
    const engine = new ExecutionEngine({ directory: root, providers: [provider(generation)], pollIntervalMs: 5,
      providerCallTimeoutMs: 1000, retentionDays })
    engines.push(engine)
    return engine
  }
  const request: ExperimentRequest = { goal: 'Check materialized experiment state', method: { id: 'test', version: '1' },
    context: {}, inputArtifactIds: [], outputRequirements: 'Actual observations', budget: 10, maxOperations: 3,
    actions: [{ id: 'run', providerId: 'work', input: null, minUses: 0, maxUses: 3, requiresEvidence: false }] }
  return { root, calls, make, request }
}
const action = { requestKey: 'run', actionId: 'run', rationale: 'Use the approved operation.', evidenceOperationIds: [], evidenceArtifactIds: [] }
function stable(view: ExperimentView) {
  const { controllerActive: _authority, ...facts } = view
  return facts
}

it('migrates schema 3 states, rejected decisions, bindings and cursors without querying or replaying work', async () => {
  const w = setup(), first = w.make()
  await first.open()
  first.createProject('p', 100)
  const c = first.issueContext('p', 'first', ['work'])
  const waiting = first.experiments.create(c, 'waiting', { ...w.request, budget: 0 })
  expect(() => first.experiments.submit(c, waiting.id, action)).toThrow('budget')
  const active = first.experiments.create(c, 'active', w.request)
  await first.experiments.submit(c, active.id, action)
  const cancelled = first.experiments.create(c, 'cancelled', w.request)
  await first.experiments.cancel(c, cancelled.id)
  const before = first.experiments.list(c).map(stable)
  await first.close()
  const db = new DatabaseSync(join(w.root, 'execution.sqlite'))
  db.exec('DROP TABLE experiment_view; DROP TABLE execution_meta; PRAGMA user_version=3')
  const auditCount = db.prepare('SELECT COUNT(*) n FROM events').get()!.n
  db.close()
  const calls = { ...w.calls }, next = w.make()
  await next.open({ recover: false })
  const fresh = next.issueContext('p', 'second', ['work'])
  expect(next.experiments.list(fresh).map(stable)).toEqual(before)
  expect(next.experiments.get(fresh, active.id).controllerActive).toBe(false)
  expect(w.calls).toEqual(calls)
  const inspect = new DatabaseSync(join(w.root, 'execution.sqlite'), { readOnly: true })
  try {
    expect(inspect.prepare('PRAGMA user_version').get()!.user_version).toBe(EXECUTION_SCHEMA_VERSION)
    expect(inspect.prepare('SELECT COUNT(*) n FROM events').get()!.n).toBe(auditCount)
    expect(inspect.prepare('SELECT COUNT(*) n FROM experiment_view').get()!.n).toBe(3)
  } finally { inspect.close() }
})

it('rolls back facts, audit and projected state together when projection publication fails', async () => {
  const w = setup(), engine = w.make()
  await engine.open(); engine.createProject('p', 100)
  const c = engine.issueContext('p', 'controller', ['work'])
  const experiment = engine.experiments.create(c, 'rollback', w.request)
  const before = stable(engine.experiments.get(c, experiment.id)), cursor = engine.eventCursor(c)
  const db = new DatabaseSync(join(w.root, 'execution.sqlite'))
  try {
    db.exec("CREATE TRIGGER reject_projection BEFORE UPDATE ON experiment_view BEGIN SELECT RAISE(ABORT,'projection failure'); END")
    expect(() => engine.experiments.escalate(c, experiment.id, 'Request a review', {})).toThrow('projection failure')
    expect(stable(engine.experiments.get(c, experiment.id))).toEqual(before)
    expect(engine.eventCursor(c)).toBe(cursor)
    expect(db.prepare('SELECT review_required FROM experiments WHERE id=?').get(experiment.id)!.review_required).toBe(0)
    db.exec('DROP TRIGGER reject_projection')
    expect(engine.experiments.escalate(c, experiment.id, 'Request a review', {}).state).toBe('needs_review')
  } finally { db.close() }
})

it('keeps cached approved requirements isolated from mutable returned views', async () => {
  const w = setup(), engine = w.make()
  await engine.open(); engine.createProject('p', 100)
  const c = engine.issueContext('p', 'controller', ['work'])
  const experiment = engine.experiments.create(c, 'copies', w.request)
  experiment.request.actions[0]!.input = 'unapproved replacement'
  experiment.request.goal = 'changed display'
  const next = engine.experiments.get(c, experiment.id)
  expect(next.request.actions[0]!.input).toBeNull()
  expect(next.request.goal).toBe(w.request.goal)
  expect((await engine.experiments.submit(c, experiment.id, action)).input).toBeNull()
})

it('readonly compatibility diagnostics and wait timeouts neither rewrite the projection nor call providers', async () => {
  const w = setup(), writer = w.make()
  await writer.open(); writer.createProject('p', 100)
  const c = writer.issueContext('p', 'controller', ['work'])
  const experiment = writer.experiments.create(c, 'readonly', w.request)
  await writer.experiments.submit(c, experiment.id, action)
  const cursor = writer.eventCursor(c), calls = { ...w.calls }
  const observer = w.make(), incompatible = w.make(1)
  await observer.openObserver(); await incompatible.openObserver()
  const view = observer.issueContext('p', 'observer', ['work'])
  const result = await observer.experiments.wait(view, experiment.id, { after: cursor, until: 'change', timeoutMs: 10 })
  expect(result.reason).toBe('timeout')
  expect(incompatible.experiments.get(incompatible.issueContext('p', 'observer', ['work']), experiment.id).state).toBe('blocked')
  expect(writer.experiments.get(c, experiment.id).state).toBe('running')
  expect(writer.eventCursor(c)).toBe(cursor)
  expect(w.calls).toEqual(calls)
})

it('performs the same bounded SQL reads for 100 polls before and after unrelated audit growth', async () => {
  const w = setup(), engine = w.make()
  await engine.open(); engine.createProject('p', 100)
  const c = engine.issueContext('p', 'controller', ['work'])
  const experiment = engine.experiments.create(c, 'bounded', w.request)
  const gets = vi.spyOn(StatementSync.prototype, 'get'), lists = vi.spyOn(StatementSync.prototype, 'all')
  const poll = () => {
    gets.mockClear(); lists.mockClear()
    for (let i = 0; i < 100; i++) engine.experiments.get(c, experiment.id)
    const sql = [...gets.mock.contexts, ...lists.mock.contexts].map(statement => (statement as StatementSync).sourceSQL)
    expect(sql.length).toBeGreaterThanOrEqual(100)
    expect(sql.some(query => /\bFROM\s+events\b/i.test(query))).toBe(false)
    return sql.length
  }
  const before = poll()
  const db = new DatabaseSync(join(w.root, 'execution.sqlite'))
  try {
    db.exec('BEGIN IMMEDIATE')
    const insert = db.prepare('INSERT INTO events(operation_id,project_id,type,data_json,at) VALUES(NULL,?,?,?,?)')
    for (let i = 0; i < 5000; i++) insert.run('p', 'unrelated-history', '{}', '2026-01-01T00:00:00.000Z')
    db.exec('COMMIT')
  } finally { db.close() }
  expect(poll()).toBe(before)
})

it('archives settled audit while preserving views, facts, grants and a preexisting readonly reader', async () => {
  const w = setup(), writer = w.make(0, 0)
  await writer.open(); writer.createProject('p', 100)
  const c = writer.issueContext('p', 'controller', ['work'])
  const experiment = writer.experiments.create(c, 'archive', w.request)
  await writer.experiments.cancel(c, experiment.id)
  writer.recordFact(c, 'participant-created', { id: 'persistent-member' })
  const artifacts = new Artifacts(writer)
  const artifact = artifacts.publish(c, { content: 'Retained result', mediaType: 'text/plain', sources: [] })
  const before = writer.experiments.get(c, experiment.id), audit = writer.events(c), cursor = writer.eventCursor(c)
  const observer = w.make()
  await observer.openObserver()
  const reader = observer.issueContext('p', 'reader', ['work'])
  expect(observer.eventCursor(reader)).toBe(cursor)
  expect(writer.archiveEvents()).toBeGreaterThan(0)
  expect(existsSync(join(w.root, 'events-archive.sqlite'))).toBe(true)
  expect(writer.experiments.get(c, experiment.id)).toEqual(before)
  expect(observer.experiments.get(reader, experiment.id).providerBindings).toEqual(before.providerBindings)
  expect(writer.events(c)).toEqual(audit)
  expect(observer.events(reader)).toEqual(audit)
  expect(observer.eventCursor(reader)).toBe(cursor)
  expect(new Artifacts(observer).read(reader, artifact.id).content).toBe('Retained result')
  expect(writer.readFacts(c).some(fact => fact.kind === 'participant-created')).toBe(true)
  expect(() => observer.archiveEvents()).toThrow('read-only')
  writer.recordFact(c, 'new-fact', {})
  expect(writer.eventCursor(c)).toBeGreaterThan(cursor)
  const db = new DatabaseSync(join(w.root, 'execution.sqlite'), { readOnly: true })
  try {
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type GLOB 'experiment-*'").get()!.n).toBe(0)
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type='fact'").get()!.n).toBeGreaterThan(0)
    expect(db.prepare('SELECT COUNT(*) n FROM experiments').get()!.n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) n FROM experiment_view').get()!.n).toBe(1)
  } finally { db.close() }
})

it('retains recent terminal audit by default and does not create an empty archive', async () => {
  const w = setup(), engine = w.make()
  await engine.open(); engine.createProject('p', 100)
  const c = engine.issueContext('p', 'controller', ['work'])
  const experiment = engine.experiments.create(c, 'recent', w.request)
  await engine.experiments.cancel(c, experiment.id)
  const audit = engine.events(c)
  expect(engine.archiveEvents()).toBe(0)
  expect(existsSync(join(w.root, 'events-archive.sqlite'))).toBe(false)
  expect(engine.events(c)).toEqual(audit)
})

it.each(['malformed JSON', 'duplicate creation'] as const)('rolls migration with %s back before any provider call', async failure => {
  const w = setup(), first = w.make()
  await first.open(); first.createProject('p', 100)
  const c = first.issueContext('p', 'controller', ['work'])
  first.experiments.create(c, 'malformed-history', w.request)
  await first.close()
  const db = new DatabaseSync(join(w.root, 'execution.sqlite'))
  try {
    db.exec('DROP TABLE experiment_view; DROP TABLE execution_meta; PRAGMA user_version=3')
    if (failure === 'malformed JSON') db.exec("UPDATE events SET data_json='broken' WHERE type='experiment-created'")
    else db.exec(`INSERT INTO events(operation_id,project_id,type,data_json,at)
      SELECT operation_id,project_id,type,data_json,at FROM events WHERE type='experiment-created'`)
    const count = db.prepare('SELECT COUNT(*) n FROM events').get()!.n
    const next = w.make()
    await expect(next.open({ recover: false })).rejects.toThrow()
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(3)
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('experiment_view','execution_meta')").get()!.n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) n FROM events').get()!.n).toBe(count)
    expect(w.calls).toEqual({ submit: 0, query: 0 })
  } finally { db.close() }
})

it('refuses a current-format missing projection before recovery can touch a Provider', async () => {
  const w = setup(), first = w.make()
  await first.open(); first.createProject('p', 100)
  const c = first.issueContext('p', 'controller', ['work'])
  const experiment = first.experiments.create(c, 'integrity', w.request)
  await first.experiments.submit(c, experiment.id, action)
  await first.close()
  const db = new DatabaseSync(join(w.root, 'execution.sqlite'))
  try { db.prepare('DELETE FROM experiment_view WHERE experiment_id=?').run(experiment.id) }
  finally { db.close() }
  const calls = { ...w.calls }, next = w.make()
  await expect(next.open()).rejects.toThrow('Experiment projection missing')
  expect(w.calls).toEqual(calls)
})
