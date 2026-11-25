#!/usr/bin/env node
/** Exercise shared editing, prospective selection and independent offline scoring through two real Hosts. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSidecar } from '../app/science/sidecar-rpc.mjs'
import { marsRoster } from '../app/science/mars-roster.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), checks = join(root,'demo','.checks')
mkdirSync(checks, { recursive:true })
const exec = promisify(execFile), verifyArg = process.argv.indexOf('--verify')
const fixture = verifyArg<0 ? mkdtempSync(join(checks,'reviewed-choice-')) : resolve(process.argv[verifyArg+1])
const replayHome = verifyArg<0 ? fixture : mkdtempSync(join(checks,'verified-choice-'))
const full = process.argv.includes('--full')
const baseline = full ? 720 : 120, final = full ? 1800 : 336, horizon = full ? 2400 : 432
const shared = process.argv.includes('--shared')
const workflow = shared ? 'delivery-v2' : 'reviewed-v1', trialVersion = shared ? 'shared-plan-v3' : 'pilot-choice-v2'
const stage = { baselineTick:baseline, finalTick:final, horizon }
const step = (id,tool,args,at,dependsOn=[]) => ({id,tool,args,at,dependsOn})
const crop = n => `crop-${n}-1`, chamber = n => `incubator-${n}`
const irrigate = (n,at) => step(`water-${n}-${at}`,'greenhouse_irrigate',{chamber_id:chamber(n),crop_id:crop(n),volume_ul:100},at)
const light = (n,level,at,dependsOn=[]) => step(`light-${n}`,'greenhouse_light',{chamber_id:chamber(n),level},at,dependsOn)
const scan = (n,at,id,dependsOn=[]) => step(id,'greenhouse_scan',{chamber_id:chamber(n)},at,dependsOn)

async function run(mode) {
  const home = join(fixture,mode)
  if (verifyArg>=0) return verify(mode,home)
  const child = spawn(process.execPath,['--experimental-transform-types',join(root,'app/mars-server.mjs'),'--home',home,'--truth',join(root,'data/mars/truth.json'),
    '--mode',mode,'--team-size','8','--model-source','scripted-integration','--stage-profile',JSON.stringify(stage),'--research-workflow',workflow,
    '--joint-trial',trialVersion,'--auto-clock','0','--checkpoint-interval','0'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}})
  const rpc = connectSidecar(child,{label:`Choice ${mode}`,log:chunk=>process.stderr.write(chunk)})
  const sid = role => `choice-${mode}-${mode==='multi'?role:'single'}`
  const tool = async(role,name,args={}) => (await rpc.call('tools.call',{sessionId:sid(role),name,args})).result
  const write = (role,name,body,key,extra={}) => tool(role,name,{...extra,input_json:JSON.stringify(body),request_key:key})
  let now = 0
  const advance = async at => { assert.equal((await rpc.call('advance',{steps:at-now},0)).tick,at); now=at }
  const receipt = async(role,pending,problem) => {
    const row = (await tool(role,'round_receipts')).find(r=>r.callId===pending.callId);assert.ok(row)
    if (problem) assert.match(row.result.error,problem); else assert.ok(!row.result.isError,row.result.error)
    return row.result
  }
  const edit = (role,action,revision,key,patch) => tool(role,'research_draft',{action,task_id:'T6',slot_id:'baseline',revision,request_key:key,...(patch ? {input_json:JSON.stringify(patch)}:{})})
  const form = {taskId:'T6',slotId:'baseline',expectedRevision:0,evidence:[]}
  const submit = (role,key,body) => write(role,'research_submit',body,key,{action:'submit'})
  const schedule = (role,title,steps) => write(role,'experiment_plan',{title,steps},title,{action:'schedule'})
  const levels = { A:80,B:50 }, pilot = { arms:{A:{cropId:crop(3),light:levels.A},B:{cropId:crop(4),light:levels.B}},treatmentCropId:crop(1),controlCropId:crop(2) }
  try {
    await rpc.call('hello');for (const role of marsRoster(mode,8)) await rpc.call('login',{sessionId:sid(role),role})
    await rpc.call('run.start',{sessionId:sid('brain')})
    const catalog = await tool('brain','research_catalog',{contract:'research_submit',task_id:'T6'})
    assert.deepEqual(catalog.slots.map(s=>s.slotId),['baseline','final'])
    const pilotSteps = []
    for (const [n,level] of [[3,levels.A],[4,levels.B]]) pilotSteps.push(scan(n,baseline+3,`pre-${n}`),light(n,level,baseline+12,[`pre-${n}`]),scan(n,baseline+42,`post-${n}`,[`light-${n}`]))
    const pre = await schedule('crops','Pilot',pilotSteps)
    const care = shared ? [] : [light(1,40,20),light(2,40,20)]
    const wholeChamber = (n,at,volume=300) => step(`care-${n}-${at}`,'greenhouse_irrigate',{chamber_id:chamber(n),volume_ul:volume},at)
    if (shared) {
      for (const n of [1,2,3,4]) {
        for (const [i,lux] of [50,70,90].entries()) {
          const at=12+i*18, id=`coverage-light-${n}-${i}`
          care.push({...light(n,lux,at),id},scan(n,at+8,`coverage-scan-${n}-${i}`,[id]))
        }
        care.push({...light(n,n<=2?40:70,68),id:`pretrial-${n}`})
      }
    }
    const careInterval=shared?100:120
    for (let at=78;at<final;at+=careInterval) for (const n of [1,2,3,4]) if (n<3 || at<baseline || at>baseline+48) care.push(shared?wholeChamber(n,at):irrigate(n,at))
    const prep = await schedule('water','Care',care)
    await tool('engineer','device_calibrate',{device_id:'confirm',request_key:'cal'})
    await tool('water','water_assay',{source_id:'reservoir',method:'confirm',task_id:'measurement',request_key:'water'})
    await advance(12); const first = await receipt('crops',pre);await receipt('water',prep)
    const request = {...form,payload:{planId:first.id,pilot},evidence:[{id:first.id,purpose:'validation'}]}
    const bad = await submit('brain','wrong-field',request);await advance(24);await receipt('brain',bad,/Evidence unavailable/)
    const slot = await tool('verifier','research_draft',{action:'read',task_id:'T6',slot_id:'baseline'})
    assert.equal(slot.accepted,null);assert.ok(slot.lastRejection.problem.includes('payload.planId'))
    if(mode==='multi') assert.ok((await tool('verifier','mars_inbox')).messages.some(m=>m.text.includes('[提交复核]')))
    const patch = {rejectionId:slot.lastRejection.id,evidence:[]}
    const repaired = await edit('verifier','save',0,'fix',patch);await advance(36)
    const saved = (await receipt('verifier',repaired)).draft;assert.equal(saved.problem,null);assert.equal(saved.revision,1)
    const stale = await edit('brain','save',0,'stale',patch), accepted = await edit('verifier','submit',1,'release')
    await advance(48);await receipt('brain',stale,/revision changed/);assert.equal((await receipt('verifier',accepted)).accepted,true)
    const replay = await edit('verifier','save',0,'fix',patch);await advance(60);assert.equal((await receipt('verifier',replay)).replay,true)
    await assert.rejects(tool('brain','trial_pilot'),/baseline seal/)
    if (shared) {
      await advance(baseline-12)
      const last=await write('brain','research_submit',{...request,expectedRevision:1,references:[{kind:'plan',id:first.id}]},'last-window',{action:'check_submit'})
      await advance(baseline)
      const selected=await receipt('brain',last);assert.equal(selected.acceptedTick,baseline-12);assert.equal(selected.revision,2)
      assert.equal((await rpc.call('stages')).seals[0].selections.find(s=>s.taskId==='T6').revision,2)
    }
    await advance(baseline+72); const observed = await tool('brain','trial_pilot');assert.equal(observed.readings.length,2)
    const demand = await tool('engineer','analysis_run',{code:`const values=(await telemetry(['energy.demand'],1,${now}))['energy.demand']; return values.reduce((sum,row)=>sum+row[1],0)/values.length;`})
    await advance(now+12); const energy = await receipt('engineer',demand);assert.ok(energy.output>0)
    const evidence = observed.readings.flatMap(r=>[r.beforeId,r.afterId]).map(id=>({id,purpose:'validation'}))
    const results = await tool('water','research_catalog',{section:'references',task_id:'T6',reference_kind:'result',limit:10})
    const measurement = results.items.find(r=>r.detail.includes('reservoir'));assert.ok(measurement)
    if(shared) {
      const windows=await tool('service','service_review')
      assert.ok(windows.commissions.find(c=>c.source==='reservoir').mothers.some(m=>m.resultId===measurement.id && m.rootSampleId))
    }
    evidence.push({id:measurement.id,purpose:'current-estimate'},{id:energy.runId,purpose:'validation'})
    const window = horizon-final, makeForecast = r => ({gainPerTick:Math.max(-0.08,Math.min(0.08,r.change/20)),energy:Math.ceil(energy.output*window)})
    const forecasts = Object.fromEntries(observed.readings.map(r=>[r.name,makeForecast(r)]))
    const selected = forecasts.A.gainPerTick >= forecasts.B.gainPerTick ? 'A' : 'B'
    const choice = {selected,forecasts,energyBudget:18*window,waterBudgetUl:(shared?18:3)*window}
    const careStep=shared?wholeChamber:irrigate
    // Carry the pre-final watering cadence across the seal. A small trial dose avoids two full doses inside the same 100-tick window.
    const lastCare=78+Math.floor((final-1-78)/careInterval)*careInterval
    const verify = horizon-12, nextCare=shared?Math.max(final+12,lastCare+careInterval):final+104
    const ops = [careStep(1,final+2,20),careStep(2,final+2,20),light(1,levels[selected],final+8)]
    for(let at=nextCare;at<verify-3;at+=careInterval) for(const n of [1,2]) ops.push(careStep(n,at))
    ops.push(scan(1,verify,'end-a',['light-1']),scan(2,verify,'end-b',['light-1']))
    const trialSteps=ops.map(s=>s.id)
    let cropRefs=[], registered
    if (shared) {
      for (const n of [3,4]) {
        for(let at=nextCare;at<verify-3;at+=careInterval) ops.push(wholeChamber(n,at))
        ops.push(light(n,n===3?70:50,final+8),scan(n,verify,`end-${n}`,[`light-${n}`]))
      }
      for(let offset=0;;offset+=10) {
        const page=await tool('crops','research_catalog',{section:'references',task_id:'T2',reference_kind:'operation',offset,limit:10})
        cropRefs.push(...page.items.map(r=>({kind:'operation',id:r.id,purpose:'validation'})))
        if(offset+page.items.length>=page.total) break
      }
      const history=await tool('crops','analysis_run',{code:`return await archiveSql("SELECT json_extract(result,'$.variety') AS variety,json_extract(result,'$.light') AS light,avg(json_extract(result,'$.growthIndex')) AS growth FROM experiments WHERE method='light-trial' AND status='completed' GROUP BY 1,2 ORDER BY 1,2")`})
      await advance(now+12);const data=await receipt('crops',history);assert.ok(data.output.length>=16)
      registered=await write('crops','model_register',{id:'public-light-curve',parameters:{rows:data.output},inputSchema:{},outputSchema:{},runtimeVersion:'mars-model-v06-sync-v1',
        code:`const rows=parameters.rows.filter(r=>r.variety===Number(input.cropId.split('-')[2])); const lo=rows.filter(r=>r.light<=input.light).at(-1)||rows[0]; const hi=rows.find(r=>r.light>=input.light)||rows.at(-1); const mix=(input.light-lo.light)/Math.max(1,hi.light-lo.light); const g=lo.growth+mix*(hi.growth-lo.growth); return {growthIndex:g*Math.exp(-(((input.temperature-22)/6)**2))*(input.co2/(input.co2+350))/(800/1150)};`},'crop-model')
    }
    const cropSteps=ops.map(s=>s.id)
    if(shared) ops.push(step('base-panel','panel_clean',{},final+32))
    const booked=await schedule('brain','Holdout',ops);await advance(now+12)
    const holdout=await receipt('brain',booked), proposal={...form,slotId:'final',payload:{planId:holdout.id,choice,...(shared?{stepIds:trialSteps}:{})},evidence}
    if (shared) {
      await receipt('crops',registered)
      const pred=await write('crops','prediction_commit',{id:'crop-choice-pred',taskId:'T2',slotId:'final',modelId:'public-light-curve',inputDomain:{kind:'crop'}},'crop-pred')
      await advance(now+12);await receipt('crops',pred)
      const cropSubmit=await write('crops','research_submit',{taskId:'T2',slotId:'final',expectedRevision:0,payload:{stepIds:cropSteps},references:[{kind:'prediction',id:'crop-choice-pred'},{kind:'plan',id:holdout.id},...cropRefs]},'shared-t2',{action:'check_submit'})
      const broken=await submit('brain','omitted-control',{...proposal,payload:{...proposal.payload,stepIds:trialSteps.filter(id=>id!==careStep(2,final+2).id)}})
      await advance(now+12);await receipt('crops',cropSubmit);await receipt('brain',broken,/Include the trial-chamber intervention/)
    }
    const wrong=await submit('brain','wrong-option',{...proposal,payload:{...proposal.payload,choice:{...choice,selected:selected==='A'?'B':'A'}}})
    const missing=await submit('brain','missing-pilot-scan',{...proposal,evidence:evidence.slice(1)})
    const bookedFinal=await submit('brain','selected-option',proposal);await advance(now+12)
    await receipt('brain',wrong,/highest predicted gain/);await receipt('brain',missing,/four observed/);await receipt('brain',bookedFinal)
    await advance(horizon)
  } finally {
    try {
      if (child.exitCode===null && child.signalCode===null) {
        const exit=once(child,'exit',{signal:AbortSignal.timeout(60000)})
        const [, [code,signal]]=await Promise.all([rpc.call('shutdown',{},5000),exit])
        assert.equal(code,0,`Fixture shutdown ended with ${signal ?? code}`)
      }
    } finally { await rpc.close() }
  }
  return verify(mode,home)
}
async function verify(mode,home) {
  const original=JSON.parse(readFileSync(join(home,'final-report.json'),'utf8')), trial=original.jointTrial
  assert.equal(trial.version,trialVersion);assert.equal(trial.outcome.controlledTrialValid,true,JSON.stringify(trial.checks));assert.equal(trial.pilot.length,2)
  if(shared){
    assert.ok(original.sharedPlan.matched && original.sharedPlan.wholePlanSucceeded);assert.ok(original.sharedPlan.sharedOperations>=5)
    const journal=new DatabaseSync(join(home,'execution/execution.sqlite'),{readOnly:true})
    try {
      const planId=original.sharedPlan.planId
      const row=journal.prepare("SELECT json_extract(data_json,'$.data.result') AS plan FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-v06-plan-mutation' AND json_extract(data_json,'$.data.result.id')=? ORDER BY seq DESC LIMIT 1").get(planId)
      const plan=JSON.parse(row.plan), work=journal.prepare("SELECT id,request_key,state FROM operations WHERE request_key LIKE ?").all(`v06:${planId}:%`)
      assert.equal(work.length,plan.steps.length)
      for(const step of plan.steps){const op=work.find(o=>o.request_key===`v06:${planId}:${step.id}`);assert.equal(op?.id,plan.operations[step.id]);assert.equal(op?.state,'succeeded')}
    }finally{journal.close()}
    assert.ok(original.validation.holdout_accuracy.valid);assert.equal(original.O.waterUnavailableTicks,0)
    assert.equal(original.jointConditions.find(c=>c.id==='T2:science').passed,true)
    assert.equal(original.components.intervention_attainment,1);assert.equal(trial.passed,true)
    assert.equal(original.O.aliveCrops,16);assert.ok(original.jointConditions.filter(c=>c.id.startsWith('operation:')).every(c=>c.passed))
    console.log(JSON.stringify({mode,sharedPlan:original.sharedPlan,T2:original.q.T2,T2Intervention:original.components.intervention_attainment,alive:original.O.aliveCrops,T6:trial.passed,
      interventionPasses:original.jointConditions.filter(c=>c.id.endsWith(':intervention') && c.passed).length}))
  }
  assert.equal(trial.outcome.forecastImprovement,Math.abs(trial.outcome.gainPerTick)-trial.outcome.forecastError)
  assert.equal(trial.passed,Object.values(trial.checks).every(Boolean));assert.equal(trial.checks.forecast,trial.outcome.forecastImprovement>0 || (trial.outcome.zeroEffectError===0 && trial.outcome.forecastError===0))
  assert.equal(original.tick,horizon);assert.equal(original.stopReason,'normal')
  const out=join(replayHome,`${mode}.replay.json`)
  await exec(process.execPath,['--experimental-transform-types',join(root,'app/mars-evaluate.mjs'),'--home',home,'--output',out],{encoding:'utf8'})
  const replay=JSON.parse(readFileSync(out,'utf8'));for(const [key,value] of Object.entries(original)) assert.deepEqual(replay[key],value,key)
  console.log(JSON.stringify({mode,full,selected:trial.declaration.choice.selected,gain:trial.outcome.gainPerTick,production:trial.checks.measuredGain,forecast:trial.checks.forecast,energy:trial.outcome.energy,offlineMatch:true}))
  return trial.outcome
}
const both=await Promise.allSettled(['multi','single'].map(run));for(const r of both) if(r.status==='rejected') throw r.reason
assert.deepEqual(both[0].value,both[1].value)
const pair=await exec(process.execPath,[join(root,'app/mars-pair.mjs'),join(fixture,'multi'),join(fixture,'single')],{encoding:'utf8'})
assert.equal(JSON.parse(pair.stdout).comparable,true)
console.log('PASS matched scientific trial, cross-role repair, version checks and offline replay. Real model calls: 0.')
