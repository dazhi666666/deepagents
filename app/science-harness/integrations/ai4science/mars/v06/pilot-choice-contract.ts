/** Public two-stage trial. Protocol identity includes the declarations, windows and decision rule. */
import { z } from 'zod'
import { jointTrialPolicy } from './joint-trial-contract.ts'

export const pilotChoiceVersion = 'pilot-choice-v2' as const
export const sharedPlanVersion = 'shared-plan-v3' as const
export const isChoiceTrial = (version?:string) => version === pilotChoiceVersion || version === sharedPlanVersion
export const scopedStepIds = z.array(z.string().trim().min(1)).min(1).max(256).refine(ids=>new Set(ids).size===ids.length,'Select each step once')
export const armNames = ['A', 'B'] as const
export const trialChamber = (crop: string) => `incubator-${crop.split('-')[1]}`
const crop = z.string().regex(/^crop-[1-4]-[1-4]$/)
const arm = z.object({ cropId: crop, light: z.number().int().min(0).max(100) }).strict()
export const pilotSchema = z.object({ arms: z.object({ A: arm, B: arm }).strict(), treatmentCropId: crop, controlCropId: crop }).strict().refine(p => {
  const crops = [p.arms.A.cropId, p.arms.B.cropId, p.treatmentCropId, p.controlCropId]
  return new Set(crops.map(trialChamber)).size === 4 && new Set(crops.map(c => c.split('-')[2])).size === 1 && p.arms.A.light !== p.arms.B.light
}, 'Use four different chambers of one variety and two different candidate light levels')
const forecast = z.object({ gainPerTick: z.number(), energy: z.number().positive() }).strict()
export const choiceSchema = z.object({ selected: z.enum(armNames), forecasts: z.object({ A: forecast, B: forecast }).strict(),
  waterBudgetUl: z.number().int().positive(), energyBudget: z.number().positive() }).strict()
export type Pilot = z.infer<typeof pilotSchema>
export type Choice = z.infer<typeof choiceSchema>
export const choicePolicy = { version: pilotChoiceVersion, minimumExposureTicks: 12, minimumGainPerTick: jointTrialPolicy.minimumGainPerTick,
  maximumWaterUlPerTick: jointTrialPolicy.maximumWaterUlPerTick, maximumEnergyPerTick: jointTrialPolicy.maximumEnergyPerTick,
  maximumStartingBiomassDifferenceFraction: jointTrialPolicy.maximumStartingBiomassDifferenceFraction, earliestScanFraction: jointTrialPolicy.earliestScanFraction,
  baseline: 'Before baseline, submit an unstarted planId and pilot={arms:{A:{cropId,light},B:{cropId,light}},treatmentCropId,controlCropId}. Four chambers, one variety. Between baseline and final, obtain a pre-scan, apply the candidate light, then a post-scan after at least 12 ticks in each pilot chamber. Irrigation is allowed.',
  final: 'After the pilot succeeds and before final, submit planId and choice={selected,forecasts:{A:{gainPerTick,energy},B:{gainPerTick,energy}},waterBudgetUl,energyBudget}. Cite both pre/post scan operations per arm, current source-water data and a completed analysis of energy.demand. Each energy forecast covers whole-base delivered demand over (final,horizon]. Gain is signed. Select the largest predicted gain within the declared energy budget, then lowest energy, then A.',
  holdout: jointTrialPolicy.plan, endpoint: jointTrialPolicy.endpoint,
  evaluation: 'Report signed gain, absolute error, improvement over a zero-effect prediction in biomass/tick, absolute energy forecast error, and operational target separately. F requires a valid controlled trial, strictly smaller error than the zero-effect reference (exact prediction of a realized zero also passes the forecast check), minimum production gain and both budgets. R uses the existing T1–T5 scale.' } as const

export function publicTrialPolicy(version:string) {
  if (version === sharedPlanVersion) return { ...choicePolicy, version:sharedPlanVersion,
    sharedPlan:'T2/final and T6/final each select stepIds from one unstarted full validation plan. Seal both references to the same plan specification to satisfy the joint F condition. All steps start in the validation window. Include every intervention in the trial chambers in T6; use those chambers only for declared irrigation, treatment light and scans. Other chambers and base maintenance can use separate steps. T2 credit requires an applied treatment affecting the fixed crop and a subsequent scan. One shared step executes once.' }
  return version===pilotChoiceVersion ? choicePolicy : jointTrialPolicy
}

export function selectedArm(c: Choice) {
  return armNames.filter(k => c.forecasts[k].energy <= c.energyBudget).sort((a,b) => c.forecasts[b].gainPerTick - c.forecasts[a].gainPerTick || c.forecasts[a].energy - c.forecasts[b].energy || a.localeCompare(b))[0]
}
