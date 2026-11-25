import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, readFileSync } from 'node:fs'
import { boot, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { reportStopped } from '../report.ts'
import { mountMars } from '../runtime.ts'
import { truthFor } from '../fixture.ts'
const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
it('native environment generates inherited research and finalizes the full 100-point evaluator without exposing truth', async () => {
  const probe = await boot('mars-v05-terminal', true, async root => ({ withoutScience: true, configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' }, 'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  const directory = join(probe.root, 'mars'), fixture = truthFor(directory, 41)
  writeFileSync(fixture.path, JSON.stringify({ ...fixture.truth, horizon: 12 }))
  const runtime = await mountMars(probe.ctx, { benchmarkVersion: 'v0.5', directory, mode: 'environment', seed: 41, truthFile: fixture.path,
    port: 0, model: { provider: 'teams-probe', model: 'fixture', maxTokens: 1024 }, pollIntervalMs: 5, providerCallTimeoutMs: 1000 })
  try {
    const inherited = runtime.snapshot().research as { records: unknown[] }
    expect(inherited.records).toHaveLength(3)
    expect(runtime.snapshot().seed).toBe(0)
    while (runtime.world.observe().tick < 12) runtime.world.advance(12)
    const score = await runtime.finalize() as { version: string; maximum: number; components: Record<string, number> }
    expect(score.version).toBe('v0.5'); expect(score.maximum).toBeCloseTo(100)
    expect(score.components.R).toBe(0); expect(score.components.K).toBe(0)
    const saved = JSON.parse(readFileSync(join(directory, 'final-score.json'), 'utf8'))
    expect(saved).not.toHaveProperty('truth'); expect(saved).not.toHaveProperty('manifest'); expect(saved).not.toHaveProperty('taskTruths')
    expect(readFileSync(join(directory, 'report/summary.md'), 'utf8')).toContain('Mars v0.5')
    expect(probe.model.requests).toHaveLength(0)
    await runtime.close()
    const offline = await reportStopped({ directory, truthFile: fixture.path })
    if (!('score' in offline)) throw new Error('Expected the v0.5 report branch')
    expect(offline.score).toMatchObject({ version: 'v0.5', maximum: score.maximum, components: score.components })
    await expect(reportStopped({ benchmarkVersion: 'v0.4', directory, truthFile: fixture.path })).rejects.toThrow('version differs')
  } finally { await runtime.close() }
}, 30000)
