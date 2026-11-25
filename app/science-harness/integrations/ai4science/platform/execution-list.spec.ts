/** Batched metadata reads retain project/provider scopes, artifact association and fresh snapshots. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { ExecutionEngine } from './execution.ts'
import type { ExecutionProvider } from './sdk.ts'

const roots: string[] = [], engines: ExecutionEngine[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const engine of engines.splice(0)) await engine.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function world(count = 8) {
  const root = mkdtempSync(join(tmpdir(), 'ai4s-list-'))
  roots.push(root)
  const never = (): never => { throw new Error('Metadata listing must not run a Provider') }
  const provider = (id: string): ExecutionProvider => ({
    describe: () => ({ apiVersion: 1, id, version: '1', configuration: {}, inputSchema: {}, outputSchema: {},
      units: {}, constraints: [], completion: 'No work.', cancellation: 'No work.' }),
    prepare: never, submit: never, query: never, cancel: never,
  })
  const engine = new ExecutionEngine({ directory: root, providers: [provider('a'), provider('b')], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  engines.push(engine)
  await engine.open(); engine.createProject('p', 100); engine.createProject('foreign', 100)
  const db = new DatabaseSync(join(root, 'execution.sqlite'))
  try {
    const operation = db.prepare(`INSERT INTO operations(id,project_id,actor_id,provider_id,provider_version,provider_fingerprint,
      request_key,request_json,input_json,resources_json,budget,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const artifact = db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?)')
    db.exec('BEGIN IMMEDIATE')
    for (let i = 0; i < count; i++) {
      const id = `op-${i}`, project = i === count - 1 ? 'foreign' : 'p', providerId = i % 2 ? 'b' : 'a'
      operation.run(id, project, 'owner', providerId, '1', '{}', id, '{}', 'null', '[]', 1, 'succeeded', String(i).padStart(4, '0'), 'now')
      for (const suffix of ['z', 'a']) artifact.run(`${id}-${suffix}`, id, `${id}/${suffix}.json`, '0'.repeat(64), 1, 'application/json')
    }
    db.exec('COMMIT')
  } finally { db.close() }
  return { engine, root }
}

it('joins only the current project and provider grant, preserving per-operation artifact ordering', async () => {
  const { engine } = await world()
  const c = engine.issueContext('p', 'reader', ['a'])
  const rows = engine.list(c)
  expect(rows.map(row => row.id)).toEqual(['op-0', 'op-2', 'op-4', 'op-6'])
  for (const row of rows) {
    expect(row.projectId).toBe('p'); expect(row.providerId).toBe('a')
    expect(row.artifacts.map(artifact => artifact.id)).toEqual([`${row.id}-a`, `${row.id}-z`])
    expect(row.artifacts.every(artifact => artifact.operationId === row.id)).toBe(true)
    expect(engine.get(c, row.id)).toEqual(row)
  }
  expect(engine.list(engine.issueContext('p', 'empty', []))).toEqual([])
  expect(() => engine.get(c, 'op-1')).toThrow('not authorized')
  engine.revokeContext(c)
  expect(() => engine.list(c)).toThrow('expired')
})

it('uses two SELECT executions independent of operation count, with no per-row artifact query', async () => {
  const { engine } = await world(120)
  const c = engine.issueContext('p', 'reader', ['a', 'b'])
  const spy = vi.spyOn(StatementSync.prototype, 'all')
  expect(engine.list(c)).toHaveLength(119)
  expect(spy).toHaveBeenCalledTimes(2)
})

it('reuses SQL programs per connection while executing both queries on each fresh list', async () => {
  const { engine } = await world()
  const c = engine.issueContext('p', 'reader', ['a'])
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare'), all = vi.spyOn(StatementSync.prototype, 'all')
  engine.list(c)
  expect(prepare).toHaveBeenCalledTimes(2)
  engine.list(c)
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(all).toHaveBeenCalledTimes(4)
  const observer = await engine.observer()
  engines.push(observer)
  const reader = observer.issueContext('p', 'observer', ['a'])
  prepare.mockClear(); all.mockClear()
  expect(observer.list(reader)).toEqual(engine.list(c))
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(all).toHaveBeenCalledTimes(4)
})

it('accepts large grants without SQL placeholder limits and reads peer changes rather than caching result data', async () => {
  const { engine, root } = await world()
  const c = engine.issueContext('p', 'reader', Array.from({ length: 40000 }, () => 'a'))
  const first = engine.list(c)
  first[0]!.artifacts[0]!.path = 'caller mutation'
  const db = new DatabaseSync(join(root, 'execution.sqlite'))
  try { db.prepare('UPDATE operations SET detail=? WHERE id=?').run('peer update', 'op-0') }
  finally { db.close() }
  const next = engine.list(c)
  expect(next[0]!.detail).toBe('peer update')
  expect(next[0]!.artifacts[0]!.path).toBe('op-0/a.json')
})
