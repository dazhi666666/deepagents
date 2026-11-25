#!/usr/bin/env node
/** Exercise public plan arguments through physical service delivery and the final seal. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'
import { marsRoster } from '../app/science/mars-roster.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = join(root, 'demo', '.checks')
mkdirSync(checks, { recursive: true })
const fixture = mkdtempSync(join(checks, 'plan-service-'))
const mode = process.argv.includes('--single') ? 'single' : 'multi'
const portfolio = process.argv.includes('--portfolio')
const delivery = process.argv.includes('--delivery')
const reviewed = delivery || process.argv.includes('--reviewed')
const home = join(fixture, mode)
const child = spawn(process.execPath, ['--experimental-transform-types', join(root, 'app', 'mars-server.mjs'),
  '--home', home, '--truth', join(root, 'data', 'mars', 'truth.json'), '--mode', mode, '--team-size', '8',
  '--auto-clock', '0', '--checkpoint-interval', '0', '--model-source', 'scripted-integration', ...(reviewed ? ['--research-workflow',delivery?'delivery-v2':'reviewed-v1'] : []), ...(delivery ? ['--joint-trial','pilot-choice-v2'] : [])],
{ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NODE_NO_WARNINGS: '1' } })
const rpc = connectSidecar(child, { label: 'Public service plan', log: chunk => process.stderr.write(chunk) })
const sessionId = role => `service-fixture-${mode === 'multi' ? role : 'single'}`
const tool = async (role, name, args = {}) => (await rpc.call('tools.call', { sessionId: sessionId(role), name,
  args: delivery && name==='research_catalog' && args.contract ? {...args,refresh:true} : args })).result
const write = (role, name, key, input, args = {}) => tool(role, name, { request_key: key, input_json: JSON.stringify(input), ...args })
async function advanceTo(tick) {
  const prior = (await rpc.call('status')).tick
  assert.ok(tick >= prior)
  if (tick > prior) assert.equal((await rpc.call('advance', { steps: tick - prior }, 0)).tick, tick)
}
async function receipt(role, pending) {
  assert.equal(pending.state, 'pending')
  const found = (await tool(role, 'round_receipts')).find(row => row.callId === pending.callId)
  assert.ok(found, `Missing receipt for ${role}`)
  assert.ok(!found.result.isError, found.result.error)
  return found.result
}
const output = id => `$step:${id}:outputSampleId`
const step = (id, name, args, dependsOn = [], at = 0) => ({ id, tool: name, args, dependsOn, at })

async function exercise() {
  await rpc.call('hello')
  for (const role of marsRoster(mode, 8)) await rpc.call('login', { sessionId: sessionId(role), role })
  await rpc.call('run.start', { sessionId: sessionId('brain') })
  const overview = await tool('service', 'research_catalog')
  assert.ok(overview.contractNames.includes('experiment_plan'))
  const { experiment_plan: contract } = await tool('service', 'research_catalog', { contract: 'experiment_plan' })
  assert.deepEqual(contract['x-mars-call'].requiredByAction.schedule, ['input_json', 'request_key'])
  const mission = await tool('service', 'mission_read')
  const lots = await tool('service', 'research_catalog', { section: 'resources', resource_kind: 'batch', limit: 10 })
  const extraction = lots.items.find(item => item.value.kind === 'extraction')?.value
  assert.ok(extraction?.units > 0)
  const robots = await tool('service', 'research_catalog', { section: 'resources', resource_kind: 'robot' })
  assert.equal(robots.items.find(item => item.value.id === 'robot-3').value.sampleCapacity, 0)
  const commission = mission.services.filter(service => service.methods.includes('screen')).sort((a, b) => b.deadline - a.deadline)[0]
  const method = mission.resources.methods.find(method => method.id === 'screen')
  const robot = 'robot-2'
  const startTick = Math.max(commission.preserveUntil - mission.resources.rules.sampleLifetimeTicks, commission.deadline - 140)
  const preferredLoads = new Set(['incubator-1', 'incubator-2', 'incubator-3', 'incubator-4', 'cold-1', 'cold-2', 'freezer', 'robot-2'])
  const shedFirst = ['co2-distribution', 'water-recovery', ...mission.resources.devices.map(device => device.id).filter(id => !preferredLoads.has(id))]
  const planInput = { title: 'Deliver one service with its retained mother sample',
    service: { commissionId: commission.id, measurementStepId: 'measure', retentionStepId: 'keep-mother' }, steps: [
    step('protect-storage', 'power_priority', { order: shedFirst }),
    step('clean-panels', 'panel_clean', {}, ['protect-storage'], startTick - 80),
    step('dock', 'robot_move', { robot_id: robot, destination: robot }, ['protect-storage'], startTick),
    step('charge', 'robot_charge', { robot_id: robot }, ['dock']),
    step('position', 'robot_move', { robot_id: robot, destination: commission.sourceId }, ['charge']),
    step('draw', 'water_sample', { source_id: commission.sourceId, volume_ul: 150, container: 'vial' }, ['position']),
    step('to-handler', 'sample_transfer', { robot_id: robot, sample_id: output('draw'), destination: 'liquid-handler' }, ['draw']),
    step('split', 'sample_aliquot', { device_id: 'liquid-handler', sample_id: output('draw'), volume_ul: 25, container: 'vial' }, ['to-handler', 'draw']),
    step('to-screen', 'sample_transfer', { robot_id: robot, sample_id: output('split'), additional_sample_ids: [output('draw')], destination: 'screen' }, ['split', 'draw']),
    step('clean-screen', 'device_clean', { device_id: 'screen' }, ['to-screen']),
    step('calibrate-screen', 'device_calibrate', { device_id: 'screen' }, ['clean-screen']),
    step('measure', 'water_screen', { device_id: 'screen', sample_id: output('split'), volume_ul: 25, method_version: method.version }, ['calibrate-screen', 'split']),
    step('keep-mother', 'sample_transfer', { robot_id: robot, sample_id: output('draw'), additional_sample_ids: [output('measure')], destination: 'freezer' }, ['measure', 'draw']),
    step('maintain-panels', 'panel_clean', {}, ['clean-panels'], 1320),
    step('maintain-panels-late', 'panel_clean', {}, ['maintain-panels'], 1920),
  ] }
  for (const { tool: name, args } of planInput.steps) {
    assert.ok(contract['x-mars-step-tools'].includes(name))
    const advertised = (await tool('service', 'research_catalog', { contract: 'experiment_plan', tool: name })).experiment_plan['x-mars-step']
    assert.ok(advertised.argsSchema.required?.every(arg => Object.hasOwn(args, arg)) ?? true)
    assert.ok(Object.keys(args).every(arg => Object.hasOwn(advertised.argsSchema.properties ?? {}, arg)))
  }
  const preflight = await tool('service', 'experiment_plan', {
    action: 'check', input_json: JSON.stringify(planInput), deadline_tick: commission.deadline,
  })
  assert.equal(preflight.diagnostics.asOfTick, 0)
  const timing = preflight.diagnostics.steps.find(s => s.id === 'measure')
  assert.equal(timing.earliestStartTick, startTick)
  assert.equal(timing.missesDeadline, false)
  assert.equal(preflight.plan.steps.find(s => s.id === 'measure').input.sampleId, output('split'))
  assert.equal(preflight.diagnostics.steps.find(s => s.id === 'maintain-panels-late').missesDeadline, true)
  const serviceCheck = preflight.diagnostics.service
  assert.equal(serviceCheck.commissionId, commission.id)
  assert.equal(serviceCheck.drawStepId, 'draw')
  assert.equal(serviceCheck.remainingUl, 125)
  assert.deepEqual(serviceCheck.warnings, [])
  const check = plan => tool('service', 'experiment_plan', { action: 'check', input_json: JSON.stringify(plan) })
  const invalid = (id, args) => ({ ...planInput, steps: planInput.steps.map(item => item.id === id ? { ...item, args: { ...item.args, ...args } } : item) })
  await assert.rejects(check(invalid('keep-mother', { robot_id: 'robot-3' })), /Step keep-mother: Robot robot-3 carries at most 0/)
  await assert.rejects(check(invalid('keep-mother', { sample_id: output('measure'), additional_sample_ids: [] })), /original raw mother sample/)
  await assert.rejects(check(invalid('draw', { volume_ul: 30 })), /plan leaves 5 µL/)
  const projected = await tool('engineer', 'experiment_plan', { action: 'portfolio', input_json: JSON.stringify({ drafts: [planInput, planInput] }) })
  assert.equal(projected.asOfTick, 0)
  assert.equal(projected.services.length, 2)
  assert.ok(projected.issues.some(x => x.code === 'shared_window'))
  assert.ok(projected.issues.some(x => x.code === 'duplicate_commission'))
  assert.ok(projected.steps.every(x => x.operationId === null))
  assert.ok(projected.services.every(x => x.measurement.endTick > startTick))
  const early = await check({ ...planInput, steps: planInput.steps.map(item => item.id === 'dock' ? { ...item, at: 30 } : item) })
  assert.match(early.diagnostics.service.warnings.join('\n'), /early draw could expire/)
  const late = await check({ ...planInput, steps: planInput.steps.map(item => item.id === 'measure' ? { ...item, at: commission.deadline } : item) })
  assert.match(late.diagnostics.service.warnings.join('\n'), /earliest completion tick .* exceeds the measurement deadline/)
  const withoutSupplies = { title: 'Prepare with missing extraction supplies', steps: [
    step('sample', 'water_sample', { source_id: commission.sourceId, volume_ul: 100, container: 'vial' }),
    step('prepare', 'water_prepare', { device_id: 'heater-2', sample_id: output('sample'), volume_ul: 25,
      method_version: mission.resources.methods.find(m => m.id === 'water-prepare').version }, ['sample']),
  ] }
  await assert.rejects(check(withoutSupplies), /Step prepare: .*extraction/)
  const restoredRecipe = { ...withoutSupplies, steps: withoutSupplies.steps.map(item => item.id === 'prepare'
    ? { ...item, args: { ...item.args, consumables: [{ batchId: extraction.id, units: 1 }] } } : item) }
  assert.ok((await check(restoredRecipe)).plan.steps[1].input.consumables.length)
  const badSchedule = await write('service', 'experiment_plan', 'missing-supplies', withoutSupplies, { action: 'schedule' })
  const scheduled = await write('service', 'experiment_plan', 'deliver-service', planInput, { action: 'schedule' })
  await advanceTo(12)
  const rejected = (await tool('service', 'round_receipts')).find(row => row.callId === badSchedule.callId).result
  assert.equal(rejected.isError, true)
  assert.match(rejected.error, /Step prepare: .*extraction/)
  const plan = await receipt('service', scheduled)
  assert.deepEqual(plan.steps, preflight.plan.steps)
  assert.deepEqual(plan.service, planInput.service)
  const readPlan = async () => (await tool('service', 'experiment_plan', { action: 'list' })).find(row => row.id === plan.id)
  const guarded = await readPlan()
  assert.equal(guarded.commitmentRecorded, false)
  assert.deepEqual(guarded.operations, {})
  assert.equal((await rpc.call('operations')).length, 0)
  const forecastInput = { id: 'service-forecast', taskId: 'T3', planId: plan.id, commissionId: commission.id, sourceId: commission.sourceId,
    forecast: { completedTick: startTick + 120, remainingUl: 125 } }
  const mismatched = await write('service', 'prediction_commit', 'wrong-service', {
    ...forecastInput, id: 'wrong-service', commissionId: mission.services.find(s => s.id !== commission.id).id,
  })
  await advanceTo(24)
  const mismatch = (await tool('service', 'round_receipts')).find(row => row.callId === mismatched.callId).result
  assert.equal(mismatch.isError, true)
  assert.match(mismatch.error, /requires a T3 commitment/)
  assert.deepEqual((await readPlan()).operations, {})
  let withoutReview
  if (reviewed) {
    withoutReview = await write('service','action_commit','no-review',forecastInput)
    const checked = (await tool('engineer','service_review')).plans.find(s => s.planId === plan.id)
    assert.ok(checked.eligible, JSON.stringify(checked.firstBlocker)); forecastInput.reviewId = checked.reviewId
  }
  const predicted = await write('service', 'prediction_commit', 'service-commitment', forecastInput)
  await advanceTo(36)
  if (withoutReview) assert.match((await tool('service','round_receipts')).find(row => row.callId === withoutReview.callId).result.error,/reviewId/)
  const commitment = await receipt('service', predicted)
  assert.equal(commitment.planId, plan.id)
  assert.equal((await readPlan()).commitmentRecorded, true)
  assert.deepEqual((await readPlan()).commitmentReceipts.map(r=>r.id),[commitment.id])
  assert.ok((await readPlan()).operations['protect-storage'])
  console.log('PASS plan preflight rejects missing supplies, wrong cargo and lost mother volume; first job waits for the matching commitment')

  if (mode === 'multi') {
    const message = {to:'agronomist',text:'Check the scheduled measurement and dispatched power step.',request_key:'step-status-handoff',handoff:{taskId:'T3',slotId:'final',references:[
      {kind:'plan',id:plan.id,stepId:'measure'},{kind:'plan',id:plan.id,stepId:'protect-storage'}]}}
    const sent = await tool('service','mars_send',message)
    const [measurement,power] = sent.handoff.references.map(r=>r.stepReceipt)
    assert.equal(measurement.state,'scheduled');assert.equal(measurement.operationId,null)
    assert.equal(power.state,'succeeded');assert.ok(power.operationId);assert.ok(power.completedTick<=36)
    const replay=await tool('service','mars_send',message);assert.equal(replay.duplicate,true);assert.deepEqual(replay.handoff,sent.handoff)
    await assert.rejects(tool('service','mars_send',{...message,request_key:'invented-step',handoff:{...message.handoff,references:[{kind:'plan',id:plan.id,stepId:'invented'}]}}),/service step unavailable/i)
  }
  if (process.argv.includes('--commit-only')) {
    const view = await tool('engineer', 'experiment_plan', { action: 'portfolio' })
    assert.deepEqual(view.services[0].commitmentReceipts.map(r=>[r.id,r.acceptedTick]),[[commitment.id,commitment.acceptedTick]])
    console.log('PASS portfolio identifies the accepted matching forecast before dispatch')
    return
  }
  const additionalCommitments = []
  if (portfolio) {
    const earlier = mission.services.filter(service => service.id !== commission.id)
    const scheduledEarlier = []
    for (const [index, service] of earlier.entries()) {
      const at = index === 0 ? service.deadline - 305 : service.deadline - 250
      const additionalSteps = planInput.steps.filter(item => !['protect-storage', 'clean-panels', 'maintain-panels', 'maintain-panels-late'].includes(item.id))
        .map(item => ({ ...item, at: item.id === 'dock' ? at : item.at,
          dependsOn: item.dependsOn.filter(dep => dep !== 'protect-storage'),
          args: { ...item.args, ...(item.id === 'draw' ? { source_id: service.sourceId } : {}), ...(item.id === 'position' ? { destination: service.sourceId } : {}) } }))
      const draft = { ...planInput, title: `Service and retention for ${service.sourceId}`,
        steps: [...additionalSteps, step('park', 'robot_move', { robot_id: robot, destination: robot }, ['keep-mother'])],
        service: { ...planInput.service, commissionId: service.id } }
      assert.deepEqual((await check(draft)).diagnostics.service.warnings, [])
      const pending = await write('service', 'experiment_plan', `schedule-${service.id}`, draft, { action: 'schedule' })
      scheduledEarlier.push({ service, at, pending })
    }
    await advanceTo(48)
    const pendingCommitments = []
    for (const { service, at, pending } of scheduledEarlier) {
      const earlierPlan = await receipt('service', pending)
      pendingCommitments.push(await write('service', 'prediction_commit', `commit-${service.id}`, {
        id: `tested-${service.id}`, taskId: 'T3', planId: earlierPlan.id, commissionId: service.id, sourceId: service.sourceId,
        ...(reviewed ? {reviewId:(await tool('engineer','service_review')).plans.find(s => s.planId === earlierPlan.id).reviewId} : {}),
        forecast: { completedTick: at + 120, remainingUl: 125 },
      }))
    }
    await advanceTo(60)
    for (const pending of pendingCommitments) additionalCommitments.push(await receipt('service', pending))
  }
  await advanceTo(commission.deadline + 36)
  const ongoing = (await tool('service', 'experiment_plan', { action: 'list' })).find(p => p.id === plan.id)
  assert.ok(ongoing.operations['keep-mother'], JSON.stringify({ state: ongoing.state, blocked: ongoing.blocked, failureReason: ongoing.failureReason, operations: Object.keys(ongoing.operations) }))
  const results = await tool('service', 'mars_measurements', { method_id: 'screen' })
  const result = results.items.find(r => r.operationId === ongoing.operations.measure)
  assert.ok(result, 'Service measurement must come from the scheduled step')
  assert.ok(result.completedTick <= commission.deadline)
  const roots = await tool('service', 'mars_samples', { sample_id: result.rootSampleId })
  const mother = roots.items.find(sample => sample.id === result.rootSampleId)
  assert.equal(mother.volumeUl, 125)
  assert.equal(mother.location, 'freezer')
  assert.ok(mother.expiresAt >= commission.preserveUntil)
  console.log(`PASS public service plan measured by tick ${result.completedTick} and stored ${mother.volumeUl} µL of its own mother sample`)

  const commitmentIds = [commitment.id, ...additionalCommitments.map(item => item.id)]
  if (mode === 'multi') {
    const sent = await tool('service', 'mars_send', { to: 'agronomist', text: 'Include these service commitments and measured result in T3.',
      request_key: 'service-evidence', handoff: { taskId: 'T3', slotId: 'final', references: [
        ...commitmentIds.map(id => ({ kind: 'commitment', id })), { kind: 'evidence', id: result.id },
      ] } })
    const inbox = await tool('agronomist', 'mars_inbox')
    assert.deepEqual(inbox.messages.find(message => message.id === sent.messageId).handoff, sent.handoff)
  }
  const firstModel = await write('agronomist', 'model_register', 'service-fixture-model', { id: 'service-fixture-model', parameters: {},
    code: 'return { generation: 0, minimumSoc: input.initialSoc ?? 0 };',
    inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-model-v06-sync-v1' })
  const advanceWindow = async () => {
    const { tick } = await rpc.call('status')
    await advanceTo((Math.floor(tick / mission.decisionTicks) + 1) * mission.decisionTicks)
  }
  await advanceWindow()
  const model = await receipt('agronomist', firstModel)
  const prediction = await write('agronomist', 'prediction_commit', 'lock-model', {
    id: 'service-fixture-prediction', taskId: 'T3', slotId: 'final', modelId: model.id, inputDomain: {},
  })
  await advanceWindow()
  const committed = await receipt('agronomist', prediction)
  const submitted = await write('agronomist', 'research_submit', 'submit-service', { taskId: 'T3', slotId: 'final',
    payload: { modelId: model.id, predictionId: committed.id, commitmentIds },
    evidence: [{ id: result.id, purpose: 'current-estimate' }], expectedRevision: 0 }, { action: 'submit' })
  await advanceWindow()
  await receipt('agronomist', submitted)
  await advanceTo(mission.stages.finalTick)
  assert.ok((await rpc.call('stages')).seals.find(seal => seal.stage === 'final').selections.some(s => s.taskId === 'T3'))
  await advanceTo(commission.preserveUntil)
  const report = JSON.parse(readFileSync(join(home, 'final-report.json'), 'utf8'))
  const service = report.services.find(s => s.id === commission.id)
  assert.equal(service.measurement, true, JSON.stringify(service))
  assert.equal(service.preserved, true, JSON.stringify(service))
  assert.equal(service.remainingUl, 125)
  const receiptsView = await tool('service', 'experiment_plan', { action: 'portfolio', input_json: JSON.stringify({ planIds: [plan.id] }) })
  assert.equal(receiptsView.services[0].measurement.operationId, result.operationId)
  assert.equal(receiptsView.services[0].measurement.endTick, result.completedTick)
  assert.equal(receiptsView.services[0].measurement.status, 'succeeded')
  assert.equal(receiptsView.services[0].measuredResult.id,result.id)
  assert.equal(receiptsView.services[0].measuredResult.rootSampleId,result.rootSampleId)
  assert.equal(receiptsView.services[0].measuredResult.motherNow.volumeUl,125)
  const forecast = report.commitments.find(c => c.id === commission.id)
  assert.equal(forecast.valid, true, JSON.stringify(forecast))
  const settledPlans = await tool('service', 'experiment_plan', { action: 'list' })
  const settled = settledPlans.find(p => p.id === plan.id)
  assert.equal(settled.state, 'succeeded', JSON.stringify(settled))
  const portfolioOutcomes = portfolio ? report.services.map(item => ({ ...item,
    planState: settledPlans.find(p => p.service?.commissionId === item.id)?.state,
    commitmentValid: report.commitments.find(c => c.id === item.id).valid,
  })) : undefined
  if (portfolio) {
    assert.equal(portfolioOutcomes.length, 3)
    assert.ok(portfolioOutcomes.every(item => item.measurement && item.preserved && item.remainingUl === 125
      && item.commitmentValid && item.planState === 'succeeded'), JSON.stringify(portfolioOutcomes))
  }
  console.log(JSON.stringify({ passed: true, fixture, mode, measuredTick: service.completedTick, cutoff: commission.deadline,
    finalTick: report.tick, retainedUl: service.remainingUl, commitmentValid: true, portfolioOutcomes, realModelCalls: 0 }))
}
try { await exercise() } finally { await rpc.close() }
