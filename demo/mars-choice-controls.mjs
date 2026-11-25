/** Public controls for effects that a live scripted pair cannot cover in one world. */
import assert from 'node:assert/strict'
import { planHash } from '../app/science-harness/integrations/ai4science/mars/v06/actions.ts'
import { pilotSchema, selectedArm } from '../app/science-harness/integrations/ai4science/mars/v06/pilot-choice-contract.ts'
import { checkPilotPlan, pilotObservations, checkChoice, evaluateChoice } from '../app/science-harness/integrations/ai4science/mars/v06/pilot-choice.ts'
const stages = { baselineTick:50, finalTick:150, horizon:250, jointTrial:'pilot-choice-v2' }
const ch = n => `incubator-${n}`, crop = n => `crop-${n}-1`, step = (id,at,input,dependsOn=[]) => ({id,at,input,dependsOn})
const plan = (id,steps) => ({id,actorId:'public-researcher',createdTick:10,title:id,state:'scheduled',steps,operations:{}})
const realized = p => ({...p,state:'succeeded',operations:Object.fromEntries(p.steps.map(s=>[s.id,`op-${s.id}`]))})
const scans = (n,level) => [step(`before-${n}`,52,{action:'scan',chamberId:ch(n)}),step(`light-${n}`,60,{action:'light',chamberId:ch(n),level},[`before-${n}`]),step(`after-${n}`,84,{action:'scan',chamberId:ch(n)},[`light-${n}`])]
const pilot = {arms:{A:{cropId:crop(3),light:80},B:{cropId:crop(4),light:50}},treatmentCropId:crop(1),controlCropId:crop(2)}
const screening = plan('screening',[...scans(3,80),...scans(4,50)])
const validation = plan('validation',[step('water',152,{action:'irrigate',chamberId:ch(1),volumeUl:60}),step('treatment',155,{action:'light',chamberId:ch(1),level:80}),...([1,2].map(n=>step(`end-${n}`,235,{action:'scan',chamberId:ch(n)})))])
const base = {payload:{planId:screening.id,pilot},references:[{kind:'plan',id:screening.id,hash:planHash(screening)}]}
const choice = {selected:'A',forecasts:{A:{gainPerTick:0.1,energy:850},B:{gainPerTick:-0.02,energy:750}},waterBudgetUl:100,energyBudget:1000}
const measurements = [...screening.steps,...validation.steps].map(s=>({id:`op-${s.id}`,command:s.input,state:'succeeded',acceptedTick:s.at,completedTick:s.at+2,result:{light:s.id==='after-3'?80:s.id==='after-4'?50:70,values:[{cropId:crop(Number(s.input.chamberId.at(-1))),growthIndex:0.5}]}}))
const plants = [1,2].map(n=>({id:crop(n),status:'healthy',removed:false,biomass:20}))
function world({gain=0.1,energy=900,work=measurements}={}) { return {stages,observe:()=>({operations:[]}),observeSystems:()=>({operations:work,crops:plants.map((p,i)=>({...p,biomass:p.biomass+20+(i?0:gain*100)})),light:{[ch(2)]:70}}),quality:()=>({snapshots:{150:{crops:plants},250:{jointEnergy:{ticks:100,delivered:energy}}}})} }
checkPilotPlan(screening,pilot,stages)
assert.throws(()=>pilotSchema.parse({...pilot,treatmentCropId:crop(3)}),/four different/)
assert.throws(()=>checkPilotPlan({...screening,steps:screening.steps.map(s=>s.id==='after-3'?{...s,at:65}:s)},pilot,stages),/pre-scan/)
const observed=pilotObservations(world(),base,realized(screening),140),evidence=observed.readings.flatMap(r=>[r.beforeId,r.afterId]).map(id=>({id,purpose:'validation'}))
checkChoice(validation,choice,observed,evidence,stages)
assert.equal(selectedArm({...choice,energyBudget:800}),'B');assert.equal(selectedArm({...choice,energyBudget:700}),undefined)
assert.equal(selectedArm({...choice,forecasts:{A:{gainPerTick:0,energy:500},B:{gainPerTick:0,energy:500}}}),'A')
assert.throws(()=>checkChoice(validation,{...choice,selected:'B'},observed,evidence,stages),/highest predicted/)
assert.throws(()=>checkChoice(validation,choice,observed,evidence.slice(1),stages),/four observed/)
assert.throws(()=>pilotObservations(world(),base,{...realized(screening),title:'changed'},140),/baseline seal/)
assert.throws(()=>pilotObservations(world({work:[...measurements,{id:'other',state:'succeeded',command:{action:'light',chamberId:ch(3),level:70},completedTick:76}]}),base,realized(screening),140),/Undeclared intervention/)
const score=(w,c=choice)=>evaluateChoice(w,base,realized(screening),{acceptedTick:142,payload:{planId:validation.id,choice:c}},realized(validation),{currentWater:true,measuredEnergy:true})
assert.equal(score(world()).passed,true);assert.ok(score(world()).outcome.forecastImprovement>0)
const zeroGuess={...choice,forecasts:{...choice.forecasts,A:{gainPerTick:0,energy:850}}}
assert.equal(score(world(),zeroGuess).checks.forecast,false);assert.equal(score(world({gain:0}),zeroGuess).checks.forecast,true)
const noEffect=score(world({gain:0}));assert.equal(noEffect.checks.forecast,false);assert.equal(noEffect.checks.measuredGain,false)
const negative=score(world({gain:-0.01}),{...choice,forecasts:{A:{gainPerTick:-0.01,energy:850},B:{gainPerTick:-0.02,energy:750}}});assert.equal(negative.checks.forecast,true);assert.equal(negative.outcome.productionTargetMet,false)
const over=score(world({energy:1100}));assert.equal(over.checks.energy,false);assert.equal(over.outcome.validatedForecastImprovement,null)
console.log('PASS public controls: held-out chambers, temporal separation, changed plan, external treatment, feasible selection, positive/zero/negative gain and whole-base overspend')
