/** Native execution stopping policy preserves the original scientific horizon and partial-report semantics. */
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { boot, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { toolCallResponse } from '../../../../../science-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountMars } from '../runtime.ts'
import { truthFor } from '../fixture.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
async function fixture(name: string) {
  const probe = await boot(name, true, async root => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  const directory = join(probe.root, 'mars'), generated = truthFor(directory)
  // This tiny fixture represents an otherwise unchanged scientific world with H=24.
  writeFileSync(generated.path, JSON.stringify({ ...generated.truth, horizon: 24 }))
  return { probe, directory, config: { benchmarkVersion: 'v0.5' as const, directory, truthFile: generated.path, seed: 1, port: 0,
    decisionTicks: 12, stopAtTick: 12, model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 } }
}

it('clamps environment advancement and writes partial artifacts without evaluating the full scientific horizon', async () => {
  const { probe, directory, config } = await fixture('mars-v05-environment-stop')
  const runtime = await mountMars(probe.ctx, { ...config, mode: 'environment' })
  try {
    await expect(runtime.finalize()).rejects.toThrow('stop boundary')
    expect(existsSync(join(directory, 'final-score.json'))).toBe(false)
    for (let i = 0; i < 30; i++) runtime.world.advance(9999)
    expect(runtime.world.observe().tick).toBe(12)
    expect(runtime.world.advance()).toBeNull()
    expect(runtime.world.horizon).toBe(24)
    expect(runtime.world.truth.horizon).toBe(24)
    const report = await runtime.finalize()
    expect(report).toMatchObject({ status: 'partial', terminationReason: 'user_requested_stop', tick: 12, stopAtTick: 12,
      worldHorizon: 24, stopTargetReached: true, score: null, normalized: null, formalRankingEligible: false })
    const saved = JSON.parse(readFileSync(join(directory, 'final-score.json'), 'utf8'))
    expect(saved).toEqual(report)
    expect(JSON.parse(readFileSync(join(directory, 'early-stop-report.json'), 'utf8'))).toEqual(report)
    expect(readFileSync(join(directory, 'report/summary.md'), 'utf8')).toContain('12')
    expect(JSON.parse(readFileSync(join(directory, 'manifest.public.json'), 'utf8'))).toMatchObject({ horizon: 24, stopAtTick: 12, executionTermination: 'user_requested_stop' })
    expect(probe.model.requests).toHaveLength(0)
  } finally { await runtime.close() }
}, 30000)

it('terminates a native waiting agent at its execution stop instead of spinning toward the original horizon', async () => {
  const { probe, directory, config } = await fixture('mars-v05-native-wait-stop')
  probe.model.queue('brain', toolCallResponse('wait-past-stop', 'mars_wait', { until_tick: 9999 }))
  const runtime = await mountMars(probe.ctx, { ...config, mode: 'single-agent', automaticCheckpoints: true })
  try {
    await vi.waitFor(() => expect(runtime.snapshot().status).toBe('completed'), { timeout: 20000 })
    expect(runtime.world.observe().tick).toBe(12)
    expect(runtime.world.horizon).toBe(24)
    expect(runtime.world.advance(24)).toBeNull()
    const report = JSON.parse(readFileSync(join(directory, 'final-score.json'), 'utf8'))
    expect(report).toMatchObject({ status: 'partial', tick: 12, worldHorizon: 24, stopAtTick: 12, score: null, formalRankingEligible: false })
    const inspector = runtime.engine.issueContext('mars', 'stop-runtime-inspector', [])
    expect(runtime.engine.readFacts(inspector).filter(fact => fact.kind === 'mars-v05-infrastructure-interrupted')).toHaveLength(0)
    expect(probe.model.requests).toHaveLength(1)
  } finally { await runtime.close() }
}, 30000)

it('settles a short final decision window without repeated checkpoints or a model request after stopping', async () => {
  const { probe, directory, config } = await fixture('mars-v05-native-short-final-window')
  probe.model.queue('brain', toolCallResponse('observe-at-zero', 'mars_observe', {}))
  probe.model.queue('brain', toolCallResponse('observe-at-twelve', 'mars_observe', {}))
  // This response is intentionally left unused: the next full decision boundary is24,
  // while the actual user stop is23. The world must never spin trying to reach24.
  probe.model.queue('brain', toolCallResponse('must-not-request-after-stop', 'mars_observe', {}))
  const runtime = await mountMars(probe.ctx, { ...config, stopAtTick: 23, mode: 'single-agent', automaticCheckpoints: true })
  try {
    await vi.waitFor(() => expect(runtime.snapshot().status).toBe('completed'), { timeout: 20000 })
    expect(runtime.world.observe().tick).toBe(23)
    expect(runtime.world.horizon).toBe(24)
    const before = await runtime.checkpoints.published()
    expect(before.length).toBeGreaterThan(0)
    const requests = probe.model.requests.length
    expect(requests).toBe(2)
    // Host callers and clock callbacks may race with a cancelled boundary waiter.
    // Every post-terminal save request must reuse the retained checkpoint.
    await runtime.takeCheckpoint(true)
    await runtime.takeCheckpoint(false, true)
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    expect((await runtime.checkpoints.published()).map(c => c.id)).toEqual(before.map(c => c.id))
    expect(probe.model.requests).toHaveLength(requests)
    expect(runtime.snapshot().status).toBe('completed')
    const inspector = runtime.engine.issueContext('mars', 'post-stop-stream-inspector', [])
    const requestFacts = runtime.engine.readFacts(inspector).filter(fact => fact.kind === 'mars-model-request').length
    const auditPath = `${directory}.audit.jsonl`
    const auditRequests = () => readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string }).filter(record => record.kind === 'model-request').length
    const recordedRequests = auditRequests()
    // This fixture does not install the compaction plugin's purpose-map augmentation;
    // exercise its native lower-level stream shape without adding another plugin.
    const stream = probe.ctx.llm.stream.bind(probe.ctx.llm) as (options: GenerateOptions<string>) => AsyncIterable<StreamChunk>
    for (const purpose of ['conversation', 'compaction'] as const) {
      await expect((async () => {
        for await (const _chunk of stream({ provider: config.model.provider, model: config.model.model,
          purpose, sessionId: runtime.root!.agent.id, messages: [] })) { /* adapter must never be reached */ }
      })()).rejects.toMatchObject({ failure: { code: 'ABORTED' } })
    }
    expect(probe.model.requests).toHaveLength(requests)
    expect(auditRequests()).toBe(recordedRequests)
    expect(runtime.engine.readFacts(inspector).filter(fact => fact.kind === 'mars-model-request')).toHaveLength(requestFacts)
    expect(JSON.parse(readFileSync(join(directory, 'early-stop-report.json'), 'utf8'))).toMatchObject({ status: 'partial', tick: 23, worldHorizon: 24, stopAtTick: 23 })
  } finally { await runtime.close() }
}, 30000)
