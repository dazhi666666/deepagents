/** Long computation reference provider: restartable hash-chain chunks, independent of Agent organization. */
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { CancellationResponse, Json, ExecutionProvider, ProviderObservation } from '../sdk.ts'
import {
  openJournal,
  claimControlDomain,
  stableIdentity,
  checkIdentity,
  publishAtomic,
  terminalState,
} from './journal.ts'

type Row = {
  id: string
  identity: string
  directory: string
  total: number
  done: number
  digest: string
  state: 'running' | 'succeeded' | 'cancelled'
  cancel: number
  next_at: number
}

/** Construct the reference worker using the public provider API and its independent journal. */
export function createProvider(input: Json): ExecutionProvider {
  const c = input as {
    id: string
    directory: string
    resource: string
    tickMs: number
    chunkSize: number
  }
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== 'chunkSize,directory,id,resource,tickMs' ||
    typeof c.id !== 'string' ||
    !/^[\w.-]+$/.test(c.id) ||
    typeof c.directory !== 'string' ||
    !c.directory ||
    typeof c.resource !== 'string' ||
    !c.resource ||
    !Number.isFinite(c.tickMs) ||
    c.tickMs < 1 ||
    !Number.isSafeInteger(c.chunkSize) ||
    c.chunkSize < 1 ||
    c.chunkSize > 10000
  )
    throw new Error('Invalid computation provider configuration')
  const directory = resolve(c.directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const journal = {
    path: join(directory, 'compute.sqlite'),
    schema:
      'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,identity TEXT NOT NULL,directory TEXT NOT NULL,total INTEGER NOT NULL,done INTEGER NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,cancel INTEGER NOT NULL,next_at REAL NOT NULL); CREATE TABLE IF NOT EXISTS chunks(operation_id TEXT NOT NULL, end_iteration INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(operation_id,end_iteration));',
    configuration: input,
    versionError: 'Unsupported computation journal version',
    configurationError: 'Compute configuration changed; use a new journal',
  }
  const parse = (v: Json) => {
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      Object.keys(v).sort().join() !== 'iterations,text' ||
      typeof v.text !== 'string' ||
      v.text.length > 65536 ||
      typeof v.iterations !== 'number' ||
      !Number.isSafeInteger(v.iterations) ||
      v.iterations < 1 ||
      v.iterations > 10000000
    )
      throw new Error('Expected text <=65536 characters and iterations 1..10000000')
    return { text: v.text, iterations: v.iterations }
  }
  const observe = (r: Row): ProviderObservation => {
    const terminal = terminalState(r.state)
    if (terminal)
      publishAtomic(r.directory, {
        'digest.json':
          JSON.stringify(
            {
              algorithm: 'sha256-chain',
              operationId: r.id,
              iterations: r.done,
              requestedIterations: r.total,
              digest: r.digest,
              complete: r.state === 'succeeded',
            },
            null,
            2,
          ) + '\n',
      })
    return {
      state: r.state,
      progress: { iterations: r.done, total: r.total },
      ...(terminal ? { artifacts: [{ path: 'digest.json', mediaType: 'application/json' }] } : {}),
    }
  }
  return {
    describe: () => ({
      apiVersion: 1,
      id: c.id,
      version: '0.1.0',
      configuration: input,
      inputSchema: {
        type: 'object',
        required: ['text', 'iterations'],
        additionalProperties: false,
        properties: {
          text: { type: 'string', maxLength: 65536 },
          iterations: { type: 'integer', minimum: 1, maximum: 10000000 },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          digest: { type: 'string' },
          iterations: { type: 'integer' },
          complete: { type: 'boolean' },
        },
      },
      units: { budget: 'iteration' },
      constraints: [
        `Exclusive resource ${c.resource}`,
        'Device journal is permanently bound to the real parent of the first submitted operation artifact directory; another management domain is refused even while idle',
        `At most ${c.chunkSize} iterations per query after tickMs`,
        'Cooperative local execution: query performs a real CPU chunk and atomically checkpoints it; while controller is absent the job pauses',
      ],
      completion: 'All iterations durably checkpointed and digest.json published; no model judgement.',
      cancellation:
        'A request sets a device flag. Next query preserves the last committed partial digest and reports cancelled. Completed chunks remain budget charged.',
    }),
    prepare(input) {
      const v = parse(input)
      return { input: v, resources: [c.resource], budget: v.iterations }
    },
    async submit(op) {
      const v = parse(op.input)
      return openJournal(journal, op, (db) => {
        db.exec('BEGIN IMMEDIATE')
        claimControlDomain(db, op, () =>
          db.prepare('SELECT DISTINCT directory FROM jobs').all() as { directory: string }[],
        )
        let r = db.prepare('SELECT * FROM jobs WHERE id=?').get(op.operationId) as Row | undefined
        if (r) checkIdentity(r, op, 'Stable job ID changed its input or artifact destination')
        else {
          if (db.prepare("SELECT id FROM jobs WHERE state='running'").get())
            throw new Error('Compute worker independently rejects conflicting job')
          db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)').run(
            op.operationId,
            stableIdentity(op),
            realpathSync(op.artifactDirectory),
            v.iterations,
            0,
            v.text,
            'running',
            0,
            Date.now() + c.tickMs,
          )
          db.prepare('INSERT INTO starts VALUES (?)').run(op.operationId)
          r = db.prepare('SELECT * FROM jobs WHERE id=?').get(op.operationId) as Row
        }
        db.exec('COMMIT')
        return observe(r)
      })
    },
    async query(op) {
      return openJournal<ProviderObservation>(journal, op, (db) => {
        db.exec('BEGIN IMMEDIATE')
        const r = db.prepare('SELECT * FROM jobs WHERE id=?').get(op.operationId) as Row | undefined
        if (!r) {
          db.exec('COMMIT')
          return { state: 'not_found', detail: 'No stable job in independent worker journal' }
        }
        checkIdentity(r, op, 'Stable job ID changed its input or artifact destination')
        if (r.state === 'running') {
          if (r.cancel) r.state = 'cancelled'
          else if (Date.now() >= r.next_at) {
            const end = Math.min(r.total, r.done + c.chunkSize)
            for (; r.done < end; r.done++) r.digest = createHash('sha256').update(r.digest).digest('hex')
            db.prepare('INSERT INTO chunks VALUES (?,?,?)').run(r.id, r.done, r.digest)
            if (r.done === r.total) r.state = 'succeeded'
            r.next_at = Date.now() + c.tickMs
          }
          db.prepare('UPDATE jobs SET done=?,digest=?,state=?,next_at=? WHERE id=?').run(
            r.done,
            r.digest,
            r.state,
            r.next_at,
            r.id,
          )
        }
        db.exec('COMMIT')
        return observe(r)
      })
    },
    async cancel(op) {
      return openJournal<CancellationResponse>(journal, op, (db) => {
        const r = db.prepare('SELECT * FROM jobs WHERE id=?').get(op.operationId) as Row | undefined
        if (!r) return { disposition: 'rejected', detail: 'Unknown job' }
        checkIdentity(r, op, 'Stable job ID changed its input or artifact destination')
        if (r.state !== 'running')
          return { disposition: 'rejected', observation: observe(r), detail: 'Job already terminal' }
        db.prepare('UPDATE jobs SET cancel=1 WHERE id=?').run(r.id)
        return {
          disposition: 'requested',
          detail: 'Cancellation finishes at next query without executing another chunk',
        }
      })
    },
  }
}
