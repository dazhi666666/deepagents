import { publicMission, V05_TASK_IDS, V05_TASKS, type RoleId } from './registry.ts'
export const LEGACY_ROLE_MAP = { brain: 'director', water: 'wet_lab', crops: 'bio_ops', agronomist: 'theory', engineer: 'facilities', analyst: 'data_methods' } as const
export const V05_ROLES = ['director', 'wet_lab', 'bio_ops', 'theory', 'facilities', 'data_methods'] as const
const duties: Record<RoleId, string> = {
  director: '负责项目组合、资源取舍和跨项目承诺。只协调冲突，不审批每次专家查询。交付可执行联合计划。',
  wet_lab: '负责样品、对照、湿实验和留样。提出可比较的实验，记录真实时间与失败，提供原始测量。',
  bio_ops: '负责温室干预、作物运行与异常。持续记录实际处理条件，检验竞争解释，保持作物研究。',
  theory: '负责假设、可辨识性、模型与实验选择。提交可运行模型和前瞻预测，用实验反驳自己的解释。',
  facilities: '负责能源、设备、物流和研究运行能力。预测资源，维护设施，落实预约与承诺。',
  data_methods: '负责原始数据、方法、子批与质量。提交可重跑分析，说明校正范围和不确定性。',
}
export function v05Charter(role: keyof typeof LEGACY_ROLE_MAP | RoleId | 'single', decisionTicks = 12, horizon = 2400): string {
  const mapped: RoleId | 'single' = role in LEGACY_ROLE_MAP ? LEGACY_ROLE_MAP[role as keyof typeof LEGACY_ROLE_MAP] : role as RoleId | 'single'
  const common = `火星基地v0.5科研任务。时间窗${horizon} tick，每轮${decisionTicks} tick。\n三个项目为水质与测量、作物响应、设施与调度。\n` +
    '先 research_catalog 读取标量目标ID和数据契约。修改工具返回pending，本轮统一接纳后在下一轮用round_receipts读取结果；不要把pending当操作成功。\n' +
    '保持研究问题、证据、适用范围、模型版本、未决实验和资源承诺。通过实际实验与独立验证推进研究；不能把操作接纳当完成。\n' +
    '纯定时流程可预约，允许一次响应安排多个独立动作。物理资源共享，机器人按能力使用。发现冲突说明备选和代价。\n' +
    '方法更新后自主判断影响范围，修订执行模型和计划，保留未受影响研究。引用须明确版本和用途。\n' +
    '预测在验证数据可见前锁定。模型、实际暴露与旧预测不可回填。科学分数运行中不可见。\n' +
    '可以读取全部公开资料、按需检索和使用全部合法工具；角色是责任划分，不是独占权限。专家可直接交换证据和协商。\n'
  const scope = mapped === 'single' ? '你是唯一持久研究者，兼任全部职责。使用项目视图、笔记、检索、批处理和预约维持各研究线。\n' + Object.values(duties).join('\n') : duties[mapped]
  const tasks = V05_TASK_IDS.filter(id => mapped === 'single' || V05_TASKS[id].owner === mapped).map(id => `${id} ${V05_TASKS[id].title}：${V05_TASKS[id].question}`).join('\n')
  return `${common}\n${scope}\n默认负责任务（可以协助所有项目）：\n${tasks}\n总评分：${JSON.stringify(publicMission(horizon, decisionTicks).scoring)}。消息数、人数和笔记长度不直接得分。`
}
