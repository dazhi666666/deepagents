/** Independent journals and processes exercise ownership, WAL readers and durable admission. */
import { afterEach, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ExecutionEngine, type ExecutionOptions } from './execution.ts'
import { Ownership } from './lifecycle.ts'
import { startDashboard } from './dashboard.ts'
import type { ExecutionProvider, Json, OperationRecord, ProviderObservation } from './sdk.ts'
import { readPlatformConfig, type PlatformConfig } from './config.ts'

interface RunningProcess {
  child: ChildProcess
  messages: Record<string, Json>[]
  exited: Promise<number | null>
  readonly stdout: string
  readonly stderr: string
  stop(): Promise<void>
}
const roots: string[] = []
const engines: ExecutionEngine[] = []
const children: RunningProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) await child.stop()
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function launch(args: string[], environment: NodeJS.ProcessEnv = {}): RunningProcess {
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = '', stderr = ''
  const messages: Record<string, Json>[] = []
  child.stdout!.on('data', (data) => { stdout += String(data) })
  child.stderr!.on('data', (data) => { stderr += String(data) })
  child.on('message', (message) => { messages.push(message as Record<string, Json>) })
  const exited = new Promise<number | null>((done, reject) => {
    child.once('error', reject)
    child.once('exit', done)
  })
  const result = {
    child, messages, exited,
    get stdout() { return stdout },
    get stderr() { return stderr },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    },
  }
  children.push(result)
  return result
}

async function message(run: ReturnType<typeof launch>, key: string) {
  await expect.poll(() => run.messages.find((value) => key in value), {
    timeout: 12000, message: `Missing ${key}; stderr: ${run.stderr}`,
  }).toBeTruthy()
  return run.messages.find((value) => key in value)!
}

const providerModule = `import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';import {mkdirSync} from 'node:fs';
export function createProvider(config){
 const {directory}=config;mkdirSync(directory,{recursive:true});
 function journal(fn){const db=new DatabaseSync(join(directory,'device.sqlite'));try{
 db.exec('PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS starts(id TEXT PRIMARY KEY,submits INTEGER,queries INTEGER,cancelled INTEGER,done INTEGER,last_pid INTEGER)');return fn(db)}finally{db.close()}}
 return {
 describe(){return {apiVersion:1,id:'device',version:'1',configuration:config,inputSchema:{},outputSchema:{},units:{budget:'work'},constraints:[],completion:'Observed completion',cancellation:'Durable intent'}},
 prepare(input){return {input,resources:input.resource?[input.resource]:[],budget:1}},
 async submit(op){journal(db=>{db.prepare('INSERT OR IGNORE INTO starts VALUES (?,0,0,0,0,0)').run(op.operationId);db.prepare('UPDATE starts SET submits=submits+1 WHERE id=?').run(op.operationId)});
 if(op.input.hold){process.send?.({inflight:op.operationId});await new Promise(done=>process.once('message',done))}return {state:'running'}},
 async query(op){return journal(db=>{const row=db.prepare('SELECT * FROM starts WHERE id=?').get(op.operationId);if(!row)return {state:'not_found'};
 db.prepare('UPDATE starts SET queries=queries+1,last_pid=? WHERE id=?').run(process.pid,op.operationId);
 return {state:row.cancelled?'cancelled':(op.input.selfDriven?row.done:row.queries+1>=(op.input.polls??4))?'succeeded':'running',progress:{queries:row.queries+1}}})},
 async cancel(op){journal(db=>db.prepare('UPDATE starts SET cancelled=1 WHERE id=?').run(op.operationId));return {disposition:'requested'}}
 }}
`

async function world() {
  const root = mkdtempSync(join(tmpdir(), 'ai4s-lifecycle-'))
  roots.push(root)
  const module = join(root, 'provider.mjs')
  writeFileSync(module, providerModule)
  const config: PlatformConfig = {
    apiVersion: 1, enabled: true, hostApi: '0.2', baseline: '1'.repeat(40),
    directory: join(root, 'domain'), pollIntervalMs: 10, providerCallTimeoutMs: 50,
    controllerLockTimeoutMs: 5000,
    management: { actorId: 'operator', projects: ['p'], allowedProviders: ['device'] },
    providers: [{ module, config: { directory: join(root, 'device') } }],
  }
  const factory = await import(pathToFileURL(module).href) as {
    createProvider(config: Json): ExecutionProvider
  }
  const provider = factory.createProvider(config.providers[0]!.config as Json)
  const options: ExecutionOptions = {
    directory: config.directory, providers: [provider], pollIntervalMs: config.pollIntervalMs,
    providerCallTimeoutMs: config.providerCallTimeoutMs, controllerLockTimeoutMs: 5000,
  }
  const engine = new ExecutionEngine(options)
  engines.push(engine)
  await engine.open()
  engine.createProject('p', 10)
  const c = engine.issueContext('p', 'operator', ['device'])
  return { root, module, config, provider, options, engine, c }
}

function journal(root: string) {
  const db = new DatabaseSync(join(root, 'device', 'device.sqlite'))
  try { return db.prepare('SELECT * FROM starts ORDER BY id').all() }
  finally { db.close() }
}

function source(w: Awaited<ReturnType<typeof world>>, body: string) {
  return `import {ExecutionEngine} from ${JSON.stringify(new URL('./execution.ts', import.meta.url).href)};
  import {createProvider} from ${JSON.stringify(pathToFileURL(w.module).href)};
  const provider=createProvider(${JSON.stringify(w.config.providers[0]!.config)});
  const e=new ExecutionEngine({directory:${JSON.stringify(w.engine.directory)},providers:[provider],pollIntervalMs:10,providerCallTimeoutMs:50,controllerLockTimeoutMs:10000});
  await e.open({recover:false});const c=e.issueContext('p','child',['device']);${body}`
}
function runSource(code: string) {
  return launch(['--import', 'tsx/esm', '--input-type=module', '-e', code])
}

const experimentSpec = {
  goal: 'Bounded independent work', method: { id: 'test', version: '1' }, context: {},
  inputArtifactIds: [], outputRequirements: 'Observed result', budget: 8, maxOperations: 8,
  actions: [{ id: 'work', providerId: 'device', input: {}, maxUses: 8 }],
}
const experimentAction = (requestKey: string) => ({
  actionId: 'work', requestKey, rationale: 'Act within the live controller requirements',
  evidenceOperationIds: [], evidenceArtifactIds: [],
})

it('rejects peer experiment claims, preserves worker actions, and transfers authority after revocation', async () => {
  const w = await world()
  const experiment = w.engine.experiments.create(w.c, 'authority', experimentSpec)
  const second = await w.engine.commandController()
  engines.push(second)
  const peer = second.issueContext('p', w.c.actorId, ['device'])
  expect(() => second.experiments.claim(peer, experiment.id, 'Competing instance')).toThrow('live')
  expect(() => w.engine.experiments.requireController(w.c, experiment.id)).not.toThrow()
  expect(() => second.experiments.requireController(peer, experiment.id)).toThrow('claim')
  const worker = w.engine.issueContext('p', 'worker', ['device'])
  expect((await w.engine.experiments.submit(worker, experiment.id, experimentAction('worker'))).actorId).toBe('worker')
  expect(w.engine.experiments.escalate(worker, experiment.id, 'Review requested by worker', {}).state).toBe('needs_review')
  expect(() => w.engine.experiments.resolve(worker, experiment.id, 'Worker cannot approve')).toThrow('controller')
  w.engine.experiments.resolve(w.c, experiment.id, 'Controller approves original work')
  w.engine.revokeContext(w.c)
  expect(w.engine.experiments.get(worker, experiment.id).controllerActive).toBe(false)
  expect(() => w.engine.experiments.submit(worker, experiment.id, experimentAction('revoked'))).toThrow('context')
  expect(second.experiments.claim(peer, experiment.id, 'Explicit replacement after revocation').controllerActive).toBe(true)
  expect(() => w.engine.experiments.claim(worker, experiment.id, 'Compete with replacement')).toThrow('live')
  second.revokeContext(peer)
  expect(w.engine.experiments.claim(worker, experiment.id, 'Explicit return to original engine').controllerActive).toBe(true)
})

it('worker revocation and terminal cancellation retain the live experiment controller authority', async () => {
  const w = await world()
  const experiment = w.engine.experiments.create(w.c, 'authority', experimentSpec)
  const worker = w.engine.issueContext('p', 'worker', ['device'])
  const second = await w.engine.commandController()
  engines.push(second)
  const peer = second.issueContext('p', 'worker', ['device'])
  w.engine.revokeContext(worker)
  expect(() => second.experiments.claim(peer, experiment.id, 'Worker expiry must not release owner')).toThrow('live')
  expect((await w.engine.experiments.cancel(w.c, experiment.id)).state).toBe('cancelled')
  expect(() => second.experiments.claim(peer, experiment.id, 'Terminal state does not replace live context')).toThrow('live')
  expect(() => w.engine.experiments.requireController(w.c, experiment.id)).not.toThrow()
  w.engine.revokeContext(w.c)
  expect(second.experiments.claim(peer, experiment.id, 'Explicit claim after controller expiry').controllerActive).toBe(true)
})

it('failed experiment create and claim transactions release new ownership and preserve prior live authority', async () => {
  const w = await world()
  const db = new DatabaseSync(join(w.engine.directory, 'execution.sqlite'))
  const second = await w.engine.commandController()
  engines.push(second)
  const peer = second.issueContext('p', w.c.actorId, ['device'])
  try {
    const cursor = w.engine.eventCursor(w.c)
    db.exec("CREATE TRIGGER fail_create BEFORE INSERT ON events WHEN NEW.type='experiment-created' BEGIN SELECT RAISE(ABORT,'create audit failure'); END")
    expect(() => w.engine.experiments.create(w.c, 'authority', experimentSpec)).toThrow('create audit failure')
    expect(w.engine.experiments.list(w.c)).toHaveLength(0)
    expect(w.engine.eventCursor(w.c)).toBe(cursor)
    const directory = join(w.engine.directory, 'experiment-locks')
    const files = readdirSync(directory).filter((name) => name.endsWith('.sqlite'))
    expect(files).toHaveLength(1)
    for (const file of files) {
      const ownership = Ownership.acquire(join(directory, file))
      try { expect(ownership).not.toBeNull() }
      finally { ownership?.close() }
    }
    db.exec('DROP TRIGGER fail_create')
    const experiment = w.engine.experiments.create(w.c, 'authority', experimentSpec)
    expect(second.experiments.create(peer, 'authority', experimentSpec)).toMatchObject({ id: experiment.id, controllerActive: false })
    db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON events WHEN NEW.type='experiment-claimed' BEGIN SELECT RAISE(ABORT,'claim audit failure'); END")
    expect(() => w.engine.experiments.claim(w.c, experiment.id, 'Repeated live claim')).toThrow('claim audit failure')
    expect(w.engine.experiments.get(w.c, experiment.id).controllerActive).toBe(true)
    expect(() => second.experiments.claim(peer, experiment.id, 'Cannot steal after failed same-owner claim')).toThrow('live')
    w.engine.revokeContext(w.c)
    expect(() => second.experiments.claim(peer, experiment.id, 'Failed fresh claim must release ownership')).toThrow('claim audit failure')
    expect(second.experiments.get(peer, experiment.id).controllerActive).toBe(false)
    db.exec('DROP TRIGGER fail_claim')
    const third = await second.commandController()
    engines.push(third)
    const contender = third.issueContext('p', w.c.actorId, ['device'])
    expect(third.experiments.claim(contender, experiment.id, 'Explicit claim after failed transaction').controllerActive).toBe(true)
  } finally { db.close() }
})

it('releases experiment authority on close without restoring it from actor IDs or late provider results', async () => {
  const w = await world()
  const experiment = w.engine.experiments.create(w.c, 'authority', experimentSpec)
  const actual = Promise.withResolvers<ProviderObservation>()
  w.provider.submit = () => actual.promise
  try {
    expect((await w.engine.experiments.submit(w.c, experiment.id, experimentAction('held'))).state).toBe('unknown')
    const closing = w.engine.close()
    let closed = false
    void closing.then(() => { closed = true })
    const second = new ExecutionEngine(w.options)
    engines.push(second)
    await second.open({ recover: false })
    const peer = second.issueContext('p', w.c.actorId, ['device'])
    expect(second.experiments.get(peer, experiment.id).controllerActive).toBe(false)
    expect(second.experiments.create(peer, 'authority', experimentSpec).controllerActive).toBe(false)
    expect(() => second.experiments.requireController(peer, experiment.id)).toThrow('claim')
    expect(second.experiments.claim(peer, experiment.id, 'Explicit replacement during disposal').controllerActive).toBe(true)
    expect(closed).toBe(false)
    actual.resolve({ state: 'succeeded' })
    await closing
    expect(second.experiments.get(peer, experiment.id).controllerActive).toBe(true)
    const third = await second.commandController()
    engines.push(third)
    const contender = third.issueContext('p', w.c.actorId, ['device'])
    expect(() => third.experiments.claim(contender, experiment.id, 'Old close must not release new owner')).toThrow('live')
    await second.close()
    expect(third.experiments.claim(contender, experiment.id, 'Explicit replacement after orderly close').controllerActive).toBe(true)
  } finally { actual.resolve({ state: 'running' }) }
})

it('allows only one process to claim experiment authority and releases it on crash and one-shot exit', async () => {
  const w = await world()
  const experiment = w.engine.experiments.create(w.c, 'authority', experimentSpec)
  w.engine.revokeContext(w.c)
  const runs = [0, 1].map(() => runSource(source(w, `
    process.send({ready:true});await new Promise(done=>process.once('message',done));
    try {e.experiments.claim(c,${JSON.stringify(experiment.id)},'Concurrent process claim');process.send({claimed:true});await new Promise(done=>process.once('message',done))}
    catch(error){process.send({failure:String(error)})}await e.close();`)))
  await Promise.all(runs.map((run) => message(run, 'ready')))
  for (const run of runs) run.child.send('go')
  await expect.poll(() => runs.flatMap((run) => run.messages.filter((value) => 'claimed' in value || 'failure' in value)).length).toBe(2)
  const owner = runs.find((run) => run.messages.some((value) => value.claimed))!
  const loser = runs.find((run) => run !== owner)!
  expect(owner).toBeTruthy()
  expect(loser.messages.find((value) => value.failure)!.failure).toContain('live')
  expect(await loser.exited, loser.stderr).toBe(0)
  const reader = w.engine.issueContext('p', 'child', ['device'])
  expect(() => w.engine.experiments.claim(reader, experiment.id, 'Cannot replace a live process')).toThrow('live')
  await owner.stop()
  expect(w.engine.experiments.get(reader, experiment.id).controllerActive).toBe(false)
  expect(() => w.engine.experiments.requireController(reader, experiment.id)).toThrow('context')
  expect(w.engine.experiments.claim(reader, experiment.id, 'Explicit crash takeover').controllerActive).toBe(true)
  w.engine.revokeContext(reader)
  for (let index = 0; index < 2; index++) {
    const once = runSource(source(w, `
      if(e.experiments.get(c,${JSON.stringify(experiment.id)}).controllerActive)throw new Error('Persisted actor restored authority');
      e.experiments.claim(c,${JSON.stringify(experiment.id)},'Explicit one-shot claim');process.send({claimed:true});await e.close();`))
    expect(await once.exited, once.stderr).toBe(0)
    expect(once.messages.some((value) => value.claimed)).toBe(true)
  }
})

it('keeps lifecycle lock tuning optional and validates it before opening provider resources', async () => {
  const w = await world()
  const path = join(w.root, 'config.json')
  for (const controllerLockTimeoutMs of [undefined, 1, 300000]) {
    writeFileSync(path, JSON.stringify({ ...w.config, controllerLockTimeoutMs }))
    expect(readPlatformConfig(path).controllerLockTimeoutMs).toBe(controllerLockTimeoutMs)
  }
  for (const controllerLockTimeoutMs of [0, -1, 1.5, 300001, '5']) {
    writeFileSync(path, JSON.stringify({ ...w.config, controllerLockTimeoutMs }))
    expect(() => readPlatformConfig(path)).toThrow()
  }
})

it('observers coexist with held controller ownership and never recover, migrate, query or mutate', async () => {
  const w = await world()
  const op = await w.engine.submit(w.c, { providerId: 'device', requestKey: 'one', input: {} })
  const cursor = w.engine.eventCursor(w.c)
  const ownership = Ownership.acquire(join(w.engine.directory, 'controller.sqlite'))!
  const observer = new ExecutionEngine(w.options)
  engines.push(observer)
  try {
    await observer.openObserver()
    const c = observer.issueContext('p', 'reader', ['device'])
    expect(observer.snapshot(() => observer.get(c, op.id))).toMatchObject({ state: 'running' })
    expect(observer.eventCursor(c)).toBe(cursor)
    expect(journal(w.root)[0]!.queries).toBe(0)
    expect(() => observer.createProject('forbidden', 1)).toThrow('read-only')
    expect(() => observer.recordFact(c, 'forbidden', {})).toThrow('read-only')
    expect(() => observer.query(c, op.id)).toThrow('read-only')
    expect(() => observer.cancel(c, op.id)).toThrow('read-only')
    const app = await startDashboard(observer, w.config, { port: 0, refreshMs: 100, signal: new AbortController().signal })
    try {
      const response = await fetch(app.url + '/api/state', { headers: { Authorization: `Bearer ${app.token}` } })
      expect(response.status).toBe(200)
      expect((await response.json()).operations[0].state).toBe('running')
      expect(journal(w.root)[0]!.queries).toBe(0)
      expect(observer.eventCursor(c)).toBe(cursor)
    } finally { await app.close() }
  } finally { ownership.close() }
  await observer.close()
  await w.engine.close()
  const db = new DatabaseSync(join(w.engine.directory, 'execution.sqlite'))
  db.exec('PRAGMA user_version=2')
  db.close()
  const old = new ExecutionEngine(w.options)
  await expect(old.openObserver()).rejects.toThrow('controller initialization')
  const check = new DatabaseSync(join(w.engine.directory, 'execution.sqlite'))
  expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(2)
  check.close()
  const absent = join(w.root, 'absent')
  await expect(new ExecutionEngine({ ...w.options, directory: absent }).openObserver()).rejects.toThrow()
  expect(existsSync(absent)).toBe(false)
})

it.each([false, true])('drivers observe query-driven and independently completed providers (self-driven=%s)', async (selfDriven) => {
  const w = await world()
  const driver = new ExecutionEngine(w.options)
  engines.push(driver)
  await driver.openDriver()
  const controller = await w.engine.commandController()
  engines.push(controller)
  const c = controller.issueContext('p', 'writer', ['device'])
  const op = await controller.submit(c, { providerId: 'device', requestKey: 'one', input: { selfDriven } })
  const observer = await w.engine.observer()
  engines.push(observer)
  const reader = observer.issueContext('p', 'reader', ['device'])
  if (selfDriven) {
    await expect.poll(() => Number(journal(w.root)[0]!.queries)).toBeGreaterThan(0)
    const db = new DatabaseSync(join(w.root, 'device', 'device.sqlite'))
    db.prepare('UPDATE starts SET done=1 WHERE id=?').run(op.id)
    db.close()
  }
  expect((await observer.wait(reader, op.id, { timeoutMs: 3000 })).state).toBe('succeeded')
  expect(journal(w.root)[0]!.submits).toBe(1)
})

it.each(['duplicate', 'resource', 'budget'] as const)('serializes concurrent process %s admission inside the registration transaction', async (kind) => {
  const w = await world()
  const project = kind === 'resource' ? 'resource' : 'limited'
  w.engine.createProject(project, kind === 'resource' ? 10 : 1)
  const runs = [0, 1].map((index) => runSource(source(w, `
    const scoped=e.issueContext(${JSON.stringify(project)},'child',['device']);
    const prepare=provider.prepare;provider.prepare=input=>{const result=prepare(input);process.send({prepared:true});return result};
    process.send({ready:true});await new Promise(done=>process.once('message',done));
    try {const op=await e.submit(scoped,{providerId:'device',requestKey:${JSON.stringify(kind === 'duplicate' ? 'same' : String(index))},input:{resource:${JSON.stringify(kind === 'budget' ? `resource-${index}` : 'shared')}}});process.send({result:op})}
    catch(error){process.send({failure:String(error)})}await e.close();`)))
  await Promise.all(runs.map((run) => message(run, 'ready')))
  const ownership = Ownership.acquire(join(w.engine.directory, 'controller.sqlite'))!
  try {
    for (const run of runs) run.child.send('go')
    await Promise.all(runs.map((run) => message(run, 'prepared')))
  } finally { ownership.close() }
  await Promise.all(runs.map((run) => run.exited))
  const results = runs.flatMap((run) => run.messages.filter((value) => 'result' in value))
  const failures = runs.flatMap((run) => run.messages.filter((value) => 'failure' in value))
  expect(runs.map((run) => run.stderr).join('\n')).not.toContain('TypeError')
  if (kind === 'duplicate') {
    expect(results).toHaveLength(2)
    const operations = results.map(({ result }) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Missing operation')
      return result
    })
    expect(operations[0]!.id).toBe(operations[1]!.id)
    expect(failures).toHaveLength(0)
  } else {
    expect(results).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.failure).toContain(kind === 'resource' ? 'Resource busy' : 'budget exceeded')
  }
  const c = w.engine.issueContext(project, 'reader', ['device'])
  expect(w.engine.list(c)).toHaveLength(1)
  expect(w.engine.projects().find((p) => p.id === project)!.budgetUsed).toBe(1)
  expect(journal(w.root).map((row) => row.submits)).toEqual([1])
})

it('serializes experiment creation checks and direct fact writes across controller processes', async () => {
  const w = await world()
  const spec = { goal: 'One request', method: { id: 'test', version: '1' }, context: {},
    inputArtifactIds: [], outputRequirements: 'Observed result', budget: 2, maxOperations: 2,
    actions: [{ id: 'work', providerId: 'device', input: {}, maxUses: 2 }] }
  const runs = [0, 1].map((index) => runSource(source(w, `
    process.send({ready:true});await new Promise(done=>process.once('message',done));
    process.send({attempt:true});
    const experiment=e.experiments.create(c,'same',${JSON.stringify(spec)});
    e.recordFact(c,'child-fact',{index:${index}});process.send({result:experiment.id});await e.close();`)))
  await Promise.all(runs.map((run) => message(run, 'ready')))
  const cursor = w.engine.eventCursor(w.c)
  const ownership = Ownership.acquire(join(w.engine.directory, 'controller.sqlite'))!
  try {
    for (const run of runs) run.child.send('go')
    await Promise.all(runs.map((run) => message(run, 'attempt')))
    expect(w.engine.eventCursor(w.c)).toBe(cursor)
  } finally { ownership.close() }
  expect(await Promise.all(runs.map((run) => run.exited))).toEqual([0, 0])
  const ids = runs.map((run) => run.messages.find((value) => 'result' in value)!.result)
  expect(ids[0]).toBe(ids[1])
  expect(w.engine.experiments.list(w.c)).toHaveLength(1)
  expect(w.engine.readFacts(w.c).filter((fact) => fact.kind === 'child-fact')).toHaveLength(2)
})

it('retains timed-out submit ownership across processes, persists busy cancellation, and lets other operations complete', async () => {
  const w = await world()
  const driver = new ExecutionEngine(w.options)
  engines.push(driver)
  await driver.openDriver()
  const run = runSource(source(w, `
    const op=await e.submit(c,{providerId:'device',requestKey:'held',input:{hold:true,resource:'busy'}});
    process.send({timedOut:op});await e.close();process.send({closed:true});`))
  const inflight = await message(run, 'inflight')
  const id = String(inflight.inflight)
  expect((await w.engine.cancel(w.c, id)).cancelRequested).toBe(true)
  const uncertain = await message(run, 'timedOut')
  expect(uncertain.timedOut).toMatchObject({ state: 'unknown' })
  expect(w.engine.get(w.c, id)).toMatchObject({ state: 'unknown', cancelRequested: true })
  expect(() => w.engine.submit(w.c, { providerId: 'device', requestKey: 'conflict', input: { resource: 'busy' } })).toThrow('Resource busy')
  const other = await w.engine.submit(w.c, { providerId: 'device', requestKey: 'other', input: { resource: 'other' } })
  expect((await w.engine.wait(w.c, other.id, { timeoutMs: 3000 })).state).toBe('succeeded')
  expect(journal(w.root).find((row) => row.id === id)).toMatchObject({ queries: 0, submits: 1, cancelled: 0 })
  expect(run.messages.some((value) => value.closed)).toBe(false)
  run.child.send('release')
  await run.exited
  await expect.poll(() => w.engine.get(w.c, id).state, { timeout: 3000 }).toBe('cancelled')
  expect(journal(w.root).find((row) => row.id === id)).toMatchObject({ submits: 1, cancelled: 1 })
  await driver.close()
  const restarted = await w.engine.commandController()
  engines.push(restarted)
  const c = restarted.issueContext('p', 'restart', ['device'])
  expect((await restarted.submit(c, { providerId: 'device', requestKey: 'held', input: { hold: true, resource: 'busy' } })).id).toBe(id)
  expect(journal(w.root).find((row) => row.id === id)!.submits).toBe(1)
})

it('a timed-out fallback query retains only its operation ownership and discards its late result', async () => {
  const w = await world()
  const busy = await w.engine.submit(w.c, { providerId: 'device', requestKey: 'busy', input: { resource: 'busy' } })
  const actual = Promise.withResolvers<ProviderObservation>()
  const query = w.provider.query.bind(w.provider)
  let heldCalls = 0
  w.provider.query = (op) => {
    if (op.operationId === busy.id) { heldCalls++; return actual.promise }
    return query(op)
  }
  try {
    expect((await w.engine.query(w.c, busy.id)).state).toBe('unknown')
    const closing = w.engine.close()
    expect(w.engine.close()).toBe(closing)
    let closed = false
    void closing.then(() => { closed = true })
    const controller = new ExecutionEngine(w.options)
    engines.push(controller)
    await controller.open()
    const c = controller.issueContext('p', 'other', ['device'])
    expect((await controller.query(c, busy.id)).state).toBe('unknown')
    const other = await controller.submit(c, { providerId: 'device', requestKey: 'other', input: { resource: 'other' } })
    expect((await controller.wait(c, other.id, { timeoutMs: 3000 })).state).toBe('succeeded')
    expect((await controller.cancel(c, busy.id)).cancelRequested).toBe(true)
    expect(heldCalls).toBe(1)
    expect(closed).toBe(false)
    expect(journal(w.root).find((row) => row.id === busy.id)).toMatchObject({ queries: 0, cancelled: 0 })
    const cursor = controller.eventCursor(c)
    actual.resolve({ state: 'succeeded' })
    await closing
    expect(controller.get(c, busy.id)).toMatchObject({ state: 'unknown', cancelRequested: true })
    expect(controller.eventCursor(c)).toBe(cursor)
    w.provider.query = query
    const driver = new ExecutionEngine(w.options)
    engines.push(driver)
    await driver.openDriver()
    expect((await controller.wait(c, busy.id, { timeoutMs: 3000 })).state).toBe('cancelled')
  } finally { actual.resolve({ state: 'running' }) }
})

it('close during recovery waits for actual provider settlement and shares its completion promise', async () => {
  const w = await world()
  const op = await w.engine.submit(w.c, { providerId: 'device', requestKey: 'busy', input: {} })
  const started = Promise.withResolvers<void>()
  const actual = Promise.withResolvers<ProviderObservation>()
  w.provider.query = async () => { started.resolve(); return actual.promise }
  const recovering = new ExecutionEngine(w.options)
  engines.push(recovering)
  try {
    const opening = recovering.open()
    await started.promise
    const closing = recovering.close()
    expect(recovering.close()).toBe(closing)
    let closed = false
    void closing.then(() => { closed = true })
    await opening
    expect(closed).toBe(false)
    actual.resolve({ state: 'succeeded' })
    await closing
    expect(w.engine.get(w.c, op.id).state).toBe('unknown')
  } finally { actual.resolve({ state: 'running' }) }
})

it('driver shutdown releases polling qualification while unresolved calls keep operation ownership', async () => {
  const w = await world()
  const busy = await w.engine.submit(w.c, { providerId: 'device', requestKey: 'busy', input: { resource: 'busy' } })
  const actual = Promise.withResolvers<ProviderObservation>()
  const query = w.provider.query.bind(w.provider)
  let hold = true, heldCalls = 0
  w.provider.query = (op) => {
    if (op.operationId === busy.id && hold) { heldCalls++; return actual.promise }
    return query(op)
  }
  try {
    const first = new ExecutionEngine(w.options)
    engines.push(first)
    await first.openDriver()
    let closed = false
    const closing = first.close().then(() => { closed = true })
    await first.driverClosed
    const replacement = new ExecutionEngine(w.options)
    engines.push(replacement)
    await replacement.openDriver()
    const other = await w.engine.submit(w.c, { providerId: 'device', requestKey: 'other', input: { resource: 'other' } })
    expect((await w.engine.wait(w.c, other.id, { timeoutMs: 3000 })).state).toBe('succeeded')
    expect(closed).toBe(false)
    expect(heldCalls).toBe(1)
    expect(journal(w.root).find((row) => row.id === busy.id)!.queries).toBe(0)
    hold = false
    actual.resolve({ state: 'running' })
    await closing
    await expect.poll(() => w.engine.get(w.c, busy.id).state, { timeout: 3000 }).toBe('succeeded')
  } finally { actual.resolve({ state: 'running' }) }
})

it('blocks changed fingerprints even when another driver makes controller recovery unavailable', async () => {
  const w = await world()
  const op = await w.engine.submit(w.c, { providerId: 'device', requestKey: 'one', input: { selfDriven: true } })
  const driver = new ExecutionEngine(w.options)
  engines.push(driver)
  await driver.openDriver()
  const changed: ExecutionProvider = { ...w.provider, describe: () => ({ ...w.provider.describe(), version: '2' }) }
  const controller = new ExecutionEngine({ ...w.options, providers: [changed] })
  engines.push(controller)
  await controller.open()
  const c = controller.issueContext('p', 'changed', ['device'])
  expect(controller.get(c, op.id).state).toBe('running')
  expect(() => controller.submit(c, { providerId: 'device', requestKey: 'two', input: {} })).toThrow('configuration differs')
  expect(journal(w.root).map((row) => row.submits)).toEqual([1])
})

it('real dsh drive coexists with serve and commands, survives UI shutdown, and releases ownership on crash', async () => {
  const w = await world()
  const home = join(w.root, 'home'), profile = join(home, 'profiles', 'ai4science')
  mkdirSync(profile, { recursive: true })
  const configPath = join(w.root, 'config.json')
  writeFileSync(configPath, JSON.stringify(w.config))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'lifecycle-test-profile', private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'startup' } } }))
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'ai4science-management', name: fileURLToPath(new URL('./cli.ts', import.meta.url)), config: { configPath } }] }]))
  const cli = (...args: string[]) => launch(['--import', 'tsx/esm', fileURLToPath(new URL('../../../apps/cli/src/bin.ts', import.meta.url)), '--profile', 'ai4science', ...args], { DSH_HOME: home })
  const ready = async (run: ReturnType<typeof launch>, marker: string) => {
    await expect.poll(() => run.stdout, { timeout: 15000, message: run.stderr }).toContain(marker)
  }
  const driver = cli('drive')
  await ready(driver, '"mode":"driver"')
  const duplicate = cli('drive')
  expect(await duplicate.exited, duplicate.stderr).toBe(1)
  expect(duplicate.stderr).toContain('Another driver')
  const serve = cli('serve', '--port', '0', '--refresh-ms', '100')
  await ready(serve, '"mode":"local-dashboard"')
  const input = join(w.root, 'input.json')
  writeFileSync(input, JSON.stringify({ selfDriven: true }))
  const start = cli('start', '--project', 'p', '--provider', 'device', '--key', 'cli', '--input', input)
  expect(await start.exited, start.stderr).toBe(0)
  const op = JSON.parse(start.stdout.split('\n').find((line) => line.startsWith('{"id"') || line.startsWith('{"runId"'))!) as OperationRecord
  await serve.stop()
  const db = new DatabaseSync(join(w.root, 'device', 'device.sqlite'))
  db.prepare('UPDATE starts SET done=1 WHERE id=?').run(op.id)
  db.close()
  const wait = cli('wait', '--project', 'p', '--operation', op.id, '--timeout-ms', '5000')
  expect(await wait.exited, wait.stderr).toBe(0)
  expect(wait.stdout).toContain('"state":"succeeded"')
  expect(journal(w.root)[0]).toMatchObject({ submits: 1, last_pid: driver.child.pid })
  await driver.stop()
  const replacement = cli('drive')
  await ready(replacement, '"mode":"driver"')
  await replacement.stop()
}, 60000)
