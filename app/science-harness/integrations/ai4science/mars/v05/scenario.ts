/** Private scenario compiler. Only .public may enter an Agent sandbox or catalog. */
import { createHash } from 'node:crypto'
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { CROP_IDS, decayRate, growthRate, normal, varietyOf, type Truth } from '../truth.ts'
import { initialBase, waterQuality, solarOutput, stormFactor, type BaseState, type CropState } from '../base.ts'
import type { MarsWorld } from '../world.ts'
import { publicMission } from './registry.ts'
import { publicObjectiveContracts } from './objectives.ts'
import { validateEvaluationManifest, type Objective, type EvaluationManifest, type Metric } from './evaluator.ts'

export interface ScenarioProbe { objectiveId: string; input: Json; outputPath: string[]; evaluatedAt: number }
export interface V05Scenario {
  public: { mission: ReturnType<typeof publicMission>; objectives: { objectiveId: string; contractId: string; entity: string; field: string; points: number; units: string; predictionTarget: string | null }[]; handover: ReturnType<typeof createHandover>; calibrationStatus: 'not_frozen' }
  private: { manifest: EvaluationManifest; probes: ScenarioProbe[]; scenarioHash: string; calibrationStatus: 'not_frozen' }
}
export function createHandover(truth: Truth) {
  const conditions = { light: 70, nutrient: 1, irrigation: 75, co2: 800, temperature: 22 }
  return [
    { id: 'handover-water-calibration', project: 'PW', revision: 1, status: 'provisional', kind: 'claim',
      content: { question: '历史方法在当前样品中的适用性需验证', historicalStandard: { sampledAt: -192, methodVersion: 1, knownStandardMgL: 5,
        instrumentEstimate: 5 * truth.bias.confirmV1 * (1 + 0.01 * normal(truth.seed, 'historical-standard')), calibrationAgeTicks: 0 },
      protocol: '按内标处理色谱，区分方法、子批和保存变化。历史对照不是当前验证。', obligations: ['保留至少一个当前母样及方法/子批元数据，直到修订窗口结束。'] }, basedOn: [] },
    { id: 'handover-plant-water-dependency', project: 'PG', revision: 1, status: 'provisional', kind: 'study',
      content: { question: '水质解释改变后，选择性审查依赖的作物研究', historicalConditions: conditions,
        historicalGrowth: Object.fromEntries(CROP_IDS.map(id => [id, growthRate(truth, id, conditions) * (1 + 0.03 * normal(truth.seed, id, 'historical-growth'))])),
        obligations: ['保留实际灌溉和处理记录；水质方法改变时复核解释，不默认全部作物模型失效。'] }, basedOn: [{ id: 'handover-water-calibration', revision: 1 }] },
    { id: 'handover-independent-energy', project: 'PF', revision: 1, status: 'provisional', kind: 'study',
      content: { question: '持续建立能源模型，此研究不依赖水质色谱方法', publicSolarShape: 'max(0,sin(2*pi*(tick%96)/96))',
        obligations: ['水质方法修订时保留独立能源研究及资源承诺；在新遥测反驳时可有证据地修订。'] }, basedOn: [] },
  ]
}
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0

/** Uses actual simulator functions and private realized state, not imagined physical parameters. */
export function createV05Scenario(truth: Truth, world?: MarsWorld, decisionTicks = 12): V05Scenario {
  const base: BaseState = world?.observeBase() ?? initialBase(truth, []), lab = world?.observe()
  const realizedCrops = (world?.observeSystems().crops ?? []) as CropState[]
  const H = truth.horizon, baseline = waterQuality(truth, initialBase(truth, []), 0)
  const incident = truth.contamination[0]
  const dirty = waterQuality(truth, initialBase(truth, []), incident ? incident.onset + 1 : 0)
  const contracts = publicObjectiveContracts().objectives, objectives: Objective[] = [], probes: ScenarioProbe[] = [], publicObjectives: V05Scenario['public']['objectives'] = []
  // Conditional future experiment follows the exact dust/solar/whole-load shedding/battery recurrence in stepBase.
  // Future weather factors are blind-case inputs, not information made visible during the run.
  const energyBase = structuredClone(base), loads = [{ id: 'co2-distribution', power: 1 }, { id: 'water-recovery', power: 1.5 },
    ...(lab?.devices ?? []).filter(d => d.enabled && !d.broken && d.conditions).map(d => ({ id: d.id, power: d.powerDraw }))]
  let energyTotal = 0, minimumSoc = energyBase.energy.soc
  const weatherFactors: number[] = []
  for (let offset = 1; offset <= truth.solTicks; offset++) {
    const t = H + offset, factor = stormFactor(truth, t)
    weatherFactors.push(factor)
    energyBase.energy.dust *= 1 - truth.energy.dustRate * (factor < 1 ? 5 : 1)
    const solar = solarOutput(truth, energyBase, t), supply = solar + Math.min(20, energyBase.energy.soc)
    let demand = loads.reduce((n, load) => n + load.power, 0)
    const shed = new Set<string>()
    for (const id of energyBase.energy.priority) { if (demand <= supply) break; const load = loads.find(l => l.id === id); if (load) { demand -= load.power; shed.add(id) } }
    for (const load of loads) if (demand > supply && !shed.has(load.id)) demand -= load.power
    energyBase.energy.soc = Math.max(0, Math.min(energyBase.energy.capacity, energyBase.energy.soc + Math.max(-20, Math.min(20, solar - demand))))
    energyTotal += solar; minimumSoc = Math.min(minimumSoc, energyBase.energy.soc)
  }
  function value(field: string, entity: string, task: string, branch: string): { target: string | number | boolean | string[]; input: Json } {
    const variety = truth.crops.varieties[(entity.startsWith('variety-') ? Number(entity.slice(8)) : entity.startsWith('crop-') ? varietyOf(entity) : 1) - 1]!
    const cropId = entity.startsWith('crop-') ? entity : `crop-1-${variety.variety}`
    const conditions = { light: branch === 'test' ? 83 : 70, nutrient: branch === 'test' ? 2 : 1, irrigation: branch === 'test' ? 90 : 75, co2: branch === 'test' ? 950 : 800, temperature: branch === 'test' ? 24 : 22 }
    const temperature = branch === 'test' ? 12 : 4, elapsed = branch === 'test' ? 144 : 96, initialConcentration = truth.water.reservoir
    const waterInput = { module: entity, initialConcentration, temperature, elapsedTicks: elapsed, methodVersion: 2, calibrationAgeTicks: 0 }
    if (field === 'filter_efficiency') return { target: truth.water.removal, input: { module: 'filter' } }
    if (field === 'concentration_by_module' || field === 'holdout_concentration' && task === 'PW-01' || field === 'post_response_concentration') return { target: baseline[entity as 'reservoir' | 'filter' | 'pump'] ?? baseline.reservoir, input: { ...waterInput, condition: 'baseline-no-contamination' } }
    if (field.includes('concentration')) return { target: initialConcentration * Math.exp(-decayRate(truth, temperature) * elapsed), input: waterInput }
    if (field === 'decay_rate_by_temperature') return { target: entity === '4C' ? truth.water.k4 : entity === '-10C' ? truth.water.kMinus10 : truth.water.k22, input: { temperature: entity === '4C' ? 4 : entity === '-10C' ? -10 : 22 } }
    if (field === 'transfer_applicable') return { target: true, input: { ...waterInput, historicalFamily: 'same-simulator-sample-family' } }
    if (field === 'domain_supported' || field === 'holdout_supported') {
      const probeTemperature = branch === 'test' ? 28 : 4
      return { target: probeTemperature >= -10 && probeTemperature <= 22, input: { ...waterInput, temperature: probeTemperature, declaredTemperatureDomain: [-10, 22] } }
    }
    if (field === 'method_bias_ratio') return { target: truth.bias.confirmV1, input: { methodVersion: 1, referenceMethodVersion: 2 } }
    if (field === 'batch_bias_ratio') return { target: truth.bias.extractionA2, input: { batch: truth.lots.A2 } }
    if (field === 'affected_result_ids') return { target: (lab?.results ?? []).filter(r => r.methodId === 'confirm' && (r.methodVersion === 1 || r.batchIds.includes(truth.lots.A2))).map(r => r.id), input: { task: 'historical-impact' } }
    if (field === 'source_hypotheses') return { target: incident?.hypotheses ?? [], input: { event: 'primary-water-incident' } }
    if (field === 'pump_increment') return { target: dirty.pump - baseline.pump, input: { event: 'primary-water-incident' } }
    if (field === 'lubricant_present') return { target: (dirty.lubricant.pump ?? 0) > 0, input: { module: 'pump' } }
    if (field === 'faulty_sensor') return { target: incident?.decoyModule ?? 'none', input: { event: 'primary-water-incident' } }
    if (field === 'scanner_bias_by_chamber') return { target: 1 + 0.004 * (conditions.light - 70), input: { light: conditions.light, chamber: entity } }
    if (field.includes('growth')) return { target: growthRate(truth, cropId, conditions), input: { cropId, variety: variety.variety, ...conditions, stressFree: true } }
    if (field === 'light_optimum_by_variety') return { target: variety.lightOpt, input: { variety: variety.variety } }
    if (field === 'response_width_by_variety') return { target: variety.lightWidth, input: { variety: variety.variety } }
    if (field === 'temperature_optimum_by_variety') return { target: variety.tempOpt, input: { variety: variety.variety } }
    if (field === 'recommendation_utility') return { target: 1, input: { publicGrid: { nutrient: [1, 2, 3], irrigation: [45, 75, 105], co2: [600, 800, 1100] }, objective: 'relative-to-feasible-grid-maximum' } }
    if (field === 'cause_by_crop') {
      const crop = realizedCrops.find(c => c.id === entity)
      return { target: [...(crop?.infectedSince !== null && crop?.infectedSince !== undefined ? ['pathogen'] : []), ...(crop?.contamination.length ? ['water-contamination'] : []), ...(crop && crop.exposureTicks > 0 ? ['environmental-stress'] : [])], input: { cropId: entity, asOfTick: H } }
    }
    if (field.includes('risk_by_crop')) { const crop = realizedCrops.find(c => c.id === entity); return { target: crop?.infectedSince !== null && crop?.infectedSince !== undefined ? 1 : 0, input: { cropId: entity, asOfTick: H, target: 'realized-infection-indicator' } } }
    if (field === 'battery_capacity') return { target: base.energy.capacity, input: { asOfTick: H } }
    if (field === 'dust_decay') return { target: truth.energy.dustRate, input: { unit: 'per-tick' } }
    if (field === 'clean_panel_peak') return { target: truth.energy.peak, input: { dust: 1, daylightSine: 1 } }
    if (field.includes('remaining_uses')) return { target: Math.max(0, (1 - (base.wear[entity] ?? 0)) / Math.max(1e-12, truth.wear[entity]?.perUse ?? 1)), input: { deviceId: entity, asOfTick: H } }
    if (field === 'fault_class_by_device') return { target: (base.wear[entity] ?? 0) >= 1 ? 'hardware-wear' : 'normal', input: { deviceId: entity, target: 'hardware-wear-threshold' } }
    if (field === 'scientifically_usable' || field === 'holdout_usable') return { target: Math.exp(-decayRate(truth, temperature) * elapsed) >= 0.8, input: { ...waterInput, minimumRetentionFraction: 0.8 } }
    if (field === 'next_sol_generation' || field === 'minimum_soc') return { target: field === 'next_sol_generation' ? energyTotal : minimumSoc,
      input: { startTick: H, initialDust: base.energy.dust, initialSoc: base.energy.soc, solTicks: truth.solTicks, weatherFactors, loads, priority: base.energy.priority, target: 'conditional-energy-recurrence-no-new-faults' } }
    const done = (lab?.operations ?? []).filter(o => o.state === 'succeeded' && o.completedTick !== undefined)
    if (field.includes('finish_offset')) return { target: mean(done.map(o => o.completedTick! - o.acceptedTick)), input: { operations: done.map(o => ({ operationId: o.id, acceptedTick: o.acceptedTick, command: JSON.parse(JSON.stringify(o.command)) as Json })), target: 'mean-realized-duration' } }
    if (field.includes('feasible')) return { target: done.length > 0, input: { operationIds: done.map(o => o.id), target: 'actual-completed-chain-exists' } }
    if (field === 'blocking_resources') return { target: [...new Set((lab?.operations ?? []).filter(o => o.state === 'failed').map(o => o.command.deviceId))], input: { target: 'failed-operation-device-set' } }
    throw new Error(`No simulator-backed target adapter: ${task}/${field}`)
  }
  for (const c of contracts) for (const entity of c.scope) {
    const id = `${c.objectiveId}:${entity}`, derived = c.branch === 'joint' ? { target: 1, input: {} } : value(c.field, entity, c.taskId, c.branch)
    const tolerance = c.branch === 'joint' ? 1 : c.candidateTolerance ? c.candidateTolerance.mode === 'absolute' ? c.candidateTolerance.value : Math.max(Math.abs(Number(derived.target)) * c.candidateTolerance.value, c.candidateTolerance.absoluteFloor) : undefined
    const metric: Metric = c.metric === 'numeric' ? { kind: 'numeric', target: derived.target as number, tolerance: tolerance! } : c.metric === 'set' ? { kind: 'set', target: derived.target as string[] } : { kind: 'exact', target: derived.target as string | number | boolean }
    const purpose = c.branch === 'test' ? 'validation' : 'current-estimate'
    const physicalMetadata = c.taskId.startsWith('PW') ? [{ action: 'sample', ...(c.scope.includes('reservoir') ? { sourceId: entity } : {}) }] :
      c.taskId.startsWith('PG') ? [{ action: 'scan' }, { action: 'process', methodId: 'image' }] :
        c.taskId === 'PF-01' ? [{ action: 'panel_clean' }, { action: 'power_priority' }] :
          c.taskId === 'PF-02' ? [{ action: 'device_service' }, { action: 'device_reference' }, { action: 'process' }] : c.taskId === 'PF-03' ? [{ action: 'sample' }, { action: 'transfer' }] : [{}]
    const objective: Objective = { id, duplicateKey: id, component: c.branch === 'joint' ? 'J' : 'R', taskId: c.taskId, points: c.points / c.scope.length, metric,
      deadline: H, evidence: c.branch === 'joint' ? [{ kind: 'host-outcome', count: 1, purpose: 'validation', metadata: { objectiveId: id } }] : [
        { kind: 'analysis', count: 1, purpose: c.branch === 'test' ? 'validation' : 'current-estimate', metadata: { hasDataAccess: true } },
        { kind: 'operation', count: 1, purpose, anyMetadata: physicalMetadata },
      ] }
    if (c.branch !== 'joint') objective.branch = c.branch
    if (c.branch === 'test') { objective.validationAvailableAt = H; objective.predictionTarget = c.predictionTarget!; probes.push({ objectiveId: id, input: derived.input as Json, outputPath: entity === 'declared-conditions' ? [c.field] : [c.field, entity], evaluatedAt: H }) }
    objectives.push(objective); publicObjectives.push({ objectiveId: id, contractId: c.objectiveId, entity, field: c.field, points: objective.points, units: c.units, predictionTarget: c.predictionTarget })
  }
  for (const [id, component, points] of [['K-retain', 'K', 5], ['K-update', 'K', 5], ['K-preserve', 'K', 5], ['O-crops', 'O', 8], ['O-energy', 'O', 3], ['O-water', 'O', 2], ['O-atmosphere', 'O', 2], ['Q-reproduce', 'Q', 3], ['Q-audit', 'Q', 2]] as const) objectives.push({ id, duplicateKey: id, component, points, metric: { kind: 'numeric', target: 1, tolerance: 1 }, deadline: H, evidence: [{ kind: 'host-outcome', count: 1, purpose: 'validation', metadata: { objectiveId: id } }] })
  const manifest: EvaluationManifest = { version: 'v0.5', mode: 'core', horizon: H, objectives }
  validateEvaluationManifest(manifest)
  return { public: { mission: publicMission(H, decisionTicks), objectives: publicObjectives, handover: createHandover(truth), calibrationStatus: 'not_frozen' }, private: { manifest, probes, scenarioHash: createHash('sha256').update(JSON.stringify({ truth, manifest })).digest('hex'), calibrationStatus: 'not_frozen' } }
}
