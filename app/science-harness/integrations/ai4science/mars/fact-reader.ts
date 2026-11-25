/** Instance-owned incremental fact reads over the authorized durable event API. */
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { Json, OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
export type FactSource = Pick<ExecutionEngine, 'readFacts' | 'recordFact'> & Partial<Pick<ExecutionEngine, 'events' | 'eventCursor'>>
type Fact = { actorId: string; kind: string; data: Json }
const eventSchema = z.object({ seq: z.number().int().positive(), type: z.string(), data_json: z.string() })
const factSchema = z.object({ actorId: z.string(), kind: z.string(), data: z.json() })
/** Cached objects are internal: consumers copy any mutable values returned to callers. */
export class FactReader {
  private cursor = 0
  private rows: Fact[] = []
  constructor(private readonly source: FactSource, private readonly context: OperationContext, private readonly incremental = true) {}
  /** Rechecks authorization on every read. Sources without event cursors keep the full-read behavior. */
  read(): readonly Fact[] {
    if (!this.incremental || !this.source.events || !this.source.eventCursor) return this.source.readFacts(this.context)
    const latest = this.source.eventCursor(this.context)
    if (latest < this.cursor) { this.rows = []; this.cursor = 0 }
    if (latest === this.cursor) return this.rows
    for (const raw of this.source.events(this.context, this.cursor)) {
      const event = eventSchema.parse(raw)
      if (event.seq <= this.cursor) throw new Error('Durable fact event order regressed')
      this.cursor = event.seq
      if (event.type === 'fact') this.rows.push(factSchema.parse(JSON.parse(event.data_json)))
    }
    this.cursor = Math.max(this.cursor, latest)
    return this.rows
  }
}
