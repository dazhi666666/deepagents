// Isolated analysis runner: started with `node --permission`, so it cannot touch files, spawn processes or open workers.
// All data arrives through host bindings over stdio. The model's program is an async function body.
import { createInterface } from 'node:readline'
import { chromatogram } from './analysis-math.mjs'

const lines = createInterface({ input: process.stdin })
const pending = new Map()
let nextId = 1
let started = false
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
// The water lab's chromatogram fit (same algorithm as chromatography.ts): DOC 5.1 min, lubricant 5.4 min and internal
// standard 7.8 min Gaussian peaks over a linear baseline. Accepts a raw chromatogram ({ points, dtMinutes }) or readRaw's output.
const call = (name, args) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  send({ type: 'call', id, name, args })
})
lines.on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'reply') {
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result)
    return
  }
  if (message.type !== 'run' || started) return
  started = true
  const logs = []
  const format = value => typeof value === 'string' ? value : JSON.stringify(value)
  const sandboxConsole = { log: (...values) => logs.push(values.map(format).join(' ')), error: (...values) => logs.push(values.map(format).join(' ')) }
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const program = new AsyncFunction('readArtifact', 'telemetry', 'archiveSql', 'readRaw', 'chromatogram', 'console', message.code)
    const result = await program(id => call('readArtifact', [id]), (channels, from, to) => call('telemetry', [channels, from, to]), sql => call('archiveSql', [sql]),
      ref => call('readRaw', [ref]), chromatogram, sandboxConsole)
    send({ type: 'done', result: result === undefined ? null : JSON.parse(JSON.stringify(result)), logs })
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? `${error.name}: ${error.message}` : String(error), logs })
  }
  process.exit(0)
})
