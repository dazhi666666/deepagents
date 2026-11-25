/** Resume the native loop from a checkpoint whose round is committed but time has not advanced. */
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { boot, Gate, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { toolCallResponse } from '../../../../../science-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { mountMars } from '../runtime.ts'
import { truthFor } from '../fixture.ts'

const probes: Probe[] = [], roots: string[] = []
afterEach(async () => {
  try { for (const probe of probes.splice(0)) await probe.close() }
  finally { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) }
})

it('resumes a committed boundary into the next decision round without repeating the saved mutation', async () => {
  const owned = mkdtempSync(join(tmpdir(), 'mars-v05-recovery-fixture-')); roots.push(owned)
  const directory = join(owned, 'mars')
  const first = await boot('mars-v05-boundary-restore', true, async () => ({ withoutScience: true,
    configs: { jsonl: { root: join(directory, 'sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(first)
  first.model.queue('brain', toolCallResponse('saved-write', 'note_write', { request_key: 'saved-write', path: 'notes/saved.md', revision: 0, text: 'saved before checkpoint' }), new Gate().step())
  const truthFile = truthFor(directory).path
  const config = { benchmarkVersion: 'v0.5' as const, directory, truthFile, mode: 'single-agent' as const, seed: 1,
    port: 0, automaticCheckpoints: true, decisionTicks: 12,
    model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 }
  const original = await mountMars(first.ctx, config)
  await vi.waitFor(() => expect(first.model.requests).toHaveLength(2), { timeout: 20000 })
  expect(original.world.observe().tick).toBe(12)
  expect(original.records.listNotes()).toMatchObject([{ path: 'notes/saved.md', revision: 1 }])
  const checkpoint = (await original.checkpoints.list()).filter(value => value.tick === 0 &&
    (value.metadata as { nativeState?: { missionSubmitted?: boolean } }).nativeState?.missionSubmitted).at(-1)
  expect(checkpoint, 'must exercise the saved committed-round boundary at tick zero').toBeDefined()
  const identity = original.root!.agent.id
  await original.close(); await first.close(); probes.splice(probes.indexOf(first), 1)
  await original.checkpoints.restoreStopped(checkpoint!.id)

  const second = await boot('mars-v05-boundary-resumed', true, async () => ({ withoutScience: true,
    configs: { jsonl: { root: join(directory, 'sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(second)
  const next = toolCallResponse('new-write', 'note_write', { request_key: 'new-write', path: 'notes/new.md', revision: 0, text: 'next round after restore' })
  second.model.queue('brain', next, new Gate().step())
  second.model.queue('lead', next, new Gate().step())
  const resumed = await mountMars(second.ctx, { ...config, resume: true })
  try {
    expect(resumed.root!.agent.id).toBe(identity)
    await vi.waitFor(() => expect(resumed.records.listNotes()).toHaveLength(2), { timeout: 20000 })
    await vi.waitFor(() => expect(second.model.requests).toHaveLength(2), { timeout: 20000 })
    expect(resumed.world.observe().tick).toBe(24)
    const inspector = resumed.engine.issueContext('mars', 'restore-inspector', [])
    const facts = resumed.engine.readFacts(inspector)
    const mutations = facts.filter(fact => fact.kind === 'mars-record-mutation')
    expect(mutations).toHaveLength(2)
    expect(resumed.records.listNotes().map(note => ({ path: note.path, revision: note.revision }))).toEqual([
      { path: 'notes/saved.md', revision: 1 }, { path: 'notes/new.md', revision: 1 },
    ])
    const receipts = facts.filter(fact => fact.kind === 'mars-v05-native-receipt').map(fact => fact.data as { callId: string; round: number })
    expect(receipts).toEqual([{ actorId: identity, callId: 'saved-write', round: 0, result: expect.anything() },
      { actorId: identity, callId: 'new-write', round: 1, result: expect.anything() }])
  } finally { await resumed.close() }
}, 60000)
