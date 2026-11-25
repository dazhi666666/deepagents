/** Replay public planning conditions that can strand an r3-style service before measurement. */
import assert from 'node:assert/strict'
import { inspectServicePortfolio } from '../app/science-harness/integrations/ai4science/mars/v06/service-portfolio.ts'
import { initialMarsRules } from '../app/science-harness/integrations/ai4science/mars/world.ts'
import { planRoute } from '../app/science-harness/integrations/ai4science/mars/routing.ts'
const rules = initialMarsRules(), scenario = {loadingTicks:2,handlingTicks:2,maintenanceTicks:3}
const route = (a,b) => planRoute(a,b,0,[],rules.speed).at(-1)?.endTick ?? 0
const outbound = (route('heater-1','confirm')+4)*rules.energyPerTick
const samples=[{id:'prepared',location:'heater-1',volumeUl:100},{id:'mother',location:'heater-1',volumeUl:150},
  {id:'occupied-qc',location:'confirm',volumeUl:20}]
const lab={tick:100,devices:[{id:'confirm',capacity:1,dirty:true},{id:'freezer',capacity:10,dirty:false}],samples,operations:[],
  methods:[{id:'confirm',processingTicks:5,dirtiesDevice:true}]}
const robot={id:'robot-1',node:'heater-1',energy:outbound+0.1,operationId:null,segments:[]}
const world={rules,scenario,observe:()=>structuredClone(lab),observeSystems:()=>({robots:[{...robot}],operations:[],transports:[]})}
const steps=[{id:'carry',dependsOn:[],at:100,input:{action:'transfer',deviceId:'robot-1',sampleId:'prepared',destination:'confirm'}},
  {id:'measure',dependsOn:['carry'],at:0,input:{action:'process',methodId:'confirm',deviceId:'confirm',sampleId:'prepared',volumeUl:100}},
  {id:'keep',dependsOn:['carry'],at:0,input:{action:'transfer',deviceId:'robot-1',sampleId:'mother',destination:'freezer'}}]
const draft={title:'Shared public resources',steps,service:{commissionId:'a',measurementStepId:'measure',retentionStepId:'keep'}}
const args=[[{id:'a',deadline:110}],[{id:'draft-1',draft,committed:false}],x=>x]
const first=inspectServicePortfolio(world,...args), issues=new Set(first.issues.map(i=>i.code))
for(const code of ['dock_reserve','insufficient_charge','destination_full','clean_first','deadline']) assert.ok(issues.has(code),code)
assert.ok(first.services[0].slackTicks<0);assert.equal(first.services[0].outlook,'review_projection')
assert.deepEqual(inspectServicePortfolio(world,...args),first);assert.deepEqual(world.observe().samples,samples)
const cancelled = {...draft,id:'cancelled',state:'cancelled',operations:{}}
const terminal = inspectServicePortfolio(world,args[0],[{id:cancelled.id,draft:cancelled,saved:cancelled,committed:false}],x=>x)
assert.equal(terminal.services[0].outlook,'terminal');assert.equal(terminal.services[0].slackTicks,null)
assert.ok(terminal.steps.every(s=>s.status==='not_dispatched' && s.endTick===null))
const {reviewServices,requireServiceReview}=await import('../app/science-harness/integrations/ai4science/mars/v06/service-review.ts')
const saved={...draft,id:'service-a',actorId:'service',createdTick:1,revision:1,state:'scheduled',operations:{}}
const review=reviewServices(world,args[0],[saved]), decision=review.plans[0]
assert.equal(decision.firstBlocker.code,'dock_reserve');assert.throws(()=>requireServiceReview(review,saved.id,decision.reviewId),/dock_reserve/)
robot.energy=120
const feasible=reviewServices(world,[{id:'a',deadline:500}],[saved]);assert.equal(feasible.plans[0].eligible,true)
requireServiceReview(feasible,saved.id,feasible.plans[0].reviewId)
const amended=reviewServices(world,[{id:'a',deadline:500}],[{...saved,title:'revised transport route'}]);assert.throws(()=>requireServiceReview(amended,saved.id,decision.reviewId),/reviewId/)
const {resolveResearchHandoff}=await import('../app/science-harness/integrations/ai4science/mars/v06/research-handoff.ts')
const signed=resolveResearchHandoff({taskId:'T3',slotId:'final',references:[{kind:'service-review',id:decision.reviewId}]},100,{researchWorkflow:'reviewed-v1',baselineTick:150,finalTick:300,horizon:500},{},{},{serviceReviewReceipt:()=>decision},id=>id)
assert.equal(signed.references[0].eligible,false);assert.equal(signed.references[0].firstBlocker.code,'dock_reserve')
const {serviceWindows}=await import('../app/science-harness/integrations/ai4science/mars/v06/service-review.ts')
const commission={id:'a',sourceId:'reservoir',deadline:1206,preserveUntil:2400,minimumRemainingUl:10,methods:['screen']}
const inventory={ ...lab,tick:900,revocations:[{resultId:'revoked',tick:890}],samples:[{id:'tested-mother',state:'raw',disposition:'available',volumeUl:15,expiresAt:2450,location:'cold-2'},{id:'unmeasured',state:'raw',disposition:'available',volumeUl:100,expiresAt:2500}],
  results:[{id:'measured',sampleId:'aliquot',rootSampleId:'tested-mother',methodId:'screen',completedTick:880},{id:'revoked',rootSampleId:'unmeasured',methodId:'screen',completedTick:870}] }
const sampleWorld={rules,observe:()=>inventory,observeSystems:()=>({sampleSources:{'tested-mother':'reservoir',unmeasured:'reservoir'}})}
const [window]=serviceWindows(sampleWorld,[commission]);assert.equal(window.earliestSampleCompletionTick,800);assert.equal(window.timelyMeasurements,1)
assert.equal(window.mothers[0].rootSampleId,'tested-mother');assert.equal(window.mothers[0].viableByPublicInventory,true)
inventory.samples[0].volumeUl=0;assert.equal(serviceWindows(sampleWorld,[commission])[0].mothers[0].viableByPublicInventory,false)
console.log('PASS route checks, review handoff, measured mother lineage, expiry and live inventory')
