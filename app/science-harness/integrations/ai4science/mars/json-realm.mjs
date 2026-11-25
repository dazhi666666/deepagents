/** VM-local JSON copying and captured intrinsics; exports source text, never Host functions. */
export const JSON_REALM_BOOTSTRAP = `
  const __parse = JSON.parse, __encode = JSON.stringify, __keys = Reflect.ownKeys;
  const __descriptor = Object.getOwnPropertyDescriptor, __create = Object.create;
  const __setPrototype = Object.setPrototypeOf, __getPrototype = Object.getPrototypeOf;
  const __array = Array.isArray, __finite = Number.isFinite, __integer = Number.isSafeInteger;
  const __number = Number, __string = String, __Error = Error;
  const __objectPrototype = Object.prototype, __arrayPrototype = Array.prototype;
  const __own = Function.call.bind(Object.prototype.hasOwnProperty);
  globalThis.process = undefined; globalThis.require = undefined; globalThis.fetch = undefined;
  globalThis.WebSocket = undefined; globalThis.console = undefined; globalThis.Date = undefined;
  globalThis.Intl = undefined; globalThis.Temporal = undefined; globalThis.performance = undefined;
  globalThis.SharedArrayBuffer = undefined; globalThis.Atomics = undefined;
  Math.random = () => { throw new __Error('Randomness unavailable in frozen models') };
  const __copy = (value, depth = 0) => {
    if (depth > 64) throw new __Error('JSON nesting exceeds limit');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && __finite(value)) return value;
    if (typeof value !== 'object') throw new __Error('Finite JSON required');
    const array = __array(value), prototype = __getPrototype(value);
    if (prototype !== null && prototype !== (array ? __arrayPrototype : __objectPrototype)) throw new __Error('Plain JSON required');
    const copy = array ? [] : __create(null);
    if (array) __setPrototype(copy, null);
    const length = array ? __descriptor(value, 'length').value : 0;
    for (const key of __keys(value)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new __Error('JSON string keys required');
      if (array && (!__integer(__number(key)) || __number(key) < 0 || __number(key) >= length || __string(__number(key)) !== key)) throw new __Error('Plain JSON array required');
      const property = __descriptor(value, key);
      if (!property || !__own(property, 'value') || !property.enumerable) throw new __Error('JSON data properties required');
      copy[key] = __copy(property.value, depth + 1);
    }
    if (array) for (let i = 0; i < length; i++) if (!__own(copy, __string(i))) throw new __Error('Sparse JSON array');
    return copy;
  };
`
