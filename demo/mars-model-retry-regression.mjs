#!/usr/bin/env node
/** Error-triggered retries reuse one scientific slot and respect an explicit stop. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
mkdirSync(join(root,'demo/.checks'),{recursive:true});const home=mkdtempSync(join(root,'demo/.checks/model-retry-'))
const sessionId='retry_single',rpc=connectSidecar(spawn(process.execPath,['--experimental-transform-types',join(root,'app/mars-server.mjs'),
 '--home',home,'--truth',join(root,'data/mars/truth.json'),'--mode','single','--checkpoint-interval','0','--model-source','scripted-integration'],
 {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}}),{label:'Model retry regression',log:chunk=>process.stderr.write(chunk)})
try{
 await rpc.call('hello');await rpc.call('login',{sessionId,role:'single'});await rpc.call('busy.set',{sessions:[sessionId]});await rpc.call('run.start',{sessionId})
 await rpc.call('tools.call',{sessionId,name:'mars_inbox',args:{}})
 await rpc.call('decision.enter',{sessionId,key:'step-zero',messageId:'msg-original'})
 await rpc.call('model.verify',{sessionId,messageId:'msg-bad',active:true})
 await rpc.call('session.idle',{sessionId})
 assert.equal((await rpc.call('status')).tick,0,'Verification protects the slot after normal EOS')
 const request={sessionId,key:'step-zero',messageId:'msg-bad',reason:'text_tool_call'}
 const retry=await rpc.call('model.retry',request);assert.equal(retry.accepted,true)
 assert.equal((await rpc.call('model.retry',request)).reason,'retry_limit')
 await rpc.call('model.verify',{sessionId,messageId:'msg-bad',active:false})
 await rpc.call('busy.set',{sessions:[]})
 await rpc.call('notices.ack',{id:retry.noticeId,messageId:'msg-retry'})
 assert.equal((await rpc.call('status')).tick,0,'Acknowledged notices reserve admission until the corresponding model enters')
 const grant=await rpc.call('decision.enter',{sessionId,key:'step-zero',messageId:'msg-retry',noticeId:retry.noticeId})
 assert.equal(grant.tick,0);assert.equal(grant.retry,true)
 await rpc.call('model.verify',{sessionId,messageId:'msg-bad-again',active:true})
 assert.equal((await rpc.call('model.retry',{...request,messageId:'msg-bad-again'})).reason,'retry_limit')
 await rpc.call('model.verify',{sessionId,messageId:'msg-bad-again',active:false})
 const stopped=await rpc.call('session.idle',{sessionId,cancelled:true,cancellationId:'abort-one'});assert.equal(stopped.idle,true)
 assert.equal((await rpc.call('session.idle',{sessionId,cancelled:true,cancellationId:'abort-one'})).duplicate,true)
 await assert.rejects(rpc.call('decision.enter',{sessionId,key:'step-zero',messageId:'msg-retry',noticeId:retry.noticeId}),/decision cancelled/)
 const db=new DatabaseSync(join(home,'execution/execution.sqlite'),{readOnly:true})
 try{
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-native-model-retry'").get().n,1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-native-decision'").get().n,1)
 }finally{db.close()}
 console.log('PASS one durable retry per scientific key, preserved logical slot and explicit-stop notice cancellation')
 console.log(JSON.stringify({passed:true,home,realModelCalls:0}))
}finally{await rpc.close()}
