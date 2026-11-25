/** Deployment compatibility is negotiated by host API; optional commit metadata does not gate startup. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPlatformConfig } from './config.ts'
import { HARNESS_BASELINE, HOST_API_VERSION } from './version.ts'

const roots: string[] = []
const oldBaseline = '1'.repeat(40)

function deployment(metadata: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'ai4s-config-'))
  roots.push(root)
  const path = join(root, 'deployment.json')
  writeFileSync(path, JSON.stringify({
    apiVersion: 1,
    enabled: true,
    directory: './state',
    providerCallTimeoutMs: 1000,
    pollIntervalMs: 10,
    management: { actorId: 'operator', projects: ['project'], allowedProviders: ['compute'] },
    providers: [{ module: './provider.ts', config: { directory: './device', id: 'compute' } }],
    ...metadata,
  }))
  return { root, path }
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each([HARNESS_BASELINE, oldBaseline])(
  'accepts legacy baseline %s and emits one actionable stderr migration notice',
  (baseline) => {
    const { path } = deployment({ baseline })
    const config = readPlatformConfig(path)
    expect(config.hostApi).toBe(HOST_API_VERSION)
    expect(config.baseline).toBe(baseline)
    expect(process.stderr.write).toHaveBeenCalledTimes(1)
    const notice = vi.mocked(process.stderr.write).mock.calls[0]![0]
    expect(notice).toContain(path)
    expect(notice).toContain('legacy baseline-only')
    expect(notice).toContain('add "hostApi": "0.2"')
    expect(notice).toContain('optional "baseline"')
    expect(notice).toMatch(/\n$/)
  },
)

it('accepts hostApi without inventing a deployment baseline and resolves file-relative paths', () => {
  const { root, path } = deployment({ hostApi: '0.2' })
  const config = readPlatformConfig(path)
  expect(config.hostApi).toBe(HOST_API_VERSION)
  expect(config.baseline).toBeUndefined()
  expect(config.apiVersion).toBe(1)
  expect(config.directory).toBe(join(root, 'state'))
  expect(config.providers[0]).toEqual({
    module: join(root, 'provider.ts'),
    config: { directory: join(root, 'device'), id: 'compute' },
  })
  expect(process.stderr.write).not.toHaveBeenCalled()
})

it('retains a different valid commit as optional metadata without a migration notice for explicit hostApi', () => {
  expect(oldBaseline).not.toBe(HARNESS_BASELINE)
  const { path } = deployment({ hostApi: '0.2', baseline: oldBaseline })
  expect(readPlatformConfig(path)).toMatchObject({ hostApi: '0.2', baseline: oldBaseline })
  expect(process.stderr.write).not.toHaveBeenCalled()
})

it('rejects deployment files with neither hostApi nor a legacy baseline', () => {
  const { path } = deployment({})
  expect(() => readPlatformConfig(path)).toThrow(/Declare hostApi.*legacy baseline commit/)
  expect(process.stderr.write).not.toHaveBeenCalled()
})

it.each(['0.1', '0.3', '0.2.0', '', 0.2, null, true, {}, []])(
  'rejects unsupported or malformed hostApi %j even when a legacy baseline is present',
  (hostApi) => {
    const { path } = deployment({ hostApi, baseline: oldBaseline })
    expect(() => readPlatformConfig(path)).toThrow()
    expect(process.stderr.write).not.toHaveBeenCalled()
  },
)

it.each(['', 'fcc0ad4', 'g'.repeat(40), 'A'.repeat(40), '1'.repeat(41), `${oldBaseline}\n`, null, 1, {}, []])(
  'rejects malformed baseline %j even when hostApi is supported',
  (baseline) => {
    const { path } = deployment({ hostApi: '0.2', baseline })
    expect(() => readPlatformConfig(path)).toThrow()
    expect(process.stderr.write).not.toHaveBeenCalled()
  },
)

it('accepts explicit audit retention and rejects invalid archival policy before loading Providers', () => {
  const valid = deployment({ hostApi: '0.2', retentionDays: 0 })
  expect(readPlatformConfig(valid.path).retentionDays).toBe(0)
  for (const retentionDays of [-1, 0.5, 36501, '30', null]) {
    const invalid = deployment({ hostApi: '0.2', retentionDays })
    expect(() => readPlatformConfig(invalid.path)).toThrow()
  }
})

it('accepts optional dashboard verification capacity including zero and rejects invalid capacities', () => {
  const absent = deployment({ hostApi: '0.2' })
  expect(readPlatformConfig(absent.path).artifactVerificationCacheEntries).toBeUndefined()
  for (const artifactVerificationCacheEntries of [0, 1024, 100000]) {
    const valid = deployment({ hostApi: '0.2', artifactVerificationCacheEntries })
    expect(readPlatformConfig(valid.path).artifactVerificationCacheEntries).toBe(artifactVerificationCacheEntries)
  }
  for (const artifactVerificationCacheEntries of [-1, 0.5, 100001, '1024', null, true]) {
    const invalid = deployment({ hostApi: '0.2', artifactVerificationCacheEntries })
    expect(() => readPlatformConfig(invalid.path)).toThrow()
  }
})

it.each([{ apiVersion: 2 }, { enabled: false }, { unexpected: true }])(
  'preserves deployment version, enablement and strict-field checks for %j',
  (invalid) => {
    const { path } = deployment({ hostApi: '0.2', ...invalid })
    expect(() => readPlatformConfig(path)).toThrow()
    expect(process.stderr.write).not.toHaveBeenCalled()
  },
)
