/** Opt-in physical calibration is deliberately separate from the fast keyless regression suite. */
import { expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { boot } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { truthFor } from '../fixture.ts'
import { runReferenceFeasibility } from './feasibility.ts'
import { reportStopped } from '../report.ts'
const enabled = process.env.MARS_V06_REFERENCE === '1'
const wallMs = Number(process.env.MARS_V06_REFERENCE_WALL_MS ?? 1200000)
if (!Number.isSafeInteger(wallMs) || wallMs < 30000 || wallMs > 3600000) throw new Error('Invalid physical-calibration wall-clock budget')
for (const [condition, seed] of [['G0', 1], ['G1', 1], ['G1', 2], ['G2', 1]] as const) {
  const selected = !process.env.MARS_V06_REFERENCE_CONDITION || process.env.MARS_V06_REFERENCE_CONDITION === `${condition}:${seed}`
  it.skipIf(!enabled || !selected)(`completes public joint scientific feasibility ${condition}:${seed}`, async () => {
    let directory = ''
    const probe = await boot('v06-public-feasibility', true, async root => {
      const output = process.env.MARS_V06_REFERENCE_OUTPUT
      if (output) { mkdirSync(output, { recursive: true }); directory = mkdtempSync(join(output, `reference-${condition}-${seed}-`)) }
      else directory = join(root, 'run')
      return { withoutScience: true, configs: { jsonl: { root: join(directory, 'sessions'), compression: 'none' },
        'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }
    })
    try {
      const truthFile = truthFor(directory, seed).path
      const report = await runReferenceFeasibility(probe.ctx, { benchmarkVersion: 'v0.6', implementation: 'scientific_candidate', directory, truthFile,
        stageProfile: { baselineTick: 720, finalTick: 1800, horizon: 2400 }, scienceProfile: { condition }, mode: 'environment', seed, port: 0,
        model: { provider: 'teams-probe', model: 'fixture', maxTokens: 1024 }, pollIntervalMs: 5, providerCallTimeoutMs: 1000, decisionTicks: 12 }, { signal: AbortSignal.timeout(wallMs - 15000), failFast: true })
      expect(probe.model.requests).toHaveLength(0)
      expect(report.policyCompleted, report.failure ?? JSON.stringify(report.score)).toBe(true)
      expect(report.jointFeasibility, JSON.stringify(report.score)).toBe(true)
      const offline = await reportStopped({ directory, truthFile })
      expect(offline).toEqual(report.score)
    } finally { await probe.close() }
  }, wallMs)
}
