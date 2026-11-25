/** analysis_run: model-written programs in a permission-restricted Node child process, with recorded, re-runnable inputs. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { assertIsolatedProgram } from './program-validation.ts'

const RUNNER = fileURLToPath(new URL('./analysis-runner.mjs', import.meta.url))
const ISOLATED_RUNNER = fileURLToPath(new URL('./v06/analysis-runner.mjs', import.meta.url))
const ANALYSIS_MATH = fileURLToPath(new URL('./analysis-math.mjs', import.meta.url))
const JSON_REALM = fileURLToPath(new URL('./json-realm.mjs', import.meta.url))
export interface AnalysisExecutionOptions { isolatedRealm?: boolean; maxOutputBytes?: number }
export interface AnalysisRegistryOptions extends AnalysisExecutionOptions { timeoutMs?: number }
export interface AnalysisBindings {
  readArtifact(id: string): Json
  telemetry(channels: string[], from: number, to: number): Json
  archiveSql(sql: string): Json
  /** Raw data of a laboratory result (r-N) or a chamber scan (so-N), with the facts needed to correct it. */
  readRaw(ref: string): Json
}
export interface AnalysisRecord { dataAccesses?: { kind: 'artifact' | 'raw' | 'telemetry' | 'archive'; id: string }[]; id: string; actorId: string; asOfTick: number; code: string; codeSha256: string; status: 'done' | 'error'; output: Json; logs: string[]; error: string | null; runtimeVersion?: 'mars-analysis-v06-isolated' }

/** Execute one program with a CPU-time deadline; bindings are answered by the host. */
export function execute(code: string, bindings: AnalysisBindings, timeoutMs = 30000, options: AnalysisExecutionOptions = {}): Promise<{ status: 'done' | 'error'; output: Json; logs: string[]; error: string | null }> {
  let source = code
  const prefix = 'async function __program() {\n', suffix = '\n}'
  try { const stripped = stripTypeScriptTypes(prefix + code + suffix); source = stripped.slice(prefix.length, stripped.length - suffix.length) } catch { /* plain JavaScript */ }
  if (options.isolatedRealm) {
    try { assertIsolatedProgram(source, true) }
    catch (error) { return Promise.resolve({ status: 'error', output: null, logs: [], error: error instanceof Error ? error.message : 'Isolated program refused' }) }
  }
  return new Promise(resolve => {
    const runner = options.isolatedRealm ? ISOLATED_RUNNER : RUNNER
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${runner}`, `--allow-fs-read=${ANALYSIS_MATH}`, `--allow-fs-read=${JSON_REALM}`, '--max-old-space-size=1024', '--no-warnings', runner],
      { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true })
    let buffer = '', settled = false, stderr = '', outputBytes = 0
    const maxOutputBytes = options.maxOutputBytes ?? (options.isolatedRealm ? 2 * 1024 * 1024 : Infinity)
    const finish = (value: { status: 'done' | 'error'; output: Json; logs: string[]; error: string | null }) => {
      if (settled) return
      settled = true; clearTimeout(timer); child.kill(); resolve(value)
    }
    // A program may exit (OOM, explicit process.exit, runner crash) while the
    // host is replying to a binding call. Without this guard the write raises
    // an uncaught EPIPE and takes the whole experiment process down.
    const send = (payload: unknown) => {
      if (settled || child.stdin.destroyed) return
      try { child.stdin.write(JSON.stringify(payload) + '\n') } catch { /* child already gone; exit handler settles */ }
    }
    child.stdin.on('error', () => { /* EPIPE after the child exits is expected */ })
    const timer = setTimeout(() => finish({ status: 'error', output: null, logs: [], error: `Program exceeded ${timeoutMs} ms` }), timeoutMs)
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => finish({ status: 'error', output: null, logs: [], error: error.message }))
    child.on('exit', () => finish({ status: 'error', output: null, logs: [], error: `Runner exited unexpectedly ${stderr.slice(0, 500)}` }))
    child.stdout.on('data', chunk => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > maxOutputBytes) { finish({ status: 'error', output: null, logs: [], error: 'Analysis output limit exceeded' }); return }
      buffer += String(chunk)
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let message: { type: string; id?: number; name?: string; args?: unknown[]; result?: Json; logs?: string[]; message?: string }
        try { message = JSON.parse(line) as typeof message } catch { continue }
        if (message.type === 'call') {
          let reply: { type: 'reply'; id: number; result?: Json; error?: string }
          try {
            const args = message.args ?? []
            const result = message.name === 'readArtifact' ? bindings.readArtifact(String(args[0])) :
              message.name === 'telemetry' ? bindings.telemetry((args[0] as string[]).map(String), Number(args[1]), Number(args[2])) :
              message.name === 'archiveSql' ? bindings.archiveSql(String(args[0])) :
              message.name === 'readRaw' ? bindings.readRaw(String(args[0])) : (() => { throw new Error('Unknown binding') })()
            reply = { type: 'reply', id: message.id!, result }
          } catch (error) { reply = { type: 'reply', id: message.id!, error: error instanceof Error ? error.message : String(error) } }
          send(reply)
        }
        if (message.type === 'done') finish({ status: 'done', output: message.result ?? null, logs: message.logs ?? [], error: null })
        if (message.type === 'error') finish({ status: 'error', output: null, logs: message.logs ?? [], error: message.message ?? 'error' })
      }
    })
    send({ type: 'run', code: source, timeoutMs })
  })
}

/** Persistent registry of analysis runs for evidence and reproducibility checks. */
export class AnalysisRegistry {
  /** Read-only registries inspect existing records without creating a directory or accepting new runs. */
  constructor(private readonly directory: string, private readonly readOnly = false, private readonly executionOptions: AnalysisRegistryOptions = {}) { if (!readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 }) }
  /** Short sequential run IDs (a-0001) that models can copy reliably. */
  private nextId() {
    let next = this.ids().size + 1
    while (existsSync(join(this.directory, `a-${String(next).padStart(4, '0')}.json`))) next++
    return `a-${String(next).padStart(4, '0')}`
  }
  async run(actorId: string, asOfTick: number, code: string, bindings: (asOf: number) => AnalysisBindings): Promise<AnalysisRecord> {
    if (this.readOnly) throw new Error('Read-only analysis registry cannot accept programs')
    if (Buffer.byteLength(code) > 200000) throw new Error('Program exceeds 200 kB')
    const accesses: NonNullable<AnalysisRecord['dataAccesses']> = []
    const source = bindings(asOfTick)
    const traced: AnalysisBindings = {
      readArtifact: id => { const value = source.readArtifact(id); accesses.push({ kind: 'artifact', id }); return value },
      readRaw: id => { const value = source.readRaw(id); accesses.push({ kind: 'raw', id }); return value },
      telemetry: (channels, from, to) => { const value = source.telemetry(channels, from, to); accesses.push({ kind: 'telemetry', id: JSON.stringify({ channels, from, to }) }); return value },
      archiveSql: sql => { const value = source.archiveSql(sql); accesses.push({ kind: 'archive', id: createHash('sha256').update(sql).digest('hex') }); return value },
    }
    const result = await execute(code, traced, this.executionOptions.timeoutMs ?? 30000, this.executionOptions)
    const base = { ...(this.executionOptions.isolatedRealm ? { runtimeVersion: 'mars-analysis-v06-isolated' as const } : {}), actorId, asOfTick, code, dataAccesses: accesses, codeSha256: createHash('sha256').update(code).digest('hex'), ...result }
    for (;;) {
      const record: AnalysisRecord = { id: this.nextId(), ...base }
      try { writeFileSync(join(this.directory, `${record.id}.json`), JSON.stringify(record), { mode: 0o600, flag: 'wx' }); return record }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
  }
  get(id: string): AnalysisRecord | undefined {
    if (!/^(analysis-[\w-]+|a-\d{4,})$/.test(id)) return undefined
    const path = join(this.directory, `${id}.json`)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as AnalysisRecord : undefined
  }
  ids() { return new Set((existsSync(this.directory) ? readdirSync(this.directory) : []).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))) }
  /** Re-run a recorded program at its recorded tick; true when the output contains every given value (relative 1e-6). */
  async reproduces(id: string, values: number[], bindings: (asOf: number) => AnalysisBindings) {
    const record = this.get(id)
    if (!record || record.status !== 'done') return false
    const rerun = await execute(record.code, bindings(record.asOfTick), this.executionOptions.timeoutMs ?? 30000,
      { ...this.executionOptions, isolatedRealm: record.runtimeVersion === 'mars-analysis-v06-isolated' || this.executionOptions.isolatedRealm === true })
    if (rerun.status !== 'done') return false
    const found: number[] = []
    const walk = (value: unknown) => { if (typeof value === 'number') found.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk) }
    walk(rerun.output)
    return values.some(value => found.some(candidate => Math.abs(candidate - value) <= 1e-6 * Math.max(1, Math.abs(value))))
  }
}
