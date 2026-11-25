/** Public research commissions and candidate scoring; no instance labels or private cases. */
import { z } from 'zod'
import { contentHash, stageProfileSchema, payloadSchemas, submissionPayloadSchema, type StageProfile, type TaskId } from './contracts.ts'
import { isChoiceTrial, publicTrialPolicy, sharedPlanVersion } from './pilot-choice-contract.ts'

export const V06_TASK_IDS: TaskId[] = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']
export const RESEARCH_COMMISSIONS = [
  { id: 'J-A', title: '可信供水与异常解释', goal: '判断供水证据，区分真实变化、保存与检测问题；验证处置并复核下游解释。', dimensions: ['T1', 'T4', 'T5'] },
  { id: 'J-B', title: '资源受限的作物改进', goal: '区分真实生长、光温混杂和扫描偏差，在共享资源约束下验证处理方案。', dimensions: ['T2', 'T3'] },
  { id: 'J-C', title: '多项目研究交付', goal: '自主安排实验、质控、留样和维护，兑现固定科研服务目标。', dimensions: ['T3', 'T5', 'T6'] },
] as const
export const TASKS: Record<TaskId, { title: string; slots: ('baseline' | 'final')[]; components: Record<string, number> }> = {
  T1: { title: '可靠水质与保存校正', slots: ['baseline', 'final'], components: { current_accuracy: 0.4, storage_accuracy: 0.6 } },
  T2: { title: '受约束作物干预', slots: ['baseline', 'final'], components: { holdout_accuracy: 0.6, intervention_attainment: 0.4 } },
  T3: { title: '研究组合与资源管理', slots: ['baseline', 'final'], components: { energy_forecast: 0.3, commitment_forecast: 0.2, service_attainment: 0.5 } },
  T4: { title: '异常根因与处置验证', slots: ['final'], components: { diagnosis: 0.4, response_forecast: 0.3, response_effect: 0.3 } },
  T5: { title: '跨项目证据与选择性修订', slots: ['baseline', 'final'], components: { scope_accuracy: 0.2, dependent_pipeline: 0.5, independent_pipeline: 0.3 } },
  T6: { title: '联合交付与持续运行', slots: ['final'], components: {} },
}

export function taskSlots(id: TaskId, profile: StageProfile) {
  return id === 'T6' && isChoiceTrial(profile.jointTrial) ? (['baseline', 'final'] as const) : TASKS[id].slots
}

/** Describe the implemented protocol without claiming that scientific mechanisms are installed. */
export function publicMission(profile: StageProfile, decisionTicks: number, implementation: 'protocol_only' | 'scientific_candidate' = 'protocol_only') {
  const stages = stageProfileSchema.parse(profile)
  z.number().int().positive().parse(decisionTicks)
  return { version: 'v0.6' as const, status: implementation, calibrationStatus: 'not_frozen' as const,
    horizon: stages.horizon, decisionTicks, stages, commissions: RESEARCH_COMMISSIONS,
    ...(stages.researchWorkflow ? { researchWorkflow: { version: stages.researchWorkflow, drafts: 'Shared versioned submissions with public checks and explicit acceptance.', ...(stages.researchWorkflow === 'delivery-v2' ? {delivery:'Durable receipt follow-ups, delegated work, incremental public changes and typed check-and-submit at a common decision boundary.'} : {}), services: 'Bind T3 service commitments to the active portfolio review and recheck route energy and deadlines at commitment.' } } : {}),
    tasks: V06_TASK_IDS.map(id => ({ id, ...TASKS[id], slots:taskSlots(id, stages), lockTicks: { baseline: stages.baselineTick, final: stages.finalTick },
      ...(id === 'T6' && isChoiceTrial(stages.jointTrial) ? { baselinePayloadSchema:z.toJSONSchema(submissionPayloadSchema('T6','baseline',stages)) } : {}),
      payloadSchema: z.toJSONSchema((id === 'T6' && stages.jointTrial) || (id==='T2' && stages.jointTrial===sharedPlanVersion) ? submissionPayloadSchema(id, 'final', stages) : payloadSchemas[id]) })),
    ...(stages.jointTrial ? { jointTrial: publicTrialPolicy(stages.jointTrial) } : {}),
    scoring: { formula: 'R = 100 * (q_T1 + q_T2 + q_T3 + q_T4 + q_T5) / 5',
      primarySlot: 'final', baseline: isChoiceTrial(stages.jointTrial) ? 'T6 pilot preregistration; other baselines diagnostic' : 'diagnostic_only', O: 'separate_operational_diagnostics', F: 'joint_pass_no_extra_points', weights: 'candidate' },
    limitations: implementation === 'protocol_only' ? ['E1/E2 and scientific evaluation are not installed in this protocol milestone',
      'External model admission is disabled until budget, isolation and scientific feasibility are verified'] : ['Candidate scientific profile; tolerances and formal experimental protocol are not frozen'],
    instructions: '三个委托共享一个持续世界。目录是交付规则，不规定唯一实验SOP。baseline仅作诊断；行动的前瞻预测仍需在对应动作前锁定。',
  }
}
/** Bind stage settings and public JSON validation to the persisted run identity. */
export function protocolHash(profile: StageProfile, decisionTicks: number, implementation: 'protocol_only' | 'scientific_candidate' = 'protocol_only'): string {
  return contentHash(publicMission(profile, decisionTicks, implementation))
}
