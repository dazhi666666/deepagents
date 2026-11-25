/** Independent actors repair a rejected T2 submission using only the shared revision and public observations. */
import assert from 'node:assert/strict'
import { V06Records } from '../app/science-harness/integrations/ai4science/mars/v06/records.ts'
import { SubmissionDrafts, draftProgress } from '../app/science-harness/integrations/ai4science/mars/v06/submission-drafts.ts'
const facts=[];let tick=30
const journal={readFacts:()=>structuredClone(facts),recordFact:(grant,kind,data)=>facts.push({actorId:grant.actorId,kind,data:structuredClone(data)})}
const profile={baselineTick:60,finalTick:180,horizon:240,researchWorkflow:'reviewed-v1'}
const resolver={validation:()=>({caseSetHash:'1'.repeat(64),availableAt:240}),evidence:id=>id==='scan-1'?{availableAt:22}:null,
  reference:(kind,id)=>kind==='plan' && id==='care-1'?{kind,id,hash:'2'.repeat(64)}:null}
function actor(actorId){const grant={actorId},records=new V06Records(journal,grant,()=>tick,profile,resolver)
  return {records,drafts:new SubmissionDrafts(journal,grant,()=>tick,profile,records,()=>[{group:'holdout_accuracy',eligible:false,missing:['Two more public light settings required']}])}}
const crops=actor('crops'),verifier=actor('verifier'),slot={taskId:'T2',slotId:'final'}
crops.records.registerModel('register',{id:'model-1',code:'return {growthIndex:1}',parameters:{},runtimeVersion:'mars-model-v06-sync-v1',inputSchema:{},outputSchema:{}})
crops.records.commitPrediction('predict',{id:'forecast',...slot,modelId:'model-1',inputDomain:{}})
const bad={...slot,expectedRevision:0,payload:{predictionId:'forecast',modelId:'model-1',planId:'care-1'},evidence:[{id:'forecast',purpose:'validation'}]}
assert.throws(()=>crops.records.submit('wrong',bad),/payload.predictionId/)
const rejection=crops.drafts.rememberFailure('wrong',bad,'Keep this ID in payload.predictionId');assert.ok(rejection)
assert.equal(crops.drafts.rememberFailure('wrong',bad,'same failed request'),null)
const badSave=crops.drafts.save(slot,0,'first',{rejectionId:rejection.id});assert.ok(badSave.draft.problem.includes('payload.predictionId'))
const patch={removePayloadFields:['modelId'],payload:{predictionId:'forecast'},evidence:[{id:'scan-1',purpose:'validation'}]}
const fixed=verifier.drafts.save(slot,1,'fix',patch);assert.equal(fixed.draft.problem,null);assert.equal(fixed.draft.request.payload.modelId,'model-1')
assert.equal(fixed.draft.evidenceChecks[0].eligible,false);assert.equal(crops.drafts.read(slot).accepted,null)
assert.throws(()=>crops.drafts.save(slot,1,'stale',patch),/revision changed/)
assert.throws(()=>verifier.drafts.save(slot,1,'fix',{evidence:[]}),/different input/)
assert.equal(draftProgress(facts).get('T2/final').draft.revision,2)
const sent=verifier.drafts.submit(slot,2,'release');assert.equal(sent.revision,1);assert.equal(sent.acceptedTick,30)
const next=crops.drafts.save(slot,2,'revise',{expectedRevision:1});assert.equal(next.draft.revision,3)
assert.throws(()=>crops.drafts.submit(slot,2,'stale-release'),/revision changed/)
assert.throws(()=>verifier.drafts.submit(slot,3,'release'),/different input/)
tick=180;assert.deepEqual(verifier.drafts.submit(slot,2,'release'),sent);assert.equal(verifier.drafts.save(slot,1,'fix',patch).replay,true)
assert.throws(()=>crops.drafts.save(slot,3,'late',{}),/closed/);assert.throws(()=>crops.drafts.submit(slot,3,'late'),/closed/)
assert.equal(crops.records.submissions().length,1)
const {resolveResearchHandoff} = await import('../app/science-harness/integrations/ai4science/mars/v06/research-handoff.ts')
const inspect = (ref) => resolveResearchHandoff({...slot,references:[ref]},100,profile,crops.records,{}, {draftReceipt:()=>draftProgress(facts).get('T2/final').draft},id=>id)
assert.equal(inspect({kind:'draft',id:'T2/final',revision:3}).references[0].revision,3)
assert.throws(()=>inspect({kind:'draft',id:'T2/final',revision:2}),/revision changed/)
console.log('PASS T2 rejected IDs, cross-role repair, public evidence gaps, versioned handoff, physical cutoff and idempotent replay')
