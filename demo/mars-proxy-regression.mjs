#!/usr/bin/env node
/** Local-only gateway compatibility, stream ownership and diagnostics regression. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
mkdirSync(join(root,'demo/.checks'),{recursive:true});const fixture=mkdtempSync(join(root,'demo/.checks/proxy-'))
const keyFile=join(fixture,'key.json');writeFileSync(keyFile,JSON.stringify({apiKey:'fixture-only'}))
const requests=[],held=new Map();let proxyNumber=0
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
const within=async(promise,ms=5000)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Proxy fixture timeout')),ms)})])}finally{clearTimeout(timer)}}
const upstream=createServer(async(req,res)=>{
 req.on('error',()=>{});res.on('error',()=>{})
 const chunks=[];for await(const chunk of req)chunks.push(chunk)
 const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),scenario=body.messages?.[0]?.content??'normal'
 assert.equal(req.headers.authorization,'Bearer fixture-only');requests.push(body)
 if(scenario.startsWith('hold')||scenario==='break'){
  const closed=deferred();held.set(scenario,{res,closed});res.once('close',()=>closed.resolve())
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {}\n\n');return
 }
 if(scenario==='text-envelope'||scenario==='structured'){
  res.writeHead(200,{'content-type':'text/event-stream'})
  const delta=scenario==='text-envelope'?{content:'<invoke name="mars_status"></invoke></｜DSML｜tool_calls>'}:{tool_calls:[{index:0,id:'call-one',type:'function',function:{name:'mars_status',arguments:'{}'}}]}
  const text='data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n'+'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:scenario==='structured'?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})+'\n\n'+'data: [DONE]\n\n'
  const bytes=Buffer.from(text),cut=scenario==='text-envelope'?bytes.indexOf(Buffer.from('｜'))+1:20
  res.write(bytes.subarray(0,cut));res.end(bytes.subarray(cut));return
 }
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}))
})
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const upstreamPort=upstream.address().port
const freePort=async()=>{const s=netServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function startProxy(field='max_tokens',ips='127.0.0.1'){
 const port=await freePort(),log=join(fixture,`proxy-${++proxyNumber}.log`),ready=deferred()
 const child=spawn(process.execPath,[join(root,'app/science/llm-proxy.mjs'),'--port',String(port),'--upstream-port',String(upstreamPort),'--ips',ips,
  '--key-file',keyFile,'--log',log,'--max-output-tokens','30000','--output-token-field',field,'--exit-on-stdin-close'],
  {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,SCIENCE_API_KEY:'fixture-only'}})
 let output='';child.stdout.on('data',data=>{output+=data;if(output.includes('"event":"ready"'))ready.resolve()});child.stderr.on('data',data=>{output+=data})
 await within(Promise.race([ready.promise,once(child,'exit').then(()=>{throw new Error('Proxy failed to start: '+output.slice(-500))})]))
 return{child,origin:`http://127.0.0.1:${port}`,log}
}
const stop=async proxy=>{if(!proxy||proxy.child.exitCode!==null)return;proxy.child.stdin.end();try{await within(once(proxy.child,'exit'))}catch(error){proxy.child.kill();throw error}}
const post=(proxy,scenario,extra={},signal)=>fetch(`${proxy.origin}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture',messages:[{role:'user',content:scenario}],...extra}),signal})
let proxy
try{
 proxy=await startProxy()
 let response=await post(proxy,'normal',{max_completion_tokens:32000});assert.equal(response.status,200);await response.text()
 assert.equal(requests.at(-1).max_tokens,30000);assert.ok(!Object.hasOwn(requests.at(-1),'max_completion_tokens'))
 response=await post(proxy,'normal',{max_tokens:128});await response.text();assert.equal(requests.at(-1).max_tokens,128)
 response=await post(proxy,'normal',{max_tokens:400,max_completion_tokens:100});await response.text();assert.equal(requests.at(-1).max_tokens,100)
 const count=requests.length;response=await post(proxy,'normal',{max_tokens:-1});assert.equal(response.status,400);await response.text();assert.equal(requests.length,count)
 response=await post(proxy,'text-envelope',{stream:true});const raw=await response.text();assert.ok(raw.includes('</｜DSML｜tool_calls>'))
 response=await post(proxy,'structured',{stream:true});await response.text()
 const metadata=readFileSync(proxy.log,'utf8').split('\n').filter(x=>x.includes(' response ')).map(x=>JSON.parse(x.slice(x.indexOf(' response ')+10)))
 assert.ok(metadata.some(x=>x.textToolEnvelope&&x.toolCalls===0));assert.ok(metadata.some(x=>x.toolCalls===1&&x.finish==='tool_calls'))
 const cancel=new AbortController();response=await post(proxy,'hold-cancel',{stream:true},cancel.signal);assert.equal(response.status,200);cancel.abort()
 await assert.rejects(response.text());await within(held.get('hold-cancel').closed.promise)
 let health=await (await fetch(`${proxy.origin}/health`)).json();assert.equal(health.ok,true);assert.deepEqual(health.down,[])
 response=await post(proxy,'break',{stream:true});const broken=response.text();held.get('break').res.destroy(new Error('fixture stream break'));await assert.rejects(broken)
 health=await (await fetch(`${proxy.origin}/health`)).json();assert.equal(health.ok,true)
 response=await post(proxy,'hold-shutdown',{stream:true});const shutting=response.text().then(()=>false,()=>true)
 await stop(proxy);await within(held.get('hold-shutdown').closed.promise);assert.equal(await shutting,true)
 console.log('PASS actual outgoing token cap/field, unchanged UTF-8 streaming bytes and structured response diagnostics')
 console.log('PASS caller abort, upstream stream failure and gateway shutdown release owned upstream work without crashing')
 proxy=await startProxy('max_completion_tokens');response=await post(proxy,'normal',{max_tokens:1000});await response.text()
 assert.equal(requests.at(-1).max_completion_tokens,1000);assert.ok(!Object.hasOwn(requests.at(-1),'max_tokens'));await stop(proxy)
 proxy=await startProxy('max_tokens','127.0.0.2,127.0.0.1');response=await post(proxy,'normal',{max_tokens:100});assert.equal(response.status,200);await response.text()
 assert.equal((await (await fetch(`${proxy.origin}/health`)).json()).down.includes('127.0.0.2'),true)
 console.log('PASS completion-token alias compatibility and pre-header failover remain functional')
 console.log(JSON.stringify({passed:true,fixture,realModelCalls:0}))
}finally{await stop(proxy);upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve))}
