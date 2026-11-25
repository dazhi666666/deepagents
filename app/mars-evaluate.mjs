#!/usr/bin/env node
/**
 * Offline scientific evaluation of a stopped Mars run.
 *
 * Opens the execution journal in observer mode (no writes), rebuilds the world from the read-only
 * device snapshot, re-runs the same finalizer and writes the R/O/F report.
 *
 *   node app/mars-evaluate.mjs --home data/mars-multi --truth data/mars/truth.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const home = resolve(arg('home', join(here, '..', 'data', 'mars-multi')))
const truthFile = resolve(arg('truth', join(here, '..', 'data', 'mars', 'truth.json')))
const output = resolve(arg('output', `${home}.evaluation.json`))
const platformDir = join(here, 'science-harness', 'integrations', 'ai4science', 'platform')
const marsDir = join(here, 'science-harness', 'integrations', 'ai4science', 'mars')

const pidFile = join(home, 'mars-server.pid')
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  try {
    process.kill(pid, 0)
    throw new Error('Mars sidecar is still running; stop it before offline evaluation')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

const [{ ExecutionEngine }, { reportScientificStopped }] = await Promise.all([
  import(pathToFileURL(join(platformDir, 'execution.ts')).href),
  import(pathToFileURL(join(marsDir, 'v06/offline.ts')).href),
])

const stub = (id) => ({
  describe: () => ({ apiVersion: 1, id, version: '0.1.0', configuration: {}, inputSchema: {}, outputSchema: {}, units: {}, constraints: [], completion: 'offline', cancellation: 'unsupported' }),
  prepare: (input) => ({ input, resources: [], budget: 0 }),
  submit: async () => ({ state: 'unknown', detail: 'offline observer' }),
  query: async () => ({ state: 'unknown', detail: 'offline observer' }),
  cancel: async () => ({ disposition: 'unsupported' }),
})
const engine = new ExecutionEngine({
  directory: join(home, 'execution'),
  providers: ['water', 'greenhouse', 'facilities'].map(stub),
  pollIntervalMs: 100,
  providerCallTimeoutMs: 10000,
  logicalTick: () => 0,
})
await engine.open({ mode: 'observer' })
try {
  const context = engine.issueContext('mars', 'offline-evaluator', ['water', 'greenhouse', 'facilities'])
  const runId = JSON.parse(readFileSync(join(home, 'run.json'), 'utf8')).runId
  const report = await reportScientificStopped({
    directory: home,
    truthFile,
    engine,
    context,
    identity: { runId },
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    checks: [],
  })
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ output, R: report.R, F: report.F, completionStatus: report.completionStatus }))
} finally {
  await engine.close()
}
