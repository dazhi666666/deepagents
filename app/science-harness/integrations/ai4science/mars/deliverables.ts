/** v0.3 deliverables: duties (D), research campaign milestones (W/G/F/A), integration tasks (X).
 * Answer schemas, public deadlines, cadences and the minimum evidence agents see (spec v0.3, docs/实验任务重设计v0.3.md).
 */
import { z } from 'zod'
import { CHAMBERS, CROP_IDS } from './truth.ts'

const estimate = z.object({ est: z.number().finite(), lo: z.number().finite(), hi: z.number().finite() }).strict()
  .refine(value => value.lo <= value.est && value.est <= value.hi, 'Require lo <= est <= hi (a 90% interval)')
const varietyKey = z.enum(['variety-1', 'variety-2', 'variety-3', 'variety-4'])
const crop = z.enum(CROP_IDS as [string, ...string[]])
const chamber = z.enum(CHAMBERS)
const sensorState = z.enum(['ok', 'faulty'])
const wearDevices = ['confirm', 'imager', 'centrifuge-1', 'centrifuge-2', 'heater-1'] as const
const value = z.object({ value: z.number().finite() }).strict()

export const answerSchemas = {
  D1: z.object({ reservoir: estimate, filter: estimate, pump: estimate,
    sensors: z.object({ reservoir: sensorState, filter: sensorState, pump: sensorState }).strict() }).strict(),
  D2: z.object({ crops: z.record(crop, z.enum(['healthy', 'stressed', 'infected', 'lost'])), latent: z.array(crop).default([]) }).strict(),
  D3: z.object({ energy: estimate, minSoc: estimate }).strict(),
  W1: z.object({ reservoir: estimate, filter: estimate, pump: estimate, removal: estimate }).strict(),
  W2: z.object({ k4: estimate, kMinus10: estimate, k22: estimate }).strict(),
  W3: z.object({ confirmV1Bias: estimate, extractionA2Bias: estimate, recalledLot: z.string(), affectedDeliverables: z.array(z.enum(['W1', 'W2', 'W4'])) }).strict(),
  W4: z.object({ hypotheses: z.array(z.enum(['inlet', 'membrane', 'seal'])).min(1), increaseAtPump: estimate, lubricantPresent: z.boolean(),
    faultySensor: z.enum(['reservoir', 'filter', 'pump', 'none']) }).strict(),
  G1: z.record(crop, estimate),
  G2: z.record(varietyKey, z.object({ lightOpt: estimate, width: estimate }).strict()),
  G3: z.object({ nutrient: z.union([z.literal(1), z.literal(2), z.literal(3)]), irrigation: z.number().min(30).max(120), co2: z.number().min(400).max(1500), predictedGrowth: estimate }).strict(),
  G4: z.object({ indexCase: crop, lambda: estimate }).strict(),
  F1: z.object({ dustRate: estimate, batteryCapacity: estimate, peakOutput: estimate }).strict(),
  F2: z.object({ remainingUses: z.record(z.enum(wearDevices), estimate) }).strict(),
  F3: z.object({ sensors: z.array(z.object({ chamber, channel: z.enum(['temperature', 'moisture']), rate: estimate }).strict()) }).strict(),
  A1: value, A2: z.object({ value: z.number().int() }).strict(), A3: value, A4: z.record(varietyKey, z.number()), A5: z.record(z.string(), z.number()),
  A6: value, A7: value, A8: value,
  X1: z.object({ stressTicks: z.record(varietyKey, estimate), cleanAfterTicks: estimate }).strict(),
  X2: z.object({ targetSoc: z.number().min(0).max(100), powerPriority: z.array(z.string()).min(1), chamberLight: z.record(chamber, z.number().min(0).max(100)) }).strict(),
  X3: z.object({ chambers: z.record(chamber, z.object({ light: z.number().min(0).max(100), nutrient: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    co2: z.number().min(400).max(1500), temperature: z.number().min(16).max(28) }).strict()),
    irrigation: z.record(crop, z.number().min(0).max(200)), waterSource: z.enum(['main', 'reserve']),
    powerPriority: z.array(z.string()), panelCleanEveryTicks: z.number().int().min(0), sampleStorage: z.enum(['cold', 'freezer']) }).strict(),
} as const
export type TaskId = keyof typeof answerSchemas
export const TASK_IDS = Object.keys(answerSchemas) as TaskId[]
export const DUTY_IDS = ['D1', 'D2', 'D3'] as const
export type DutyId = typeof DUTY_IDS[number]
export const isDuty = (id: string): id is DutyId => (DUTY_IDS as readonly string[]).includes(id)
export const ARCHIVE_IDS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'] as const
export const WEAR_TASK_DEVICES = wearDevices

/** Evidence: short refs (r-12, s-30, op-8, a-0017, q-0042) or full IDs. */
export const evidenceSchema = z.object({ resultIds: z.array(z.string()).default([]), artifactIds: z.array(z.string()).default([]),
  operationIds: z.array(z.string()).default([]), archiveQueryIds: z.array(z.string()).default([]), analysisRunIds: z.array(z.string()).default([]) }).strict()
export type Evidence = z.infer<typeof evidenceSchema>

export type Block = 'D' | 'R' | 'X'
type Deadline = number | { after: string; ticks: number } | null
export interface TaskSpec { block: Block; campaign: string; title: string; weight: number; deadline: Deadline; question: string; minimumEvidence: string }

const archive = (question: string, title: string): TaskSpec => ({ block: 'R', campaign: 'A', title, weight: 0.625, deadline: 1200, question, minimumEvidence: '至少 1 个档案查询或分析运行 ID。' })

export const TASKS: Record<TaskId, TaskSpec> = {
  D1: { block: 'D', campaign: 'D', title: '水质日报', weight: 7, deadline: null,
    question: '每个值班时段提交一次：本时段中点时刻 reservoir、filter、pump 三处的真实 DOC (mg/L)，以及三处在线 DOC 传感器状态（ok / faulty）。三个数值各自独立评分，任何一个缺测都按 0 计——没有取到样的模块用在线读数（可能被漂移或干扰项污染）配合已有参考测量作答即可。时段由提交时刻决定（各时段起止见本任务的 dutyWindows），同一时段以最后一次通过检查的提交为准。',
    minimumEvidence: '证据只需一条：本时段或上一时段内取样的 1 条水样 confirm 结果，或本时段内完成的 1 次水路模块 device_reference。不要求三条水路都有证据。' },
  D2: { block: 'D', campaign: 'D', title: '作物巡检', weight: 7, deadline: null,
    question: '每个值班时段提交一次：16 株作物在本时段结束时的状态（healthy / stressed / infected / lost；infected 含潜伏期），以及疑似潜伏感染名单 latent。',
    minimumEvidence: '本时段内完成的 4 个舱各至少 1 次 greenhouse_scan（引用其操作 ID，so-N）。' },
  D3: { block: 'D', campaign: 'D', title: '能源调度', weight: 6, deadline: null,
    question: '每个 sol 提交一次预报：该 sol 的太阳能发电总量 energy 与电池最低电量 minSoc（与 telemetry energy.soc 同单位）。时段以要预报的 sol 编号（= dutyWindows 里的 slot）为准，从前一个 sol 的中点开到本 sol 的中点：sol 3 的时段是第 240–335 步，因此时段开启时 mars_observe 报的 sol 还停在 2。时间线上每一步都落在某个时段内，随时可提交；越晚提交看到的越多，但关闭后不可补交。该 sol 内一级负载未被切断另计分。',
    minimumEvidence: '提交前 120 步内运行的至少 1 个 analysis_run。' },
  W1: { block: 'R', campaign: 'W', title: '水路基线浓度', weight: 2, deadline: 1000, question: '污染发生前 reservoir、filter、pump 三处出水的真实 DOC 浓度 (mg/L) 与过滤去除率 removal。', minimumEvidence: '三处各至少 1 条 confirm 结果，至少 1 个处理色谱原始数据的 analysis_run。' },
  W2: { block: 'R', campaign: 'W', title: '样品降解动力学', weight: 3, deadline: 1800,
    question: '水样 DOC 在 4°C、-10°C、22°C 下的一阶降解速率常数（每步）。同一母样分装到三种温度保存，按时间序列测量（建议取样后 +0、+24、+48、+96、+192 步各测一次），拟合时用各测点的实际时间。',
    minimumEvidence: '同一母样的 confirm 结果至少 8 条，覆盖至少 4 个不同测量时刻（以 confirm 开始处理的时刻计，彼此相隔 ≥20 步），首末时刻相隔 ≥150 步。' },
  W3: { block: 'R', campaign: 'W', title: '偏差与影响追溯', weight: 2, deadline: { after: 'confirm 方法更新', ticks: 400 }, question: 'confirm v1 的乘性偏差、被召回子批的乘性偏差、被召回子批的批号，以及受影响的本方交付（W1/W2/W4）。', minimumEvidence: '至少 4 条 confirm 结果。' },
  W4: { block: 'R', campaign: 'W', title: '污染溯源', weight: 2, deadline: { after: '水路污染开始', ticks: 300 }, question: '污染假设（inlet/membrane/seal，可能多个）、泵出口 DOC 增量、是否存在润滑剂峰、哪个在线传感器读数是假的（无则 none）。', minimumEvidence: '三处各至少 1 条 confirm 结果，至少 1 个处理色谱的 analysis_run。' },
  G1: { block: 'R', campaign: 'G', title: '作物生长基线', weight: 2, deadline: 700, question: '16 株作物在基线条件（光照 70、营养 1、灌溉 75 µL/100 步、CO2 800 ppm、品种最适温度）下的稳态生长率。', minimumEvidence: '至少 10 株不同作物在基线条件（光照 70、营养 1、CO2 800，已保持 ≥48 步）下的生长观测（greenhouse_scan 操作或实验室 image 结果）。' },
  G2: { block: 'R', campaign: 'G', title: '光照响应', weight: 3, deadline: 1500,
    question: '四个品种各自的最适光照 lightOpt 与响应宽度 width（生长率 ∝ exp(-((L-lightOpt)/width)^2)）。舱内光照需保持不变至少 48 步后的观测才计入证据（生长率以 20 步时间常数趋近稳态）。',
    minimumEvidence: '至少 8 条生长观测（image 结果或 scan 操作），取样前该舱光照已保持 ≥48 步，覆盖至少 3 个不同光照设定。' },
  G3: { block: 'R', campaign: 'G', title: '营养 × 灌溉 × CO2 优化', weight: 3, deadline: 1900,
    question: '品种 2 的最佳营养档、灌溉量 (µL/100 步) 与 CO2 设定，以及该设定下的预测生长率。处理（营养、CO2、光照）需保持不变至少 48 步后的观测才计入证据。',
    minimumEvidence: '至少 5 条品种 2 的生长观测，取样前处理已保持 ≥48 步，覆盖至少 3 种不同处理组合。' },
  G4: { block: 'R', campaign: 'G', title: '病害参数', weight: 1, deadline: { after: '病害指示病例感染', ticks: 400 }, question: '病害指示病例与每步传播率 lambda。', minimumEvidence: '至少 8 株作物有高光谱或病原检测证据。' },
  F1: { block: 'R', campaign: 'F', title: '能源系统辨识', weight: 2, deadline: 1600, question: '面板积尘衰减率（每步）、电池实际容量、清洁面板峰值功率。', minimumEvidence: '至少 2 个 analysis_run。' },
  F2: { block: 'R', campaign: 'F', title: '预测性维护', weight: 3, deadline: 1400,
    question: 'confirm、imager、centrifuge-1、centrifuge-2、heater-1 在提交时刻还能运行多少次（剩余使用次数）。分 {F2N} 个窗口计分：{F2}，每个窗口以其中最后一次提交为准；首次提交之后缺少更新的窗口记 0。',
    minimumEvidence: '至少 1 个 analysis_run。' },
  F3: { block: 'R', campaign: 'F', title: '传感器漂移估计', weight: 2, deadline: { after: '传感器漂移开始', ticks: 400 }, question: '发生漂移的舱室传感器（舱 + temperature/moisture）及其漂移速率（读数-真值 每步）。', minimumEvidence: '至少 3 次 device_reference 参考测量。' },
  A1: archive('历史 filter 去除率中位数。', '档案 A1'),
  A2: archive('cold-1 超温事件次数（>8°C 连续≥3 条，旧记录为华氏度）。', '档案 A2'),
  A3: archive('confirm 校准后 100 步内相对参考样偏差均值。', '档案 A3'),
  A4: archive('各品种历史最佳光照档（键 variety-1..4）。', '档案 A4'),
  A5: archive('各 extraction 批号历史不合格比例（键为批号）。', '档案 A5'),
  A6: archive('时钟迁移前生命支持 CO2 平均流量 (L/sol)。', '档案 A6'),
  A7: archive('离心机振动 RMS 首次超过 2.0 到故障的平均步数。', '档案 A7'),
  A8: archive('以往水污染事故中泵封泄漏所占比例（以最终复盘为准）。', '档案 A8'),
  X1: { block: 'X', campaign: 'X', title: '污染影响评估', weight: 3, deadline: { after: '水路污染开始', ticks: 500 },
    question: '水路污染开始后，各品种（4 株合计）因灌溉污染水而受压的累计步数 stressTicks，以及从污染开始到全部污染源修复（灌溉水恢复洁净）经过的步数 cleanAfterTicks。',
    minimumEvidence: '至少 1 条水样 confirm 结果，以及至少 1 个 analysis_run。' },
  X2: { block: 'X', campaign: 'X', title: '沙尘暴预案', weight: 2, deadline: { after: '沙尘暴开始', ticks: 0 },
    question: '在沙尘暴到来前提交：暴前电池目标电量 targetSoc（容量百分比）、限电优先级表 powerPriority（先切断者在前）、暴风期间各舱光照 chamberLight。评测器用真实沙尘暴参数模拟整个暴风期。',
    minimumEvidence: '至少 1 个 analysis_run（例如读取 energy.tau_dust 等遥测）。' },
  X3: { block: 'X', campaign: 'X', title: '下一阶段运行方案', weight: 5, deadline: 2400,
    question: '为时间窗结束后的 500 步制定运行方案：各舱光照/营养/CO2/温度、每株灌溉量 (µL/100 步)、水源、限电优先级、面板清洁周期、样品保存方式。评测器用真实模型从结束时刻的状态起模拟这 500 步。方案在时间窗内任何时刻都可提交，越晚提交越接近结束状态，方案针对的是第 {H} 步之后的 500 步，不是结算前的剩余时间。',
    minimumEvidence: '至少 1 条本方生长观测证据。' },
}

/** Task sets per load level. */
export const LOAD_TASKS: Record<string, TaskId[]> = {
  L1: ['D1', 'D2', 'W1', 'W2', 'G1', 'G2', 'F1', 'X3'],
  L2: TASK_IDS, L3: TASK_IDS, L4: TASK_IDS,
}
export const BLOCK_TOTALS: Record<Block, number> = { D: 20, R: 30, X: 10 }

/** Duty slot length in ticks for a load level. */
export function dutyPeriod(task: DutyId, load: string) {
  if (task === 'D1') return load === 'L4' ? 48 : 96
  if (task === 'D2') return load === 'L3' || load === 'L4' ? 48 : 96
  return 96
}
export const D3_LEAD = 48
/** Ticks accepted for one duty slot as `[from, to)`. D3 opens half a sol before its sol so the answer is a
 * forecast, and the last window swallows the rest of the horizon, so the windows tile it exactly.
 */
export function dutyWindow(task: DutyId, load: string, slot: number, horizon: number): [number, number] {
  if (task === 'D3') return [Math.max(0, slot * 96 - D3_LEAD), slot === dutySlots(task, load, horizon) - 1 ? horizon : slot * 96 + D3_LEAD]
  const period = dutyPeriod(task, load)
  return [slot * period, (slot + 1) * period]
}
/** Slot a duty submission at a tick counts for, or null when it falls outside the horizon. */
export function dutySlot(task: DutyId, load: string, tick: number, horizon: number) {
  if (tick < 0 || tick >= horizon) return null
  if (task !== 'D3') return Math.floor(tick / dutyPeriod(task, load))
  // One window per sol, opened half a sol early: a tick in the sol's first half belongs to the coming sol,
  // a tick in its second half to the next one. The last window absorbs whatever remains of the horizon.
  return Math.min(Math.floor((tick + D3_LEAD) / 96), dutySlots(task, load, horizon) - 1)
}
export const dutySlots = (task: DutyId, load: string, horizon: number) => Math.ceil(horizon / dutyPeriod(task, load))
/** One slot of one duty, as reported to Agents: its tick range, whether it is still open and when it closes. */
export function dutySchedule(task: DutyId, load: string, horizon: number, tick: number) {
  return Array.from({ length: dutySlots(task, load, horizon) }, (_, slot) => {
    const [from, to] = dutyWindow(task, load, slot, horizon)
    return { slot, from, to, open: tick >= from && tick < to, closed: tick >= to }
  })
}
/** The first window that has not closed at `tick`, so a rejection can name where the next submission counts. */
export function nextDutyWindow(task: DutyId, load: string, horizon: number, tick: number) {
  for (let slot = 0; slot < dutySlots(task, load, horizon); slot++) {
    const [from, to] = dutyWindow(task, load, slot, horizon)
    if (tick < to) return { slot, from, to }
  }
  return null
}

/** Absolute deadline for a task given hidden event onsets (evaluator only); no deadline falls after the horizon. */
export function deadlineOf(task: TaskId, factor: number, onsets: Record<string, number>, horizon: number) {
  const spec = TASKS[task].deadline
  if (spec === null || task === 'X3') return horizon
  if (typeof spec === 'number') return Math.min(horizon, Math.round(spec * factor))
  const anchor = { '水路污染开始': onsets.E3, '传感器漂移开始': onsets.E4, 'confirm 方法更新': onsets.E6, '病害指示病例感染': onsets.E10, '沙尘暴开始': onsets.E1 }[spec.after]
  if (anchor === undefined) return horizon
  return Math.min(horizon, Math.round(anchor + spec.ticks * factor))
}

/** F2 scoring windows: each ends at the tick listed, the last at the horizon. */
export function f2Windows(horizon: number) { return [...[1400, 1800, 2200].filter(end => end < horizon), Infinity] }
const f2Text = (horizon: number) => f2Windows(horizon).map((end, index, all) => {
  const start = index === 0 ? null : all[index - 1]! + 1, stop = end === Infinity ? horizon : end
  return start === null ? `≤${stop}` : `${start}–${stop}`
}).join('、')
/** A task question with the horizon-dependent parts filled in. */
const questionOf = (id: TaskId, horizon: number) => TASKS[id].question
  .replaceAll('{H}', String(horizon)).replaceAll('{F2N}', String(f2Windows(horizon).length)).replaceAll('{F2}', f2Text(horizon))

/** Public mission view of tasks for one load level (deadlines are scaled; event-relative ones stay relative). */
export function publicTasks(tasks: TaskId[], factor: number, weights: Record<string, number>, load: string, horizon: number, tick: number) {
  return tasks.map(id => {
    const spec = TASKS[id]
    const deadline = spec.deadline === null ? (id === 'D3' ? '每个 sol' : `每 ${dutyPeriod(id as DutyId, load)} 步一个值班时段`)
      : id === 'X3' ? `结束时刻 ${horizon}` : typeof spec.deadline === 'number' ? `第 ${Math.min(horizon, Math.round(spec.deadline * factor))} 步`
        : spec.deadline.ticks === 0 ? `${spec.deadline.after}之前` : `${spec.deadline.after}后 ${Math.round(spec.deadline.ticks * factor)} 步`
    const duty = isDuty(id) ? dutySchedule(id, load, horizon, tick) : undefined
    return { id, block: spec.block, campaign: spec.campaign, title: spec.title, weight: Number((weights[id] ?? 0).toFixed(3)), deadline,
      question: questionOf(id, horizon), minimumEvidence: spec.minimumEvidence, answerSchema: z.toJSONSchema(answerSchemas[id], { io: 'input' }),
      ...(duty ? { dutyPeriod: dutyPeriod(id as DutyId, load), dutyWindows: duty.map(window => ({ slot: window.slot, from: window.from, to: window.to })) } : {}) }
  })
}
