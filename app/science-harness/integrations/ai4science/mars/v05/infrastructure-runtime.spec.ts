/** Infrastructure retries freeze virtual time and retain successful actors' staged responses. */
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { boot, Gate, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { toolCallResponse } from '../../../../../science-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountMars } from '../runtime.ts'
import { truthFor } from '../fixture.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })

it('freezes one undecided round on transport failure, checkpoints completed responses and retries only the failed actor', async () => {
  const probe = await boot('mars-v05-infrastructure-round', true, async root => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  const roles = ['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst'], retry = new Gate()
  const response = (role: string) => toolCallResponse(`write-${role}`, 'note_write', { request_key: `write-${role}`, path: `notes/${role}.md`, revision: 0, text: role })
  for (const role of roles.filter(role => role !== 'analyst')) probe.model.queue(role, response(role), new Gate().step())
  probe.model.queue('analyst', [{ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'fixture connection failure' } } }],
    async options => { await retry.wait(options.signal); return response('analyst') }, new Gate().step())
  const directory = join(probe.root, 'mars')
  const runtime = await mountMars(probe.ctx, { benchmarkVersion: 'v0.5', directory, mode: 'multi-agent', seed: 1,
    truthFile: truthFor(directory).path, port: 0, automaticCheckpoints: true, decisionTicks: 12, infrastructureRetryDelayMs: 0,
    model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  try {
    await vi.waitFor(() => expect(probe.model.requests).toHaveLength(7), { timeout: 20000 })
    expect(probe.model.requests.filter(request => request.actor === 'analyst')).toHaveLength(2)
    for (const role of roles.filter(role => role !== 'analyst')) expect(probe.model.requests.filter(request => request.actor === role), role).toHaveLength(1)
    expect(runtime.world.observe().tick).toBe(0)
    expect(runtime.records.listNotes()).toHaveLength(0)
    const inspector = runtime.engine.issueContext('mars', 'infrastructure-inspector', [])
    const facts = () => runtime.engine.readFacts(inspector)
    expect(facts().filter(fact => fact.kind === 'mars-v05-round' && String((fact.data as { key?: string }).key).startsWith('intent:0:'))).toHaveLength(5)
    const failed = runtime.org.snapshotParticipants().find(participant => participant.role === 'analyst')!.id
    const partial = (await runtime.checkpoints.list()).find(checkpoint => checkpoint.tick === 0 &&
      Boolean((checkpoint.metadata as { nativeState?: { infrastructureFailed?: Record<string, unknown> } }).nativeState?.infrastructureFailed?.[failed]))
    expect(partial, 'partial checkpoint must retain missing actor at unchanged tick').toBeDefined()
    retry.release()
    await vi.waitFor(() => expect(runtime.records.listNotes()).toHaveLength(6), { timeout: 20000 })
    await vi.waitFor(() => expect(probe.model.requests).toHaveLength(13), { timeout: 20000 })
    expect(runtime.world.observe().tick).toBe(12)
    expect(facts().filter(fact => fact.kind === 'mars-record-mutation')).toHaveLength(6)
    expect(facts().filter(fact => fact.kind === 'mars-v05-native-receipt')).toHaveLength(6)
    expect(facts().filter(fact => fact.kind === 'mars-v05-infrastructure-recovered')).toHaveLength(1)
  } finally { await runtime.close() }
}, 60000)

it('keeps an exhausted infrastructure failure interrupted and accepts an explicit replacement response at the same tick', async () => {
  const probe = await boot('mars-v05-infrastructure-interrupted', true, async root => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  probe.model.queue('brain', [{ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'fixture transport unavailable' } } }])
  const directory = join(probe.root, 'mars')
  const runtime = await mountMars(probe.ctx, { benchmarkVersion: 'v0.5', directory, mode: 'single-agent', seed: 1,
    truthFile: truthFor(directory).path, port: 0, automaticCheckpoints: true, decisionTicks: 12, infrastructureRetryLimit: 0, infrastructureRetryDelayMs: 0,
    model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  try {
    const inspector = runtime.engine.issueContext('mars', 'interruption-inspector', [])
    const facts = () => runtime.engine.readFacts(inspector)
    await vi.waitFor(() => expect(facts().filter(fact => fact.kind === 'mars-v05-infrastructure-interrupted')).toHaveLength(1), { timeout: 20000 })
    expect(runtime.world.observe().tick).toBe(0)
    expect(probe.model.requests).toHaveLength(1)
    expect(runtime.snapshot().status).toBe('attention-required')
    probe.model.queue('brain', toolCallResponse('replacement', 'note_write', { request_key: 'replacement', path: 'notes/recovered.md', revision: 0, text: 'recovered same decision window' }), new Gate().step())
    runtime.root!.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ACTOR brain\nRetry the interrupted infrastructure request.' }] }))
    await vi.waitFor(() => expect(runtime.records.listNotes()).toHaveLength(1), { timeout: 20000 })
    await vi.waitFor(() => expect(probe.model.requests).toHaveLength(3), { timeout: 20000 })
    expect(runtime.world.observe().tick).toBe(12)
    expect(facts().filter(fact => fact.kind === 'mars-v05-native-receipt')).toHaveLength(1)
    expect(facts().filter(fact => fact.kind === 'mars-v05-infrastructure-recovered')).toHaveLength(1)
  } finally { await runtime.close() }
}, 60000)
