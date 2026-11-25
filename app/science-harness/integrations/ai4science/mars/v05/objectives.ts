/** Public scientific output contracts. Candidate tolerances are proposals, never private targets or measured error bars. */
import { V05_TASK_IDS, V05_TASKS, type TaskId } from './registry.ts'

export interface PublicObjectiveContract {
  objectiveId: string
  taskId: TaskId
  branch: 'accuracy' | 'test' | 'joint'
  field: string
  description: string
  metric: 'numeric' | 'exact' | 'set'
  units: string
  /** Evaluate every public entity; missing entities score zero, never shrink the denominator. */
  scope: readonly string[]
  aggregation: 'fixed-entity-mean'
  points: number
  candidateTolerance: { mode: 'relative' | 'absolute'; value: number; absoluteFloor: number } | null
  evidencePurposes: readonly string[]
  validation: 'current-evidence' | 'frozen-model-probe' | 'actual-execution'
  predictionTarget: string | null
  calibrationStatus: 'candidate_not_calibrated'
}
type Goal = Omit<PublicObjectiveContract, 'objectiveId' | 'taskId' | 'branch' | 'points' | 'aggregation' | 'validation' | 'predictionTarget' | 'calibrationStatus'> & { share: number }
const modules = ['reservoir', 'filter', 'pump']
const varieties = ['variety-1', 'variety-2', 'variety-3', 'variety-4']
const crops = Array.from({ length: 4 }, (_, chamber) => Array.from({ length: 4 }, (_, variety) => `crop-${chamber + 1}-${variety + 1}`)).flat()
const devices = ['confirm', 'imager', 'centrifuge-1', 'centrifuge-2', 'heater-1']
const one = ['declared-conditions']
const relative = (value = 0.15, absoluteFloor = 0.01) => ({ mode: 'relative' as const, value, absoluteFloor })
const absolute = (value: number) => ({ mode: 'absolute' as const, value, absoluteFloor: value })
const number = (field: string, description: string, units: string, share = 1, scope: readonly string[] = one,
  candidateTolerance: NonNullable<PublicObjectiveContract['candidateTolerance']> = relative(), evidencePurposes: readonly string[] = ['current-estimate']): Goal =>
  ({ field, description, units, share, scope, metric: 'numeric', candidateTolerance, evidencePurposes })
const exact = (field: string, description: string, share = 1, scope: readonly string[] = one, evidencePurposes: readonly string[] = ['current-estimate']): Goal =>
  ({ field, description, units: 'category', share, scope, metric: 'exact', candidateTolerance: null, evidencePurposes })
const set = (field: string, description: string, share = 1, scope: readonly string[] = one, evidencePurposes: readonly string[] = ['current-estimate']): Goal =>
  ({ field, description, units: 'entity-set', share, scope, metric: 'set', candidateTolerance: null, evidencePurposes })

/** Scope and fields are fixed public output domains; actual holdout inputs remain private until validation. */
const accuracyGoals: Record<Exclude<TaskId, `PX-${string}`>, readonly Goal[]> = {
  'PW-01': [number('concentration_by_module', '三位置在声明基线时段的真实浓度', 'DOC concentration units', 0.75, modules), number('filter_efficiency', '对应同一条件下的过滤去除率', 'fraction', 0.25, one, absolute(0.05))],
  'PW-02': [number('decay_rate_by_temperature', '保存速率或已公开认可的可辨识等价量', '1/tick', 0.7, ['4C', '-10C', '22C'], relative(0.2, 0.00001)), exact('transfer_applicable', '历史保存模型对当前基质是否适用', 0.3)],
  'PW-03': [number('method_bias_ratio', '有可比对照支持的方法偏差', 'ratio', 0.4, one, absolute(0.04), ['bias-study', 'calibration']), number('batch_bias_ratio', '有可比对照支持的子批偏差', 'ratio', 0.4, one, absolute(0.04), ['bias-study', 'calibration']), set('affected_result_ids', '需修订解释的真实结果集合', 0.2, one, ['historical'])],
  'PW-04': [set('source_hypotheses', '污染来源集合', 0.4), number('pump_increment', '污染对泵出口浓度的增量', 'DOC concentration units', 0.3), exact('lubricant_present', '原始指纹是否支持润滑剂存在', 0.15), exact('faulty_sensor', '诱饵传感器或none', 0.15)],
  'PW-05': [number('concentration_by_module', '联合解释在已支持条件下的浓度', 'DOC concentration units', 0.7, modules), exact('domain_supported', '来源保存方法组合是否在模型支持域', 0.3)],
  'PG-01': [number('baseline_growth_by_crop', '十六批作物可辨识基线组合', 'simulated growth units/tick', 0.75, crops), number('scanner_bias_by_chamber', '舱内扫描相对校准锚点的偏差', 'ratio', 0.25, ['incubator-1', 'incubator-2', 'incubator-3', 'incubator-4'], absolute(0.05), ['calibration'])],
  'PG-02': [number('light_optimum_by_variety', '可辨识光照最适量', 'light setting units', 0.45, varieties, absolute(10)), number('response_width_by_variety', '光照响应宽度', 'light setting units', 0.3, varieties, relative(0.2, 1)), number('temperature_optimum_by_variety', '当前模拟器实际建模的温度最适量（未实现独立动态滞后参数）', 'C', 0.25, varieties, absolute(1))],
  'PG-03': [number('recommendation_utility', '推荐组合在公开可行网格和固定效用下的达成率', 'fraction', 0.7, one, absolute(0.1)), number('predicted_growth', '推荐组合的条件生长预测', 'simulated growth units/tick', 0.3, varieties)],
  'PG-04': [set('cause_by_crop', '病害污染设施竞争原因集合', 0.6, crops), number('conditional_risk_by_crop', '预声明时间窗的条件风险', 'probability', 0.4, crops, absolute(0.15))],
  'PG-05': [number('conditional_growth_by_crop', '更新后的条件生长解释', 'simulated growth units/tick', 0.7, crops), exact('domain_supported', '修订模型的适用性判断', 0.3)],
  'PF-01': [number('battery_capacity', '条件电池容量', 'battery energy units', 0.4, one, absolute(40)), number('dust_decay', '积尘造成的有效效率衰减', '1/tick', 0.3, one, relative(0.2, 0.0001)), number('clean_panel_peak', '清洁条件下发电峰值', 'power units', 0.3)],
  'PF-02': [number('remaining_uses_by_device', '以当前维护和使用状态为条件的剩余次数', 'uses', 0.7, devices, relative(0.2, 1)), exact('fault_class_by_device', '校准漂移硬件磨损或正常', 0.3, devices)],
  'PF-03': [number('remaining_concentration', '实际保存暴露后的浓度', 'DOC concentration units', 0.7), exact('scientifically_usable', '对已声明固定研究目的是否仍可用', 0.3)],
  'PF-04': [number('operation_finish_offset', '预测操作链相对起点的完成时间', 'tick', 0.5, one, absolute(24)), exact('schedule_feasible', '真实容量下排程是否可行', 0.3), set('blocking_resources', '预测的阻塞资源集合', 0.2)],
}
const testGoals: Record<Exclude<TaskId, `PX-${string}`>, readonly Goal[]> = {
  'PW-01': [number('holdout_concentration', '未拟合标准或基质条件下的浓度解释', 'DOC concentration units', 1, modules)],
  'PW-02': [number('holdout_concentration', '新保存轨迹下的浓度预测', 'DOC concentration units')],
  'PW-03': [number('corrected_concentration', '独立方法子批对照的校正浓度', 'DOC concentration units')],
  'PW-04': [number('post_response_concentration', '独立复核中的水质浓度', 'DOC concentration units', 1, modules)],
  'PW-05': [number('holdout_concentration', '新来源保存方法组合的联合预测', 'DOC concentration units', 0.7, modules), exact('holdout_supported', '新组合的支持域识别', 0.3)],
  'PG-01': [number('holdout_growth_by_crop', '独立成像或留出时段的基线预测', 'simulated growth units/tick', 1, crops)],
  'PG-02': [number('holdout_growth_by_variety', '未拟合光照温度组合下的响应', 'simulated growth units/tick', 1, varieties)],
  'PG-03': [number('holdout_growth_by_variety', '冻结推荐模型在独立组合下的生长', 'simulated growth units/tick', 1, varieties)],
  'PG-04': [number('holdout_risk_by_crop', '后续病例条件下的风险预测', 'probability', 1, crops, absolute(0.15))],
  'PG-05': [number('holdout_growth_by_crop', '后期独立条件下修订模型的预测', 'simulated growth units/tick', 1, crops)],
  'PF-01': [number('next_sol_generation', '未拟合昼夜及负载下的发电', 'energy units', 0.6), number('minimum_soc', '对应窗口最低荷电状态', 'battery energy units', 0.4, one, relative(0.15, 8))],
  'PF-02': [number('holdout_remaining_uses', '锁定使用序列或后续操作的条件寿命', 'uses', 1, devices, relative(0.2, 1))],
  'PF-03': [number('holdout_concentration', '独立温度与样品组合下的暴露预测', 'DOC concentration units', 0.7), exact('holdout_usable', '独立轨迹下的研究可用性', 0.3)],
  'PF-04': [number('holdout_finish_offset', '未见操作组合的完成时间', 'tick', 0.7, one, absolute(24)), exact('holdout_feasible', '未见资源组合的容量可行性', 0.3)],
}
const jointGoals: Record<Extract<TaskId, `PX-${string}`>, readonly Goal[]> = {
  'PX-01': [number('protected_information_fraction', '固定科学对象的实际信息保全', 'fraction', 0.6, one, absolute(0.1)), number('required_research_continuity', '预声明关键研究交付的保持率', 'fraction', 0.4, one, absolute(0.1))],
  'PX-02': [number('water_service_fraction', '污染响应窗口中持续供水目标的达成率', 'fraction', 0.5, one, absolute(0.1)), number('interpretable_experiment_fraction', '污染期间目标实验经调整仍可解释的比例', 'fraction', 0.5, one, absolute(0.1))],
  'PX-03': [number('affected_workflow_restored', '真实受影响研究链完成修复的比例', 'fraction', 0.5, one, absolute(0.1)), number('unaffected_commitments_preserved', '未受影响研究保持必要执行的比例', 'fraction', 0.5, one, absolute(0.1))],
  'PX-04': [number('future_research_attainment', '真实终局延伸500tick的固定研究目标达成率', 'fraction', 0.6, one, absolute(0.1)), number('future_constraint_attainment', '延伸回放必要约束和运行目标达成率', 'fraction', 0.4, one, absolute(0.1))],
}

function expand(taskId: TaskId, branch: PublicObjectiveContract['branch'], goals: readonly Goal[], share: number): PublicObjectiveContract[] {
  const sum = goals.reduce((n, goal) => n + goal.share, 0)
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`Objective shares must sum to one: ${taskId}/${branch}`)
  return goals.map(({ share: goalShare, ...goal }) => ({ ...goal, objectiveId: `${taskId}:${branch}:${goal.field}`, taskId, branch,
    points: V05_TASKS[taskId].weight * share * goalShare, aggregation: 'fixed-entity-mean',
    evidencePurposes: branch === 'test' ? ['validation', ...goal.evidencePurposes] : goal.evidencePurposes,
    validation: branch === 'test' ? 'frozen-model-probe' : branch === 'joint' ? 'actual-execution' : 'current-evidence',
    predictionTarget: branch === 'test' ? `${taskId}:holdout` : null, calibrationStatus: 'candidate_not_calibrated' }))
}
export const V05_OBJECTIVES: readonly PublicObjectiveContract[] = V05_TASK_IDS.flatMap(id => id.startsWith('PX')
  ? expand(id, 'joint', jointGoals[id as keyof typeof jointGoals], 1)
  : [...expand(id, 'accuracy', accuracyGoals[id as keyof typeof accuracyGoals], 0.65), ...expand(id, 'test', testGoals[id as keyof typeof testGoals], 0.35)])

/** JSON-safe copy: callers cannot change the shared registry by editing the catalog response. */
export function publicObjectiveContracts(taskId?: TaskId): { calibrationStatus: 'candidate_not_calibrated'; tolerancePolicy: string; objectives: PublicObjectiveContract[] } {
  return { calibrationStatus: 'candidate_not_calibrated',
    tolerancePolicy: '候选容差须在开发场景验证单位、噪声、物理可行性和可辨识性后冻结。相对容差使用max(abs(target)*value,absoluteFloor)。此处不含真实目标值；范围和子目标权重也须标定。',
    objectives: structuredClone(V05_OBJECTIVES.filter(o => !taskId || o.taskId === taskId)) }
}
