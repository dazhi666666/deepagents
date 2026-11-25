/** Read-only indexed history remains separate from current physical evidence. Every query is logged with a query ID. */
import { DatabaseSync } from 'node:sqlite'
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'

const TABLES = ['sensors', 'corrections', 'maintenance', 'experiments', 'documents', 'lots', 'lot_qc', 'reference_checks', 'incidents', 'chromatograms'] as const

/** Immutable simulated historical data, identified and verified at startup. */
export class MarsArchive {
  private readonly db: DatabaseSync | undefined
  private closed = false
  private readonly queries = new Map<string, { kind: string; request: string }>()
  readonly manifest: { schemaVersion: number; source: string; seed: number; sha256: string; bytes: number; counts: Record<string, number> } | null
  constructor(directory: string, redactSeed = false) {
    const path = join(directory, 'history.sqlite')
    if (!existsSync(path)) { this.manifest = null; return }
    this.manifest = z.object({ schemaVersion: z.literal(2), source: z.literal('simulated-history'), seed: z.number(),
      sha256: z.string(), bytes: z.number(), counts: z.record(z.string(), z.number()) }).passthrough().parse(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')))
    if (redactSeed) this.manifest.seed = 0
    const hash = createHash('sha256'), handle = openSync(path, 'r'), chunk = Buffer.alloc(1 << 20)
    let bytes = 0
    try { for (let read; (read = readSync(handle, chunk, 0, chunk.length, null)) > 0;) { hash.update(chunk.subarray(0, read)); bytes += read } } finally { closeSync(handle) }
    if (bytes !== this.manifest.bytes || hash.digest('hex') !== this.manifest.sha256) throw new Error('Historical dataset integrity check failed')
    this.db = new DatabaseSync(path, { readOnly: true })
  }
  private counter = 0
  /** Continue short query numbering after a restart (the runtime passes the number of recorded queries). */
  resumeNumbering(issued: number) { this.counter = Math.max(this.counter, issued) }
  private record(kind: string, request: unknown) { const id = `q-${String(++this.counter).padStart(4, '0')}`; this.queries.set(id, { kind, request: JSON.stringify(request) }); return id }
  /** Query IDs issued in this process (persisted separately by the runtime as facts). */
  knownQueries() { return new Set(this.queries.keys()) }
  /** Search document text and versions. */
  search(query: string, offset = 0, limit = 20) {
    if (!this.db) throw new Error('Historical archive is not installed')
    z.number().int().nonnegative().parse(offset); z.number().int().min(1).max(200).parse(limit)
    const match = `%${query}%`
    const items = this.db.prepare('SELECT id,tick,entity_id,title,version,status,body FROM documents WHERE title LIKE ? OR body LIKE ? ORDER BY status,version DESC,id LIMIT ? OFFSET ?').all(match, match, limit, offset)
    return { queryId: this.record('search', { query, offset, limit }), items }
  }
  /** Query bounded historical rows by table, entity and signed logical interval. */
  query(input: unknown) {
    if (!this.db) throw new Error('Historical archive is not installed')
    const request = z.object({ kind: z.enum(TABLES), id: z.string().optional(), entityId: z.string().optional(),
      fromTick: z.number().int().max(-1).optional(), toTick: z.number().int().max(-1).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(50) }).strict().parse(input)
    const filters: string[] = [], values: (string | number)[] = []
    const idColumn = request.kind === 'corrections' ? 'record_id' : request.kind === 'lots' ? 'lot_id' : 'id'
    const hasEntity = ['sensors', 'maintenance', 'experiments', 'documents'].includes(request.kind)
    if (request.id) { filters.push(`${idColumn}=?`); values.push(request.id) }
    if (request.entityId && hasEntity) { filters.push('entity_id=?'); values.push(request.entityId) }
    if (request.fromTick !== undefined) { filters.push('tick>=?'); values.push(request.fromTick) }
    if (request.toTick !== undefined) { filters.push('tick<=?'); values.push(request.toTick) }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : ''
    const count = this.db.prepare(`SELECT COUNT(*) AS total FROM ${request.kind}${where}`).get(...values)
    const order = ['lots', 'corrections'].includes(request.kind) ? idColumn : 'tick DESC'
    const rows = this.db.prepare(`SELECT * FROM ${request.kind}${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...values, request.limit, request.offset)
    return { queryId: this.record('query', request), total: count?.total ?? 0, offset: request.offset, limit: request.limit, source: 'simulated-history', items: rows }
  }
  /** Read-only SQL over the archive; results are capped. */
  sql(statement: string, limit = 500) {
    if (!this.db) throw new Error('Historical archive is not installed')
    const text = statement.trim().replace(/;\s*$/, '')
    if (!/^(select|with)\b/i.test(text) || text.includes(';')) throw new Error('Only a single SELECT or WITH statement is allowed')
    const rows = this.db.prepare(text).all() as Record<string, unknown>[]
    return { queryId: this.record('sql', text), rowCount: rows.length, truncated: rows.length > limit, rows: rows.slice(0, limit) }
  }
  /** Uncapped read-only SQL for analysis programs. */
  sqlAll(statement: string) {
    if (!this.db) throw new Error('Historical archive is not installed')
    const text = statement.trim().replace(/;\s*$/, '')
    if (!/^(select|with)\b/i.test(text) || text.includes(';')) throw new Error('Only a single SELECT or WITH statement is allowed')
    const rows = this.db.prepare(text).all() as Record<string, unknown>[]
    if (rows.length > 2_000_000) throw new Error('Query returned more than 2,000,000 rows; aggregate in SQL first')
    return rows
  }
  /** Aggregate large sensor series server-side. */
  statistics(entityId: string, metric: string) {
    if (!this.db) throw new Error('Historical archive is not installed')
    const items = this.db.prepare('SELECT entity_id,metric,unit,COUNT(*) AS observations,SUM(value IS NULL) AS missing,MIN(value) AS minimum,MAX(value) AS maximum,AVG(value) AS average,MIN(tick) AS fromTick,MAX(tick) AS toTick FROM sensors WHERE entity_id=? AND metric=? GROUP BY unit')
      .all(entityId, metric)
    return { queryId: this.record('stats', { entityId, metric }), items }
  }
  /** Table names and columns. */
  schema() {
    if (!this.db) throw new Error('Historical archive is not installed')
    return Object.fromEntries(TABLES.map(table => [table, (this.db!.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]).map(column => `${column.name} ${column.type}`)]))
  }
  close() { if (!this.closed) { this.closed = true; this.db?.close() } }
}
