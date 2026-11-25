/** Public research projection. No evaluator, Truth, probes or target values are accepted. */
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { V05ResearchRecords } from './research-records.ts'
import { V05Predictions } from './predictions.ts'
import { V05Planning } from './planning.ts'
import { V05_TASK_IDS, V05_TASKS } from './registry.ts'
export function researchProjection(engine: ExecutionEngine, grant: OperationContext, tick: number) {
  const records = new V05ResearchRecords(engine, grant, () => tick)
  const predictions = new V05Predictions(engine, grant, () => tick, records)
  const plans = new V05Planning(engine, grant, () => tick)
  const current = records.list()
  return {
    version: 'v0.5', tick,
    projects: ['PW', 'PG', 'PF', 'PX'].map(project => ({ project, tasks: V05_TASK_IDS.filter(id => id.startsWith(project)).map(id => V05_TASKS[id]),
      records: current.filter(record => record.project === project), open: current.filter(record => record.project === project && ['provisional', 'needs_review'].includes(record.status)).length })),
    records: current,
    revisions: current.flatMap(record => records.history(record.id)),
    models: predictions.models().map(model => ({ id: model.id, hash: model.hash, createdBy: model.createdBy, createdTick: model.createdTick, basedOn: model.basedOn })),
    predictions: predictions.predictions(), plans: plans.list(), reservations: plans.reservations(),
    observations: engine.readFacts(grant).filter(fact => fact.kind === 'mars-v05-observation').map(fact => (fact.data as { observation: unknown }).observation),
  }
}
