#!/usr/bin/env node
/** Drive the installed opencode through a deterministic localhost model. Never contacts a real model. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { once } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
const executable=process.argv[2]
if(!executable)throw new Error('Pass the installed opencode executable')
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
mkdirSync(join(root,'demo/.checks'),{recursive:true})
const fixture=mkdtempSync(join(root,'demo/.checks/native-engine-'))
const workspace=join(fixture,'workspace'),home=join(fixture,'single')
mkdirSync(join(workspace,'.opencode/agents'),{recursive:true})
cpSync(join(root,'app/workspace/.opencode/agents/mars.md'),join(workspace,'.opencode/agents/mars.md'))
for(const target of [join(workspace,'.opencode'),join(fixture,'xdg/config/opencode')]){
 mkdirSync(target,{recursive:true})
 for(const file of ['package.json','package-lock.json'])cpSync(join(root,'app/workspace/.opencode',file),join(target,file))
 cpSync(join(root,'app/workspace/.opencode/node_modules'),join(target,'node_modules'),{recursive:true})
}
const requests=[]
const testFailedCompaction=process.argv.includes('--fail-compaction')
const testContextOverflow=testFailedCompaction||process.argv.includes('--context-overflow')
const testTextProtocol=process.argv.includes('--text-tool-error')
assert.ok(!testFailedCompaction||!testTextProtocol,'Run the failure and text protocol fixtures separately')
const modelOutputLimit=testFailedCompaction?30000:1000
const managedIndex=process.argv.indexOf('--managed-plugin'),managedPlugin=managedIndex>=0?process.argv[managedIndex+1]:null
let actionIndex=0,overflowInjected=false,protocolInjected=false
const actions=[
 ['mars_login',{role:'single'}],['mars_start',{}],
 ['device_calibrate',{device_id:'confirm',request_key:'real-native-calibration'}],
 ['round_receipts',{}],['mars_wait',{until_tick:36}],
]
const tick=()=>{
 const db=new DatabaseSync(join(home,'device/laboratory.sqlite'),{readOnly:true})
 try{return JSON.parse(db.prepare('SELECT state FROM world WHERE id=1').get().state).tick}finally{db.close()}
}
const model=createServer(async(req,res)=>{
 if(!req.url.endsWith('/chat/completions')){res.writeHead(404);res.end('Only local chat completions are installed');return}
 const chunks=[];for await(const chunk of req)chunks.push(chunk)
 const body=JSON.parse(Buffer.concat(chunks).toString('utf8'))
 const n=requests.length+1
 const compaction=testContextOverflow&&overflowInjected&&!(body.tools?.length)
 const overflow=testContextOverflow&&!overflowInjected&&actionIndex===3
 const textProtocol=testTextProtocol&&!protocolInjected&&!overflow&&!compaction&&actionIndex===3
 const system=body.messages.filter(m=>m.role==='system').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n')
 requests.push({n,tick:tick(),model:body.model,tools:body.tools?.length??0,kind:overflow?'overflow':compaction?'compaction':textProtocol?'text-protocol':'science',maxOutputTokens:body.max_tokens??body.max_completion_tokens,
  mainSystem:system.includes('MARS_MAIN_ONLY_FIXTURE'),resumeSystem:system.includes('MARS_RESUME_AFTER_COMPACTION'),managedCompaction:JSON.stringify(body.messages).includes('DEEPWORKS_COMPACTION_INJECT_V1')})
 if(overflow||testFailedCompaction&&compaction){
  if(overflow)overflowInjected=true
  res.writeHead(400,{'content-type':'application/json'})
  res.end(JSON.stringify({error:{message:"This model's maximum context length is 131072 tokens. However, you requested 32000 output tokens and your prompt contains at least 99073 input tokens, for a total of at least 131073 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=99073)",type:'invalid_request_error',param:'input_tokens',code:'context_length_exceeded'}}))
  return
 }
 if(textProtocol)protocolInjected=true
 const action=compaction||textProtocol?undefined:actions[actionIndex++]
 const text=textProtocol?'<invoke name="device_calibrate"><parameter name="device_id">screen</parameter><parameter name="request_key">text-must-not-run</parameter></invoke></｜DSML｜tool_calls>':compaction?'COMPACTED_FIXTURE_CONTEXT':'NATIVE_OK'
 const delta=action?{role:'assistant',tool_calls:[{index:0,id:'call_native_'+n,type:'function',function:{name:action[0],arguments:JSON.stringify(action[1])}}]}:{role:'assistant',content:text}
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
 const base={id:'chatcmpl_native_'+n,object:'chat.completion.chunk',created:1700000000,model:body.model}
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n')
 res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}})+'\n\n')
 res.end('data: [DONE]\n\n')
})
model.listen(0,'127.0.0.1');await once(model,'listening')
const modelPort=model.address().port
const configFile=join(fixture,'science.json')
writeFileSync(configFile,JSON.stringify({home:join(fixture,'sampling'),server:join(root,'app/science/server.mjs'),llmProxy:{enabled:false},systemPrompt:'MARS_MAIN_ONLY_FIXTURE: use the real scientific tools; do not summarize the task.',
 mars:{enabled:true,mode:'single',dual:false,server:join(root,'app/mars-server.mjs'),home,truth:join(root,'data/mars/truth.json'),salt:'a'.repeat(64),checkpointIntervalTicks:0,modelSource:'scripted-integration',modelBarrier:true,stageProfile:{baselineTick:24,finalTick:60,horizon:84}}}))
const prepared=spawnSync(process.execPath,[join(root,'demo/mars-prepare.mjs'),'--config',configFile],{windowsHide:true,encoding:'utf8',timeout:360000,env:{...process.env,NODE_NO_WARNINGS:'1'}})
assert.equal(prepared.status,0,prepared.error?.message??prepared.stderr)
writeFileSync(join(workspace,'opencode.json'),JSON.stringify({default_agent:'mars',model:'fixture/native',small_model:'fixture/native',snapshot:false,
 compaction:{auto:true,reserved:20000},
 plugin:[pathToFileURL(join(root,'app/workspace/.opencode/plugin/science.js')).href,...managedPlugin?[pathToFileURL(resolve(managedPlugin)).href]:[]],agent:{title:{disable:true}},
 provider:{fixture:{npm:'@ai-sdk/openai-compatible',name:'Local deterministic fixture',options:{baseURL:`http://127.0.0.1:${modelPort}/v1`,apiKey:'fixture-only'},models:{native:{limit:{context:131072,output:modelOutputLimit}}}}}}))
const free=createNetServer().listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(resolve=>free.close(resolve))
const child=spawn(executable,['--print-logs','--log-level','DEBUG','serve','--hostname','127.0.0.1','--port',String(port)],{cwd:workspace,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,
 SCIENCE_CONFIG:configFile,SCIENCE_HOME:join(fixture,'sampling'),SCIENCE_MARS_HOME:home,
 XDG_CONFIG_HOME:join(fixture,'xdg/config'),XDG_DATA_HOME:join(fixture,'xdg/data'),XDG_STATE_HOME:join(fixture,'xdg/state'),
 OPENCODE_CONFIG_CONTENT:'{"agent":{"title":{"disable":false}}}',OPENCODE_SERVER_USERNAME:'opencode',OPENCODE_SERVER_PASSWORD:'fixture-only',OPENCODE_DISABLE_MODELS_FETCH:'1',NODE_NO_WARNINGS:'1'}})
let log='';child.stdout.on('data',data=>{log+=data});child.stderr.on('data',data=>{log+=data})
child.on('error',error=>{log+='spawn: '+error.message})
child.on('exit',(code,signal)=>{log+='\nexit: '+code+' '+signal})
let phase='listen'
const headers={authorization:'Basic '+Buffer.from('opencode:fixture-only').toString('base64'),'content-type':'application/json'}
const api=async(path,body,timeoutMs=60000)=>{
 const url=new URL(path,`http://127.0.0.1:${port}`);url.searchParams.set('directory',workspace)
 const response=await fetch(url,{method:body===undefined?'GET':'POST',headers,...body===undefined?{}:{body:JSON.stringify(body)},signal:AbortSignal.timeout(timeoutMs)})
 const text=await response.text();assert.equal(response.status,200,path+': '+response.status+' '+text.slice(0,600));return text?JSON.parse(text):null
}
try{
 const deadline=Date.now()+120000
 while(true){try{await api('/global/health',undefined,700);break}catch(error){if(Date.now()>deadline||child.exitCode!==null)throw error;await delay(100)}}
 phase='session-create'
 const session=await api('/session',{})
 phase='model-loop'
 const answer=await api(`/session/${session.id}/message`,{parts:[{type:'text',text:'Use mars_login(single), mars_start, device_calibrate(confirm), round_receipts, mars_wait until tick 36, then finish. Local integration fixture.'}]},120000)
 if (!testFailedCompaction) assert.ok(!answer.info?.error,JSON.stringify(answer.info?.error))
 if(testTextProtocol){
  phase='format-retry'
  let finished=false
  const deadline=Date.now()+120000
  while(Date.now()<deadline){
   const rows=await api(`/session/${session.id}/message`)
   if(rows.some(row=>row.info?.role==='assistant'&&row.info.time?.completed&&row.parts?.some(part=>part.type==='text'&&part.text==='NATIVE_OK'))){finished=true;break}
   await delay(100)
  }
  assert.ok(finished,'A stranded text tool envelope must recover through one same-step retry')
 }
 const scientific=requests.filter(request=>request.kind==='science')
 if(!testFailedCompaction){
  assert.ok(scientific.length>=6,'Real engine must drive the tool loop')
  assert.deepEqual(scientific.slice(0,5).map(request=>request.tick),[0,0,0,12,24])
  assert.ok(scientific[5].tick>=36)
 }
 assert.ok(requests.every(request=>request.maxOutputTokens<=modelOutputLimit),'All requests must honor the configured output limit')
 if(testContextOverflow){
  assert.equal(requests.filter(request=>request.kind==='overflow').length,1)
  assert.equal(requests.filter(request=>request.kind==='compaction').length,1,'The engine must recover through real compaction')
  assert.ok(requests.filter(request=>request.kind==='overflow'||request.kind==='compaction').every(request=>request.tick===12),'Overflow and compaction hold the same logical position')
  assert.ok(requests.filter(request=>request.kind==='compaction').every(request=>!request.mainSystem),'The scientific execution prompt must not contaminate the summary model')
  const summarizedAt=requests.findIndex(request=>request.kind==='compaction')
  if(testFailedCompaction)assert.ok(requests[summarizedAt].maxOutputTokens<=4096,'Real auxiliary request must honor the summary cap')
  else assert.equal(requests.slice(summarizedAt+1).find(request=>request.kind==='science'||request.kind==='text-protocol').resumeSystem,true)
 }
 if(testTextProtocol){assert.equal(requests.filter(request=>request.kind==='text-protocol').length,1);assert.equal(requests.find(request=>request.kind==='text-protocol').tick,12)}
 if(managedPlugin){assert.ok(requests.some(request=>request.kind==='compaction'&&request.managedCompaction),'The real installed compaction plugin must execute');assert.ok(!log.includes('%7Bid%7D'),'SDK compatibility must resolve the legacy session path')}
 const db=new DatabaseSync(join(home,'device/laboratory.sqlite'),{readOnly:true})
 try{const state=JSON.parse(db.prepare('SELECT state FROM world WHERE id=1').get().state);assert.equal(state.operations[0].acceptedTick,0);assert.equal(state.operations.length,1,'Tool syntax stranded in text cannot execute a physical mutation')}finally{db.close()}
 const history=new DatabaseSync(join(home,'execution/execution.sqlite'),{readOnly:true})
 let decisions
 try{
  decisions=history.prepare("SELECT data_json FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-native-decision' ORDER BY seq").all().map(row=>JSON.parse(row.data_json).data.tick)
  if(testTextProtocol)assert.equal(history.prepare("SELECT COUNT(*) AS n FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-native-model-retry'").get().n,1,'The text protocol failure creates exactly one auditable retry')
 }finally{history.close()}
 if(testFailedCompaction)assert.deepEqual(decisions,[0,12])
 else assert.ok(decisions.length>=4)
 for(let i=1;i<decisions.length;i++)assert.ok(decisions[i]-decisions[i-1]>=12,'Distinct scientific steps must be separated by logical decision cadence')
 phase='automatic-report'
 let messages,report
 const reportDeadline=Date.now()+120000
 while(Date.now()<reportDeadline){
  messages=await api(`/session/${session.id}/message`)
  report=messages.find(message=>message.info?.role==='user'&&message.parts?.some(part=>part.type==='text'&&part.text.includes('"kind":"mars-final-report"')))
  if(report)break
  await delay(200)
 }
 assert.ok(report,'Host must persist a final report without requesting a model reply')
 assert.equal(tick(),84)
 if(testFailedCompaction){
  const audit=new DatabaseSync(join(home,'execution/execution.sqlite'),{readOnly:true})
  try {
   const failed=audit.prepare("SELECT data_json FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-native-compaction-failed'").all().map(row=>JSON.parse(row.data_json).data)
   assert.equal(failed.length,1)
   assert.deepEqual([failed[0].role,failed[0].tick,failed[0].reason],['single',12,'context_overflow'])
  } finally {audit.close()}
 }
 assert.ok(requests.slice(2).every(request=>request.tick<60),'No model request may start after final model admission closes')
 assert.ok(!messages.some(message=>message.parts?.some(part=>part.type==='tool'&&part.tool==='mars_continue')))
 const configuration=await api('/config')
 assert.equal(configuration.agent.title.disable,true)
 assert.equal(configuration.compaction.auto,true)
 assert.equal(configuration.compaction.reserved,20000)
 console.log(JSON.stringify({passed:true,fixture,requests,decisionTicks:decisions,contextOverflowRecovered:testContextOverflow&&!testFailedCompaction,summaryFailureRecorded:testFailedCompaction,textProtocolRecovered:testTextProtocol,managedSdkCompatible:!!managedPlugin,reportAtTick:84,noModelsAtOrAfter:60,reportNoReply:true,realModelCalls:0}))
}catch(error){console.error(JSON.stringify({passed:false,fixture,error:error.message,cause:error.cause?.message,phase,port,exitCode:child.exitCode,requests,diagnostic:log.slice(-2000)}));process.exitCode=1}
finally{
 await api('/instance/dispose',{},2000).catch(()=>{})
 child.kill();if(child.exitCode===null)await Promise.race([once(child,'exit'),delay(3000)])
 writeFileSync(join(fixture,'engine.log'),log)
 await new Promise(resolve=>model.close(resolve))
}
