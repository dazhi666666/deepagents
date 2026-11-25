import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { V06Records } from './records.ts'
import { artifactOutputs, numericQuality, validateGroup } from './validation.ts'
import { validatePipeline } from './pipeline.ts'
import type { EvaluationCase } from './cases.ts'
let root: string, engine: ExecutionEngine, records: V06Records
const schema = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mars-v06-validation-'))
  engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  await engine.open(); engine.createProject('mars', null)
  records = new V06Records(engine, engine.issueContext('mars', 'validation-fixture', []), () => 0, { baselineTick: 3, finalTick: 8, horizon: 12 })
})
afterEach(async () => { await engine.close(); rmSync(root, { recursive: true, force: true }) })
const model = (id: string, code: string) => records.registerModel(id, { id, code, parameters: {}, inputSchema: schema,
  outputSchema: { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] }, runtimeVersion: 'mars-analysis-v1' })
const cases = (): EvaluationCase[] => [2, 3].map(x => ({ id: String(x), scoreKey: `test:${x}`, taskId: 'T1', group: 'current_accuracy',
  input: { x }, outputPath: ['y'], metric: { kind: 'numeric', target: x * 2, pass: 0.01, zero: 0.03 } }))
it('keeps the pass plateau, zero boundary and invalid-label failures distinct', async () => {
  expect(numericQuality(0.2, 0.2, 0.6)).toBe(1)
  expect(numericQuality(0.4, 0.2, 0.6)).toBeCloseTo(0.5)
  expect(numericQuality(0.6, 0.2, 0.6)).toBe(0)
  const invalid = cases(); invalid[0]!.metric = { kind: 'numeric', target: NaN, pass: 1, zero: 3 }
  await expect(validateGroup(invalid, async () => [], true)).rejects.toThrow('private')
})
it('does not filter one bad output out of a fixed prediction group', async () => {
  const result = await validateGroup(cases(), async () => [{ y: 4 }, { y: NaN }], true)
  expect(result).toMatchObject({ valid: false, quality: 0, caseCount: 2 })
  expect(result.errors).toHaveLength(2)
})
it('gives equivalent single models and model DAGs the same scientific score', async () => {
  model('double', 'return { y: input.x * 2 }')
  records.registerPipeline('pipe', { pipelineId: 'pipe', nodes: [{ id: 'step', modelId: 'double', bindings: { x: '$case.x' } }],
    outputs: { y: '$node.step.y' }, inputSchema: schema, outputSchema: { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] } })
  const single = await validateGroup(cases(), inputs => artifactOutputs(records, 'model', 'double', inputs), true)
  const dag = await validateGroup(cases(), inputs => artifactOutputs(records, 'pipeline', 'pipe', inputs), true)
  expect(single.quality).toBe(1); expect(dag).toEqual(single)
})
it('resets model globals for every case and rejects process/network/nonfinite output', async () => {
  model('counter', 'globalThis.counter = (globalThis.counter || 0) + 1; return { y: globalThis.counter }')
  expect(await artifactOutputs(records, 'model', 'counter', [{ x: 2 }, { x: 2 }, { x: 3 }])).toEqual([{ y: 1 }, { y: 1 }, { y: 1 }])
  for (const [id, code] of [['process', 'return process.env'], ['network', 'return await fetch("http://127.0.0.1/")'], ['infinity', 'return { y: Infinity }']]) {
    model(id!, code!)
    await expect(artifactOutputs(records, 'model', id!, [{ x: 1 }])).rejects.toThrow()
  }
})
it('does not expose a Host constructor or await model-created promises', async () => {
  model('realm', 'let escaped = false; try { escaped = __model.constructor("return typeof process")() === "object" } catch {} return { y: escaped ? 1 : 0 }')
  expect(await artifactOutputs(records, 'model', 'realm', [{ x: 1 }, { x: 2 }])).toEqual([{ y: 0 }, { y: 0 }])
  model('promise', 'Promise.prototype.then = function(resolve) { const host = resolve.constructor("return globalThis")(); host.counter = (host.counter || 0) + 1; resolve({ y: host.counter }) }; return Promise.resolve({ y: 1 })')
  await expect(artifactOutputs(records, 'model', 'promise', [{ x: 1 }])).rejects.toThrow()
  model('import-comment', 'return import /* gap */ ("node:process")')
  await expect(artifactOutputs(records, 'model', 'import-comment', [{ x: 1 }])).rejects.toThrow()
})
it('rejects cyclic and undeclared binding paths without executing code', () => {
  model('double', 'return { y: input.x * 2 }')
  const pipeline = { pipelineId: 'bad', nodes: [{ id: 'a', modelId: 'double', bindings: { x: '$node.b.y' } },
    { id: 'b', modelId: 'double', bindings: { x: '$node.a.y' } }], outputs: { y: '$node.a.y' }, inputSchema: schema,
    outputSchema: { type: 'object', properties: { y: { type: 'number' } } } }
  expect(() => validatePipeline(pipeline, records.models())).toThrow('cycle')
  pipeline.nodes = [{ id: 'a', modelId: 'double', bindings: { x: '$case.missing' } }]
  expect(() => validatePipeline(pipeline, records.models())).toThrow('Undeclared')
})
