// v0.6 analysis compartment: every binding, promise and callback in the program realm is VM-owned.
// The Node worker pumps primitive JSON messages; it never awaits or invokes a model-created object.
import { createInterface } from 'node:readline'
import { createContext, Script } from 'node:vm'
import { JSON_REALM_BOOTSTRAP } from '../json-realm.mjs'
import { chromatogram, SPECTRUM_PEAKS } from '../analysis-math.mjs'

const lines = createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
let context, timeoutMs = 30000, finished = false
const bootstrap = new Script(`
  ${JSON_REALM_BOOTSTRAP}
  const SPECTRUM_PEAKS = ${JSON.stringify(SPECTRUM_PEAKS)};
  const chromatogram = ${chromatogram.toString()};
  const __Map = Map, __Promise = Promise;
  const __waiters = new __Map(), __calls = [], __logs = [];
  const __mapGet = Function.call.bind(Map.prototype.get), __mapSet = Function.call.bind(Map.prototype.set);
  const __mapDelete = Function.call.bind(Map.prototype.delete), __push = Function.call.bind(Array.prototype.push);
  const __splice = Function.call.bind(Array.prototype.splice);
  let __nextId = 1, __done = false, __result = null, __error = null, __logCharacters = 0;
  const __call = (name, args) => new __Promise((resolve, reject) => {
    const id = __nextId++;
    __mapSet(__waiters, id, { resolve, reject });
    __push(__calls, { type: 'call', id, name, args });
  });
  const readArtifact = id => __call('readArtifact', [id]);
  const telemetry = (channels, from, to) => __call('telemetry', [channels, from, to]);
  const archiveSql = sql => __call('archiveSql', [sql]);
  const readRaw = id => __call('readRaw', [id]);
  const __log = (...values) => {
    const line = values.map(v => typeof v === 'string' ? v : v === undefined ? 'undefined' : typeof v === 'function' ? '[function]' : __encode(__copy(v))).join(' ');
    __logCharacters += line.length;
    if (__logCharacters > 64000) throw new __Error('Analysis log limit exceeded');
    __push(__logs, line);
  };
  const console = { log: __log, error: __log };
  const __fail = error => {
    __done = true;
    let message = 'Isolated analysis failed';
    try {
      if (typeof error === 'string') message = error;
      else { const property = error && __descriptor(error, 'message'); if (property && typeof property.value === 'string') message = property.value; }
    } catch { /* Do not invoke model getters in the Node realm. */ }
    __error = message.slice(0, 1000);
  };
  const __finish = value => {
    try { __result = __copy(value === undefined ? null : value); __done = true; }
    catch (error) { __fail(error); }
  };
  const __start = () => {
    try { __program(readArtifact, telemetry, archiveSql, readRaw, chromatogram, console).then(__finish, __fail); }
    catch (error) { __fail(error); }
  };
  const __accept = payload => {
    const message = __parse(payload), waiter = __mapGet(__waiters, message.id);
    if (!waiter) throw new __Error('Unknown analysis reply');
    __mapDelete(__waiters, message.id);
    if (message.error !== undefined) waiter.reject(new __Error(message.error)); else waiter.resolve(message.result);
  };
  const __drain = () => __encode(__copy(__splice(__calls, 0)));
  const __state = () => __done ? __encode(__copy(__error === null ? { type: 'done', result: __result, logs: __logs } : { type: 'error', message: __error, logs: __logs })) : '';
`)
const drain = new Script('__drain()'), state = new Script('__state()'), accept = new Script('__accept(__reply); delete globalThis.__reply;')
function pump() {
  const calls = drain.runInContext(context, { timeout: timeoutMs })
  if (typeof calls !== 'string') throw new Error('Invalid analysis message encoding')
  for (const call of JSON.parse(calls)) {
    if (call.type !== 'call' || !Number.isSafeInteger(call.id) || call.id < 1 || !['readArtifact', 'telemetry', 'archiveSql', 'readRaw'].includes(call.name) || !Array.isArray(call.args)) throw new Error('Invalid analysis binding request')
    send(call)
  }
  const result = state.runInContext(context, { timeout: timeoutMs })
  if (typeof result !== 'string') throw new Error('Invalid analysis result encoding')
  if (result) { send(JSON.parse(result)); finished = true; process.exit(0) }
}
lines.on('line', line => {
  if (finished) return
  try {
    const message = JSON.parse(line)
    if (message.type === 'run') {
      if (context) throw new Error('Analysis already started')
      timeoutMs = message.timeoutMs
      context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' })
      bootstrap.runInContext(context, { timeout: timeoutMs })
      // Arbitrary source stays in this realm, including source which exits its proposed function body.
      // No Host function or promise resolver is supplied to it.
      new Script(`globalThis.__program = async function(readArtifact, telemetry, archiveSql, readRaw, chromatogram, console) { "use strict";\n${message.code}\n}; __start();`)
        .runInContext(context, { timeout: timeoutMs })
      pump()
    } else if (message.type === 'reply' && context) {
      context.__reply = JSON.stringify(message)
      accept.runInContext(context, { timeout: timeoutMs })
      pump()
    } else throw new Error('Unexpected analysis protocol message')
  } catch (error) {
    // Never inspect a model-created exception object in the Node realm.
    send({ type: 'error', message: 'Analysis compartment failed or exceeded its execution limits', logs: [] })
    finished = true; process.exit(0)
  }
})
