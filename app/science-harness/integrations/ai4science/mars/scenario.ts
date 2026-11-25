/** Mars laboratory scenario derived from the joint laboratory and the hidden truth's fault and revision schedule. */
import { jointLaboratoryScenario } from '../greenhouse/laboratory/scenario.ts'
import type { LaboratoryScenario } from '../greenhouse/laboratory/schema.ts'
import type { Truth } from './truth.ts'

export const ROBOT_CAPACITY: Record<string, number> = { 'robot-1': 6, 'robot-2': 2, 'robot-3': 0 }

/** Build the device scenario for one run; fault times come from evaluator truth and never reach Agents.
 * @param truth Hidden truth for this seed and load level.
 * @returns Validated laboratory scenario.
 */
export function marsScenario(truth: Truth): LaboratoryScenario {
  const scenario = jointLaboratoryScenario(truth.seed)
  scenario.projects = [{ id: 'mars', title: '火星基地' }]
  scenario.samples = scenario.samples.slice(0, 4).map((sample, index) => ({ ...sample, id: `legacy-retained-${index + 1}`, projectId: 'mars', location: 'freezer',
    container: 'vial', expiresAt: 100000, preservation: { minimumTemperature: -30, maximumTemperature: 8, maximumExposureTicks: 160 } }))
  scenario.tasks = []
  scenario.facilities.initialWaterUl = 3000
  scenario.facilities.waterCapacityUl = 5000
  scenario.facilities.powerCapacity = 20
  const incubator = scenario.devices.find(device => device.id === 'incubator-3')!
  scenario.devices.push({ ...structuredClone(incubator), id: 'incubator-4' })
  for (const device of scenario.devices) if (device.kind === 'incubator') device.capacity = 12
  scenario.devices.push({ id: 'robot-3', kind: 'robot', methods: [], containers: ['tube', 'vial'], capacity: 1,
    maximumBatchSamples: 1, batchMultiple: 1, powerDraw: 0.5, waterPerProcessUl: 0 })
  for (const device of scenario.devices) if (device.kind === 'robot') device.containers = ['tube', 'vial']
  const coldRobot = scenario.devices.find(device => device.id === 'robot-2')!
  coldRobot.conditions = { initialTemperature: 4, targetTemperature: 4, minimumTarget: 4, maximumTarget: 4, ambientTemperature: 22, driftPerTick: 1, controlPerTick: 2 }
  coldRobot.powerDraw = 1
  for (const device of scenario.devices) if (device.kind === 'incubator') device.waterPerProcessUl = 20
  scenario.methods = scenario.methods.map(method => ['culture', 'water-prepare', 'extract'].includes(method.id) ? { ...method, suppliesPerBatch: true } : method)
  scenario.batches = [
    { id: truth.lots.A1, kind: 'extraction', units: 4, expiresAt: 100000, disposition: 'available' },
    { id: truth.lots.A2, kind: 'extraction', units: 4, expiresAt: 100000, disposition: 'available' },
    { id: truth.lots.A3, kind: 'extraction', units: 4, expiresAt: 100000, disposition: 'available' },
    { id: truth.lots.B, kind: 'extraction', units: 40, expiresAt: 100000, disposition: 'available' },
    { id: truth.lots.medium, kind: 'medium', units: 12, expiresAt: 100000, disposition: 'available' },
  ]
  scenario.supplyCatalog = [{ kind: 'extraction', unitsPerOrder: 30, deliveryTicks: 120, shelfLifeTicks: 5000 },
    { kind: 'medium', unitsPerOrder: 30, deliveryTicks: 120, shelfLifeTicks: 5000 }]
  scenario.faults = truth.faults.map(fault => ({ id: `${fault.event}-${fault.deviceId}`, tick: fault.tick, deviceId: fault.deviceId }))
  scenario.revisions = [{ id: 'confirm-method-update', tick: truth.methodUpdate.tick, kind: 'method', methodId: 'confirm', version: 2 }]
  return scenario
}
