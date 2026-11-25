/** Reproducible numerical methods for the first-loop scene; interpretation remains caller-owned. */

/** A published observation; simulator parameters never enter analysis. */
export interface Reading {
  runId: string
  operationId: string
  requestedCondition: number
  appliedCondition: number
  order: number
  timestamp: string
  value: number
  unit: string
}

/** The two numerical procedures exposed to the model in this demonstration. */
export type AnalysisMethod = 'condition-summary' | 'condition-order-regression'

const algorithmVersion = 'ai4science-numerics-v1'
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const centeredSum = (a: number[], b: number[]) => {
  const am = mean(a), bm = mean(b)
  return a.reduce((sum, value, i) => sum + (value - am) * (b[i]! - bm), 0)
}

/** Compute descriptive statistics, or OLS with applied condition and global order.
 * @param readings Complete published observations; no rows are silently excluded.
 * @param method Model-selected procedure, retained in the returned record.
 * @returns Numerical estimates and assumptions, without a scientific conclusion.
 */
export function analyzeReadings(readings: Reading[], method: AnalysisMethod) {
  if (!readings.length) throw new Error('Analysis requires observations')
  const orders = new Set<number>()
  for (const row of readings) {
    if (![row.requestedCondition, row.appliedCondition, row.order, row.value].every(Number.isFinite)
      || row.appliedCondition < -1 || row.appliedCondition > 1 || row.requestedCondition < -1 || row.requestedCondition > 1
      || !Number.isInteger(row.order) || row.order < 1 || !row.runId || !row.operationId || !row.unit || !Number.isFinite(Date.parse(row.timestamp))) {
      throw new Error('Invalid published observation')
    }
    if (orders.has(row.order)) throw new Error('Duplicate global acquisition order: repeated observations cannot count as new evidence')
    orders.add(row.order)
  }
  if (new Set(readings.map(row => row.unit)).size !== 1) throw new Error('Mixed observation units')
  const groups = [...new Set(readings.map(row => row.appliedCondition))].sort((a, b) => a - b).map(condition => {
    const rows = readings.filter(row => row.appliedCondition === condition)
    const values = rows.map(row => row.value)
    const sampleVariance = values.length > 1 ? centeredSum(values, values) / (values.length - 1) : null
    return { condition, n: rows.length, mean: mean(values), standardDeviation: sampleVariance === null ? null : Math.sqrt(sampleVariance),
      standardError: sampleVariance === null ? null : Math.sqrt(sampleVariance / rows.length),
      orderMin: Math.min(...rows.map(row => row.order)), orderMax: Math.max(...rows.map(row => row.order)) }
  })
  const plus = groups.find(group => group.condition === 1), minus = groups.find(group => group.condition === -1)
  const unadjustedEffect = plus && minus ? {
    comparison: '+1 versus -1', estimate: plus.mean - minus.mean,
    standardError: plus.standardError === null || minus.standardError === null ? null : Math.hypot(plus.standardError, minus.standardError),
  } : null
  const caveats = [
    'Synthetic instrument observations, not evidence about a physical device.',
    'Standard errors assume independent errors; serial dependence or unmodeled drift can invalidate them.',
    'An insignificant estimate does not establish equivalence; the prespecified minimum effect of interest is 0.2 simulated output units.',
    'Group differences are unadjusted for acquisition order and can confound condition with drift.',
  ]
  const common = { algorithmVersion, method, n: readings.length, unit: readings[0]!.unit, groups, unadjustedEffect, minimumEffectOfInterest: 0.2, caveats }
  if (method === 'condition-summary') return { ...common, regression: null }
  if (method !== 'condition-order-regression') throw new Error('Unknown analysis method')
  const x = readings.map(row => row.appliedCondition), t = readings.map(row => row.order), y = readings.map(row => row.value)
  const xx = centeredSum(x, x), tt = centeredSum(t, t), xt = centeredSum(x, t)
  const xy = centeredSum(x, y), ty = centeredSum(t, y)
  const determinant = xx * tt - xt * xt
  const conditionOrderCorrelation = xx > 0 && tt > 0 ? xt / Math.sqrt(xx * tt) : null
  const specification = { formula: 'value = intercept + conditionCoefficient * appliedCondition + orderCoefficient * order + error', conditionOrderCorrelation }
  if (xx === 0 || tt === 0 || determinant <= 1e-12 * xx * tt) {
    caveats.push('Rank-deficient design: the condition effect cannot be separated from intercept or acquisition order; no regression estimates are reported.')
    return { ...common, regression: { ...specification, status: 'unidentifiable' as const, residualDegreesOfFreedom: null, intercept: null, conditionCoefficient: null, orderCoefficient: null, residualStandardDeviation: null, adjustedEffect: null } }
  }
  if (conditionOrderCorrelation !== null && Math.abs(conditionOrderCorrelation) >= 0.8) caveats.push('Condition and acquisition order are strongly correlated (absolute correlation >= 0.8); separating effects depends heavily on the linear-order assumption.')
  caveats.push('OLS assumes a linear condition response and linear drift with global acquisition order, with independent constant-variance errors. Standard errors are not confidence intervals.')
  const conditionCoefficient = (xy * tt - ty * xt) / determinant
  const orderCoefficient = (ty * xx - xy * xt) / determinant
  const intercept = mean(y) - conditionCoefficient * mean(x) - orderCoefficient * mean(t)
  const residualSumSquares = readings.reduce((sum, row) => sum + (row.value - intercept - conditionCoefficient * row.appliedCondition - orderCoefficient * row.order) ** 2, 0)
  const residualDegreesOfFreedom = readings.length - 3
  const residualVariance = residualDegreesOfFreedom > 0 ? residualSumSquares / residualDegreesOfFreedom : null
  if (residualVariance === null) caveats.push('No residual degrees of freedom: uncertainty is not estimable from these observations.')
  if (!plus || !minus) caveats.push('The +1 versus -1 regression contrast extrapolates beyond one or both observed endpoints.')
  return { ...common, regression: { ...specification, status: 'estimated' as const, residualDegreesOfFreedom, intercept, conditionCoefficient, orderCoefficient,
    residualStandardDeviation: residualVariance === null ? null : Math.sqrt(residualVariance),
    adjustedEffect: { comparison: '+1 versus -1 at the same acquisition order', estimate: 2 * conditionCoefficient,
      standardError: residualVariance === null ? null : 2 * Math.sqrt(residualVariance * tt / determinant) } } }
}
