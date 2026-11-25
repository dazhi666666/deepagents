/** Public, deterministic controls for receipt ordering, ownership, selection and shared plan boundaries. */
import assert from 'node:assert/strict'
import { DeliveryLedger, deliverySpec } from '../app/science-harness/integrations/ai4science/mars/v06/delivery.ts'
import { pendingScope, guardTrialChambers, checkCropScope } from '../app/science-harness/integrations/ai4science/mars/v06/shared-plan.ts'
const stages={baselineTick:72,finalTick:180,horizon:240,researchWorkflow:'delivery-v2',jointTrial:'shared-plan-v3'}
let tick=48
const events=[], store={eventCursor:()=>events.length,events:(_,after)=>events.slice(after),recordFact:(_,kind,data)=>events.push({seq:events.length+1,type:'fact',data_json:JSON.stringify({kind,data,logicalTick:tick})})}
const ledger=new DeliveryLedger(store,{},()=>tick), add=(kind,data)=>store.recordFact({},kind,data)
function queue(owner,round,callId,args={}) {
  const meta=deliverySpec('analysis_run',args,owner,owner==='single'?['single']:['service','engineer','brain'],stages)
  add('mars-v06-round',{key:`intent:${round}:${owner}:0`,value:{actorId:owner,input:{tool:'analysis_run',args,callId,delivery:meta}}})
  return ledger.list(owner).items.at(-1).id
}
const receipt=(actorId,round,callId,result)=>add('mars-v06-native-receipt',{actorId,round,callId,result})
const assigned=deliverySpec('experiment_plan',{input_json:JSON.stringify({service:{commissionId:'s1'}})},'service',['service','engineer'],stages,[{id:'s1',deadline:116}])
assert.equal(assigned.task,'s1');assert.equal(assigned.beforeTick,116)
const id=queue('service',4,'shared-call-id',{follow_up:{task:'T3',next:'Use measured supply',backup:'engineer'}})
assert.equal(ledger.due().size,0);ledger.cancelOwner('service','interrupted-1');assert.equal(ledger.get(id,'engineer').state,'pending')
receipt('service',4,'shared-call-id',{isError:true,error:'Observation unavailable'});const [ready]=ledger.due().get('engineer');assert.equal(ready.id,id)
ledger.notified([ready]);ledger.notified([ready]);assert.equal(ledger.due().size,0)
assert.equal(ledger.get(id,'engineer').result.error,'Observation unavailable');assert.equal(ledger.list('engineer').total,1)
assert.throws(()=>ledger.change('service','wrong',id,ready.revision,null,''),/current open/)
const sent=ledger.change('engineer','send',id,ready.revision,'brain','Choose a new observation');assert.deepEqual(ledger.change('engineer','send',id,ready.revision,'brain','Choose a new observation'),sent)
assert.throws(()=>ledger.change('engineer','send',id,ready.revision,'brain','Different request'),/different input/)
assert.equal(ledger.due().get('brain')[0].revision,sent.revision)
const readItem=queue('service',5,'read-and-delegate');receipt('service',5,'read-and-delegate',{output:3});assert.equal(ledger.get(readItem,'service').state,'read')
assert.equal(ledger.list('service').total,0);ledger.change('service','delegate-after-read',readItem,1,'engineer','Apply known result',()=>true)
assert.equal(ledger.get(readItem,'engineer').state,'ready');ledger.change('engineer','applied',readItem,2,null,'')
const other=queue('single',4,'shared-call-id');ledger.cancelOwner('single');receipt('single',4,'shared-call-id',{output:1})
assert.equal(ledger.get(other,'single').state,'paused');assert.equal(ledger.due().has('single'),false)
const expired=queue('service',5,'expired',{follow_up:{task:'T6',next:'Confirm baseline',beforeTick:72}});tick=72;receipt('service',5,'expired',{accepted:false})
assert.ok(!ledger.list('service').items.some(i=>i.id===expired));assert.equal(ledger.due().has('service'),false)
const reconstructed=new DeliveryLedger(store,{},()=>tick);assert.deepEqual(reconstructed.get(id,'brain'),ledger.get(id,'brain'))
const all=reconstructed.since(0,50).items;let cursor=0;const paged=[]
for(;;){const page=reconstructed.since(cursor,2);paged.push(...page.items);cursor=page.cursor;if(!page.more)break}
assert.deepEqual(paged,all);assert.equal(reconstructed.since(cursor).items.length,0)
const step=(id,action,chamber,at,dependsOn=[])=>({id,input:{action,chamberId:`incubator-${chamber}`},at,dependsOn})
const full={id:'combined',state:'scheduled',operations:{},steps:[step('outside','irrigate',3,190),step('water','irrigate',1,0,['outside']),step('end','scan',1,230,['water']),step('ctrl','irrigate',2,192)]}
const {planNeedsDispatch}=await import('../app/science-harness/integrations/ai4science/mars/v05/planning.ts')
assert.equal(planNeedsDispatch(full,160,()=>undefined),false)
assert.equal(planNeedsDispatch({...full,state:'running',operations:{outside:'op'}},160,()=> 'unknown'),true)
assert.equal(planNeedsDispatch({...full,state:'running',operations:{outside:'op'}},190,()=> 'succeeded'),true)
const partial=pendingScope(full,{stepIds:['water','end']},stages)
assert.equal(partial.steps[0].at,190);assert.throws(()=>pendingScope(full,{stepIds:['water','water']},stages),/Select each step once/)
assert.throws(()=>pendingScope(full,{stepIds:['missing']},stages),/Unknown selected/)
assert.throws(()=>pendingScope({...full,state:'running'},{stepIds:['end']},stages),/unstarted/)
const pilot={treatmentCropId:'crop-1-1',controlCropId:'crop-2-1'}
assert.throws(()=>guardTrialChambers(full,partial,pilot),/trial-chamber intervention ctrl/)
guardTrialChambers(full,pendingScope(full,{stepIds:['water','end','ctrl']},stages),pilot)
checkCropScope(partial,['crop-1-1']);assert.throws(()=>checkCropScope({...partial,steps:[{...partial.steps[0],input:{...partial.steps[0].input,cropId:'crop-1-3'}}]},['crop-1-1']),/fixed crop/)
const {materializeSubmission}=await import('../app/science-harness/integrations/ai4science/mars/v06/selected-submission.ts')
const directory=[{kind:'prediction',id:'pred',field:'payload.predictionId'},{kind:'note',id:'model',field:'evidence'},{kind:'operation',id:'scan',field:'evidence'}]
const records={predictions:()=>[{id:'pred',taskId:'T2',slotId:'final',modelId:'model'}]}
const select=request=>materializeSubmission({taskId:'T2',slotId:'final',expectedRevision:0,...request},records,q=>({items:directory.filter(r=>q.ids.includes(r.id))}),x=>x==='so-1'?'scan':x,id=>id==='scan'||id==='model')
const chosen=select({references:[{kind:'prediction',id:'pred'},{kind:'note',id:'model',purpose:'validation'},{kind:'operation',id:'so-1',purpose:'intervention'}]})
assert.equal(chosen.payload.modelId,'model');assert.deepEqual(chosen.evidence.map(r=>r.id),['model','scan'])
assert.throws(()=>select({references:[{kind:'analysis',id:'scan',purpose:'validation'}]}),/unavailable/)
assert.throws(()=>select({payload:{predictionId:'another'},references:[{kind:'prediction',id:'pred'}]}),/Conflicting selection/)
const {sealedSubmission}=await import('../app/science-harness/integrations/ai4science/mars/v06/finalize.ts')
const {contentHash}=await import('../app/science-harness/integrations/ai4science/mars/v06/contracts.ts')
const paper={taskId:'T2',slotId:'final',revision:2,acceptedSeq:22,payload:{planId:'all',stepIds:['water','end']},references:[{kind:'plan',id:'all',hash:'1'.repeat(64)}]}
const frozen={selected:()=>({acceptedSeq:22,revision:2,payloadHash:contentHash(paper.payload),references:paper.references})}
assert.deepEqual(sealedSubmission({submissions:()=>[paper]},frozen,'T2'),paper)
assert.throws(()=>sealedSubmission({submissions:()=>[{...paper,payload:{...paper.payload,stepIds:['end']}}]},frozen,'T2'),/declaration/)
console.log('PASS receipt handoff and replay, cursor pagination, scoped isolation, typed selections, and verification of frozen step claims')
