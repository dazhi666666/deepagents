/** Pure deterministic admission order, with durable intent and commit journal. */
import { z } from 'zod'
import { canonicalJson, type Json, type OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { FactReader } from '../fact-reader.ts'
export interface RoundIntent { actorId: string; sequence: number; requestKey: string; input: Json }
export function orderRoundIntents(round: number, actors: readonly string[], intents: readonly RoundIntent[], actorKey: (id: string) => string = id => id): RoundIntent[] {
  if (!Number.isInteger(round) || round < 0 || new Set(actors).size !== actors.length || !actors.length) throw new Error('Invalid round or actors')
  if (new Set(actors.map(actorKey)).size !== actors.length) throw new Error('Actor ordering keys must be unique')
  const ordered = [...actors].sort((a, b) => actorKey(a) < actorKey(b) ? -1 : actorKey(a) > actorKey(b) ? 1 : 0), offset = round % ordered.length
  const rank = new Map([...ordered.slice(offset), ...ordered.slice(0, offset)].map((id, i) => [id, i]))
  const keys = new Set<string>()
  for (const intent of intents) {
    if (!rank.has(intent.actorId) || !Number.isInteger(intent.sequence) || intent.sequence < 0) throw new Error('Invalid intent actor or sequence')
    const key = `${intent.actorId}:${intent.sequence}`
    if (keys.has(key)) throw new Error('Duplicate actor intent sequence'); keys.add(key)
  }
  return [...intents].sort((a, b) => rank.get(a.actorId)! - rank.get(b.actorId)! || a.sequence - b.sequence)
}
export class V05Rounds {
  private readonly committing = new Map<number, Promise<void>>()
  constructor(private readonly engine: ExecutionEngine, private readonly context: OperationContext,
    private readonly namespace: 'v05' | 'v06' = 'v05', private readonly actorKey: (id: string) => string = id => id,
    private readonly reader = new FactReader(engine,context,namespace==='v06')) {}
  private facts() { return this.reader.read().filter(v => v.kind === `mars-${this.namespace}-round`) }
  private append(key: string, value: Json) {
    const prior = this.facts().find(v => (v.data as { key: string }).key === key)
    if (prior) { if (canonicalJson((prior.data as { value: Json }).value) !== canonicalJson(value)) throw new Error('Round key used with different input'); return }
    this.engine.recordFact(this.context, `mars-${this.namespace}-round`, { key, value })
  }
  open(round: number, tick: number, actors: string[], snapshot: Json) {
    z.number().int().nonnegative().parse(tick)
    orderRoundIntents(round, actors, [], this.actorKey)
    this.append(`open:${round}`, z.json().parse({ round, tick, actors: [...actors].sort(), snapshot }))
  }
  /** Immutable beginning-of-round query state; callers decide which public views it contains. */
  snapshot(round: number): Json {
    const opened = this.facts().find(v => (v.data as { key: string }).key === `open:${round}`)
    if (!opened) throw new Error('Round not open')
    return structuredClone((opened.data as unknown as { value: { snapshot: Json } }).value.snapshot)
  }
  response(round: number, actorId: string, response: Json) {
    const opened = this.facts().find(v => (v.data as { key: string }).key === `open:${round}`)
    if (!opened || !(opened.data as unknown as { value: { actors: string[] } }).value.actors.includes(actorId)) throw new Error('Unknown round actor')
    if (this.committed(round)) throw new Error('Round already committed')
    this.append(`response:${round}:${actorId}`, response)
  }
  ready(round: number) {
    const opened = this.facts().find(v => (v.data as { key: string }).key === `open:${round}`)
    if (!opened) return false
    return (opened.data as unknown as { value: { actors: string[] } }).value.actors.every(actor => this.facts().some(v => (v.data as { key: string }).key === `response:${round}:${actor}`))
  }
  /** Collect without awaiting application, so native tool execution cannot deadlock the boundary. */
  collect(round: number, intent: RoundIntent) {
    this.prepare(round, intent)
    return { state: 'pending' as const, round, actorId: intent.actorId, sequence: intent.sequence, requestKey: intent.requestKey, availableRound: round + 1 }
  }
  results(round: number) {
    return this.facts().filter(v => (v.data as { key: string }).key.startsWith(`applied:${round}:`)).map(v => structuredClone(v.data as unknown as { key: string; value: Json }))
  }
  prepare(round: number, intent: RoundIntent) {
    if (this.committed(round)) throw new Error('Round already committed')
    const opened = this.facts().find(v => (v.data as { key: string }).key === `open:${round}`)
    if (!opened) throw new Error('Round not open')
    const value = (opened.data as unknown as { value: { actors: string[] } }).value
    orderRoundIntents(round, value.actors, [intent], this.actorKey)
    this.append(`intent:${round}:${intent.actorId}:${intent.sequence}`, z.json().parse(intent))
  }
  intents(round: number): RoundIntent[] {
    return this.facts().filter(v => (v.data as { key: string }).key.startsWith(`intent:${round}:`)).map(v => structuredClone((v.data as unknown as { value: RoundIntent }).value))
  }
  committed(round: number) { return this.facts().some(v => (v.data as { key: string }).key === `commit:${round}`) }
  async commit(round: number, apply: (intent: RoundIntent) => Promise<Json>, requireResponses = false) {
    if (this.committed(round)) return
    if (this.committing.has(round)) return this.committing.get(round)
    const task = this.apply(round, apply, requireResponses)
    this.committing.set(round, task)
    try { await task } finally { this.committing.delete(round) }
  }
  private async apply(round: number, apply: (intent: RoundIntent) => Promise<Json>, requireResponses: boolean) {
    const opened = this.facts().find(v => (v.data as { key: string }).key === `open:${round}`)
    if (!opened) throw new Error('Round not open')
    if (requireResponses && !this.ready(round)) throw new Error('Round has pending responses')
    const actors = (opened.data as unknown as { value: { actors: string[] } }).value.actors
    for (const intent of orderRoundIntents(round, actors, this.intents(round), this.actorKey)) {
      const key = `applied:${round}:${intent.actorId}:${intent.sequence}`
      if (this.facts().some(v => (v.data as { key: string }).key === key)) continue
      // Caller supplies an idempotent requestKey to physical execution for recovery after response loss.
      const result = await apply(intent)
      this.append(key, result)
    }
    this.append(`commit:${round}`, { round })
  }
}
