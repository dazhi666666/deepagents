/** Versioned analytical response; the memory state belongs to the physical transaction. */
import { z } from 'zod'
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { normal, type Truth } from '../truth.ts'
import type { BaseState } from '../base.ts'
import { chromatogram, measure, type MeasurementInput } from '../observation.ts'
import type { ScienceProfile } from './profile.ts'

export const qualityStateSchema = z.object({ configHash: z.string(), residual: z.number().nonnegative(),
  contacts: z.record(z.string(), z.object({ used: z.number().nonnegative(), concentration: z.number().nonnegative(), tick: z.number().int().nonnegative() })),
  cleanings: z.array(z.string()), initialResidual: z.number().nonnegative(),
  trajectories: z.record(z.string(), z.array(z.object({ temperature: z.number(), elapsedTicks: z.number().int().nonnegative() }))).default({}), snapshots: z.record(z.string(), z.json()).default({}),
}).strict()
export type QualityState = z.infer<typeof qualityStateSchema>
/** Same detector response for inline and laboratory fast paths; gain and offset require standards. */
export function fastResponse(truth: Truth, concentration: number, key: string, profile: ScienceProfile) {
  const gain = 1 + 0.08 * normal(truth.seed, 'v06-fast-gain'), offset = 0.08 * normal(truth.seed, 'v06-fast-offset')
  return Math.max(0, gain * concentration + offset + profile.fastNoiseFraction * Math.max(1, concentration) * normal(key, 'v06-fast-noise'))
}
/** Sample-contact update uses a single pre-batch state, independent of sample or actor ordering. */
export function contact(state: QualityState, operationId: string, concentrations: number[], tick: number, profile: ScienceProfile): number {
  const old = state.contacts[operationId]
  if (old) return old.used
  if (!concentrations.length || concentrations.some(c => !Number.isFinite(c) || c < 0 || c > profile.maximumConcentration)) throw new Error('Water concentration outside declared analytical range')
  const concentration = concentrations.reduce((a, b) => a + b, 0) / concentrations.length
  const used = profile.residualEnabled ? state.residual : 0
  state.contacts[operationId] = { used, concentration, tick }
  if (profile.residualEnabled) state.residual = profile.residualRetention * used + profile.residualContact * concentration
  return used
}
/** Cleaning does not calibrate; calibration does not clean. Repeated completion receipts are harmless. */
export function clean(state: QualityState, operationId: string, profile: ScienceProfile) {
  if (state.cleanings.includes(operationId)) return
  state.cleanings.push(operationId); state.residual *= profile.cleaningRetention
}
/** Generate raw chromatograms and summaries from one common concentration signal. */
export function measureV06(truth: Truth, base: BaseState, input: MeasurementInput & { noiseKey?: string }, profile: ScienceProfile, residual = 0) {
  const sample = base.samples[input.sampleId]
  if (sample?.kind !== 'water' || !['screen', 'confirm'].includes(input.methodId)) return measure(truth, base, input.noiseKey ? { ...input, resultId: input.noiseKey } : input)
  const concentration = sample.doc * sample.decay, key = `${truth.seed}:${input.noiseKey ?? input.resultId}`
  if (input.methodId === 'screen') return { measurement: { channel: 'doc-fast', unit: 'mg/L',
    value: fastResponse(truth, concentration, key, profile), methodVersion: input.methodVersion,
    calibrationAgeTicks: input.calibrationAge, precision: 'fast', specification: 'Biased quantitative screening; calibrate using certified controls' } as Json, raw: null }
  const age = input.calibrationAge ?? 400
  const effective = (concentration + residual) * (input.methodVersion === 1 ? truth.bias.confirmV1 : 1) *
    (input.batchIds.includes(truth.lots.A2) ? truth.bias.extractionA2 : 1) * (1 + 0.0004 * age)
  const curve = chromatogram(key, effective, sample.lubricant, age)
  return { measurement: { channel: 'doc', unit: 'mg/L', instrumentSummary: curve.summary, precision: 'precise',
    internalStandard: { retentionTime: 7.8, area: 1 }, calibrationAgeTicks: age, methodVersion: input.methodVersion,
    summaryMethod: 'SOP-CONF window 4.8-5.6 min; separate baseline and interfering peaks',
    rawArtifact: 'raw.json (600-point chromatogram)' } as Json,
    raw: { kind: 'chromatogram', dtMinutes: 0.02, points: curve.points } as Json }
}
