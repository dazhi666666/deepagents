#!/usr/bin/env node
/** Keyless T1 protocol acceptance: fresh fixtures, real rounds/seals/finalizer, no model or network. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkRoot = join(root, 'demo', '.checks')
mkdirSync(checkRoot, { recursive: true })
const home = mkdtempSync(join(checkRoot, 'accept-'))
const child = spawn(process.execPath, ['--experimental-transform-types', join(root, 'app', 'mars-server.mjs'),
  '--home', home, '--truth', join(root, 'data', 'mars', 'truth.json'), '--auto-clock', '0', '--checkpoint-interval', '0',
  '--model-source', 'scripted-integration'],
{ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } })
const rpc = connectSidecar(child, { label: 'Mars acceptance', log: chunk => process.stderr.write(chunk) })
const call = rpc.call
const roles = ['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst']
const tool = async (role, name, args = {}) => (await call('tools.call', { sessionId: `ses_accept_${role}`, name, args })).result
const mutate = async (role, name, args) => {
  const pending = await tool(role, name, args)
  assert.equal(pending.state, 'pending')
  const current = (await call('status')).tick
  await call('advance', { steps: 12 })
  const receipt = (await tool(role, 'round_receipts')).find(item => item.callId === pending.callId)
  assert.ok(receipt, 'Mutation must produce a durable receipt')
  assert.ok(!receipt.result.isError, JSON.stringify(receipt.result))
  return receipt.result
}
try {
  await call('hello')
  for (const role of roles) await call('login', { sessionId: `ses_accept_${role}`, role })
  await call('run.start', { sessionId: 'ses_accept_brain' })
  await tool('brain', 'mars_send', { to: 'water', text: '开始 T1 baseline' })
  assert.ok((await tool('water', 'mars_inbox')).messages.some(message => message.from === 'brain'))
  const model = await mutate('brain', 'model_register', {
    input_json: JSON.stringify({ id: 'demo-water-model', code: 'return { concentrationAtSampling: 10 };',
      parameters: {}, inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-model-v06-sync-v1' }), request_key: 'demo-model',
  })
  assert.equal(model.id, 'demo-water-model')
  for (const slotId of ['baseline', 'final']) {
    const prediction = await mutate('brain', 'prediction_commit', {
      input_json: JSON.stringify({ id: `demo-t1-${slotId}`, taskId: 'T1', slotId, modelId: model.id, inputDomain: {} }),
      request_key: `demo-pred-${slotId}`,
    })
    const submission = await mutate('brain', 'research_submit', {
      input_json: JSON.stringify({ taskId: 'T1', slotId, payload: { modelId: model.id, predictionId: prediction.id }, evidence: [], expectedRevision: 0 }),
      request_key: `demo-submit-${slotId}`,
    })
    assert.equal(submission.revision, 1)
    console.log(`${slotId}: accepted revision ${submission.revision}`)
  }
  for (const [tick, stage] of [[720, 'baseline'], [1800, 'final'], [2400, 'horizon']]) {
    const current = (await call('status')).tick
    const advanced = await call('advance', { steps: tick - current }, 0)
    assert.equal(advanced.tick, tick)
    assert.ok(advanced.advanced.seals.includes(stage))
    console.log(`sealed ${stage}@${tick}`)
  }
  const report = await call('finalize', { sessionId: 'ses_accept_brain' })
  assert.equal(report.R, 0)
  assert.equal(report.F, false)
  assert.equal((await call('status')).round.clock.failure, null)
  console.log(JSON.stringify({ passed: true, home, R: report.R, F: report.F, completionStatus: report.completionStatus }))
} finally { await rpc.close() }
