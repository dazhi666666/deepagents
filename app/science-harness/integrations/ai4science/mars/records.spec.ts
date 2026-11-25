/** Durable planning and note recovery through the real execution fact store. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { MarsRecords } from './records.ts'

const roots: string[] = [], engines: ExecutionEngine[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function open(directory?: string) {
  const root = directory ?? mkdtempSync(join(tmpdir(), 'mars-records-'))
  if (!directory) roots.push(root)
  const engine = new ExecutionEngine({ directory: root, providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  engines.push(engine)
  await engine.open()
  engine.createProject('mars', null)
  const context = engine.issueContext('mars', 'brain', [])
  return { engine, root, records: new MarsRecords(engine, context), context }
}

it('starts empty, records actual author, deduplicates retries and preserves notes through reopen', async () => {
  const { engine, root, records } = await open()
  expect(records.listTasks()).toEqual([])
  const input = { title: '调查水路', objectiveIds: ['W1'] }
  const task = records.createTask('create', input)
  expect(task.createdBy).toBe('brain')
  expect(records.createTask('create', input)).toEqual(task)
  expect(() => records.createTask('create', { ...input, title: 'changed' })).toThrow('different input')
  records.updateTask('start', task.id, 1, { state: 'running', reason: '已调查设备' })
  expect(() => records.updateTask('stale', task.id, 1, { state: 'completed', reason: '旧版本' })).toThrow('revision')
  const note = records.writeNote('write', 'plans/水循环.md', 0, '先检查泵，再获取水样。\n引用 operation-1。')
  expect(records.writeNote('write', note.path, 0, note.text)).toEqual(note)
  expect(() => records.writeNote('overwrite', note.path, 0, 'lost')).toThrow('revision')
  await engine.close()
  const restored = await open(root)
  expect(restored.records.listTasks()).toEqual([{ ...task, revision: 2, state: 'running', reason: '已调查设备' }])
  expect(restored.records.listNotes()).toEqual([note])
})

it('rejects dependency cycles, unknown objectives and invalid record paths without committing changes', async () => {
  const { records, engine, context } = await open()
  const first = records.createTask('a', { title: 'a', objectiveIds: ['W1'] })
  const second = records.createTask('b', { title: 'b', objectiveIds: ['G2'], dependencies: [first.id] })
  expect(() => records.updateTask('cycle', first.id, 1, { dependencies: [second.id], reason: 'cycle' })).toThrow('cycle')
  expect(() => records.createTask('unknown', { title: 'bad', objectiveIds: ['W999'] })).toThrow('objective')
  expect(() => records.writeNote('escape', 'notes/../../private', 0, 'secret')).toThrow('path')
  expect(records.listTasks()).toHaveLength(2)
  engine.revokeContext(context)
  expect(() => records.listNotes()).toThrow()
})
