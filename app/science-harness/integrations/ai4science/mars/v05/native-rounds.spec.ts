/** Native staging uses a real durable execution journal, without model requests. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { NativeRounds, isV05Mutation } from './native-rounds.ts'

const roots: string[] = [], engines: ExecutionEngine[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) await engine.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function open(directory?: string, initialTick = 0) {
  const root = directory ?? mkdtempSync(join(tmpdir(), 'mars-native-rounds-')); if (!directory) roots.push(root)
  const engine = new ExecutionEngine({ directory: root, providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 }); engines.push(engine)
  await engine.open(); engine.createProject('mars', null)
  const admin = engine.issueContext('mars', 'round-host', [])
  let now = initialTick
  const source: { claims: { revision: number }[] } = { claims: [{ revision: 1 }] }
  const rounds = new NativeRounds(engine, admin, () => now, 12, () => ['actor-b', 'actor-a'], () => source)
  return { engine, admin, root, rounds, source, tick: (value: number) => { now = value } }
}

it('commits different arrival permutations identically and rotates actor priority next round', async () => {
  const observed: string[][] = []
  for (const arrival of [['actor-b', 'actor-a'], ['actor-a', 'actor-b']]) {
    const { rounds, tick } = await open(), sequence: string[] = []
    for (const actor of arrival) expect(rounds.queue(actor, `${actor}-first`, 'research_write', { id: actor })).toMatchObject({ state: 'pending', round: 0 })
    await rounds.commit(async (actor, _id, tool) => { sequence.push(`${actor}:${tool}`); return { accepted: true } })
    observed.push(sequence)
    tick(12)
    for (const actor of arrival) rounds.queue(actor, `${actor}-second`, 'research_write', { id: actor })
    const next: string[] = []
    await rounds.commit(async actor => { next.push(actor); return null })
    expect(next).toEqual(['actor-b', 'actor-a'])
  }
  expect(observed).toEqual([['actor-a:research_write', 'actor-b:research_write'], ['actor-a:research_write', 'actor-b:research_write']])
})

it('persists a detached initial snapshot and rejects actors outside the frozen participant set', async () => {
  const { rounds, engine, admin, source } = await open()
  rounds.begin()
  source.claims[0]!.revision = 3
  rounds.queue('actor-a', 'write', 'research_write', { id: 'claim' })
  source.claims[0]!.revision = 7
  const opened = engine.readFacts(admin).find(fact => fact.kind === 'mars-v05-round' && (fact.data as { key?: string }).key === 'open:0')!
  expect((opened.data as unknown as { value: { snapshot: Json } }).value.snapshot).toEqual({ claims: [{ revision: 1 }] })
  expect(() => rounds.queue('intruder', 'bad', 'research_write', {})).toThrow('actor')
  await rounds.commit(async () => ({ value: true }))
  expect(rounds.receipts('actor-a')).toHaveLength(1)
  expect(rounds.receipts('actor-b')).toHaveLength(0)
})

it('classifies queries separately from every mutation and conservatively stages unknown tools', () => {
  for (const name of ['research_catalog', 'research_read', 'round_receipts', 'mars_observe', 'artifact_read', 'telemetry_query', 'archive_sql']) expect(isV05Mutation(name, {}), name).toBe(false)
  for (const action of ['list', 'check']) expect(isV05Mutation('experiment_plan', { action })).toBe(false)
  expect(isV05Mutation('resource_reservation', { action: 'list' })).toBe(false)
  for (const action of ['schedule', 'amend', 'cancel']) expect(isV05Mutation('experiment_plan', { action })).toBe(true)
  for (const action of ['reserve', 'release']) expect(isV05Mutation('resource_reservation', { action })).toBe(true)
  for (const name of ['research_write', 'prediction_commit', 'model_register', 'analysis_run', 'robot_move', 'unrecognized-write']) expect(isV05Mutation(name, {}), name).toBe(true)
})

it('restores pending receipts and treats reordered JSON keys as the same call while rejecting changed input', async () => {
  const first = await open()
  const pending = first.rounds.queue('actor-a', 'stable', 'research_write', { b: 2, a: 1 })
  expect(first.rounds.queue('actor-a', 'stable', 'research_write', { a: 1, b: 2 })).toEqual(pending)
  await first.engine.close()
  const restored = await open(first.root)
  expect(restored.rounds.queue('actor-a', 'stable', 'research_write', { a: 1, b: 2 })).toEqual(pending)
  expect(() => restored.rounds.queue('actor-a', 'stable', 'research_write', { a: 9, b: 2 })).toThrow('different intent')
  let calls = 0
  await restored.rounds.commit(async (_actor, callId) => { calls++; expect(callId).toMatch(/^v05-apply-[a-f0-9]{64}$/); return { stored: true } })
  await restored.rounds.commit(async () => { calls++; return null })
  expect(calls).toBe(1)
  expect(restored.rounds.receipts('actor-a')).toEqual([{ actorId: 'actor-a', callId: 'stable', round: 0, result: { stored: true } }])
})

it('replays a failed commit with stable application keys and does not repeat already published outcomes', async () => {
  const first = await open(), effects = new Map<string, Json>()
  first.rounds.queue('actor-a', 'first', 'research_write', { id: 'a' })
  first.rounds.queue('actor-b', 'second', 'research_write', { id: 'b' })
  const calls: string[] = []
  const apply = async (actor: string, key: string) => { calls.push(key); let result = effects.get(key); if (!result) { result = { actor }; effects.set(key, result) } return result }
  const original = first.engine.recordFact.bind(first.engine)
  let failOnce = true
  vi.spyOn(first.engine, 'recordFact').mockImplementation((...args) => {
    if (args[1] === 'mars-v05-native-receipt' && (args[2] as { actorId?: string }).actorId === 'actor-b' && failOnce) { failOnce = false; throw new Error('response publication failed') }
    return original(...args)
  })
  await expect(first.rounds.commit(apply)).rejects.toThrow('publication failed')
  expect(first.rounds.receipts('actor-a')).toHaveLength(1)
  expect(first.rounds.receipts('actor-b')).toHaveLength(0)
  await first.engine.close()
  const restored = await open(first.root)
  await restored.rounds.commit(apply)
  expect(effects.size).toBe(2)
  expect(calls).toHaveLength(3)
  expect(calls[1]).toBe(calls[2])
  expect(restored.rounds.receipts('actor-a')).toHaveLength(1)
  expect(restored.rounds.receipts('actor-b')).toHaveLength(1)
})
