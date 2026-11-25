/** Compartment tests use public JSON fixtures and an owned loopback listener, never an external service. */
import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { execute, type AnalysisBindings } from '../analysis.ts'
import { assertIsolatedProgram } from '../program-validation.ts'

function bindings(calls: string[]): AnalysisBindings {
  return { readArtifact: id => { calls.push(`artifact:${id}`); if (id !== 'public') throw new Error('Artifact not available'); return { name: 'public' } },
    readRaw: id => { calls.push(`raw:${id}`); if (id !== 'r-1') throw new Error('Raw data not available'); return { value: 4 } },
    telemetry: () => { calls.push('telemetry'); return { solar: [[0, 2], [1, 3]] } },
    archiveSql: () => { calls.push('archive'); return [{ n: 2 }] } }
}
it('executes asynchronous JSON data reads while keeping every promise resolver in the program realm', async () => {
  const calls: string[] = []
  const result = await execute('const [raw, series] = await Promise.all([readRaw("r-1"), telemetry(["solar"], 0, 1)]); const rows = await archiveSql("SELECT n"); const artifact = await readArtifact("public"); console.log("done"); return { value: raw.value + series.solar[1][1] + rows[0].n, artifact: artifact.name }',
    bindings(calls), 10000, { isolatedRealm: true })
  expect(result).toMatchObject({ status: 'done', output: { value: 9, artifact: 'public' }, logs: ['done'] })
  expect(calls).toEqual(['raw:r-1', 'telemetry', 'archive', 'artifact:public'])
})
it('denies process access, Host function constructors and module-loader syntax', async () => {
  for (const code of ['return process.env', 'return readRaw.constructor("return process")().env', 'return await import /* gap */ ("node:fs")']) {
    const result = await execute(code, bindings([]), 10000, { isolatedRealm: true })
    expect(result.status, code).toBe('error')
  }
  expect(() => assertIsolatedProgram('const text = "import(\\\"node:fs\\\")"; return text', true)).not.toThrow()
  expect(() => assertIsolatedProgram('return import /* comment */ ("node:process")', true)).toThrow('imports')
})
it('does not pass a Host callback through Promise.prototype.then', async () => {
  const code = 'Promise.prototype.then = function(resolve) { return resolve.constructor("return process")().env }; return await readRaw("r-1")'
  const result = await execute(code, bindings([]), 10000, { isolatedRealm: true })
  expect(result.status).toBe('error')
})
it('cannot issue a loopback network request from the analysis program', async () => {
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.end('private fixture') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing loopback listener')
    const result = await execute(`return await fetch("http://127.0.0.1:${address.port}/").then(r => r.text())`, bindings([]), 10000, { isolatedRealm: true })
    expect(result.status).toBe('error'); expect(requests).toBe(0)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
