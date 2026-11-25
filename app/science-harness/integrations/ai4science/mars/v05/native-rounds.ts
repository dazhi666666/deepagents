/** Native tools return pending receipts; physical mutations are applied only at a common round boundary. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { canonicalJson, type Json, type OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { V05Rounds } from './rounds.ts'
import { FactReader } from '../fact-reader.ts'

const READ_TOOLS = new Set(['mission_read', 'research_catalog', 'research_read', 'round_receipts', 'task_list', 'note_read',
  'mars_inbox', 'mars_wait', 'mars_observe', 'mars_catalog', 'mars_samples', 'mars_measurements', 'mars_history',
  'robot_status', 'water_status', 'greenhouse_status', 'energy_status', 'artifact_read', 'telemetry_query',
  'archive_search', 'archive_query', 'archive_stats', 'archive_sql', 'archive_schema', 'mars_result', 'device_diagnose', 'model_test'])
export function isV05Mutation(name: string, args: unknown): boolean {
  if (READ_TOOLS.has(name)) return false
  if (name === 'research_draft') return z.object({ action: z.string() }).parse(args).action !== 'read'
  if (name === 'receipt_work') return !['get', 'list'].includes(z.object({ action:z.string() }).parse(args).action)
  if (name === 'service_review' || name === 'trial_pilot' || name === 'research_changes') return false
  if (['experiment_plan', 'resource_reservation'].includes(name)) {
    const action = z.object({ action: z.string() }).parse(args).action
    return !['list', 'check'].includes(action) && !(name === 'experiment_plan' && action === 'portfolio')
  }
  return true
}
export class NativeRounds {
  private readonly rounds: V05Rounds
  private readonly facts: FactReader
  constructor(private readonly engine: ExecutionEngine, private readonly context: OperationContext,
    private readonly tick: () => number, private readonly dt: number, private readonly actors: () => string[], private readonly snapshot: () => Json,
    private readonly namespace: 'v05' | 'v06' = 'v05', actorKey: (id: string) => string = id => id) {
    this.facts = new FactReader(engine,context,namespace==='v06')
    this.rounds = new V05Rounds(engine, context, namespace, actorKey, this.facts)
  }
  currentCommitted() { return this.rounds.committed(this.round()) }
  pending() { return this.currentCommitted() ? 0 : this.rounds.intents(this.round()).length }
  private round() { return Math.floor(this.tick() / this.dt) }
  begin() {
    const round = this.round()
    if (!this.facts.read().some(fact => fact.kind === `mars-${this.namespace}-round` && (fact.data as {key?: string}).key === `open:${round}`))
      this.rounds.open(round, this.tick(), this.actors(), this.snapshot())
  }
  queue(actorId: string, callId: string, tool: string, args: unknown, delivery?: Json) {
    const round = this.round(), input = z.json().parse({ tool, args, callId, ...(delivery ? {delivery} : {}) })
    const prior = this.rounds.intents(round).find(intent => intent.actorId === actorId && intent.requestKey === callId)
    if (prior) {
      if (canonicalJson(prior.input) !== canonicalJson(input)) throw new Error('Tool call ID reused with different intent')
      return { state: 'pending', round, actorId, callId }
    }
    const facts = this.facts.read()
    if (!facts.some(fact => fact.kind === `mars-${this.namespace}-round` && (fact.data as { key?: string }).key === `open:${round}`))
      this.rounds.open(round, this.tick(), this.actors(), this.snapshot())
    const sequence = this.rounds.intents(round).filter(intent => intent.actorId === actorId).length
    this.rounds.prepare(round, { actorId, sequence, requestKey: callId, input })
    return { state: 'pending', round, actorId, callId }
  }
  receipts(actorId: string, callId?: string) {
    const facts = this.facts.read().filter(fact => fact.kind === `mars-${this.namespace}-native-receipt`)
    return facts.map(fact => z.object({ actorId: z.string(), callId: z.string(), round: z.number(), result: z.json() }).parse(fact.data))
      .filter(receipt => receipt.actorId === actorId && (callId === undefined || receipt.callId === callId)).slice(-100)
  }
  async commit(apply: (actorId: string, callId: string, tool: string, args: Json) => Promise<Json>) {
    const round = this.round()
    if (!this.rounds.intents(round).length) return
    await this.rounds.commit(round, async intent => {
      const { tool, args, callId } = z.object({ tool: z.string(), args: z.json(), callId: z.string() }).parse(intent.input)
      const receipt = this.facts.read().find(fact => fact.kind === `mars-${this.namespace}-native-receipt` &&
        (fact.data as { actorId?: string; callId?: string; round?: number }).actorId === intent.actorId &&
        (fact.data as { callId?: string }).callId === callId && (fact.data as { round?: number }).round === round)
      if (receipt) return (receipt.data as { result: Json }).result
      const id = `${this.namespace}-apply-${createHash('sha256').update(`${round}:${intent.actorId}:${callId}`).digest('hex')}`
      const result = await apply(intent.actorId, id, tool, args)
      this.engine.recordFact(this.context, `mars-${this.namespace}-native-receipt`, { actorId: intent.actorId, callId, round, result })
      return result
    })
    return true
  }
}
