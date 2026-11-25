/** Exercise core normalization and durable tool/result events, rather than inspecting a middleware return. */
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { boot, execute, stored, Gate, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { toolCallResponse } from '../../../../../science-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountMars } from '../runtime.ts'
import { truthFor } from '../fixture.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
const text = (blocks: readonly { type: string; text?: string }[]) => blocks.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n')

it('persists byte-bounded model content after core normalization while keeping full canonical values and backend data', async () => {
  const probe = await boot('mars-v05-tool-display', true, async root => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  const ready = new Gate()
  const batch: StreamChunk[] = Array.from({ length: 6 }, (_, index) => toolCallResponse(`display-${index}`, 'note_read', { path: 'notes/display.md' })
    .filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage').map(chunk => 'index' in chunk ? { ...chunk, index } : chunk)).flat()
  batch.push({ type: 'finish', reason: { kind: 'tool-calls' } })
  probe.model.queue('brain', async options => { await ready.wait(options.signal); return batch }, new Gate().step())
  const directory = join(probe.root, 'mars')
  const runtime = await mountMars(probe.ctx, { benchmarkVersion: 'v0.5', directory, mode: 'single-agent', seed: 1,
    truthFile: truthFor(directory).path, port: 0, automaticCheckpoints: true, decisionTicks: 12,
    model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  try {
    const raw = '科学"\\\t🧪'.repeat(12000)
    runtime.records.writeNote('fixture-note', 'notes/display.md', 0, raw)
    const actor = runtime.root!.agent
    ready.release()
    await vi.waitFor(() => expect(actor.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(6), { timeout: 20000 })
    await vi.waitFor(() => expect(probe.model.requests).toHaveLength(2), { timeout: 20000 })
    const messages = actor.session.snapshotEvents().flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
    expect(messages.every(message => !message.isError)).toBe(true)
    const visible = messages.map(message => text(message.content))
    for (const result of visible) expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(12000)
    expect(visible.reduce((sum, result) => sum + Buffer.byteLength(result, 'utf8'), 0)).toBeLessThanOrEqual(48000)
    expect(visible.some(result => result.includes('"truncated":true'))).toBe(true)
    expect(visible.every(result => !result.includes('\uFFFD'))).toBe(true)
    expect(visible.filter(result => result.length === 0).length).toBeGreaterThanOrEqual(1)
    await probe.ctx.sessionPersistence.flush()
    const durable = await stored(probe, actor.id)
    const persisted = durable.events.flatMap(event => event.type === 'tool/result' ? [text(event.data.message.content)] : [])
    expect(persisted).toEqual(visible)
    // A new response resets the aggregate budget. Registry values stay complete even
    // when their model-visible content is abbreviated by the post-execute policy.
    const canonical = await execute(probe, 'note_read', { path: 'notes/display.md' }, actor)
    expect(canonical.isError).toBe(false)
    expect((canonical.value as { notes: { text: string }[] }).notes[0]!.text).toBe(raw)
    expect(Buffer.byteLength(text(canonical.content))).toBeLessThanOrEqual(12000)
    expect(text(canonical.content)).toContain('"truncated":true')
    expect(runtime.records.listNotes()[0]!.text).toBe(raw)
  } finally { await runtime.close() }
}, 30000)
