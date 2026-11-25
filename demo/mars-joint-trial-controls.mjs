/** Independent public examples exercise the outcome gates without private target values. */
import assert from 'node:assert/strict'
import { evaluateJointTrial, checkJointPlan } from '../app/science-harness/integrations/ai4science/mars/v06/joint-trial.ts'
const stages = { baselineTick: 20, finalTick: 100, horizon: 200, jointTrial: 'paired-growth-v1' }
const trial = { treatmentCropId:'crop-1-1',controlCropId:'crop-2-1',forecastGainPerTick:0.1,waterBudgetUl:100,energyBudget:1200 }
const payload = { planId:'public-plan',trial }, submission = {payload}
const commands = [{action:'irrigate',chamberId:'incubator-1',volumeUl:80}, {action:'light',chamberId:'incubator-1',level:80},
  {action:'scan',chamberId:'incubator-1'}, {action:'scan',chamberId:'incubator-2'}]
const steps = commands.map((input,i)=>({id:`step-${i}`,input,at:[101,105,180,180][i],dependsOn:[]}))
const unstarted = {id:payload.planId,state:'scheduled',operations:{},steps}
checkJointPlan(unstarted,payload,stages)
assert.throws(()=>checkJointPlan({...unstarted,steps:[steps[2]]},payload,stages),/irrigation and a light/)
assert.throws(()=>checkJointPlan({...unstarted,operations:{started:'op'}},payload,stages),/unstarted/)
assert.throws(()=>checkJointPlan(unstarted,{...payload,trial:{...trial,controlCropId:'crop-1-1'}},stages),/same variety/)
assert.throws(()=>checkJointPlan(unstarted,{...payload,trial:{...trial,energyBudget:9999}},stages),/budget/)
const ops = steps.map((s,i)=>({id:`op-${i}`,command:s.input,state:'succeeded',acceptedTick:s.at,completedTick:s.at+2}))
const plan={...unstarted,state:'succeeded',operations:Object.fromEntries(steps.map((s,i)=>[s.id,ops[i].id]))}
const crops=[trial.treatmentCropId,trial.controlCropId].map(id=>({id,status:'healthy',removed:false,biomass:25}))
const end=crops.map((c,i)=>({...c,biomass:i===0?45:35}))
const evidence={currentWater:true,measuredEnergy:true}
function score({declaration=trial, final=end, work=ops, linked=plan, base=crops, useEvidence=evidence, labOps=[]}={}) {
  const world={stages,observe:()=>({operations:labOps}),observeSystems:()=>({operations:work,crops:final,light:{'incubator-1':80,'incubator-2':70}}),
    quality:()=>({snapshots:{100:{crops:base},200:{jointEnergy:{ticks:100,delivered:1100}}}})}
  return evaluateJointTrial(world,{...submission,payload:{...payload,trial:declaration}},linked,useEvidence)
}
assert.equal(score().passed,true)
for(const [field,change] of [ ['forecast',{declaration:{...trial,forecastGainPerTick:0.8}}],['water',{declaration:{...trial,waterBudgetUl:40}}],
  ['energy',{declaration:{...trial,energyBudget:900}}], ['comparableStart',{base:[{...crops[0],biomass:5},crops[1]]}], ['bothAlive',{final:[end[0],{...end[1],status:'lost'}]}],
  ['currentWater',{useEvidence:{...evidence,currentWater:false}}], ['measuredEnergy',{useEvidence:{...evidence,measuredEnergy:false}}],
  ['verified',{work:[...ops.slice(0,3),{...ops[3],acceptedTick:130,completedTick:132}]}], ['interventionsExecuted',{work:ops.slice(1)}],
  ['comparisonProtocol',{labOps:[{state:'succeeded',completedTick:155,command:{action:'configure',deviceId:'incubator-2'}}]}],
  ['comparisonProtocol',{work:[...ops,{...ops[0],id:'outside-plan'}]}], ['measuredGain',{final:[{...end[0],biomass:30},end[1]]}] ]) {
  const result=score(change);assert.equal(result.passed,false,field);assert.equal(result.checks[field],false,field)
}
console.log('PASS public matched-growth example and independent negative controls for evidence, timing, forecast, growth, budgets and experimental control')
