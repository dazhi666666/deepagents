import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { truthFor } from '../fixture.ts'
import { runReferenceFeasibility } from './feasibility.ts'

it('keeps the scripted policy behind the public facade', () => {
  const source = readFileSync(fileURLToPath(new URL('./reference.ts', import.meta.url)), 'utf8')
  expect(source).not.toMatch(/\.truth\b|\.observeBase\(|scoring-|loadTruth|MarsWorld/)
})

it('executes 2400 physical ticks, selectively revises dependencies and independently validates actual raw assays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-v05-reference-'))
  try {
    const generated = truthFor(join(root, 'reference'))
    writeFileSync(generated.path, JSON.stringify({ ...generated.truth, horizon: 2400 }))
    const report = await runReferenceFeasibility({ truthFile: generated.path, directory: join(root, 'run') })
    expect(report.tick).toBe(2400)
    expect(report.acceptance).toEqual({ physicalClosure: true, selectiveRevision: true, independentValidation: true, nonnegativeResources: true, fullCoreJointFeasibility: false })
    expect(report.phase, JSON.stringify(report.feasibility.failures.slice(-8))).toBe('done')
    expect(report.assays).toHaveLength(3)
    expect(report.assays.map(assay => assay.methodVersion)).toEqual([1, 2, 2])
    expect(report.records.find(record => record.id === 'water-calibration')?.revision).toBe(2)
    expect(report.records.find(record => record.id === 'plant-water-interpretation')?.basedOn).toEqual([{ id: 'water-calibration', revision: 2 }])
    expect(report.records.find(record => record.id === 'energy-observation')?.revision).toBe(1)
    expect(report.predictions[0]!.lockedTick).toBeLessThan(report.assays[2]!.tick)
    expect(report.score.score, JSON.stringify({ score: report.score, validation: report.validation, assays: report.assays })).toBeGreaterThan(0)
    expect(report.feasibility.successful).toBeGreaterThan(10)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 300000)
