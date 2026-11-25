/** Fixed-roster research descriptions; responsibilities confer no exclusive physical tools. */
import { HIDDEN_TOOLS, SINGLE_TOOLS, SPECIALISTS, type Specialist, type TeamRole } from '../team.ts'
import { LEGACY_ROLE_MAP } from '../v05/team.ts'
import { V05_PLAN_TOOLS } from '../v05/planning-tools.ts'
import { isChoiceTrial, sharedPlanVersion } from './pilot-choice-contract.ts'
import type { StageProfile } from './contracts.ts'

export const V06_TOOLS = ['research_catalog', 'research_read', 'research_write', 'model_register', 'prediction_commit', 'research_submit']
export const ROLE_DUTIES = {
  director: '协调项目组合、共享资源、期限和联合交付；不审批每次专家实验。',
  wet_lab: '设计湿实验、对照和留样，检查真实样品与测量谱系。',
  bio_ops: '管理作物处理和运行，记录实际条件与干预后果。',
  theory: '提出竞争解释，检查可辨识性，建立模型并选择检验实验。',
  facilities: '管理能源、设备、物流、维护和资源承诺。',
  data_methods: '分析原始数据、测量偏差与不确定性，检查证据和选择性修订。',
} as const
export const FIXED_ROLES: TeamRole[] = ['brain', ...SPECIALISTS]

type ExtraSpecialist = 'service' | 'verifier'
const deliveryDuties: Record<Specialist | ExtraSpecialist, string> = {
  water: '主责 T1 水质与保存研究、T4 诊断与处置，从当前实测和质控做到正式提交。和 engineer 协调检测设备与机器人占用，把可引用的水质证据及模型 ID 发给 analyst。',
  crops: '主责 T2，从作物维护、对照与扫描做到模型、预测和正式提交。为 final 所引用的干预计划安排封存后的处理与验证。可请 agronomist 协助实验设计和建模。',
  agronomist: '主责 T3 的能源分析、模型、预测和正式提交。同时推进能源工作和服务承诺的汇总。收到 engineer 的已接纳承诺 ID 后更新 T3，按当前有效证据及时提交并用新版本补齐。',
  engineer: '主责三项固定服务、设备和物流。开局按每项公开截止安排测量与留样，和 water 协调共享设备。为前瞻承诺预留计划登记、预测和确认回执的窗口，并在第一步开工前锁定。把已接纳的承诺 ID 和测量、留样证据发给 agronomist。',
  analyst: '主责 T5 跨项目模型或流水线、预测和正式提交。先推进可独立验证的部分，再合入 water 和 agronomist 提供的实际证据与模型。可协助其它岗位核对契约和引用。',
  service: '三项固定服务都由你负责登记计划、锁定承诺、取得按时实测和核对同一母样终点留存。先用 experiment_plan(action=portfolio) 联查所有服务草案，请 engineer 安排设备、清洗和返桩窗口。备选计划需要新承诺，按真实转运和测量回执交接，报告具体阻塞与剩余时间。与 water 和 engineer 协商仪器、机器人及用水。用 experiment_plan 的 service 字段绑定委托、测量步骤和留样步骤，先核对预检和登记回执，再锁定 T3 承诺放行开工。将已接纳的承诺、计划和实测证据交给 agronomist。',
  verifier: '负责公开证据的独立验证。用 research_catalog(section=references) 分清 payload 的产物 ID 和 evidence 的实测引用，协助 T1/T2 负责人在封存前完成预检、正式提交并读回执。按需安排对照、复测和公开输入上的 model_test，报告具体证据 ID 和缺口。协助 crops 与 brain 检查 1800 后的计划能执行干预和独立扫描。各任务负责人签收回执并提交。',
}
const eightRoleDuties: Partial<Record<Specialist, string>> = {
  water: '主责 T1 水质与保存研究、T4 诊断与处置及正式提交。与 service 协商检测和冷链排程，将可引用的实测证据与模型交给 analyst。',
  engineer: '主责共享设备排程、供电供水与维护。用 experiment_plan(action=portfolio) 联查多个服务的运输、返桩、接收位置与清洗窗口，核对实际作业回执。服务计划和承诺由 service 统一登记。',
  agronomist: '主责 T3 能源预测和正式提交。先提交当前证据已支持的版本，收到 service 的已接纳承诺及证据后按回执修订。',
}

/** Public opening responsibilities for a specialist in the fixed team. */
export function teamDeliveryBrief(role: Specialist | ExtraSpecialist, teamSize = 6, workflow?: StageProfile['researchWorkflow']): string {
  if (workflow === 'delivery-v2') {
    const first = {water:'从本局源水测量做起，与 service 核对同一原始母样的体积和寿命，供 T1/T4/T5 与服务复用。',service:'现在读 service_review 的三项委托，请 water 与 engineer 共同安排实际采样、仪器和运输，先登记可行计划。',
      engineer:'保持能源建模，并用 service_review 将第一条实际路线阻塞交给 service。',crops:'用公开实测选小试株对，及时交给 brain，同时安排自己的 T2 干预和封存后的全周期养护。',
      agronomist:'从已登记能源模型和遥测出发提交 T3，看到真实服务承诺再修订。',analyst:'先形成可执行的 T5 模型，向 water 和 agronomist 索取所需的真实证据。',
      verifier:'对具体拒件和证据缺口复核，读实际草稿。用 check_submit 修订后以 acceptedTick 签收。'}
    const duty = teamSize === 6 && role === 'engineer' ? `${first.service} 同时管理设备和能源。` : teamSize === 6 && role === 'water'
      ? '从本局源水测量做起，与 engineer 核对同一原始母样的体积和寿命，供 T1/T4/T5 与服务复用。' : first[role]
    return `${duty} 科研写入的回执可附 follow_up，Host 按事件汇合到原岗位。只读本次 call_id 或 research_changes 的新增事项，静态契约需要全文时 refresh=true。`
  }
  const override = teamSize === 8 && role !== 'service' && role !== 'verifier' ? eightRoleDuties[role] : undefined
  return `${override ?? deliveryDuties[role]} 收到开局通知即可推进本岗的独立工作。用 round_receipts 确认实际接纳。交接用 mars_send 的 handoff 和 request_key，填任务槽位与实际 ID，在 text 写接收者的下一步，截止由宿主附上。共享资源冲突时先查实时占用再协调。`
}

const legacyDelivery = new Set(['deliverable_check', 'deliverable_submit', 'deliverable_status', 'duty_status', 'board'])
/** Same model-visible capabilities for every role and for Single. Host creation remains separate. */
export function roleTools(stages?: StageProfile): string[] {
  const workflow = stages?.researchWorkflow ? ['research_draft', 'service_review', ...(stages.researchWorkflow === 'delivery-v2' ? ['receipt_work','research_changes'] : [])] : []
  const pilot = isChoiceTrial(stages?.jointTrial) ? ['trial_pilot'] : []
  return [...new Set([...SINGLE_TOOLS.filter(name => !legacyDelivery.has(name)), ...V06_TOOLS, ...V05_PLAN_TOOLS, ...workflow, ...pilot, 'round_receipts'])]
    .filter(name => !HIDDEN_TOOLS.includes(name))
}
/** Include all duties in Single; legacy runtime names remain stable for messages and recovery. */
export function charter(role: TeamRole | ExtraSpecialist | 'single', stages: StageProfile, decisionTicks: number,
  scientific = false, teamSize = 6): string {
  const label = role === 'single' || role === 'service' || role === 'verifier' ? role : LEGACY_ROLE_MAP[role]
  const extra = teamSize === 8 ? ['统筹三项固定服务的测量、母样留存和前瞻承诺。', '安排独立复测和公开模型自检，并核对封存后的验证作业。'] : []
  let duties: string
  if (role === 'single') duties = [...Object.values(ROLE_DUTIES), ...extra].join('\n')
  else if (role === 'service' || role === 'verifier') duties = deliveryDuties[role]
  else if (role === 'brain' && teamSize === 8) duties = `${ROLE_DUTIES.director} service 统一负责三份服务计划、承诺、测量和原母样留存。engineer 联查设备排程，agronomist 汇总承诺并提交 T3。verifier 核对 T1/T2 的实际证据与接纳回执。`
  else duties = ROLE_DUTIES[LEGACY_ROLE_MAP[role]]
  return `火星基地v0.6。共享世界，时间窗${stages.horizon} tick，每轮${decisionTicks} tick。\n` +
    `${role === 'single' ? '你是唯一持久研究者，兼任全部岗位，可管理多个在途实验。' : `固定岗位 ${label}。团队编制 ${teamSize} 人。`}\n${duties}\n` +
    '三项委托为可信供水、作物改进和多项目研究交付。用research_catalog读取公开验收规则，不要求唯一SOP。\n' +
    '全部合法科研工具、机器人与物理能力对所有岗位开放。角色是默认职责，可以直接交换证据和协商。不能创建额外成员。\n' +
    (stages.researchWorkflow === 'delivery-v2' ? '科研写入支持 follow_up={task,next,backup,beforeTick}；真实回执会交给负责人。用 receipt_work 交接，research_changes 按上次游标读新增事项，round_receipts 可按 call_id 读取。用 research_submit(action=check_submit) 按 kind 选择引用并当窗提交。静态契约已读时用 refresh=true 取全文。\n' : '') +
    (stages.researchWorkflow ? '用 research_draft 保存或接手同一任务槽位的已检查草稿。verifier 收到 Host 的拒件邮件后读取草稿、按版本修订并确认接纳。用 service_review 核对整组路线，工程、服务或 Single 依据第一条阻塞修订。把返回的 reviewId 写入对应 T3 服务承诺。\n' : '') +
    (stages.jointTrial === sharedPlanVersion ? 'T2 和 T6 的 final 可选同一全基地计划的 stepIds。先确定受控舱，整组安排维持性灌溉、处理、复测与供电。\n' : '') +
    (isChoiceTrial(stages.jointTrial) ? `T6 需要在 ${stages.baselineTick} 前封存双方案小试，在 ${stages.finalTick} 前用四条真实扫描、源水和全基地 energy.demand 分析封存另一对舱的选择。用 research_catalog(section=interfaces,task_id=T6) 查声明格式。\n` : '') +
    `初期成果于${stages.baselineTick}封存${isChoiceTrial(stages.jointTrial) ? '，含 T6 小试预注册' : '，仅作诊断'}；最终成果于${stages.finalTick}封存。之后停止模型请求，已接纳物理作业继续。\n` +
    '具体处置的前瞻预测必须在动作前锁定，允许先保全再诊断。消息数、角色数和操作次数不直接得分。\n' +
    (scientific ? '当前为科学候选配置。任务、证据、容差、费用和截止可查；尚未冻结为正式排名协议。修改工具先返回pending，统一边界接纳后用round_receipts读取结果。'
      : '当前入口为协议验证阶段，尚未安装科学评分、E1/E2和费用预算，不能用于正式比较。')
}
