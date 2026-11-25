#!/usr/bin/env node
/** Native-step scheduling: barriers, acceptance tick, retry slots, waits, compaction and automatic finalization. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'
import { marsRoster } from '../app/science/mars-roster.mjs'
const teamSize = process.argv.includes('--eight') ? 8 : 6
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
mkdirSync(join(root,'demo/.checks'),{recursive:true})
const fixture=mkdtempSync(join(root,'demo/.checks/native-'))
const launch=(mode,manual=false)=>connectSidecar(spawn(process.execPath,['--experimental-transform-types',join(root,'app/mars-server.mjs'),
 '--home',join(fixture,mode),'--truth',join(root,'data/mars/truth.json'),'--mode',mode,'--checkpoint-interval','0',
 '--auto-clock',manual?'0':'1','--team-size',String(teamSize),'--model-source','scripted-integration'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}}),{label:'Native scheduler regression',log:chunk=>process.stderr.write(chunk)})
const sid=role=>'native_'+role
const tool=async(rpc,role,name,args={})=>(await rpc.call('tools.call',{sessionId:sid(role),name,args})).result
const busy=(rpc,roles)=>rpc.call('busy.set',{sessions:roles.map(sid)})
const ack=async rpc=>{for(const notice of await rpc.call('notices.list'))await rpc.call('notices.ack',{id:notice.id})}
const awaitGate=async(rpc,promise)=>{
 let finished=false,value,failure
 promise.then(result=>{finished=true;value=result},error=>{finished=true;failure=error})
 const deadline=Date.now()+20000
 while(!finished&&Date.now()<deadline){await ack(rpc);await delay(5)}
 if(!finished)throw new Error('Decision gate did not complete')
 if(failure)throw failure
 return value
}
const enter=(rpc,role,key)=>rpc.call('decision.enter',{sessionId:sid(role),key},0)
let single,multi
try{
 single=launch('single')
 await single.call('hello')
 await single.call('login',{sessionId:sid('single'),role:'single'})
 await busy(single,['single'])
 await single.call('run.start',{sessionId:sid('single')})
 assert.equal((await single.call('notices.list')).filter(notice => notice.kind === 'start').length, 0)
 assert.equal((await enter(single,'single','s0')).tick,0)
 const singleStagesAtStart=await single.call('stages')
 assert.equal(singleStagesAtStart.openSlots.length,10)
 await tool(single,'single','mars_inbox')
 await assert.rejects(tool(single,'single','research_write',{arguments:'{}',request_key:'missing-input'}),/input_json/)
 await assert.rejects(tool(single,'single','greenhouse_scan',{chamber_id:'chamber-1',request_key:'bad-chamber'}),/incubator-1/)
 const malformed=await tool(single,'single','research_write',{input_json:'{broken',request_key:'malformed-json'})
 const intent=await tool(single,'single','device_calibrate',{device_id:'confirm',request_key:'single-calibration'})
 assert.equal(intent.state,'pending')
 await delay(60)
 assert.equal((await single.call('status')).tick,0,'An active model/tool step cannot consume virtual time')
 const next=await awaitGate(single,enter(single,'single','s1'))
 assert.equal(next.tick,12)
 const receipts=await tool(single,'single','round_receipts')
 const receipt=receipts.find(item=>item.callId===intent.callId)
 assert.ok(receipt&&!receipt.result.isError)
 assert.equal(receipts.find(item=>item.callId===malformed.callId).result.isError,true)
 assert.equal((await single.call('status')).round.clock.failure,null)
 const db=new DatabaseSync(join(fixture,'single/device/laboratory.sqlite'),{readOnly:true})
 try{const state=JSON.parse(db.prepare('SELECT state FROM world WHERE id=1').get().state);assert.equal(state.operations[0].acceptedTick,0);assert.ok(state.operations[0].completedTick<=12)}finally{db.close()}
 const retry=await enter(single,'single','s1')
 assert.equal(retry.retry,true);assert.equal(retry.decisionTick,12);assert.equal(retry.tick,12)
 console.log('PASS first decision at 0; common intent acceptance at 0; next decision at 12; retry retains its slot')

 await single.call('model.aux',{sessionId:sid('single'),active:true})
 const compactGate=enter(single,'single','s2')
 await delay(120)
 assert.equal((await single.call('status')).tick,12,'Compaction must pause the world even while the next decision is queued')
 await single.call('model.aux',{sessionId:sid('single'),active:false})
 assert.equal((await awaitGate(single,compactGate)).tick,24)
 await single.call('model.aux',{sessionId:sid('single'),active:true})
 let waitDone=false
 const wait=single.call('wait',{sessionId:sid('single'),timeoutMs:1000},0).then(result=>{waitDone=true;return result})
 await delay(1250)
 assert.equal(waitDone,false,'Wall-clock time must not manufacture a waiting result')
 await single.call('wait.cancel',{sessionId:sid('single')})
 assert.equal((await wait).cancelled,true)
 await single.call('model.aux',{sessionId:sid('single'),active:false})
 const longWait=single.call('wait',{sessionId:sid('single'),untilTick:30},0)
 const waited=await awaitGate(single,longWait)
 assert.equal(waited.timedOut,false)
 assert.ok(waited.events.every(event=>!['robot-position','logical-decision-progress','operation-processing','system-operation-accepted'].includes(event.kind)))
 const stoppedTick=(await single.call('status')).tick
 await delay(60)
 assert.equal((await single.call('status')).tick,stoppedTick,'A returned wait must protect the resumed decision')
 const afterWait=await awaitGate(single,enter(single,'single','s3'))
 assert.ok(afterWait.tick>=36)
 console.log('PASS compaction barrier; event/tick wait without wall timeout; cancellation; resumed-model barrier')
 const durableIntent=await tool(single,'single','model_register',{request_key:'durable-model',input_json:JSON.stringify({id:'durable-model',code:'return { concentrationAtSampling: 10 };',parameters:{},inputSchema:{},outputSchema:{},runtimeVersion:'mars-model-v06-sync-v1'})})
 await single.close()
 single=launch('single',true)
 const restored=await single.call('hello')
 assert.equal(restored.status.tick,afterWait.tick)
 const resumedSlot=await enter(single,'single','s3')
 assert.equal(resumedSlot.retry,true);assert.equal(resumedSlot.decisionTick,afterWait.decisionTick)
 await single.call('session.idle',{sessionId:sid('single')})
 if(process.argv.includes('--quick')) {
  await single.call('advance',{steps:12},0)
 } else {
  await single.call('advance',{steps:1800-afterWait.tick},0)
  assert.equal((await single.call('status')).round.modelAdmissionClosed,true)
  await assert.rejects(enter(single,'single','after-final'),/admission.*closed/i)
  await assert.rejects(single.call('model.aux',{sessionId:sid('single'),active:true}),/admission.*closed/i)
  await single.call('advance',{steps:600},0)
  const ended=await single.call('status')
  assert.equal(ended.tick,2400);assert.equal(ended.round.finalized,true)
  assert.equal(JSON.parse(readFileSync(join(fixture,'single/final-report.json'),'utf8')).completionStatus,'finalized')
  console.log('PASS model and compaction admission close at 1800; host finalizes at 2400 without a model request')
 }
 assert.ok((await tool(single,'single','round_receipts')).some(item=>item.callId===durableIntent.callId&&item.result.id==='durable-model'))
 console.log('PASS pending intents, decision slots and participant identity survive restart')

 multi=launch('multi')
 await multi.call('hello')
 const roles = marsRoster('multi', teamSize)
 assert.deepEqual((await multi.call('status')).requiredRoles, roles)
 const lastRole = roles.at(-1)
 for (const role of roles.slice(0, -1)) await multi.call('login', { sessionId: sid(role), role })
 await assert.rejects(multi.call('run.start', { sessionId: sid('brain') }), new RegExp(`missing: ${lastRole}`))
 assert.equal((await multi.call('status')).round.started, false)
 await multi.call('login', { sessionId: sid(lastRole), role: lastRole })
 await assert.rejects(multi.call('login', { sessionId: 'duplicate', role: lastRole }), /already held/)
 if (teamSize === 6) await assert.rejects(multi.call('login', { sessionId: 'extra-service', role: 'service' }), /cannot join/)
 await busy(multi,roles)
 await multi.call('run.start',{sessionId:sid('brain')})
 const starts = (await multi.call('notices.list')).filter(notice => notice.kind === 'start')
 assert.deepEqual(starts.map(notice => notice.role).sort(), roles.slice(1).sort())
 assert.ok(starts.every(notice => notice.tick === 0 && notice.sessionId === sid(notice.role)))
 const duties = { water:/主责 T1.*T4/, crops:/主责 T2/, agronomist:/主责 T3/,
  engineer:teamSize === 8 ? /主责共享设备排程.*action=portfolio.*由 service 统一登记/ : /主责三项固定服务/, analyst:/主责 T5/,
  service:/三项固定服务都由你负责登记计划、锁定承诺、取得按时实测/, verifier:/负责公开证据的独立验证.*section=references/ }
 for (const notice of starts) {
  assert.match(notice.text, duties[notice.role])
  assert.match(notice.text, /mars_send 的 handoff 和 request_key/)
 }
 await multi.call('run.start',{sessionId:sid('brain')})
 assert.deepEqual((await multi.call('notices.list')).filter(notice => notice.kind === 'start').map(notice => notice.id), starts.map(notice => notice.id))
 await ack(multi)
 for(const role of roles)assert.equal((await enter(multi,role,'m0')).tick,0)
 assert.deepEqual(await multi.call('stages'),singleStagesAtStart,'Both worlds expose the same open slots and deadlines')
 // Reverse submission order must not override the fixed-role admission order.
 const engineer=await tool(multi,'engineer','device_calibrate',{device_id:'confirm',request_key:'engineer-race'})
 const water=await tool(multi,'water','device_calibrate',{device_id:'confirm',request_key:'water-race'})
 const pending = roles.slice(0, -1).map(role => enter(multi, role, 'm1'))
 await delay(100)
 assert.equal((await multi.call('status')).tick, 0, 'The shared barrier must wait for the last configured member')
 pending.push(enter(multi, lastRole, 'm1'))
 const grants=await awaitGate(multi,Promise.all(pending))
 assert.ok(grants.every(grant=>grant.tick===12))
 const wr=(await tool(multi,'water','round_receipts')).find(item=>item.callId===water.callId)
 const er=(await tool(multi,'engineer','round_receipts')).find(item=>item.callId===engineer.callId)
 assert.ok(!wr.result.isError)
 assert.equal(er.result.isError,true)
 assert.match(er.result.error,/Resource busy|Device has accepted work/)
 assert.equal((await multi.call('status')).round.protocol,'mars-v06-native-steps/1')
 console.log(`PASS ${teamSize}-role startup and common barrier, fixed-role order and recoverable conflicts`)

 const write = (role, name, key, input, extra = {}) => tool(multi, role, name, {
  request_key: key, input_json: JSON.stringify(input), ...extra,
 })
 const nextStep = async (key, tick) => {
  const steps = await awaitGate(multi, Promise.all(roles.map(role => enter(multi, role, key))))
  assert.ok(steps.every(step => step.tick === tick))
 }
 const modelId = 'handoff-energy-model'
 await write('agronomist', 'model_register', 'register-energy', { id: modelId, parameters: {},
  code: 'return {generation: [], minimumSoc: 0};', inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-model-v06-sync-v1' })
 const serviceRole = teamSize === 8 ? 'service' : 'engineer'
 const plan = await write(serviceRole, 'experiment_plan', 'schedule-service', {
  title: 'Handoff fixture plan', steps: [{ id: 'calibrate', providerId: 'facilities', at: 120, input: { action: 'calibrate', deviceId: 'confirm' } }],
 }, { action: 'schedule' })
 const note = { id: 'handoff-service-note', kind: 'study', project: 'PW', expectedRevision: 0, content: { fixture: true }, reason: 'Handoff fixture' }
 await write(serviceRole, 'research_write', 'publish-note', note)
 const peer = { to: 'agronomist', text: 'Use the accepted records in T3.', request_key: 'service-handoff' }
 const draft = { taskId: 'T3', slotId: 'final', references: [{ kind: 'model', id: modelId }] }
 const send = (handoff, overrides = {}) => tool(multi, serviceRole, 'mars_send', { ...peer, ...overrides, handoff })
 await assert.rejects(send(draft), /Accepted model unavailable/)
 await assert.rejects(tool(single, 'single', 'mars_send', { ...peer, handoff: draft }), /another joined role in this Mars world/)
 await nextStep('m2', 24)
 const planId = (await tool(multi, serviceRole, 'round_receipts')).find(receipt => receipt.callId === plan.callId).result.id
 assert.ok(planId)
 const predictionId = 'handoff-energy-prediction'
 const commitmentId = 'handoff-service-commitment'
 await write('agronomist', 'prediction_commit', 'energy-prediction', { id: predictionId, taskId: 'T3', slotId: 'final', modelId, inputDomain: {} })
 await write(serviceRole, 'action_commit', 'service-commitment', { id: commitmentId, taskId: 'T3', planId,
  commissionId: 'service-1', sourceId: 'reservoir', forecast: { completedTick: 130, remainingUl: 20 } })
 await nextStep('m3', 36)
 const references = [{ kind: 'commitment', id: commitmentId }, { kind: 'plan', id: planId },
  { kind: 'prediction', id: predictionId }, { kind: 'evidence', id: note.id }]
 const handoff = { ...draft, references }
 await assert.rejects(send({ ...handoff, slotId: 'baseline' }), /another task or slot/)
 await assert.rejects(send({ ...draft, references: [{ kind: 'evidence', id: 'missing-evidence' }] }), /Evidence unavailable/)
 const sent = await send(handoff)
 assert.equal(sent.duplicate, false)
 assert.equal(sent.tick, 36)
 assert.equal(sent.handoff.acceptBeforeTick, 1800)
 const [commitment, linkedPlan, prediction, evidence] = sent.handoff.references
 assert.equal(commitment.planId, linkedPlan.id)
 assert.equal(commitment.planHash, linkedPlan.hash)
 assert.equal(prediction.modelId, modelId)
 assert.equal(evidence.revision, 1)
 const replay = await send(handoff)
 assert.deepEqual(replay, { ...sent, duplicate: true })
 await assert.rejects(send(handoff, { text: 'Different next step.' }), /different input/)
 const delivery = (await multi.call('notices.list')).filter(notice => notice.id === `mail:${sent.messageId}`)
 assert.equal(delivery.length, 1)
 assert.deepEqual(JSON.parse(delivery[0].text).message.handoff, sent.handoff)
 assert.equal((await multi.call('status')).tick, 36)
 if (teamSize === 8) {
  const verify = await tool(multi, 'verifier', 'research_read', { kind: 'action', id: commitmentId })
  assert.equal(verify.current.id, commitmentId)
  assert.equal(verify.current.actorId.split('@')[0], 'service')
 }
 await write(serviceRole, 'research_write', 'amend-note', { ...note, expectedRevision: 1, content: { fixture: true, updated: true } })
 await nextStep('m4', 48)
 assert.deepEqual(await send(handoff), { ...sent, duplicate: true })
 await tool(multi,'brain','mars_send',{to:'water',text:'durable native mail'})
 const summaryFailure = { sessionId: sid(lastRole), messageId: 'fixture-summary-overflow', reason: 'context_overflow' }
 await multi.call('model.aux', { sessionId: sid(lastRole), active: true })
 assert.deepEqual(await multi.call('model.aux-failure', summaryFailure), { recorded: true, duplicate: false })
 await multi.close()
 multi=launch('multi',true)
 const restoredTeam = (await multi.call('hello')).status
 assert.equal(restoredTeam.participants.length, teamSize)
 assert.deepEqual(restoredTeam.round.recentCompactionFailures, [{ role: lastRole, tick: 48, decisionTick: 48, reason: 'context_overflow' }])
 assert.deepEqual(await multi.call('model.aux-failure', summaryFailure), { recorded: false, duplicate: true })
 const failureMail = (await tool(multi,'brain','mars_inbox')).messages.filter(message=>message.text.includes('上下文压缩因上下文过长失败'))
 assert.equal(failureMail.length,1)
 assert.deepEqual(JSON.parse(readFileSync(join(fixture,'multi/manifest.public.json'),'utf8')).roles, roles)
 assert.deepEqual(await send(handoff), { ...sent, duplicate: true })
 assert.ok((await tool(multi,'water','mars_inbox')).messages.some(message=>message.text==='durable native mail'))
 const message = (await tool(multi, 'agronomist', 'mars_inbox')).messages.find(message => message.id === sent.messageId)
 assert.deepEqual(message.handoff, sent.handoff)
 assert.ok(!(await tool(multi, 'agronomist', 'mars_inbox')).messages.some(message => message.id === sent.messageId))
 const submission = await write('agronomist', 'research_submit', 'submit-from-handoff', { taskId: message.handoff.taskId, slotId: message.handoff.slotId,
  payload: { modelId: prediction.modelId, predictionId: prediction.id, commitmentIds: [commitment.id] },
  evidence: [{ id: evidence.id, revision: evidence.revision, purpose: 'current-estimate' }], expectedRevision: 0 }, { action: 'submit' })
 await multi.call('advance', { steps: 12 })
 const accepted = (await tool(multi, 'agronomist', 'round_receipts')).find(receipt => receipt.callId === submission.callId)
 assert.equal(accepted.result.revision, 1)
 assert.deepEqual(accepted.result.references.find(ref => ref.kind === 'commitment'), { kind: 'commitment', id: commitment.id, hash: commitment.hash })
 console.log('PASS verified references support recipient submission, retry and restart preserve one exact handoff, and plain mail survives')
 if (teamSize === 8 && !process.argv.includes('--quick')) {
  const before = (await multi.call('status')).tick
  await multi.call('advance', { steps: 1800 - before }, 0)
  await assert.rejects(enter(multi, 'verifier', 'after-final'), /admission.*closed/i)
  await multi.call('advance', { steps: 600 }, 0)
  const ended = await multi.call('status')
  assert.equal(ended.tick, 2400)
  assert.equal(ended.round.finalized, true)
  const view = await multi.call('stages')
  assert.deepEqual(view.seals.map(seal => seal.tick), [720, 1800, 2400])
  assert.ok(view.seals.find(seal => seal.stage === 'final').selections.some(selected => selected.taskId === 'T3'))
  console.log('PASS eight-role world seals T3 and reaches 2400 with the original three boundaries')
 }
 console.log(JSON.stringify({passed:true,fixture,teamSize,modelCalls:0}))
}finally{await single?.close();await multi?.close()}
