/** Descriptive partial-run report. Never runs final science scoring or future validation. */
import { writeFileSync } from 'node:fs'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { AnalysisRegistry } from '../analysis.ts'
import type { MarsWorld } from '../world.ts'
import type { MarsAudit } from '../audit.ts'
import { researchRecordSchema } from './research-records.ts'
import { modelArtifactSchema, predictionCommitSchema } from './predictions.ts'
import { observationSchema } from './evaluation-input.ts'
import { V05_TASK_IDS, V05_TASKS } from './registry.ts'

export interface EarlyStopOptions {
  engine: Pick<ExecutionEngine, 'readFacts' | 'list'>
  context: OperationContext
  analysis: Pick<AnalysisRegistry, 'ids' | 'get'>
  world: Pick<MarsWorld, 'observe' | 'sensors' | 'horizon'>
  stopAtTick: number
  reason?: 'user_requested_stop' | 'incomplete_run'
  audit?: Pick<MarsAudit, 'usage' | 'agentUsage'>
  usage?: ReturnType<MarsAudit['usage']>
}
export function buildEarlyStopReport(options: EarlyStopOptions) {
  const tick = options.world.observe().tick, horizon = options.world.horizon
  if (!Number.isSafeInteger(options.stopAtTick) || options.stopAtTick < 0 || options.stopAtTick >= horizon) throw new Error('Partial stop target must be before the original world horizon')
  if (tick >= horizon) throw new Error('World is terminal; partial reporting cannot replace terminal classification')
  const facts = options.engine.readFacts(options.context), operations = options.engine.list(options.context)
  const research = facts.filter(f => f.kind === 'mars-v05-research').map(f => researchRecordSchema.parse((f.data as { record: unknown }).record))
  const latest = [...new Map(research.map(record => [record.id, record])).values()]
  const models = facts.filter(f => f.kind === 'mars-v05-model').map(f => modelArtifactSchema.parse((f.data as { result: unknown }).result))
  const predictions = facts.filter(f => f.kind === 'mars-v05-prediction').map(f => predictionCommitSchema.parse((f.data as { result: unknown }).result))
  const observations = facts.filter(f => f.kind === 'mars-v05-observation').map(f => observationSchema.parse((f.data as { observation: unknown }).observation))
  const analyses = [...options.analysis.ids()].map(id => options.analysis.get(id)).filter(run => run !== undefined)
  const stateCounts: Record<string, number> = {}
  for (const operation of operations) stateCounts[operation.state] = (stateCounts[operation.state] ?? 0) + 1
  const usage = options.audit?.usage() ?? options.usage ?? null
  return {
    schemaVersion: 5, version: 'v0.5', status: 'partial' as const,
    terminationReason: options.reason ?? 'user_requested_stop', tick, stopAtTick: options.stopAtTick,
    stopTargetReached: tick >= options.stopAtTick, worldHorizon: horizon, formalRankingEligible: false,
    score: null, normalized: null, scientificAssessment: 'not_performed_for_partial_run',
    note: '按实际停止状态描述进展；原世界时间窗、事件与科学截止未改写。未运行未来验证或终局回放，未完成目标不视为科学失败。',
    progress: {
      tasks: V05_TASK_IDS.map(id => ({ id, title: V05_TASKS[id].title, project: V05_TASKS[id].project,
        submissionCount: observations.filter(o => o.objectiveId.startsWith(`${id}:`)).length,
        predictionCount: predictions.filter(p => p.target.startsWith(`${id}:`)).length,
        state: 'unassessed_at_partial_stop' as const })),
      researchRevisionCount: research.length, currentResearchCount: latest.length,
      currentResearch: latest.map(r => ({ id: r.id, revision: r.revision, project: r.project, kind: r.kind, declaredStatus: r.status,
        updatedTick: r.updatedTick, basedOn: r.basedOn, evidence: r.evidence })),
    },
    models: models.map(m => ({ id: m.id, hash: m.hash, createdBy: m.createdBy, createdTick: m.createdTick, basedOn: m.basedOn })),
    predictions: predictions.map(p => ({ id: p.id, target: p.target, modelId: p.modelId, modelHash: p.modelHash, lockedTick: p.lockedTick,
      validationAvailableAt: p.validationAvailableAt, state: 'locked_not_evaluated' as const })),
    observations: observations.map(o => ({ id: o.id, objectiveId: o.objectiveId, submittedAt: o.submittedAt, actorId: o.actorId,
      evidence: o.evidence, predictionId: o.predictionId ?? null, state: 'submitted_not_scored' as const })),
    operations: { counts: stateCounts, total: operations.length, items: operations.map(o => ({ id: o.id, providerId: o.providerId,
      actorId: o.actorId, state: o.state, input: o.input, artifactIds: o.artifacts.map(a => a.id) })) },
    analyses: analyses.map(run => ({ id: run.id, actorId: run.actorId, asOfTick: run.asOfTick, status: run.status, codeHash: run.codeSha256 })),
    publicState: options.world.sensors(),
    costs: { usage, byAgent: options.audit?.agentUsage() ?? null, includesAllRecordedAttempts: true },
  }
}
export type EarlyStopReport = ReturnType<typeof buildEarlyStopReport>

export function earlyStopMarkdown(report: EarlyStopReport): string {
  return `# Mars v0.5 提前停止记录\n\n状态：部分运行；${report.terminationReason === 'user_requested_stop' ? '用户要求停止' : '尚未完成'}。\n\n` +
    `实际 tick：${report.tick}；停止目标：${report.stopAtTick}；原世界终点：${report.worldHorizon}。\n\n` +
    `完成操作：${report.operations.counts.succeeded ?? 0}/${report.operations.total}；研究记录：${report.progress.currentResearchCount}；模型：${report.models.length}；冻结预测：${report.predictions.length}。\n\n` +
    `${report.note}\n\n本记录不提供完整总分或归一化成绩，不进入正式排名。任务提交和预测锁定仅表示实际进度，不表示科学结论已通过验证。\n`
}
export function writeEarlyStopReport(report: EarlyStopReport, paths: { jsonFile: string; markdownFile?: string }) {
  writeFileSync(paths.jsonFile, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  if (paths.markdownFile) writeFileSync(paths.markdownFile, earlyStopMarkdown(report), { encoding: 'utf8', mode: 0o600 })
}
