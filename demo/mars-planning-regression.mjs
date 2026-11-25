#!/usr/bin/env node
/** Plan admission, durable block feedback and old short-reference recovery; no external model. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const {V05Planning,PlanAdmissionError}=await import(pathToFileURL(join(root,'app/science-harness/integrations/ai4science/mars/v05/planning.ts')).href)
const {planHash}=await import(pathToFileURL(join(root,'app/science-harness/integrations/ai4science/mars/v06/actions.ts')).href)
{
 const facts=[],changes=[],states=new Map();let occupied=1
 const engine={readFacts:()=>facts,recordFact:(context,kind,data)=>facts.push({actorId:context.actorId,kind,data})}
 const plans=new V05Planning(engine,{actorId:'fixture'},()=>0,{robot:1},{resourcesOf:()=>[{resource:'robot',quantity:1}],occupied:()=>occupied,
  onBlocked:(...args)=>changes.push(args)},'v06')
 const requestWithRobot={title:'Blocked then admitted',steps:[{id:'one',providerId:'water',input:{}}]}
 const plan=plans.schedule('new',requestWithRobot),hash=planHash(plan)
 const reservation=plans.reserve('planning-window',{resource:'robot',start:0,end:10})
 const inspected=plans.inspect(requestWithRobot,0)
 assert.deepEqual(inspected.diagnostics.steps[0].resources,[{resource:'robot',occupiedNow:true,reservationConflict:[reservation.id]}])
 assert.equal(inspected.diagnostics.steps[0].missesDeadline,false)
 plans.release('free-planning-window',reservation.id,reservation.revision)
 const submit=async()=>({id:'op-one',state:'running'})
 await plans.advance(submit,id=>states.get(id));const blocked=plans.list()[0]
 assert.equal(blocked.blocked.one.reason,'Resource unavailable: robot');assert.equal(changes.length,1)
 const count=facts.length;await plans.advance(submit,id=>states.get(id));assert.equal(facts.length,count,'Unchanged block reasons must not append every tick')
 occupied=0;await plans.advance(submit,id=>states.get(id));assert.equal(plans.list()[0].blocked,undefined)
 states.set('op-one','succeeded');await plans.advance(submit,id=>states.get(id));assert.equal(plans.list()[0].state,'succeeded');assert.equal(planHash(plans.list()[0]),hash)
 const invalid=new V05Planning(engine,{actorId:'invalid'},()=>0,{robot:1},{resourcesOf:()=>[{resource:'robot',quantity:1}],
  validateInput:()=>{throw new PlanAdmissionError('Sample depleted',true)}},'v06')
 assert.throws(()=>invalid.schedule('bad',{title:'Bad input',steps:[{id:'bad',providerId:'water',input:{}}]}),/depleted/)
 let consumed=false,rejectAll=false
 const dynamic=new V05Planning(engine,{actorId:'idempotent'},()=>0,{robot:1},{resourcesOf:()=>[{resource:'robot',quantity:1}],
  validateInput:(_provider,input)=>{if(rejectAll||consumed&&input.marker==='used')throw new PlanAdmissionError('Sample depleted',true)}},'v06')
 const request={title:'Amend future work',steps:[{id:'done',providerId:'water',input:{marker:'used'}},{id:'later',providerId:'water',input:{marker:'future'},at:10}]}
 const original=dynamic.schedule('schedule-once',request)
 await dynamic.advance(async()=>({id:'accepted-once',state:'running'}),()=> 'running');consumed=true
 assert.throws(()=>dynamic.check(request),/depleted/)
 const beforeReplay=facts.length;assert.deepEqual(dynamic.schedule('schedule-once',request),original);assert.equal(facts.length,beforeReplay)
 const prior=dynamic.list().find(p=>p.id===original.id),changed={...request,title:'Amended future work',steps:request.steps.map(s=>s.id==='later'?{...s,at:11}:s)}
 const amended=dynamic.amend('amend-once',prior.id,prior.revision,changed);assert.deepEqual(amended.operations,prior.operations)
 assert.throws(()=>dynamic.amend('rewrite-accepted',amended.id,amended.revision,{...changed,steps:changed.steps.map(s=>s.id==='done'?{...s,input:{marker:'replacement'}}:s)}),/accepted step/)
 rejectAll=true;const beforeAmendReplay=facts.length
 assert.deepEqual(dynamic.amend('amend-once',prior.id,prior.revision,changed),amended);assert.equal(facts.length,beforeAmendReplay)
}
console.log('PASS idempotent schedule/amend replays survive resource changes; accepted steps stay immutable while future work can change')
console.log('PASS block reasons are durable and deduplicated; admission clears only its block and preserves the frozen plan hash')
mkdirSync(join(root,'demo/.checks'),{recursive:true})
const fixture=mkdtempSync(join(root,'demo/.checks/planning-')),home=join(fixture,'single'),sessionId='planning_single'
const launch=()=>connectSidecar(spawn(process.execPath,['--experimental-transform-types',join(root,'app/mars-server.mjs'),
 '--home',home,'--truth',join(root,'data/mars/truth.json'),'--mode','single','--auto-clock','0','--checkpoint-interval','0','--model-source','scripted-integration'],
 {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}}),{label:'Planning regression',log:chunk=>process.stderr.write(chunk)})
let rpc
const tool=async(name,args={})=>(await rpc.call('tools.call',{sessionId,name,args})).result
const check=plan=>tool('experiment_plan',{action:'check',input_json:JSON.stringify(plan)})
try{
 rpc=launch();await rpc.call('hello');await rpc.call('login',{sessionId,role:'single'});await rpc.call('run.start',{sessionId})
 const lab=new DatabaseSync(join(home,'device/laboratory.sqlite'),{readOnly:true});let ref,id
 try{const world=JSON.parse(lab.prepare('SELECT state FROM world WHERE id=1').get().state),index=world.samples.findIndex(s=>s.id!=='qc-blank'&&s.projectId==='mars'&&s.state==='raw'&&s.volumeUl>0);assert.ok(index>=0);ref=`s-${index+1}`;id=world.samples[index].id}finally{lab.close()}
 const command=sampleId=>({action:'transfer',deviceId:'robot-1',sampleId,destination:'heater-2'})
 const invalid={title:'Unknown sample',steps:[{id:'one',providerId:'water',input:command('s-99999')}]}
 await assert.rejects(check(invalid),/Step one: Unknown|inaccessible/)
 const publicSample={title:'Public sample',steps:[{id:'draw',tool:'water_sample',args:{source_id:'reservoir',volume_ul:100,container:'vial'}}]}
 const missingVolume={title:'Public sample',steps:[{id:'draw',tool:'water_sample',args:{source_id:'reservoir',container:'vial'}}]}
 await assert.rejects(check(missingVolume),/Step draw: volume_ul/)
 await assert.rejects(check({title:'Nested operation',steps:[{id:'draw',tool:'water_assay',args:{source_id:'reservoir'}}]}),/Step draw: Unknown plan tool/)
 await assert.rejects(check({title:'Mixed node',steps:[{...publicSample.steps[0],providerId:'water'}]}),/Step draw: .*providerId/)
 await assert.rejects(check({title:'Case mismatch',steps:[{...publicSample.steps[0],args:{sourceId:'reservoir',volume_ul:100,container:'vial'}}]}),/Step draw: .*source_id/)
 const queued=await tool('experiment_plan',{action:'schedule',request_key:'bad',input_json:JSON.stringify(invalid)})
 const withoutKey=await tool('experiment_plan',{action:'schedule',input_json:JSON.stringify(publicSample)})
 await rpc.call('advance',{steps:1})
 const earlyReceipts=await tool('round_receipts')
 assert.equal(earlyReceipts.find(r=>r.callId===queued.callId).result.isError,true)
 assert.match(earlyReceipts.find(r=>r.callId===withoutKey.callId).result.error,/request_key is required for action=schedule/)
 assert.deepEqual(await tool('experiment_plan',{action:'list'}),[])
 const normalized=await check({title:'Short sample',steps:[{id:'s-1',providerId:'water',input:command(ref)}]})
 assert.equal(normalized.steps[0].id,'s-1');assert.equal(normalized.steps[0].input.sampleId,id)
 const dag=await check({title:'Deferred sample',steps:[{id:'s-1',providerId:'water',input:{action:'sample',sourceId:'reservoir',container:'vial',volumeUl:200}},
  {id:'carry',providerId:'water',dependsOn:['s-1'],input:command('$step:s-1:outputSampleId')}]})
 assert.equal(dag.steps[0].id,'s-1');assert.deepEqual(dag.steps[1].dependsOn,['s-1'])
 await assert.rejects(check({title:'Fake placeholder',steps:[{id:'one',providerId:'water',input:command('v05-deferred-output-s-1-outputSampleId')}]}),/Unknown|inaccessible/)
 const runId=JSON.parse(readFileSync(join(home,'run.json'),'utf8')).runId
 await rpc.close();rpc=null
 const labWrite=new DatabaseSync(join(home,'device/laboratory.sqlite'))
 try{const world=JSON.parse(labWrite.prepare('SELECT state FROM world WHERE id=1').get().state);world.samples.find(s=>s.id==='qc-blank').volumeUl=0;labWrite.prepare('UPDATE world SET state=? WHERE id=1').run(JSON.stringify(world))}finally{labWrite.close()}
 const db=new DatabaseSync(join(home,'execution/execution.sqlite'))
 try{
 const insert=db.prepare('INSERT INTO events(project_id,operation_id,type,data_json,at) VALUES (?,NULL,?,?,?)')
 for(const[planId,sampleId]of [['legacy-depleted','qc-blank'],['legacy-short',ref]]){
  const plan={id:planId,actorId:`single@${sessionId}`,revision:1,title:planId,state:'scheduled',createdTick:1,operations:{},steps:[{id:'s-1',providerId:'water',input:command(sampleId),at:0,dependsOn:[],reservationIds:[]}]}
  insert.run('mars','fact',JSON.stringify({actorId:plan.actorId,kind:'mars-v06-plan-mutation',logicalTick:1,data:{key:'seed-'+planId,input:'fixture',result:plan}}),new Date().toISOString())
 }
 }finally{db.close()}
 rpc=launch();assert.equal((await rpc.call('hello')).status.tick,1);assert.equal(JSON.parse(readFileSync(join(home,'run.json'),'utf8')).runId,runId)
 await assert.rejects(check({title:'Depleted',steps:[{id:'one',providerId:'water',input:command('qc-blank')}]}),/no remaining volume/)
 await rpc.call('advance',{steps:1})
 const plans=await tool('experiment_plan',{action:'list'}),failed=plans.find(p=>p.id==='legacy-depleted'),running=plans.find(p=>p.id==='legacy-short')
 assert.equal(failed.state,'partial_failed');assert.match(failed.failureReason,/no remaining volume/)
 assert.ok(running.operations['s-1'],'Restored valid short refs must dispatch real work')
 const verify=new DatabaseSync(join(home,'execution/execution.sqlite'),{readOnly:true})
 try{
  const input=JSON.parse(verify.prepare('SELECT input_json FROM operations WHERE id=?').get(running.operations['s-1']).input_json);assert.equal(input.sampleId,id)
  const original=JSON.parse(verify.prepare("SELECT data_json FROM events WHERE type='fact' AND json_extract(data_json,'$.data.key')='seed-legacy-short'").get().data_json);assert.equal(original.data.result.steps[0].input.sampleId,ref)
 }finally{verify.close()}
 await rpc.call('advance',{steps:1})
 const inbox=await tool('mars_inbox');assert.ok(inbox.messages.some(m=>m.text.includes('[计划失败]')&&m.text.includes('legacy-depleted')))
 assert.equal((await rpc.call('status')).round.clock.failure,null)
 const tick = (await rpc.call('status')).tick
 await rpc.call('advance', { steps: 12 - tick })
 const scan = { title: 'Public scan', steps: [{ id: 'scan', at: 120, tool: 'greenhouse_scan', args: { chamber_id: 'incubator-1' } }] }
 const inspected = await check(scan)
 const first = await tool('experiment_plan', { action: 'schedule', request_key: 'same-scan', input_json: JSON.stringify(scan) })
 await rpc.call('advance', { steps: 12 })
 const original = (await tool('round_receipts')).find(row => row.callId === first.callId).result
 assert.ok(!original.isError, original.error)
 const replay = await tool('experiment_plan', { action: 'schedule', request_key: 'same-scan', input_json: JSON.stringify(inspected.plan) })
 await rpc.call('advance', { steps: 12 })
 assert.deepEqual((await tool('round_receipts')).find(row => row.callId === replay.callId).result, original)
 assert.equal((await tool('experiment_plan', { action: 'list' })).filter(plan => plan.title === scan.title).length, 1)
 console.log('PASS public syntax and normalized plans share one durable request receipt')
 console.log('PASS static checks reject unknown/depleted samples, preserve step IDs and allow declared deferred outputs')
 console.log('PASS old invalid plans terminate with one actionable owner notification; valid old short refs execute without rewriting history')
 console.log(JSON.stringify({passed:true,fixture,realModelCalls:0,productionDataWrites:0}))
}finally{if(rpc)await rpc.close()}
