/** Real native multi-member loop with delayed scripted responses; no external model service. */
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { boot, Gate, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { toolCallResponse } from '../../../../../science-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { mountMars } from '../runtime.ts'
import { truthFor } from '../fixture.ts'
import { orderRoundIntents } from './rounds.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })

it('starts all six actors together and applies their mutations only after the slowest response at a common boundary', async () => {
  const probe = await boot('mars-v05-shared-round', true, async root => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  const roles = ['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst'], gates = new Map(roles.map(role => [role, new Gate()]))
  for (const role of roles) probe.model.queue(role, async options => {
    await gates.get(role)!.wait(options.signal)
    return toolCallResponse(`note-${role}`, 'note_write', { request_key: `note-${role}`, path: `notes/${role}.md`, revision: 0, text: role })
  }, new Gate().step())
  const directory = join(probe.root, 'mars')
  const runtime = await mountMars(probe.ctx, { benchmarkVersion: 'v0.5', directory, mode: 'multi-agent', seed: 1,
    truthFile: truthFor(directory).path, port: 0, automaticCheckpoints: true, decisionTicks: 12,
    model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  try {
    await vi.waitFor(() => expect(probe.model.requests).toHaveLength(6), { timeout: 20000 })
    const participants = runtime.org.snapshotParticipants()
    expect(participants).toHaveLength(6)
    const tick = runtime.world.observe().tick
    expect(tick).toBe(0)
    const inspector = runtime.engine.issueContext('mars', 'round-inspector', [])
    const facts = () => runtime.engine.readFacts(inspector)
    const open = facts().find(fact => fact.kind === 'mars-v05-round' && (fact.data as { key?: string }).key === 'open:0')!
    expect((open.data as unknown as { value: { actors: string[] } }).value.actors).toHaveLength(6)
    for (const role of roles.filter(role => role !== 'analyst')) gates.get(role)!.release()
    await vi.waitFor(() => expect(facts().filter(fact => fact.kind === 'mars-v05-round' && String((fact.data as { key?: string }).key).startsWith('intent:0:'))).toHaveLength(5), { timeout: 20000 })
    expect(runtime.records.listNotes()).toHaveLength(0)
    expect(runtime.world.observe().tick).toBe(tick)
    gates.get('analyst')!.release()
    await vi.waitFor(() => expect(runtime.records.listNotes()).toHaveLength(6), { timeout: 20000 })
    await vi.waitFor(() => expect(probe.model.requests).toHaveLength(12), { timeout: 20000 })
    expect(runtime.world.observe().tick).toBe(12)
    const expected = orderRoundIntents(0, participants.map(p => String(p.id)), participants.map(p => ({ actorId: String(p.id), sequence: 0, requestKey: 'note', input: null }))).map(intent => intent.actorId)
    const actual = facts().filter(fact => fact.kind === 'mars-record-mutation').map(fact => fact.actorId)
    expect(actual).toEqual(expected)
    expect(facts().filter(fact => fact.kind === 'mars-v05-native-receipt')).toHaveLength(6)
  } finally { await runtime.close() }
}, 60000)
