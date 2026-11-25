/** Replay an archived public rejection in memory at its original tick using the registered r6 tool. */
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {readFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {installResearchTools} from '../app/science-harness/integrations/ai4science/mars/v06/tools.ts'
import {planHash} from '../app/science-harness/integrations/ai4science/mars/v06/actions.ts'
import {baselinePayload,checkPilotPlan} from '../app/science-harness/integrations/ai4science/mars/v06/pilot-choice.ts'
const base=resolve(dirname(fileURLToPath(import.meta.url)),'..'), home=resolve(process.argv[2]??join(base,'data/mars-multi-8-r5'))
const db=new DatabaseSync(join(home,'execution/execution.sqlite'),{readOnly:true}), device=new DatabaseSync(join(home,'device/laboratory.sqlite'),{readOnly:true})
try {
  const rejected=JSON.parse(db.prepare("SELECT data_json FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-v06-rejection' AND json_extract(data_json,'$.data.taskId')='T6' AND json_extract(data_json,'$.data.slotId')='baseline' ORDER BY seq LIMIT 1").get().data_json)
  const now=rejected.logicalTick, request=rejected.data.request, id=request.payload.planId
  const rows=db.prepare("SELECT data_json FROM events WHERE type='fact' AND json_extract(data_json,'$.logicalTick')<=? AND json_extract(data_json,'$.kind') IN ('mars-v06-seal','mars-v06-record','mars-v06-plan-mutation','mars-v06-research') ORDER BY seq").all(now).map(row=>JSON.parse(row.data_json))
  const plan=rows.filter(r=>r.kind==='mars-v06-plan-mutation' && r.data.result.id===id).at(-1).data.result
  const systems=JSON.parse(device.prepare('SELECT state FROM mars_state WHERE id=1').get().state), lab=JSON.parse(device.prepare('SELECT state FROM world WHERE id=1').get().state)
  const observations=[...systems.operations,...lab.operations].filter(o=>o.state==='succeeded' && o.completedTick<=now)
  const known=new Map([...observations,...lab.results.filter(r=>r.completedTick<=now)].map(r=>[r.id,r.completedTick]))
  for(const e of request.evidence)if(/^a-\d+$/.test(e.id)){const a=JSON.parse(readFileSync(join(home,'analysis',e.id+'.json'),'utf8'));if(a.status==='done' && a.asOfTick<=now)known.set(e.id,a.asOfTick)}
  const profile={...JSON.parse(readFileSync(join(home,'manifest.public.json'),'utf8')).stages,researchWorkflow:'delivery-v2'};let tick=now
  const journal={readFacts:()=>rows,recordFact:(grant,kind,data)=>rows.push({actorId:grant.actorId,kind,data:structuredClone(data)})},tools=new Map()
  installResearchTools({register:(name,_description,_schema,body)=>tools.set(name,body),engine:journal,tick:()=>tick,profile,decisionTicks:12,access:agent=>({actorId:agent.id}),
    resolvers:{reference:(kind,ref)=>kind==='plan' && ref===id?{kind,id,hash:planHash(plan)}:null,evidence:ref=>known.has(ref)?{availableAt:known.get(ref)}:null,
      checkJointTrial:payload=>checkPilotPlan(plan,baselinePayload.parse(payload).pilot,profile)},referencePicker:()=>({items:[]})})
  const run=(key,action,input)=>tools.get('research_submit')({action,request_key:key,input_json:JSON.stringify(input)},{id:'replay'},new AbortController().signal)
  assert.throws(()=>run('original','check',request),/Keep this ID in payload.planId/)
  assert.throws(()=>run('bad','check_submit',{...request,evidence:[...request.evidence,{id:'unavailable-observation',purpose:'validation'}]}),/unavailable-observation/)
  const bad=rows.findLast(r=>r.kind==='mars-v06-rejection').data
  const recovered={taskId:'T6',slotId:'baseline',expectedRevision:0,rejectionId:bad.id,evidence:request.evidence}
  const accepted=run('correct','check_submit',recovered);assert.ok(accepted.accepted);assert.equal(accepted.acceptedTick,now);assert.equal(accepted.payload.planId,id)
  assert.deepEqual(accepted.evidence,request.evidence.filter(e=>e.id!==id));assert.equal(accepted.scientificValidation,'not_evaluated')
  tick=profile.baselineTick;assert.deepEqual(run('correct','check_submit',recovered),accepted);assert.throws(()=>run('late','check_submit',request),/closed/)
  console.log(JSON.stringify({originalRejectionTick:now,acceptedInMemory:accepted.acceptedTick,evidenceCount:accepted.evidence.length,revision:accepted.revision,officialDataWrites:0}))
}finally{device.close();db.close()}
