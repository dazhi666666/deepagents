/** Prospective matched-chamber pilot. Score only the frozen declaration and realized physical work. */
import { z } from 'zod'
import type { Plan } from '../v05/planning.ts'
import type { StageProfile, Submission } from './contracts.ts'
import { jointTrialPolicy as policy, trialDeclaration, type TrialDeclaration } from './joint-trial-contract.ts'
import type { V06World } from './world.ts'
import { touchesTrialChamber } from './shared-plan.ts'
import { sharedPlanVersion } from './pilot-choice-contract.ts'

const payloadSchema = z.object({ planId: z.string(), trial: trialDeclaration }).strict()
const chambers = (t: TrialDeclaration) => [t.treatmentCropId, t.controlCropId].map(id => `incubator-${id.split('-')[1]}`) as [string, string]
const commandFields = z.object({ action: z.string(), chamberId: z.string().optional(), cropId: z.string().optional() })
const controlSettings = new Set(['light', 'nutrient', 'co2', 'crop_remove', 'quarantine'])

export function checkJointPlan(plan: Plan | undefined, input: unknown, stages: StageProfile) {
  checkDeclaredPlan(plan, payloadSchema.parse(input).trial, stages)
}
export function checkDeclaredPlan(plan: Plan | undefined, trial: TrialDeclaration, stages: StageProfile) {
  if (!plan || plan.state !== 'scheduled' || Object.keys(plan.operations).length) throw new Error('T6 requires an unstarted scheduled plan')
  const window = stages.horizon - stages.finalTick, [treatment, control] = chambers(trial)
  if (trial.waterBudgetUl > window * policy.maximumWaterUlPerTick || trial.energyBudget > window * policy.maximumEnergyPerTick)
    throw new Error('T6 declared water or energy budget exceeds the public validation-window cap')
  const scanFrom = stages.finalTick + Math.ceil(policy.earliestScanFraction * window)
  const commands = plan.steps.map(s => ({ c: commandFields.parse(s.input), s }))
  const byId = new Map(plan.steps.map(s => [s.id, s])), starts = new Map<string, number>()
  const first = (id: string): number => { const cached = starts.get(id); if (cached !== undefined) return cached
    const s = byId.get(id)!; const at = Math.max(s.at, ...s.dependsOn.map(first)); starts.set(id, at); return at }
  if (commands.some(({ s }) => first(s.id) < stages.finalTick || first(s.id) >= stages.horizon)) throw new Error('Schedule all T6 steps inside [finalTick,horizon)')
  if (!commands.some(({ c }) => c.action === 'irrigate' && c.chamberId === treatment && (!c.cropId || c.cropId === trial.treatmentCropId)) ||
      !commands.some(({ c }) => c.action === 'light' && c.chamberId === treatment)) throw new Error('T6 needs irrigation and a light treatment for the declared crop')
  if (commands.some(({ c }) => !['irrigate', 'light', 'scan'].includes(c.action) || ![treatment, control].includes(c.chamberId ?? '') ||
    (c.cropId && c.cropId !== (c.chamberId === treatment ? trial.treatmentCropId : trial.controlCropId))))
    throw new Error('T6 trial steps support irrigation, light and scans of the two declared chambers')
  if (commands.some(({ c }) => c.chamberId === control && c.action === 'light')) throw new Error('Keep the comparison chamber under its existing settings')
  for (const ch of [treatment, control]) if (!commands.some(({ c, s }) => c.action === 'scan' && c.chamberId === ch && first(s.id) >= scanFrom))
    throw new Error(`T6 needs a final-quarter verification scan for ${ch} at or after ${scanFrom}`)
}

const cropSnapshot = z.object({ id: z.string(), status: z.string(), removed: z.boolean(), biomass: z.number() })
export function evaluateJointTrial(world: Pick<V06World, 'observe' | 'observeSystems' | 'quality' | 'stages'>, submission: Submission | null, plan: Plan | null,
  evidence: { currentWater: boolean; measuredEnergy: boolean }) {
  const version = policy.version
  if (!submission || !plan) return { version, passed: false, reason: 'missing_sealed_trial', checks: null, outcome: null }
  return evaluateDeclaredTrial(world, plan, payloadSchema.parse(submission.payload).trial, evidence)
}
export function evaluateDeclaredTrial(world: Pick<V06World, 'observe' | 'observeSystems' | 'quality' | 'stages'>, plan: Plan,
  trial: TrialDeclaration, evidence: { currentWater: boolean; measuredEnergy: boolean }) {
  const version = policy.version, { finalTick, horizon } = world.stages
  const start = z.object({ crops: z.array(cropSnapshot) }).parse(world.quality().snapshots[String(finalTick)])
  const meter = z.object({ jointEnergy: z.object({ ticks: z.number(), delivered: z.number() }) }).parse(world.quality().snapshots[String(horizon)]).jointEnergy
  if (meter.ticks !== horizon - finalTick) throw new Error('T6 sealed energy meter does not cover the full validation window')
  const systems = world.observeSystems(), [a, b] = chambers(trial), duration = horizon - finalTick
  const pair = [trial.treatmentCropId, trial.controlCropId].map(id => ({ before: start.crops.find(c => c.id === id)!, after: systems.crops.find(c => c.id === id)! }))
  const [t, c] = [pair[0]!, pair[1]!], growth = (t.after.biomass - t.before.biomass) / duration, controlGrowth = (c.after.biomass - c.before.biomass) / duration
  const gainPerTick = growth - controlGrowth, forecastError = Math.abs(trial.forecastGainPerTick - gainPerTick)
  const linked = new Set(Object.values(plan.operations))
  const work = systems.operations.filter(o => o.state === 'succeeded' && o.completedTick != null && o.completedTick > finalTick && o.completedTick <= horizon)
  const applied = work.filter(o => linked.has(o.id) && o.acceptedTick >= finalTick)
  const treatment = applied.filter(o => 'chamberId' in o.command && o.command.chamberId === a &&
    (o.command.action === 'light' || o.command.action === 'irrigate' && (!o.command.cropId || o.command.cropId === trial.treatmentCropId)))
  const lastTreatment = Math.max(finalTick, ...treatment.map(o => o.completedTick!))
  const pairedWork = work.filter(o => 'chamberId' in o.command && [a, b].includes(o.command.chamberId) ||
    'cropId' in o.command && [trial.treatmentCropId, trial.controlCropId].includes(o.command.cropId ?? ''))
  const waterUl = pairedWork.reduce((water, o) => water + (o.command.action === 'irrigate' ? o.command.volumeUl : 0), 0)
  const scanFrom = finalTick + Math.ceil(policy.earliestScanFraction * duration)
  const shared = world.stages.jointTrial === sharedPlanVersion
  const externalChamberConfig = world.observe().operations.some(op => op.state === 'succeeded' && op.completedTick != null && op.completedTick > finalTick &&
    (shared ? touchesTrialChamber(op.command,[a,b]) : op.command.action === 'configure' && [a, b].includes(op.command.deviceId)))
  const externalSystemWork = shared && work.some(op=>op.command.action!=='scan' && !linked.has(op.id) && touchesTrialChamber(op.command,[a,b]))
  const checks = { ...evidence, planSucceeded: plan.state === 'succeeded',
    comparableStart: pair.every(p => !p.before.removed && p.before.status === 'healthy') &&
      Math.abs(t.before.biomass - c.before.biomass) <= policy.maximumStartingBiomassDifferenceFraction * Math.max(1, t.before.biomass, c.before.biomass),
    bothAlive: pair.every(p => !p.after.removed && p.after.status !== 'lost'),
    interventionsExecuted: treatment.some(o => o.command.action === 'irrigate') &&
      treatment.some(o => o.command.action === 'light' && o.command.level !== systems.light[b]),
    comparisonProtocol: !externalChamberConfig && !externalSystemWork && pairedWork.every(o => o.command.action === 'scan' || linked.has(o.id)) &&
      !pairedWork.some(o => 'chamberId' in o.command && o.command.chamberId === b && controlSettings.has(o.command.action)),
    verified: [a,b].every(ch => applied.some(o => o.command.action === 'scan' && o.command.chamberId === ch && o.acceptedTick >= Math.max(scanFrom, lastTreatment))),
    measuredGain: growth > 0 && gainPerTick >= policy.minimumGainPerTick, forecast: forecastError <= policy.forecastAbsoluteTolerance,
    water: waterUl <= trial.waterBudgetUl, energy: meter.delivered <= trial.energyBudget }
  return { version, passed: Object.values(checks).every(Boolean), reason: null, declaration: trial, checks,
    outcome: { treatmentGainPerTick: growth, controlGainPerTick: controlGrowth, gainPerTick, forecastError, waterUl, energy: meter.delivered } }
}
