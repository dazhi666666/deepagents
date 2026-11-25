/** Native tool bridge. Scientific truth never enters a tool closure. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from '../world.ts'
import type { AnalysisRegistry } from '../analysis.ts'
import { publicObjectiveContracts } from './objectives.ts'
import { V05Observations } from './evaluation-input.ts'
import { V05ResearchRecords } from './research-records.ts'
import { V05Predictions } from './predictions.ts'
import { V05_TASK_IDS, publicMission } from './registry.ts'
import { PUBLIC_HANDOVER, publicResources } from './resources.ts'

export const V05_TOOLS = ['research_read', 'research_write', 'model_register', 'prediction_commit', 'research_catalog', 'research_submit']
type Register = (name: string, description: string, parameters: ParameterSchemaSpec,
  body: (args: Record<string, unknown>, agent: Agent, signal: AbortSignal) => unknown | Promise<unknown>) => void
export function installResearchTools(context: { register: Register; engine: ExecutionEngine; world: MarsWorld;
  analysis: AnalysisRegistry; access: (agent: Agent, tool: string) => OperationContext; decisionTicks: number; publicScenario?: import('./scenario.ts').V05Scenario['public'] | undefined; resolveReference?: (id: string) => string }) {
  const { register, engine, world, analysis, access } = context
  const stores = (agent: Agent, name: string) => {
    const grant = access(agent, name), now = () => world.observe().tick
    const records = new V05ResearchRecords(engine, grant, now, reference => {
      if (reference.revision !== undefined && reference.revision !== 1) return null
      const referenceId = context.resolveReference?.(reference.id) ?? reference.id
      const operation = engine.list(grant).find(item => item.id === referenceId || item.artifacts.some(artifact => artifact.id === referenceId))
      if (operation?.state === 'succeeded') return { availableAt: now() }
      const result = world.observe().results.find(item => item.id === referenceId)
      if (result?.completedTick !== undefined && result.completedTick !== null) return { availableAt: result.completedTick }
      const run = analysis.get(referenceId)
      if (run?.status === 'done') return { availableAt: now() }
      return null
    })
    const predictions = new V05Predictions(engine, grant, now, records, target => {
      if (!V05_TASK_IDS.some(id => target === `${id}:holdout`)) return null
      return { availableAt: world.horizon, policyHash: createHash('sha256').update(`v05-holdout:${target}:${world.horizon}`).digest('hex') }
    })
    const observations = new V05Observations(engine, grant, now, id => {
      const canonical = context.resolveReference?.(id) ?? id
      const operation = engine.list(grant).find(item => item.id === canonical || item.artifacts.some(artifact => artifact.id === canonical))
      if (operation?.state === 'succeeded' || analysis.get(canonical)?.status === 'done' || world.observe().results.some(item => item.id === canonical && item.completedTick !== null)) return { availableAt: now() }
      return null
    })
    return { records, predictions, observations }
  }
  const payload = { input_json: { type: 'string', required: true, description: 'JSON object matching the contract shown by research_catalog.' },
    request_key: { type: 'string', required: true } } as const
  const input = (args: Record<string, unknown>) => {
    const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(String(args.input_json)))
    if (Array.isArray(parsed.evidence)) parsed.evidence = parsed.evidence.map(item => {
      const ref = z.record(z.string(), z.unknown()).parse(item)
      return { ...ref, ...(typeof ref.id === 'string' ? { id: context.resolveReference?.(ref.id) ?? ref.id } : {}) }
    })
    return parsed
  }
  const fullCatalog = () => ({
    ...publicMission(world.horizon, context.decisionTicks), resources: publicResources(world), objectives: publicObjectiveContracts(), handover: context.publicScenario?.handover ?? PUBLIC_HANDOVER, publicScenario: context.publicScenario ?? null,
    contracts: {
      research_write: { id: 'claim-id', expectedRevision: 0, kind: 'study|claim|commitment', project: 'PW|PG|PF|PX', content: {}, reason: 'why', basedOn: [], evidence: [], status: 'provisional' },
      model_register: { id: 'model-v1', code: 'return { prediction: 0 }', parameters: {}, inputSchema: {}, outputSchema: {}, runtimeVersion: 'mars-analysis-v1', basedOn: [] },
      prediction_commit: { id: 'prediction-v1', target: 'PW-01:holdout', modelId: 'model-v1', inputDomain: {} },
    }, calibrationStatus: 'not_frozen',
  })
  register('research_catalog', 'Read the compact v0.5 directory. Use section=tasks/objectives/resources/handover/contracts with task_id, offset and limit for details. No scientific answers.',
    { section: { type: 'string', enum: ['summary','tasks','objectives','resources','handover','contracts'] }, task_id: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, args => {
      const catalog = fullCatalog(), offset = z.number().int().nonnegative().parse(args.offset ?? 0), limit = z.number().int().min(1).max(10).parse(args.limit ?? 3)
      const page = (items: unknown[]) => ({ total: items.length, offset, limit, items: items.slice(offset, offset + limit) })
      const section = String(args.section ?? 'summary'), task = args.task_id === undefined ? undefined : String(args.task_id)
      if (section === 'contracts') return { contracts: catalog.contracts }
      if (section === 'handover') return page([...catalog.handover])
      if (section === 'tasks') return page(catalog.tasks.filter(item => !task || item.id === task))
      if (section === 'objectives') return { scalarTargets: page((catalog.publicScenario?.objectives ?? []).filter(item => !task || item.objectiveId.startsWith(task + ':'))), contracts: page(catalog.objectives.objectives.filter(item => !task || item.taskId === task)) }
      if (section === 'resources') return page([ ...catalog.resources.devices.map(value => ({ kind: 'device', value })), ...catalog.resources.methods.map(value => ({ kind: 'method', value })), ...catalog.resources.robots.map(value => ({ kind: 'robot', value })), ...Object.entries(catalog.resources.rules).map(([name, value]) => ({ kind: 'rule', name, value })) ])
      return { version: catalog.version, calibrationStatus: catalog.calibrationStatus, horizon: catalog.horizon, decisionTicks: catalog.decisionTicks, scoring: catalog.scoring,
        tasks: catalog.tasks.map(item => ({ id: item.id, title: item.title, owner: item.owner, weight: item.weight })), contracts: catalog.contracts,
        handoverIndex: catalog.handover.map(item => ({ id: item.id, project: item.project })), sections: ['tasks','objectives','resources','handover','contracts'],
        instructions: 'Read relevant sections with small pages. For raw datasets use analysis_run with readRaw/readArtifact/archiveSql; never ingest full tables into conversation.' }
    })
  register('research_read', 'Read current or historical research, immutable models and predictions. Optional id/revision/query/project.',
    { id: { type: 'string' }, revision: { type: 'integer' }, query: { type: 'string' }, project: { type: 'string' } }, (args, agent) => {
      const { records, predictions } = stores(agent, 'research_read')
      if (args.id) return { current: records.read(String(args.id), args.revision === undefined ? undefined : Number(args.revision)), history: records.history(String(args.id)) }
      return { records: records.search(String(args.query ?? ''), z.enum(['PW', 'PG', 'PF', 'PX']).optional().parse(args.project)), models: predictions.models(), predictions: predictions.predictions() }
    })
  register('research_write', 'Create or revise a study, claim or commitment using expectedRevision and stable request_key. Self-declared support is not truth.', payload,
    (args, agent) => stores(agent, 'research_write').records.put(String(args.request_key), input(args) as Parameters<V05ResearchRecords['put']>[1]))
  register('research_submit', 'Submit an objective answer with real evidence references. Host timestamps the submission; no online scientific accuracy feedback. input_json={objectiveId,value,evidence:[{id,purpose}],predictionId?}.', payload,
    (args, agent) => stores(agent, 'research_submit').observations.submit(String(args.request_key), input(args) as Parameters<V05Observations['submit']>[1]))
  register('model_register', 'Register immutable executable model code, parameters, schemas and exact research dependency revisions.', payload,
    (args, agent) => stores(agent, 'model_register').predictions.registerModel(String(args.request_key), input(args) as Parameters<V05Predictions['registerModel']>[1]))
  register('prediction_commit', 'Freeze model hash and prediction domain before the host-declared holdout availability. Does not run or certify a prediction.', payload,
    (args, agent) => stores(agent, 'prediction_commit').predictions.commit(String(args.request_key), input(args) as Parameters<V05Predictions['commit']>[1]))
}
