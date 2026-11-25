/** Poll committed physical transitions once; unchanged running devices keep their real locks. */
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext, OperationRecord } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from './world.ts'
const terminal = new Set(['succeeded', 'failed', 'cancelled'])
export class PhysicalObserver {
  private cursor = -1
  private readonly observed = new Map<string, string>()
  private physical = new Map<string, { state: string; signature: string }>()
  constructor(private readonly engine: Pick<ExecutionEngine, 'get' | 'query' | 'list'>,
    private readonly world: Pick<MarsWorld, 'eventCursor' | 'observe' | 'observeSystems'>) {}
  private states() {
    const cursor = this.world.eventCursor()
    if (cursor !== this.cursor) {
      if (cursor < this.cursor) this.observed.clear()
      this.physical = new Map([...this.world.observe().operations, ...this.world.observeSystems().operations].map(operation =>
        [operation.id, { state: operation.state, signature: JSON.stringify([operation.state, operation.nextTick,
          'stage' in operation ? operation.stage : null, operation.completedTick ?? null]) }]))
      this.cursor = cursor
    }
    return this.physical
  }
  /** Authorization is checked even when a physical transition was already published. */
  async query(context: OperationContext, id: string): Promise<OperationRecord> {
    const current = this.engine.get(context, id)
    if (terminal.has(current.state)) return current
    const physical = this.states().get(id)
    if (physical && this.observed.get(id) === physical.signature && current.state === physical.state) return current
    const result = await this.engine.query(context, id)
    if (physical && result.state === physical.state) this.observed.set(id, physical.signature)
    else this.observed.delete(id)
    return result
  }
  /** Observe all unfinished operations, preserving unknown outcomes and original provider identities. */
  async reconcile(context: OperationContext): Promise<void> {
    for (const operation of this.engine.list(context)) if (!terminal.has(operation.state)) await this.query(context, operation.id)
  }
}
