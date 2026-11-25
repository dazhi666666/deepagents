/** Artifact verification reuses only stable byte identities; current access, sources and strict content reads remain authoritative. */
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Artifacts, type ProjectArtifact } from './artifacts.ts'
import { ExecutionEngine } from './execution.ts'
import type { ExecutionProvider, OperationContext } from './sdk.ts'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, readFileSync: vi.fn(original.readFileSync) }
})
const original = await vi.importActual<typeof import('node:fs')>('node:fs')
const reads = vi.mocked(readFileSync)
const roots: string[] = []
const links: string[] = []
const engines: ExecutionEngine[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  reads.mockReset().mockImplementation(original.readFileSync)
  for (const engine of engines.splice(0)) await engine.close()
  for (const link of links.splice(0)) if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'artifact-verification-'))
  roots.push(root)
  return root
}
function fixture(capacity?: number) {
  const root = directory()
  mkdirSync(join(root, 'files'))
  const context: OperationContext = { projectId: 'p', actorId: 'actor', allowedProviders: [] }
  const published: ProjectArtifact[] = []
  const metadata: Pick<ExecutionEngine, 'directory' | 'list' | 'readFacts' | 'recordFact'> = {
    directory: root,
    list(c) {
      if (c !== context) throw new Error('Invalid context')
      return []
    },
    readFacts(c) {
      if (c !== context) throw new Error('Invalid context')
      return published.map(artifact => ({ actorId: artifact.actorId, kind: 'artifact-published', data: { ...artifact } }))
    },
    recordFact() { throw new Error('Fixture metadata is explicit') },
  }
  const add = (id: string, content: string | Buffer, sources: string[] = [], mediaType = 'text/plain') => {
    const artifact: ProjectArtifact = { id, projectId: 'p', actorId: 'actor', path: `files/${id}`,
      sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content), mediaType, sources }
    writeFileSync(join(root, artifact.path), content, { flag: 'wx' })
    published.push(artifact)
    return artifact
  }
  return { root, context, published, metadata, add, artifacts: new Artifacts(metadata, capacity) }
}

it('warmed verification skips all recursive hash reads while strict reads still read every file', () => {
  const f = fixture()
  const source = f.add('source', 'raw'), analysis = f.add('analysis', 'analysis', [source.id])
  const report = f.add('report', 'report', [analysis.id, source.id])
  reads.mockClear()
  expect(f.artifacts.verify(f.context, report.id)).toMatchObject(report)
  expect(reads).toHaveBeenCalledTimes(3)
  reads.mockClear()
  f.artifacts.verify(f.context, report.id)
  expect(reads).not.toHaveBeenCalled()
  expect(f.artifacts.read(f.context, report.id).content).toBe('report')
  expect(reads).toHaveBeenCalledTimes(4)
  reads.mockClear()
  new Artifacts(f.metadata).verify(f.context, report.id)
  expect(reads).toHaveBeenCalledTimes(3)
})

it('rejects same-size tampering with the original mtime restored using the changed ctime', () => {
  const f = fixture(), artifact = f.add('same-size', 'alpha')
  const path = join(f.root, artifact.path), fixedTime = new Date('2026-01-01T00:00:00.000Z')
  utimesSync(path, fixedTime, fixedTime)
  f.artifacts.verify(f.context, artifact.id)
  const before = statSync(path, { bigint: true })
  writeFileSync(path, 'omega')
  utimesSync(path, fixedTime, fixedTime)
  const after = statSync(path, { bigint: true })
  expect(after.size).toBe(before.size)
  expect(after.mtimeNs).toBe(before.mtimeNs)
  expect(after.ctimeNs).not.toBe(before.ctimeNs)
  expect(() => f.artifacts.verify(f.context, artifact.id)).toThrow('integrity')
  expect(() => f.artifacts.read(f.context, artifact.id)).toThrow('integrity')
})

it('re-evaluates recursive bytes, source references, and expected hash/byte metadata on warmed outputs', () => {
  const f = fixture(), source = f.add('source', 'raw')
  const analysis = f.add('analysis', 'analysis', [source.id]), report = f.add('report', 'report', [analysis.id])
  f.artifacts.verify(f.context, report.id)
  writeFileSync(join(f.root, source.path), 'bad')
  expect(() => f.artifacts.verify(f.context, report.id)).toThrow('integrity')
  writeFileSync(join(f.root, source.path), 'raw')
  f.artifacts.verify(f.context, report.id)
  analysis.sources = ['missing']
  expect(() => f.artifacts.verify(f.context, report.id)).toThrow('inaccessible')
  analysis.sources = [source.id]
  f.artifacts.verify(f.context, report.id)
  report.sha256 = '0'.repeat(64)
  expect(() => f.artifacts.verify(f.context, report.id)).toThrow('integrity')
  report.sha256 = createHash('sha256').update('report').digest('hex')
  f.artifacts.verify(f.context, report.id)
  report.bytes++
  expect(() => f.artifacts.verify(f.context, report.id)).toThrow('integrity')
})

it('resolves warmed source real paths again and rejects a directory symlink escaping the store', () => {
  const f = fixture(), source = f.add('source', 'raw'), report = f.add('report', 'report', [source.id])
  const link = join(f.root, 'linked'), outside = directory()
  writeFileSync(join(outside, 'source'), 'raw')
  symlinkSync(join(f.root, 'files'), link, 'junction')
  links.push(link)
  source.path = 'linked/source'
  f.artifacts.verify(f.context, report.id)
  unlinkSync(link)
  symlinkSync(outside, link, 'junction')
  expect(() => f.artifacts.verify(f.context, report.id)).toThrow('escaped')
  expect(() => f.artifacts.read(f.context, report.id)).toThrow('escaped')
})

it('checks cycles before accepting any warmed file identity and accepts shared acyclic sources', () => {
  const f = fixture(), source = f.add('source', 'raw'), report = f.add('report', 'report', [source.id, source.id])
  f.artifacts.verify(f.context, report.id)
  source.sources = [report.id]
  expect(() => f.artifacts.verify(f.context, report.id)).toThrow('cycle')
  expect(() => f.artifacts.read(f.context, report.id)).toThrow('cycle')
})

it('disables reuse at zero and evicts least-recently-used file identities at the configured capacity', () => {
  const disabled = fixture(0), a = disabled.add('a', 'a')
  reads.mockClear()
  disabled.artifacts.verify(disabled.context, a.id)
  disabled.artifacts.verify(disabled.context, a.id)
  expect(reads).toHaveBeenCalledTimes(2)
  const f = fixture(2)
  for (const id of ['a', 'b', 'c']) f.add(id, id)
  f.artifacts.verify(f.context, 'a')
  f.artifacts.verify(f.context, 'b')
  f.artifacts.verify(f.context, 'a')
  f.artifacts.verify(f.context, 'c')
  reads.mockClear()
  f.artifacts.verify(f.context, 'a')
  expect(reads).not.toHaveBeenCalled()
  f.artifacts.verify(f.context, 'b')
  expect(reads).toHaveBeenCalledTimes(1)
})

it.each([-1, 0.5, 100001, NaN, Infinity])('rejects invalid cache capacity %s before file access', capacity => {
  expect(() => fixture(capacity)).toThrow('integer 0..100000')
})

it('rejects a file changed during its read without saving verification under mismatched stats', () => {
  const f = fixture(), artifact = f.add('changing', 'alpha'), path = join(f.root, artifact.path)
  reads.mockImplementationOnce((file, options) => {
    const bytes = original.readFileSync(file, options)
    writeFileSync(path, 'omega')
    return bytes
  })
  expect(() => f.artifacts.verify(f.context, artifact.id)).toThrow('integrity')
  expect(() => f.artifacts.verify(f.context, artifact.id)).toThrow('integrity')
  writeFileSync(path, 'alpha')
  reads.mockClear()
  f.artifacts.verify(f.context, artifact.id)
  expect(reads).toHaveBeenCalledTimes(1)
  reads.mockClear()
  f.artifacts.verify(f.context, artifact.id)
  expect(reads).not.toHaveBeenCalled()
})

it('retains UTF-8 JSON/text and base64 binary content encodings', () => {
  const f = fixture(), text = f.add('text', 'λ text'), json = f.add('json', '{"answer":42}', [], 'application/json')
  const binary = f.add('binary', Buffer.from([0, 255, 128, 1]), [], 'application/octet-stream')
  for (const artifact of [text, json, binary]) f.artifacts.verify(f.context, artifact.id)
  expect(f.artifacts.read(f.context, text.id)).toMatchObject({ content: 'λ text', encoding: 'utf8' })
  expect(f.artifacts.read(f.context, json.id)).toMatchObject({ content: '{"answer":42}', encoding: 'utf8' })
  expect(f.artifacts.read(f.context, binary.id)).toMatchObject({ content: 'AP+AAQ==', encoding: 'base64' })
})

it('never reuses revoked contexts or lost Provider grants, and publish source checks remain strict', async () => {
  const root = directory()
  const unused = async (): Promise<never> => { throw new Error('No device work expected') }
  const provider: ExecutionProvider = {
    describe: () => ({ apiVersion: 1, id: 'fixed', version: '1', configuration: {}, inputSchema: {}, outputSchema: {},
      units: {}, constraints: [], completion: 'Immediate fixed output', cancellation: 'No running work' }),
    prepare: input => ({ input, resources: [], budget: 0 }),
    submit: async operation => {
      const path = join(operation.artifactDirectory, 'source.txt')
      writeFileSync(path, 'raw')
      return { state: 'succeeded', artifacts: [{ path, mediaType: 'text/plain' }] }
    },
    query: unused, cancel: unused,
  }
  const engine = new ExecutionEngine({ directory: root, providers: [provider], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  engines.push(engine)
  await engine.open()
  engine.createProject('p', 10)
  const context = engine.issueContext('p', 'actor', ['fixed']), artifacts = new Artifacts(engine)
  const operation = await engine.submit(context, { providerId: 'fixed', requestKey: 'source', input: {} })
  const source = operation.artifacts[0]!
  const report = artifacts.publish(context, { content: 'report', mediaType: 'text/plain', sources: [source.id] })
  artifacts.verify(context, report.id)
  const restricted = engine.issueContext('p', 'actor', [])
  expect(() => artifacts.verify(restricted, report.id)).toThrow('inaccessible')
  reads.mockClear()
  artifacts.publish(context, { content: 'second report', mediaType: 'text/plain', sources: [report.id] })
  expect(reads.mock.calls.filter(([file]) => typeof file === 'number')).toHaveLength(2)
  writeFileSync(join(root, source.path), 'bad')
  expect(() => artifacts.read(context, report.id)).toThrow('integrity')
  expect(() => artifacts.publish(context, { content: 'bad source', mediaType: 'text/plain', sources: [report.id] })).toThrow('integrity')
  expect(() => engine.exportArtifact(context, source.id, join(root, 'bad-export'))).toThrow('integrity')
  engine.revokeContext(context)
  expect(() => artifacts.verify(context, report.id)).toThrow('expired')
  expect(() => artifacts.read(context, report.id)).toThrow('expired')
})
