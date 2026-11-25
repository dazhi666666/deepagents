/** Mount the native v0.5 runtime with the deterministic model fixture; never contacts a model service. */
import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { z } from 'zod'
import { boot, execute, Gate, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { mountMars } from '../runtime.ts'
import { truthFor } from '../fixture.ts'
import { V05_TASK_IDS } from './registry.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })

it('mounts research tools and eighteen objectives for a native single without exposing a legacy scientific score', async () => {
  const probe = await boot('mars-native-v05', true, async root => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  probe.model.queue('brain', new Gate().step())
  const directory = join(probe.root, 'mars')
  const runtime = await mountMars(probe.ctx, { benchmarkVersion: 'v0.5', directory, mode: 'single-agent', seed: 1,
    truthFile: truthFor(directory, 1).path, port: 0, decisionTicks: 12,
    model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  try {
    const agent = runtime.root!.agent
    const invoke = async (name: string, args: unknown) => {
      // Native fixture drives the host boundary explicitly; no model service is contacted.
      const result = await execute(probe, name, args, agent)
      if (!result.isError && (result.value as {state?: string}).state === 'pending') {
        await runtime.commitRound()
        const receipts = await execute(probe, 'round_receipts', {}, agent)
        const rows = receipts.value as { result: { isError: boolean; value?: unknown; error?: unknown } }[]
        const applied = rows.at(-1)!.result
        const until = Math.min(runtime.world.horizon, runtime.world.observe().tick + 12)
        while (runtime.world.observe().tick < until) runtime.world.advance(until)
        return applied
      }
      return result
    }
    const mission = await invoke('mission_read', {})
    expect(mission.isError).toBe(false)
    expect(z.object({ tasks: z.array(z.object({ id: z.string() })) }).parse(runtime.snapshot().mission).tasks.map(task => task.id)).toEqual([...V05_TASK_IDS])
    const catalog = await invoke('research_catalog', {})
    expect(catalog.isError, JSON.stringify(catalog.error)).toBe(false)
    expect(catalog.value).toMatchObject({ version: 'v0.5', calibrationStatus: 'not_frozen' })
    expect(runtime.org.config.roles.brain!.tools).toContain('research_write')
    expect(runtime.org.config.roles.brain!.tools).not.toContain('deliverable_submit')
    const claim = { id: 'native-water-claim', expectedRevision: 0, kind: 'claim', project: 'PW', content: { estimate: 7 }, reason: 'fixture observation' }
    const written = await invoke('research_write', { request_key: 'claim', input_json: JSON.stringify(claim) })
    expect(written.isError, JSON.stringify(written.error)).toBe(false)
    expect(written.value).toMatchObject({ id: claim.id, revision: 1, createdBy: agent.id })
    const read = await invoke('research_read', { id: claim.id })
    expect(read.isError).toBe(false)
    expect(read.value).toMatchObject({ current: { id: claim.id, revision: 1 } })
    const model = { id: 'native-model', code: 'return { prediction: input.x }', parameters: {}, inputSchema: {}, outputSchema: {},
      runtimeVersion: 'mars-analysis-v1', basedOn: [{ id: claim.id, revision: 1 }] }
    expect((await invoke('model_register', { request_key: 'model', input_json: JSON.stringify(model) })).isError).toBe(false)
    const prediction = await invoke('prediction_commit', { request_key: 'predict', input_json: JSON.stringify({ id: 'native-prediction',
      target: 'PW-01:holdout', modelId: model.id, inputDomain: {} }) })
    expect(prediction.isError, JSON.stringify(prediction.error)).toBe(false)
    expect(prediction.value).toMatchObject({ id: 'native-prediction', validationAvailableAt: runtime.world.horizon })
    const inspector = runtime.engine.issueContext('mars', 'v05-test-inspector', [])
    expect(runtime.engine.readFacts(inspector).filter(fact => fact.kind === 'mars-v05-research')).toHaveLength(4)
    expect(runtime.engine.readFacts(inspector).filter(fact => fact.kind === 'mars-v05-prediction')).toHaveLength(1)
    const task = await invoke('task_create', { request_key: 'task', input_json: JSON.stringify({ title: 'Current water baseline', objectiveIds: ['PW-01'] }) })
    expect(task.isError, JSON.stringify(task.error)).toBe(false)
    const score = runtime.snapshot().score
    for (const legacy of ['S', 'S_ref', 'ref', 'total', 'accuracy']) expect(score).not.toHaveProperty(legacy)
  } finally { await runtime.close() }
}, 30000)
