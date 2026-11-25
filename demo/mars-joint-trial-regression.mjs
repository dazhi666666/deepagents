#!/usr/bin/env node
/** Two fresh Host worlds use observed water, energy and crop scans to preregister a matched trial. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'
import { marsRoster } from '../app/science/mars-roster.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = join(root,'demo','.checks')
mkdirSync(checks,{recursive:true})
const fixture = mkdtempSync(join(checks,'paired-growth-'))
const full = process.argv.includes('--full')
const stages = full ? { baselineTick: 720, finalTick: 1800, horizon: 2400 } : { baselineTick: 120, finalTick: 288, horizon: 384 }
const window = stages.horizon - stages.finalTick, verifyAt = stages.horizon - 19
const step = (id, tool, args, at, dependsOn=[]) => ({id, tool, args, at, dependsOn})
const chamber = n => `incubator-${n}`
async function run(mode) {
  const home = join(fixture,mode)
  const child = spawn(process.execPath,['--experimental-transform-types',join(root,'app/mars-server.mjs'), '--home',home,'--truth',join(root,'data/mars/truth.json'),
    '--mode',mode,'--team-size','8','--model-source','scripted-integration','--stage-profile',JSON.stringify(stages),'--joint-trial','paired-growth-v1','--auto-clock','0','--checkpoint-interval','0'],
    {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}})
  const rpc = connectSidecar(child,{label:`Matched trial ${mode}`,log:chunk=>process.stderr.write(chunk)})
  const sid = role => `trial-${mode}-${mode==='single'?'single':role}`
  const tool = async (role,name,args={}) => (await rpc.call('tools.call',{sessionId:sid(role),name,args})).result
  const write = (role,name,id,body,action) => tool(role,name,{request_key:id,input_json:JSON.stringify(body),...(action?{action}:{})})
  const advance = async target => { const {tick}=await rpc.call('status');assert.equal((await rpc.call('advance',{steps:target-tick},0)).tick,target) }
  const receipt = async (role,pending) => { const r=(await tool(role,'round_receipts')).find(r=>r.callId===pending.callId);assert.ok(r);return r.result }
  const good = async (role,pending) => { const r=await receipt(role,pending);assert.ok(!r.isError,r.error);return r }
  try {
    await rpc.call('hello'); for(const role of marsRoster(mode,8)) await rpc.call('login',{role,sessionId:sid(role)})
    await rpc.call('run.start',{sessionId:sid('brain')})
    const contract=await tool('brain','research_catalog',{contract:'research_submit',task_id:'T6'})
    assert.deepEqual(contract.slots[0].payloadSchema.required,['planId','trial'])
    await tool('engineer','device_calibrate',{device_id:'confirm',request_key:'calibrate'})
    await tool('water','water_assay',{source_id:'reservoir',method:'confirm',task_id:'water-evidence',request_key:'observed-water'})
    const scans=[]
    for(let n=1;n<=4;n++) for(const [i,level] of [55,85,70].entries()) {
      const l=`light-${n}-${i}`
      scans.push(step(l,'greenhouse_light',{chamber_id:chamber(n),level},24+i*20),step(`scan-${n}-${i}`,'greenhouse_scan',{chamber_id:chamber(n)},28+i*20,[l]))
    }
    if (full) for(let at=110;at<stages.finalTick;at+=144) for(const n of [1,2])
      scans.push(step(`care-${n}-${at}`,'greenhouse_irrigate',{chamber_id:chamber(n),crop_id:`crop-${n}-1`,volume_ul:100},at))
    const observations=await write('crops','experiment_plan','observe',{title:'Observed light coverage and matched pretrial care',steps:scans},'schedule')
    const predictionModel=await write('crops','model_register','crop-model',{id:'public-crop-test',code:'return {growthIndex:1};',parameters:{},inputSchema:{},outputSchema:{},runtimeVersion:'mars-model-v06-sync-v1'})
    await advance(132);await good('crops',observations);await good('crops',predictionModel)
    const energy=await tool('agronomist','analysis_run',{code:'return (await telemetry(["energy.soc"],0,120))["energy.soc"].length;'})
    const prediction=await write('crops','prediction_commit','crop-prediction',{id:'trial-crop-prediction',taskId:'T2',slotId:'final',modelId:'public-crop-test',inputDomain:{}})
    const design={title:'Matched water and light trial',steps:[
      step('water','greenhouse_irrigate',{chamber_id:chamber(1),crop_id:'crop-1-1',volume_ul:80},stages.finalTick+1),
      step('light','greenhouse_light',{chamber_id:chamber(1),level:90},stages.finalTick+3,['water']),
      step('verify-treatment','greenhouse_scan',{chamber_id:chamber(1)},verifyAt,['light']),
      step('verify-control','greenhouse_scan',{chamber_id:chamber(2)},verifyAt,['light'])]}
    if (full) for(let at=stages.finalTick+100;at<verifyAt;at+=144) for(const n of [1,2])
      design.steps.push(step(`follow-up-${n}-${at}`,'greenhouse_irrigate',{chamber_id:chamber(n),crop_id:`crop-${n}-1`,volume_ul:100},at))
    const registered=await write('brain','experiment_plan','joint-plan',design,'schedule')
    const scanOnly=await write('brain','experiment_plan','scan-only',{title:'Single scan',steps:[step('scan','greenhouse_scan',{chamber_id:chamber(2)},verifyAt)]},'schedule')
    await advance(228);const plan=await good('brain',registered);const badPlan=await good('brain',scanOnly);const analysis=await good('agronomist',energy);await good('crops',prediction)
    const refs = async(task,kind) => {const rows=[];for(let offset=0;;offset+=10){const p=await tool('verifier','research_catalog',{section:'references',task_id:task,reference_kind:kind,limit:10,offset});rows.push(...p.items);if(rows.length>=p.total)return rows}}
    const water=(await refs('T6','result')).find(x=>x.detail.startsWith('confirm'))
    assert.ok(water,'A current water measurement is required')
    const trial={treatmentCropId:'crop-1-1',controlCropId:'crop-2-1',forecastGainPerTick:0.1,waterBudgetUl:full ? 1000 : 100,energyBudget:18.75*window}
    const draft={taskId:'T6',slotId:'final',expectedRevision:0,payload:{planId:plan.id,trial},evidence:[{id:water.id,purpose:'current-estimate'},{id:analysis.runId,purpose:'validation'}]}
    const evidenceCheck=await write('verifier','research_submit','trial-preflight',draft,'check')
    await advance(240)
    assert.deepEqual((await good('verifier',evidenceCheck)).evidenceChecks.map(c=>[c.group,c.eligible]),[['trial_water',true],['trial_energy',true]])
    const rejected=await write('brain','research_submit','one-scan',{...draft,payload:{planId:badPlan.id,trial}},'submit')
    const accepted=await write('brain','research_submit','joint-trial',draft,'submit')
    const cropEvidence=(await refs('T2','operation')).map(({id})=>({id,purpose:'validation'}));assert.equal(cropEvidence.length,12)
    const cropDraft={taskId:'T2',slotId:'final',expectedRevision:0,payload:{modelId:'public-crop-test',predictionId:'trial-crop-prediction',planId:plan.id},evidence:cropEvidence}
    const checked=await write('crops','research_submit','crop-check',cropDraft,'check')
    const submitted=await write('crops','research_submit','crop-final',cropDraft,'submit')
    await advance(252);assert.match((await receipt('brain',rejected)).error,/irrigation and a light treatment/)
    assert.ok((await good('brain',accepted)).accepted);assert.ok((await good('crops',checked)).evidenceChecks.every(c=>c.eligible));assert.ok((await good('crops',submitted)).accepted)
    await advance(stages.horizon)
    const report=JSON.parse(readFileSync(join(home,'final-report.json'),'utf8'))
    assert.equal(report.tick,stages.horizon);assert.equal(report.completionStatus,'finalized');assert.ok(report.validation.holdout_accuracy.valid)
    const t=report.jointTrial;assert.equal(t.version,'paired-growth-v1');assert.ok(t.checks,JSON.stringify(t));
    for(const k of ['currentWater','measuredEnergy','planSucceeded','bothAlive','comparableStart','interventionsExecuted','comparisonProtocol','verified','water','energy']) assert.ok(t.checks[k],`${k} ${JSON.stringify(t)}`)
    assert.equal(t.outcome.waterUl,design.steps.filter(s=>s.tool==='greenhouse_irrigate').reduce((sum,s)=>sum+s.args.volume_ul,0));assert.ok(t.outcome.energy>0);assert.equal(t.passed,Object.values(t.checks).every(Boolean));
    console.log(JSON.stringify({mode,fixture,holdoutValidation:true,trial:t.checks,gainPerTick:t.outcome.gainPerTick,measuredEnergy:t.outcome.energy,realModelCalls:0}))
    return t
  } finally {await rpc.close()}
}
const results=await Promise.allSettled(['multi','single'].map(run))
for (const result of results) if(result.status==='rejected') throw result.reason
assert.deepEqual(results[0].value,results[1].value)
const pair=spawnSync(process.execPath,[join(root,'app/mars-pair.mjs'),join(fixture,'multi'),join(fixture,'single')],{encoding:'utf8'});assert.equal(pair.status,0,pair.stderr);assert.ok(JSON.parse(pair.stdout).comparable)
for (const mode of ['multi','single']) {
  const home=join(fixture,mode),out=join(fixture,`${mode}-replay.json`)
  const replay=spawnSync(process.execPath,['--experimental-transform-types',join(root,'app/mars-evaluate.mjs'),'--home',home,'--output',out],{encoding:'utf8'})
  assert.equal(replay.status,0,replay.stderr)
  const original=JSON.parse(readFileSync(join(home,'final-report.json'),'utf8')),offline=JSON.parse(readFileSync(out,'utf8'))
  for (const [key,value] of Object.entries(original)) assert.deepEqual(offline[key],value,key)
}
console.log('PASS both arms sealed a prospective T6 declaration, reached numerical T2 validation and reproduced the report offline')
