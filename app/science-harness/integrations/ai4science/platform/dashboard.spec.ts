/** Local HTTP access must preserve project/provider permissions and execution lifecycle. */
import { it, expect, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from './execution.ts'
import { startDashboard } from './dashboard.ts'
import { createProvider } from './providers/compute.ts'
import { HARNESS_BASELINE } from './version.ts'
import type { PlatformConfig } from './config.ts'
import { Artifacts } from './artifacts.ts'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, readFileSync: vi.fn(original.readFileSync) }
})

it('serves real state, rejects foreign origins/callers/scopes, and exports only checked artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'science-dashboard-'))
  const engine = new ExecutionEngine({
    directory: join(root, 'execution'),
    providers: [
      createProvider({
        id: 'compute',
        directory: join(root, 'device'),
        resource: 'cpu',
        tickMs: 1,
        chunkSize: 2,
      }),
    ],
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
  })
  await engine.open()
  engine.createProject('visible', 100)
  engine.createProject('hidden', 100)
  const config = {
    apiVersion: 1,
    enabled: true,
    baseline: HARNESS_BASELINE,
    directory: engine.directory,
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
    management: { actorId: 'operator', projects: ['visible', 'new-project'], allowedProviders: ['compute'] },
    providers: [],
  } as PlatformConfig
  const controller = new AbortController()
  const app = await startDashboard(engine, config, { port: 0, refreshMs: 100, signal: controller.signal })
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(app.url + path, { headers: { Authorization: `Bearer ${app.token}`, ...headers } })
  const post = (value: unknown) =>
    fetch(app.url + '/api/action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json', Origin: app.url },
      body: JSON.stringify(value),
    })
  try {
    expect((await fetch(app.url + '/')).status).toBe(200)
    const introduction = await fetch(app.url + '/about')
    expect(introduction.status).toBe(200)
    expect(introduction.headers.get('content-type')).toContain('text/html')
    expect(await introduction.text()).toContain('CONCEPTUAL WALKTHROUGH')
    expect((await fetch(app.url + '/about.css')).headers.get('content-type')).toContain('text/css')
    expect((await fetch(app.url + '/about.js')).headers.get('content-type')).toContain('text/javascript')
    expect((await get('/unknown-asset.js')).status).toBe(404)
    expect((await fetch(app.url + '/api/state')).status).toBe(401)
    expect((await get('/api/state', { Origin: 'https://unrelated.example' })).status).toBe(403)
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        app.url + '/api/state',
        { headers: { Host: 'unrelated.example', Authorization: `Bearer ${app.token}` } },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        },
      )
      request.on('error', reject)
      request.end()
    })
    expect(foreignHost).toBe(403)
    const stateResponse = await get('/api/state')
    const cookie = stateResponse.headers.get('set-cookie')!.split(';')[0]!
    expect(stateResponse.headers.get('set-cookie')).toContain('HttpOnly')
    expect(stateResponse.headers.get('set-cookie')).toContain('SameSite=Strict')
    expect((await fetch(app.url+'/api/action',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({action:'create',project:'new-project',budget:1})})).status).toBe(401)
    expect((await fetch(app.url + '/api/state', { headers: { Cookie: cookie } })).status).toBe(401)
    const state = await stateResponse.json()
    expect(state.projects.map((p: { id: string }) => p.id)).toEqual(['visible'])
    expect(state.providers[0].configuration).toBeUndefined()
    expect((await get('/api/state?project=hidden')).status).toBe(400)
    expect((await post({ action: 'create', project: 'hidden', budget: 100 })).status).toBe(400)
    expect(
      (
        await post({
          action: 'submit',
          project: 'visible',
          providerId: 'unregistered',
          requestKey: 'bad',
          input: {},
        })
      ).status,
    ).toBe(400)
    const op = await (
      await post({
        action: 'submit',
        project: 'visible',
        providerId: 'compute',
        requestKey: 'one',
        input: { text: 'abc', iterations: 4 },
      })
    ).json()
    expect(op.id).toBeTruthy()
    const result = await engine.wait(engine.issueContext('visible', 'test', ['compute']), op.id, {
      timeoutMs: 1000,
    })
    expect(result.state).toBe('succeeded')
    const duplicate = await (
      await post({
        action: 'submit',
        project: 'visible',
        providerId: 'compute',
        requestKey: 'one',
        input: { text: 'abc', iterations: 4 },
      })
    ).json()
    expect(duplicate.id).toBe(op.id)
    const artifact = result.artifacts[0]!
    expect(
      (await (await get('/api/artifact?project=visible&id=' + artifact.id)).json()).artifact.sha256,
    ).toBe(artifact.sha256)
    const download = await fetch(
      app.url + '/api/artifact?project=visible&id=' + artifact.id + '&download=1',
      { headers: { Cookie: cookie } },
    )
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(await download.text()).toContain('sha256-chain')
    writeFileSync(join(engine.directory, artifact.path), 'changed')
    expect((await get('/api/artifact?project=visible&id=' + artifact.id)).status).toBe(400)
    expect((await post({ action: 'create', project: 'new-project', budget: 10 })).status).toBe(200)
  } finally {
    await app.close()
    await engine.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([undefined, 0])('verifies unchanged derived state with cache capacity %s and keeps content/download checks strict', async capacity => {
  const root = mkdtempSync(join(tmpdir(), 'science-dashboard-artifacts-'))
  const engine = new ExecutionEngine({ directory: join(root, 'execution'),
    providers: [createProvider({ id: 'compute', directory: join(root, 'device'), resource: 'cpu', tickMs: 1, chunkSize: 2 })],
    pollIntervalMs: 2, providerCallTimeoutMs: 1000 })
  await engine.open()
  engine.createProject('p', 100)
  const config: PlatformConfig = {
    apiVersion: 1, enabled: true, hostApi: '0.2', directory: engine.directory,
    pollIntervalMs: 2, providerCallTimeoutMs: 1000,
    ...(capacity === undefined ? {} : { artifactVerificationCacheEntries: capacity }),
    management: { actorId: 'operator', projects: ['p'], allowedProviders: ['compute'] }, providers: [],
  }
  const context = engine.issueContext('p', 'writer', ['compute']), artifacts = new Artifacts(engine)
  const operation = await engine.submit(context, { providerId: 'compute', requestKey: 'raw', input: { text: 'raw', iterations: 1 } })
  const completed = await engine.wait(context, operation.id, { timeoutMs: 1000 }), source = completed.artifacts[0]!
  const report = artifacts.publish(context, { content: 'derived report', mediaType: 'text/plain', sources: [source.id] })
  const oversized = { ...report, id: 'oversized', bytes: 16 * 1024 * 1024 + 1 }
  engine.recordFact(context, 'artifact-published', oversized)
  const app = await startDashboard(engine, config, { port: 0, refreshMs: 100, signal: new AbortController().signal })
  const get = (path: string) => fetch(app.url + path, { headers: { Authorization: `Bearer ${app.token}` } })
  const diskReads = () => vi.mocked(readFileSync).mock.calls.filter(([file]) => typeof file === 'number').length
  try {
    vi.mocked(readFileSync).mockClear()
    const firstResponse = await get('/api/state')
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json()
    expect(first.artifacts.map((artifact: { id: string }) => artifact.id)).toContain(report.id)
    expect(first.artifacts.map((artifact: { id: string }) => artifact.id)).not.toContain(oversized.id)
    expect(diskReads()).toBe(2)
    vi.mocked(readFileSync).mockClear()
    const second = await (await get('/api/state')).json()
    expect(second.artifacts).toEqual(first.artifacts)
    expect(diskReads()).toBe(capacity === 0 ? 2 : 0)
    vi.mocked(readFileSync).mockClear()
    const read = await get(`/api/artifact?project=p&id=${report.id}`)
    expect(await read.json()).toMatchObject({ content: 'derived report', encoding: 'utf8' })
    expect(diskReads()).toBe(2)
    vi.mocked(readFileSync).mockClear()
    const cookie = firstResponse.headers.get('set-cookie')!.split(';')[0]!
    const download = await fetch(app.url + `/api/artifact?project=p&id=${report.id}&download=1`, { headers: { Cookie: cookie } })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('derived report')
    expect(diskReads()).toBe(2)
    expect((await get('/api/artifact?project=p&id=' + oversized.id)).status).toBe(400)
    config.management.allowedProviders = []
    const restricted = await (await get('/api/state')).json()
    expect(restricted.artifacts.map((artifact: { id: string }) => artifact.id)).not.toContain(report.id)
    config.management.allowedProviders = ['compute']
    writeFileSync(join(engine.directory, source.path), 'tampered source')
    const damaged = await (await get('/api/state')).json()
    expect(damaged.artifacts.map((artifact: { id: string }) => artifact.id)).not.toContain(report.id)
    expect((await get(`/api/artifact?project=p&id=${report.id}`)).status).toBe(400)
    expect((await fetch(app.url + `/api/artifact?project=p&id=${report.id}&download=1`, { headers: { Cookie: cookie } })).status).toBe(400)
  } finally {
    await app.close()
    await engine.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('an independent driver observes cancellation and keeps progressing after the page server closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'science-dashboard-close-'))
  const provider = createProvider({
    id: 'compute',
    directory: join(root, 'device'),
    resource: 'cpu',
    tickMs: 1,
    chunkSize: 2,
  })
  const engine = new ExecutionEngine({
    directory: join(root, 'execution'),
    providers: [provider],
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
  })
  await engine.open()
  engine.createProject('p', 10000)
  const driver = new ExecutionEngine({
    directory: engine.directory, providers: [provider], pollIntervalMs: 2, providerCallTimeoutMs: 1000,
  })
  await driver.openDriver()
  const config = {
    apiVersion: 1,
    enabled: true,
    baseline: HARNESS_BASELINE,
    directory: engine.directory,
    pollIntervalMs: 2,
    providerCallTimeoutMs: 1000,
    management: { actorId: 'operator', projects: ['p'], allowedProviders: ['compute'] },
    providers: [],
  } as PlatformConfig
  const controller = new AbortController()
  const app = await startDashboard(engine, config, { port: 0, refreshMs: 100, signal: controller.signal })
  const c = engine.issueContext('p', 'operator', ['compute'])
  try {
    const op = await engine.submit(c, {
      providerId: 'compute',
      requestKey: 'cancel',
      input: { text: 'abc', iterations: 1000 },
    })
    await engine.cancel(c, op.id)
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (engine.get(c, op.id).state === 'cancelled') {
          clearInterval(timer)
          clearTimeout(timeout)
          resolve()
        }
      }, 20)
      const timeout = setTimeout(() => {
        clearInterval(timer)
        reject(new Error('Cancellation not observed'))
      }, 2000)
    })
    const remaining = await engine.submit(c, {
      providerId: 'compute',
      requestKey: 'keep',
      input: { text: 'abc', iterations: 20 },
    })
    controller.abort()
    await app.closed
    expect(engine.get(c, remaining.id).cancelRequested).toBe(false)
    expect((await engine.wait(c, remaining.id, { timeoutMs: 2000 })).state).toBe('succeeded')
  } finally {
    await app.close()
    await driver.close()
    await engine.close()
    rmSync(root, { recursive: true, force: true })
  }
})
