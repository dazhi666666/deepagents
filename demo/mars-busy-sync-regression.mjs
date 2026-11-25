#!/usr/bin/env node
/** Control RPC remains responsive across held calls/physical batches; clock failure ends waits explicitly. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
mkdirSync(join(root,'demo/.checks'),{recursive:true})
const home=mkdtempSync(join(root,'demo/.checks/busy-sync-')),sessionId='busy_single'
let diagnostic=''
const rpc=connectSidecar(spawn(process.execPath,['--inspect=127.0.0.1:0','--experimental-transform-types',join(root,'app/mars-server.mjs'),
 '--home',home,'--truth',join(root,'data/mars/truth.json'),'--mode','single','--checkpoint-interval','0','--auto-clock','0','--model-source','scripted-integration'],
 {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}}),
 {label:'Busy sync regression',log:chunk=>{diagnostic+=String(chunk)}})
const control=[];rpc.onEvent(message=>{if(message.event==='mars.control')control.push(message.result)})
const until=async test=>{const end=Date.now()+10000;while(!await test()){if(Date.now()>=end)throw new Error('Fixture state did not become ready');await delay(2)}}
let socket
try{
 await rpc.call('hello');await rpc.call('login',{sessionId,role:'single'});await rpc.call('run.start',{sessionId})
 await rpc.call('tools.call',{sessionId,name:'mars_inbox',args:{}})
 assert.ok(control.some(x=>x.round.started),'State changes must push a control event')
 let heldDone=false
 const held=rpc.call('wait',{sessionId},0).then(value=>{heldDone=true;return value})
 await until(async()=>(await rpc.call('status')).round.waiting===1)
 const started=Date.now(),busy=await rpc.call('busy.set',{sessions:[sessionId]},5000,{lane:'control'})
 assert.equal(busy.busy,1);assert.equal(heldDone,false);assert.ok(Date.now()-started<2000)
 await rpc.call('wait.cancel',{sessionId});await held
 await rpc.call('session.idle',{sessionId,cancelled:true,cancellationId:'fixture-stop'})
 let advanced=false
 const batch=rpc.call('advance',{steps:600},0).then(value=>{advanced=true;return value})
 const reader=new DatabaseSync(join(home,'device/laboratory.sqlite'),{readOnly:true})
 try{
  await until(()=>JSON.parse(reader.prepare('SELECT state FROM world WHERE id=1').get().state).tick>0)
  assert.equal(advanced,false,'The batch must still be running when the control probe starts')
  const snapshot=await rpc.call('control.snapshot',{},5000,{lane:'control'})
  assert.equal(snapshot.round.clock.failure,null);assert.equal(advanced,false,'Physical batches must yield I/O before the batch finishes')
 }finally{reader.close()}
 assert.equal((await batch).tick,600)
 console.log('PASS control events and acknowledgements remain responsive during a held wait and a real physical batch')
 await rpc.call('decision.enter',{sessionId,key:'before-fault'})
 await rpc.call('model.aux',{sessionId,active:true})
 const waiting=rpc.call('wait',{sessionId,untilTick:620},0)
 const gate=rpc.call('decision.enter',{sessionId,key:'after-fault'},0)
 const rejected=assert.rejects(gate,/Mars infrastructure failure: fixture IO failure/)
 await until(async()=>{const s=await rpc.call('status');return s.round.waiting===1&&s.round.decisionsWaiting===1})
 const url=diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0];assert.ok(url)
 socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
 let sequence=0;const pending=new Map()
 socket.addEventListener('message',event=>{const m=JSON.parse(String(event.data)),item=pending.get(m.id);if(item){pending.delete(m.id);clearTimeout(item.timer);m.error?item.reject(new Error(m.error.message)):item.resolve(m.result)}})
 const send=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Inspector timeout'))},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
 const moduleUrl=pathToFileURL(join(root,'app/science-harness/integrations/ai4science/greenhouse/simulation-clock.ts')).href
 const loader=`process.getBuiltinModule('vm').compileFunction(${JSON.stringify(`return import(${JSON.stringify(moduleUrl)})`)},[],{importModuleDynamically:process.getBuiltinModule('vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})()`
 const prototype=(await send('Runtime.evaluate',{expression:`${loader}.then(m=>m.SimulationClock.prototype)`,awaitPromise:true})).result
 const objects=(await send('Runtime.queryObjects',{prototypeObjectId:prototype.objectId})).objects
 const failed=await send('Runtime.callFunctionOn',{objectId:objects.objectId,functionDeclaration:"function(){if(this.length!==1)throw new Error('Unexpected fixture clocks');this[0].fail(new Error('fixture IO failure'));return this[0].status()}",returnByValue:true})
 assert.ok(!failed.exceptionDetails,failed.exceptionDetails?.text);await rejected
 assert.match((await waiting).failure,/fixture IO failure/)
 const status=await rpc.call('status');assert.equal(status.round.clock.failure,'fixture IO failure');assert.equal(status.round.modelAdmissionClosed,false)
 assert.ok(control.some(x=>x.round.clock.failure==='fixture IO failure'))
 for(const [method,params] of [
  ['decision.enter',{sessionId,key:'after-known-fault'}],['wait',{sessionId,untilTick:630}],
  ['run.start',{sessionId}],['model.aux',{sessionId,active:true}],['model.verify',{sessionId,messageId:'after-fault',active:true}],
  ['tools.call',{sessionId,name:'device_calibrate',args:{device_id:'confirm',request_key:'after-fault'}}],['advance',{steps:1}],
 ])await assert.rejects(rpc.call(method,params,5000),/Mars infrastructure failure: fixture IO failure/,method+' must reject a known failed clock')
 await rpc.call('model.aux',{sessionId,active:false})
 assert.equal((await rpc.call('status')).tick,600,'A failed clock cannot silently accept new scientific work or advance time')
 console.log('PASS clock failure releases existing waits, rejects new inference/writes/waits and pushes infrastructure health without declaring model failure')
 console.log(JSON.stringify({passed:true,home,realModelCalls:0}))
}finally{
 if(socket){const closed=once(socket,'close').catch(()=>{});socket.close();await closed}
 await rpc.close()
}
