/** Protocol tests use a real execution journal and deterministic case metadata, without a model API. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { contentHash, type StageProfile } from './contracts.ts'
import { publicMission } from './registry.ts'
import { openProtocol } from './protocol.ts'
import { V06Records, type ResearchJournal } from './records.ts'
import { V06Stages } from './stages.ts'
import { charter, FIXED_ROLES, roleTools, ROLE_DUTIES } from './team.ts'
import { orderRoundIntents } from '../v05/rounds.ts'

let root: string, engine: ExecutionEngine, context: OperationContext, now: number
const profile: StageProfile = { baselineTick: 3, finalTick: 8, horizon: 12 }
const fixtureCases = [{ input: { x: 2 }, target: 4 }, { input: { x: 3 }, target: 6 }]
const resolvers = { validation: () => ({ caseSetHash: contentHash(fixtureCases), availableAt: 12 }),
  evidence: (id: string) => id === 'measured-sample' ? { availableAt: 1 } : null }
let protocol: ReturnType<typeof openProtocol>
beforeEach(async () => {
  now = 0; root = mkdtempSync(join(tmpdir(), 'mars-v06-protocol-'))
  engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  await engine.open(); engine.createProject('mars', null)
  context = engine.issueContext('mars', 'protocol-fixture', [])
  protocol = openProtocol(engine, context, () => now, profile, 1, resolvers)
})
afterEach(async () => { await engine.close(); rmSync(root, { recursive: true, force: true }) })
const model = (id: string, code = 'return { value: input.x * 2 }') => protocol.records.registerModel(`register-${id}`, {
  id, code, parameters: {}, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, runtimeVersion: 'mars-analysis-v1',
})
const prediction = (id: string, modelId: string, slotId: 'baseline' | 'final' = 'final') => protocol.records.commitPrediction(`commit-${id}`, {
  id, taskId: 'T1', slotId, modelId, inputDomain: {},
})
const submit = (modelId: string, predictionId: string, expectedRevision = 0, slotId: 'baseline' | 'final' = 'final') => ({
  taskId: 'T1', slotId, payload: { modelId, predictionId }, evidence: [], expectedRevision,
})
const boundary = () => ({ worldHash: contentHash({ tick: now }), worldCursor: now, ledgerCursor: engine.eventCursor(context) })

it('publishes three commissions, six dimensions and equal model-visible role capabilities', () => {
  const mission = publicMission(profile, 1)
  expect(mission.commissions.map(c => c.id)).toEqual(['J-A', 'J-B', 'J-C'])
  expect(mission.tasks).toHaveLength(6)
  expect(mission.tasks.find(t => t.id === 'T3')!.components).toEqual({ energy_forecast: 0.3, commitment_forecast: 0.2, service_attainment: 0.5 })
  expect(FIXED_ROLES).toHaveLength(6)
  for (const duty of Object.values(ROLE_DUTIES)) expect(charter('single', profile, 1)).toContain(duty)
  expect(roleTools()).toEqual(expect.arrayContaining(['water_assay', 'greenhouse_scan', 'device_clean', 'experiment_plan']))
  for (const extra of ['org_create', 'subagent', 'fork', 'workflow']) expect(roleTools()).not.toContain(extra)
})
it('rotates physical intent priority by frozen role rather than random native session identifiers', () => {
  const order = (brain: string, water: string, round: number) => orderRoundIntents(round, [water, brain], [
    { actorId: water, sequence: 0, requestKey: 'low', input: 'low' }, { actorId: brain, sequence: 0, requestKey: 'high', input: 'high' },
  ], id => id === brain ? '00-director' : '01-wet-lab').map(i => i.input)
  expect(order('z-root', 'a-water', 0)).toEqual(['high', 'low'])
  expect(order('a-root', 'z-water', 0)).toEqual(['high', 'low'])
  expect(order('a-root', 'z-water', 1)).toEqual(['low', 'high'])
})
it('timestamps actual acceptance and preserves idempotency and CAS across actors', () => {
  model('m1'); prediction('p1', 'm1'); now = 1
  const accepted = protocol.records.submit('submit', submit('m1', 'p1'))
  expect(accepted).toMatchObject({ revision: 1, acceptedTick: 1, acceptedSeq: 3 })
  expect(protocol.records.submit('submit', submit('m1', 'p1'))).toEqual(accepted)
  const other = new V06Records(engine, engine.issueContext('mars', 'other-actor', []), () => now, profile, resolvers)
  expect(() => other.submit('racing-write', submit('m1', 'p1'))).toThrow('revision changed')
  expect(() => protocol.records.submit('submit', submit('m1', 'p1', 1))).toThrow('different input')
  expect(protocol.records.submissions()).toHaveLength(1)
  expect(engine.readFacts(context).some(f => f.kind.startsWith('mars-v05-'))).toBe(false)
})
it('keeps the newest format-valid model even if its code will fail, and rejects bad format without replacement', () => {
  model('good'); prediction('good-p', 'good')
  protocol.records.submit('first', submit('good', 'good-p'))
  model('bad-code', 'throw new Error("science failure")'); prediction('bad-p', 'bad-code')
  protocol.records.submit('latest', submit('bad-code', 'bad-p', 1))
  expect(() => protocol.records.submit('malformed', { ...submit('good', 'good-p', 2), payload: { modelId: 'good', predictionId: 'good-p', hiddenTruth: 42 } })).toThrow()
  now = 3; protocol.stages.synchronize(boundary())
  now = 8; protocol.stages.synchronize(boundary())
  const selected = protocol.stages.selected('T1', 'final')!
  expect(selected.revision).toBe(2)
  expect(selected.references.find(r => r.kind === 'model')!.id).toBe('bad-code')
})
it('locks the strict boundary, keeps baseline missing diagnostic-only and never backfills a prediction', () => {
  model('m'); prediction('p', 'm')
  now = 3; const baseline = protocol.stages.synchronize(boundary())!
  expect(baseline.missing).toHaveLength(4)
  expect(baseline.missing.every(m => m.reason === 'baseline_missing')).toBe(true)
  expect(() => prediction('late-baseline', 'm', 'baseline')).toThrow('slot closed')
  now = 7; protocol.records.submit('final', submit('m', 'p'))
  now = 8; const final = protocol.stages.synchronize(boundary())!
  expect(final.selections.map(s => s.taskId)).toEqual(['T1'])
  expect(final.missing).toHaveLength(5)
  expect(protocol.stages.modelAdmissionClosed()).toBe(true)
  expect(() => protocol.records.submit('too-late', submit('m', 'p', 1))).toThrow('slot closed')
  expect(protocol.records.submit('final', submit('m', 'p')).revision).toBe(1)
  expect(protocol.stages.synchronize(boundary())).toBeNull()
})
it('refuses invented evidence, cross-slot predictions, missing case policies and nonfinite JSON', () => {
  model('m'); prediction('p', 'm', 'baseline')
  expect(() => protocol.records.submit('wrong-slot', submit('m', 'p'))).toThrow('reference differs')
  expect(() => protocol.records.submit('future-evidence', { ...submit('m', 'p', 0, 'baseline'), evidence: [{ id: 'measured-sample', purpose: 'calibration' }] })).toThrow('Evidence unavailable')
  const noCases = new V06Records(engine, context, () => now, profile)
  expect(() => noCases.commitPrediction('no-case', { id: 'no-case', taskId: 'T1', slotId: 'final', modelId: 'm', inputDomain: {} })).toThrow('not installed')
  expect(() => model('nan', 'return NaN')).not.toThrow()
  expect(() => protocol.records.registerModel('bad-parameters', { id: 'bad', code: 'return 0', parameters: { n: NaN }, inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-analysis-v1' })).toThrow()
})
it('validates hash-linked seals on reopen and rejects rewound worlds, changed profiles or skipped boundaries', () => {
  now = 3; protocol.stages.synchronize(boundary())
  expect(openProtocol(engine, context, () => now, profile, 1).stages.seals()).toHaveLength(1)
  expect(() => openProtocol(engine, context, () => 0, profile, 1)).toThrow('precedes')
  expect(() => openProtocol(engine, context, () => now, { ...profile, finalTick: 9 }, 1)).toThrow('profile differs')
  const tampered: ResearchJournal = { recordFact: (...args) => engine.recordFact(...args), readFacts: grant => engine.readFacts(grant).map(f =>
    f.kind === 'mars-v06-seal' ? { ...f, data: { ...zRecord(f.data), worldHash: '0'.repeat(64) } } : f) }
  expect(() => new V06Stages(tampered, context, profile, protocol.config.protocolHash, () => now, protocol.records)).toThrow('hash')
  now = 9; expect(() => protocol.stages.synchronize(boundary())).toThrow('skipped')
})
function zRecord(value: import('../../../../../science-harness/integrations/ai4science/platform/sdk.ts').Json) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object')
  return value
}
