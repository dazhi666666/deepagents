/** Opt-in diagnostic: fitting sees only the exact public scans cited before the final seal. */
import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'
import { loadTruth } from '../truth.ts'
import { scienceProfileSchema } from './profile.ts'
import { compileScenario } from './scenario.ts'
import { createCases } from './cases.ts'
import { validateGroup } from './validation.ts'
import type { PublicScan } from './reference.ts'
type Row = { light: number; nutrient: number; irrigation: number; co2: number; temperature: number; y: number; individual?: string }
type Fit = { coefficients: number[]; response: number[]; tempOpt: number; half: number; error: number }
it.skipIf(!process.env.MARS_V06_FIT_REPLAY)('checks the public crop fit on fixed validation conditions', async () => {
  const root = process.env.MARS_V06_FIT_REPLAY!
  const text = readFileSync(new URL('./reference.ts', import.meta.url), 'utf8')
  const source = ts.createSourceFile('reference.ts', text, ts.ScriptTarget.ESNext, true)
  const pieces = source.statements.filter(node => ts.isFunctionDeclaration(node) && ['solve', 'plantObservations', 'fitPlant', 'plantValue'].includes(node.name?.text ?? '') ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === 'mean')).map(node => node.getText(source)).join('\n')
  const crop = source.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations).find(d => d.name.getText(source) === 'cropProgram')?.initializer
  if (!crop || !ts.isNoSubstitutionTemplateLiteral(crop)) throw new Error('Public reference predictor is unavailable')
  const javascript = ts.transpileModule(pieces, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  // Only trusted policy functions execute; evaluator data enters after fitting.
  const algorithms: { plantObservations(scans: PublicScan[]): Record<string, Row[]>; fitPlant(rows: Row[]): Fit; plantValue(fit: Fit, row: Row): number } =
    new Function('z', `${javascript}; return {plantObservations,fitPlant,plantValue}`)(z)
  const retained = z.object({ policy: z.object({ trace: z.array(z.object({ event: z.string(), refs: z.array(z.string()) })) }) })
    .parse(JSON.parse(readFileSync(join(root, 'feasibility-report.json'), 'utf8')))
  const selected = new Set(retained.policy.trace.find(entry => entry.event === 'actual-crossed-plant-data')?.refs ?? [])
  if (!selected.size) throw new Error('Retained public reference has no prospective plant-training evidence')
  const db = new DatabaseSync(join(root, 'device/laboratory.sqlite'), { readOnly: true })
  const scanSchema = z.object({ tick: z.number(), chamberId: z.string(), conditions: z.object({ light: z.number(), nutrient: z.number(), temperature: z.number(), co2: z.number(), irrigationByCrop: z.record(z.string(), z.number()) }),
    values: z.array(z.object({ cropId: z.string(), growthIndex: z.number().optional() }).passthrough()) })
  const scans: PublicScan[] = []
  try {
    const state = z.object({ state: z.string() }).parse(db.prepare('SELECT state FROM mars_state WHERE id=1').get())
    const operations = z.object({ operations: z.array(z.object({ id: z.string(), state: z.string(), command: z.object({ action: z.string() }).passthrough(), result: z.json() }).passthrough()) }).parse(JSON.parse(state.state)).operations
    for (const operation of operations) if (selected.has(operation.id) && operation.command.action === 'scan' && operation.state === 'succeeded') {
      const scan = scanSchema.parse(operation.result)
      if (scan.tick >= 1800) throw new Error('Prospective plant fit cannot use final-window scans')
      const raw = z.object({ data: z.string() }).parse(db.prepare('SELECT data FROM mars_raw WHERE key=?').get(`scan:${operation.id}`))
      scans.push({ id: operation.id, tick: scan.tick, chamberId: scan.chamberId, conditions: scan.conditions, raw: z.json().parse(JSON.parse(raw.data)),
        values: scan.values.flatMap(value => value.growthIndex === undefined ? [] : [{ cropId: value.cropId, growthIndex: value.growthIndex }]) })
    }
  } finally { db.close() }
  const observations = algorithms.plantObservations(scans)
  const byCrop = Object.fromEntries(['crop-1-1', 'crop-2-2', 'crop-3-3', 'crop-4-4'].map(cropId => {
    const related = Object.entries(observations).filter(([id]) => id.split('-').at(-1) === cropId.split('-').at(-1)).flatMap(([, rows]) => rows)
    const fit = algorithms.fitPlant(related)
    const factors = (observations[cropId] ?? []).map(row => row.y / Math.max(0.01, algorithms.plantValue(fit, row))).sort((a, b) => a - b)
    fit.coefficients[0] = fit.coefficients[0]! + Math.log(Math.max(0.1, factors[Math.floor(factors.length / 2)] ?? 1))
    return [cropId, fit]
  }))
  const predict = new Function('input', 'parameters', crop.text)
  const stages = { baselineTick: 720, finalTick: 1800, horizon: 2400 }, profile = scienceProfileSchema.parse({})
  const compiled = compileScenario(loadTruth(`${root}.evaluator/truth.json`), stages, profile)
  const manifest = createCases(compiled.truth, profile, stages, 'predictive-diagnostic-not-an-instance')
  const result = await validateGroup(manifest.cases.filter(c => c.group === 'holdout_accuracy'), async inputs => inputs.map(input => z.json().parse(predict(input, { byCrop }))), true)
  if (process.env.MARS_V06_FIT_OUTPUT) writeFileSync(process.env.MARS_V06_FIT_OUTPUT, JSON.stringify({ diagnostic: 'public-scan-predictive-fit-only', scanCount: scans.length, result }), { flag: 'wx' })
  expect(scans).toHaveLength(selected.size)
  expect(result.quality, JSON.stringify(result)).toBeGreaterThanOrEqual(profile.minimumScienceQuality)
}, 60000)
