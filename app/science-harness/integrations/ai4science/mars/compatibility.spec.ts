/** P0 uses actual native participants and a scripted adapter; no model API is contacted. */
import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { boot, execute, Gate, type Probe } from '../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { mountMars } from './runtime.ts'
import { truthFor } from './fixture.ts'

const probes: Probe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.close() })
for (const mode of ['single-agent', 'multi-agent'] as const) it(`P0 ${mode} preserves equal research tools and forbids extra model-created members`, async () => {
  const probe = await boot('mars-p0-capabilities', true, async root => ({ withoutScience: true,
    configs: { jsonl: { root: join(root, 'mars/sessions'), compression: 'none' },
      'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
  probes.push(probe)
  for (const role of ['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst']) probe.model.queue(role, new Gate().step())
  const directory = join(probe.root, 'mars')
  const runtime = await mountMars(probe.ctx, { benchmarkVersion: 'v0.5', directory, mode, seed: 1, truthFile: truthFor(directory).path,
    port: 0, decisionTicks: 12, model: { provider: 'teams-probe', model: 'fixture', maxTokens: 1024 }, pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  try {
    const participants = runtime.org.snapshotParticipants()
    expect(participants).toHaveLength(mode === 'multi-agent' ? 6 : 1)
    const visible = (role: string) => runtime.org.config.roles[role]!.tools!.filter(t => t !== 'org_create').sort()
    for (const participant of participants) {
      expect(visible(participant.role)).toEqual(visible('brain'))
      expect(visible(participant.role)).toEqual(expect.arrayContaining(['research_submit', 'water_confirm', 'greenhouse_scan', 'device_clean', 'experiment_plan']))
      const agent = probe.ctx.agents.get(participant.id)!
      for (const tool of ['org_create', 'subagent', 'fork', 'workflow'])
        expect((await execute(probe, tool, {}, agent)).isError).toBe(true)
    }
    expect(runtime.org.snapshotParticipants()).toHaveLength(participants.length)
  } finally { await runtime.close() }
})
