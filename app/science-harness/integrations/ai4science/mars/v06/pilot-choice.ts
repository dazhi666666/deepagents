/** Resolve sealed pilot observations and apply a predeclared choice to a separate validation pair. */
import { z } from 'zod'
import type { Plan } from '../v05/planning.ts'
import type { StageProfile, Submission } from './contracts.ts'
import type { V06World } from './world.ts'
import { armNames, choicePolicy, choiceSchema, pilotChoiceVersion, sharedPlanVersion, scopedStepIds, pilotSchema, selectedArm, trialChamber, type Choice, type Pilot } from './pilot-choice-contract.ts'
import { checkDeclaredPlan, evaluateDeclaredTrial } from './joint-trial.ts'
import { planHash } from './actions.ts'

export const baselinePayload = z.object({ planId: z.string(), pilot: pilotSchema }).strict()
export const choicePayload = z.object({ planId: z.string(), choice: choiceSchema }).strict()
export const sharedChoicePayload = choicePayload.extend({stepIds:scopedStepIds})
const command = z.object({ action:z.enum(['scan','light','irrigate']), chamberId:z.string(), level:z.number().optional(), cropId:z.string().optional() })
const scanResult = z.object({ light:z.number(), values:z.array(z.object({ cropId:z.string(), growthIndex:z.number().optional() })) })
type World = Pick<V06World, 'observe' | 'observeSystems' | 'quality' | 'stages'>

export function checkPilotPlan(plan: Plan | undefined, pilot: Pilot, stages: StageProfile) {
  if (!plan || plan.state !== 'scheduled' || Object.keys(plan.operations).length) throw new Error('Register an unstarted two-arm pilot plan')
  const steps = plan.steps.map(s => ({ ...s, c:command.parse(s.input) }))
  for (const step of steps) {
    const arm = Object.values(pilot.arms).find(a => trialChamber(a.cropId) === step.c.chamberId)
    if (!arm || (step.c.cropId && step.c.cropId !== arm.cropId) || step.at < stages.baselineTick || step.at >= stages.finalTick)
      throw new Error('Limit pilot work to the two pilot chambers between baseline and final')
  }
  for (const arm of Object.values(pilot.arms)) {
    const inChamber = steps.filter(s => s.c.chamberId === trialChamber(arm.cropId))
    const lights = inChamber.filter(s => s.c.action === 'light'), light = lights[0]
    if (lights.length !== 1 || !light || light.c.level !== arm.light) throw new Error('Apply the declared light once per pilot chamber')
    const scans = inChamber.filter(s => s.c.action === 'scan')
    if (!scans.some(s => light.dependsOn.includes(s.id) && s.at <= light.at) ||
      !scans.some(s => s.dependsOn.includes(light.id) && s.at >= light.at + choicePolicy.minimumExposureTicks))
      throw new Error('In each arm link pre-scan → light → post-scan, with at least 12 ticks of exposure')
  }
}

export function pilotObservations(world: Pick<World,'observe'|'observeSystems'|'stages'>, sealed: Submission | null, plan: Plan | null, asOf: number) {
  if (!sealed || !plan || plan.state !== 'succeeded' || !sealed.references.some(r => r.kind === 'plan' && r.id === plan.id && r.hash === planHash(plan)))
    throw new Error('Complete the pilot plan selected by the baseline seal before final submission')
  const { pilot } = baselinePayload.parse(sealed.payload), systems = world.observeSystems(), lab = world.observe()
  const receipts = new Set(Object.values(plan.operations)), until = Math.min(asOf, world.stages.finalTick - 1)
  const operations = systems.operations.filter(o => o.state === 'succeeded' && o.completedTick != null && o.completedTick <= until)
  const readings = armNames.map(name => {
    const arm = pilot.arms[name], chamber = trialChamber(arm.cropId)
    const linked = operations.filter(o => receipts.has(o.id) && o.acceptedTick >= world.stages.baselineTick && 'chamberId' in o.command && o.command.chamberId === chamber)
    const light = linked.find(o => o.command.action === 'light' && o.command.level === arm.light)
    if (!light || light.completedTick == null) throw new Error(`Missing pilot light receipt for ${name}`)
    const lightEnd = light.completedTick
    const scans = linked.filter(o => o.command.action === 'scan').sort((a,b) => a.completedTick! - b.completedTick!)
    const before = scans.findLast(o => o.completedTick! <= light.acceptedTick)
    const after = scans.find(o => o.acceptedTick >= lightEnd + choicePolicy.minimumExposureTicks)
    if (!before || !after) throw new Error(`Pilot arm ${name} lacks separated pre/post scan receipts`)
    const left = scanResult.parse(before.result), right = scanResult.parse(after.result)
    const initial = left.values.find(v => v.cropId === arm.cropId)?.growthIndex, final = right.values.find(v => v.cropId === arm.cropId)?.growthIndex
    if (initial === undefined || final === undefined || right.light !== arm.light) throw new Error(`Pilot scan lacks realized conditions for ${arm.cropId}`)
    const during = (t:number) => t > before.completedTick! && t <= after.completedTick!
    if (operations.some(o => !receipts.has(o.id) && during(o.completedTick!) && (('chamberId' in o.command && o.command.chamberId === chamber) || ('cropId' in o.command && o.command.cropId === arm.cropId)) && o.command.action !== 'scan') ||
        lab.operations.some(o => o.state === 'succeeded' && o.completedTick != null && during(o.completedTick) && o.command.action === 'configure' && o.command.deviceId === chamber))
      throw new Error(`Undeclared intervention during pilot exposure in ${chamber}`)
    return { name, cropId:arm.cropId, light:arm.light, beforeId:before.id, afterId:after.id, initialGrowthIndex:initial, finalGrowthIndex:final, change:final-initial }
  })
  return { pilot, readings }
}

function declaration(pilot: Pilot, choice: Choice) {
  return { treatmentCropId:pilot.treatmentCropId, controlCropId:pilot.controlCropId, forecastGainPerTick:choice.forecasts[choice.selected].gainPerTick,
    waterBudgetUl:choice.waterBudgetUl, energyBudget:choice.energyBudget }
}

export function checkChoice(plan: Plan | undefined, choice: Choice, observed: ReturnType<typeof pilotObservations>, evidence: Submission['evidence'], stages: StageProfile) {
  if (selectedArm(choice) !== choice.selected) throw new Error('Select the highest predicted gain within the energy budget, breaking ties by lower energy then A')
  const cited = new Set(evidence.map(e => e.id))
  if (!observed.readings.every(r => cited.has(r.beforeId) && cited.has(r.afterId))) throw new Error('Cite the four observed pilot scans in evidence')
  checkDeclaredPlan(plan, declaration(observed.pilot, choice), stages)
  const lights = plan!.steps.map(s => command.parse(s.input)).filter(c => c.action === 'light')
  if (lights.some(c => c.level !== observed.pilot.arms[choice.selected].light)) throw new Error('Use the selected pilot light in the holdout treatment chamber')
}

export function evaluateChoice(world: World, baseline: Submission | null, pilotPlan: Plan | null, final: Submission | null, holdout: Plan | null,
  evidence: {currentWater:boolean; measuredEnergy:boolean}) {
  const version = world.stages.jointTrial === sharedPlanVersion ? sharedPlanVersion : pilotChoiceVersion
  if (!baseline || !pilotPlan || !final || !holdout) return { version, passed:false, reason:!baseline || !pilotPlan ? 'missing_sealed_pilot' : 'missing_sealed_choice', checks:null, outcome:null }
  const { pilot, readings } = pilotObservations(world, baseline, pilotPlan, final.acceptedTick), { choice } = (version === sharedPlanVersion ? sharedChoicePayload : choicePayload).parse(final.payload)
  const result = evaluateDeclaredTrial(world, holdout, declaration(pilot,choice), evidence)
  const { gainPerTick, forecastError, energy } = result.outcome
  const zeroEffectError = Math.abs(gainPerTick), forecastImprovement = zeroEffectError - forecastError
  const { measuredGain, forecast: _legacyTolerance, ...physical } = result.checks
  const forecastVerified = forecastImprovement > 0 || (zeroEffectError === 0 && forecastError === 0)
  const checks = { ...physical, forecast:forecastVerified, measuredGain }
  const valid = Object.values(physical).every(Boolean)
  return { version, passed:Object.values(checks).every(Boolean), reason:null, declaration:{ pilot, choice }, pilot:readings, checks,
    outcome:{ ...result.outcome, zeroEffectError, forecastImprovement, energyForecastError:Math.abs(energy-choice.forecasts[choice.selected].energy),
      controlledTrialValid:valid, productionTargetMet:valid && measuredGain, validatedForecastImprovement:valid ? forecastImprovement : null } }
}
