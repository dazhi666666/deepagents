import { marsLayout, deviceCatalog, TASKS } from '../src/layout.js'
import { BUNDLE_VERSION, compileOperations, validateBundle, publicSnapshot } from '../src/data.js'

/** Deterministic integration fixtures. Never a copy of an experiment, and never sent to a model. */
export function demoBundle() {
  const layout = marsLayout()
  const runs = ['multi', 'single'].map((mode, runIndex) => {
    const id = `fixture-${mode}-v06`, horizon = 240
    const roles = mode === 'multi' ? ['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst'] : ['single']
    const participants = roles.map(role => ({ actorId: `${mode}:${role}`, role, tick: 0 }))
    const actor = role => `${mode}:${mode === 'single' ? 'single' : role}`
    const jobs = [
      ['o-transfer-1', 12, 14, 44, {action:'transfer',deviceId:'robot-1',sampleId:'sample-A',destination:'liquid-handler'}, 'water'],
      ['o-dispenser', 46, 50, 62, {action:'aliquot',deviceId:'liquid-handler',sampleId:'sample-A',volumeUl:100,container:'tube'}, 'water'],
      ['o-transfer-2', 64, 68, 90, {action:'transfer',deviceId:'robot-1',sampleId:'sample-A-1',destination:'centrifuge-1'}, 'water'],
      ['o-centrifuge', 92, 96, 110, {action:'process',deviceId:'centrifuge-1',sampleId:'sample-A-1',volumeUl:100,methodId:'centrifuge',methodVersion:1}, 'water'],
      ['o-transfer-3', 112, 114, 140, {action:'transfer',deviceId:'robot-1',sampleId:'sample-A-1',destination:'confirm'}, 'water'],
      ['o-confirm', 142, 146, 172, {action:'process',deviceId:'confirm',sampleId:'sample-A-1',volumeUl:50,methodId:'confirm',methodVersion:2}, 'water'],
      ['o-clean', 174, 178, 188, {action:'clean',deviceId:'confirm'}, 'engineer'],
      ['o-screen', 64, 68, 84, {action:'process',deviceId:'screen',sampleId:'sample-B',volumeUl:50,methodId:'screen',methodVersion:1}, 'analyst'],
      ['o-imager', 132, 136, 155, {action:'process',deviceId:'imager',sampleId:'sample-C',volumeUl:20,methodId:'image',methodVersion:1}, 'crops'],
    ]
    const labOperations = jobs.map(([id,acceptedTick,processingTick,completedTick,command,role]) => ({id,acceptedTick,nextTick:completedTick,completedTick,state:'succeeded',stage:'finished',command,role,resultIds:command.action==='process'?[`result:${id}`]:[]}))
    const systemOperations = [{id:'so-light',acceptedTick:24,nextTick:26,completedTick:26,state:'succeeded',command:{action:'light',chamberId:'incubator-2',level:80},result:{level:80}}]
    const events = [{tick:0,kind:'laboratory-created',payload:{}}]
    for(const [index, op] of labOperations.entries()){
      const processingTick=jobs[index][2]
      events.push({tick:op.acceptedTick,kind:'operation-accepted',payload:{...op,state:'running',stage:'loading',completedTick:undefined}},
        {tick:processingTick,kind:'operation-processing',payload:{...op,state:'running',stage:'processing',completedTick:undefined}},
        {tick:op.completedTick,kind:'operation-finished',payload:{...op}})
    }
    for(const op of systemOperations)events.push({tick:op.acceptedTick,kind:'system-operation-accepted',payload:{...op,state:'running'}},{tick:op.completedTick,kind:'system-operation-settled',payload:op})
    const routeSpecs = [
      ['o-transfer-1',12,[['robot-1','door:robot-bay',14,19],['door:robot-bay','door:warehouse',19,25],['door:warehouse','door:preparation',25,32],['door:preparation','liquid-handler',32,40]]],
      ['o-transfer-2',64,[['liquid-handler','door:preparation',68,77],['door:preparation','centrifuge-1',77,86]]],
      ['o-transfer-3',112,[['centrifuge-1','door:preparation',114,120],['door:preparation','door:analysis',120,129],['door:analysis','confirm',129,136]]],
    ]
    const routes=routeSpecs.map(([operationId,tick,segments])=>({operationId,robotId:'robot-1',tick,finishTick:labOperations.find(o=>o.id===operationId).completedTick,segments:segments.map(([from,to,startTick,endTick])=>({from,to,startTick,endTick}))}))
    for(const route of routes){
      const node=layout.nodes.find(n=>n.id===route.segments.at(-1).to)
      events.push({tick:route.tick,kind:'robot-route-accepted',payload:route},{tick:route.finishTick,kind:'robot-operation-settled',payload:{operationId:route.operationId,robotId:'robot-1',state:'succeeded',position:{node:node.id,x:node.x,y:node.y},cargo:[]}})
    }
    events.sort((a,b)=>a.tick-b.tick);events.forEach((e,i)=>{e.seq=i+1;e.source='physical'})
    const executions=labOperations.map(o=>({id:o.id,actorId:actor(o.role),providerId:'facilities'})).concat([{id:'so-light',actorId:actor('agronomist'),providerId:'greenhouse'}])
    const operations=compileOperations(labOperations,systemOperations,executions,events)
    const devices=deviceCatalog(layout).filter(d=>!['solar-array','battery','co2-tank','spares','quarantine-bay'].includes(d.id)).map(d=>({id:d.id,kind:d.id.startsWith('robot-')?'robot':d.id.startsWith('incubator-')?'incubator':d.id,methods:[],capacity:12,dirty:d.id==='centrifuge-1',broken:false,enabled:true,shed:false,...(d.id.startsWith('cold')?{temperature:4,targetTemperature:4}:{}),...(d.id==='confirm'?{calibrationId:'cal-fixture',calibratedUntil:280}:{})}))
    const lab={tick:horizon,devices,samples:[{id:'sample-A',container:'tube',location:'liquid-handler',volumeUl:400,state:'raw',expiresAt:500,disposition:'available',batchIds:[]},{id:'sample-A-1',parentId:'sample-A',container:'tube',location:'confirm',volumeUl:50,state:'confirmed',expiresAt:500,disposition:'available',batchIds:[]},{id:'sample-B',container:'plate',location:'screen',volumeUl:150,state:'screened',expiresAt:500,disposition:'available',batchIds:[]},{id:'sample-C',container:'tube',location:'imager',volumeUl:80,state:'imaged',expiresAt:500,disposition:'available',batchIds:[]}],facilities:{waterUl:4200,waterCapacityUl:12000,ambientTemperature:22,powerCapacity:200},batches:[{id:'qc-cleaning',kind:'cleaner',units:5,expiresAt:900,disposition:'available'}],methods:[{id:'confirm',version:2,inputState:'raw',outputState:'confirmed'}],results:labOperations.filter(o=>o.resultIds.length).map(o=>({id:o.resultIds[0],operationId:o.id,sampleId:o.command.sampleId,rootSampleId:o.command.sampleId==='sample-A-1'?'sample-A':o.command.sampleId,methodId:o.command.methodId,methodVersion:o.command.methodVersion,completedTick:o.completedTick,batchIds:[]})),revocations:[]}
    const systems={robots:layout.anchors.filter(a=>a.id.startsWith('robot-')).map(a=>({id:a.id,x:a.id==='robot-1'?37:a.x,y:a.id==='robot-1'?18:a.y,node:a.id==='robot-1'?'confirm':a.id,energy:90,operationId:null,updatedTick:horizon,segments:[]})),crops:Array.from({length:12},(_,i)=>({id:`crop-${i+1}`,chamberId:`incubator-${Math.floor(i/3)+1}`,status:'healthy',removed:false,availableSampleUl:9000}))}
    const base={energy:{soc:560-runIndex*30,solar:18,demand:14,tauDust:.5,priority:devices.map(d=>d.id),shed:[]},atmosphere:Object.fromEntries([1,2,3,4].map(i=>[`incubator-${i}`,{co2:800,pressure:70,setpoint:800,quarantine:false}])),water:{route:'main',reserve:500,inlineAlarm:{}},co2Tank:11000,spares:{membrane:1,bearing:2,lamp:2},metrics:{ticks:horizon,tierOneShedTicks:0,waterUnavailableTicks:0,shedTicksByLoad:{}}}
    const telemetry={}
    for(let tick=0;tick<=horizon;tick+=2){
      const readings={'energy.solar':Math.max(0,30*Math.sin(tick/96*Math.PI*2)),'energy.demand':14+2*Math.sin(tick/21),'energy.soc':560-70*Math.cos(tick/96*Math.PI*2)-runIndex*30,'energy.tau_dust':.5,'energy.co2_tank':12000-tick*4,'water.tank':6000-tick*7,'water.reserve':800-tick*1.25,'reservoir.doc_inline':3.1+.2*Math.sin(tick/25),'filter.doc_inline':1.6+.1*Math.sin(tick/20),'pump.doc_inline':1.9+.1*Math.sin(tick/22)}
      for(let i=1;i<=4;i++)Object.assign(readings,{[`incubator-${i}.temperature`]:22+.4*Math.sin(tick/30+i),[`incubator-${i}.co2`]:800+10*Math.sin(tick/24),[`incubator-${i}.pressure`]:70+.1*Math.sin(tick/30),[`incubator-${i}.light`]:i===2&&tick>=26?80:70})
      for(const [channel,value]of Object.entries(readings))(telemetry[channel]??=[]).push([tick,Number(value.toFixed(4))])
    }
    const facts=participants.map(p=>({source:'execution',kind:'mars-organization',actorId:'host',tick:0,data:{kind:'member-joined',...p}}))
    for(let tick=0;tick<=180;tick+=12)for(const p of participants)facts.push({source:'execution',kind:'mars-native-decision',actorId:p.actorId,tick,data:{actorId:p.actorId,tick}})
    for(const task of TASKS)facts.push({source:'execution',kind:'mars-v06-record',actorId:actor('brain'),tick:176,data:{operation:'submission',actorId:actor('brain'),result:{taskId:task.id,slotId:'final',revision:1,acceptedTick:176,acceptedSeq:facts.length+1,payload:{summary:'集成样例提交，用于验证页面与证据跳转'},evidence:task.id==='T1'?[{id:'result:o-confirm',purpose:'water'}]:[],references:[],hash:'a'.repeat(64)}}})
    facts.push({source:'execution',kind:'mars-v06-research',actorId:actor('analyst'),tick:170,data:{record:{id:'note-water',kind:'study',project:'PW',revision:1,availableAt:170,content:{summary:'集成样例：比较筛查与确认记录'},evidence:[{id:'result:o-confirm'}]}}},
      {source:'execution',kind:'mars-mail',actorId:'host',tick:92,data:{role:mode==='multi'?'water':'single',message:{id:'mail-1',from:'brain',tick:92,text:'集成样例消息：核对样品前处理记录。',read:true}}})
    facts.forEach((f,i)=>f.seq=i+1)
    const q={T1:.82-runIndex*.08,T2:.7,T3:.75,T4:.65,T5:.73}
    const report={benchmarkVersion:'v0.6',version:'v0.6',tick:horizon,completionStatus:'finalized',stopReason:'normal',R:100*Object.values(q).reduce((a,b)=>a+b,0)/5,q,O:{cropSurvival:1,cropCount:12,aliveCrops:12,criticalShedFraction:0,waterUnavailableTicks:0,ticks:horizon,succeededOperations:operations.length,failedOperations:0,samplesAvailable:4},F:false,jointConditions:[{id:'T4:science',passed:false},{id:'operation:crop-survival',passed:true}],failureReasons:['T4:science'],components:{current_accuracy:.8,storage_accuracy:.83},phaseSeals:[{stage:'baseline',tick:72,hash:'b'.repeat(64)},{stage:'final',tick:180,hash:'c'.repeat(64)},{stage:'horizon',tick:240,hash:'d'.repeat(64)}],calibrationStatus:'candidate_not_frozen',formalRankingEligible:false,protocolHash:'a'.repeat(64),caseManifestHash:'b'.repeat(64)}
    return {id,mode,label:mode==='multi'?'Multi 团队':'Single 单体',benchmarkVersion:'v0.6',tick:horizon,horizon,layout,
      manifest:{benchmarkVersion:'v0.6',mode,truthHash:'1'.repeat(64),saltHash:'2'.repeat(64),scenarioHash:'3'.repeat(64),caseManifestHash:'b'.repeat(64),protocolHash:'a'.repeat(64),horizon,decisionTicks:12,modelSource:'scripted-integration',model:{provider:'fixture',model:'无模型调用'},stages:{baselineTick:72,finalTick:180,horizon}},
      snapshot:publicSnapshot(lab,systems,base),operations,events,routes,telemetry,participants,facts,report,
      coverage:{operationHistory:true,fromTick:0,toTick:horizon,snapshotTick:horizon,historicalHealth:false,historicalInventory:false,warnings:[]},
      analyses:[{id:'a-0001',actorId:actor('analyst'),asOfTick:170,status:'done',code:'// 集成样例记录，仅供查看，不在浏览器执行\nreturn {meanSignal: 1.9};',codeSha256:'e'.repeat(64),output:{meanSignal:1.9},logs:['集成样例'],error:null,dataAccesses:[{kind:'raw',id:'result:o-confirm'}]}],
      measurements:[{id:'result:o-confirm',data:{methodVersion:2,instrumentSummary:1.9,summaryMethod:'集成样例',flags:[]}}],
      raw:[{id:'result:o-confirm',data:{kind:'chromatogram',dtMinutes:.02,points:Array.from({length:600},(_,i)=>Number((.04+2.3*Math.exp(-Math.pow((i*.02-5.1)/.13,2))+.9*Math.exp(-Math.pow((i*.02-7.8)/.1,2))).toFixed(5)))}}],
      catalog:{version:'v0.6',tasks:TASKS,commissions:[{id:'J-A',title:'可信供水与异常解释',dimensions:['T1','T4','T5']},{id:'J-B',title:'资源受限的作物改进',dimensions:['T2','T3']},{id:'J-C',title:'多项目研究交付',dimensions:['T3','T5','T6']}],instructions:'集成样例；分数、曲线、工作记录均非真实实验。'},sources:[]}
  })
  return validateBundle({version:BUNDLE_VERSION,source:'fixture',createdAt:'2026-11-16T00:00:00.000Z',runs})
}
