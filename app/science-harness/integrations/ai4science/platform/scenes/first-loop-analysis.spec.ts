/** Numerical regressions independent of the retired study runner. */
import { expect, it } from 'vitest'
import { analyzeReadings, type Reading } from './first-loop-analysis.ts'

function readings(conditions: number[], values: number[]): Reading[] {
  return conditions.map((condition, i) => ({ runId: 'run-A', operationId: `op-${i + 1}`, requestedCondition: condition, appliedCondition: condition,
    order: i + 1, timestamp: '2026-09-06T00:00:00.000Z', value: values[i]!, unit: 'simulated output units' }))
}

it('reports sample uncertainty and endpoint differences without a canned conclusion', () => {
  const result = analyzeReadings(readings([-1, -1, 1, 1, 0], [1, 3, 3, 5, 4]), 'condition-summary')
  expect(result.groups[0]).toMatchObject({ condition: -1, n: 2, mean: 2, standardError: 1 })
  expect(result.groups[0]!.standardDeviation).toBeCloseTo(Math.sqrt(2))
  expect(result.groups[1]).toMatchObject({ n: 1, standardDeviation: null, standardError: null })
  expect(result.unadjustedEffect?.estimate).toBe(2)
  expect(result.unadjustedEffect?.standardError).toBeCloseTo(Math.sqrt(2))
  expect(result.regression).toBeNull()
  expect(result).not.toHaveProperty('conclusion')
})

it('separates a condition effect and linear drift and computes residual-based uncertainty', () => {
  const x = [-1, 1, -1, 1, -1, 1], residual = [1, 1, -2, -2, 1, 1]
  const result = analyzeReadings(readings(x, x.map((condition, i) => 10 + 0.4 * condition + 0.2 * (i + 1) + residual[i]!)), 'condition-order-regression')
  expect(result.regression?.status).toBe('estimated')
  expect(result.regression?.intercept).toBeCloseTo(10, 10)
  expect(result.regression?.conditionCoefficient).toBeCloseTo(0.4, 10)
  expect(result.regression?.orderCoefficient).toBeCloseTo(0.2, 10)
  expect(result.regression?.adjustedEffect?.estimate).toBeCloseTo(0.8, 10)
  expect(result.regression?.residualDegreesOfFreedom).toBe(3)
  expect(result.regression?.residualStandardDeviation).toBeCloseTo(2, 10)
  expect(result.regression?.adjustedEffect?.standardError).toBeCloseTo(Math.sqrt(35 / 12), 10)
})

it('does not turn pure drift into a condition effect despite an unadjusted difference', () => {
  const x = [-1, -1, -1, 1, 1, 1]
  const result = analyzeReadings(readings(x, x.map((_, i) => 10 + 0.3 * (i + 1))), 'condition-order-regression')
  expect(result.unadjustedEffect?.estimate).toBeCloseTo(0.9, 10)
  expect(result.regression?.adjustedEffect?.estimate).toBeCloseTo(0, 10)
  expect(result.regression?.orderCoefficient).toBeCloseTo(0.3, 10)
  expect(result.caveats.some(value => value.includes('strongly correlated'))).toBe(true)
})

it('withholds estimates for rank-deficient designs and uncertainty with no residual degrees of freedom', () => {
  const deficient = analyzeReadings(readings([-1, 0, 1], [1, 2, 3]), 'condition-order-regression')
  expect(deficient.regression?.status).toBe('unidentifiable')
  expect(deficient.regression?.adjustedEffect).toBeNull()
  expect(deficient.caveats.some(value => value.includes('Rank-deficient'))).toBe(true)
  const saturated = analyzeReadings(readings([-1, 1, -1], [1, 2, 3]), 'condition-order-regression')
  expect(saturated.regression?.status).toBe('estimated')
  expect(saturated.regression?.adjustedEffect?.standardError).toBeNull()
  expect(saturated.regression?.residualDegreesOfFreedom).toBe(0)
})

it('rejects duplicate observations, invalid readings and mixed units rather than silently filtering', () => {
  const rows = readings([-1, 1], [1, 2])
  expect(() => analyzeReadings([...rows, rows[0]!], 'condition-summary')).toThrow('Duplicate global acquisition order')
  expect(() => analyzeReadings([{ ...rows[0]!, value: NaN }], 'condition-summary')).toThrow('Invalid published')
  expect(() => analyzeReadings([rows[0]!, { ...rows[1]!, unit: 'volts' }], 'condition-summary')).toThrow('Mixed')
  expect(() => analyzeReadings([], 'condition-summary')).toThrow('requires observations')
})
