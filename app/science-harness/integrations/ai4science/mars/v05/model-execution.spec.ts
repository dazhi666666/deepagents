import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { canonicalJson } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { modelInputSchema, type ModelArtifact } from './predictions.ts'
import { runFrozenModel } from './model-execution.ts'

function model(code: string, outputSchema: ModelArtifact['outputSchema'] = {}): ModelArtifact {
  const request = modelInputSchema.parse({ id: 'frozen-model', code, parameters: { scale: 3 }, runtimeVersion: 'mars-model-v1',
    inputSchema: { type: 'object', required: ['x'], properties: { x: { type: 'number' } }, additionalProperties: false }, outputSchema })
  return { ...request, schemaVersion: 1, createdBy: 'fixture', createdTick: 12,
    hash: createHash('sha256').update(canonicalJson(request)).digest('hex') }
}

it('executes the actual immutable model in a restricted subprocess and validates JSON output', async () => {
  const frozen = model('return { prediction: input.x * parameters.scale }', { type: 'object', required: ['prediction'],
    properties: { prediction: { type: 'number' } }, additionalProperties: false })
  const result = await runFrozenModel(frozen, [{ x: 2 }, { x: 4 }])
  expect(result.status, result.error ?? '').toBe('done')
  expect(result.outputs).toEqual([{ prediction: 6 }, { prediction: 12 }])
  expect(result.modelHash).toBe(frozen.hash)
  expect(result.inputHash).toHaveLength(64)
  expect((await runFrozenModel(frozen, [{ x: 2 }, { x: 4 }])).outputs).toEqual(result.outputs)
})

it('rejects tampered immutable code, invalid inputs, output schema and unsupported assertions', async () => {
  const frozen = model('return input.x', { type: 'number' })
  expect((await runFrozenModel({ ...frozen, code: 'return 0' }, [{ x: 2 }])).error).toContain('hash mismatch')
  expect((await runFrozenModel(frozen, [{ x: 'bad' }])).error).toContain('Type mismatch')
  expect((await runFrozenModel(model('return "bad"', { type: 'number' }), [{ x: 2 }])).error).toContain('Type mismatch')
  expect((await runFrozenModel(model('return 1', { anyOf: [{ type: 'number' }] }), [{ x: 2 }])).error).toContain('Unsupported schema')
})

it.each([
  'return process.env',
  'return await fetch("https://example.com")',
  'const fs = await import("node:fs"); return fs.readFileSync("C:/Windows/win.ini", "utf8")',
  'const net = await import("node:net"); return net.connect(80, "example.com")',
  'return ({}).constructor.constructor("return process")().env',
  'const cp = await import("node:child_process"); return cp.spawnSync("node", ["--version"]).stdout.toString()',
  'const worker = await import("node:worker_threads"); return new worker.Worker("", { eval: true })',
])('denies filesystem network process and worker capabilities: %s', async code => {
  const result = await runFrozenModel(model(code), [{ x: 1 }])
  expect(result.status).toBe('error')
  expect(result.outputs).toEqual([])
})

it('terminates synchronous loops and unresolved asynchronous models, enforcing output limits', async () => {
  const loop = await runFrozenModel(model('while (true) {}'), [{ x: 1 }], { timeoutMs: 150 })
  expect(loop.status).toBe('error')
  const pending = await runFrozenModel(model('return await new Promise(() => {})'), [{ x: 1 }], { timeoutMs: 150 })
  expect(pending.status).toBe('error')
  expect((await runFrozenModel(model('return "a".repeat(10000)'), [{ x: 1 }], { maxOutputBytes: 128 })).error).toContain('output limit')
})

it('rejects non-JSON numbers and non-deterministic runtime capabilities', async () => {
  expect((await runFrozenModel(model('return { value: Infinity }'), [{ x: 1 }])).error).toContain('finite JSON')
  expect((await runFrozenModel(model('return Math.random()'), [{ x: 1 }])).status).toBe('error')
  expect((await runFrozenModel(model('return Date.now()'), [{ x: 1 }])).status).toBe('error')
})
