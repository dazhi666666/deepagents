/** Domain-facing operation metadata uses logical positions from the device journal. */
import { z } from 'zod'
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from './world.ts'

/** Present recognized operation records with physical stages and logical timing.
 * @param value JSON tool or viewer result.
 * @param world Authoritative physical state.
 * @returns Domain timing, trajectory and infrastructure observation state.
 */
export function logicalOperationView(value: Json, world: MarsWorld): Json {
  let laboratory: ReturnType<MarsWorld['observe']> | undefined
  let systems: ReturnType<MarsWorld['observeSystems']> | undefined
  const visit = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(visit)
    if (value === null || typeof value !== 'object') return value
    const result: Record<string, Json> = {}
    const operation = typeof value.id === 'string' && typeof value.providerId === 'string' && typeof value.requestKey === 'string' && Array.isArray(value.artifacts)
    for (const [key, item] of Object.entries(value)) {
      if (operation && ['createdAt', 'updatedAt'].includes(key)) continue
      result[key] = visit(item)
    }
    if (operation) {
      laboratory ??= world.observe(); systems ??= world.observeSystems()
      const physical = laboratory.operations.find(operation => operation.id === value.id) ?? systems.operations.find(operation => operation.id === value.id)
      const transport = systems.transports.find(transport => transport.operationId === value.id)
      result.acceptedTick = physical?.acceptedTick ?? null
      result.completedTick = physical?.completedTick ?? null
      result.physicalState = physical?.state ?? null
      result.phase = physical && 'stage' in physical ? physical.stage : physical?.state === 'running' ? 'processing' : 'finished'
      result.plannedFinishTick = transport?.finishTick ?? physical?.nextTick ?? null
      result.resultIds = z.json().parse(physical && 'resultIds' in physical ? physical.resultIds ?? [] : [])
      result.action = physical && 'command' in physical && physical.command && typeof physical.command === 'object' && 'action' in physical.command
        ? String(physical.command.action) : null
      result.routeSegments = z.json().parse(transport?.segments ?? (physical && 'segments' in physical ? physical.segments : []))
      result.robotId = transport?.robotId ?? (physical && 'robotId' in physical.command ? physical.command.robotId : null)
    }
    return result
  }
  return visit(value)
}
