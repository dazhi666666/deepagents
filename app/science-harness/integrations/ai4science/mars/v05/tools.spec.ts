/** Native bridge tests: real execution journal, captured tool callbacks, no LLM or physical trial run. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { AnalysisRegistry } from '../analysis.ts'
import type { MarsWorld } from '../world.ts'
import { installResearchTools, V05_TOOLS } from './tools.ts'

const engines: ExecutionEngine[] = [], roots: string[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function bridge() {
  const root = mkdtempSync(join(tmpdir(), 'mars-v05-tools-')); roots.push(root)
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  engines.push(engine); await engine.open(); engine.createProject('mars', null)
  const grant = engine.issueContext('mars', 'native-member', [])
  let now = 12
  // Only public world methods are available to the bridge; no truth/evaluator properties exist.
  const world = { horizon: 2400, rules: {}, observe: () => ({ tick: now, devices: [], methods: [], results: [
    { id: 'result-past', completedTick: 6 }, { id: 'result-future', completedTick: 48 },
  ] }), observeSystems: () => ({ robots: [] }) } as unknown as MarsWorld
  const callbacks = new Map<string, (args: Record<string, unknown>, agent: Agent, signal: AbortSignal) => unknown | Promise<unknown>>()
  const agent = { id: 'native-member' } as Agent
  const calls: string[] = []
  installResearchTools({ register: (name, _description, _parameters, callback) => { callbacks.set(name, callback) }, engine, world,
    analysis: new AnalysisRegistry(join(root, 'analysis')), access: (_agent, tool) => { calls.push(tool); return grant }, decisionTicks: 12 })
  const invoke = (name: string, args: Record<string, unknown> = {}) => callbacks.get(name)!(args, agent, new AbortController().signal)
  const write = (name: string, key: string, value: unknown) => invoke(name, { request_key: key, input_json: JSON.stringify(value) })
  return { engine, grant, callbacks, calls, invoke, write, tick: (value: number) => { now = value } }
}
const record = { id: 'water-claim', expectedRevision: 0, kind: 'claim', project: 'PW', content: { value: 7, unit: 'mg/L' }, reason: 'measured' }
const model = { id: 'water-model-v1', code: 'return input.x', parameters: {}, inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-analysis-v1', basedOn: [{ id: 'water-claim', revision: 1 }] }

it('registers native research tools and round-trips exact revisions through the real fact store', async () => {
  const { callbacks, write, invoke, calls, engine, grant } = await bridge()
  expect([...callbacks.keys()].sort()).toEqual([...V05_TOOLS].sort())
  const first = await write('research_write', 'first', record)
  const second = await write('research_write', 'second', { ...record, expectedRevision: 1, content: { value: 8 }, reason: 'revision' })
  expect(await write('research_write', 'first', record)).toEqual(first)
  const read = await invoke('research_read', { id: record.id, revision: 1 }) as { current: unknown; history: unknown[] }
  expect(read).toEqual({ current: first, history: [first, second] })
  expect(engine.readFacts(grant).filter(fact => fact.kind === 'mars-v05-research')).toHaveLength(2)
  expect(calls).toContain('research_write'); expect(calls).toContain('research_read')
  expect(() => write('research_write', 'stale', record)).toThrow('revision')
})

it('derives evidence availability from host results and rejects future or unknown evidence', async () => {
  const { write } = await bridge()
  const evidence = (id: string) => [{ id, purpose: 'current-estimate' }]
  expect(() => write('research_write', 'future', { ...record, evidence: evidence('result-future') })).toThrow('unavailable')
  expect(() => write('research_write', 'missing', { ...record, evidence: evidence('unknown') })).toThrow('unavailable')
  expect(await write('research_write', 'past', { ...record, evidence: evidence('result-past') })).toMatchObject({ revision: 1, createdTick: 12 })
})

it('uses only known host targets and horizon deadlines for immutable prediction commitments', async () => {
  const { write, invoke, tick } = await bridge()
  await write('research_write', 'claim', record)
  const registered = await write('model_register', 'model', model) as { hash: string }
  const prediction = { id: 'forecast-v1', target: 'PW-01:holdout', modelId: model.id, inputDomain: { source: 'pump' } }
  const committed = await write('prediction_commit', 'prediction', prediction)
  expect(committed).toMatchObject({ modelHash: registered.hash, lockedTick: 12, validationAvailableAt: 2400 })
  expect(() => write('prediction_commit', 'unknown', { ...prediction, id: 'unknown', target: 'W1' })).toThrow('unavailable')
  tick(2400)
  expect(await write('prediction_commit', 'prediction', prediction)).toEqual(committed)
  expect(() => write('prediction_commit', 'late', { ...prediction, id: 'late' })).toThrow('already visible')
  const read = await invoke('research_read') as { predictions: unknown[]; models: unknown[] }
  expect(read.predictions).toEqual([committed]); expect(read.models).toHaveLength(1)
})

it('exposes public requirements and weights without legacy or hidden scientific scores', async () => {
  const { invoke, callbacks } = await bridge()
  const catalog = await invoke('research_catalog') as Record<string, unknown>
  expect(catalog).toMatchObject({ version: 'v0.5', calibrationStatus: 'not_frozen', horizon: 2400,
    scoring: { R: 50, K: 15, J: 15, O: 15, Q: 5 } })
  expect((catalog.tasks as unknown[])).toHaveLength(18)
  for (const key of ['score', 'finalScore', 'truth', 'accuracy', 'baselines', 'affectedResults']) expect(catalog).not.toHaveProperty(key)
  expect([...callbacks.keys()]).not.toContain('deliverable_submit')
  expect(() => invoke('research_write', { request_key: 'invalid', input_json: '{' })).toThrow()
})
