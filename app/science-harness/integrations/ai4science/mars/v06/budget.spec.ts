import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { V06Budget, BudgetExhausted, MonetaryAdmissions, type BudgetConfig } from './budget.ts'
const roots: string[] = [], ledgers: V06Budget[] = []
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const config: BudgetConfig = { limitUsd: 0.001, prices: [{ provider: 'fixture', model: 'mock', inputPerMillion: 1, cacheReadPerMillion: 0.1,
  cacheWritePerMillion: 1.25, outputPerMillion: 2, maxInputTokens: 100, maxOutputTokens: 100, verified: true, singleAttempt: true }] }
function fixture(input = config) {
  const root = mkdtempSync(join(tmpdir(), 'mars-budget-')); roots.push(root)
  const path = join(root, 'outside-world.sqlite'), ledger = new V06Budget(path, input); ledgers.push(ledger)
  return { path, ledger }
}
it('atomically reserves the last balance across independent ledger owners', async () => {
  const { path, ledger } = fixture({ ...config, limitUsd: 0.0005 })
  const second = new V06Budget(path, { ...config, limitUsd: 0.0005 }); ledgers.push(second)
  ledger.reserve('first', 'actor-1', 'fixture', 'mock', 100)
  expect(() => second.reserve('second', 'actor-2', 'fixture', 'mock', 100)).toThrow(BudgetExhausted)
  expect(second.report().requests).toBe(1)
})
it('charges disjoint cumulative usage once and never adds included reasoning twice', () => {
  const { ledger } = fixture()
  ledger.reserve('request', 'root', 'fixture', 'mock', 100); ledger.dispatched('request')
  const usage = { inputTokens: 10, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 4, reasoningTokens: 15 }
  ledger.settle('request', usage); ledger.settle('request', usage)
  expect(ledger.report().actualUsd).toBeCloseTo((10 + 60 + 2 + 5) / 1000000)
  expect(ledger.report().reservedUsd).toBe(0)
  expect(ledger.report().requests).toBe(1)
})
it('retains unknown billed outcomes after reopen and refuses a refund after dispatch', () => {
  const { path, ledger } = fixture()
  ledger.reserve('unknown', 'worker', 'fixture', 'mock', 100); ledger.dispatched('unknown'); ledger.settle('unknown', null)
  const held = ledger.report().reservedUsd
  expect(() => ledger.release('unknown')).toThrow('refund')
  ledger.close(); ledgers.splice(ledgers.indexOf(ledger), 1)
  const recovered = new V06Budget(path, config); ledgers.push(recovered)
  expect(recovered.report()).toMatchObject({ reservedUsd: held, uncertain: 1, costStatus: 'uncertain' })
  recovered.reserve('retry', 'worker', 'fixture', 'mock', 100)
  expect(recovered.report().requests).toBe(2)
})
it('never rounds a fractional micro-dollar limit up into spendable credit', () => {
  const { ledger } = fixture({ ...config, limitUsd: 0.0000009 })
  expect(ledger.report().availableUsd).toBe(0)
  expect(() => ledger.reserve('no-fractional-credit', 'root', 'fixture', 'mock', 1)).toThrow(BudgetExhausted)
})
it('waits for a live request settlement rather than prematurely stopping a concurrent model tree', async () => {
  const { ledger } = fixture({ ...config, limitUsd: 0.0005 }), admissions = new MonetaryAdmissions(ledger), signal = new AbortController().signal
  await admissions.reserve('first', 'root', 'fixture', 'mock', 100, signal); ledger.dispatched('first')
  const waiting = admissions.reserve('second', 'child', 'fixture', 'mock', 100, signal)
  await Promise.resolve(); expect(ledger.report().requests).toBe(1)
  ledger.settle('first', { inputTokens: 10, outputTokens: 1 }); admissions.complete('first')
  await waiting
  expect(ledger.report().requests).toBe(2)
  expect(ledger.report().actualUsd + ledger.report().reservedUsd).toBeLessThanOrEqual(ledger.report().limitUsd)
  ledger.release('second'); admissions.complete('second'); admissions.close()
})
it('does not wait indefinitely on an uncertain billed hold or a canceled waiter', async () => {
  const { ledger } = fixture({ ...config, limitUsd: 0.0005 }), admissions = new MonetaryAdmissions(ledger), controller = new AbortController()
  await admissions.reserve('first', 'root', 'fixture', 'mock', 100, controller.signal); ledger.dispatched('first')
  const cancellation = new AbortController(), waiting = admissions.reserve('canceled', 'child', 'fixture', 'mock', 100, cancellation.signal)
  cancellation.abort(new Error('fixture cancellation'))
  await expect(waiting).rejects.toThrow('fixture cancellation')
  ledger.settle('first', null); admissions.complete('first')
  await expect(admissions.reserve('uncertain-retry', 'child', 'fixture', 'mock', 100, controller.signal)).rejects.toThrow(BudgetExhausted)
  admissions.close()
})
it('refuses changed price identity, unknown routes and an output-bound rewrite', () => {
  const { path, ledger } = fixture()
  expect(() => new V06Budget(path, { ...config, limitUsd: 0.002 })).toThrow('prices differ')
  expect(() => ledger.reserve('wrong-route', 'root', 'other', 'mock', 100)).toThrow('verified')
  expect(() => ledger.reserve('too-long', 'root', 'fixture', 'mock', 101)).toThrow('bounds')
})
