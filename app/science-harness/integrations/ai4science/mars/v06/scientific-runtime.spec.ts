/** Full candidate paths use native scripted adapters and the real shared world, never a model API. */
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { boot, execute, Gate, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { toolCallResponse } from '../../../../../science-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { mountMars, type Config } from '../runtime.ts'
import { truthFor } from '../fixture.ts'
import { V05Planning } from '../v05/planning.ts'
import type { BudgetConfig } from './budget.ts'
import { reportStopped } from '../report.ts'
import { referencePort } from './feasibility.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
const prices: BudgetConfig = { limitUsd: 1, prices: [{ provider: 'teams-probe', model: 'fixture', inputPerMillion: 1,
  cacheReadPerMillion: 0.1, cacheWritePerMillion: 1, outputPerMillion: 1, maxInputTokens: 10000, maxOutputTokens: 1024,
  verified: true, singleAttempt: true }] }
async function setup(label: string) {
  const probe = await boot(label, true, async root => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  const directory = join(probe.root, 'mars')
  const config: Config = { benchmarkVersion: 'v0.6', implementation: 'scientific_candidate', directory,
    truthFile: truthFor(directory).path, stageProfile: { baselineTick: 8, finalTick: 16, horizon: 24 },
    scienceProfile: { condition: 'G0' }, mode: 'environment', seed: 1, port: 0, decisionTicks: 8,
    model: { provider: 'teams-probe', model: 'fixture', maxTokens: 1024 }, modelSource: 'scripted-integration',
    pollIntervalMs: 10, providerCallTimeoutMs: 1000 }
  return { probe, config, directory }
}
it('runs a sealed joint DAG in the original world and refuses unselected future plan steps', async () => {
  const { probe, config } = await setup('v06-science-environment')
  const runtime = await mountMars(probe.ctx, config)
  try {
    expect(runtime.snapshot().mission).toMatchObject({ version: 'v0.6', status: 'scientific_candidate' })
    expect(runtime.snapshot().seed).toBe(0)
    expect(runtime.snapshot().capabilities.scoring).toBe(true)
    const grant = runtime.engine.issueContext('mars', 'public-fixture', ['water', 'greenhouse', 'facilities'])
    const planning = new V05Planning(runtime.engine, grant, () => runtime.world.observe().tick, {}, undefined, 'v06')
    const selected = planning.schedule('selected', { title: 'Retained world state', steps: [{ id: 'route', providerId: 'facilities', at: 18,
      input: { action: 'water_route', target: 'reserve' } }] })
    planning.schedule('unselected', { title: 'Must remain unstarted', steps: [{ id: 'light', providerId: 'greenhouse', at: 18,
      input: { action: 'light', chamberId: 'incubator-1', level: 10 } }] })
    runtime.science!.recordsFor(grant).submit('joint', { taskId: 'T6', slotId: 'final', payload: { planId: selected.id }, evidence: [], expectedRevision: 0 })
    await runtime.advanceScientificTo(24)
    expect(runtime.world.observeBase().water.route).toBe('reserve')
    expect(runtime.world.observeSystems().light['incubator-1']).toBe(70)
    const score = await runtime.finalize() as { R: number; F: boolean; completionStatus: string; failureReasons: string[] }
    expect(score).toMatchObject({ R: 0, F: false, completionStatus: 'finalized' })
    expect(score.failureReasons).not.toContain('joint:sealed-plan')
    expect(runtime.science!.stages.seals().map(s => s.stage)).toEqual(['baseline', 'final', 'horizon'])
    expect(runtime.engine.readFacts(grant).some(f => f.kind.startsWith('mars-v05-'))).toBe(false)
    expect(probe.model.requests).toHaveLength(0)
    await runtime.close()
    expect(await reportStopped({ directory: config.directory, truthFile: config.truthFile })).toEqual(score)
  } finally { await runtime.close() }
}, 60000)
it('allows independent plans to interleave on one robot while retaining operation locks', async () => {
  const { probe, config } = await setup('v06-shared-robot-interleaving')
  const runtime = await mountMars(probe.ctx, { ...config, stageProfile: { baselineTick: 60, finalTick: 120, horizon: 160 } })
  try {
    const grant = runtime.engine.issueContext('mars', 'interleaving-fixture', ['water', 'greenhouse', 'facilities'])
    const plans = new V05Planning(runtime.engine, grant, () => runtime.world.observe().tick, {}, undefined, 'v06')
    const first = plans.schedule('first', { title: 'Two separated uses', steps: [
      { id: 'early', at: 1, providerId: 'water', input: { action: 'charge', robotId: 'robot-1' } },
      { id: 'late', at: 60, dependsOn: ['early'], providerId: 'water', input: { action: 'charge', robotId: 'robot-1' } }] })
    const second = plans.schedule('second', { title: 'Use the available gap', steps: [
      { id: 'between', at: 1, providerId: 'water', input: { action: 'charge', robotId: 'robot-1' } }] })
    await runtime.advanceScientificTo(55)
    const a = plans.list().find(p => p.id === first.id)!, b = plans.list().find(p => p.id === second.id)!
    expect(a.state).toBe('running'); expect(a.operations.late).toBeUndefined(); expect(b.state).toBe('succeeded')
    const physical = runtime.world.observeSystems().operations
    const early = physical.find(o => o.id === a.operations.early)!, between = physical.find(o => o.id === b.operations.between)!
    expect(between.acceptedTick).toBeGreaterThanOrEqual(early.completedTick!)
    expect(between.completedTick).toBeLessThan(60)
  } finally { await runtime.close() }
}, 60000)
it('retains real prepared control volume for a subsequent independent confirmation', async () => {
  const { probe, config } = await setup('v06-partial-control')
  const runtime = await mountMars(probe.ctx, { ...config, stageProfile: { baselineTick: 120, finalTick: 450, horizon: 600 } })
  try {
    const port = referencePort(runtime), sampleId = await port.aliquot('prepare-control', 'qc-high', 50)
    const first = await port.assay('first-control', { sampleId, method: 'confirm', confirmVolumeUl: 25 })
    const remaining = runtime.world.observe().samples.find(s => s.id === first.sampleId)!
    expect(remaining.volumeUl).toBe(25); expect(remaining.state).toBe('prepared')
    const second = await port.confirmPrepared('second-control', remaining.id, 25)
    expect(second.id).not.toBe(first.id)
    expect(runtime.world.observe().samples.find(s => s.id === remaining.id)!.volumeUl).toBe(0)
    expect(probe.model.requests).toHaveLength(0)
  } finally { await runtime.close() }
}, 60000)
it('executes a real two-control fast batch and stores its own measured outputs', async () => {
  const { probe, config } = await setup('v06-reference-batch')
  const runtime = await mountMars(probe.ctx, { ...config, stageProfile: { baselineTick: 60, finalTick: 200, horizon: 240 } })
  try {
    const measured = await referencePort(runtime).screenBatch('control-batch', ['qc-low', 'qc-high'])
    expect(measured).toHaveLength(2); expect(measured[1]!.value).toBeGreaterThan(measured[0]!.value)
    const state = runtime.world.observe()
    expect(state.results.filter(r => measured.some(m => m.id === r.id))).toHaveLength(2)
    expect(state.samples.filter(s => s.location === 'screen' && s.volumeUl > 0)).toHaveLength(0)
    expect(probe.model.requests).toHaveLength(0)
  } finally { await runtime.close() }
}, 60000)
it('starts a requested laboratory procedure after the driver first ran with an empty queue', async () => {
  const { probe, config } = await setup('v06-empty-procedure-driver')
  const runtime = await mountMars(probe.ctx, config)
  try {
    await runtime.procedures.step()
    const procedure = await runtime.procedures.start({ kind: 'water_assay', actorId: 'procedure-fixture', requestKey: 'after-empty',
      providers: ['water', 'facilities'], robot: 'robot-1', taskId: 'T1', method: 'screen', sourceId: 'reservoir' })
    await runtime.procedures.step()
    expect(runtime.procedures.view(procedure!.procedure)?.phase).toBe('sample')
    expect(runtime.world.observeSystems().operations.some(o => o.command.action === 'sample')).toBe(true)
  } finally { await runtime.close() }
}, 60000)
it('leaves a finite plan sample in its declared custody until the scheduled transfer', async () => {
  const { probe, config } = await setup('v06-scoped-housekeeping')
  const runtime = await mountMars(probe.ctx, config)
  try {
    const grant = runtime.engine.issueContext('mars', 'custody-fixture', ['water', 'greenhouse', 'facilities'])
    const planning = new V05Planning(runtime.engine, grant, () => runtime.world.observe().tick, {}, undefined, 'v06')
    const plan = planning.schedule('custody', { title: 'Retain declared custody', steps: [
      { id: 'sample', at: 1, providerId: 'water', input: { action: 'sample', sourceId: 'reservoir', volumeUl: 100, container: 'vial' } },
      { id: 'transfer', at: 18, providerId: 'water', dependsOn: ['sample'], input: { action: 'transfer', deviceId: 'robot-2', sampleId: '$step:sample:outputSampleId', destination: 'cold-2' } }] })
    runtime.science!.recordsFor(grant).submit('joint', { taskId: 'T6', slotId: 'final', expectedRevision: 0, payload: { planId: plan.id }, evidence: [] })
    await runtime.advanceScientificTo(14)
    const operationId = planning.list()[0]!.operations.sample!
    const sample = runtime.world.observe().samples.find(s => s.id === `sample:${operationId}`)!
    expect(sample.location).toBe('reservoir'); expect(sample.volumeUl).toBe(100)
    expect(runtime.world.observe().operations.filter(o => o.command.action === 'transfer')).toHaveLength(0)
    await runtime.advanceScientificTo(24)
    expect(planning.list()[0]!.operations.transfer).toBeDefined()
  } finally { await runtime.close() }
}, 60000)
for (const mode of ['single-agent', 'multi-agent'] as const) it(`keeps ${mode} fixed, charges requests once and stops every model before the validation interval`, async () => {
  const { probe, config, directory } = await setup('v06-native-science')
  const roles = mode === 'single-agent' ? ['brain'] : ['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst']
  for (const role of roles) probe.model.queue(role,
    toolCallResponse(`note-${role}`, 'note_write', { request_key: `note-${role}`, path: `notes/${role}.md`, revision: 0, text: role }),
    toolCallResponse(`observe-${role}`, 'mars_observe', {}),
    toolCallResponse(`after-lock-${role}`, 'mars_observe', {}))
  const runtime = await mountMars(probe.ctx, { ...config, mode, automaticCheckpoints: true, budget: prices })
  try {
    await vi.waitFor(() => expect(runtime.snapshot().status).toBe('completed'), { timeout: 30000 })
    expect(runtime.org.snapshotParticipants()).toHaveLength(roles.length)
    expect(probe.model.requests).toHaveLength(roles.length * 2)
    expect(runtime.records.listNotes()).toHaveLength(roles.length)
    const grant = runtime.engine.issueContext('mars', 'inspector', [])
    const requests = runtime.engine.readFacts(grant).filter(f => f.kind === 'mars-model-request').map(f => f.data as { tick: number })
    expect(requests.every(r => r.tick < 16)).toBe(true)
    expect(runtime.monetary!.report()).toMatchObject({ requests: roles.length * 2, uncertain: 0, reservedUsd: 0, costStatus: 'verified' })
    expect(runtime.monetary!.report().actualUsd).toBeCloseTo(15 * roles.length * 2 / 1000000)
    expect(JSON.parse(readFileSync(join(directory, 'final-score.json'), 'utf8'))).toMatchObject({ implementation: 'scientific_candidate',
      modelSource: 'scripted-integration', stopReason: 'normal', tick: 24, R: 0, F: false })
  } finally { await runtime.close() }
}, 60000)
it('exhausts money before dispatch and continues an already accepted plan to its physical result', async () => {
  const { probe, config, directory } = await setup('v06-budget-stop')
  probe.model.queue('brain', toolCallResponse('schedule', 'experiment_plan', { action: 'schedule', request_key: 'scheduled-before-budget', input_json: JSON.stringify({ title: 'Previously accepted',
    steps: [{ id: 'route', providerId: 'facilities', at: 12, input: { action: 'water_route', target: 'reserve' } }] }) }), toolCallResponse('unfunded', 'mars_observe', {}))
  const budget: BudgetConfig = { limitUsd: 0.00002, prices: [{ ...prices.prices[0]!, maxInputTokens: 10, maxOutputTokens: 8 }] }
  const runtime = await mountMars(probe.ctx, { ...config, mode: 'single-agent', model: { ...config.model, maxTokens: 8 }, automaticCheckpoints: true, budget })
  try {
    await vi.waitFor(() => expect(runtime.snapshot().status).toBe('completed'), { timeout: 30000 })
    expect(probe.model.requests).toHaveLength(1)
    expect(runtime.world.observe().tick).toBe(24)
    expect(runtime.world.observeBase().water.route).toBe('reserve')
    expect(runtime.monetary!.report().actualUsd).toBeCloseTo(0.000015)
    expect(JSON.parse(readFileSync(join(directory, 'final-score.json'), 'utf8'))).toMatchObject({ stopReason: 'budget_exhausted', completionStatus: 'finalized' })
  } finally { await runtime.close() }
}, 60000)
it('lets all six native members finish affordable requests while conservative reservations settle', async () => {
  const { probe, config } = await setup('v06-concurrent-monetary-admission')
  const roles = ['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst']
  for (const role of roles) probe.model.queue(role, toolCallResponse(`first-${role}`, 'mars_observe', {}), toolCallResponse(`second-${role}`, 'mars_observe', {}))
  const budget: BudgetConfig = { limitUsd: 0.0001, prices: [{ ...prices.prices[0]!, maxInputTokens: 10, maxOutputTokens: 8 }] }
  const runtime = await mountMars(probe.ctx, { ...config, mode: 'multi-agent', model: { ...config.model, maxTokens: 8 }, budget })
  try {
    await vi.waitFor(() => expect(runtime.snapshot().status).toBe('completed'), { timeout: 30000 })
    expect(probe.model.requests).toHaveLength(6)
    expect(runtime.monetary!.report()).toMatchObject({ requests: 6, reservedUsd: 0, uncertain: 0, costStatus: 'verified' })
    expect(runtime.monetary!.report().actualUsd).toBeCloseTo(0.00009)
    expect(runtime.world.observe().tick).toBe(24)
  } finally { await runtime.close() }
}, 60000)
it('does not credit an observation-only response plan for recovery performed outside that plan', async () => {
  const { probe, config } = await setup('v06-response-causality')
  const runtime = await mountMars(probe.ctx, { ...config, stageProfile: { baselineTick: 80, finalTick: 220, horizon: 260 }, scienceProfile: { condition: 'G2' } })
  try {
    await runtime.advanceScientificTo(116)
    const grant = runtime.engine.issueContext('mars', 'causality-fixture', ['water', 'greenhouse', 'facilities'])
    const plans = new V05Planning(runtime.engine, grant, () => runtime.world.observe().tick, {}, undefined, 'v06')
    const plan = plans.schedule('observation-only', { title: 'Observation does not repair', steps: [{ id: 'observe', at: 200, providerId: 'facilities', input: { action: 'device_reference', targetId: 'pump' } }] })
    const action = runtime.science!.actionsFor(grant).commit('response', { id: 'response', taskId: 'T4', planId: plan.id, sourceId: 'pump', forecast: { completedTick: 205, postResponseMgL: 1 } })
    runtime.science!.recordsFor(grant).submit('diagnosis', { taskId: 'T4', slotId: 'final', expectedRevision: 0, payload: { diagnosis: ['seal', 'inline-sensor'], responseIds: [action.id] }, evidence: [] })
    for (const input of [{ action: 'repair', deviceId: 'pump' }, { action: 'clean', deviceId: 'pump' }, { action: 'sensor_calibrate', targetId: 'filter', channel: 'doc_inline' }] as const) {
      const operation = await runtime.engine.submit(grant, { providerId: 'facilities', requestKey: `outside-${input.action}`, input })
      while (!['succeeded', 'failed'].includes(runtime.engine.get(grant, operation.id).state)) {
        await runtime.advanceScientificTo(runtime.world.observe().tick + 1)
        await runtime.engine.query(grant, operation.id)
      }
      expect(runtime.engine.get(grant, operation.id).state).toBe('succeeded')
    }
    await runtime.advanceScientificTo(260)
    const scored = await runtime.finalize() as { response: { valid: boolean; restored: boolean; independentlyValidated: boolean }; components: { response_effect: number } }
    expect(scored.response.valid).toBe(true)
    expect(scored.response.restored).toBe(true)
    expect(scored.response.independentlyValidated).toBe(false)
    expect(scored.components.response_effect).toBe(0)
  } finally { await runtime.close() }
}, 60000)
it('denies globally installed filesystem/extension capabilities to an exact native scientific participant', async () => {
  const { probe, config } = await setup('v06-tool-isolation')
  let unsafeCalls = 0
  probe.ctx.tools.register(defineTool({ name: 'unsafe_private_file', description: 'Fixture capability outside the scientific role', parameters: {},
    output: { schema: { type: 'json' }, render: () => [] }, execute: async () => { unsafeCalls++; return { secret: 'private fixture data' } } }))
  probe.model.queue('brain', new Gate().step())
  const runtime = await mountMars(probe.ctx, { ...config, mode: 'single-agent', budget: prices })
  try {
    const denied = await execute(probe, 'unsafe_private_file', {}, runtime.root!.agent)
    expect(denied.isError).toBe(true); expect(unsafeCalls).toBe(0)
    for (const name of ['subagent', 'fork', 'workflow', 'org_create']) expect((await execute(probe, name, {}, runtime.root!.agent)).isError).toBe(true)
  } finally { await runtime.close() }
}, 60000)
