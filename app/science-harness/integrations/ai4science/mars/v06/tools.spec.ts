/** Exercise JSON parsing and durable v0.6 records through real native tools, with no model request. */
import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { boot, execute, type Probe } from '../../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { installResearchTools } from './tools.ts'

const probes: Probe[] = [], engines: ExecutionEngine[] = []
afterEach(async () => {
  try { for (const engine of engines.splice(0)) await engine.close() }
  finally { for (const probe of probes.splice(0)) await probe.close() }
})
it('records research and format-only submissions without certifying a prediction or calling a model', async () => {
  const probe = await boot('mars-v06-tools', true, async () => ({ withoutScience: true })); probes.push(probe)
  const engine = new ExecutionEngine({ directory: join(probe.root, 'protocol-engine'), providers: [], pollIntervalMs: 10, providerCallTimeoutMs: 1000 })
  await engine.open(); engine.createProject('mars', null); engines.push(engine)
  const root = await probe.ctx.agents.create({ sessionId: SessionId('v06-tool-client'), agentOptions: { provider: 'teams-probe', model: 'fixture' } })
  let now = 1
  installResearchTools({ engine, tick: () => now, profile: { baselineTick: 3, finalTick: 8, horizon: 12 }, decisionTicks: 1, resolvers: {},
    access: agent => {
      if (probe.ctx.agents.get(agent.id) !== agent) throw new Error('Exact live native caller required')
      return engine.issueContext('mars', agent.id, [])
    },
    register: (name, description, parameters, body) => {
      probe.ctx.tools.register(defineTool({ name, description, parameters,
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, execution) => {
          if (!execution.agent) throw new Error('Native caller required')
          return z.json().parse(await body(args, execution.agent, execution.signal))
        } }))
    } })
  const invoke = (name: string, request: unknown) => execute(probe, name, request, root.agent)
  expect((await invoke('research_catalog', { section: 'contracts' })).isError).toBe(false)
  const written = await invoke('research_write', { request_key: 'note', input_json: JSON.stringify({
    id: 'study', expectedRevision: 0, kind: 'study', project: 'PW', content: { hypothesis: 'none' }, reason: 'Protocol fixture' }) })
  expect(written.isError).toBe(false)
  const artifact = { id: 'm', code: 'return { value: 1 }', parameters: {}, inputSchema: {}, outputSchema: {},
    runtimeVersion: 'mars-analysis-v1', basedOn: [{ id: 'study', revision: 1 }] }
  expect((await invoke('model_register', { request_key: 'model', input_json: JSON.stringify(artifact) })).isError).toBe(false)
  const refused = await invoke('prediction_commit', { request_key: 'p', input_json: JSON.stringify({ id: 'p', taskId: 'T1', slotId: 'final', modelId: 'm', inputDomain: {} }) })
  expect(refused.isError).toBe(true)
  const submission = { taskId: 'T4', slotId: 'final', payload: { diagnosis: ['none'] }, evidence: [], expectedRevision: 0 }
  const checked = await invoke('research_submit', { action: 'check', request_key: 'check', input_json: JSON.stringify(submission) })
  expect(checked.isError).toBe(false)
  expect(checked.value).toEqual({ formatValid: true, scientificValidation: 'not_evaluated', accepted: false,
    taskId: 'T4', slotId: 'final', expectedRevision: 0, checkedTick: 1, acceptBeforeTick: 8, nextAction: 'submit' })
  const accepted = await invoke('research_submit', { request_key: 'submit', input_json: JSON.stringify(submission) })
  expect(accepted.isError).toBe(false)
  expect(accepted.value).toMatchObject({ taskId: 'T4', acceptedTick: 1, revision: 1 })
  const read = await invoke('research_read', {})
  expect(read.value).toMatchObject({ research: [{ id: 'study', revision: 1 }], models: [{ id: 'm' }], predictions: [], submissions: [{ taskId: 'T4' }] })
  const grant = engine.issueContext('mars', 'inspector', [])
  expect(engine.readFacts(grant).filter(f => f.kind === 'mars-v06-research')).toHaveLength(1)
  expect(engine.readFacts(grant).some(f => f.kind.startsWith('mars-v05-'))).toBe(false)
  now = 8
  expect((await invoke('model_register', { request_key: 'after-lock', input_json: JSON.stringify({ ...artifact, id: 'late' }) })).isError).toBe(true)
  expect(probe.model.requests).toHaveLength(0)
})
