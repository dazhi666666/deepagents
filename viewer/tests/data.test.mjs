import test from 'node:test'
import assert from 'node:assert/strict'
import { demoBundle } from '../fixtures/demo.mjs'
import { frameAt, routePosition, pairCompatibility, validateBundle, publicSnapshot, publicEvent } from '../src/data.js'

const find = (run, tick, id) => frameAt(run, tick).devices.find(d => d.id === id)
test('replay separates recorded loading, processing, completion and terminal maintenance flags', () => {
  const run = demoBundle().runs[0]
  assert.equal(find(run, 93, 'centrifuge-1').phase, 'loading')
  assert.equal(find(run, 100, 'centrifuge-1').phase, 'processing')
  assert.equal(find(run, 110, 'centrifuge-1').phase, 'completed')
  assert.equal(find(run, 111, 'centrifuge-1').phase, 'idle')
  assert.equal(find(run, 100, 'centrifuge-1').healthKnown, false)
  assert.deepEqual(find(run, 100, 'centrifuge-1').flags, [])
  assert.deepEqual(find(run, 240, 'centrifuge-1').flags, ['下次使用前需清洗'])
  assert.equal(find(run, 180, 'confirm').phase, 'maintenance')
})
test('accepted route interpolation uses recorded endpoints and stops at a failure position', () => {
  const run = demoBundle().runs[0], route = run.routes[0]
  const before = routePosition(route, 14, run.layout), middle = routePosition(route, 16.5, run.layout)
  const to = run.layout.nodes.find(n => n.id === 'door:robot-bay')
  assert.equal(middle.x, (before.x + to.x) / 2)
  assert.equal(middle.y, (before.y + to.y) / 2)
  const settled = run.events.find(e => e.kind === 'robot-operation-settled' && e.payload.operationId === route.operationId)
  settled.tick = 26; settled.payload.state = 'failed'; settled.payload.position = { x: 21, y: 40 }
  const op = run.operations.find(o => o.id === route.operationId); op.completedTick = 26; op.state = 'failed'
  op.phases = op.phases.filter(p => p.tick < 26).concat({ tick: 26, seq: 999, phase: 'failed' })
  assert.equal(find(run, 30, 'robot-1').x, 21)
  assert.equal(find(run, 30, 'robot-1').y, 40)
  assert.notEqual(find(run, 30, 'robot-1').x, run.snapshot.robots[0].x)
})
test('missing history does not silently inherit terminal device health or robot location', () => {
  const run = demoBundle().runs[0]; run.coverage.operationHistory = false; run.events = []; run.routes = []; run.operations = []
  assert.equal(find(run, 20, 'confirm').phase, 'unknown')
  assert.equal(find(run, 20, 'robot-1').positionKnown, false)
  assert.equal(find(run, 240, 'robot-1').positionKnown, true)
})
test('public projection excludes hidden truth, future faults, contact history and sample contamination', () => {
  const secret = 'DO-NOT-EXPORT'
  const projection = publicSnapshot({ devices: [{ id: 'confirm', dirty: true, futureFault: secret }], samples: [{ id: 's', volumeUl: 10, doc: secret }], facilities: {} },
    { robots: [], crops: [{ id: 'c', status: 'healthy', infectedSince: secret, contamination: [secret] }], sampleConditions: secret },
    { water: { reserve: 5, resolved: secret }, samples: { s: { doc: secret } }, history: secret, wear: secret })
  assert(!JSON.stringify(projection).includes(secret))
  assert.equal(projection.devices[0].dirty, true)
  const event = publicEvent({ seq: 1, tick: 5, kind: 'device-fault', payload: { deviceId: 'confirm', observed: 'Stopped', truth: secret } })
  assert(!JSON.stringify(event).includes(secret))
})
test('observed faults stop motion until a recorded repair, without borrowing terminal flags', () => {
  const run = demoBundle().runs[0]
  run.events.push({ seq: 999, tick: 60, kind: 'device-fault', payload: { deviceId: 'confirm' } }, { seq: 1000, tick: 70, kind: 'operation-finished', payload: { state: 'succeeded', command: { action: 'repair', deviceId: 'confirm' } } })
  run.events.sort((a, b) => a.tick - b.tick || a.seq - b.seq)
  assert.equal(find(run, 65, 'confirm').alert, 'fault')
  assert.equal(find(run, 65, 'confirm').motion, false)
  assert.equal(find(run, 75, 'confirm').alert, null)
  assert.equal(frameAt(run, 65).crops[0].status, 'unknown')
  assert.equal(frameAt(run, run.tick).crops[0].status, run.snapshot.crops[0].status)
})
test('pairing requires complete frozen identity, unlike matching mode labels alone', () => {
  const [multi, single] = demoBundle().runs
  assert.equal(pairCompatibility(multi, single).compatible, true)
  single.manifest.caseManifestHash = 'changed'
  assert.equal(pairCompatibility(multi, single).compatible, false)
  delete single.manifest.truthHash
  assert(pairCompatibility(multi, single).reasons.some(s => s.startsWith('truthHash')))
})
test('imports reject bad chronology, maps, non-finite values, duplicate IDs and unsealed experiments', () => {
  const cases = [
    b => { b.runs[0].operations[0].completedTick = -1 },
    b => { b.runs[0].layout.anchors[0].x = 0 },
    b => { b.runs[0].telemetry['energy.solar'][0][1] = Infinity },
    b => { b.runs[1].id = b.runs[0].id },
    b => { b.source = 'experiment'; b.runs[0].tick = 200 },
    b => { b.runs[0].facts[0] = null },
    b => { b.runs[0].raw[0].id = null },
    b => { b.runs[0].coverage.fromTick = 900 },
    b => { b.runs[0].facts.find(f => f.kind === 'mars-v06-record').data.result.evidence = 'bad' },
  ]
  for (const mutate of cases) { const bundle = demoBundle(); mutate(bundle); assert.throws(() => validateBundle(bundle), /数据包无效/) }
})
