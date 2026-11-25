/** The v0.6 development entry advances the real MarsWorld and seals it without any model request. */
import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { boot, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { mountMars } from '../runtime.ts'
import { truthFor } from '../fixture.ts'
import { reportStopped } from '../report.ts'

const probes: Probe[] = [], roots: string[] = []
afterEach(async () => {
  try { for (const probe of probes.splice(0)) await probe.close() }
  finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) }
})
const stageProfile = { baselineTick: 3, finalTick: 8, horizon: 12 }
const settings = { benchmarkVersion: 'v0.6' as const, mode: 'environment' as const, seed: 1, stageProfile,
  decisionTicks: 1, port: 0, model: { provider: 'teams-probe', model: 'fixture', maxTokens: 1024 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 }
async function host(directory: string) {
  const probe = await boot('mars-v06-world', true, async () => ({ withoutScience: true,
    configs: { jsonl: { root: join(directory, 'sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe); return probe
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mars-v06-world-')); roots.push(root)
  const directory = join(root, 'run'), truth = truthFor(directory)
  writeFileSync(truth.path, JSON.stringify({ ...truth.truth, horizon: stageProfile.horizon }))
  return { directory, truthFile: truth.path }
}

it('finishes three stages in one world, retains physical effects and produces only an unranked protocol report', async () => {
  const files = fixture(), probe = await host(files.directory)
  const runtime = await mountMars(probe.ctx, { ...settings, ...files })
  try {
    expect(runtime.snapshot().mission).toMatchObject({ version: 'v0.6', status: 'protocol_only', commissions: expect.any(Array) })
    expect(runtime.snapshot().capabilities.scoring).toBe(false)
    expect(runtime.snapshot().seed).toBe(0)
    const grant = runtime.engine.issueContext('mars', 'physical-fixture', ['facilities'])
    const operation = await runtime.engine.submit(grant, { providerId: 'facilities', requestKey: 'switch-before-lock', input: { action: 'water_route', target: 'reserve' } })
    expect(['accepted', 'running']).toContain(operation.state)
    while (runtime.world.observe().tick < stageProfile.horizon) {
      runtime.world.advance(stageProfile.horizon)
      await runtime.synchronizeProtocol()
    }
    expect(runtime.world.observeBase().water.route).toBe('reserve')
    expect(runtime.engine.get(grant, operation.id).state).toBe('succeeded')
    expect(runtime.v06Protocol!.stages.seals().map(s => [s.stage, s.tick])).toEqual([['baseline', 3], ['final', 8], ['horizon', 12]])
    expect(runtime.v06Protocol!.stages.modelAdmissionClosed()).toBe(true)
    const report = await runtime.finalize()
    expect(report).toMatchObject({ benchmarkVersion: 'v0.6', reachedHorizon: true, formalRankingEligible: false, R: null, O: null, F: null })
    expect(existsSync(join(files.directory, 'final-score.json'))).toBe(false)
    expect(probe.model.requests).toHaveLength(0)
    expect(readFileSync(join(files.directory, 'protocol-report.json'), 'utf8')).not.toContain('truth')
    await runtime.close()
    expect(await reportStopped(files)).toEqual(report)
    await expect(reportStopped({ ...files, benchmarkVersion: 'v0.5' })).rejects.toThrow('version differs')
  } finally { await runtime.close() }
})
it('reopens a boundary without reopening its sealed slots and rejects changed stage settings', async () => {
  const files = fixture(), first = await host(files.directory)
  const original = await mountMars(first.ctx, { ...settings, ...files })
  while (original.world.observe().tick < 3) original.world.advance(12)
  await original.synchronizeProtocol()
  const baselineHash = original.v06Protocol!.stages.seals()[0]!.hash
  await original.close(); await first.close(); probes.splice(probes.indexOf(first), 1)
  const second = await host(files.directory)
  await expect(mountMars(second.ctx, { ...settings, ...files, resume: true, stageProfile: { ...stageProfile, finalTick: 9 } })).rejects.toThrow('profile differs')
  const restored = await mountMars(second.ctx, { ...settings, ...files, resume: true })
  try {
    expect(restored.world.observe().tick).toBe(3)
    expect(restored.v06Protocol!.stages.seals()[0]!.hash).toBe(baselineHash)
    expect(restored.world.stopAtTick).toBe(8)
    await expect(mountMars(second.ctx, { ...settings, ...files, benchmarkVersion: 'v0.5', stageProfile: undefined })).rejects.toThrow('version differs')
  } finally { await restored.close() }
})
it('rejects agent-mode installation before any model is called or a run directory is created', async () => {
  const files = fixture(), probe = await host(files.directory), directory = join(files.directory, 'not-created')
  await expect(mountMars(probe.ctx, { ...settings, ...files, directory, mode: 'multi-agent' })).rejects.toThrow('model admission awaits')
  expect(existsSync(directory)).toBe(false)
  expect(probe.model.requests).toHaveLength(0)
})
it('persists the same default decision interval that the v0.6 public protocol declares', async () => {
  const files = fixture(), probe = await host(files.directory)
  const runtime = await mountMars(probe.ctx, { ...settings, ...files, decisionTicks: undefined })
  try {
    const saved = await runtime.takeCheckpoint()
    expect(runtime.v06Protocol!.config.decisionTicks).toBe(12)
    expect(saved.metadata).toMatchObject({ decisionTicks: 12 })
  } finally { await runtime.close() }
})
