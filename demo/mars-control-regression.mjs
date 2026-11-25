#!/usr/bin/env node
/** Deterministic control transport checks: ordering, independent worlds, durable deduplication and SDK versions. */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createBusySender, MarsNoticePump } from '../app/science/mars-control.mjs'
import { adaptSessionGet } from '../app/science/opencode-client-compat.mjs'
import { strandedToolEnvelope } from '../app/science/mars-model-format.mjs'
{
 const tools=new Set(['device_calibrate']),envelope='<invoke name="device_calibrate"><parameter name="device_id">screen</parameter></invoke></｜DSML｜tool_calls>'
 assert.deepEqual(strandedToolEnvelope(envelope,tools),{reason:'text_tool_call',tools:['device_calibrate']})
 for(const text of ['Task finished','<invoke name="device_calibrate">quoted tag only</invoke>',envelope.replace('device_calibrate','unknown_tool'),'```xml\n'+envelope+'\n```','`'+envelope+'`'])assert.equal(strandedToolEnvelope(text,tools),null)
 console.log('PASS only a stranded declared native envelope triggers diagnosis; ordinary stops and quoted examples do not')
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const deadline=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Control fixture did not settle')),2000)})])}finally{clearTimeout(timer)}}
class Rpc {
 constructor(notices=[]){this.snapshot={revision:0,round:{started:true,modelAdmissionClosed:false},notices};this.listeners=new Set();this.calls=[];this.acked=deferred()}
 onEvent(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
 emit(snapshot){this.snapshot=snapshot;for(const fn of this.listeners)fn({event:'mars.control',result:structuredClone(snapshot)})}
 async call(method,params){this.calls.push({method,params});if(this.handler)return this.handler(method,params)
  if(method==='control.snapshot')return structuredClone(this.snapshot)
  if(method==='notices.ack'){this.emit({...this.snapshot,revision:this.snapshot.revision+1,notices:this.snapshot.notices.filter(n=>n.id!==params.id)});this.acked.resolve();return{acknowledged:true}}
  if(method==='busy.set')return{busy:params.sessions.length}
  throw new Error('Unexpected idle polling: '+method)
 }
}
const notice=(id,sid='s')=>({id,sessionId:sid,role:'single',kind:'mail',tick:0,text:'Existing work event'})
const sessionClient=()=>{
 const stored=new Map(),prompts=[]
 return{stored,prompts,session:{messages:async({path})=>({data:stored.get(path.id)??[]}),abort:async()=>({}),promptAsync:async({path,body})=>{prompts.push({path,body});stored.set(path.id,[...(stored.get(path.id)??[]),{info:{id:'msg-'+prompts.length},parts:body.parts}]);return{}}}}
}
{
 const rpc=new Rpc(),one=deferred(),two=deferred(),first=deferred(),second=deferred();let n=0
 rpc.handler=async(method,params)=>{assert.equal(method,'busy.set');if(++n===1){first.resolve();await one.promise}else{second.resolve();await two.promise}return{busy:params.sessions.length}}
 const sender=createBusySender(rpc),a=sender.update(['a']);await first.promise
 const b=sender.update([]);one.resolve();await second.promise;assert.deepEqual(sender.accepted(),['a'])
 two.resolve();await Promise.all([a,b]);assert.deepEqual(sender.accepted(),[])
 await sender.update([]);assert.equal(n,2)
 rpc.handler=async()=>{throw new Error('channel unavailable')};await assert.rejects(sender.update(['x']),/channel unavailable/);assert.deepEqual(sender.accepted(),[])
}
{
 const a=new Rpc(),b=new Rpc(),held=deferred(),started=deferred()
 a.handler=async()=>{started.resolve();await held.promise;return{busy:1}}
 const left=createBusySender(a),right=createBusySender(b),pending=left.update(['a']);await started.promise
 await right.update(['b']);assert.deepEqual(right.accepted(),['b']);assert.equal(left.accepted(),null)
 held.resolve();await pending
}
console.log('PASS busy snapshots coalesce in order, retain acknowledged state on failure, and never couple worlds')
{
 const rpc=new Rpc(),client=sessionClient();let prepared=0
 const pump=new MarsNoticePump(rpc,{getClient:()=>client,onState:()=>{},prepareNotice:async()=>{prepared++},retryDelayMs:10})
 await pump.initialize();await pump.start();assert.equal(client.prompts.length,0);assert.equal(pump.retryTimer,null)
 const calls=rpc.calls.length;await pump.deliverPending();assert.equal(rpc.calls.length,calls,'Idle worlds make no status/notices polling calls')
 rpc.emit({...rpc.snapshot,revision:1,notices:[notice('n1')]});await deadline(rpc.acked.promise);await pump.deliverPending()
 assert.equal(client.prompts.length,1);assert.equal(prepared,1)
 rpc.emit({revision:0,round:{started:true},notices:[notice('n1')]});await pump.deliverPending();assert.equal(client.prompts.length,1)
 pump.dispose();assert.equal(rpc.listeners.size,0)
}
{
 const rpc=new Rpc([notice('ambiguous')]),client=sessionClient();let attempts=0
 const post=client.session.promptAsync
 client.session.promptAsync=async args=>{attempts++;await post(args);throw new Error('Response lost after durable store')}
 const pump=new MarsNoticePump(rpc,{getClient:()=>client,onState:()=>{},retryDelayMs:10})
 await pump.initialize();await pump.start();await deadline(rpc.acked.promise)
 assert.equal(attempts,1,'An ambiguous transport error must not duplicate the model activation')
 pump.dispose()
}
{
 const left=new Rpc([notice('left','left')]),right=new Rpc([notice('right','right')]),client=sessionClient(),held=deferred(),started=deferred()
 const list=client.session.messages;let once=true
 client.session.messages=async args=>{if(args.path.id==='left'&&once){once=false;started.resolve();await held.promise}return list(args)}
 const a=new MarsNoticePump(left,{getClient:()=>client,onState:()=>{}}),b=new MarsNoticePump(right,{getClient:()=>client,onState:()=>{}})
 await a.initialize();await b.initialize();const pending=a.start();await started.promise
 await b.start();assert.equal(client.prompts.some(p=>p.path.id==='right'),true);assert.equal(client.prompts.some(p=>p.path.id==='left'),false)
 held.resolve();await pending;a.dispose();b.dispose()
}
console.log('PASS durable event push has no idle polling; ambiguous sends deduplicate and slow worlds do not block peers')
{
 const calls=[],session={get:async options=>{assert.equal(options.path.id,'ses-fixture');calls.push(options);return{data:{id:'ses-fixture'}}}}
 const original=session.get,restore=adaptSessionGet({session})
 await session.get({sessionID:'ses-fixture'});await session.get({path:{id:'ses-fixture'}})
 assert.equal(calls.length,2);assert.throws(()=>session.get({sessionID:'other',path:{id:'ses-fixture'}}),/Conflicting/)
 restore();assert.equal(session.get,original)
 const v2={get:async options=>{assert.equal(options.sessionID,'ses-fixture');return{data:{id:'ses-fixture'}}}}
 const restoreV2=adaptSessionGet({session:v2});await v2.get({path:{id:'ses-fixture'}});restoreV2()
}
const managedAt=process.argv.indexOf('--managed-plugin')
if(managedAt>=0){
 const module=await import(pathToFileURL(process.argv[managedAt+1]).href)
 let malformed=0
 const session={get:async args=>{if(!args.path?.id){malformed++;return{error:{message:'unresolved {id}'}}}return{data:{id:args.path.id}}}}
 const restore=adaptSessionGet({session}),hooks=await module.DeepworksCompactionInject({client:{session}})
 await hooks['experimental.session.compacting']({sessionID:'ses-fixture'},{context:[]})
 assert.equal(malformed,0);restore()
 console.log('PASS installed DeepWorks compaction plugin works with the legacy client without an unresolved session path')
}
console.log(JSON.stringify({passed:true,realModelCalls:0}))
