/** Public capacity inventory: deliberately built without a Truth or evaluator argument. */
import { createHash } from 'node:crypto'
import type { MarsWorld } from '../world.ts'
import { ROBOT_CAPACITY } from '../scenario.ts'

export function publicResources(world: MarsWorld, benchmarkVersion: 'v0.5' | 'v0.6' = 'v0.5') {
  const lab = world.observe(), systems = world.observeSystems()
  const inventory = {
    schemaVersion: 1, benchmarkVersion, horizon: world.horizon,
    devices: lab.devices.map(device => {
      const { temperature: _privateTemperature, ...visible } = device
      return visible
    }),
    methods: lab.methods,
    robots: systems.robots.map(robot => ({ ...robot, ...(benchmarkVersion === 'v0.6' ? { sampleCapacity: ROBOT_CAPACITY[robot.id] ?? 1 } : {}) })),
    ...(benchmarkVersion === 'v0.6' ? { batches: lab.batches } : {}),
    rules: world.rules,
    sampleTiming: ['sampled_at', 'prepared_at', 'assay_started_at', 'assay_completed_at', 'result_available_at'],
    status: 'inventory_requires_joint_feasibility_validation',
  }
  return { ...inventory, sha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex') }
}

/** Inherited project responsibilities are public; none claims an evaluator-certified scientific answer. */
export const PUBLIC_HANDOVER = [
  { id: 'handover-water', project: 'PW', question: 'Determine the scope and uncertainty of historical water measurements.',
    status: 'provisional', obligations: ['Retain raw data and method/batch versions.', 'Validate historical calibration on current samples.'] },
  { id: 'handover-bio', project: 'PG', question: 'Separate water exposure, treatment, temperature and disease explanations.',
    status: 'provisional', obligations: ['Record actual irrigation and environmental exposure.', 'Reassess models when input measurement interpretation changes.'] },
  { id: 'handover-facilities', project: 'PF', question: 'Preserve research information under energy and logistics constraints.',
    status: 'provisional', obligations: ['Use observed resource capacity.', 'Keep unrelated valid models when another method changes.'] },
] as const
