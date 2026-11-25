#!/usr/bin/env node
/** Research IO, registration guards and caller-input execution through the real standalone Host. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
mkdirSync(join(root,'demo/.checks'),{recursive:true})
const fixture=mkdtempSync(join(root,'demo/.checks/interface-')),home=join(fixture,'single'),sessionId='interface_single'
const rpc=connectSidecar(spawn(process.execPath,['--experimental-transform-types',join(root,'app/mars-server.mjs'),
 '--home',home,'--truth',join(root,'data/mars/truth.json'),'--mode','single','--auto-clock','0','--checkpoint-interval','0',
 '--model-source','scripted-integration','--stage-profile',JSON.stringify({baselineTick:24,finalTick:60,horizon:72})],
 {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}}),
 {label:'Research interface regression',log:chunk=>process.stderr.write(chunk)})
const tool=async(name,args={})=>(await rpc.call('tools.call',{sessionId,name,args})).result
const write=(name,request,key,extra={})=>tool(name,{input_json:JSON.stringify(request),request_key:key,...extra})
const publicTest=(request)=>tool('model_test',{input_json:JSON.stringify(request)})
const cursor=()=>{const db=new DatabaseSync(join(home,'execution/execution.sqlite'),{readOnly:true});try{return db.prepare('SELECT MAX(seq) AS n FROM events').get().n}finally{db.close()}}
const schema={type:'object',properties:{x:{type:'number'}},required:['x'],additionalProperties:false}
const output={type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false}
const base={id:'m-good',code:'function scale(x){return x*parameters.scale} if(input.x>=0){return {value:scale(input.x)}} return {value:0}',parameters:{scale:2},
 inputSchema:schema,outputSchema:output,runtimeVersion:'mars-model-v06-sync-v1',basedOn:[],units:{input:{x:'unit'},output:{value:'unit'}}}
try{
 await rpc.call('hello');await rpc.call('login',{sessionId,role:'single'})
 await assert.rejects(publicTest({modelId:'m-good',inputs:[{x:1}]}),/mars_start/)
 await rpc.call('run.start',{sessionId})
 const names=(await rpc.call('tools.list')).map(t=>t.name)
 assert.ok(names.includes('model_test'))
 const {interface: energy}=await tool('research_catalog',{section:'interfaces',task_id:'T3'})
 assert.ok(energy.inputSchema.required.includes('weatherFactors'))
 assert.deepEqual(energy.inputSchema.properties.loads.items.required,['id','power'])
 assert.notEqual(energy.exampleInputs[0].weatherFactors.length,energy.exampleInputs[1].weatherFactors.length)
 assert.match(energy.semantics.weatherFactors,/forecast duration/)
 const {interface: cross}=await tool('research_catalog',{section:'interfaces',task_id:'T5'})
 assert.ok(cross.variants.energy.inputSchema.required.includes('waterContext'))
 assert.ok(cross.variants['water-effect'].inputSchema.required.includes('irrigationConditions'))
 for (const [contract, toolName] of [['action_commit','prediction_commit'], ['pipeline_register','model_register'], ['model_test','model_test']]) {
  const lookup = await tool('research_catalog', { contract })
  assert.equal(lookup[contract]['x-mars-call'].tool, toolName)
  assert.ok(names.includes(toolName))
  assert.ok(names.includes(contract), 'DeepWorks exposes the original callable aliases')
 }
 const t2 = await tool('research_catalog', { contract: 'research_submit', task_id: 'T2' })
 assert.deepEqual(t2.slots.map(({ slotId, acceptBeforeTick }) => [slotId, acceptBeforeTick]), [['baseline',24], ['final',60]])
 assert.equal(t2.slots[0].payloadSchema.required.includes('planId'), false)
 assert.equal(t2.slots[1].payloadSchema.required.includes('planId'), true)
 const t4 = await tool('research_catalog', { section: 'contracts', contract: 'research_submit', task_id: 'T4' })
 assert.deepEqual(t4.slots.map(({ slotId }) => slotId), ['final'])
 const openAtStart = await rpc.call('stages')
 assert.equal(openAtStart.tick, 0)
 assert.equal(openAtStart.openSlots.length, 10)
 assert.ok(openAtStart.openSlots.every(s => s.expectedRevision === 0 && s.accepted === null && s.latestPrediction === null))
 const bad=[]
 for(const[id,change]of [
  ['m-anonymous',{code:'function(input){return {value:1}}'}],
  ['m-arrow',{code:'(input)=>{return {value:1}}'}],
  ['m-helper-only',{code:'function helper(){return {value:1}}'}],
  ['m-await',{code:'return await Promise.resolve({value:1})'}],
  ['m-import',{code:'return import("node:fs")'}],
  ['m-schema',{inputSchema:{type:'object',properties:{optional:{anyOf:[{type:'number'},{type:'string'}]}}}}],
 ])bad.push(await write('model_register',{...base,id,...change},id))
 const { parameters: _parameters, ...noParameters } = base
 const missingParameters = await write('model_register', { ...noParameters, id: 'm-missing-params' }, 'missing-params')
 const good=await write('model_register',base,'good')
 await write('model_register',{...base,id:'m-wrong-output',code:'return {value:"wrong"}'},'wrong-output')
 await write('model_register',{...base,id:'m-slow',code:'while(true){} return {value:1}'},'slow')
 await write('research_write',{id:'m-good',expectedRevision:0,kind:'study',project:'PW',content:{note:'Deliberate cross-kind ID collision'},reason:'Public fixture'},'collision')
 const pipeline={pipelineId:'pipe-double',nodes:[{id:'first',modelId:'m-good',bindings:{x:'$case.x'}},{id:'second',modelId:'m-good',bindings:{x:'$node.first.value'}}],
  outputs:{value:'$node.second.value'},inputSchema:schema,outputSchema:output,inputUnits:{x:'unit'},outputUnits:{value:'unit'}}
 await write('pipeline_register',pipeline,'pipeline')
 await rpc.call('advance',{steps:12})
 const receipts=await tool('round_receipts')
 for(const item of bad){const r=receipts.find(r=>r.callId===item.callId);assert.equal(r.result.isError,true);assert.match(r.result.error,/function body|outer body|Module imports|Unsupported schema/)}
 const missingParametersResult = receipts.find(r => r.callId === missingParameters.callId).result
 assert.equal(missingParametersResult.isError, true)
 assert.match(missingParametersResult.error, /^parameters: /)
 assert.ok(!receipts.find(r=>r.callId===good.callId).result.isError)
 const aggregate=await tool('research_read');assert.deepEqual(aggregate.models.map(m=>m.id).sort(),['m-good','m-slow','m-wrong-output'])
 assert.equal(aggregate.pipelines.length,1)
 await assert.rejects(tool('research_read',{id:'m-good'}),/Ambiguous/)
 const model=await tool('research_read',{id:'m-good',kind:'model'})
 assert.equal(model.status,'found');assert.equal(model.current.id,'m-good');assert.equal(model.immutable,true)
 assert.equal((await tool('research_read',{id:'m-good',kind:'research'})).current.revision,1)
 assert.equal((await tool('research_read',{id:'pipe-double'})).kind,'pipeline')
 assert.equal((await tool('research_read',{id:'no-such-id'})).status,'not_found')
 await assert.rejects(tool('research_read',{id:'m-good',kind:'model',revision:2}),/immutable/)
 console.log('PASS invalid code/schema rejected before model persistence; typed ID reads preserve notes and detect ambiguity')
 const before=cursor(),tick=(await rpc.call('status')).tick
 const tested=await publicTest({modelId:'m-good',inputs:[{x:3},{x:-1}]})
 assert.equal(tested.executionValid,true);assert.deepEqual(tested.outputs,[{value:6},{value:0}])
 assert.equal(tested.scientificValidation,'not_evaluated');assert.equal(tested.inputSource,'caller_supplied');assert.ok(!Object.hasOwn(tested,'quality'))
 const dag=await publicTest({pipelineId:'pipe-double',inputs:[{x:3}]});assert.equal(dag.executionValid,true);assert.deepEqual(dag.outputs,[{value:12}])
 const badInput=await publicTest({modelId:'m-good',inputs:[{x:'bad'}]});assert.equal(badInput.executionValid,false);assert.match(badInput.error,/Type mismatch/)
 const badOutput=await publicTest({modelId:'m-wrong-output',inputs:[{x:1}]});assert.equal(badOutput.executionValid,false);assert.match(badOutput.error,/Type mismatch/)
 await assert.rejects(publicTest({modelId:'missing',inputs:[{}]}),/Unknown model/)
 await assert.rejects(publicTest({modelId:'m-good',pipelineId:'pipe-double',inputs:[{x:1}]}),/exactly one/)
 await assert.rejects(publicTest({modelId:'m-good',inputs:Array.from({length:17},()=>({x:1}))}),/16/)
 assert.equal(cursor(),before,'Public tests cannot write journal facts or certified evidence')
 assert.equal((await rpc.call('status')).tick,tick,'Public tests cannot consume physical ticks')
 console.log('PASS caller-input model and DAG tests validate IO without journal writes, hidden labels or logical-time advancement')
 const {testModel,modelTestLimits}=await import(pathToFileURL(join(root,'app/science-harness/integrations/ai4science/mars/v06/model-test.ts')).href)
 const slow=(await tool('research_read',{id:'m-slow'})).current
 const store={models:()=>[slow],pipelines:()=>[]}
 const started=Date.now();const limited=await testModel(store,{modelId:'m-slow',inputs:[{x:1}]},modelTestLimits({timeoutMs:25}))
 assert.equal(limited.executionValid,false);assert.match(limited.error,/time limit/);assert.ok(Date.now()-started<2000)
 const cancelled=await testModel(store,{modelId:'m-slow',inputs:[{x:1}]},modelTestLimits(),AbortSignal.abort())
 assert.equal(cancelled.executionValid,false);assert.match(cancelled.error,/cancelled/)
 await assert.rejects(testModel({models:()=>[{...model.current,code:'return {value:99}'}],pipelines:()=>[]},{modelId:'m-good',inputs:[{x:1}]},modelTestLimits()),/hash changed/)
 console.log('PASS request-wide timeout/cancellation stop execution; frozen hash corruption remains a distinct backend fault')
 const {V06Records}=await import(pathToFileURL(join(root,'app/science-harness/integrations/ai4science/mars/v06/records.ts')).href)
 const {contentHash,modelInputSchema}=await import(pathToFileURL(join(root,'app/science-harness/integrations/ai4science/mars/v06/contracts.ts')).href)
 const {canonicalJson}=await import(pathToFileURL(join(root,'app/science-harness/integrations/ai4science/platform/sdk.ts')).href)
 const legacyInput=modelInputSchema.parse({...base,id:'legacy-bad',code:'(input)=>({value:1})'})
 const legacy={...legacyInput,hash:contentHash(legacyInput),createdBy:'legacy-actor',acceptedTick:0,acceptedSeq:1}
 const historical=new V06Records({readFacts:()=>[{kind:'mars-v06-record',data:{sequence:1,actorId:'legacy-actor',key:'legacy-key',operation:'model',input:canonicalJson(legacyInput),result:legacy}}],eventCursor:()=>1,
  recordFact:()=>{throw new Error('Historical replay cannot rewrite the journal')}},{actorId:'legacy-actor'},()=>100,{baselineTick:24,finalTick:48,horizon:60})
 assert.deepEqual(historical.models(),[legacy])
 assert.deepEqual(historical.registerModel('legacy-key',legacyInput),legacy,'Idempotent historical receipts survive stricter new-registration checks')
 console.log('PASS legacy frozen artifacts remain readable and idempotent retries do not rewrite historical receipts')
 const slot = async () => (await rpc.call('stages')).openSlots.find(s => s.taskId === 'T3' && s.slotId === 'final')
 const prediction = { id:'p-good', taskId:'T3', slotId:'final', modelId:'m-good' }
 const missingDomain = await write('prediction_commit', { ...prediction, id:'p-missing-domain' }, 'missing-domain')
 await write('prediction_commit', { ...prediction, inputDomain:{} }, 'prediction')
 await write('experiment_plan',{title:'Public read fixture',steps:[{id:'calibrate',providerId:'facilities',at:36,input:{action:'calibrate',deviceId:'confirm'}}]},'plan',{action:'schedule'})
 await rpc.call('advance',{steps:12})
 const domainResult = (await tool('round_receipts')).find(r => r.callId === missingDomain.callId).result
 assert.equal(domainResult.isError, true)
 assert.match(domainResult.error, /^inputDomain: /)
 const beforeStageRead = cursor()
 const afterBaseline = await rpc.call('stages')
 assert.equal(afterBaseline.tick, 24)
 assert.equal(afterBaseline.openSlots.length, 6)
 assert.ok(afterBaseline.openSlots.every(s => s.slotId === 'final'))
 assert.deepEqual(await slot(), {
  taskId:'T3', slotId:'final', acceptBeforeTick:60, expectedRevision:0, accepted:null,
  latestPrediction:{ id:'p-good', acceptedTick:12, modelId:'m-good', pipelineId:null },
 })
 assert.equal(cursor(), beforeStageRead, 'The stages projection must not append an event')
 assert.equal((await rpc.call('status')).tick, 24)
 const plans=await tool('experiment_plan',{action:'list'})
 const plan=Array.isArray(plans)?plans[0]:plans.plans?.[0]??plans.items?.[0]
 assert.ok(plan?.id,'Scheduled public plan must be readable')
 await write('action_commit',{id:'a-good',taskId:'T3',planId:plan.id,commissionId:'service-1',sourceId:'reservoir',forecast:{completedTick:40,remainingUl:50}},'action')
 const submission = {taskId:'T3',slotId:'final',payload:{modelId:'m-good',predictionId:'p-good'},evidence:[],expectedRevision:0}
 const picker = extra => tool('research_catalog',{section:'references',task_id:'T3',slot_id:'final',...extra})
 const beforeDiscovery=cursor(), discoveryTick=(await rpc.call('status')).tick
 const references = await picker({reference_kind:'prediction'})
 await tool('experiment_plan',{action:'portfolio'})
 assert.equal(cursor(),beforeDiscovery,'Reference discovery and portfolio projection must not append scientific work')
 assert.equal((await rpc.call('status')).tick,discoveryTick)
 assert.deepEqual(references.items.map(r=>[r.id,r.field]), [['p-good','payload.predictionId']]);assert.equal(references.accepted,null)
 const wrongEvidence = await write('research_submit',{...submission,evidence:[{id:'p-good',purpose:'validation'}]},'bad-evidence',{action:'check'})
 const checked = await write('research_submit', submission, 'preflight', {action:'check'})
 const noCropPlan = await write('research_submit', {...submission,taskId:'T2'}, 'missing-crop-plan', {action:'check'})
 const telemetry = await tool('analysis_run', { code: 'const rows = await telemetry(["energy.soc"], 0, 24); return {samples:rows["energy.soc"].length};' })
 await rpc.call('advance',{steps:12})
 const afterCheck = await tool('round_receipts')
 assert.deepEqual(afterCheck.find(r => r.callId === checked.callId).result, {
  formatValid:true, accepted:false, scientificValidation:'not_evaluated', nextAction:'submit',
  taskId:'T3', slotId:'final', expectedRevision:0, checkedTick:24, acceptBeforeTick:60,
  evidenceChecks:[{group:'energy_forecast',eligible:false,missing:['Cite a completed analysis that accessed actual energy.solar or energy.soc telemetry.']}],
 })
 assert.match(afterCheck.find(r=>r.callId===wrongEvidence.callId).result.error,/evidence\[0\].id:.*payload.predictionId/)
 const analysis = afterCheck.find(r => r.callId === telemetry.callId).result
 assert.ok((await picker({reference_kind:'analysis'})).items.some(r=>r.id===analysis.runId&&r.field==='evidence'))
 assert.equal(analysis.status,'done')
 const withTelemetry = {...submission, evidence:[{id:analysis.runId,purpose:'current-estimate'}]}
 const checkedTelemetry = await write('research_submit', withTelemetry, 'preflight-telemetry', {action:'check'})
 await write('prediction_commit',{id:'p-cross',taskId:'T5',slotId:'final',modelId:'m-good',inputDomain:{}},'t5-prediction')
 const checkedT5 = await write('research_submit', {...withTelemetry, taskId:'T5',
  payload:{modelId:'m-good',predictionId:'p-cross',scopeIds:[]}}, 'preflight-t5', {action:'check'})
 assert.match(afterCheck.find(r => r.callId === noCropPlan.callId).result.error, /^payload\.planId: /)
 assert.equal((await slot()).accepted, null, 'A format check cannot create a submission')
 assert.equal((await tool('research_read',{id:'p-good'})).kind,'prediction')
 assert.equal((await tool('research_read',{id:'a-good'})).kind,'action')
 await write('research_submit', withTelemetry, 'submission', {action:'submit'})
 await rpc.call('advance',{steps:12})
 const qualifiedReceipts = await tool('round_receipts')
 const qualifying = qualifiedReceipts.find(r => r.callId === checkedTelemetry.callId).result
 assert.deepEqual(qualifying.evidenceChecks,[{group:'energy_forecast',eligible:true,missing:[]}])
 assert.equal(qualifying.scientificValidation,'not_evaluated')
 const separated = qualifiedReceipts.find(r => r.callId === checkedT5.callId).result
 assert.deepEqual(separated.evidenceChecks.map(({group,eligible,missing})=>[group,eligible,missing.length]),
  [['dependent_pipeline',false,2],['independent_pipeline',true,0]])
 assert.equal((await slot()).expectedRevision, 1)
 assert.equal((await slot()).accepted.tick, 36)
 assert.deepEqual((await picker({reference_kind:'prediction'})).accepted,{revision:1,acceptedTick:36})
 const submitted=await tool('research_read',{kind:'submission',task_id:'T3',slot_id:'final'})
 assert.equal(submitted.current.revision,1);assert.equal(submitted.current.acceptedTick,36)
 assert.equal((await tool('research_read',{task_id:'T3',slot_id:'final',revision:2})).current,null)
 await assert.rejects(tool('research_read',{task_id:'T3'}),/both/)
 await write('research_submit', {...submission, expectedRevision:1}, 'amended', {action:'submit'})
 const stale = await write('research_submit', submission, 'stale', {action:'submit'})
 await rpc.call('advance',{steps:12})
 assert.match((await tool('round_receipts')).find(r => r.callId === stale.callId).result.error, /revision changed/)
 const afterFinal = await rpc.call('stages')
 assert.equal(afterFinal.tick, 60)
 assert.deepEqual(afterFinal.openSlots, [])
 assert.equal(afterFinal.seals.find(s => s.stage === 'final').selections.find(s => s.taskId === 'T3').revision, 2)
 await assert.rejects(publicTest({modelId:'m-good',inputs:[{x:1}]}),/close.*final/i)
 assert.equal((await rpc.call('status')).round.clock.failure,null)
 console.log('PASS callable contracts and field errors; check leaves slot open; explicit submit and CAS revision agree with final seal')
 console.log(JSON.stringify({passed:true,fixture,realModelCalls:0,productionDataWrites:0}))
}finally{await rpc.close()}
