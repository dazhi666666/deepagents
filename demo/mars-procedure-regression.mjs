#!/usr/bin/env node
/** Invalid water samples must not poison a run; persisted broken procedures settle on recovery. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
mkdirSync(join(root,'demo/.checks'),{recursive:true})
const fixture=mkdtempSync(join(root,'demo/.checks/procedure-recovery-')),home=join(fixture,'single')
const sessionId='procedure_single',missing='sample:missing-procedure-regression'
const launch=manual=>connectSidecar(spawn(process.execPath,['--experimental-transform-types',join(root,'app/mars-server.mjs'),
 '--home',home,'--truth',join(root,'data/mars/truth.json'),'--mode','single','--checkpoint-interval','0',
 '--auto-clock',manual?'0':'1','--model-source','scripted-integration'],
 {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}}),
 {label:'Procedure recovery regression',log:chunk=>process.stderr.write(chunk)})
const tool=async(rpc,name,args={})=>(await rpc.call('tools.call',{sessionId,name,args})).result
const gate=async(rpc,promise)=>{
 let done=false,result,error
 promise.then(value=>{done=true;result=value},failure=>{done=true;error=failure})
 const end=Date.now()+30000
 while(!done&&Date.now()<end){for(const notice of await rpc.call('notices.list'))await rpc.call('notices.ack',{id:notice.id});await delay(5)}
 assert.ok(done,'Decision gate must complete after invalid intent');if(error)throw error;return result
}
let rpc,aliasRef,aliasSampleId
try{
 rpc=launch(false);await rpc.call('hello');await rpc.call('login',{sessionId,role:'single'})
 await rpc.call('busy.set',{sessions:[sessionId]});await rpc.call('run.start',{sessionId})
 await rpc.call('decision.enter',{sessionId,key:'first'})
 const bad=await tool(rpc,'water_assay',{sample_id:missing,method:'confirm',task_id:'bad-sample',request_key:'bad-sample'})
 const valid=await tool(rpc,'device_calibrate',{device_id:'confirm',request_key:'valid-calibration'})
 await rpc.call('model.aux',{sessionId,active:true})
 const next=rpc.call('decision.enter',{sessionId,key:'after-compaction'},0)
 assert.equal((await rpc.call('status')).tick,0)
 await rpc.call('model.aux',{sessionId,active:false})
 assert.equal((await gate(rpc,next)).tick,12)
 const receipts=await tool(rpc,'round_receipts')
 assert.match(receipts.find(r=>r.callId===bad.callId).result.error,/Unknown sample/)
 assert.ok(!receipts.find(r=>r.callId===valid.callId).result.isError)
 assert.deepEqual(await tool(rpc,'mars_procedures'),[])
 assert.equal((await rpc.call('status')).round.clock.failure,null)
 const runId=JSON.parse(readFileSync(join(home,'run.json'),'utf8')).runId
 await rpc.close();rpc=null
 const lab=new DatabaseSync(join(home,'device/laboratory.sqlite'),{readOnly:true})
 try{
  const state=JSON.parse(lab.prepare('SELECT state FROM world WHERE id=1').get().state)
  const index=state.samples.findIndex(sample=>sample.state==='raw'&&sample.volumeUl>=200&&sample.container==='vial')
  assert.ok(index>=0,'Fixture must contain a usable raw sample')
  aliasRef=`s-${index+1}`;aliasSampleId=state.samples[index].id
 }finally{lab.close()}
 const db=new DatabaseSync(join(home,'execution/execution.sqlite'))
 try{
  const fact={actorId:'mars-host',kind:'mars-procedure-created',logicalTick:12,data:{id:'pr-1',kind:'water_assay',actorId:`single@${sessionId}`,requestKey:'legacy-invalid',providers:['water'],robot:'robot-1',taskId:'legacy-invalid',tick:12,sampleId:missing,method:'confirm'}}
  const insert=db.prepare('INSERT INTO events(project_id,operation_id,type,data_json,at) VALUES (?,NULL,?,?,?)')
  insert.run('mars','fact',JSON.stringify(fact),new Date().toISOString())
  insert.run('mars','fact',JSON.stringify({...fact,data:{...fact.data,id:'pr-2',requestKey:'legacy-short-ref',sampleId:aliasRef}}),new Date().toISOString())
 }finally{db.close()}
 rpc=launch(true);assert.equal((await rpc.call('hello')).status.tick,12)
 assert.equal(JSON.parse(readFileSync(join(home,'run.json'),'utf8')).runId,runId)
 const advanced=await rpc.call('advance',{steps:1})
 assert.equal(advanced.tick,13);assert.equal(advanced.round.clock.failure,null)
 const recovered=await tool(rpc,'mars_procedures')
 assert.equal(recovered.length,2);assert.equal(recovered[0].state,'failed');assert.match(recovered[0].detail,/Sample is unavailable/)
 assert.notEqual(recovered[1].state,'failed','A persisted valid short ref must resume instead of being rejected')
 const accepted=await tool(rpc,'water_assay',{sample_id:aliasRef,method:'confirm',task_id:'new-short-ref',request_key:'new-short-ref'})
 assert.notEqual(accepted.state,'failed')
 await rpc.call('advance',{steps:1})
 const check=new DatabaseSync(join(home,'execution/execution.sqlite'),{readOnly:true})
 try{
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-procedure-settled'").get().n,1)
  const step=JSON.parse(check.prepare("SELECT data_json FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-procedure-step' AND json_extract(data_json,'$.data.id')='pr-2' ORDER BY seq LIMIT 1").get().data_json).data
  const input=JSON.parse(check.prepare('SELECT input_json FROM operations WHERE id=?').get(step.operationId).input_json)
  assert.equal(input.sampleId,aliasSampleId,'Restored short refs must dispatch the real sample ID')
  const created=JSON.parse(check.prepare("SELECT data_json FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-procedure-created' AND json_extract(data_json,'$.data.requestKey')='new-short-ref'").get().data_json).data
  assert.equal(created.sampleId,aliasSampleId,'New short refs are canonicalized before persistence')
  const legacy=JSON.parse(check.prepare("SELECT data_json FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-procedure-created' AND json_extract(data_json,'$.data.id')='pr-2'").get().data_json).data
  assert.equal(legacy.sampleId,aliasRef,'Recovery cannot rewrite old procedure facts')
 }finally{check.close()}
 await rpc.call('advance',{steps:10})
 const fresh=await tool(rpc,'water_assay',{source_id:'reservoir',method:'confirm',task_id:'valid-assay',request_key:'valid-assay'})
 assert.notEqual(fresh.state,'failed')
 await rpc.call('advance',{steps:1})
 assert.equal((await rpc.call('status')).round.clock.failure,null)
 console.log('PASS invalid sample rejected before persistence; compaction releases to the next 12-tick window')
 console.log('PASS persisted broken procedure settles once; same run resumes without rolling back time and accepts valid work')
 console.log('PASS new and restored short sample refs dispatch canonical IDs without rewriting historical facts')
 console.log(JSON.stringify({passed:true,fixture,runId,realModelCalls:0}))
}finally{if(rpc)await rpc.close()}
