/** Compile controlled v0.6 mechanisms before the first request; only public descriptors are exported. */
import { marsScenario } from '../scenario.ts'
import { initialBase, waterQuality } from '../base.ts'
import { truthSchema, type Truth } from '../truth.ts'
import { laboratoryScenarioSchema } from '../../greenhouse/laboratory/schema.ts'
import { contentHash, type StageProfile } from './contracts.ts'
import { scienceProfileSchema, publicScienceProfile, type ScienceProfile } from './profile.ts'
import { CERTIFICATES } from './world.ts'

export function compileScenario(source: Truth, stages: StageProfile, input: ScienceProfile, salt?: string) {
  const profile = scienceProfileSchema.parse(input), truth = truthSchema.parse(structuredClone(source)), outside = stages.horizon + 10000
  truth.horizon = stages.horizon
  if (salt) for (const name of ['A1', 'A2', 'A3', 'B', 'medium'] as const) truth.lots[name] = `lot-${contentHash({ salt, lot: name }).slice(0, 16)}`
  // The initial clean loop can satisfy the operating threshold; challenges alter it later.
  truth.water.removal = Math.max(truth.water.removal, 1 - (2 - truth.water.pumpIncrement) / truth.water.reservoir)
  truth.faults = []; truth.storms = []; truth.drift = []; truth.contamination = []; truth.incidents = []
  truth.pathogen.onset = outside; truth.leak = null; truth.recall = null; truth.energy.cellFailure = null
  truth.methodUpdate.tick = outside
  const eventTick = Math.floor(stages.baselineTick + (stages.finalTick - stages.baselineTick) * 0.25)
  if (profile.condition === 'G1' && truth.seed % 2 === 1) truth.methodUpdate = { event: 'v06-method-change', tick: eventTick }
  if (profile.condition === 'G2') {
    truth.contamination = [{ event: 'v06-water-event', onset: eventTick, hypotheses: ['seal'], deltaInlet: 0,
      membraneRemoval: truth.water.removal, deltaSeal: 3.5, lubricantRatio: 0.2, decoyModule: 'filter', decoyOffset: 1.2, decoyOnset: eventTick }]
    truth.storms = [{ event: 'v06-weather-event', onset: Math.floor(eventTick + (stages.finalTick - eventTick) * 0.3),
      duration: Math.max(12, Math.floor((stages.finalTick - eventTick) * 0.25)), factor: 0.65 }]
  }
  for (const at of [0, eventTick + 1]) {
    const water = waterQuality(truth, initialBase(truth, []), at)
    if (Math.max(water.reservoir, water.filter, water.pump) * 1.15 > profile.maximumConcentration) throw new Error('Instance exceeds the declared analytical concentration range')
  }
  const scenario = marsScenario(truth)
  // Stable branches start with the validated second method; the method-change branch retains its real update.
  if (truth.methodUpdate.tick > stages.horizon) scenario.methods = scenario.methods.filter(m => m.id !== 'confirm' || m.version === 2)
  for (const method of scenario.methods) if (method.id === 'screen') { method.processingTicks = profile.fastTicks; method.requiresCalibration = true }
  const storage = scenario.devices.find(d => d.id === 'cold-2')!
  storage.capacity = Math.max(storage.capacity, CERTIFICATES.length + 4)
  for (const certificate of CERTIFICATES) scenario.samples.push({ id: certificate.id, projectId: 'mars', location: 'cold-2', container: 'vial',
    volumeUl: profile.controlVolumeUl, state: 'raw', expiresAt: stages.horizon, disposition: 'available', batchIds: [], exposureTicks: 0,
    preservation: { minimumTemperature: -30, maximumTemperature: 22, maximumExposureTicks: 400 } })
  scenario.batches.push({ id: 'qc-cleaning', kind: 'cleaning', units: profile.cleaningUnits, expiresAt: stages.horizon, disposition: 'available' })
  const publicProfile = publicScienceProfile(profile)
  return { truth, scenario: laboratoryScenarioSchema.parse(scenario), profile,
    public: { instruments: publicProfile, controls: CERTIFICATES.map(c => ({ ...c, volumeUl: profile.controlVolumeUl, validUntil: stages.horizon,
      source: 'Host-certified stable control material; handling/preservation and volume are enforced' })) },
    privateHash: contentHash({ truth, profile, stages }) }
}
