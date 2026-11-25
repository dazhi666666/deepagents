/** The optional sampling preset variant runs the same experiment through native model tool calls. */
import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { boot, execute, lead, toolValue } from './organization-fixture.ts'
import { textResponse, toolCallResponse } from './test-host.ts'
import RoleDefaults from './preset-defaults.ts'
import * as Sampling from './scenes/sampling.ts'

function assignment(options: GenerateOptions): { experimentId: string; notify: string } {
  const marker = options.messages.flatMap(message => message.content)
    .find(block => block.type === 'text' && block.text.startsWith('ACTOR worker\n'))
  if (marker?.type !== 'text') throw new Error('Missing actual worker assignment')
  return JSON.parse(marker.text.split('\n').slice(1).join('\n'))
}

it('the optional compact preset example keeps model behavior, provider grants and observed sampling results', async () => {
  const p = await boot('sampling-presets', true, async root => {
    const config = JSON.parse(await readFile(new URL('./examples/sampling.compact.presets.organization.json', import.meta.url), 'utf8'))
    await writeFile(join(root, 'org.json'), JSON.stringify(config))
    await writeFile(join(root, 'deployment.json'), JSON.stringify({
      apiVersion: 1, hostApi: '0.2', enabled: true, directory: join(root, 'execution'),
      pollIntervalMs: 5, providerCallTimeoutMs: 3000,
      management: { actorId: 'operator', projects: ['cross-branch-project'], allowedProviders: ['instrument'] },
      providers: [{ module: fileURLToPath(new URL('./providers/instrument.ts', import.meta.url)),
        config: { id: 'instrument', directory: join(root, 'device'), resource: 'instrument', tickMs: 1,
          reference: 10, slope: 0.27, drift: 0.012, noise: 0.18, seed: 9 } }],
    }))
    return {
      withoutScience: true,
      modules: {
        'preset-registry': AgentPresets,
        sampling: { ...Sampling, async apply(ctx: Context) {
          await Sampling.apply(ctx, { deploymentFile: join(root, 'deployment.json'), organizationFile: join(root, 'org.json'),
            task: 'Obtain the same observations with optional role presets', budget: 100,
            roleProviders: { controller: ['instrument'], worker: ['instrument'] } })
        } },
      },
      configs: { 'preset-registry': { default: 'ai4science-cerebrum' } },
      resolveModules: { '@deepseek-ai/dsh-agent-preset': AgentPreset, '../preset-defaults.ts': RoleDefaults },
      entries: ['cerebrum', 'midbrain', 'cerebellum'].map(id => ({ id: `template-${id}`, name: 'cordis:include',
        config: { path: new URL(`./presets/${id}.yml`, import.meta.url).href } })),
    }
  })
  try {
    await [...p.ctx.loader.entries()].find(entry => entry.options.name === 'sampling')!.fiber!.await()
    const root = await lead(p, 'sampling-preset-controller')
    expect(p.ctx.agentPresets.presetForSession(root.agent.session)).toBe('ai4science-midbrain')
    const created = await execute(p, 'experiment_create', {
      request_key: 'same-recipe', request_json: JSON.stringify(Sampling.samplingRequest('instrument')),
    }, root.agent)
    if (created.isError) throw new Error(created.error.message)
    const experiment = (created.value as { id: string }).id
    p.model.queue('worker',
      options => toolCallResponse('measure', 'experiment_act', { experiment_id: assignment(options).experimentId,
        decision_json: JSON.stringify({ actionId: 'measure', requestKey: 'initial', rationale: 'Acquire approved observations.' }) }),
      options => toolCallResponse('wait-initial', 'experiment_wait', { experiment_id: assignment(options).experimentId,
        after_seq: 0, until: 'decision', timeout_ms: 10000 }),
      options => toolCallResponse('quality-initial', 'sampling_assess', { experiment_id: assignment(options).experimentId }),
      options => {
        const quality = toolValue(options, 'quality-initial') as { status: string; artifactId: string }
        expect(quality.status).toBe('insufficient')
        return toolCallResponse('supplement', 'experiment_act', { experiment_id: assignment(options).experimentId,
          decision_json: JSON.stringify({ actionId: 'supplement', requestKey: 'additional', rationale: 'Four observations are below six.',
            evidenceArtifactIds: [quality.artifactId] }) })
      },
      options => toolCallResponse('wait-extra', 'experiment_wait', { experiment_id: assignment(options).experimentId,
        after_seq: 0, until: 'decision', timeout_ms: 10000 }),
      options => toolCallResponse('quality-final', 'sampling_assess', { experiment_id: assignment(options).experimentId }),
      options => {
        expect(toolValue(options, 'quality-final')).toMatchObject({ status: 'sufficient', observed: 6 })
        return toolCallResponse('notify', 'send_message', { agent: assignment(options).notify, message: 'Preset sampling complete' })
      }, textResponse('Observed six samples through approved experiment decisions.'))
    const node = await execute(p, 'org_create', { role: 'worker',
      task: 'ACTOR worker\n' + JSON.stringify({ experimentId: experiment, notify: root.agent.id }) }, root.agent)
    if (node.isError) throw new Error(node.error.message)
    const child = p.ctx.agents.get(SessionId((node.value as { participant: { id: string } }).participant.id))!
    expect(p.ctx.agentPresets.presetForSession(child.session)).toBe('ai4science-cerebellum')
    expect(p.ctx.tools.schemas(child).map(tool => tool.name).sort()).toEqual([
      'experiment_act', 'experiment_wait', 'experiment_status', 'sampling_assess', 'send_message', 'list_agents',
    ].sort())
    await vi.waitFor(() => expect(child.session.snapshotEvents().some(event => event.type === 'tool/result' &&
      event.data.message.toolCallId === 'notify' && !event.data.message.isError)).toBe(true), { timeout: 15000 })
    const finished = await execute(p, 'sampling_finish', { experiment_id: experiment }, root.agent)
    expect(finished).toMatchObject({ isError: false, value: { state: 'completed', budgetUsed: 6,
      operations: [expect.any(Object), expect.any(Object)] } })
    const device = new DatabaseSync(join(p.root, 'device/instrument.sqlite'))
    try {
      expect(device.prepare('SELECT COUNT(*) n FROM starts').get()?.n).toBe(2)
      expect(device.prepare('SELECT COUNT(*) n FROM samples').get()?.n).toBe(6)
    } finally { device.close() }
    expect(await execute(p, 'experiment_act', { experiment_id: experiment, decision_json: '{}' }, Object.create(child))).toMatchObject({ isError: true })
    expect(await execute(p, 'execution_describe', {}, child)).toMatchObject({ isError: true })
  } finally { await p.close() }
})
