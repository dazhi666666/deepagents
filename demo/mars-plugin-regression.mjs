#!/usr/bin/env node
/** Real bridge with a simulated fixed roster and independent single conversation. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync,mkdtempSync,writeFileSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { marsRoster } from '../app/science/mars-roster.mjs'
const teamSize = process.argv.includes('--eight') ? 8 : 6
const jointTrial = process.argv.includes('--trial') ? 'paired-growth-v1' : undefined
const roles = marsRoster('multi', teamSize)
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
mkdirSync(join(root,'demo/.checks'),{recursive:true})
const fixture=mkdtempSync(join(root,'demo/.checks/plugin-native-'))
const cfg=join(fixture,'science.json')
writeFileSync(cfg,JSON.stringify({home:join(fixture,'sampling'),llmProxy:{enabled:false},mars:{enabled:true,dual:true,teamSize,jointTrial,modelBarrier:true,modelSource:'scripted-integration',checkpointIntervalTicks:0,home:join(fixture,'multi'),singleHome:join(fixture,'single'),truth:join(root,'data/mars/truth.json'),salt:'a'.repeat(64)}}))
process.env.SCIENCE_CONFIG=cfg
const prepared=spawnSync(process.execPath,[join(root,'demo/mars-prepare.mjs'),'--config',cfg],{windowsHide:true,encoding:'utf8',timeout:360000,env:{...process.env,NODE_NO_WARNINGS:'1'}})
assert.equal(prepared.status,0,prepared.error?.message??prepared.stderr)
const states={},messages=new Map(),titles=new Map(),prompts=[]
let initializing=true,initReads=0,counter=0,statusReads=0
const client={session:{
 status:async()=>{statusReads++;if(initializing)initReads++;return{data:Object.fromEntries(Object.entries(states).filter(([,s])=>s.type!=='idle'))}},
 update:async({path,body})=>{titles.set(path.id,body.title);return{}},
 promptAsync:async({path,body})=>{prompts.push({id:path.id,body});states[path.id]={type:'busy'};const rows=messages.get(path.id)??[];rows.push({info:{id:'msg_fake_'+(++counter),role:'user',sessionID:path.id,agent:'mars',model:{providerID:'fixture',modelID:'native'},time:{created:Date.now()}},parts:body.parts});messages.set(path.id,rows);await hooks?.event({event:{type:'session.status',properties:{sessionID:path.id,status:{type:'busy'}}}});return{}},
 messages:async({path})=>({data:messages.get(path.id)??[]}),
 abort:async({path})=>{states[path.id]={type:'idle'};await hooks?.event({event:{type:'session.status',properties:{sessionID:path.id,status:{type:'idle'}}}});return{}},
}}
globalThis.fetch=async()=>{throw new Error('External network is forbidden in plugin regression')}
const{Science}=await import(pathToFileURL(join(root,'app/workspace/.opencode/plugin/science.js')).href)
const hooks=await Science({client});initializing=false
assert.equal(initReads,0,'Initialization cannot call back into the engine')
const ids=Object.fromEntries([...roles,'single'].map(role=>[role,'ses_plugin_'+role]))
const context=(role,abort=new AbortController())=>({sessionID:ids[role],messageID:'msg_test_'+(++counter),agent:'mars',abort:abort.signal})
const tool=async(role,name,args={},abort)=>JSON.parse(await hooks.tool[name].execute(args,context(role,abort)))
const idle=async role=>{states[ids[role]]={type:'idle'};await hooks.event({event:{type:'session.status',properties:{sessionID:ids[role],status:{type:'idle'}}}});await hooks.event({event:{type:'session.idle',properties:{sessionID:ids[role]}}})}
const event=info=>hooks.event({event:{type:'message.updated',properties:{info}}})
const assistant=(role,more={})=>({id:'usage_'+role,sessionID:ids[role],role:'assistant',time:{completed:1},cost:0,tokens:{input:0,output:0,reasoning:0},...more})
try{
 assert.ok(!hooks.tool.mars_continue,'No self-wake tool in the default scientific protocol')
 const handoff = { taskId:'T3', slotId:'final', references:[{ kind:'commitment', id:'service-commitment' }] }
 assert.deepEqual(hooks.tool.mars_send.args.handoff.parse(handoff), handoff)
 const plannedStep={...handoff,references:[{kind:'plan',id:'service-plan',stepId:'measure'}]}
 assert.deepEqual(hooks.tool.mars_send.args.handoff.parse(plannedStep),plannedStep)
 assert.equal(hooks.tool.mars_send.args.handoff.safeParse({ ...handoff, references:[{ kind:'commitment' }] }).success, false)
 const configuration={agent:{title:{disable:false}}};await hooks.config(configuration);assert.equal(configuration.agent.title.disable,true)
 await hooks['chat.message']({sessionID:'before_login',agent:'mars'},{message:{agent:'mars'},parts:[]})
 await assert.rejects(hooks['tool.execute.before']({sessionID:'before_login',tool:'read'},{}),/disabled/)
 await tool('brain','mars_login',{role:'brain'})
 const initialStatus=client.session.status
 let releaseInitial
 client.session.status=async()=>{statusReads++;return await new Promise(resolve=>{releaseInitial=resolve})}
 const priming=hooks.event({event:{type:'session.status',properties:{sessionID:ids.brain,status:{type:'busy'}}}})
 await hooks.event({event:{type:'session.status',properties:{sessionID:ids.brain,status:{type:'idle'}}}})
 releaseInitial({data:{[ids.brain]:{type:'busy'}}});await priming
 assert.ok(!hooks.lastBusySnapshot().get('multi').includes(ids.brain),'A late initial REST snapshot cannot overwrite a newer idle event')
 client.session.status=initialStatus
 for(const role of Object.keys(ids)){states[ids[role]]={type:'busy'};await hooks.event({event:{type:'session.status',properties:{sessionID:ids[role],status:{type:'busy'}}}});await tool(role,'mars_login',{role})}
 assert.equal(titles.get(ids.brain),'M-brain');assert.equal(titles.get(ids.single),'S-single')
 await assert.rejects(tool('single','mars_login',{role:'brain'}),/already joined/)
 const teamStatus = await tool('brain','mars_status')
 assert.deepEqual(teamStatus.requiredRoles, roles)
 assert.equal(teamStatus.participants.length, teamSize)
 assert.deepEqual((await tool('single','mars_status')).requiredRoles, ['single'])
 if (teamSize === 8) {
  assert.equal(titles.get(ids.service), 'M-service')
  assert.equal(titles.get(ids.verifier), 'M-verifier')
  assert.equal(hooks.tool.mars_wake.args.role.parse('verifier'), 'verifier')
 }
 await assert.rejects(hooks['tool.execute.before']({sessionID:ids.single,tool:'science_delegate'},{}),/disabled/)
 const busy=await tool('brain','mars_wake',{role:'water',message:'Read shared evidence'})
 assert.equal(busy.queued,false);assert.equal(prompts.length,0)
 assert.ok((await tool('water','mars_inbox')).messages.some(message=>message.text==='Read shared evidence'))
 await idle('water')
 await tool('brain','mars_wake',{role:'water',message:'Resume the same role'})
 assert.equal(prompts.length,1);assert.equal(prompts[0].body.agent,'mars')
 await tool('brain','mars_wake',{role:'water',message:'Additional evidence'})
 assert.equal(prompts.length,1)
 await assert.rejects(tool('brain','mars_wake',{role:'water',message:'Block',wait:true}),/barrier/)
 console.log(`PASS ${teamSize + 1} bindings, default-only role titles, cross-world guard, pre-login sandbox and wake deduplication`)
 await event(assistant('single',{time:{},cost:0}))
 await event(assistant('single',{cost:0.1,tokens:{input:100,output:20,reasoning:5}}))
 await event(assistant('single',{cost:0.2,tokens:{input:120,output:25,reasoning:5}}))
 await event(assistant('single',{cost:0.2,tokens:{input:120,output:25,reasoning:5}}))
 await event(assistant('brain',{cost:0.4,tokens:{input:200,output:30,reasoning:10}}))
 const singleBudget=await tool('single','mars_budget'),multiBudget=await tool('brain','mars_budget')
 assert.equal(singleBudget.requests,1);assert.equal(singleBudget.inputTokens,120);assert.equal(singleBudget.outputTokens,30);assert.equal(singleBudget.costUsd,0.2);assert.equal(multiBudget.costUsd,0.4)
 await tool('single','mars_start')
 assert.equal(hooks.tool.research_catalog.args.section.parse('references'),'references')
 assert.equal((await tool('single','experiment_plan',{action:'portfolio'})).asOfTick,0)
 assert.equal((await tool('single','research_catalog',{section:'references',task_id:'T2',reference_kind:'operation'})).expectedRevision,0)
 const trialContract=await tool('single','research_catalog',{contract:'research_submit',task_id:'T6'})
 assert.equal(trialContract.slots[0].payloadSchema.required.includes('trial'),Boolean(jointTrial))
 const user={info:{id:'msg_user_native',sessionID:ids.single,role:'user',agent:'mars',model:{providerID:'fixture',modelID:'native'},time:{created:1}},parts:[{type:'text',text:'Scientific mission'}]}
 const first={messages:[user]}
 await hooks['experimental.chat.messages.transform']({},first)
 assert.equal((await tool('single','mars_status')).tick,0)
 await hooks['experimental.session.compacting']({sessionID:ids.single},{context:[]})
 await tool('single','mars_inbox')
 const abort=new AbortController()
 const waiting=tool('single','mars_wait',{},abort)
 for(let attempt=0;attempt<50;attempt++){if((await tool('single','mars_status')).round.waiting)break;await delay(10)}
 abort.abort();await assert.rejects(waiting,/cancelled/)
 assert.equal((await tool('single','mars_status')).round.waiting,0)
 await hooks.event({event:{type:'session.compacted',properties:{sessionID:ids.single}}})
 console.log('PASS per-world streaming usage accounting and cancellation of the remote event wait')
 const second={messages:[user,{info:{id:'msg_assistant_native0',sessionID:ids.single,role:'assistant',time:{created:2,completed:3}},parts:[{type:'tool',tool:'mars_status',state:{status:'completed'}}]}]}
 await hooks['experimental.chat.messages.transform']({},second)
 assert.equal((await tool('single','mars_status')).tick,12)
 await hooks['chat.params']({sessionID:ids.single,agent:'mars',message:user.info},{})
 assert.equal((await tool('single','mars_status')).tick,12)
 const params={maxOutputTokens:32000}
 await hooks['chat.params']({sessionID:ids.single,agent:'mars',model:{limit:{output:30000}},message:user.info},params)
 assert.equal(params.maxOutputTokens,30000,'Engine parameters cannot exceed the configured output limit')
 for(const error of [{name:'ContextOverflowError',data:{message:'Input too long'}},{name:'APIError',data:{message:"This model's maximum context length is 131072 tokens"}}]){
  await hooks.event({event:{type:'session.error',properties:{sessionID:ids.single,error}}})
  assert.equal((await tool('single','mars_status')).round.modelAdmissionClosed,false,'Context overflow is recoverable and cannot close model admission')
  await hooks['experimental.session.compacting']({sessionID:ids.single},{context:[]})
  await hooks['chat.params']({sessionID:ids.single,agent:'compaction'},{})
  assert.equal((await tool('single','mars_status')).tick,12,'Compaction cannot consume a scientific window')
  await hooks.event({event:{type:'session.compacted',properties:{sessionID:ids.single}}})
  const resumed={messages:[{...user,info:{...user.info,id:'msg_compaction_resume_'+(++counter)}}]}
  await hooks['experimental.chat.messages.transform']({},resumed)
  assert.equal((await tool('single','mars_status')).tick,12,'The failed step resumes in its original window after compaction')
  await hooks['experimental.chat.messages.transform']({},resumed)
  assert.equal((await tool('single','mars_status')).tick,12,'Repeated transforms of the same retry must reuse its grant')
 }
 console.log('PASS context overflow compacts without closing admission or consuming a retry window; output cap follows model configuration')
 const statusImpl=client.session.status,readsBefore=statusReads
 client.session.status=async()=>{statusReads++;throw new Error('engine status unavailable')}
 states[ids.single]={type:'idle'}
 await hooks.event({event:{type:'session.status',properties:{sessionID:ids.single,status:{type:'idle'}}}})
 assert.ok(!hooks.lastBusySnapshot().get('single').includes(ids.single),'An explicit idle event remains authoritative when REST is unavailable')
 assert.equal(statusReads,readsBefore,'Normal busy synchronization must not query engine REST')
 client.session.status=statusImpl
 await hooks.event({event:{type:'session.idle',properties:{sessionID:ids.single}}})
 await hooks.event({event:{type:'session.status',properties:{sessionID:ids.single,status:{type:'idle'}}}})
 assert.ok(!hooks.lastBusySnapshot().get('single').includes(ids.single),'An engine idle transition drops the session from the pushed busy set without waiting for the poll')
 console.log('PASS model-step hooks enforce 0 -> 12 and repeated hooks reuse the same slot; no mars_continue')
 console.log('PASS event-driven busy states survive REST failure; stale initial snapshots cannot reverse newer events')
 await hooks.event({event:{type:'session.error',properties:{sessionID:ids.single,error:{name:'UnknownError',data:{message:'Mars control unavailable [single]: fixture transport failure'}}}}})
 assert.equal((await tool('single','mars_status')).round.modelAdmissionClosed,false,'Infrastructure errors must not permanently grade a world as model_error')
 await tool('brain','mars_start')
 await assert.rejects(hooks['chat.params']({sessionID:'unbound_auxiliary',agent:'mars'},{}),/fixed-role/)
 const observer = teamSize === 8 ? 'verifier' : 'analyst'
 await hooks['chat.params']({sessionID:ids[observer],agent:'mars',message:{id:'observer-science'}},{})
 await hooks['experimental.session.compacting']({sessionID:ids[observer]},{context:[]})
 const summaryParams={maxOutputTokens:30000}
 await hooks['chat.params']({sessionID:ids[observer],agent:'compaction',model:{limit:{output:30000}}},summaryParams)
 assert.equal(summaryParams.maxOutputTokens,4096)
 const failedSummary = assistant(observer,{id:'failed-summary',summary:true,finish:'error',error:{name:'ContextOverflowError',data:{message:'Summary input too long'}}})
 await event(failedSummary)
 await event(failedSummary)
 const afterSummary = await tool('brain','mars_status')
 assert.equal(afterSummary.tick,0)
 assert.equal(afterSummary.round.modelAdmissionClosed,false)
 assert.deepEqual(afterSummary.round.recentCompactionFailures,[{role:observer,tick:0,decisionTick:0,reason:'context_overflow'}])
 const warnings=(await tool('brain','mars_inbox')).messages.filter(message=>message.text.includes('上下文压缩因上下文过长失败'))
 assert.equal(warnings.length,1)
 assert.match(warnings[0].text,new RegExp(observer))
 await idle(observer)
 console.log('PASS compaction output cap, terminal summary failure recorded once, and brain receives a real failure notice')
 await hooks.event({event:{type:'session.error',properties:{sessionID:ids.analyst,error:{name:'ContextOverflowError',data:{message:'Input too long'}}}}})
 assert.equal((await tool('brain','mars_status')).round.modelAdmissionClosed,false,'One role overflowing cannot terminate the team')
 await hooks.event({event:{type:'session.error',properties:{sessionID:ids.analyst,error:{name:'APIError',data:{message:'Invalid provider credentials'}}}}})
 const closed=(await tool('brain','mars_status')).round
 assert.equal(closed.modelAdmissionClosed,true,'Unrecoverable model errors still close the affected world')
 assert.equal(closed.stopReason,'model_error')
 assert.notEqual((await tool('single','mars_status')).round.stopReason,'model_error','A team failure cannot close the single world')
 console.log('PASS recoverable overflow preserves the whole team; fatal errors close only their own world')
 console.log(JSON.stringify({passed:true,fixture,realModelCalls:0,externalNetworkCalls:0}))
}finally{await hooks.dispose()}
