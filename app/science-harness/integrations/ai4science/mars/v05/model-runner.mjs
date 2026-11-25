// Private evaluator worker. No evaluator filesystem/data binding is available to model programs.
import { createInterface } from 'node:readline'
import { compileFunction, createContext, Script } from 'node:vm'
import { JSON_REALM_BOOTSTRAP } from '../json-realm.mjs'

const lines = createInterface({ input: process.stdin })
let started = false
const send = value => process.stdout.write(JSON.stringify(value) + '\n')

// v0.6 crosses realms using primitive strings only. In particular, Host await/Promise callbacks
// never enter the model realm, and a model body is parsed by compileFunction, not source interpolation.
const initializeFresh = new Script(`
  ${JSON_REALM_BOOTSTRAP}
  const __data = __parse(__payload); delete globalThis.__payload;
  const __run = () => {
    try {
      const output = __model(__data.input, __data.parameters);
      return '{"status":"done","output":' + __encode(__copy(output)) + '}';
    } catch { return '{"status":"error","error":"Frozen synchronous model failed"}'; }
  };
`)
const evaluateFresh = new Script('__run()')

lines.on('line', async line => {
  if (started) return
  started = true
  try {
    const message = JSON.parse(line)
    if (message.freshContext) {
      const outputs = []
      for (const input of message.inputs) {
        const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
        context.__payload = JSON.stringify({ input, parameters: message.parameters })
        initializeFresh.runInContext(context, { timeout: message.syncTimeoutMs })
        context.__model = compileFunction('"use strict";\n' + message.code, ['input', 'parameters'], { parsingContext: context })
        const serialized = evaluateFresh.runInContext(context, { timeout: message.syncTimeoutMs })
        if (typeof serialized !== 'string') throw new Error('Invalid primitive model result')
        const result = JSON.parse(serialized)
        if (result.status !== 'done') throw new Error('Frozen synchronous model failed')
        outputs.push(result.output)
        if (Buffer.byteLength(JSON.stringify(outputs)) > message.maxOutputBytes) throw new Error('Model output limit exceeded')
      }
      send({ status: 'done', outputs, error: null })
      process.exit(0)
      return
    }
    // Historical v0.5 semantics remain unchanged.
    const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
    context.__payload = JSON.stringify({ inputs: message.inputs, parameters: message.parameters })
    new Script(`
      globalThis.process = undefined; globalThis.require = undefined; globalThis.fetch = undefined;
      globalThis.WebSocket = undefined; globalThis.console = undefined; globalThis.Date = undefined;
      Math.random = () => { throw new Error('Randomness unavailable in frozen models') };
      globalThis.__model = async function(input, parameters) { "use strict";\n${message.code}\n};
      globalThis.__data = JSON.parse(__payload); delete globalThis.__payload;
    `).runInContext(context, { timeout: message.syncTimeoutMs })
    const outputs = []
    for (let index = 0; index < message.inputs.length; index++) {
      context.__index = index
      const value = await new Script('__model(JSON.parse(JSON.stringify(__data.inputs[__index])), JSON.parse(JSON.stringify(__data.parameters)))')
        .runInContext(context, { timeout: message.syncTimeoutMs })
      context.__value = value
      const serialized = new Script(`(() => {
        const seen = new Set();
        function check(value, depth = 0) {
          if (depth > 64) throw new Error('Model output nesting exceeds limit');
          if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
          if (typeof value === 'number' && Number.isFinite(value)) return;
          if (typeof value !== 'object') throw new Error('Model must return finite JSON values');
          if (seen.has(value)) throw new Error('Cyclic model output');
          seen.add(value);
          for (const item of Object.values(value)) check(item, depth + 1);
          seen.delete(value);
        }
        check(__value);
        return JSON.stringify(__value);
      })()`).runInContext(context, { timeout: message.syncTimeoutMs })
      if (serialized === undefined) throw new Error('Model must return JSON')
      outputs.push(JSON.parse(serialized))
      if (Buffer.byteLength(JSON.stringify(outputs)) > message.maxOutputBytes) throw new Error('Model output limit exceeded')
    }
    send({ status: 'done', outputs, error: null })
  } catch (error) {
    send({ status: 'error', outputs: [], error: String(error?.message ?? error).slice(0, 1000) })
  }
  process.exit(0)
})
