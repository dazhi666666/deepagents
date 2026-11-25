import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { truthFor } from '../fixture.ts'
import { decayRate, growthRate } from '../truth.ts'
import { createV05Scenario } from './scenario.ts'
import { evaluateV05 } from './evaluator.ts'

it('compiles a complete private 100-point scenario without exposing targets in the public contract', () => {
  const { truth } = truthFor(join(mkdtempSync(join(tmpdir(), 'mars-v05-scenario-')), 'run'))
  const scenario = createV05Scenario(truth)
  const result = evaluateV05(scenario.private.manifest, { facts: [], observations: [], predictions: [] })
  expect(result.maximum).toBeCloseTo(100)
  expect(result.score).toBe(0)
  expect(scenario.public.calibrationStatus).toBe('not_frozen')
  expect(scenario.public.objectives.every(o => !Object.hasOwn(o, 'metric') && !Object.hasOwn(o, 'target'))).toBe(true)
  expect(JSON.stringify(scenario.public)).not.toContain('scenarioHash')
  expect(scenario.public.handover[1]?.basedOn[0]?.id).toBe('handover-water-calibration')
  expect(scenario.public.handover[2]?.basedOn).toEqual([])
  expect(new Set(scenario.private.manifest.objectives.filter(o => o.taskId).map(o => o.taskId)).size).toBe(18)
})

it('derives blind scientific targets from the simulator equations', () => {
  const { truth } = truthFor(join(mkdtempSync(join(tmpdir(), 'mars-v05-equations-')), 'run'), 2)
  const scenario = createV05Scenario(truth)
  const water = scenario.private.manifest.objectives.find(o => o.id === 'PW-02:test:holdout_concentration:declared-conditions')!
  expect(water.metric.kind).toBe('numeric')
  if (water.metric.kind === 'numeric') expect(water.metric.target).toBeCloseTo(truth.water.reservoir * Math.exp(-decayRate(truth, 12) * 144))
  const crop = scenario.private.manifest.objectives.find(o => o.id === 'PG-02:test:holdout_growth_by_variety:variety-1')!
  if (crop.metric.kind === 'numeric') expect(crop.metric.target).toBeCloseTo(growthRate(truth, 'crop-1-1', { light: 83, nutrient: 2, irrigation: 90, co2: 950, temperature: 24 }))
  const temp = scenario.private.manifest.objectives.find(o => o.id === 'PG-02:accuracy:temperature_optimum_by_variety:variety-1')!
  if (temp.metric.kind === 'numeric') expect(temp.metric.target).toBe(truth.crops.varieties[0]!.tempOpt)
  expect(scenario.private.manifest.objectives.some(o => o.id.includes('lag_by_variety'))).toBe(false)
})
