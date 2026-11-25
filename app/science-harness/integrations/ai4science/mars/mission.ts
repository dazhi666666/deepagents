/** Complete public mission for the v0.4 benchmark. Hidden truth, event times and fault schedules are never included. */
import { BLOCK_TOTALS, LOAD_TASKS, publicTasks, TASKS } from './deliverables.ts'
import { TEAM, type TeamRole } from './team.ts'

const DEADLINE_FACTOR: Record<string, number> = { L1: 1, L2: 1, L3: 0.75, L4: 0.6 }
/** Mission horizon per load (truth.py HORIZONS): L1/L2 end after their last event, L3/L4 keep E11 and E13. */
export const HORIZONS: Record<string, number> = { L1: 1920, L2: 1920, L3: 2400, L4: 2400 }
export const horizonFor = (load: string) => HORIZONS[load] ?? 2400

/** Task weights rescaled so each block (D 20, R 30, X 10) keeps its total at every load level. */
export function taskWeights(load: string): Record<string, number> {
  const tasks = LOAD_TASKS[load]!
  const totals: Record<string, number> = {}
  for (const id of tasks) totals[TASKS[id].block] = (totals[TASKS[id].block] ?? 0) + TASKS[id].weight
  return Object.fromEntries(tasks.map(id => [id, TASKS[id].weight * BLOCK_TOTALS[TASKS[id].block] / totals[TASKS[id].block]!]))
}
export const tasksForLoad = (load: string) => LOAD_TASKS[load]!
export const deadlineFactor = (load: string) => DEADLINE_FACTOR[load]!

/** A specialist of the fixed team, whose mission view defaults to the tasks it owns; the brain and the single agent see all. */
const specialist = (role: string | undefined): Exclude<TeamRole, 'brain'> | null =>
  role && role !== 'brain' && role in TEAM ? role as Exclude<TeamRole, 'brain'> : null

/** Mission delivered once to the root Agent and readable through mission_read.
 * @param load Load level.
 * @param role Reader's role; specialists get their domain view unless `full` is set.
 * @param full Whether to return every task rather than the reader's domain.
 * @param tick Current logical tick, used to publish the open duty windows.
 * @param horizon Mission horizon in ticks (the world's, from the hidden truth).
 */
export function createMission(load = 'L2', role?: string, full = true, tick = 0, horizon = horizonFor(load)) {
  const weights = taskWeights(load)
  const owner = specialist(role)
  const visible = tasksForLoad(load).filter(id => full || !owner || TEAM[owner].tasks.includes(id))
  return {
    version: 5, benchmark: 'mars-base-v0.4', load, title: '火星基地联合运营与科研行动',
    view: full || !owner ? 'full' : `${TEAM[owner].title}（只含本岗负责的任务；mission_read(full=true) 返回全文）`,
    situation: `基地有 4 个温室舱（每舱 4 个品种各 1 株，共 16 株作物）、水循环、太阳能与电池、舱内大气、共享实验室、3 台机器人和仓储。与地球通信已中断，不会有任何外部帮助。任务时间窗为 ${horizon} 个逻辑步（${horizon / 96} 个火星日，1 sol = 96 步，日照约占半个 sol）；第 ${horizon} 步之后不再有观测和操作，X3 要提交的是那之后 500 步的运行方案。`,
    instructions: '在整个时间窗内保持基地安全运转：按时完成值班（D），推进科研战役（W 水、G 温室、F 设施、A 档案），完成跨领域集成任务（X），并处置突发事件。各项工作的做法见岗位章程里的 SOP。思考与行动都会消耗时间：每开始一步新的决策，世界至少前进若干步。',
    scoring: {
      total: `S = O(15) + D(20) + C(20) + R(30) + X(10) + Q(5)，到 ${horizon} 步统一结算。`,
      operations: { crops: '15/22 × 12 × 各株健康分均值；损失为 0，否则 1 - 0.5 × min(1, 累计受压步/耐受步)。受压：水分、温度、气压 < 60 kPa、污染水灌溉。', energy: `15/22 × 3 × (1 - 一级负载（4 个温室舱温控、cold-1、cold-2、freezer、R2 保温箱）被切断的步数 / ${horizon})`,
        water: `15/22 × 3 × (1 - 水路不可用或水箱 < 300 µL 的步数 / ${horizon})`, atmosphere: '15/22 × 2 × 各舱气压 ≥ 65 kPa 且 CO2 在 400–1500 ppm 的步数比例均值', samples: '15/22 × 2 × (1 - 样品不安全保存步 / 样品总步)' },
      duties: 'D：每个值班时段单独计分（证据有效率 × 准确度），时段内没有通过检查的提交记 0，不追溯。每个任务的 dutyWindows 给出全部时段及其起止步；时段外提交会被拒绝并在回执里给出下一个可提交窗口。D1 水质 7、D2 巡检 7、D3 能源 6，按全部时段平均。',
      crises: '20 分平均分给本档全部突发事件；每个事件按 发现速度、损失遏制、恢复速度、处置是否正确 四项计分。用 incident_report 报告你发现的异常（引用受影响对象，选择 event_class 并给出 root_cause），处置动作也计为发现；"正确"一项中一半来自根因报告。',
      research: { formula: '每个里程碑 r = d × (0.4 × 进度 + 0.6 × 证据有效率 × 准确度)；数值答案写成 {est, lo, hi}（90% 区间），准确度 = 0.7 × 误差项 + 0.3 × 区间分数。', deadline: '截止因子 d 按首次通过公开检查的提交计算，超时线性降到 0.5；之后的修正提交只更新答案，不重新计时。从未提交只得 0.2 × 进度。', weights },
      quality: 'Q = 2 × 分析可复现（结算时重跑你引用的 analysis_run，输出须包含提交的数值）+ 2 × 资源效率 + 1 × 独立复核（数值答案由两份代码不同的 analysis_run 各自得出）。被拒提交不扣分；先用 deliverable_check 免费预检。',
      conclusionCorrectness: '结论的正确性按隐藏真值评分，运行中不会透露对错。',
    },
    tasks: publicTasks(visible, DEADLINE_FACTOR[load]!, weights, load, horizon, tick),
    references: '证据和工具参数可使用短引用：结果 r-12、样品 s-30、实验室操作 op-8、系统操作 so-5、产物 ar-4、分析运行 a-0017、档案查询 q-0042；工具输出里的 *Ref 字段给出对应短引用。',
    priors: { waterDocMgL: '2–6', filterRemoval: '0.5–0.9', lightOpt: '40–90', lightWidth: '20–50', irrigationOpt: '30–120 µL/100 步', co2HalfSaturation: '200–800 ppm',
      dustRatePerTick: '0.0001–0.001', batteryCapacity: '标称 800，实际可能更低', driftRate: '0.02–0.05 /步', pathogenLambda: '0.0005–0.005 /步', confirmV1Bias: '未公布' },
    physics: {
      growth: '生长率随光照、营养、灌溉、CO2、温度变化；可观测的平滑生长率以 20 步时间常数趋近新稳态。灯光高于 70 时舱温每单位升高 0.03°C。',
      water: 'DOC 随保存温度一阶降解（常温远快于冷藏）。confirm 色谱需扣基线并拆分 5.1 分钟 DOC 峰与可能出现的 5.4 分钟干扰峰；仪器摘要值按旧窗口积分，仅供参考。灌溉水（pump 出口）DOC 超过 2.5 会让作物受压；在线报警阈值 reservoir 7、filter 2.5、pump 2.5（reservoir 原水本身 DOC 较高）。在线 DOC 传感器可能失真。水路模块的 device_reference 给出参考探头读数。维修后的设备处于待清洗状态，水路模块未清洗时水路不可用。水回收每步 12 µL（filter 与 pump 正常且有电时）；备用净水罐 800 µL 不可再生。',
      energy: '太阳能峰值约 45、随积尘衰减、沙尘暴期间大幅下降（遥测 energy.tau_dust 会提前上升）；电池充放电上限每步 20。需求超过供给时按限电优先级表从前往后切断负载，默认表按设备 ID 字母序。',
      pathogen: '病害潜伏约 60 步（仅高光谱第 6/4 波段可见），之后显症约 200 步并最终致死；同舱、相邻舱共用灌溉回路以及运送过病株样品的未消毒机器人都会传播。',
      spares: '维修与预防维护消耗对应备件；修错对象同样消耗备件。补给穿梭整个时间窗只有一次，到货需 120 步。',
    },
    dataSources: { current: 'mars_observe（传感器读数，可能漂移）、telemetry_query（全通道遥测）、mars_catalog', historical: 'archive_search、archive_query、archive_sql（只读 SQL）',
      analysis: 'analysis_run：在隔离的 Node 进程中运行你写的 JavaScript/TypeScript 异步函数体，可用 readArtifact(id)、telemetry(channels, from, to)、archiveSql(sql)；返回值即输出。', records: 'note_read、note_write、note_edit' },
    operatingRules: { horizon, solTicks: 96, assistance: 'none' },
  }
}
