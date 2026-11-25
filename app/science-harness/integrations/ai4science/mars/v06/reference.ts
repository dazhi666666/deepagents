/** Public-data-only reference policy. This module is never given a world, truth, private cases or scorer. */
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { z } from 'zod'

export interface PublicAssay {
  id: string; methodVersion: number; completedTick: number; sourceId: string | null; sampleId: string;
  value: number; lubricant: number; calibrationAge: number; trajectory: { temperature: number; elapsedTicks: number }[];
}
export interface PublicScan { id: string; tick: number; chamberId: string; values: { cropId: string; growthIndex: number }[]; raw: Json;
  conditions: { light: number; nutrient: number; temperature: number; co2: number; irrigationByCrop: Record<string, number> } }
export interface ReferenceState {
  tick: number; baselineTick: number; finalTick: number; horizon: number; methodVersion: number;
  chambers: { id: string; temperatureReading: number; light: number; nutrient: number; co2: number }[];
  crops: { id: string; chamberId: string; moistureReading: number | null; removed: boolean; irrigationLast100: number }[];
  robots: { id: string; energy: number; node: string; busy: boolean }[];
  devices: { id: string; kind: string; dirty: boolean; broken: boolean; busy: boolean; calibratedUntil: number | null }[];
  batches: { id: string; kind: string; units: number }[];
  samples: { id: string; location: string; state: string; volumeUl: number; busy: boolean }[];
  inlineDoc: Record<string, number>; waterRoute: string; solar: number; soc: number; tankUl: number;
}
export interface PublicReferencePort {
  state(): ReferenceState
  progress(entry: { tick: number; event: string; refs: string[] }): void
  onTick(callback: (() => Promise<void>) | null): void
  completedScans(planId: string): PublicScan[]
  completedAssays(planId: string): PublicAssay[]
  waitUntil(tick: number): Promise<void>
  command(key: string, provider: string, input: Json): Promise<{ id: string; completedTick: number; result: Json }>
  assay(key: string, input: { sourceId?: string; sampleId?: string; method: 'screen' | 'confirm'; confirmVolumeUl?: number }): Promise<PublicAssay>
  confirmPrepared(key: string, sampleId: string, volumeUl: number): Promise<PublicAssay>
  screenBatch(key: string, sampleIds: string[]): Promise<PublicAssay[]>
  aliquot(key: string, sampleId: string, volumeUl: number): Promise<string>
  store(key: string, sampleId: string, destination: string): Promise<void>
  split(key: string): Promise<{ byStorage: Record<string, string[]> }>
  scan(key: string, chamberId: string): Promise<PublicScan>
  analyze(code: string): Promise<{ id: string; output: Json }>
  catalog(): { handover: { id: string; content: Json }[]; services: { id: string; sourceId: string; deadline: number }[] }
  registerModel(key: string, model: Json): unknown
  commit(key: string, prediction: Json): unknown
  submit(key: string, submission: Json): unknown
  schedule(key: string, plan: Json): { id: string; createdTick: number }
  actionForecast(key: string, forecast: Json): unknown
}

const core = ['crop-1-1', 'crop-2-2', 'crop-3-3', 'crop-4-4']
const median = (values: number[]) => { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.floor(ordered.length / 2)] ?? 0 }
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
const peaks = [[5.1, 0.12], [5.4, 0.15], [7.8, 0.2]]
function spectral(points: number[], dt = 0.02) {
  const n = 5, a = Array.from({ length: n }, () => Array(n + 1).fill(0) as number[])
  for (let i = 0; i < points.length; i++) {
    const t = i * dt, x = peaks.map(([m, s]) => Math.exp(-0.5 * ((t - m!) / s!) ** 2) / (s! * Math.sqrt(2 * Math.PI)))
    x.push(1, t)
    for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) a[r]![c] = a[r]![c]! + x[r]! * x[c]!; a[r]![n] = a[r]![n]! + x[r]! * points[i]! }
  }
  for (let c = 0; c < n; c++) {
    let pivot = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[pivot]![c]!)) pivot = r
    ;[a[c], a[pivot]] = [a[pivot]!, a[c]!]
    const divisor = a[c]![c]!
    for (let k = c; k <= n; k++) a[c]![k] = a[c]![k]! / divisor
    for (let r = 0; r < n; r++) if (r !== c) { const factor = a[r]![c]!; for (let k = c; k <= n; k++) a[r]![k] = a[r]![k]! - factor * a[c]![k]! }
  }
  return a[0]![n]! / 0.1
}
function decayAt(rates: number[], temperature: number) {
  const temps = [-10, 4, 22]
  if (temperature <= -10) return rates[0]!
  if (temperature >= 22) return rates[2]!
  const i = temperature <= 4 ? 0 : 1, fraction = (temperature - temps[i]!) / (temps[i + 1]! - temps[i]!)
  return Math.exp(Math.log(rates[i]!) + fraction * (Math.log(rates[i + 1]!) - Math.log(rates[i]!)))
}
const waterProgram = `
const peaks = ${JSON.stringify(peaks)};
const spectral = ${spectral.toString()};
const decayAt = ${decayAt.toString()};
function water(sample) {
  const gain = sample.methodVersion === 1 ? parameters.method1 : parameters.method2;
  let effective = spectral(sample.observation.raw.points, sample.observation.raw.dtMinutes) / ((1 + 0.0004 * sample.calibrationAgeTicks) * gain);
  if (sample.qualityControl) {
    const qc = sample.qualityControl;
    const blank = spectral(qc.observation.raw.points, qc.observation.raw.dtMinutes) / ((1 + 0.0004 * qc.calibrationAgeTicks) * gain);
    effective -= (sample.residualRetention ?? parameters.retention) * blank;
  }
  const trajectory = sample.storageTrajectory ?? [{ temperature: sample.temperature, elapsedTicks: sample.elapsedTicks }];
  return effective * Math.exp(trajectory.reduce((s, interval) => s + decayAt(parameters.rates, interval.temperature) * interval.elapsedTicks, 0));
}
`
function solve(rows: { x: number[]; y: number }[], count: number) {
  const a = Array.from({ length: count }, () => Array(count + 1).fill(0) as number[])
  for (const { x, y } of rows) for (let r = 0; r < count; r++) { for (let c = 0; c < count; c++) a[r]![c] = a[r]![c]! + x[r]! * x[c]!; a[r]![count] = a[r]![count]! + x[r]! * y }
  for (let c = 0; c < count; c++) {
    a[c]![c] = a[c]![c]! + 0.00001
    let pivot = c
    for (let r = c + 1; r < count; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[pivot]![c]!)) pivot = r
    ;[a[c], a[pivot]] = [a[pivot]!, a[c]!]
    const d = a[c]![c]!
    for (let k = c; k <= count; k++) a[c]![k] = a[c]![k]! / d
    for (let r = 0; r < count; r++) if (r !== c) { const f = a[r]![c]!; for (let k = c; k <= count; k++) a[r]![k] = a[r]![k]! - f * a[c]![k]! }
  }
  return a.map(r => r[count]!)
}
function plantObservations(scans: PublicScan[]) {
  const observations: Record<string, { light: number; nutrient: number; irrigation: number; co2: number; temperature: number; y: number; individual: string }[]> = {}
  const paired: { row: { y: number }; feature: number }[] = []
  for (const scan of scans) {
    const cubes = z.object({ cubes: z.record(z.string(), z.object({ data: z.array(z.array(z.array(z.number()))) })) }).parse(scan.raw).cubes
    for (const value of scan.values) {
      const row = { ...scan.conditions, irrigation: scan.conditions.irrigationByCrop[value.cropId] ?? 0, individual: value.cropId,
        y: value.growthIndex / (1 + 0.004 * (scan.conditions.light - 70)) }
      ;(observations[value.cropId] ??= []).push(row)
      const cube = cubes[value.cropId]
      if (!cube?.data[3]?.length || !cube.data[6]?.length) throw new Error('Public plant scan lacks red/NIR measurements')
      const red = cube.data[3], nir = cube.data[6], split = (Math.min(...red.flat()) + Math.max(...red.flat())) / 2
      const pixels = red.flatMap((line, y) => line.flatMap((v, x) => v < split ? [nir[y]![x]!] : []))
      if (!pixels.length) throw new Error('Public plant scan has no segmented foliage')
      paired.push({ row, feature: mean(pixels) })
    }
  }
  const mx = mean(paired.map(p => p.feature)), my = mean(paired.map(p => p.row.y))
  const variance = paired.reduce((s, p) => s + (p.feature - mx) ** 2, 0)
  if (variance <= 0) throw new Error('Public plant study has no optical response variation')
  const slope = paired.reduce((s, p) => s + (p.feature - mx) * (p.row.y - my), 0) / variance
  for (const p of paired) p.row.y = my + slope * (p.feature - mx)
  return observations
}
function fitPlant(rows: { light: number; nutrient: number; irrigation: number; co2: number; temperature: number; y: number; individual?: string }[]) {
  const individuals = [...new Set(rows.map(r => r.individual))], linearCount = 4 + Math.max(0, individuals.length - 1)
  let best = { error: Infinity, coefficients: [0, 0, -1], response: [0, 0, 0, 0], tempOpt: 22, half: 350 }
  for (const half of [200, 350, 500, 650, 800]) {
    const transformed = rows.filter(r => r.y > 0.02).map(r => {
      const co2 = (r.co2 / (r.co2 + half)) / (800 / (800 + half)), di = (r.irrigation - 75) / 50, n = r.nutrient - 1
      return { x: [1, r.light / 100, (r.light / 100) ** 2, (r.temperature - 22) / 6, ...individuals.slice(1).map(id => Number(r.individual === id))],
        response: [n, di, di * di, n * di], y: Math.log(r.y / co2) + ((r.temperature - 22) / 6) ** 2 }
    })
    let theta = [...solve(transformed, linearCount), 0, 0, 0, 0]
    theta[2] = Math.min(-0.001, theta[2]!); theta[3] = Math.max(-2, Math.min(8 / 3, theta[3]!))
    const evaluate = (parameters: number[]) => mean(transformed.map(r => {
      const response = 1 + r.response.reduce((s, x, i) => s + x * parameters[linearCount + i]!, 0)
      if (response <= 0) return Infinity
      return (r.y - r.x.reduce((s, x, i) => s + x * parameters[i]!, 0) - Math.log(response)) ** 2
    }))
    let error = evaluate(theta)
    for (let iteration = 0; iteration < 80; iteration++) {
      const gradient = transformed.map(r => {
        const response = 1 + r.response.reduce((s, x, i) => s + x * theta[linearCount + i]!, 0)
        return { x: [...r.x, ...r.response.map(x => x / response)], y: r.y - r.x.reduce((s, x, i) => s + x * theta[i]!, 0) - Math.log(response) }
      })
      const delta = solve(gradient, theta.length)
      let improved = false
      for (let scale = 1; scale >= 1 / 1024; scale /= 2) {
        const candidate = theta.map((x, i) => x + scale * delta[i]!)
        candidate[2] = Math.min(-0.001, candidate[2]!); candidate[3] = Math.max(-2, Math.min(8 / 3, candidate[3]!))
        const next = evaluate(candidate)
        if (next < error - 1e-10) { theta = candidate; error = next; improved = true; break }
      }
      if (!improved) break
    }
    if (error < best.error) best = { error, coefficients: [theta[0]! + theta[3]! ** 2 / 4, theta[1]!, theta[2]!],
      response: theta.slice(linearCount), tempOpt: 22 + 3 * theta[3]!, half }
  }
  return best
}
const cropProgram = `const p = parameters.byCrop[input.cropId]; if (!p) throw new Error('Unknown crop'); const di = (input.irrigation - 75) / 50, n = input.nutrient - 1;
const x = [1,input.light/100,(input.light/100)**2], response = [n,di,di*di,n*di];
const lightAndNutrition = Math.exp(x.reduce((s,v,i)=>s+v*p.coefficients[i],0)) * Math.max(0,1+response.reduce((s,v,i)=>s+v*p.response[i],0));
return { growthIndex: lightAndNutrition * Math.exp(-(((input.temperature-p.tempOpt)/6)**2)) * (input.co2/(input.co2+p.half))/(800/(800+p.half)) };`
const energyProgram = `function energy(input) { let dust=input.initialDust,soc=input.initialSoc,generation=0,minimumSoc=soc;
for(let i=0;i<input.weatherFactors.length;i++){ const f=input.weatherFactors[i],t=input.startTick+i+1;dust*=1-parameters.dustRate*(f<1?5:1);
const solar=parameters.peak*dust*Math.max(0,Math.sin(2*Math.PI*(t%96)/96))*f,supply=solar+Math.min(20,soc);let demand=input.loads.reduce((s,l)=>s+l.power,0);const shed=new Set();
for(const id of input.priority){if(demand<=supply)break;const l=input.loads.find(x=>x.id===id);if(l&&!shed.has(id)){demand-=l.power;shed.add(id)}}
for(const l of input.loads)if(demand>supply&&!shed.has(l.id)){demand-=l.power;shed.add(l.id)}
soc=Math.max(0,Math.min(parameters.battery,soc+Math.max(-20,Math.min(20,solar-demand))));generation+=solar;minimumSoc=Math.min(minimumSoc,soc)}return {generation,minimumSoc};}`

function serviceSteps(sourceId: string, robotId: string, at: number): Json[] {
  return [
    { id: 'dock', providerId: 'water', at, input: { action: 'move', robotId, destination: robotId } },
    { id: 'charge', providerId: 'water', dependsOn: ['dock'], input: { action: 'charge', robotId } },
    { id: 'position', providerId: 'water', dependsOn: ['charge'], input: { action: 'move', robotId, destination: sourceId } },
    { id: 'sample', providerId: 'water', dependsOn: ['position'], input: { action: 'sample', sourceId, volumeUl: 150, container: 'vial' } },
    { id: 'to-handler', providerId: 'water', dependsOn: ['sample'], input: { action: 'transfer', deviceId: robotId, sampleId: '$step:sample:outputSampleId', destination: 'liquid-handler' } },
    { id: 'aliquot', providerId: 'water', dependsOn: ['to-handler', 'sample'], input: { action: 'aliquot', deviceId: 'liquid-handler', sampleId: '$step:sample:outputSampleId', volumeUl: 25, container: 'vial' } },
    { id: 'to-screen', providerId: 'water', dependsOn: ['aliquot', 'sample'], input: { action: 'transfer', deviceId: robotId, sampleId: '$step:aliquot:outputSampleId', additionalSampleIds: ['$step:sample:outputSampleId'], destination: 'screen' } },
    { id: 'wash-screen', providerId: 'facilities', dependsOn: ['to-screen'], input: { action: 'clean', deviceId: 'screen' } },
    { id: 'calibrate-screen', providerId: 'facilities', dependsOn: ['wash-screen'], input: { action: 'calibrate', deviceId: 'screen' } },
    { id: 'measure', providerId: 'water', dependsOn: ['calibrate-screen', 'aliquot'], input: { action: 'process', deviceId: 'screen', sampleId: '$step:aliquot:outputSampleId', volumeUl: 25, methodId: 'screen', methodVersion: 1 } },
    { id: 'preserve-mother', providerId: 'water', dependsOn: ['measure', 'sample'], input: { action: 'transfer', deviceId: robotId, sampleId: '$step:sample:outputSampleId', additionalSampleIds: ['$step:measure:outputSampleId'], destination: 'freezer' } },
    { id: 'dock-end', providerId: 'water', dependsOn: ['preserve-mother'], input: { action: 'move', robotId, destination: robotId } },
    { id: 'charge-end', providerId: 'water', dependsOn: ['dock-end'], input: { action: 'charge', robotId } },
  ]
}
function plantValue(p: ReturnType<typeof fitPlant>, row: { light: number; nutrient: number; irrigation: number; co2: number; temperature: number }) {
  const n = row.nutrient - 1, di = (row.irrigation - 75) / 50, x = [1, row.light / 100, (row.light / 100) ** 2], response = [n, di, di * di, n * di]
  return Math.exp(x.reduce((s, value, i) => s + value * p.coefficients[i]!, 0)) * Math.max(0, 1 + response.reduce((s, value, i) => s + value * p.response[i]!, 0)) *
    Math.exp(-(((row.temperature - p.tempOpt) / 6) ** 2)) * (row.co2 / (row.co2 + p.half)) / (800 / (800 + p.half))
}

/** One public strategy runs research concurrently with fixed finite experimental plans. */
export async function runPublicReference(port: PublicReferencePort) {
  const trace: { tick: number; event: string; refs: string[] }[] = [], waterEvidence: string[] = [], plantEvidence: string[] = []
  const initial = port.state(), services = port.catalog().services
  const note = (event: string, refs: string[] = []) => { const entry = { tick: port.state().tick, event, refs }; trace.push(entry); port.progress(entry) }
  const critical = ['incubator-1', 'incubator-2', 'incubator-3', 'incubator-4', 'cold-1', 'cold-2', 'freezer', 'robot-2']
  await port.command('protect-critical-loads', 'facilities', { action: 'power_priority', order: [...new Set([
    ...initial.devices.map(d => d.id).filter(id => !critical.includes(id)), 'co2-distribution', 'water-recovery', ...critical])] })
  let lastIrrigation = -96, lastPanel = -192, plantStart = Infinity
  let fastCalibration: { gain: number; offset: number } | null = null
  let earlyResponseId: string | null = null, earlySeal = false, responseMaintenanceReady = false
  const earlySensorFaults: string[] = [], diagnosticEvidence: string[] = []
  const experiment: { plantPlan: ReturnType<PublicReferencePort['schedule']> | null } = { plantPlan: null }
  const startPlantCoverage = () => {
    if (experiment.plantPlan || port.state().batches.filter(b => b.kind === 'medium').reduce((n, b) => n + b.units, 0) < 40) return
    const medium = port.state().batches.filter(b => b.kind === 'medium' && b.units > 0).map(b => ({ ...b }))
    const allocateMedium = () => { const batch = medium.find(b => b.units >= 2); if (!batch) throw new Error('Public reference lacks medium for its declared coverage'); batch.units -= 2; return batch.id }
    plantStart = port.state().tick + 16
    const plantSteps: Json[] = [], levels = [45, 65, 85, 95, 55, 75]
    for (let round = 0; round < 6; round++) for (const [index, chamber] of initial.chambers.entries()) {
      const at = plantStart + 128 * round, suffix = `${round}-${index}`, light = levels[(round + index) % levels.length]!, nutrient = round % 3 + 1
      plantSteps.push({ id: `light-${suffix}`, providerId: 'greenhouse', at, input: { action: 'light', chamberId: chamber.id, level: light } },
        { id: `temperature-${suffix}`, providerId: 'greenhouse', at, input: { action: 'configure', deviceId: chamber.id, enabled: true, targetTemperature: 20 + 2 * ((round + 2 * index) % 3) } },
        { id: `co2-${suffix}`, providerId: 'greenhouse', at, input: { action: 'co2', chamberId: chamber.id, setpoint: [650, 950, 1150][(round + index) % 3]! } })
      if (round > 0) plantSteps.push({ id: `nutrient-${suffix}`, providerId: 'greenhouse', at,
        input: { action: 'nutrient', chamberId: chamber.id, level: nutrient, batchId: allocateMedium() } })
      plantSteps.push({ id: `irrigation-${suffix}`, providerId: 'greenhouse', at: at + 8,
        input: { action: 'irrigate', chamberId: chamber.id, volumeUl: 4 * [45, 75, 105][(2 * round + index) % 3]! } })
      for (let repeat = 0; repeat < 6; repeat++) plantSteps.push({ id: `scan-${suffix}-${repeat}`, providerId: 'greenhouse', at: at + 80 + 4 * repeat,
        input: { action: 'scan', chamberId: chamber.id } })
    }
    experiment.plantPlan = port.schedule('plant-coverage', { title: 'Crossed live plant response coverage', steps: plantSteps })
    note('plant-plan-start', [experiment.plantPlan.id])
  }
  const admissionOpen = () => port.state().tick < initial.finalTick
  port.onTick(async () => {
    const state = port.state()
    if (state.tick >= state.finalTick) return
    const maintenanceState = state.robots.find(r => r.id === 'robot-3')!
    if (earlyResponseId && !responseMaintenanceReady && !maintenanceState.busy && maintenanceState.node === maintenanceState.id && maintenanceState.energy >= 110) responseMaintenanceReady = true
    const mayMaintain = !earlyResponseId || responseMaintenanceReady
    startPlantCoverage()
    if (fastCalibration && !earlyResponseId && (state.inlineDoc.pump! - fastCalibration.offset) / fastCalibration.gain > 2.5) {
      const maintenance = port.state().robots.find(r => r.id === 'robot-3')!
      if (maintenance.energy < 100) {
        if (maintenance.node !== maintenance.id) await port.command(`incident-dock-${state.tick}`, 'facilities', { action: 'move', robotId: maintenance.id, destination: maintenance.id })
        if (!admissionOpen()) return
        await port.command(`incident-charge-${state.tick}`, 'facilities', { action: 'charge', robotId: maintenance.id })
      }
      if (!admissionOpen()) return
      const readings: Record<string, number> = {}
      for (const source of ['filter', 'pump']) {
        if (!admissionOpen()) return
        const probe = await port.command(`investigate-${source}-${state.tick}`, 'facilities', { action: 'device_reference', targetId: source })
        readings[source] = z.object({ reference: z.object({ docInline: z.number() }) }).passthrough().parse(probe.result).reference.docInline
        diagnosticEvidence.push(probe.id)
        if (Math.abs((state.inlineDoc[source]! - readings[source]!) / fastCalibration.gain) > 0.7) earlySensorFaults.push(source)
      }
      if (!admissionOpen()) return
      earlySeal = (readings.pump! - readings.filter!) / fastCalibration.gain > 1
      const steps: Json[] = [], dependencies: string[] = []
      if (earlySeal) {
        steps.push({ id: 'repair-pump', providerId: 'facilities', input: { action: 'repair', deviceId: 'pump' } },
          { id: 'clean-pump', providerId: 'facilities', dependsOn: ['repair-pump'], input: { action: 'clean', deviceId: 'pump' } })
        dependencies.push('clean-pump')
      }
      for (const source of earlySensorFaults) {
        const id = `sensor-${source}`
        steps.push({ id, providerId: 'facilities', dependsOn: [...dependencies], input: { action: 'sensor_calibrate', targetId: source, channel: 'doc_inline' } })
        dependencies.push(id)
      }
      steps.push({ id: 'validate-pump', providerId: 'facilities', dependsOn: dependencies, input: { action: 'device_reference', targetId: 'pump' } },
        { id: 'park-maintenance', providerId: 'facilities', dependsOn: ['validate-pump'], input: { action: 'move', robotId: 'robot-3', destination: 'robot-3' } },
        { id: 'charge-maintenance', providerId: 'facilities', dependsOn: ['park-maintenance'], input: { action: 'charge', robotId: 'robot-3' } })
      const plan = port.schedule('early-response', { title: 'Prospective response to observed water anomaly', steps }), id = 'early-response-prediction'
      const baselineIncrement = Math.max(0, Math.min(0.5, (initial.inlineDoc.pump! - initial.inlineDoc.filter!) / fastCalibration.gain))
      port.actionForecast(id, { id, taskId: 'T4', planId: plan.id, sourceId: 'pump', forecast: { completedTick: port.state().tick + 160,
        postResponseMgL: (readings.filter! - fastCalibration.offset) / fastCalibration.gain + baselineIncrement } })
      earlyResponseId = id; note('observed-early-anomaly', diagnosticEvidence)
      return
    }
    if (mayMaintain && !(state.tick >= plantStart && state.tick < plantStart + 6 * 128) && state.tick - lastIrrigation >= 96) {
      lastIrrigation = state.tick
      const round = Math.max(0, Math.floor((state.tick - plantStart) / 128))
      for (const [index, chamber] of state.chambers.entries()) {
        if (!admissionOpen()) return
        const dose = state.waterRoute === 'reserve' ? 35 : plantStart === Infinity ? 65 : [45, 75, 105][(2 * round + index) % 3]!
        await port.command(`routine-water-${chamber.id}-${state.tick}`, 'greenhouse', { action: 'irrigate', chamberId: chamber.id, volumeUl: 4 * dose })
      }
    }
    if (!admissionOpen()) return
    // Assay procedures and service DAGs own the two carriers' charging; maintenance owns only robot-3.
    for (const robot of port.state().robots) if (robot.id === 'robot-3' && mayMaintain && !robot.busy && robot.energy < 65) {
      if (robot.node !== robot.id) await port.command(`dock-${robot.id}-${state.tick}`, robot.id === 'robot-3' ? 'facilities' : 'water', { action: 'move', robotId: robot.id, destination: robot.id })
      if (!admissionOpen()) return
      await port.command(`charge-${robot.id}-${state.tick}`, robot.id === 'robot-3' ? 'facilities' : 'water', { action: 'charge', robotId: robot.id })
    }
    if (!admissionOpen()) return
    const now = port.state(), robot = now.robots.find(r => r.id === 'robot-3')
    if (mayMaintain && now.tick + 96 < state.finalTick && robot && !robot.busy && robot.energy > 75 && now.tick - lastPanel >= 192) {
      lastPanel = now.tick
      await port.command(`panel-${now.tick}`, 'facilities', { action: 'panel_clean' })
      if (port.state().tick < state.finalTick) await port.command(`park-maintenance-${now.tick}`, 'facilities', { action: 'move', robotId: 'robot-3', destination: 'robot-3' })
    }
  })
  await port.command('medium-order', 'facilities', { action: 'order', deviceId: 'analysis', kind: 'medium' })
  const servicePortfolio: Json[] = [], previousCarrierMission = new Map<string, string>()
  const serviceStarts = services.map((_request, index) => 790 + 40 * index)
  for (const [index, request] of services.entries()) {
    const prefix = `s${index + 1}`, robot = 'robot-2'
    const qualify = (value: Json): Json => {
      if (typeof value === 'string' && value.startsWith('$step:')) return `$step:${prefix}-${value.slice(6)}`
      if (Array.isArray(value)) return value.map(qualify)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, qualify(child)]))
      return value
    }
    for (const raw of serviceSteps(request.sourceId, robot, serviceStarts[index]!)) {
      const step = z.object({ id: z.string(), providerId: z.string(), input: z.json(), at: z.number().optional(), dependsOn: z.array(z.string()).default([]) }).parse(raw)
      servicePortfolio.push({ id: `${prefix}-${step.id}`, providerId: step.providerId, input: qualify(step.input),
        ...(step.at === undefined ? {} : { at: step.at }), dependsOn: [...step.dependsOn.map(id => `${prefix}-${id}`),
          ...(step.id === 'dock' && previousCarrierMission.has(robot) ? [previousCarrierMission.get(robot)!] : [])] })
    }
    previousCarrierMission.set(robot, `${prefix}-charge-end`)
  }
  const servicePlan = port.schedule('service-portfolio', { title: 'Explicitly coordinated public service portfolio', steps: servicePortfolio })
  const commitmentIds = services.map((request, index) => {
    const id = `commitment-${request.id}`
    port.actionForecast(id, { id, taskId: 'T3', planId: servicePlan.id, commissionId: request.id,
      forecast: { completedTick: serviceStarts[index]! + 120 + (index === 2 ? 250 : 0), remainingUl: 125 } })
    return id
  })
  await port.command('controls-to-handler', 'water', { action: 'transfer', deviceId: 'robot-1', sampleId: 'qc-low', additionalSampleIds: ['qc-high'], destination: 'liquid-handler' })
  const lowId = await port.aliquot('low-control', 'qc-low', 25), highId = await port.aliquot('high-control', 'qc-high', 25), preciseId = await port.aliquot('precise-control', 'qc-high', 50)
  await port.command('controls-to-store', 'water', { action: 'transfer', deviceId: 'robot-1', sampleId: 'qc-low', additionalSampleIds: ['qc-high'], destination: 'cold-2' })
  const controls = await port.screenBatch('screen-controls', [lowId, highId]), low = controls[0]!, high = controls[1]!
  waterEvidence.push(low.id, high.id)
  const fastGain = (high.value - low.value) / 6, fastOffset = low.value - 2 * fastGain
  fastCalibration = { gain: fastGain, offset: fastOffset }
  const split = await port.split('decay-study'), samples: PublicAssay[] = [], stores = ['cold-2', 'bench']
  samples.push(...await port.screenBatch('early-storage', stores.map(name => split.byStorage[name]![0]!)))
  const storageComparisonTick = port.state().tick + 160
  await port.command('preclean-precise-1', 'facilities', { action: 'clean', deviceId: 'confirm' })
  await port.command('preclean-precise-2', 'facilities', { action: 'clean', deviceId: 'confirm' })
  const precise = await port.assay('confirm-standard', { sampleId: preciseId, method: 'confirm', confirmVolumeUl: 25 }); waterEvidence.push(precise.id)
  const historical = port.catalog().handover.find(r => r.id === 'handover-water-calibration')
  const historicalStandard = historical ? z.object({ historicalStandard: z.object({ knownStandardMgL: z.number(), instrumentEstimate: z.number() }) }).passthrough().parse(historical.content).historicalStandard : null
  let method1 = historicalStandard ? historicalStandard.instrumentEstimate / historicalStandard.knownStandardMgL : 1, method2 = 1
  const measuredGain = precise.value / (8 * (1 + 0.0004 * precise.calibrationAge))
  if (precise.methodVersion === 1) method1 = measuredGain; else method2 = measuredGain
  note('actual-controls', [low.id, high.id, precise.id])
  while (!experiment.plantPlan) { startPlantCoverage(); if (!experiment.plantPlan) await port.waitUntil(port.state().tick + 12) }
  const plantPlan = experiment.plantPlan
  await port.waitUntil(storageComparisonTick)
  samples.push(...await port.screenBatch('late-storage', stores.map(name => split.byStorage[name]![1]!)))
  waterEvidence.push(...samples.map(a => a.id)); note('actual-storage-contrasts', samples.map(a => a.id))
  const priorFrozen = 0.00001
  const differences = stores.map((_name, i) => {
    const a = samples[i]!, b = samples[i + stores.length]!
    const durations = (assay: PublicAssay) => [-10, 4, 22].map(t => assay.trajectory.filter(x => Math.abs(x.temperature - t) < 0.5).reduce((n, x) => n + x.elapsedTicks, 0))
    const ta = durations(a), tb = durations(b), log = Math.log(Math.max(0.001, a.value - fastOffset) / Math.max(0.001, b.value - fastOffset))
    return { x: [tb[1]! - ta[1]!, tb[2]! - ta[2]!], y: log - priorFrozen * (tb[0]! - ta[0]!) }
  })
  const fittedRates = solve(differences, 2), rates = [priorFrozen, Math.max(0.0000001, fittedRates[0]!), Math.max(0.0000001, fittedRates[1]!)]
  await port.waitUntil(Math.max(plantStart + 5 * 128 + 110, initial.baselineTick + Math.floor((initial.finalTick - initial.baselineTick) * 0.35)))
  const scans = port.completedScans(plantPlan.id)
  if (scans.length < 60) throw new Error('Live plant coverage did not complete')
  const observations = plantObservations(scans)
  plantEvidence.push(...scans.map(scan => scan.id))
  const byCrop = Object.fromEntries(core.map(cropId => {
    const variety = cropId.split('-').at(-1), related = Object.entries(observations).filter(([id]) => id.split('-').at(-1) === variety).flatMap(([individual, rows]) => rows.map(row => ({ ...row, individual })))
    const fit = fitPlant(related), own = observations[cropId] ?? []
    const factor = median(own.map(row => row.y / Math.max(0.01, plantValue(fit, row))))
    fit.coefficients[0] = fit.coefficients[0]! + Math.log(Math.max(0.1, factor))
    return [cropId, fit]
  }))
  note('actual-crossed-plant-data', plantEvidence)
  const energyAnalysis = await port.analyze('return await telemetry(["energy.solar","energy.soc","energy.demand"], 0, 100000)')
  const data = z.record(z.string(), z.array(z.tuple([z.number(), z.number().nullable()]))).parse(energyAnalysis.output)
  const daylight = (data['energy.solar'] ?? []).filter(([t, value]) => t < 96 && value !== null && Math.sin(2 * Math.PI * (t % 96) / 96) > 0.5)
    .map(([t, value]) => ({ x: [1, t], y: Math.log(value! / Math.sin(2 * Math.PI * (t % 96) / 96)) }))
  const solarFit = solve(daylight, 2), energyParameters = { peak: Math.exp(solarFit[0]!), dustRate: Math.max(0, Math.min(0.01, 1 - Math.exp(solarFit[1]!))),
    battery: Math.max(1, ...(data['energy.soc'] ?? []).map(([, soc]) => soc ?? 0)) }
  let serviceMeasurements = port.completedAssays(servicePlan.id)
  while (!['reservoir', 'filter', 'pump'].every(source => serviceMeasurements.some(result => result.sourceId === source))) {
    if (port.state().tick >= initial.finalTick - 80) throw new Error('Scientific service measurements missed the model-validation window')
    await port.waitUntil(port.state().tick + 12)
    serviceMeasurements = port.completedAssays(servicePlan.id)
  }
  const current = ['reservoir', 'filter', 'pump'].map(source => serviceMeasurements.filter(result => result.sourceId === source).at(-1)!)
  waterEvidence.push(...current.map(a => a.id)); note('actual-service-measurements', current.map(a => a.id))
  if (port.state().methodVersion !== precise.methodVersion) {
    await port.command('new-method-preclean-1', 'facilities', { action: 'clean', deviceId: 'confirm' })
    await port.command('new-method-preclean-2', 'facilities', { action: 'clean', deviceId: 'confirm' })
    const measurement = await port.confirmPrepared('new-method-calibration', precise.sampleId, 25)
    waterEvidence.push(measurement.id)
    method2 = measurement.value / (8 * (1 + 0.0004 * measurement.calibrationAge))
  }
  const atSampling = (assay: PublicAssay) => (assay.value - fastOffset) / fastGain * Math.exp(assay.trajectory.reduce((s, x) => s + decayAt(rates, x.temperature) * x.elapsedTicks, 0))
  const inferred = current.map(atSampling), live = port.state(), diagnosis: string[] = []
  if (earlySeal || inferred[2]! - inferred[1]! > 1) diagnosis.push('seal')
  if (live.methodVersion !== precise.methodVersion) diagnosis.push('measurement')
  const sensorFaults = [...new Set([...earlySensorFaults, ...['reservoir', 'filter', 'pump'].filter((source, i) => Math.abs((live.inlineDoc[source]! - fastOffset) / fastGain - inferred[i]!) > 0.7)])]
  if (sensorFaults.length) diagnosis.push('inline-sensor')
  let responseId: string | null = earlyResponseId
  if (!responseId) {
    const responseSteps: Json[] = [], causal: string[] = []
    if (diagnosis.includes('seal')) {
      responseSteps.push({ id: 'repair-pump', providerId: 'facilities', input: { action: 'repair', deviceId: 'pump' } },
        { id: 'clean-pump', providerId: 'facilities', dependsOn: ['repair-pump'], input: { action: 'clean', deviceId: 'pump' } })
      causal.push('clean-pump')
    }
    for (const source of sensorFaults) { const id = `sensor-${source}`; responseSteps.push({ id, providerId: 'facilities', input: { action: 'sensor_calibrate', targetId: source, channel: 'doc_inline' } }); causal.push(id) }
    responseSteps.push({ id: 'independent-validation', providerId: 'facilities', dependsOn: causal, input: { action: 'device_reference', targetId: 'pump' } })
    const responsePlan = port.schedule('response', { title: 'Prospective response and independent calibrated probe', steps: responseSteps })
    responseId = 'response-forecast'
    port.actionForecast(responseId, { id: responseId, taskId: 'T4', planId: responsePlan.id, sourceId: 'pump', forecast: { completedTick: live.tick + 160,
      postResponseMgL: diagnosis.includes('seal') ? inferred[1]! + 0.15 : inferred[2]! } })
  }
  const validation: Json[] = []
  for (let at = initial.finalTick; at < initial.horizon - 8; at += 96) for (const chamber of initial.chambers)
    validation.push({ id: `water-${at}-${chamber.id}`, providerId: 'greenhouse', at, input: { action: 'irrigate', chamberId: chamber.id, volumeUl: 260 } })
  for (const [index, chamber] of initial.chambers.entries()) {
    const fit = byCrop[core[index]!]!, light = [45, 55, 65, 75, 85, 95].sort((a, b) => plantValue(fit, { light: b, nutrient: 3, irrigation: 65, co2: 1100, temperature: 22 + 0.03 * Math.max(0, b - 70) }) -
      plantValue(fit, { light: a, nutrient: 3, irrigation: 65, co2: 1100, temperature: 22 + 0.03 * Math.max(0, a - 70) }))[0]!
    await port.command(`final-light-${chamber.id}`, 'greenhouse', { action: 'light', chamberId: chamber.id, level: light })
    await port.command(`final-temperature-${chamber.id}`, 'greenhouse', { action: 'configure', deviceId: chamber.id, enabled: true, targetTemperature: 22 })
    validation.push({ id: `scan-${chamber.id}`, providerId: 'greenhouse', at: initial.horizon - 20, input: { action: 'scan', chamberId: chamber.id } })
  }
  for (let at = initial.finalTick + 24; at < initial.horizon - 64; at += 192) validation.push(
    { id: `dock-${at}`, providerId: 'facilities', at, input: { action: 'move', robotId: 'robot-3', destination: 'robot-3' } },
    { id: `charge-${at}`, providerId: 'facilities', dependsOn: [`dock-${at}`], input: { action: 'charge', robotId: 'robot-3' } },
    { id: `panel-${at}`, providerId: 'facilities', dependsOn: [`charge-${at}`], input: { action: 'panel_clean' } })
  const joint = port.schedule('joint-validation', { title: 'Frozen joint research window', steps: validation })
  const waterParameters = { method1, method2, rates, retention: 0.5 }
  const register = (id: string, code: string, parameters: Json) => port.registerModel(id, { id, code, parameters, inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-model-v06-sync-v1' })
  register('water-final', `${waterProgram}\nreturn { concentrationAtSampling: water(input) };`, waterParameters)
  register('crop-final', cropProgram, { byCrop })
  register('energy-final', `${energyProgram}\nreturn energy(input);`, energyParameters)
  register('joint-final', `${waterProgram}\n${energyProgram}\nif(input.kind==='energy')return energy(input);const c=input.irrigationConditions;return {waterStress:c.source==='main'&&c.doseUl>0&&c.elapsedTicks>=40&&c.elapsedTicks<60&&water(input.waterObservation)>input.thresholdMgL};`, { ...waterParameters, ...energyParameters })
  for (const [taskId, modelId] of [['T1', 'water-final'], ['T2', 'crop-final'], ['T3', 'energy-final'], ['T5', 'joint-final']] as const) {
    const predictionId = `${taskId}-prediction`
    port.commit(predictionId, { id: predictionId, taskId, slotId: 'final', modelId, inputDomain: {} })
    port.submit(`submit-${taskId}`, { taskId, slotId: 'final', expectedRevision: 0,
      payload: { modelId, predictionId, ...(taskId === 'T2' ? { planId: joint.id } : {}), ...(taskId === 'T3' ? { commitmentIds } : {}),
        ...(taskId === 'T5' ? { scopeIds: diagnosis.length || live.methodVersion !== initial.methodVersion ? ['impact-water', 'impact-irrigation'] : [] } : {}) },
      evidence: [...waterEvidence.map(id => ({ id, purpose: 'calibration' })), ...plantEvidence.map(id => ({ id, purpose: 'validation' })), { id: energyAnalysis.id, purpose: 'validation' }] })
  }
  port.submit('submit-T4', { taskId: 'T4', slotId: 'final', payload: { diagnosis, responseIds: [responseId] }, evidence: [...waterEvidence, ...diagnosticEvidence].map(id => ({ id, purpose: 'calibration' })), expectedRevision: 0 })
  port.submit('submit-T6', { taskId: 'T6', slotId: 'final', payload: { planId: joint.id }, evidence: [], expectedRevision: 0 })
  note('final-models-and-plans', ['water-final', 'crop-final', 'energy-final', 'joint-final', joint.id])
  await port.waitUntil(initial.horizon)
  return { trace, waterParameters, plantParameters: byCrop, energyParameters, fastCalibration: { gain: fastGain, offset: fastOffset } }
}
