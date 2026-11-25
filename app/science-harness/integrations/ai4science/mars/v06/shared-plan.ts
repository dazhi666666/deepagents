/** Scoped claims against the full preregistered plan. Only the full specification is hashed and dispatched. */
import { z } from 'zod'
import type { Plan } from '../v05/planning.ts'
import type { StageProfile, Submission } from './contracts.ts'
import { scopedStepIds, trialChamber, type Pilot } from './pilot-choice-contract.ts'

const scope = z.object({ stepIds: scopedStepIds })
const cmd = z.object({ action: z.string(), chamberId: z.string().optional(), cropId: z.string().optional(), deviceId: z.string().optional(), sourceId: z.string().optional(), targetId: z.string().optional(), destination: z.string().optional() })
export function selectSteps(plan: Plan, payload: Submission['payload'], stages: StageProfile) {
  const ids = new Set(scope.parse(payload).stepIds), steps = new Map(plan.steps.map(s => [s.id, s])), times = new Map<string, number>()
  for (const id of ids) if (!steps.has(id)) throw new Error(`Unknown selected plan step: ${id}`)
  // Preserve effective times even when a task omits a predecessor owned by the other task.
  const earliest = (id: string): number => {
    const prior = times.get(id)
    if (prior !== undefined) return prior
    const step = steps.get(id)!
    const at = Math.max(step.at, ...step.dependsOn.map(earliest))
    times.set(id, at)
    return at
  }
  const selected = plan.steps.flatMap(s => {
    const at = earliest(s.id)
    if (at < stages.finalTick || at >= stages.horizon) throw new Error('Schedule the full shared validation plan inside [finalTick,horizon)')
    return ids.has(s.id) ? [{ ...s, at, dependsOn: s.dependsOn.filter(dep => ids.has(dep)) }] : []
  })
  return { ...plan, steps: selected, operations: Object.fromEntries(Object.entries(plan.operations).filter(([id]) => ids.has(id))) }
}
export function pendingScope(plan: Plan | undefined, payload: Submission['payload'], stages: StageProfile) {
  if (!plan || plan.service || plan.state !== 'scheduled' || Object.keys(plan.operations).length) throw new Error('Select an unstarted validation plan')
  return selectSteps(plan, payload, stages)
}
export function touchesTrialChamber(input:unknown, chambers:readonly string[]) {
  const c=cmd.parse(input)
  const targets=[c.chamberId,c.deviceId,c.targetId,c.sourceId,c.cropId,c.destination].filter((id): id is string=>typeof id==='string')
  return targets.some(id=>chambers.includes(id.startsWith('crop-') ? trialChamber(id) : id))
}
export function guardTrialChambers(full: Plan, selected: Plan, pilot: Pilot) {
  const pair = [pilot.treatmentCropId, pilot.controlCropId], chambers = pair.map(trialChamber), included = new Set(selected.steps.map(s => s.id))
  for (const s of full.steps) {
    if (included.has(s.id)) continue
    const c = cmd.parse(s.input)
    if (touchesTrialChamber(c, chambers) && c.action !== 'scan') throw new Error(`Include the trial-chamber intervention ${s.id} in T6, or move it outside the trial pair`)
  }
}
export function checkCropScope(plan: Plan, crops: readonly string[]) {
  for (const s of plan.steps) {
    const c = cmd.parse(s.input)
    if (!['irrigate', 'light', 'co2', 'nutrient', 'scan'].includes(c.action) || !crops.some(id => trialChamber(id) === c.chamberId && (!c.cropId || c.cropId === id)))
      throw new Error(`T2 step ${s.id} must treat or scan a fixed crop or its chamber`)
  }
}
