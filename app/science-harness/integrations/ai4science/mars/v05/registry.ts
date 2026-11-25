/** Public v0.5 research registry. This contains questions, never scenario answers. */
export const V05_PROJECTS = ['PW', 'PG', 'PF', 'PX'] as const
export type ProjectId = typeof V05_PROJECTS[number]
export const V05_TASK_IDS = ['PW-01', 'PW-02', 'PW-03', 'PW-04', 'PW-05', 'PG-01', 'PG-02', 'PG-03', 'PG-04', 'PG-05',
  'PF-01', 'PF-02', 'PF-03', 'PF-04', 'PX-01', 'PX-02', 'PX-03', 'PX-04'] as const
export type TaskId = typeof V05_TASK_IDS[number]
export type RoleId = 'director' | 'wet_lab' | 'theory' | 'data_methods' | 'bio_ops' | 'facilities'
export interface TaskDefinition { id: TaskId; project: ProjectId; title: string; weight: number; owner: RoleId; question: string; evidence: readonly string[] }
const task = (id: TaskId, title: string, weight: number, owner: RoleId, question: string, evidence: string[]): TaskDefinition =>
  ({ id, project: id.slice(0, 2) as ProjectId, title, weight, owner, question, evidence })
export const V05_TASKS: Record<TaskId, TaskDefinition> = {
  'PW-01': task('PW-01', '版本化水质基线与误差分离', 3, 'wet_lab', '建立三处水质及去除率基线，区分测量偏差与真实变化。', ['三位置当前观测', '原始色谱分析', '方法版本与适用范围']),
  'PW-02': task('PW-02', '保存动力学与当前迁移验证', 4, 'wet_lab', '历史保存模型能否解释当前样品在真实温度轨迹下的变化？', ['历史多温度序列', '可辨识的当前对照测量', '冻结的转移预测']),
  'PW-03': task('PW-03', '方法与子批定量追溯', 4, 'data_methods', '哪些测量解释受方法或子批变化影响，怎样定量修正？', ['可比较对照', '样品与方法谱系', '修订模型及保留集合']),
  'PW-04': task('PW-04', '污染与传感器异常区分', 4, 'wet_lab', '区分真实污染、在线传感器异常和保存偏差，建立暴露时间线。', ['独立观测', '原始指纹分析', '基线与修复后复核']),
  'PW-05': task('PW-05', '水质模型独立验证', 3, 'theory', '修订后的解释能否预测未参与拟合的样品与条件？', ['冻结模型', '独立验证', '适用范围']),
  'PG-01': task('PG-01', '生长与观测基线', 3, 'bio_ops', '建立有条件范围的生长基线，并区分观测偏差。', ['跨舱跨时观测', '实际暴露', '校准依据']),
  'PG-02': task('PG-02', '光照温度混杂与滞后', 5, 'theory', '如何通过实验区分光照、温度与滞后响应？', ['多水平干预', '真实温度与处理历史', '留出预测']),
  'PG-03': task('PG-03', '营养灌溉与CO₂优化', 5, 'bio_ops', '在资源约束下选择下一轮处理并验证推荐方案。', ['真实处理组合', '资源使用', '冻结推荐与预测']),
  'PG-04': task('PG-04', '异常竞争解释', 4, 'bio_ops', '生长异常来自病害、污染还是设施条件，怎样检验？', ['竞争假设', '区分性观测', '后续复核']),
  'PG-05': task('PG-05', '修订作物模型独立验证', 3, 'theory', '新知识进入模型后，是否改善独立条件下的预测？', ['版本依赖', '冻结模型', '独立观测']),
  'PF-01': task('PF-01', '能源与温控辨识', 3, 'facilities', '辨识设施能力并在目标数据出现前预测运行范围。', ['遥测', '负载及维护历史', '冻结预测']),
  'PF-02': task('PF-02', '寿命校准与维护选择', 3, 'facilities', '如何结合设备状态和研究需求选择维护？', ['磨损代理', '维护记录', '实际停机与预测']),
  'PF-03': task('PF-03', '冷链与样品价值', 3, 'facilities', '不同保存与排队方案怎样影响样品的科学价值？', ['真实温度暴露', '保存模型', '留样及损失记录']),
  'PF-04': task('PF-04', '多实验资源预测排程', 3, 'director', '如何预测并安排设备、物流与能源，满足跨项目承诺？', ['资源模型', '预约与实际操作', '完成等待及失败事实']),
  'PX-01': task('PX-01', '能源冷链科研取舍', 4, 'director', '资源不足时如何保留最重要科学信息并继续研究？', ['样品价值依据', '实际取舍', '保全与科研后果']),
  'PX-02': task('PX-02', '污染期间供水与可解释性', 4, 'director', '根因未明时如何维持供水并保护实验解释？', ['水质与作物证据', '供水执行', '条件修正']),
  'PX-03': task('PX-03', '跨项目研究恢复', 4, 'director', '方法变化后怎样修复受影响研究并保留其他研究？', ['真实依赖', '模型与计划修订', '后续执行']),
  'PX-04': task('PX-04', '后续联合研究方案', 3, 'director', '从当前真实终局状态出发安排未来500 tick研究与运行。', ['冻结确定性策略', '当前库存和故障', '实际延伸回放']),
}
export const V05_COMPONENT_WEIGHTS = { R: 50, K: 15, J: 15, O: 15, Q: 5 } as const
export function publicMission(horizon = 2400, decisionTicks = 12) {
  if (!Number.isSafeInteger(horizon) || horizon <= 0 || !Number.isSafeInteger(decisionTicks) || decisionTicks <= 0) throw new Error('Invalid mission timing')
  return { version: 'v0.5', status: 'design_not_frozen', horizon, decisionTicks, tasks: V05_TASK_IDS.map(id => V05_TASKS[id]),
    scoring: V05_COMPONENT_WEIGHTS, rules: ['身份不构成评分条件；单Agent可以完成全部任务。', '支持检索、批量操作和预约；物理资源照常消耗。',
      '必须读取原始证据并维护适用范围；预测在验证数据可见之前锁定。', '公开预检只查合法性；科学准确度仅在终局离线评测。'] }
}
