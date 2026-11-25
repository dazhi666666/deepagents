/** Finite model DAGs map JSON fields only; no shell, evaluator objects or orchestration API is available. */
import { z } from 'zod'
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { contentHash, identifier, digestSchema } from './contracts.ts'
import type { ModelArtifact } from './records.ts'

const path = z.string().regex(/^\$(case|node\.[A-Za-z0-9_-]+)(\.[A-Za-z0-9_-]+)*$/)
export const pipelineInputSchema = z.object({ pipelineId: identifier, nodes: z.array(z.object({ id: identifier,
  modelId: identifier, bindings: z.record(identifier, path) }).strict()).min(1).max(16), outputs: z.record(identifier, path),
  inputSchema: z.json(), outputSchema: z.json(),
  inputUnits: z.record(z.string(), z.string()).default({}), outputUnits: z.record(z.string(), z.string()).default({}) }).strict()
export const pipelineSchema = pipelineInputSchema.extend({ hash: digestSchema, modelHashes: z.record(identifier, digestSchema),
  acceptedTick: z.number().int().nonnegative(), acceptedSeq: z.number().int().positive(), actorId: identifier }).strict()
export type Pipeline = z.infer<typeof pipelineSchema>
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
function parts(reference: string) {
  const segments = path.parse(reference).slice(1).split('.')
  if (segments.some(s => forbidden.has(s))) throw new Error('Unsafe field path')
  return segments
}
/** Read only explicitly present JSON properties. */
export function bindValue(reference: string, input: Json, outputs: Record<string, Json>): Json {
  const segments = parts(reference)
  let current: Json = segments.shift() === 'case' ? input : outputs[segments.shift()!]!
  for (const part of segments) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) throw new Error(`Binding source missing: ${reference}`)
    current = Array.isArray(current) ? current[Number(part)]! : current[part]!
  }
  if (current === undefined) throw new Error('Binding source missing')
  return structuredClone(current)
}
function fieldSchema(schema: Json, fields: string[]): Json {
  let current = schema
  for (const field of fields) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) throw new Error('Binding needs a declared object field')
    const properties = current.properties
    if (!properties || typeof properties !== 'object' || Array.isArray(properties) || !Object.hasOwn(properties, field)) throw new Error(`Undeclared binding field: ${field}`)
    current = properties[field]!
  }
  return current
}
function typeOf(schema: Json): Json | undefined { return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema.type : undefined }
/** Reject cycles, undeclared fields, incompatible declared types/units and mutable model references. */
export function validatePipeline(input: unknown, models: ModelArtifact[]) {
  const request = pipelineInputSchema.parse(input), nodes = new Map(request.nodes.map(n => [n.id, n]))
  if (nodes.size !== request.nodes.length) throw new Error('Duplicate pipeline node')
  const order: string[] = [], active = new Set<string>(), visited = new Set<string>()
  const modelById = new Map(models.map(m => [m.id, m]))
  const source = (reference: string) => {
    const p = parts(reference), kind = p.shift()
    if (kind === 'case') return { schema: fieldSchema(request.inputSchema, p), unit: request.inputUnits[p.join('.')] }
    const id = p.shift()!, node = nodes.get(id), model = node ? modelById.get(node.modelId) : undefined
    if (!model) throw new Error('Unknown pipeline source node/model')
    return { schema: fieldSchema(model.outputSchema, p), unit: model.units?.output[p.join('.')] }
  }
  const visit = (id: string) => {
    if (active.has(id)) throw new Error('Model pipeline cycle')
    if (visited.has(id)) return
    const node = nodes.get(id), model = node ? modelById.get(node.modelId) : undefined
    if (!node || !model) throw new Error('Unknown pipeline model')
    active.add(id)
    for (const [field, reference] of Object.entries(node.bindings)) {
      const p = parts(reference)
      if (p[0] === 'node') visit(p[1]!)
      const actual = source(reference), expected = fieldSchema(model.inputSchema, [field]), actualType = typeOf(actual.schema), expectedType = typeOf(expected)
      if (actualType !== undefined && expectedType !== undefined && contentHash(actualType) !== contentHash(expectedType)) throw new Error('Pipeline binding type mismatch')
      const unit = model.units?.input[field]
      if ((actual.unit !== undefined || unit !== undefined) && actual.unit !== unit) throw new Error('Pipeline binding unit mismatch')
    }
    if (model.inputSchema && typeof model.inputSchema === 'object' && !Array.isArray(model.inputSchema) && Array.isArray(model.inputSchema.required))
      for (const required of model.inputSchema.required) if (typeof required !== 'string' || !Object.hasOwn(node.bindings, required)) throw new Error('Required pipeline input is unbound')
    active.delete(id); visited.add(id); order.push(id)
  }
  for (const node of request.nodes) visit(node.id)
  for (const [field, reference] of Object.entries(request.outputs)) {
    const actual = source(reference), expected = fieldSchema(request.outputSchema, [field])
    if (typeOf(actual.schema) !== undefined && typeOf(expected) !== undefined && contentHash(typeOf(actual.schema)) !== contentHash(typeOf(expected))) throw new Error('Pipeline output type mismatch')
    if ((actual.unit !== undefined || request.outputUnits[field] !== undefined) && actual.unit !== request.outputUnits[field]) throw new Error('Pipeline output unit mismatch')
  }
  return { request, order, modelHashes: Object.fromEntries(request.nodes.map(n => [n.modelId, modelById.get(n.modelId)!.hash])) }
}
