/** Model-facing shapes contain field definitions and invented examples only. */
import { z } from 'zod'

const tick = z.number().int().nonnegative()
const id = z.string().min(1)
const observation = z.object({
  measurement: z.object({ channel: z.string(), unit: z.string(), value: z.number().optional(),
    instrumentSummary: z.number().optional(), calibrationAgeTicks: tick.optional() }).passthrough(),
  raw: z.unknown().describe('null for a fast observation, or a chromatogram object with kind, dtMinutes and points:number[].'),
}).passthrough()
const waterInput = z.object({
  kind: z.literal('water'), sourceId: id, temperature: z.number(), elapsedTicks: tick,
  storageTrajectory: z.array(z.object({ temperature: z.number(), elapsedTicks: tick })),
  methodVersion: z.number().int().min(1), batchIds: z.array(id), calibrationAgeTicks: tick,
  observation, qualityControl: z.object({ certifiedMgL: z.number(), observation, calibrationAgeTicks: tick, relation: z.string() }),
  residualRetention: z.number(),
})
const cropInput = z.object({ kind: z.literal('crop'), cropId: id, light: z.number(), nutrient: z.number(),
  irrigation: z.number(), co2: z.number(), temperature: z.number(), target: z.string() })
const energyInput = z.object({ kind: z.literal('energy'), startTick: tick, initialSoc: z.number(), initialDust: z.number(),
  weatherFactors: z.array(z.number()).min(1), loads: z.array(z.object({ id, power: z.number() })), priority: z.array(id) })
const independentEnergyInput = energyInput.extend({ waterContext: waterInput })
const waterEffectInput = z.object({ kind: z.literal('water-effect'), waterObservation: waterInput,
  irrigationConditions: z.object({ source: z.enum(['main', 'reserve']), doseUl: z.number(), elapsedTicks: tick }), thresholdMgL: z.number() })
const waterOutput = z.object({ concentrationAtSampling: z.number() })
const cropOutput = z.object({ growthIndex: z.number() })
const energyOutput = z.object({ generation: z.number(), minimumSoc: z.number() })
const waterEffectOutput = z.object({ waterStress: z.boolean() })

const shapes = {
  T1: waterInput, T2: cropInput, T3: energyInput, T5: z.discriminatedUnion('kind', [waterEffectInput, independentEnergyInput]),
}

/** Validate builder shape without rewriting a sealed input or changing case hashes. */
export function assertPublicCaseShape(taskId: 'T1' | 'T2' | 'T3' | 'T5', input: unknown) {
  shapes[taskId].parse(input)
}

function schemaPair(input: z.ZodType, output: z.ZodType) {
  return { inputSchema: z.toJSONSchema(input, { io: 'input' }), outputSchema: z.toJSONSchema(output, { io: 'input' }) }
}
const energySemantics = {
  weatherFactors: 'One solar multiplier per forecast tick. Element i applies at startTick + i + 1. The array length is the forecast duration.',
  loads: 'Each load is an object {id,power}. priority is an ordered array of load IDs and sheds the first listed loads first.',
  generation: 'Sum of solar generation over the supplied forecast window.',
  minimumSoc: 'Minimum battery charge over that window, including initialSoc.',
}
const sampleEnergy = { kind: 'energy', startTick: 17, initialSoc: 40, initialDust: 0.9,
  weatherFactors: [0.8, 0.75, 0.7], loads: [{ id: 'fixture-lab', power: 9 }, { id: 'fixture-cooling', power: 4 }],
  priority: ['fixture-lab', 'fixture-cooling'] } as const

/** Public IO contracts for model_test and implementation. T5 exposes its two variants separately. */
export const publicModelInterfaces = {
  T1: { ...schemaPair(waterInput, waterOutput), observation: 'observation.raw is null on the fast path or {kind,dtMinutes,points:number[]} on the precise path. The prior blank is qualityControl.observation.' },
  T2: schemaPair(cropInput, cropOutput),
  T3: { ...schemaPair(energyInput, energyOutput), semantics: energySemantics, exampleInputs: [sampleEnergy,
    { ...sampleEnergy, weatherFactors: [0.4, 0.45, 0.5, 0.55] }] },
  T5: { variants: { 'water-effect': schemaPair(waterEffectInput, waterEffectOutput),
    energy: { ...schemaPair(independentEnergyInput, energyOutput), semantics: { ...energySemantics,
      waterContext: 'An unrelated observation included on this branch. Its content does not change the energy forecast.' } } } },
}
