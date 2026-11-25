import { z } from 'zod'

export const pairedGrowthVersion = 'paired-growth-v1' as const
const cropId = z.string().regex(/^crop-[1-4]-[1-4]$/)
export const trialDeclaration = z.object({ treatmentCropId: cropId, controlCropId: cropId,
  forecastGainPerTick: z.number().positive(), waterBudgetUl: z.number().int().positive(), energyBudget: z.number().positive() }).strict()
  .refine(v => v.treatmentCropId !== v.controlCropId && v.treatmentCropId.split('-')[2] === v.controlCropId.split('-')[2],
    'Choose one crop of the same variety in each of two different chambers')
export type TrialDeclaration = z.infer<typeof trialDeclaration>
export const jointTrialPolicy = { version: pairedGrowthVersion, minimumGainPerTick: 0.02, forecastAbsoluteTolerance: 0.05,
  maximumStartingBiomassDifferenceFraction: 0.20, maximumWaterUlPerTick: 20, maximumEnergyPerTick: 20,
  earliestScanFraction: 0.75,
  endpoint: 'Gain per tick = (treatment biomass change minus control biomass change) / validation ticks. At final both crops must be healthy and their biomass difference must fit the published fraction of max(1,treatment biomass,control biomass). Both must survive to horizon.',
  plan: 'Preregister an unstarted plan containing only irrigation, light and scans in the two trial chambers. Execute irrigation and a light setting distinct from the control after final. Keep control settings stable and scan both chambers in the last quarter after the treatments. Include maintenance irrigation for the control in the sealed plan as needed.',
  evidence: 'Cite a current source-water measurement and a completed analysis of actual energy.solar or energy.soc telemetry before final.',
  resources: 'Water covers successful irrigation in both chambers. Energy totals delivered whole-base demand over (final,horizon]. Declare both budgets within the published per-tick limits.',
  scoring: 'All trial checks determine the joint plan condition in F. Report the gain, forecast error, budgets and component checks at horizon.' } as const
