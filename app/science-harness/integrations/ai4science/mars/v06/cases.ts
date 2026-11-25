/** Private frozen validation cases derive labels from the same physical functions as Mars. */
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { initialBase, solarOutput, waterQuality } from '../base.ts'
import { growthRate, decayRate, type Truth } from '../truth.ts'
import { measureV06 } from './measurement-quality.ts'
import { contentHash, type StageProfile, type TaskId } from './contracts.ts'
import type { ScienceProfile } from './profile.ts'
import { assertPublicCaseShape } from './public-model-interfaces.ts'

export const CORE_CROPS = ['crop-1-1', 'crop-2-2', 'crop-3-3', 'crop-4-4']
export type CaseGroup = 'current_accuracy' | 'storage_accuracy' | 'holdout_accuracy' | 'energy_forecast' | 'dependent_pipeline' | 'independent_pipeline'
export interface EvaluationCase {
  id: string; scoreKey: string; taskId: TaskId; group: CaseGroup; input: Json; outputPath: string[];
  metric: { kind: 'numeric'; target: number; pass: number; zero: number } | { kind: 'exact'; target: boolean }
}
export interface Commission { id: string; sourceId: string; deadline: number; preserveUntil: number; minimumRemainingUl: number; methods: string[] }
export interface CaseManifest { version: 'v0.6'; cases: EvaluationCase[]; commissions: Commission[]; coreCrops: string[]; hash: string; caseHashes: Record<string, string> }

/** Conditional recurrence mirrors stepBase's solar, priority shedding and battery charge limits. */
export function conditionalEnergy(truth: Truth, input: { startTick: number; initialSoc: number; initialDust: number; weatherFactors: number[]; loads: { id: string; power: number }[]; priority: string[] }) {
  const base = initialBase(truth, input.loads.map(l => l.id)); base.energy.soc = input.initialSoc; base.energy.dust = input.initialDust
  let generation = 0, minimumSoc = input.initialSoc
  for (const [index, factor] of input.weatherFactors.entries()) {
    base.energy.dust *= 1 - truth.energy.dustRate * (factor < 1 ? 5 : 1)
    // solarOutput uses the same daylight and peak function; weather is supplied as a controlled condition.
    const t = input.startTick + index + 1, withoutStorm = { ...truth, storms: [] }
    const solar = solarOutput(withoutStorm, base, t) * factor, supply = solar + Math.min(20, base.energy.soc)
    let demand = input.loads.reduce((n, l) => n + l.power, 0)
    const shed = new Set<string>()
    for (const id of input.priority) { if (demand <= supply) break; const load = input.loads.find(l => l.id === id); if (load && !shed.has(id)) { demand -= load.power; shed.add(id) } }
    for (const load of input.loads) if (demand > supply && !shed.has(load.id)) { demand -= load.power; shed.add(load.id) }
    base.energy.soc = Math.max(0, Math.min(base.energy.capacity, base.energy.soc + Math.max(-20, Math.min(20, solar - demand))))
    generation += solar; minimumSoc = Math.min(minimumSoc, base.energy.soc)
  }
  return { generation, minimumSoc }
}
/** Freeze actual cases once; private salt prevents a small public seed dictionary from inverting case hashes. */
export function createCases(truth: Truth, profile: ScienceProfile, stages: StageProfile, salt: string): CaseManifest {
  if (salt.length < 16) throw new Error('Private validation salt is too short')
  const cases: EvaluationCase[] = []
  const add = (taskId: 'T1' | 'T2' | 'T3' | 'T5', group: CaseGroup, id: string, input: Json, outputPath: string[], target: number | boolean, tolerance = 1) => {
    assertPublicCaseShape(taskId, input)
    const scoreKey = `${taskId}:${group}:${id}:${outputPath.join('.')}`
    cases.push({ id, scoreKey, taskId, group, input, outputPath, metric: typeof target === 'boolean' ? { kind: 'exact', target }
      : { kind: 'numeric', target, pass: tolerance, zero: 3 * tolerance } })
  }
  const concentration = waterQuality(truth, initialBase(truth, []), 0)
  const waterInput = (id: string, source: string, doc: number, temperature: number, elapsed: number, methodVersion: number, residual = 0, lubricant = 0,
    trajectory?: { temperature: number; elapsedTicks: number }[]) => {
    const base = initialBase(truth, []), preContactResidual = profile.residualEnabled ? residual : 0
    const storageTrajectory = trajectory ?? [{ temperature, elapsedTicks: elapsed }]
    base.samples.sample = { kind: 'water', source, doc, decay: Math.exp(-storageTrajectory.reduce((sum, interval) => sum + decayRate(truth, interval.temperature) * interval.elapsedTicks, 0)), lubricant, sampledTick: 0 }
    const observation = measureV06(truth, base, { resultId: `${salt}:${id}`, sampleId: 'sample', methodId: 'confirm', methodVersion,
      batchIds: [truth.lots.B], calibrationAge: 25, tick: elapsed }, profile, profile.residualRetention * preContactResidual)
    // A real blank precedes sample contact. Its zero-concentration contact decays memory by lambda.
    base.samples.blank = { kind: 'water', source: 'control:blank', doc: 0, decay: 1, lubricant: 0, sampledTick: 0 }
    const blank = measureV06(truth, base, { resultId: `${salt}:${id}:blank`, sampleId: 'blank', methodId: 'confirm', methodVersion,
      batchIds: [truth.lots.B], calibrationAge: 13, tick: elapsed }, profile, preContactResidual)
    return { kind: 'water', sourceId: source, temperature, elapsedTicks: elapsed, storageTrajectory, methodVersion, batchIds: [truth.lots.B], calibrationAgeTicks: 25,
      observation, qualityControl: { certifiedMgL: 0, observation: blank, calibrationAgeTicks: 13, relation: 'blank completed before sample contact on the same flow path' }, residualRetention: profile.residualRetention } as Json
  }
  for (let repeat = 0; repeat < profile.caseReplicates; repeat++) for (const source of ['reservoir', 'filter', 'pump'] as const) {
    const currentId = `current-${source}-${repeat}`, doc = concentration[source] * (0.85 + 0.3 * repeat / Math.max(1, profile.caseReplicates - 1))
    add('T1', 'current_accuracy', currentId, waterInput(currentId, source, doc, 4, 0, 2, 0, source === 'pump' && repeat % 2 ? 0.8 : 0), ['concentrationAtSampling'], doc, profile.waterPassMgL)
    for (const temperature of [-10, 4, 12, 22]) {
      const id = `storage-${source}-${temperature}-${repeat}`, elapsed = 80 + 60 * repeat
      const trajectory = repeat % 2 ? [{ temperature: 4, elapsedTicks: elapsed / 2 }, { temperature, elapsedTicks: elapsed / 2 }] : [{ temperature, elapsedTicks: elapsed }]
      const input = waterInput(id, source, doc, temperature, elapsed, repeat % 2 + 1, 0, 0, trajectory)
      add('T1', 'storage_accuracy', id, input, ['concentrationAtSampling'], doc, profile.waterPassMgL)
    }
  }
  for (const cropId of CORE_CROPS) for (const [index, light] of [48, 76, 92].entries()) {
    const input = { kind: 'crop', cropId, light, nutrient: index + 1, irrigation: 55 + index * 25, co2: 650 + index * 200,
      temperature: 21 + index + 0.03 * Math.max(0, light - 70), target: 'steady-state physical growth index under controlled healthy conditions' }
    add('T2', 'holdout_accuracy', `${cropId}-${index}`, input, ['growthIndex'], growthRate(truth, cropId, input), profile.growthPassIndex)
  }
  for (const [taskId, group] of [['T3', 'energy_forecast'], ['T5', 'independent_pipeline']] as const) for (let i = 0; i < profile.caseReplicates; i++) {
    const independent = taskId === 'T5'
    const conditions = { startTick: stages.finalTick + (independent ? 29 + 7 * i : 11 * i), initialSoc: independent ? 450 + 45 * i : 500 + 30 * i,
      initialDust: independent ? 0.7 + 0.08 * i : 0.8 + 0.05 * i,
      weatherFactors: Array.from({ length: truth.solTicks }, (_, t) => independent ? t < 20 ? 0.6 : 0.95 : t < 30 ? 0.7 : 1),
      loads: [{ id: 'critical', power: 12 }, { id: 'optional', power: (independent ? 4 : 6) + i }], priority: ['optional', 'critical'] }
    const expected = conditionalEnergy(truth, conditions)
    for (let variant = 0; variant < (independent ? 2 : 1); variant++) {
      const id = `${group}-${i}-${variant}`, input = { kind: 'energy', ...conditions,
        ...(independent ? { waterContext: waterInput(`unrelated-${i}-${variant}`, 'pump', variant ? 4 : 1.6, 4, 0, variant + 1, variant ? 0.7 : 0) } : {}) }
      add(taskId, group, id, input, ['generation'], expected.generation, Math.max(1, expected.generation * profile.energyPassFraction))
      add(taskId, group, id, input, ['minimumSoc'], expected.minimumSoc, Math.max(5, expected.minimumSoc * profile.energyPassFraction))
    }
  }
  for (let i = 0; i < 8; i++) {
    const doc = [0.8, 1.6, 2, 3.2, 4.2, 5, 4, 4][i]!, dose = i === 4 ? 0 : 75, source = i === 5 ? 'reserve' : 'main', elapsedTicks = i === 6 ? 30 : i === 7 ? 75 : 50
    const id = `water-effect-${i}`, observation = waterInput(id, 'pump', doc, 4, 0, i % 2 + 1, i % 2 ? 0.7 : 0, i === 2 ? 1 : 0)
    add('T5', 'dependent_pipeline', id, { kind: 'water-effect', waterObservation: observation,
      irrigationConditions: { source, doseUl: dose, elapsedTicks }, thresholdMgL: 2.5 }, ['waterStress'], source === 'main' && dose > 0 && doc > 2.5 && elapsedTicks >= 40 && elapsedTicks < 60)
  }
  const commissions: Commission[] = ['reservoir', 'filter', 'pump'].map((sourceId, i) => ({ id: `service-${i + 1}`, sourceId,
    deadline: Math.floor(stages.baselineTick + (stages.finalTick - stages.baselineTick) * (0.45 + i * 0.1)),
    preserveUntil: stages.horizon, minimumRemainingUl: 10, methods: ['screen', 'confirm'] }))
  validateCases(cases)
  const caseHashes = Object.fromEntries(['T1', 'T2', 'T3', 'T5'].map(task => [task, contentHash({ salt, cases: cases.filter(c => c.taskId === task) })]))
  return { version: 'v0.6', cases, commissions, coreCrops: [...CORE_CROPS], caseHashes,
    hash: contentHash({ salt, cases, commissions, coreCrops: CORE_CROPS }) }
}
/** An invalid private label is an evaluator failure, never a model's scientific zero. */
export function validateCases(cases: EvaluationCase[]) {
  const keys = new Set<string>()
  for (const c of cases) {
    if (keys.has(c.scoreKey)) throw new Error('Duplicate scientific scoreKey')
    keys.add(c.scoreKey)
    if (c.metric.kind === 'numeric' && (!Number.isFinite(c.metric.target) || !(c.metric.pass >= 0 && c.metric.zero > c.metric.pass))) throw new Error('Invalid private numeric label/tolerance')
    contentHash(c.input)
  }
}
