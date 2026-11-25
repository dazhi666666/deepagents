/** Offline frozen-model execution. The model sees only explicitly supplied inputs and parameters. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { canonicalJson, type Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { modelArtifactSchema, modelInputSchema, type ModelArtifact } from './predictions.ts'
import { assertIsolatedProgram } from '../program-validation.ts'

const runner = fileURLToPath(new URL('./model-runner.mjs', import.meta.url))
const jsonRealm = fileURLToPath(new URL('../json-realm.mjs', import.meta.url))
const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex')
/** Resource bounds shared by model registration and the isolated runner. */
export const FROZEN_MODEL_LIMITS = Object.freeze({ codeBytes: 200000, parameterBytes: 1024 * 1024, inputBytes: 1024 * 1024 })
/** An optional signal cancels the child; omitted retains the configured per-run timeout. */
export interface FrozenModelOptions { timeoutMs?: number; memoryMb?: number; maxOutputBytes?: number; freshContext?: boolean; signal?: AbortSignal }
export interface FrozenModelResult { status: 'done' | 'error'; modelHash: string; inputHash: string; outputs: Json[]; error: string | null; elapsedMs: number }
const optionsSchema = z.object({ timeoutMs: z.number().int().min(25).max(60000).default(5000),
  freshContext: z.boolean().default(false), memoryMb: z.number().int().min(64).max(512).default(128), maxOutputBytes: z.number().int().min(128).max(16 * 1024 * 1024).default(1024 * 1024) }).strict()

const SCHEMA_KEYS = new Set(['$schema', '$id', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const'])
const SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'])

/** Validate every schema branch before registration, including optional fields absent from test inputs. */
export function assertModelSchema(schema: Json, path = '$', depth = 0): void {
  if (depth > 64) throw new Error(`Schema nesting exceeds limit at ${path}`)
  if (typeof schema === 'boolean') return
  if (!schema || Array.isArray(schema) || typeof schema !== 'object') throw new Error(`Schema must be an object or boolean at ${path}`)
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) throw new Error(`Unsupported schema keyword: ${path}.${key}`)
  for (const key of ['$schema', '$id', 'title', 'description'])
    if (schema[key] !== undefined && typeof schema[key] !== 'string') throw new Error(`Schema ${path}.${key} must be a string`)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.length || types.some(type => typeof type !== 'string' || !SCHEMA_TYPES.has(type))) throw new Error(`Invalid schema type at ${path}`)
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string')
    || new Set(schema.required).size !== schema.required.length)) throw new Error(`Schema required must contain unique strings at ${path}`)
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || new Set(schema.enum.map(value => canonicalJson(value))).size !== schema.enum.length))
    throw new Error(`Schema enum must contain unique JSON values at ${path}`)
  for (const [minKey, maxKey, count] of [['minimum', 'maximum', false], ['minItems', 'maxItems', true], ['minLength', 'maxLength', true]] as const) {
    for (const key of [minKey, maxKey]) {
      const value = schema[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || count && (!Number.isSafeInteger(value) || value < 0)))
        throw new Error(`Invalid schema bound: ${path}.${key}`)
    }
    if (typeof schema[minKey] === 'number' && typeof schema[maxKey] === 'number' && schema[minKey] > schema[maxKey]) throw new Error(`Schema minimum exceeds maximum at ${path}`)
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || Array.isArray(schema.properties) || typeof schema.properties !== 'object') throw new Error(`Schema properties must be an object at ${path}`)
    for (const [key, value] of Object.entries(schema.properties)) assertModelSchema(value, `${path}.properties.${key}`, depth + 1)
  }
  for (const key of ['items', 'additionalProperties']) if (schema[key] !== undefined) assertModelSchema(schema[key], `${path}.${key}`, depth + 1)
}

/** Small, explicit JSON Schema subset. Unsupported assertions fail closed, rather than silently passing. */
export function validateModelValue(schema: Json, value: Json, path = '$', depth = 0): void {
  if (depth > 64) throw new Error('Schema nesting exceeds limit')
  if (schema === true) return
  if (schema === false) throw new Error(`Schema rejects ${path}`)
  if (!schema || Array.isArray(schema) || typeof schema !== 'object') throw new Error('Schema must be an object or boolean')
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) throw new Error(`Unsupported schema keyword: ${key}`)
  const matches = (type: Json): boolean => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) :
    type === 'object' ? value !== null && !Array.isArray(value) && typeof value === 'object' :
      type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) : typeof value === type
  if (schema.type !== undefined) {
    const requested = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!requested.length || requested.some(type => typeof type !== 'string' || !SCHEMA_TYPES.has(type))) throw new Error('Invalid schema type')
    if (!requested.some(matches)) throw new Error(`Type mismatch at ${path}`)
  }
  if ('const' in schema && canonicalJson(schema.const!) !== canonicalJson(value)) throw new Error(`Const mismatch at ${path}`)
  if ('enum' in schema && (!Array.isArray(schema.enum) || !schema.enum.some(item => canonicalJson(item) === canonicalJson(value)))) throw new Error(`Enum mismatch at ${path}`)
  const bound = (key: string): number | undefined => {
    const number = schema[key]
    if (number === undefined) return undefined
    if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error(`Invalid schema ${key}`)
    return number
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite model number')
    if (bound('minimum') !== undefined && value < bound('minimum')!) throw new Error(`Below minimum at ${path}`)
    if (bound('maximum') !== undefined && value > bound('maximum')!) throw new Error(`Above maximum at ${path}`)
  }
  if (typeof value === 'string' || Array.isArray(value)) {
    const minimum = bound(typeof value === 'string' ? 'minLength' : 'minItems'), maximum = bound(typeof value === 'string' ? 'maxLength' : 'maxItems')
    if (minimum !== undefined && value.length < minimum || maximum !== undefined && value.length > maximum) throw new Error(`Length mismatch at ${path}`)
  }
  if (Array.isArray(value) && schema.items !== undefined) value.forEach((item, index) => validateModelValue(schema.items!, item, `${path}[${index}]`, depth + 1))
  if (value && !Array.isArray(value) && typeof value === 'object') {
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(value, key)))) throw new Error(`Required property missing at ${path}`)
    const properties = schema.properties ?? {}
    if (!properties || Array.isArray(properties) || typeof properties !== 'object') throw new Error('Invalid schema properties')
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateModelValue(properties[key]!, item, `${path}.${key}`, depth + 1)
      else if (schema.additionalProperties === false) throw new Error(`Unexpected property ${path}.${key}`)
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) validateModelValue(schema.additionalProperties, item, `${path}.${key}`, depth + 1)
    }
  }
}

export async function runFrozenModel(artifact: ModelArtifact, inputs: Json[], options: FrozenModelOptions = {}): Promise<FrozenModelResult> {
  const started = Date.now()
  let modelHash = '', inputHash = ''
  const finish = (status: 'done' | 'error', outputs: Json[], error: string | null): FrozenModelResult => ({ status, modelHash, inputHash, outputs, error, elapsedMs: Date.now() - started })
  try {
    const { signal, ...settings } = options
    if (signal?.aborted) throw new Error('Frozen model cancelled')
    const model = modelArtifactSchema.parse(artifact), parsedInputs = z.array(z.json()).min(1).max(10000).parse(inputs), config = optionsSchema.parse(settings)
    modelHash = model.hash; inputHash = digest(parsedInputs)
    if (digest(modelInputSchema.parse({ id: model.id, code: model.code, parameters: model.parameters, inputSchema: model.inputSchema,
      outputSchema: model.outputSchema, runtimeVersion: model.runtimeVersion, basedOn: model.basedOn })) !== model.hash) throw new Error('Frozen model hash mismatch')
    if (!['mars-analysis-v1', 'mars-model-v1'].includes(model.runtimeVersion)) throw new Error('Unsupported model runtime')
    if (Buffer.byteLength(model.code) > FROZEN_MODEL_LIMITS.codeBytes) throw new Error('Model code exceeds 200 kB')
    if (Buffer.byteLength(JSON.stringify(model.parameters)) > FROZEN_MODEL_LIMITS.parameterBytes) throw new Error('Model parameter limit exceeded')
    if (Buffer.byteLength(JSON.stringify(parsedInputs)) > FROZEN_MODEL_LIMITS.inputBytes) throw new Error('Model input limit exceeded')
    if (config.freshContext) assertIsolatedProgram(model.code, false)
    for (const input of parsedInputs) validateModelValue(model.inputSchema, input)
    const result = await new Promise<{ status: 'done' | 'error'; outputs: Json[]; error: string | null }>(resolve => {
      const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${runner}`, `--allow-fs-read=${jsonRealm}`, `--max-old-space-size=${config.memoryMb}`, '--no-warnings', runner],
        { stdio: ['pipe', 'pipe', 'pipe'], env: {}, windowsHide: true })
      let settled = false, output = '', stderr = ''
      const done = (status: 'done' | 'error', outputs: Json[], error: string | null) => {
        if (settled) return
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); child.kill(); resolve({ status, outputs, error })
      }
      const cancel = () => done('error', [], 'Frozen model cancelled')
      const timer = setTimeout(() => done('error', [], 'Frozen model exceeded time limit'), config.timeoutMs)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      child.stdin.on('error', () => {})
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000) })
      child.stdout.on('data', chunk => {
        output += String(chunk)
        if (Buffer.byteLength(output) > config.maxOutputBytes + 4096) { done('error', [], 'Model output limit exceeded'); return }
        if (!output.includes('\n')) return
        try {
          const message = z.object({ status: z.enum(['done', 'error']), outputs: z.array(z.json()), error: z.string().nullable() }).strict().parse(JSON.parse(output.trim()))
          if (message.status === 'done') {
            if (message.outputs.length !== parsedInputs.length) throw new Error('Model output count mismatch')
            for (const value of message.outputs) validateModelValue(model.outputSchema, value)
          }
          done(message.status, message.outputs, message.error)
        } catch (error) { done('error', [], error instanceof Error ? error.message : 'Invalid model output') }
      })
      child.on('error', error => done('error', [], error.message))
      child.on('exit', () => done('error', [], `Frozen model exited without a result${stderr ? `: ${stderr}` : ''}`))
      child.stdin.end(JSON.stringify({ code: model.code, parameters: model.parameters, inputs: parsedInputs,
        freshContext: config.freshContext, maxOutputBytes: config.maxOutputBytes, syncTimeoutMs: Math.min(config.timeoutMs, 1000) }) + '\n')
    })
    return finish(result.status, result.outputs, result.error)
  } catch (error) { return finish('error', [], error instanceof Error ? error.message : 'Frozen model execution failed') }
}
