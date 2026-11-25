import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { V05Planning } from './planning.ts'
import { orderRoundIntents, V05Rounds, type RoundIntent } from './rounds.ts'

const roots: string[] = [], engines: ExecutionEngine[] = []
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(directory?: string) {
  const root = directory ?? mkdtempSync(join(tmpdir(), 'mars-v05-plans-')); if (!directory) roots.push(root)
  const engine = new ExecutionEngine({ directory: root, providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 }); engines.push(engine)
  await engine.open(); engine.createProject('mars', null)
  const context = engine.issueContext('mars', 'water', []), other = engine.issueContext('mars', 'plant', [])
  let tick = 0
  return { root, engine, context, other, setTick: (value: number) => { tick = value },
    plans: new V05Planning(engine, context, () => tick, { cold: 2 }), foreign: new V05Planning(engine, other, () => tick, { cold: 2 }) }
}
it('uses half-open capacity reservations, ownership, revisions and durable retry receipts', async () => {
  const { plans, foreign, engine, root } = await fixture()
  const first = plans.reserve('r1', { resource: 'cold', start: 0, end: 10, quantity: 2 })
  expect(plans.reserve('r1', { resource: 'cold', start: 0, end: 10, quantity: 2 })).toEqual(first)
  expect(() => plans.reserve('r1', { resource: 'cold', start: 1, end: 10, quantity: 2 })).toThrow('different input')
  expect(() => foreign.reserve('conflict', { resource: 'cold', start: 9, end: 11 })).toThrow('capacity')
  expect(plans.reserve('next', { resource: 'cold', start: 10, end: 20, quantity: 2 }).start).toBe(10)
  expect(() => foreign.release('steal', first.id, 1)).toThrow('unowned')
  const released = plans.release('release', first.id, 1)
  expect(() => plans.release('stale', first.id, 1)).toThrow('revision')
  await engine.close()
  const reopened = await fixture(root)
  expect(reopened.plans.reservations().find(v => v.id === first.id)).toEqual(released)
})
it('dispatches only due dependency-ready steps with stable keys and preserves accepted operations on cancel', async () => {
  const { plans, foreign, setTick } = await fixture()
  expect(() => plans.schedule('bad', { title: 'cycle', steps: [
    { id: 'a', providerId: 'water', input: {}, dependsOn: ['b'] }, { id: 'b', providerId: 'water', input: {}, dependsOn: ['a'] }] })).toThrow('cycle')
  const plan = plans.schedule('good', { title: 'sample then assay', steps: [
    { id: 'sample', providerId: 'water', input: { action: 'sample' }, at: 12 },
    { id: 'assay', providerId: 'water', input: { action: 'process' }, dependsOn: ['sample'] }] })
  const calls: string[] = [], states = new Map<string, string>()
  const submit = async (_provider: string, _input: unknown, key: string) => { calls.push(key); return { id: key } }
  await plans.advance(submit, id => states.get(id)); expect(calls).toHaveLength(0)
  setTick(12); await plans.advance(submit, id => states.get(id)); expect(calls).toEqual([`v05:${plan.id}:sample`])
  await plans.advance(submit, id => states.get(id)); expect(calls).toHaveLength(1)
  states.set(calls[0]!, 'succeeded'); await plans.advance(submit, id => states.get(id)); expect(calls).toHaveLength(2)
  const current = plans.list()[0]!
  expect(() => foreign.cancel('steal', plan.id, current.revision)).toThrow('unowned')
  expect(() => plans.amend('overwrite', plan.id, current.revision, { title: 'changed', steps: [{ id: 'sample', providerId: 'water', input: { action: 'different' } }] })).toThrow('accepted')
  const cancelled = plans.cancel('cancel', plan.id, current.revision)
  expect(cancelled.operations).toEqual(current.operations)
  await plans.advance(submit, id => states.get(id)); expect(calls).toHaveLength(2)
})
it('checks phase admission only for eligible work and rechecks it after an awaited submission', async () => {
  const { engine, context, setTick } = await fixture()
  let allowed = true, checks = 0, submitted = 0
  const states = new Map<string, string>()
  const plans = new V05Planning(engine, context, () => tick, {}, undefined, 'v06', () => { checks++; return allowed })
  let tick = 0
  plans.schedule('gated', { title: 'Eligible phase checks', steps: [
    { id: 'early', at: 0, providerId: 'water', input: {} },
    { id: 'future', at: 100, dependsOn: ['early'], providerId: 'water', input: {} }] })
  const submit = async () => { const id = `op-${++submitted}`; states.set(id, 'succeeded'); return { id } }
  await plans.advance(submit, id => states.get(id)); expect(checks).toBe(1)
  await plans.advance(submit, id => states.get(id)); expect(checks).toBe(1)
  tick = 100; setTick(tick); allowed = false
  await plans.advance(submit, id => states.get(id)); expect(submitted).toBe(1)
  allowed = true; await plans.advance(submit, id => states.get(id)); expect(submitted).toBe(2)
  const next = new V05Planning(engine, context, () => tick, {}, undefined, 'v06', () => allowed)
  next.schedule('changes-during-await', { title: 'Admission closes during awaited submit', steps: [
    { id: 'a', providerId: 'water', input: {} }, { id: 'b', providerId: 'water', input: {} }] })
  const calls: string[] = []
  await next.advance(async (_provider, _input, key) => { calls.push(key); allowed = false; states.set(key, 'succeeded'); return { id: key } }, id => states.get(id))
  expect(calls).toHaveLength(1)
})
it('orders intents independently of arrival and rotates priority across actors', () => {
  const a: RoundIntent = { actorId: 'a', sequence: 0, requestKey: 'a0', input: {} }, b: RoundIntent = { actorId: 'b', sequence: 0, requestKey: 'b0', input: {} }
  expect(orderRoundIntents(0, ['b', 'a'], [b, a])).toEqual([a, b])
  expect(orderRoundIntents(1, ['a', 'b'], [a, b])).toEqual([b, a])
  expect(() => orderRoundIntents(0, ['a'], [a, a])).toThrow('Duplicate')
})
it('keeps cancellation when physical admission resolves after cancellation', async () => {
  const { plans } = await fixture()
  const plan = plans.schedule('race', { title: 'race', steps: [{ id: 'a', providerId: 'water', input: {} }, { id: 'b', providerId: 'water', input: {} }] })
  let resolveAdmission!: (value: { id: string }) => void
  const calls: string[] = []
  const advancing = plans.advance(async (_provider, _input, key) => { calls.push(key); return new Promise(resolve => { resolveAdmission = resolve }) })
  expect(() => plans.amend('amend-race', plan.id, plan.revision, { title: 'changed', steps: [{ id: 'a', providerId: 'water', input: {} }] })).toThrow('in progress')
  plans.cancel('cancel-race', plan.id, plan.revision)
  resolveAdmission({ id: 'accepted-before-cancel' }); await advancing
  expect(plans.list()[0]?.state).toBe('cancelled')
  expect(plans.list()[0]?.operations).toEqual({ a: 'accepted-before-cancel' })
  expect(calls).toHaveLength(1)
})
it('restores prepared intents and skips durable applied intents when committing again', async () => {
  const { engine, root, context } = await fixture(), rounds = new V05Rounds(engine, context)
  rounds.open(0, 0, ['water'], { eventCursor: 0 })
  rounds.prepare(0, { actorId: 'water', sequence: 0, requestKey: 'sample', input: { action: 'sample' } })
  await engine.close()
  const restored = await fixture(root), journal = new V05Rounds(restored.engine, restored.context)
  let calls = 0
  const apply = async () => { calls++; return { operation: 'op-1' } }
  await journal.commit(0, apply); await journal.commit(0, apply)
  expect(calls).toBe(1); expect(journal.committed(0)).toBe(true)
  expect(() => journal.prepare(0, { actorId: 'water', sequence: 1, requestKey: 'late', input: {} })).toThrow('committed')
})

it('returns nonblocking pending receipts, freezes query state and gates strict commits on all responses', async () => {
  const { engine, context } = await fixture(), rounds = new V05Rounds(engine, context)
  rounds.open(2, 24, ['water', 'plant'], { claims: [{ revision: 1 }] })
  const view = rounds.snapshot(2) as { claims: { revision: number }[] }
  view.claims[0]!.revision = 99
  expect(rounds.snapshot(2)).toEqual({ claims: [{ revision: 1 }] })
  expect(rounds.collect(2, { actorId: 'water', sequence: 0, requestKey: 'w', input: { tool: 'claim_publish', args: {} } })).toMatchObject({ state: 'pending', availableRound: 3 })
  rounds.response(2, 'water', { done: true })
  expect(rounds.ready(2)).toBe(false)
  let applied = 0
  const apply = async () => { applied++; return { state: 'accepted' } }
  await expect(rounds.commit(2, apply, true)).rejects.toThrow('pending responses')
  expect(applied).toBe(0)
  rounds.response(2, 'plant', { asleep: true })
  await Promise.all([rounds.commit(2, apply, true), rounds.commit(2, apply, true)])
  expect(applied).toBe(1)
  expect(rounds.results(2)).toEqual([{ key: 'applied:2:water:0', value: { state: 'accepted' } }])
})
