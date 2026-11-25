import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { V05ResearchRecords } from './research-records.ts'
import { V05Predictions } from './predictions.ts'

const engines: ExecutionEngine[] = [], roots: string[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function setup(directory?: string) {
  const root = directory ?? mkdtempSync(join(tmpdir(), 'mars-v05-research-'))
  if (!directory) roots.push(root)
  const engine = new ExecutionEngine({ directory: root, providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  engines.push(engine); await engine.open(); engine.createProject('mars', null)
  const context = engine.issueContext('mars', 'researcher', [])
  let now = 12
  const tick = () => now
  const records = new V05ResearchRecords(engine, context, tick, reference => reference.id === 'future' ? { availableAt: 100 } : reference.id === 'known' ? { availableAt: 10 } : null)
  const predictions = new V05Predictions(engine, context, tick, records, target => target === 'next' ? { availableAt: 48, policyHash: 'frozen-policy' } : null)
  return { engine, root, context, records, predictions, setTick: (value: number) => { now = value } }
}
const claim = { id: 'water-baseline', expectedRevision: 0, kind: 'claim' as const, project: 'PW' as const,
  content: { value: 8, units: 'mg/L' }, reason: 'current measurement', evidence: [{ id: 'known', purpose: 'current-estimate' as const }] }
const model = { id: 'model@1', code: 'return input.x * parameters.factor', parameters: { factor: 2 }, inputSchema: { type: 'object' },
  outputSchema: { type: 'number' }, runtimeVersion: 'mars-model-v1', basedOn: [{ id: 'water-baseline', revision: 1 }] }

it('preserves exact immutable history and retry receipts across reopen, rejecting stale writes', async () => {
  const { engine, root, records, setTick } = await setup()
  const first = records.put('first', claim)
  setTick(24)
  const second = records.put('second', { ...claim, expectedRevision: 1, content: { value: 7, units: 'mg/L' }, reason: 'method correction' })
  expect(records.put('first', claim)).toEqual(first)
  expect(() => records.put('first', { ...claim, content: { value: 0 } })).toThrow('different input')
  expect(() => records.put('stale', claim)).toThrow('revision')
  expect(records.read(first.id, 1)).toEqual(first)
  expect(records.history(first.id)).toEqual([first, second])
  expect(records.search('correction', 'PW')).toEqual([second])
  await engine.close()
  const restored = await setup(root)
  expect(restored.records.history(first.id)).toEqual([first, second])
  expect(restored.records.put('first', claim)).toEqual(first)
})

it('checks actual evidence visibility, dependency versions and immutable identity before committing', async () => {
  const { records, engine, context } = await setup()
  expect(() => records.put('future', { ...claim, evidence: [{ id: 'future', purpose: 'validation' }] })).toThrow('unavailable')
  expect(() => records.put('unknown', { ...claim, evidence: [{ id: 'unknown', purpose: 'validation' }] })).toThrow('unavailable')
  expect(() => records.put('dependency', { ...claim, basedOn: [{ id: 'missing', revision: 1 }] })).toThrow('unavailable')
  expect(records.list()).toEqual([])
  records.put('valid', claim)
  expect(() => records.put('identity', { ...claim, expectedRevision: 1, project: 'PG' })).toThrow('immutable')
  engine.revokeContext(context)
  expect(() => records.list()).toThrow()
})

it('freezes code parameters and exact dependency revisions, rejecting retrospective predictions', async () => {
  const { records, predictions, setTick } = await setup()
  records.put('baseline', claim)
  const registered = predictions.registerModel('model', model)
  expect(predictions.registerModel('model', model)).toEqual(registered)
  expect(() => predictions.registerModel('overwrite', { ...model, parameters: { factor: 9 } })).toThrow('immutable')
  const input = { id: 'prediction@1', target: 'next', modelId: registered.id, inputDomain: { x: [1, 2] } }
  const committed = predictions.commit('forecast', input)
  expect(committed.modelHash).toBe(registered.hash)
  expect(committed.lockedTick).toBe(12)
  expect(committed.commitmentHash).toHaveLength(64)
  setTick(48)
  expect(predictions.commit('forecast', input)).toEqual(committed)
  expect(() => predictions.commit('late', { ...input, id: 'late' })).toThrow('already visible')
  expect(() => predictions.commit('missing', { ...input, id: 'missing', target: 'unknown' })).toThrow('unavailable')
  expect(predictions.predictions()).toEqual([committed])
})

it('fails closed without host evidence and validation resolvers', async () => {
  const { engine, context } = await setup()
  const records = new V05ResearchRecords(engine, context, () => 12)
  expect(() => records.put('no-resolver', claim)).toThrow('unavailable')
  records.put('no-evidence', { ...claim, evidence: [] })
  const predictions = new V05Predictions(engine, context, () => 12, records)
  predictions.registerModel('model', model)
  expect(() => predictions.commit('forecast', { id: 'p', target: 'next', modelId: model.id, inputDomain: {} })).toThrow('unavailable')
})
