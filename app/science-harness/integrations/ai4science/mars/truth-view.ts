/** Evaluator-side answer keys for the post-game comparison view. Never read while the mission is running. */
import type { BaseState, CropState } from './base.ts'
import { CROP_IDS, growthRate, type ArchiveAnswers, type Truth, varietyOf } from './truth.ts'
import type { TaskId } from './deliverables.ts'

export interface FinalTruthContext { crops: CropState[]; base: BaseState }

/** Reference values keyed by the answer path the frontend renders. */
export function taskTruths(truth: Truth, answers: ArchiveAnswers | null, final?: FinalTruthContext): Partial<Record<TaskId, unknown>> {
  const varieties = truth.crops.varieties
  const growth = (cropId: string, conditions: { nutrient: number; irrigation: number; co2: number; light: number }) =>
    growthRate(truth, cropId, { ...conditions, temperature: varieties[varietyOf(cropId) - 1]!.tempOpt })
  const history = answers ? { Q1: answers.Q1, Q2: answers.Q2, Q3: answers.Q3, Q4: answers.Q4, Q5: answers.Q5, Q6: answers.Q6, Q7: answers.Q7, Q8: answers.Q8 } : null
  const wearRemaining = final ? Object.fromEntries(Object.entries(truth.wear).map(([device, wear]) => [device, Math.max(0, (1 - (final.base.wear[device] ?? 0)) / wear.perUse)])) : null
  const archiveKeys = history ? { A1: { value: history.Q1 }, A2: { value: history.Q2 }, A3: { value: history.Q3 }, A4: history.Q4, A5: history.Q5,
    A6: { value: history.Q6 }, A7: { value: history.Q7 }, A8: { value: history.Q8 } } : {}
  const e3 = truth.contamination.find(value => value.event === 'E3')
  return {
    W1: { reservoir: truth.water.reservoir, filter: truth.water.reservoir * (1 - truth.water.removal), pump: truth.water.reservoir * (1 - truth.water.removal) + truth.water.pumpIncrement, removal: truth.water.removal },
    W2: { k4: truth.water.k4, kMinus10: truth.water.kMinus10, k22: truth.water.k22 },
    W3: { confirmV1Bias: truth.bias.confirmV1, extractionA2Bias: truth.bias.extractionA2, recalledLot: truth.lots.A2, affectedDeliverables: ['W1', 'W2', 'W4'] },
    W4: { hypotheses: e3?.hypotheses ?? [], increaseAtPump: e3?.deltaSeal ?? 0, lubricantPresent: (e3?.deltaSeal ?? 0) * (e3?.lubricantRatio ?? 0) > 0, faultySensor: e3?.decoyModule ?? 'none' },
    G1: Object.fromEntries(CROP_IDS.map(id => [id, growth(id, { light: 70, nutrient: 1, irrigation: 75, co2: 800 })])),
    G2: Object.fromEntries(varieties.map((variety, index) => [`variety-${index + 1}`, { lightOpt: variety.lightOpt, width: variety.lightWidth }])),
    G3: { nutrient: 3, irrigation: varieties[1]!.irrigationOpt, co2: 1500, predictedGrowth: growth('crop-1-2', { light: 70, nutrient: 3, irrigation: varieties[1]!.irrigationOpt, co2: 1500 }) },
    G4: { indexCase: truth.pathogen.index[0], lambda: truth.pathogen.lambda },
    F1: { dustRate: truth.energy.dustRate, batteryCapacity: truth.energy.battery, peakOutput: truth.energy.peak },
    ...(wearRemaining ? { F2: { remainingUses: wearRemaining } } : {}),
    F3: { sensors: truth.drift.map(value => ({ chamber: value.chamber, channel: value.channel, rate: value.rate })) },
    ...archiveKeys,
    ...(final && e3 ? { X1: { cleanAfterTicks: (final.base.history.contaminationClean[e3.event] ?? truth.horizon) - e3.onset } } : {}),
  }
}
