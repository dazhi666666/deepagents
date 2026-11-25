/** Explicit development settings; private realized parameters are derived separately. */
import { z } from 'zod'
import { contentHash } from './contracts.ts'

export const scienceProfileSchema = z.object({
  fastNoiseFraction: z.number().min(0).max(0.3).default(0.025),
  fastTicks: z.number().int().positive().default(3),
  analysisTimeoutMs: z.number().int().min(100).max(60000).default(30000),
  analysisOutputBytes: z.number().int().min(4096).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
  modelTimeoutMs: z.number().int().min(100).max(60000).default(10000),
  modelMemoryMb: z.number().int().min(64).max(512).default(128),
  modelOutputBytes: z.number().int().min(4096).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
  maximumConcentration: z.number().min(8).default(30),
  residualEnabled: z.boolean().default(true),
  residualRetention: z.number().min(0).max(0.999).default(0.5),
  residualContact: z.number().min(0).max(1).default(0.12),
  cleaningRetention: z.number().min(0).max(1).default(0.15),
  cleaningWaterUl: z.number().int().positive().default(10),
  cleaningUnits: z.number().int().positive().default(180),
  controlVolumeUl: z.number().int().min(100).default(600),
  caseReplicates: z.number().int().min(2).max(8).default(2),
  waterPassMgL: z.number().positive().default(0.25),
  growthPassIndex: z.number().positive().default(0.08),
  energyPassFraction: z.number().positive().max(1).default(0.12),
  interventionTarget: z.number().positive().default(0.25),
  minimumCropSurvival: z.number().min(0).max(1).default(0.75),
  minimumSampleRetention: z.number().min(0).max(1).default(0.5),
  maximumCriticalShedFraction: z.number().min(0).max(1).default(0.15),
  maximumWaterUnavailableFraction: z.number().min(0).max(1).default(0.05),
  minimumScienceQuality: z.number().min(0).max(1).default(0.6),
  condition: z.enum(['G0', 'G1', 'G2']).default('G0'),
}).strict()
export type ScienceProfile = z.infer<typeof scienceProfileSchema>
/** Hide condition-family and realized coefficients from public tools. */
export function publicScienceProfile(profile: ScienceProfile) {
  const { condition: _condition, ...settings } = profile
  return { ...settings, version: 'mars-science-v06-1', status: 'candidate_not_frozen',
    controlCertificates: [{ id: 'qc-blank', concentrationMgL: 0 }, { id: 'qc-low', concentrationMgL: 2 }, { id: 'qc-high', concentrationMgL: 8 }],
    referenceSpecification: 'Water reference is a fast biased probe, not laboratory truth. Its response is calibrated against the certified fast-channel standards.',
    inlineSpecification: 'Water status and telemetry share the biased fast response; faults add sensor offsets. Repeated reads at one tick are the same observation.',
    preciseSignalSpecification: { agingPerTick: 0.0004, docPeak: { centerMinutes: 5.1, sigmaMinutes: 0.12, areaPerMgL: 0.1 },
      interferencePeak: { centerMinutes: 5.4, sigmaMinutes: 0.15 }, internalStandard: { centerMinutes: 7.8, sigmaMinutes: 0.2, area: 1 },
      response: '(effective concentration + pre-contact memory) * unknown method gain * unknown batch gain * (1 + agingPerTick * calibration age)' },
    storageSpecification: 'Unknown positive decay rates at -10, 4 and 22 C; log-linear interpolation; each interval multiplies concentration by exp(-rate(T)*duration).',
    residualSpecification: 'Confirm water channel only. A batch shares pre-contact memory; sample contact updates memory and cleaning reduces it. Dirty/calibration constraints still apply.',
    hash: contentHash(settings) }
}
