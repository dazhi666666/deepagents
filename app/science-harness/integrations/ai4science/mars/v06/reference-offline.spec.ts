/** Opt-in read-only grading of a retained reference that already reached its published horizon. */
import { expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { reportStopped } from '../report.ts'
it.skipIf(!process.env.MARS_V06_REFERENCE_OFFLINE)('recomputes a completed reference world from its frozen records', async () => {
  const directory = process.env.MARS_V06_REFERENCE_OFFLINE!
  const manifest = z.object({ sourceHash: z.string(), caseManifestHash: z.string(), protocolHash: z.string() })
    .parse(JSON.parse(readFileSync(join(directory, 'manifest.public.json'), 'utf8')))
  const settings = z.object({ scienceProfile: z.object({ condition: z.string() }) })
    .parse(JSON.parse(readFileSync(`${directory}.evaluator/v06-runtime.json`, 'utf8')))
  const score = await reportStopped({ directory, truthFile: `${directory}.evaluator/truth.json` })
  writeFileSync(join(directory, 'feasibility-offline-report.json'), JSON.stringify({ version: 'v0.6-reference-offline', ...manifest,
    condition: settings.scienceProfile.condition, verification: 'Read-only recomputation after published horizon; original model and plan records retained.', score }, null, 2), { mode: 0o600 })
  expect('F' in score && score.F === true, JSON.stringify(score)).toBe(true)
}, 180000)
