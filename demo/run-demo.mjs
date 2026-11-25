#!/usr/bin/env node
/**
 * Keyless acceptance demo: drives the AI4Science sidecar exactly as the DeepWorks plugin does,
 * with two conversation sessions acting as two agents. No model, no network, no credentials.
 *
 *   node demo/run-demo.mjs
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const home = join(root, 'demo', '.run')
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })

const server = spawn(
  process.execPath,
  ['--experimental-transform-types', join(root, 'app', 'science', 'server.mjs'), '--home', home],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
)
server.stderr.on('data', (chunk) => process.stderr.write(chunk))
const lines = createInterface({ input: server.stdout, crlfDelay: Infinity })
const waiting = new Map()
let sequence = 0
const ready = new Promise((resolveReady) => {
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id === null) {
      if (message.event === 'ready') resolveReady()
      return
    }
    const pending = waiting.get(message.id)
    if (!pending) return
    waiting.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error))
  })
})
const call = (method, params = {}) =>
  new Promise((resolveCall, rejectCall) => {
    const id = ++sequence
    waiting.set(id, { resolve: resolveCall, reject: rejectCall })
    server.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })

const line = (text) => process.stdout.write(`${text}\n`)
const step = (name, value) => line(`\n### ${name}\n${JSON.stringify(value, null, 2)}`)

await ready
const brain = { sessionId: 'ses_demo_cerebrum', agent: 'cerebrum' }
const hands = { sessionId: 'ses_demo_midbrain', agent: 'midbrain' }

step('hello', await call('hello'))
step('session.open cerebrum', await call('session.open', brain))
step('session.open midbrain', await call('session.open', hands))

const experiment = await call('experiment.start', { ...brain, goal: '演示：两角色完成受约束采样' })
step('experiment.start (cerebrum)', { id: experiment.id, state: experiment.state, createdBy: experiment.createdBy })

step('experiment.release (cerebrum -> midbrain)', await call('experiment.release', { ...brain, experimentId: experiment.id }))

const measure = await call('experiment.act', { ...hands, experimentId: experiment.id, actionId: 'measure' })
step('experiment.act measure (midbrain)', {
  operation: measure.operation.id,
  state: measure.operation.state,
  artifacts: measure.operation.artifacts,
})

let assessment = await call('experiment.assess', { ...hands, experimentId: experiment.id })
step('assess after measure', assessment)

if (assessment.status === 'insufficient') {
  const supplement = await call('experiment.act', {
    ...hands,
    experimentId: experiment.id,
    actionId: 'supplement',
    rationale: '观测数不足，追加两次同条件测量',
  })
  step('experiment.act supplement (midbrain)', { operation: supplement.operation.id, state: supplement.operation.state })
  assessment = await call('experiment.assess', { ...hands, experimentId: experiment.id })
  step('assess after supplement', assessment)
}

const finished = await call('experiment.finish', { ...hands, experimentId: experiment.id })
step('experiment.finish (midbrain)', { state: finished.state, completion: finished.completion })

const firstArtifact = measure.operation.artifacts.find((artifact) => artifact.path.endsWith('raw.json'))
const raw = await call('artifact.read', { ...brain, artifactId: firstArtifact.id })
step('artifact.read raw.json (cerebrum)', { artifact: raw.artifact, preview: raw.content.split('\n').slice(0, 6).join('\n') })

const records = await call('records', brain)
line(`\n### records.md\n${records.markdown.split('\n').slice(0, 20).join('\n')}`)

const ok =
  finished.state === 'completed' &&
  assessment.status === 'sufficient' &&
  raw.artifact.id === firstArtifact.id &&
  records.markdown.includes('completed')
line(`\n${ok ? 'DEMO PASSED' : 'DEMO FAILED'}  data: ${home}`)
await call('shutdown')
process.exit(ok ? 0 : 1)
