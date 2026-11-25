/** Native Agents exercise actual planning tools and authenticated backend state. */
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { boot, execute, Gate, type Probe } from '../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { mountMars as mountRuntime, type Config } from './runtime.ts'
import { truthFor } from './fixture.ts'
import { evaluateStopped } from './report.ts'
import { textResponse, toolCallResponse } from '../../../../science-harness/packages/core/agent-loop/tests/mock-adapter.ts'
const probes: Probe[] = []
const mountMars = (ctx: Parameters<typeof mountRuntime>[0], config: Omit<Config, 'truthFile'>) => mountRuntime(ctx, { ...config, truthFile: truthFor(config.directory, config.seed).path })
const recoveryRoots: string[] = []
const recoveryDirectory = () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-recovery-fixture-'))
  recoveryRoots.push(root)
  return join(root, 'mars')
}
afterEach(async () => {
  try { for (const probe of probes.splice(0)) await probe.close() }
  finally { for (const root of recoveryRoots.splice(0)) rmSync(root, { recursive: true, force: true }) }
})

for (const mode of ['single-agent', 'multi-agent'] as const)
  it(`${mode} restores the pre-decision logical position across repeated transport failures`, async () => {
    const directory = recoveryDirectory()
    for (let cycle = 0; cycle < 2; cycle++) {
      const probe = await boot('mars-failed-decision', true, async () => {
        return { withoutScience: true, configs: { jsonl: { root: join(directory, 'sessions'), compression: 'none' },
          'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }
      })
      probes.push(probe)
      // Cycle 0 scripts the brain's first decision; after a restore the resumed members carry no ACTOR marker in
      // their replayed prompt, so the fixture names them 'lead'. Both scripts mean "this decision fails in transport".
      const transportFailure = [{ type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'TRANSPORT', message: 'Fixture connection loss' } } }]
      probe.model.queue('brain', transportFailure)
      probe.model.queue('lead', transportFailure)
      const runtime = await mountMars(probe.ctx, { directory, mode, seed: 1, automaticCheckpoints: true,
        resume: cycle > 0, port: 0, model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
      // Every member's model finish is audited; only a transport-failed decision is an error finish.
      const failures = () => z.array(z.object({ kind: z.string(), data: z.json() })).parse(
        readFileSync(`${directory}.audit.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
        .filter(record => record.kind === 'model-finish' && z.object({ reason: z.object({ kind: z.string() }) }).parse(record.data).reason.kind === 'error')
      await vi.waitFor(() => expect(failures()).toHaveLength(cycle + 1), { timeout: 20000 })
      const failure = z.object({ recoveryCheckpointId: z.string(), tick: z.number() }).parse(failures().at(-1)!.data)
      const checkpoint = (await runtime.checkpoints.list()).find(value => value.id === failure.recoveryCheckpointId)!
      // The referenced checkpoint is the last one saved before the failed decision, so restoring it re-runs that
      // decision at the same logical position rather than skipping past it.
      expect(failure.tick).toBe(checkpoint.tick + 1)
      await runtime.close(); await probe.close(); probes.splice(probes.indexOf(probe), 1)
      await runtime.checkpoints.restoreStopped(checkpoint.id)
    }
  })

it('records a model-driven plan and task using the original mission and actual tool replies', async () => {
  const probe = await boot('mars-model-planning', true, async (root) => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' }, 'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  probe.model.queue('brain',
    toolCallResponse('plan', 'note_write', { request_key: 'plan', path: 'plans/mission.md', revision: 0, text: '读取设备后调查水路，保存真实结果引用。' }),
    toolCallResponse('task', 'task_create', { request_key: 'task', input_json: JSON.stringify({ title: '调查水路', objectiveIds: ['W1'] }) }),
    new Gate().step())
  const runtime = await mountMars(probe.ctx, { directory: join(probe.root, 'mars'), mode: 'single-agent', seed: 1, automaticCheckpoints: true,
    port: 0, model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  await vi.waitFor(() => expect(runtime.records.listTasks()).toHaveLength(1))
  expect({ tasks: runtime.records.listTasks().map(task => ({ title: task.title, objectiveIds: task.objectiveIds,
    nativeAuthor: task.createdBy === runtime.root!.agent.id })), notes: runtime.records.listNotes().map(note => ({ path: note.path, text: note.text })) }).toMatchInlineSnapshot(`
    {
      "notes": [
        {
          "path": "plans/mission.md",
          "text": "读取设备后调查水路，保存真实结果引用。",
        },
      ],
      "tasks": [
        {
          "nativeAuthor": true,
          "objectiveIds": [
            "W1",
          ],
          "title": "调查水路",
        },
      ],
    }
  `)
  expect(runtime.snapshot().tick).toBeGreaterThanOrEqual(2)
  expect((await runtime.checkpoints.list()).length).toBeGreaterThanOrEqual(2)
  expect(() => evaluateStopped(join(probe.root, 'mars'))).toThrow()
  await runtime.close()
  const report = evaluateStopped(join(probe.root, 'mars'))
  expect(report.evidenceValid).toBe(true)
  expect(report.modelSource).toBe('scripted-integration')
})

it('gives the native root the complete mission and persists authored tasks and notes through normal tools', async () => {
  const probe = await boot('mars-planning', true, async (root) => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' }, 'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  probe.model.queue('brain', new Gate().step())
  const runtime = await mountMars(probe.ctx, { directory: join(probe.root, 'mars'), mode: 'single-agent', seed: 1,
    port: 0, model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  expect(runtime.snapshot().tasks).toEqual([])
  expect(runtime.snapshot().mission.tasks).toHaveLength(25)
  const agent = runtime.root!.agent
  const mission = await execute(probe, 'mission_read', {}, agent)
  expect(mission.isError).toBe(false)
  // v0.4: the runtime owns the team, so the catalog lists members (with their tasks, robots and tools) and no creation rights.
  expect(z.object({ organization: z.object({ mode: z.literal('single-agent'), maxParticipants: z.literal(1), maxDepth: z.literal(0),
    canCreate: z.record(z.string(), z.number()), members: z.array(z.object({ role: z.string(), tools: z.array(z.string()) })) }) }).parse(mission.value).organization)
    .toMatchObject({ canCreate: {}, members: [{ role: 'brain', tools: expect.arrayContaining(['water_assay', 'greenhouse_scan']) }] })
  expect(z.object({ organization: z.object({ members: z.array(z.object({ role: z.string() })) }) }).parse(mission.value).organization.members).toHaveLength(1)
  expect(runtime.org.config.roles.brain!.instructions).toContain('你是唯一成员')
  const created = await execute(probe, 'task_create', { request_key: 'investigate', input_json: JSON.stringify({ title: '调查水路', objectiveIds: ['W1'] }) }, agent)
  expect(created.isError).toBe(false)
  const task = z.object({ id: z.string(), createdBy: z.string() }).parse(created.value)
  expect(task.createdBy).toBe(agent.id)
  const written = await execute(probe, 'note_write', { request_key: 'plan', path: 'plans/mission.md', revision: 0, text: '先查询水路和设备，保存实际引用。' }, agent)
  expect(written.isError).toBe(false)
  const response = await fetch(`${runtime.viewer.origin}/viewer/api/v1/runs/${runtime.snapshot().runId}/snapshot`, { headers: { Authorization: `Bearer ${runtime.viewer.token}` } })
  expect(response.status).toBe(200)
  const snapshot = await response.json()
  expect(snapshot.tasks).toHaveLength(1)
  expect(snapshot.notes[0].text).toContain('实际引用')
  expect(snapshot.entities.some((entity: { kind: string }) => entity.kind === 'robot')).toBe(true)
  expect(snapshot.sensors.crops).toHaveLength(16)
  // v0.4 removes the hand-written experiment tools from every member; structured tools cover the same physical actions,
  // and every scientific stage still opens its own experiment record underneath (checked below through water_prepare).
  const calibration = await execute(probe, 'device_calibrate', { request_key: 'calibration', device_id: 'screen' }, agent)
  expect(calibration.isError, JSON.stringify(calibration.error)).toBe(false)
  const operation = z.object({ id: z.string() }).parse(calibration.value)
  while (runtime.world.operation(operation.id)?.state === 'running') runtime.world.advance()
  const read = await execute(probe, 'mars_result', { operation_id: operation.id }, agent)
  expect(read.isError).toBe(false)
  const output = z.object({ operation: z.object({ state: z.literal('succeeded'), artifacts: z.array(z.object({ id: z.string() })) }), artifacts: z.array(z.unknown()) }).parse(read.value)
  expect(output.artifacts.length).toBeGreaterThan(0)
  expect(runtime.engine.list(runtime.engine.issueContext('mars', 'integration-reader', ['facilities'])).some(value => value.id === operation.id)).toBe(true)
  const sampleCall = await execute(probe, 'water_sample', { request_key: 'source-water', source_id: 'reservoir', volume_ul: 10, container: 'vial' }, agent)
  expect(sampleCall.isError).toBe(false)
  const sampleOperation = z.object({ id: z.string() }).parse(sampleCall.value)
  while (runtime.world.observeSystems().operations.find(operation => operation.id === sampleOperation.id)?.state === 'running') runtime.world.advance()
  const sampleRead = await execute(probe, 'mars_result', { operation_id: sampleOperation.id }, agent)
  const sampleArtifact = z.object({ artifacts: z.array(z.object({ content: z.string() })) }).parse(sampleRead.value).artifacts[0]!
  const sampleId = z.object({ result: z.object({ sampleId: z.string() }) }).parse(JSON.parse(sampleArtifact.content)).result.sampleId
  const transfer = await execute(probe, 'sample_transfer', { request_key: 'deliver-water', robot_id: 'robot-2', sample_id: sampleId, destination: 'heater-1' }, agent)
  expect(transfer.isError).toBe(false)
  const transferId = z.object({ id: z.string() }).parse(transfer.value).id
  while (runtime.world.operation(transferId)?.state === 'running') runtime.world.advance()
  await execute(probe, 'mars_result', { operation_id: transferId }, agent)
  const stage = await execute(probe, 'water_prepare', { request_key: 'scientific-stage', task_id: task.id, device_id: 'heater-1',
    sample_id: sampleId, volume_ul: 10, method_version: 1, consumables: [{ batchId: runtime.world.truth.lots.B, units: 1 }] }, agent)
  expect(stage.isError, JSON.stringify(stage.error)).toBe(false)
  const stageId = z.object({ id: z.string() }).parse(stage.value).id
  const inspector = runtime.engine.issueContext('mars', 'integration-reader', ['water', 'greenhouse', 'facilities'])
  const binding = runtime.engine.readFacts(inspector).find(fact => fact.kind === 'mars-stage-binding')!
  const stageExperiment = z.object({ experimentId: z.string() }).parse(binding.data).experimentId
  expect(runtime.engine.experiments.get(inspector, stageExperiment).operations[0]!.id).toBe(stageId)
  expect(runtime.engine.experiments.get(inspector, stageExperiment).request.maxOperations).toBeNull()
  const unauthenticated = await fetch(`${runtime.viewer.origin}/viewer/api/v1/runs`)
  expect(unauthenticated.status).toBe(401)
  await vi.waitFor(() => expect(probe.model.requests.some(request => request.actor === 'brain')).toBe(true))
  await runtime.close()
})

it('builds the fixed six-role team with per-role tools and hides organization tools from every member', async () => {
  const probe = await boot('mars-roles', true, async (root) => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' }, 'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  probe.model.queue('brain', new Gate().step())
  for (const role of ['water', 'crops', 'agronomist', 'engineer', 'analyst']) probe.model.queue(role, new Gate().step())
  const runtime = await mountMars(probe.ctx, { directory: join(probe.root, 'mars'), mode: 'multi-agent', seed: 2,
    port: 0, model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  const brain = runtime.root!.agent
  // The runtime creates the whole team before the mission reaches the root, so all six take their first decision in one window.
  await vi.waitFor(() => expect(runtime.snapshot().agents).toHaveLength(6))
  const roster = () => z.array(z.object({ role: z.string() })).parse(runtime.snapshot().agents).map(value => value.role).sort()
  expect(roster()).toEqual(['agronomist', 'analyst', 'brain', 'crops', 'engineer', 'water'])
  const member = (role: string) => probe.ctx.agents.get(runtime.org.snapshotParticipants().find(value => value.role === role)!.id)!
  for (const role of ['water', 'crops', 'agronomist', 'engineer', 'analyst']) expect(member(role).session.header.parentSession).toBe(brain.id)
  for (const tool of ['mission_read', 'mars_catalog']) {
    const reply = await execute(probe, tool, {}, brain)
    expect(reply.isError).toBe(false)
    const organization = z.object({ organization: z.object({ maxParticipants: z.number(), maxDepth: z.number(),
      canCreate: z.record(z.string(), z.number()), members: z.array(z.object({ role: z.string(), tools: z.array(z.string()), robots: z.array(z.string()) })) }) }).parse(reply.value).organization
    // The team is fixed: nobody may create another member, and every role publishes its tasks, robots and tools.
    expect(organization).toMatchObject({ maxParticipants: 6, maxDepth: 1, canCreate: {} })
    expect(organization.members.map(value => value.role)).toEqual(['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst'])
    expect(organization.members.find(value => value.role === 'water')!.tools).toContain('water_assay')
    expect(organization.members.find(value => value.role === 'analyst')!.tools).not.toContain('water_assay')
    expect(organization.members.find(value => value.role === 'engineer')!.robots).toEqual(['robot-3'])
  }
  // A specialist sees only its own domain unless it asks for the full mission.
  const water = member('water')
  const ownMission = await execute(probe, 'mission_read', {}, water)
  expect(z.object({ tasks: z.array(z.object({ id: z.string() })) }).parse(ownMission.value).tasks.map(task => task.id))
    .toEqual(['D1', 'W1', 'W2', 'W3', 'W4'])
  expect(z.object({ tasks: z.array(z.object({ id: z.string() })) }).parse((await execute(probe, 'mission_read', { full: true }, water)).value).tasks).toHaveLength(25)
  // Organization tools, hand-written experiments and mars_submit are hidden from every member, the brain included.
  for (const [name, agent] of [['org_create', brain], ['org_create', water], ['experiment_create', water], ['mars_submit', water]] as const) {
    const hidden = await execute(probe, name, {}, agent)
    expect(hidden.isError, `${name} should be hidden from ${agent.id}`).toBe(true)
  }
  // Robots belong to one role each: water may drive robot-1, not robot-2.
  const foreign = await execute(probe, 'robot_move', { request_key: 'move-2', robot_id: 'robot-2', destination: 'cold-1' }, water)
  expect(foreign.isError).toBe(true)
  expect(JSON.stringify(foreign.error)).toContain('not yours to drive')
  // mars_message reaches exactly one registered role and wakes a waiting member without consuming logical time.
  const message = { request_key: 'service-request', target_role: 'engineer', content: '请检查过滤器状态并返回实际操作引用。' }
  const sent = await execute(probe, 'mars_message', message, water)
  expect(sent.isError, JSON.stringify(sent.error)).toBe(false)
  const beforeWait = runtime.snapshot().tick
  const received = await execute(probe, 'mars_wait', {}, member('engineer'))
  expect(received.isError).toBe(false)
  expect(z.object({ reason: z.string(), messages: z.array(z.object({ from: z.string(), content: z.string() })) }).parse(received.value))
    .toMatchObject({ reason: 'mail', messages: [{ from: 'water', content: message.content }] })
  expect(runtime.snapshot().tick).toBe(beforeWait)
  await execute(probe, 'mars_message', message, water)
  expect(runtime.snapshot().messages).toHaveLength(1)
  expect(runtime.snapshot().messages[0]).toMatchObject({ accepted: true, read: true, senderId: water.id })
  await runtime.close()
})

it('serves redacted scores and the new Mars endpoints through the authenticated viewer', async () => {
  const probe = await boot('mars-viewer-api', true, async (root) => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' }, 'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  probe.model.queue('brain', new Gate().step())
  const runtime = await mountMars(probe.ctx, { directory: join(probe.root, 'mars'), mode: 'single-agent', seed: 1,
    port: 0, model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  for (let tick = 0; tick < 5; tick++) runtime.world.advance()
  const agent = runtime.root!.agent
  expect((await execute(probe, 'incident_report', { entities: ['filter'], category: 'water', suspected_cause: 'clog', actions: 'inspect' }, agent)).isError).toBe(false)
  const analysis = await execute(probe, 'analysis_run', { code: 'return { value: 42 }' }, agent)
  expect(analysis.isError, JSON.stringify(analysis.error)).toBe(false)
  const analysisId = z.object({ runId: z.string() }).parse(analysis.value).runId
  const rejected = await execute(probe, 'deliverable_submit', { request_key: 'bad-answer', task_id: 'W1', answer_json: '{}', evidence_json: '{}' }, agent)
  expect(rejected.isError).toBe(false)
  expect(z.object({ accepted: z.literal(false) }).parse(rejected.value).accepted).toBe(false)
  const base = `${runtime.viewer.origin}/viewer/api/v1/runs/${runtime.snapshot().runId}`
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${runtime.viewer.token}` } })
    return { status: response.status, body: await response.json() }
  }
  const score = await get('/score')
  expect(score.status).toBe(200)
  expect(score.body).not.toHaveProperty('S')
  expect(score.body).not.toHaveProperty('normalized')
  expect(JSON.stringify(score.body)).not.toContain('"A"')
  expect(score.body.O.total).toBeGreaterThanOrEqual(0)
  expect(score.body.C).toMatchObject({ observable: expect.any(Number), reported: 1 })
  expect(score.body.R.tasks).toHaveLength(19)
  expect(score.body.X.tasks).toHaveLength(3)
  expect(score.body.D.duties.map((duty: { id: string }) => duty.id)).toEqual(['D1', 'D2', 'D3'])
  expect(score.body.R.tasks.find((task: { id: string }) => task.id === 'W1')).toMatchObject({ submissions: 0, rejected: 1 })
  expect(score.body.Q).toMatchObject({ rejected: 1 })
  const sensors = await get('/sensors')
  expect(sensors.status).toBe(200)
  expect(sensors.body.crops).toHaveLength(16)
  const entityState = await get('/snapshot')
  const cropEntity = entityState.body.entities.find((entity: { kind: string }) => entity.kind === 'crop')
  expect(cropEntity.state).not.toHaveProperty('infectedSince')
  expect(cropEntity.state).not.toHaveProperty('contamination')
  const incubator = entityState.body.entities.find((entity: { id: string }) => entity.id === 'incubator-1')
  expect(incubator.state).not.toHaveProperty('temperature')
  const channels = await get('/telemetry/channels')
  expect(channels.body.length).toBeGreaterThan(0)
  const telemetry = await get(`/telemetry?channels=${encodeURIComponent(channels.body[0])}&from=0&to=5&limit=50`)
  expect(telemetry.status).toBe(200)
  expect(Array.isArray(telemetry.body[channels.body[0]])).toBe(true)
  expect((await get('/announcements')).body).toEqual({ total: 0, events: [] })
  const deliverables = await get('/deliverables')
  expect(deliverables.body).toHaveLength(1)
  expect(deliverables.body[0]).toMatchObject({ kind: 'mars-deliverable-rejected', taskId: 'W1' })
  expect(deliverables.body[0].problems.length).toBeGreaterThan(0)
  const reports = await get('/incident-reports')
  expect(reports.body).toHaveLength(1)
  expect(reports.body[0]).toMatchObject({ actorId: agent.id, entities: ['filter'], category: 'water' })
  const runs = await get('/analysis-runs')
  expect(runs.body).toHaveLength(1)
  expect(runs.body[0]).toMatchObject({ id: analysisId, actorId: agent.id, status: 'done' })
  const run = await get(`/analysis-runs/${analysisId}`)
  expect(run.body).toMatchObject({ id: analysisId, code: 'return { value: 42 }', output: { value: 42 } })
  expect((await get('/model-activity')).body).toMatchObject({ active: expect.any(Array), recent: expect.any(Array) })
  expect((await get('/evaluation')).status).toBe(403)
  expect((await get('/interventions')).status).toBe(404)
  await runtime.close()
}, 30000)

it('starts the harness console and the Mars panel together on separate ports', async () => {
  const probe = await boot('mars-two-controls', true, async (root) => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' }, 'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  probe.model.queue('brain', new Gate().step())
  const runtime = await mountMars(probe.ctx, { directory: join(probe.root, 'mars'), mode: 'single-agent', seed: 1, port: 0,
    missionControlPorts: { harness: 0, mars: 0 },
    model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  const record = JSON.parse(readFileSync(join(probe.root, 'mars', 'mission-control.json'), 'utf8')) as
    { harness?: { launchUrl: string }; mars?: { launchUrl: string } }
  expect(record.harness?.launchUrl).toContain('#')
  expect(record.mars?.launchUrl).toContain('#')
  expect(record.harness!.launchUrl).not.toBe(record.mars!.launchUrl)
  const marsToken = record.mars!.launchUrl.split('#')[1]!
  const marsOrigin = new URL(record.mars!.launchUrl).origin
  const status = await fetch(`${marsOrigin}/mc/status`, { headers: { Authorization: `Bearer ${marsToken}` } })
  expect(await status.json()).toMatchObject({ mars: true, marsRunId: runtime.snapshot().runId,
    harnessUrl: new URL(record.harness!.launchUrl).origin })
  const proxied = await fetch(`${marsOrigin}/mc/mars/snapshot`, { headers: { Authorization: `Bearer ${marsToken}` } })
  expect(proxied.status).toBe(200)
  const text = await proxied.text()
  expect(JSON.parse(text).runId).toBe(runtime.snapshot().runId)
  expect(text).not.toContain(runtime.viewer.token)
  await runtime.close()
}, 90000)

it.each(['single-agent', 'multi-agent'] as const)('restores %s native membership, plan and physical state in a fresh host', async mode => {
  const directory = recoveryDirectory()
  const first = await boot('mars-checkpoint-native', true, async () => ({ withoutScience: true,
    configs: { jsonl: { root: join(directory, 'sessions'), compression: 'none' }, 'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(first)
  first.model.queue('brain', textResponse('已经读取使命，等待后续操作。'))
  const config = { directory, mode, seed: 1, port: 0,
    model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 }
  const original = await mountMars(first.ctx, config)
  await vi.waitFor(() => expect(original.root!.agent.status).toBe('idle'))
  const oldSessionId = original.root!.agent.id
  let childId: SessionId | undefined
  if (mode === 'multi-agent') {
    // The runtime builds the fixed team itself, so its members are real continuable children from tick 0.
    await vi.waitFor(() => expect(original.snapshot().agents).toHaveLength(6))
    childId = original.org.snapshotParticipants().find(member => member.role === 'water')!.id
    await vi.waitFor(() => expect(first.ctx.agents.get(childId!)?.status).not.toBe('running'))
  }
  const write = await execute(first, 'note_write', { request_key: 'saved-plan', path: 'plans/recovery.md', revision: 0, text: '检查点之前的计划与真实引用。' }, original.root!.agent)
  expect(write.isError).toBe(false)
  const checkpoint = await original.takeCheckpoint()
  const tick = original.snapshot().tick
  await execute(first, 'note_write', { request_key: 'discard', path: 'plans/recovery.md', revision: 1, text: '检查点之后的记录。' }, original.root!.agent)
  await original.close(); await first.close(); probes.splice(probes.indexOf(first), 1)
  await original.checkpoints.restoreStopped(checkpoint.id)
  const second = await boot('mars-checkpoint-resumed', true, async () => ({ withoutScience: true,
    configs: { jsonl: { root: join(directory, 'sessions'), compression: 'none' }, 'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(second)
  second.model.queue('brain', new Gate().step())
  const resumed = await mountMars(second.ctx, { ...config, resume: true })
  expect(resumed.root!.agent.id).toBe(oldSessionId)
  expect(resumed.snapshot().tick).toBe(tick)
  expect(resumed.snapshot().epoch).toBe(2)
  if (childId) {
    // The whole fixed team is re-enrolled with its saved session identity and its lineage to the restored root.
    const members = z.array(z.object({ id: z.string(), role: z.string(), parentId: z.string().nullable() })).parse(resumed.snapshot().agents)
    expect(members).toHaveLength(6)
    expect(members.find(entry => entry.id === childId)).toMatchObject({ role: 'water', parentId: oldSessionId })
    expect(members.filter(entry => entry.role !== 'brain').every(entry => entry.parentId === oldSessionId)).toBe(true)
  }
  expect(resumed.records.listNotes().find(note => note.path === 'plans/recovery.md')?.text).toContain('检查点之前')
  await resumed.close()
}, 60000)
