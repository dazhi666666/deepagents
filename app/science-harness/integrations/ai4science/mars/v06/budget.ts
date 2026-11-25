/** Durable whole-tree monetary admission; this SQLite file lives outside world checkpoints. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { contentHash } from './contracts.ts'

const price = z.object({ provider: z.string().min(1), model: z.string().min(1),
  inputPerMillion: z.number().nonnegative(), cacheReadPerMillion: z.number().nonnegative(),
  cacheWritePerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative(),
  maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
  verified: z.boolean(), singleAttempt: z.literal(true) }).strict()
export const budgetConfigSchema = z.object({ limitUsd: z.number().positive().max(1000000), prices: z.array(price).min(1) }).strict()
  .refine(c => new Set(c.prices.map(p => `${p.provider}:${p.model}`)).size === c.prices.length, 'Duplicate price route')
export type BudgetConfig = z.infer<typeof budgetConfigSchema>
const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(), cacheWriteTokens: z.number().int().nonnegative().optional() }).passthrough()
const requestSchema = z.object({ id: z.string(), actor: z.string(), provider: z.string(), model: z.string(), max_output: z.number(),
  reserved: z.number(), state: z.enum(['reserved', 'dispatched', 'settled', 'uncertain', 'released']),
  cost: z.number().nullable(), usage: z.string().nullable(), bounds_invalid: z.number() })
export class BudgetExhausted extends Error {}
const micros = (amount: number) => { const n = Math.ceil(amount); if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid monetary amount'); return n }
const limitMicros = (amount: number) => Math.floor(amount * 1000000)
export class V06Budget {
  private readonly db: DatabaseSync
  private closed = false
  readonly config: BudgetConfig
  constructor(readonly path: string, input: BudgetConfig, private readonly readOnly = false) {
    this.config = budgetConfigSchema.parse(input); if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path, { readOnly })
    try {
      if (!readOnly) this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,actor TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,max_output INTEGER NOT NULL,
          reserved INTEGER NOT NULL,state TEXT NOT NULL,cost INTEGER,usage TEXT,bounds_invalid INTEGER NOT NULL DEFAULT 0);`)
      const hash = contentHash(this.config), previous = this.db.prepare('SELECT hash FROM config WHERE id=1').get()
      if (previous && previous.hash !== hash) throw new Error('Budget or frozen prices differ from durable ledger')
      if (!previous) {
        if (readOnly) throw new Error('Read-only budget ledger has no frozen price identity')
        this.db.prepare('INSERT INTO config VALUES(1,?)').run(hash)
      }
    } catch (error) { this.db.close(); throw error }
  }
  private transaction<T>(body: () => T): T {
    if (this.readOnly) throw new Error('Read-only budget ledger cannot mutate requests')
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = body(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private route(provider: string, model: string) {
    const p = this.config.prices.find(p => p.provider === provider && p.model === model)
    if (!p || !p.verified) throw new Error('Route has no verified frozen price and input/output bounds')
    return p
  }
  private rows() { return this.db.prepare('SELECT * FROM requests ORDER BY rowid').all().map(r => requestSchema.parse(r)) }
  reserve(id: string, actor: string, provider: string, model: string, maxOutput: number) {
    const p = this.route(provider, model)
    if (!Number.isSafeInteger(maxOutput) || maxOutput < 1 || maxOutput > p.maxOutputTokens) throw new Error('Requested output exceeds frozen price bounds')
    const reserved = micros(p.maxInputTokens * Math.max(p.inputPerMillion, p.cacheReadPerMillion, p.cacheWritePerMillion) + maxOutput * p.outputPerMillion)
    return this.transaction(() => {
      const rows = this.rows(), existing = rows.find(r => r.id === id)
      if (existing) {
        if (existing.actor !== actor || existing.provider !== provider || existing.model !== model || existing.max_output !== maxOutput) throw new Error('Budget request identity changed')
        return existing
      }
      const committed = rows.reduce((n, r) => n + (r.state === 'settled' ? r.cost! : ['reserved', 'dispatched', 'uncertain'].includes(r.state) ? r.reserved : 0), 0)
      if (committed + reserved > limitMicros(this.config.limitUsd)) throw new BudgetExhausted('Whole-tree monetary budget cannot reserve this request')
      this.db.prepare('INSERT INTO requests(id,actor,provider,model,max_output,reserved,state) VALUES(?,?,?,?,?,?,?)').run(id, actor, provider, model, maxOutput, reserved, 'reserved')
      return this.rows().find(r => r.id === id)!
    })
  }
  dispatched(id: string) {
    this.transaction(() => {
      const request = this.rows().find(r => r.id === id)
      if (!request || !['reserved', 'dispatched'].includes(request.state)) throw new Error('Request was not reserved for dispatch')
      this.db.prepare("UPDATE requests SET state='dispatched' WHERE id=?").run(id)
    })
  }
  /** Only pre-dispatch cancellation releases the reservation. Unknown billed outcomes retain it. */
  release(id: string) {
    this.transaction(() => {
      const request = this.rows().find(r => r.id === id)
      if (!request || request.state !== 'reserved') throw new Error('Cannot refund a possibly dispatched request')
      this.db.prepare("UPDATE requests SET state='released' WHERE id=?").run(id)
    })
  }
  settle(id: string, input: unknown | null) {
    this.transaction(() => {
      const request = this.rows().find(r => r.id === id)
      if (!request || request.state === 'reserved' || request.state === 'released') throw new Error('Unknown dispatch for settlement')
      if (input === null) {
        if (request.state !== 'settled') this.db.prepare("UPDATE requests SET state='uncertain' WHERE id=?").run(id)
        return
      }
      const usage = usageSchema.parse(input), p = this.route(request.provider, request.model), encoded = JSON.stringify(usage)
      if (request.state === 'settled') { if (request.usage !== encoded) throw new Error('Authoritative settled usage changed'); return }
      // These counts are disjoint in Harness. Reasoning is already included in outputTokens.
      const cost = micros(usage.inputTokens * p.inputPerMillion + (usage.cacheReadTokens ?? 0) * p.cacheReadPerMillion +
        (usage.cacheWriteTokens ?? 0) * p.cacheWritePerMillion + usage.outputTokens * p.outputPerMillion)
      const invalid = cost > request.reserved || usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > p.maxInputTokens || usage.outputTokens > request.max_output
      this.db.prepare("UPDATE requests SET state='settled',cost=?,usage=?,bounds_invalid=? WHERE id=?").run(cost, encoded, Number(invalid), id)
    })
  }
  report() {
    const rows = this.rows(), actual = rows.reduce((n, r) => n + (r.cost ?? 0), 0), held = rows.reduce((n, r) => n + (['reserved', 'dispatched', 'uncertain'].includes(r.state) ? r.reserved : 0), 0)
    return { limitUsd: this.config.limitUsd, actualUsd: actual / 1000000, reservedUsd: held / 1000000,
      availableUsd: (limitMicros(this.config.limitUsd) - actual - held) / 1000000,
      priceHash: contentHash(this.config), requests: rows.length, uncertain: rows.filter(r => ['dispatched', 'uncertain'].includes(r.state)).length,
      costStatus: !this.config.prices.every(p => p.verified) ? 'cost-unverified' : rows.some(r => r.bounds_invalid) ? 'invalid_bounds' : rows.some(r => ['dispatched', 'uncertain'].includes(r.state)) ? 'uncertain' : 'verified',
      byRequest: rows.map(r => ({ id: r.id, actor: r.actor, provider: r.provider, model: r.model, state: r.state, actualUsd: r.cost === null ? null : r.cost / 1000000, reservedUsd: r.reserved / 1000000 })) }
  }
  close() { if (!this.closed) { this.closed = true; this.db.close() } }
}

/** Wait only for requests live in this runtime; recovered or uncertain holds never become free credit. */
export class MonetaryAdmissions {
  private readonly active = new Set<string>()
  private readonly waiters = new Set<() => void>()
  private closed = false
  constructor(private readonly ledger: V06Budget) {}
  async reserve(id: string, actor: string, provider: string, model: string, maxOutput: number, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted()
      if (this.closed) throw new Error('Monetary admission closed')
      try {
        const reservation = this.ledger.reserve(id, actor, provider, model, maxOutput)
        this.active.add(id)
        return reservation
      } catch (error) {
        if (!(error instanceof BudgetExhausted) || this.active.size === 0) throw error
        await new Promise<void>((resolve, reject) => {
          const clear = () => { this.waiters.delete(wake); signal.removeEventListener('abort', abort) }
          const wake = () => { clear(); resolve() }
          const abort = () => { clear(); reject(signal.reason) }
          this.waiters.add(wake); signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      }
    }
  }
  complete(id: string) { this.active.delete(id); for (const wake of [...this.waiters]) wake() }
  close() { this.closed = true; for (const wake of [...this.waiters]) wake() }
}
