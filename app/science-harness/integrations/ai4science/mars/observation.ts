/** Measurement values and raw instrument data derived from hidden truth (spec v0.2 sections 2.5, 3.1, 3.2). */
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { normal, unit, type Truth } from './truth.ts'
import { pathogenStage, type BaseState } from './base.ts'

const pdf = (x: number, mean: number, sd: number) => Math.exp(-0.5 * ((x - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI))
const round = (value: number, digits = 4) => Number(value.toFixed(digits))

/** Six hundred point chromatogram; DOC = DOC peak area / internal-standard area × 10. */
export function chromatogram(id: string, docEffective: number, lubricant: number, calibrationAge: number) {
  const beta0 = 0.01 + 0.00005 * calibrationAge, beta1 = 0.002
  const points: number[] = []
  for (let index = 0; index < 600; index++) {
    const t = index * 0.02
    points.push(round(0.1 * docEffective * pdf(t, 5.1, 0.12) + 0.1 * lubricant * pdf(t, 5.4, 0.15) + pdf(t, 7.8, 0.2) + beta0 + beta1 * t + 0.01 * normal(id, 'chromatogram', index)))
  }
  const summary = points.reduce((sum, value, index) => index * 0.02 >= 4.8 && index * 0.02 <= 5.6 ? sum + value * 0.02 : sum, 0) / 0.1
  return { points, summary: round(summary, 3) }
}

/** Hyperspectral cube: 8 bands, square image; lesions raise band 6 relative to band 4. */
export function hyperspectral(id: string, growth: number, lesion: { fraction: number; ratio: number } | null, size: number) {
  const soil = [0.18, 0.2, 0.22, 0.24, 0.26, 0.28, 0.3, 0.31]
  const leaf = [0.04, 0.07, 0.05, 0.09 - 0.03 * growth, 0.25, 0.35, 0.3 + 0.2 * growth, 0.42]
  const data: number[][][] = []
  for (let band = 0; band < 8; band++) {
    const rows: number[][] = []
    for (let y = 0; y < size; y++) {
      const row: number[] = []
      for (let x = 0; x < size; x++) {
        const inside = Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2) <= size * 0.4
        const spotted = inside && lesion !== null && unit(id, 'lesion', x, y) < lesion.fraction
        const base = inside ? leaf[band]! * (spotted && band === 5 ? lesion!.ratio : 1) : soil[band]!
        row.push(round(base + 0.008 * normal(id, 'pixel', band, x, y), 3))
      }
      rows.push(row)
    }
    data.push(rows)
  }
  return { kind: 'hyperspectral', bands: 8, height: size, width: size, bandNames: ['b1', 'b2', 'b3', 'b4-red', 'b5', 'b6', 'b7-nir', 'b8'], data }
}

export interface MeasurementInput {
  resultId: string; methodId: string; methodVersion: number; sampleId: string; batchIds: string[]
  calibrationAge: number | null; tick: number
}

/** Compute the value and raw data a successful method produced; intermediate stages have no measured value. */
export function measure(truth: Truth, base: BaseState, input: MeasurementInput): { measurement: Json; raw: Json | null } {
  const record = base.samples[input.sampleId]
  const id = `${truth.seed}:${input.resultId}`
  const flags: string[] = []
  if (!record) return { measurement: { channel: 'none', note: 'No traceable source for this sample' }, raw: null }
  if (input.methodId === 'screen' && record.kind === 'water') {
    const positive = record.doc * record.decay > 2.5
    const flip = unit(id, 'screen') < 0.1
    return { measurement: { channel: 'presence', unit: 'boolean', value: flip ? !positive : positive, threshold: 2.5, note: 'Screening has ~10% false positive and false negative rates' }, raw: null }
  }
  if (input.methodId === 'confirm' && record.kind === 'water') {
    const age = input.calibrationAge ?? 400
    if (input.calibrationAge === null || age > 400) flags.push('calibration-expired')
    const effective = record.doc * record.decay * (input.methodVersion === 1 ? truth.bias.confirmV1 : 1) *
      (input.batchIds.includes(truth.lots.A2) ? truth.bias.extractionA2 : 1) * (1 + 0.0004 * age)
    const curve = chromatogram(id, effective, record.lubricant, age)
    return { measurement: { channel: 'doc', unit: 'mg/L', instrumentSummary: curve.summary, summaryMethod: 'SOP-CONF v1 window 4.8-5.6 min',
      internalStandard: { retentionTime: 7.8, area: 1.0 }, calibrationAgeTicks: age, methodVersion: input.methodVersion, flags,
      rawArtifact: 'raw.json (600-point chromatogram, dt 0.02 min); analyse with analysis_run' }, raw: { kind: 'chromatogram', dtMinutes: 0.02, points: curve.points } }
  }
  if (input.methodId === 'confirm' && record.kind === 'crop') {
    const stage = pathogenStage(record.infectedSince, record.sampledTick)
    const infected = stage === 'latent' || stage === 'symptomatic'
    const detected = infected ? unit(id, 'sensitivity') < 0.95 : unit(id, 'specificity') < 0.02
    const load = detected ? (stage === 'symptomatic' ? 200 : 40) * Math.exp(0.3 * normal(id, 'load')) : 3 * Math.abs(normal(id, 'load'))
    return { measurement: { channel: 'pathogen', unit: 'copies/uL', value: round(load, 2), positive: load > 20, note: 'Sensitivity 95%, specificity 98%' }, raw: null }
  }
  if (input.methodId === 'image' && record.kind === 'crop') {
    const stage = pathogenStage(record.infectedSince, record.sampledTick)
    const lesion = stage === 'latent' || stage === 'symptomatic' ? { fraction: 0.03 + 0.05 * unit(id, 'fraction'), ratio: stage === 'latent' ? 1.15 + 0.1 * unit(id, 'ratio') : 1.4 } : null
    const growth = record.growth * (1 + 0.05 * normal(id, 'growth'))
    return { measurement: { channel: 'growth', unit: 'index', growthIndex: round(growth), cropId: record.cropId, sampledTick: record.sampledTick,
      rawArtifact: 'raw.json (8 x 32 x 32 hyperspectral cube); analyse with analysis_run' }, raw: hyperspectral(id, record.growth, lesion, 32) }
  }
  return { measurement: { channel: 'none', note: `${input.methodId} prepares material; no measured value` }, raw: null }
}

/** In-chamber scan: cheap, noisy and biased by light, at 8 x 8 resolution per crop. */
export function scan(truth: Truth, operationId: string, crops: { id: string; growth: number; infectedSince: number | null; lost: boolean }[], light: number, tick: number) {
  const values: Json[] = [], cubes: Record<string, Json> = {}
  for (const crop of crops) {
    if (crop.lost) { values.push({ cropId: crop.id, status: 'lost' }); continue }
    const id = `${truth.seed}:${operationId}:${crop.id}`
    const stage = pathogenStage(crop.infectedSince, tick)
    const lesion = stage === 'latent' || stage === 'symptomatic' ? { fraction: 0.03 + 0.05 * unit(id, 'fraction'), ratio: stage === 'latent' ? 1.15 + 0.1 * unit(id, 'ratio') : 1.4 } : null
    values.push({ cropId: crop.id, growthIndex: round(crop.growth * (1 + 0.15 * normal(id, 'growth')) * (1 + 0.004 * (light - 70))), visibleLesions: stage === 'symptomatic' })
    cubes[crop.id] = hyperspectral(id, crop.growth, lesion, 8)
  }
  return { values, raw: { kind: 'chamber-scan', tick, cubes } as Json }
}
