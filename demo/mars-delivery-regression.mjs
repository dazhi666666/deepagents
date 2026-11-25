#!/usr/bin/env node
/** An idle service owner's two actual analysis results must reach its original session once. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {connectSidecar} from '../app/science/sidecar-rpc.mjs'
import {marsRoster} from '../app/science/mars-roster.mjs'

const base=resolve(dirname(fileURLToPath(import.meta.url)),'..'), scratch=join(base,'demo','.checks')
mkdirSync(scratch,{recursive:true}); const home=mkdtempSync(join(scratch,'r6-receipts-')), roles=marsRoster('multi',8)
const launch=manual=>connectSidecar(spawn(process.execPath,['--experimental-transform-types',join(base,'app/mars-server.mjs'),'--home',home,'--truth',join(base,'data/mars/truth.json'),'--mode','multi','--team-size','8','--auto-clock',manual?'0':'1','--checkpoint-interval','0','--model-source','scripted-integration','--stage-profile','{"baselineTick":96,"finalTick":192,"horizon":240}','--research-workflow','delivery-v2','--joint-trial','pilot-choice-v2'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}}),{label:'Receipt integration'})
const sid=role=>`receipt-${role}`;let rpc=launch(false)
const call=(role,name,args={})=>rpc.call('tools.call',{sessionId:sid(role),name,args}).then(v=>v.result)
const enter=(role,key)=>rpc.call('decision.enter',{sessionId:sid(role),key})
function noticeFor(role){
  let unsubscribe,timer
  return new Promise((ok,fail)=>{
    timer=setTimeout(()=>{unsubscribe();fail(new Error(`Missing real completion notice for ${role}`))},60000)
    unsubscribe=rpc.onEvent(e=>{const n=e.result?.notices?.find(n=>n.role===role && n.kind==='mail' && n.text.includes('[科研回执]'));if(n){clearTimeout(timer);unsubscribe();ok(n)}})
  })
}
try {
  await rpc.call('hello');for(const role of roles)await rpc.call('login',{sessionId:sid(role),role})
  await rpc.call('busy.set',{sessions:roles.map(sid)});await rpc.call('run.start',{sessionId:sid('brain')})
  for(const n of await rpc.call('notices.list'))await rpc.call('notices.ack',{id:n.id})
  for(const role of roles){assert.equal((await enter(role,'initial')).tick,0);await call(role,'mars_inbox')}
  const service=await call('water','service_review');assert.equal(service.commissions.length,3);assert.ok(service.commissions.every(c=>c.timelyMeasurements===0 && c.minimumRemainingUl>0))
  const q={contract:'research_submit',task_id:'T6'}
  const first=await call('service','research_catalog',q),short=await call('service','research_catalog',q)
  assert.ok(first.slots);assert.equal(short.unchanged,true);assert.equal(short.contractTag,first.contractTag)
  const staticBytes=[first,short].map(v=>Buffer.byteLength(JSON.stringify(v)))
  assert.ok(staticBytes[1]<staticBytes[0]/2)
  assert.ok((await call('engineer','research_catalog',q)).slots);assert.ok((await call('service','research_catalog',{...q,refresh:true})).slots)
  const before=await call('service','research_changes'); const event=noticeFor('service')
  const a=await call('service','analysis_run',{code:'return 1'}), b=await call('service','analysis_run',{code:'return 2',follow_up:{task:'T3',backup:'engineer',next:'Continue service scheduling using this result'}})
  assert.ok(a.work.id && b.work.id && a.work.id!==b.work.id);assert.equal(b.work.backup,'engineer')
  for(const role of roles)await rpc.call('session.idle',{sessionId:sid(role)})
  const n=await event;assert.match(n.text,/2 项/);assert.ok(n.tick<12)
  await rpc.call('notices.ack',{id:n.id,messageId:'service-received'});const grant=await enter('service','received');assert.ok(grant.tick>=12 && grant.tick<36)
  const page=await call('service','research_changes',{cursor:before.cursor,device_cursor:before.device_cursor,limit:50});assert.equal(page.items.filter(x=>x.kind==='receipt').length,2)
  const ack=await call('service','round_receipts',{call_id:a.callId});assert.equal(ack.length,1);assert.equal(ack[0].result.output,1)
  const [work]=(await call('service','receipt_work',{action:'list'})).items;assert.equal(work.callId,b.callId)
  const backup=noticeFor('engineer');await rpc.call('session.idle',{sessionId:sid('service'),cancelled:true,cancellationId:'cancel-service'})
  const message=await backup;assert.match(message.text,/Continue service scheduling/);assert.equal((await rpc.call('session.idle',{sessionId:sid('service'),cancelled:true,cancellationId:'cancel-service'})).duplicate,true)
  const inherited=await call('engineer','receipt_work',{action:'get',id:work.id});assert.equal(inherited.owner,'engineer');assert.equal(inherited.result.output,2)
  const source=await call('engineer','receipt_work',{action:'get',id:work.id,include_input:true});assert.equal(source.input.code,'return 2')
  await assert.rejects(call('analyst','receipt_work',{action:'get',id:work.id,include_input:true}),/original input/)
  await rpc.close();rpc=launch(true);await rpc.call('hello');await rpc.call('run.start',{sessionId:sid('brain')});const again=await call('engineer','receipt_work',{action:'get',id:work.id});assert.deepEqual(again,inherited)
  const oldCancel=await rpc.call('session.idle',{sessionId:sid('service'),cancelled:true,cancellationId:'cancel-service'});assert.equal(oldCancel.duplicate,true)
  const inbox=await call('engineer','mars_inbox');assert.equal(inbox.messages.filter(m=>m.text.includes('[科研回执]')).length,1)
  const closed=await call('engineer','receipt_work',{action:'done',id:work.id,revision:again.revision,request_key:'finish'});await rpc.call('advance',{steps:12});assert.ok(!(await call('engineer','round_receipts',{call_id:closed.callId}))[0].result.isError)
  assert.equal((await call('engineer','receipt_work',{action:'list'})).total,0)
  console.log(JSON.stringify({passed:true,ownerNoticeTick:n.tick,nextDecision:grant.tick,backup:again.owner,restored:true,batchReceipts:2,realModelCalls:0}))
}finally{await rpc.close()}
