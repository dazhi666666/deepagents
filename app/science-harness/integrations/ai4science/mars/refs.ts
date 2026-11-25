/** Short, stable references for long IDs (spec v0.3 principle 4).
 * Every reference is derived from append-only arrays, so it is identical after a checkpoint restore
 * and needs no extra persistence: r-N results, s-N samples, op-N laboratory operations, so-N system
 * operations, ar-N published artifacts. Analysis runs (a-NNNN) and archive queries (q-NNNN) carry
 * short IDs natively.
 */
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from './world.ts'

export const REF_PATTERN = /^(r|s|op|so|ar)-\d+$/
/** Argument names whose values are entity IDs and may be given as short refs. */
const ID_KEY = /(^|_)(id|ids)$|Ids?$/

export class Refs {
  private cache: { key: string; long: Map<string, string>; short: Map<string, string> } | undefined
  constructor(private readonly world: Pick<MarsWorld, 'observe' | 'observeSystems'>, private readonly artifacts: () => string[] = () => []) {}
  private maps() {
    const lab = this.world.observe(), systems = this.world.observeSystems(), published = this.artifacts()
    const key = `${lab.results.length}/${lab.samples.length}/${lab.operations.length}/${systems.operations.length}/${published.length}`
    if (this.cache?.key === key) return this.cache
    const long = new Map<string, string>(), short = new Map<string, string>()
    const add = (prefix: string, ids: string[]) => ids.forEach((id, index) => { const ref = `${prefix}-${index + 1}`; long.set(ref, id); if (!short.has(id)) short.set(id, ref) })
    add('r', lab.results.map(value => value.id)); add('s', lab.samples.map(value => value.id))
    add('op', lab.operations.map(value => value.id)); add('so', systems.operations.map(value => value.id))
    add('ar', published)
    this.cache = { key, long, short }
    return this.cache
  }
  /** Full ID for a short ref; any other string is returned unchanged. */
  resolve(value: string) { return REF_PATTERN.test(value) ? this.maps().long.get(value) ?? value : value }
  shortOf(id: string) { return this.maps().short.get(id) }
  /** Replace short refs in ID-valued arguments (top level and nested objects/arrays). */
  resolveArgs<T>(args: T): T {
    const walk = (value: unknown, idValued: boolean): unknown => {
      if (typeof value === 'string') return idValued ? this.resolve(value) : value
      if (Array.isArray(value)) return value.map(item => walk(item, idValued))
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, ID_KEY.test(key))]))
      return value
    }
    return walk(args, false) as T
  }
  /** Add `<key>Ref` / `<key>Refs` (or `ref` for `id`) next to every long ID that has a short reference. */
  augment(value: Json): Json {
    const { short } = this.maps()
    const walk = (item: Json): Json => {
      if (Array.isArray(item)) return item.map(walk)
      if (!item || typeof item !== 'object') return item
      const out: Record<string, Json> = {}
      for (const [key, entry] of Object.entries(item)) {
        out[key] = walk(entry as Json)
        const name = key === 'id' ? 'ref' : `${key}Ref`
        if (typeof entry === 'string' && short.has(entry) && !(name in item)) out[name] = short.get(entry)!
        if (Array.isArray(entry) && entry.length && entry.every(element => typeof element === 'string') && entry.some(element => short.has(element as string)))
          out[`${key}Refs`] = (entry as string[]).map(element => short.get(element) ?? element)
      }
      return out
    }
    return walk(value)
  }
}
