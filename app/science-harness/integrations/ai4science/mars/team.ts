/** v0.4 fixed team (docs/实验任务重设计v0.4.md, chapter 4): roles, tools, robots, charters with task SOPs, alert routing
 * and duty owners. The multi-agent arm runs exactly these six members, created by the runtime at mission start; the
 * single agent holds every tool and every charter merged into one playbook. Both arms get the same SOP text.
 */
import type { DutyId, TaskId } from './deliverables.ts'

export const SPECIALISTS = ['water', 'crops', 'agronomist', 'engineer', 'analyst'] as const
export type Specialist = typeof SPECIALISTS[number]
export type TeamRole = 'brain' | Specialist

const BASE_TOOLS = ['mission_read', 'task_create', 'task_update', 'task_list', 'note_write', 'note_read', 'note_edit', 'mars_message', 'mars_inbox', 'deliverable_check', 'deliverable_submit',
  'deliverable_status', 'incident_report', 'analysis_run', 'telemetry_query', 'artifact_read', 'mars_observe', 'mars_catalog', 'mars_result',
  'mars_wait', 'duty_status', 'board']
const ARCHIVE_TOOLS = ['archive_search', 'archive_query', 'archive_stats', 'archive_sql', 'archive_schema']
const QUERY_TOOLS = ['mars_samples', 'mars_measurements', 'mars_history', 'robot_status']
const ROBOT_TOOLS = ['sample_transfer', 'robot_move', 'robot_charge', 'robot_sanitize']
const PHYSICAL: Record<Specialist, string[]> = {
  water: ['water_assay', 'water_split', 'water_sample', 'water_screen', 'water_prepare', 'water_confirm', 'sample_aliquot', ...ROBOT_TOOLS],
  crops: ['greenhouse_irrigate', 'greenhouse_scan', 'crop_remove', 'chamber_quarantine'],
  agronomist: ['greenhouse_scan', 'greenhouse_light', 'greenhouse_nutrient', 'greenhouse_co2', 'crop_sample', 'culture_batch', 'greenhouse_image',
    'greenhouse_separate', 'greenhouse_extract', 'pathogen_confirm', 'sample_aliquot', ...ROBOT_TOOLS],
  engineer: ['device_diagnose', 'device_clean', 'device_calibrate', 'device_repair', 'device_configure', 'device_service', 'device_reference',
    'sensor_calibrate', 'water_refill', 'water_route', 'power_priority', 'panel_clean', 'seal_inspect', 'seal_repair', 'supply_order', ...ROBOT_TOOLS],
  analyst: [],
}
const STATUS: Record<TeamRole, string[]> = {
  brain: ['water_status', 'greenhouse_status', 'energy_status'], water: ['water_status'], crops: ['greenhouse_status'],
  agronomist: ['greenhouse_status'], engineer: ['energy_status', 'water_status'], analyst: [],
}

/** One member of the fixed team. */
export interface RoleSpec {
  title: string
  /** Scored tasks this member owns; its mission view shows these unless it asks for the full mission. */
  tasks: TaskId[]
  /** Robots this member may drive; the single agent may drive all three. */
  robots: string[]
  /** Physical providers whose actions this member may submit. */
  providers: string[]
  tools: string[]
}
export const TEAM: Record<TeamRole, RoleSpec> = {
  brain: { title: '总调度', tasks: ['X1', 'X2', 'X3'], robots: [], providers: ['water', 'greenhouse', 'facilities'],
    tools: [...BASE_TOOLS, ...ARCHIVE_TOOLS, ...QUERY_TOOLS, ...STATUS.brain, 'org_create'] },
  water: { title: '水务', tasks: ['D1', 'W1', 'W2', 'W3', 'W4'], robots: ['robot-1'], providers: ['water'],
    tools: [...BASE_TOOLS, ...QUERY_TOOLS, ...STATUS.water, ...PHYSICAL.water] },
  crops: { title: '作物', tasks: ['D2'], robots: [], providers: ['greenhouse'],
    tools: [...BASE_TOOLS, ...QUERY_TOOLS, ...STATUS.crops, ...PHYSICAL.crops] },
  agronomist: { title: '农艺', tasks: ['G1', 'G2', 'G3', 'G4'], robots: ['robot-2'], providers: ['greenhouse'],
    tools: [...BASE_TOOLS, ...QUERY_TOOLS, ...STATUS.agronomist, ...PHYSICAL.agronomist] },
  engineer: { title: '工程', tasks: ['D3', 'F1', 'F2', 'F3'], robots: ['robot-3'], providers: ['facilities'],
    tools: [...BASE_TOOLS, ...QUERY_TOOLS, ...STATUS.engineer, ...PHYSICAL.engineer] },
  analyst: { title: '分析', tasks: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'], robots: [], providers: ['water', 'greenhouse', 'facilities'],
    tools: [...BASE_TOOLS, ...ARCHIVE_TOOLS, ...QUERY_TOOLS] },
}
/** Every tool the single agent holds: the union of all roles, without organization tools. */
export const SINGLE_TOOLS = [...new Set([...BASE_TOOLS, ...ARCHIVE_TOOLS, ...QUERY_TOOLS, ...STATUS.brain, ...Object.values(PHYSICAL).flat()])]
export const ALL_ROBOTS = ['robot-1', 'robot-2', 'robot-3']

/** Tools no member may use, denied on every member's tool view (runtime.ts applies the deny layer).
 * The fixed team needs no organization tools; the benchmark scores no hand-written experiment JSON; org_wait and
 * experiment_wait are wall-clock waits that would hold a synchronous decision round open. `org_create` stays in the
 * brain's role policy because the runtime builds the team through it, but the model never sees it.
 */
export const HIDDEN_TOOLS = ['org_create', 'org_discover', 'org_authorize', 'org_revoke', 'org_send_result', 'org_message', 'org_wait', 'org_finish',
  'experiment_create', 'experiment_claim', 'experiment_status', 'experiment_act', 'experiment_wait', 'experiment_escalate',
  'experiment_resolve', 'experiment_finish', 'experiment_cancel', 'mars_submit']

export const DUTY_OWNER: Record<DutyId, Specialist> = { D1: 'water', D2: 'crops', D3: 'engineer' }
/** The team member owning a task (X tasks belong to the brain). */
export function ownerOf(task: TaskId): TeamRole {
  return (Object.entries(TEAM) as [TeamRole, RoleSpec][]).find(([, spec]) => spec.tasks.includes(task))?.[0] ?? 'brain'
}

/** Roles notified of each environment event kind, lead first; the single agent receives every one of them. */
export const ALERT_ROUTES: Record<string, TeamRole[]> = {
  'device-fault': ['engineer', 'brain'], 'power-capacity-changed': ['engineer'], 'supply-arrived': ['engineer'],
  'sample-preservation-failed': ['engineer', 'water', 'agronomist'],
  'method-revised': ['water', 'agronomist', 'analyst'], 'batch-recalled': ['water', 'agronomist', 'analyst'], 'calibration-results-revoked': ['water', 'agronomist'],
  'crop-status-changed': ['crops', 'agronomist'],
  announcement: ['brain', 'water', 'crops', 'agronomist', 'engineer', 'analyst'],
  'battery-low': ['engineer', 'brain'], 'power-shed': ['engineer', 'brain'],
  'inline-doc-alarm': ['water', 'engineer', 'crops'], 'chamber-pressure-low': ['engineer', 'crops'],
}
/** Checklist lines attached to an alert, per role that receives it. */
export const ALERT_GUIDANCE: Record<string, Partial<Record<TeamRole, string>>> = {
  'inline-doc-alarm': {
    water: '水路在线 DOC 超阈值：立即对告警模块 water_assay(confirm) 确证；确证超标后 incident_report(event_class=water-contamination)，并告知工程与作物。注意在线传感器可能是假的（诱饵）。',
    engineer: '水路告警：等水务确证；确证污染后 water_route(target=reserve) 切到备用水源，修复水务判定的模块（不要修诱饵模块）。',
    crops: '水路告警：主回路可能被污染，暂停主回路灌溉，等工程切到备用水源后再浇。',
  },
  'chamber-pressure-low': {
    engineer: '舱压下降：对该舱依次 seal_inspect 门、风道、面板三个点，找到泄漏点后 seal_repair，并 incident_report(event_class=chamber-leak, root_cause=["舱:点"])。',
    crops: '舱压下降：告知工程（mars_message）具体舱号；留意该舱作物受压。',
  },
  'battery-low': { engineer: '电池低：检查限电优先级（作物温控与冷库最后切断），推迟高功耗检测，必要时降光照。', brain: '电池低：确认工程在处理；沙尘暴期间按 X2 预案执行。' },
  'power-shed': { engineer: '一级负载被切断：立即调整 power_priority，把温室舱温控与冷库排到最后。', brain: '一级负载被切断：督促工程调整限电优先级。' },
  'crop-status-changed': {
    crops: '作物状态变化：显症病株考虑 crop_remove，并对该舱 chamber_quarantine；告知农艺给 robot-2 消毒。',
    agronomist: '作物状态变化：暂停跨舱取样，robot_sanitize(robot-2)。',
  },
  'method-revised': { water: 'confirm 方法更新：先请工程校准设备（或自己确认校准有效），再用新版本测量；旧版本结果有偏差，W3 需要新旧配对。', agronomist: 'confirm 方法更新：病原检测也用新版本。', analyst: '方法更新：之后的独立复核注意版本差异。' },
  'batch-recalled': { water: '试剂子批召回：停止使用被召回子批；请分析岗查档案确认是哪一个子批。', agronomist: '试剂子批召回：停止使用被召回子批。', analyst: '试剂子批召回：用档案（lots、lot_qc 表）查出被召回的具体子批号，告知水务与农艺。' },
  'device-fault': { engineer: '设备故障：device_diagnose 后 device_repair（消耗备件），修好后清洗。', brain: '设备故障：确认工程在处理。' },
  'sample-preservation-failed': { engineer: '样品保存失效：维修冷库（cold-1 压缩机）。', water: '冷库故障：把你的水样转到 cold-2 或 freezer。', agronomist: '冷库故障：把你的作物样品转到 cold-2 或 freezer。' },
}

const SOP: Record<TaskId, string> = {
  D1: `D1 水质日报（每个窗口一次，窗口见 duty_status）
1. 窗口开启后立即 water_assay(source_id=<本 sol 轮换模块>, method="confirm", task_id="D1")；轮换顺序 reservoir → filter → pump；有水路告警时改测告警模块。
2. [流程完成] 消息给出该结果的 doc（色谱拟合值）和 calibrationAgeTicks。被测模块真实 DOC ≈ doc ÷ (1 + 0.0004 × calibrationAgeTicks)。
3. 用 water_status 读三处在线 DOC。被测模块 est = 第 2 步的校正值，区间 ±8%；另两处 est = 在线读数 × 该模块最近一次的校正系数（校正值 ÷ 当时在线读数，没有则取 1），区间 ±20%。在线读数与校正后估计相差超过 25% 的模块传感器记 faulty，其余 ok。
4. deliverable_check → deliverable_submit(task_id="D1")，evidence.resultIds 填 assay 的 r-N。`,
  D2: `D2 作物巡检（每个窗口一次）
1. 窗口前半段，在一次决策里对 4 个舱同时 greenhouse_scan。
2. 扫描完成后用 analysis_run 跑巡检模板（见下，把 so-? 换成 4 个扫描的引用），得到每株的叶片像素数与病斑像素数。
3. 判定：先取 greenhouse_status 里每株的 status（healthy / stressed / lost）；扫描结果 visibleLesions=true 或病斑像素 ≥ 1 的株改记 infected；未显症但有病斑像素的株同时列入 latent。
4. deliverable_check → deliverable_submit(task_id="D2")，evidence.operationIds 填 4 个扫描的 so-N。
巡检模板：
const out = {}; for (const ref of ['so-?', 'so-?', 'so-?', 'so-?']) { const scan = (await readRaw(ref)).raw; for (const [crop, c] of Object.entries(scan.cubes)) { let leaf = 0, spots = 0; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (c.data[0][y][x] < 0.11) { leaf++; if (c.data[5][y][x] > 0.385) spots++ } out[crop] = { leaf, spots } } } return out`,
  D3: `D3 能源调度（每个窗口一次；窗口从上一个 sol 的中点开到本 sol 的中点，预报的是 duty_status 给出的 slot 那个 sol）
1. analysis_run 读最近 2 个 sol 的 energy.solar、energy.soc、energy.tau_dust（telemetry 绑定），算上一个完整 sol 的发电总量（solar 求和）与夜间最低 soc。
2. 预报 energy = 上一 sol 发电总量 × (1 − 积尘日衰减)；tau_dust 正在上升（沙尘暴前兆）时按上升幅度大幅下调。minSoc = 上一 sol 最低电量，按发电变化同向调整。区间各 ±15%。
3. deliverable_check → deliverable_submit(task_id="D3")，evidence.analysisRunIds 填这次分析的 a-N（必须是提交前 120 步内运行的）。`,
  W1: `W1 水路基线（截止前、污染发生前完成）
1. 在一次决策里对 reservoir、filter、pump 各 water_assay(method="confirm", task_id="W1")。
2. 三个结果到齐后 analysis_run（把 r-? 换成三个结果的引用）：
const out = {}; for (const [m, ref] of [['reservoir', 'r-?'], ['filter', 'r-?'], ['pump', 'r-?']]) { const x = await readRaw(ref); out[m] = chromatogram(x).doc / (1 + 0.0004 * x.measurement.calibrationAgeTicks) } out.removal = 1 - out.filter / out.reservoir; return out
3. 提交三处浓度（区间 ±8%）与 removal（区间 ±0.05）。evidence：3 个 r-N + 这次分析的 a-N。`,
  W2: `W2 降解动力学（sol 2 起做，截止 1800）
1. water_split(source_id="reservoir", storage=["cold-1","freezer","bench"], task_id="W2")：一次取样，分装成 15 份（4 °C、−10 °C、22 °C 各 5 份）。[流程完成] 消息按存放位置列出分装样品 s-N。
2. 分装完成后立即测第一轮，之后约在 +24、+48、+96、+192 步各测一轮：每轮在一次决策里对三种温度各取一份还没测过的分装样品 water_assay(sample_id=…, method="confirm", task_id="W2")，每轮都按 cold-1、freezer、bench 的顺序下。用 mars_wait(until_tick=…) 等到下一轮；晚几步没关系，照常测。
3. 测完后 analysis_run（把 r-? 换成各轮结果，每种温度至少 4 个）：
const series = { k4: ['r-?', 'r-?', 'r-?', 'r-?', 'r-?'], kMinus10: ['r-?', 'r-?', 'r-?', 'r-?', 'r-?'], k22: ['r-?', 'r-?', 'r-?', 'r-?', 'r-?'] }; const out = {}
for (const [k, refs] of Object.entries(series)) { const pts = []; for (const ref of refs) { const x = await readRaw(ref); pts.push([x.startedTick, Math.log(chromatogram(x).doc / (1 + 0.0004 * x.measurement.calibrationAgeTicks))]) }
  const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n
  out[k] = -pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0) }
return out
4. 提交 k4（cold-1）、kMinus10（freezer）、k22（bench），区间约 ×/÷1.5，必须为正数。evidence.resultIds 填全部 confirm r-N（至少 8 条），analysisRunIds 填 a-N。`,
  W3: `W3 偏差与影响追溯（confirm 方法更新公告后 400 步内）
1. 方法更新后：对同一个留存样品先用旧版本再用新版本各测一次（water_assay 会用当前版本；旧版本历史结果可用 mars_measurements 查），比值即 v1 乘性偏差 confirmV1Bias。
2. 召回子批：请分析岗查档案 lots/lot_qc 表确认被召回子批号；用该子批与正常子批测同一母样的比值得到 extractionA2Bias。
3. affectedDeliverables：本方已提交、且用过 v1 或被召回子批结果的任务（W1/W2/W4）。证据至少 4 条 confirm r-N。`,
  W4: `W4 污染溯源（水路污染开始后 300 步内）
1. 确证污染后，在一次决策里对 reservoir、filter、pump 各 water_assay(method="confirm", task_id="W4")。
2. 三个结果到齐后 analysis_run（把 r-? 换成三个结果的引用）：
const out = {}; for (const [m, ref] of [['reservoir', 'r-?'], ['filter', 'r-?'], ['pump', 'r-?']]) { const x = await readRaw(ref); const f = chromatogram(x); out[m] = { doc: f.doc / (1 + 0.0004 * x.measurement.calibrationAgeTicks), lubricant: f.lubricant } } return out
3. 与 W1 基线比较：pump 比 filter 多出明显增量 → seal（泵封）；filter 去除率（1 − filter ÷ reservoir）明显低于 W1 → membrane；reservoir 明显高于 W1 → inlet（可能多个）。任一处 lubricant > 0.3 → lubricantPresent=true。
4. 在线读数与校正后 DOC 明显不符的模块 → faultySensor（诱饵），没有就填 none。increaseAtPump = 现在 pump − W1 的 pump。`,
  G1: `G1 生长基线（截止 700；基线条件：光照 70、营养 1、灌溉 75 µL/100 步、CO2 800，也就是开局默认值）
1. 开局先做 G1，再改光照做 G2：4 个舱保持基线设定至少 48 步。
2. 第 48 步之后，每隔约 24 步在一次决策里对 4 个舱各 greenhouse_scan 一次，共 3–4 轮。单次扫描噪声约 15%，所以要多轮取平均。
3. 每株的稳态生长率 = 各轮扫描 growthIndex 的平均；提交 16 株（区间 ±12%）。evidence.operationIds 填各次扫描的 so-N。`,
  G2: `G2 光照响应（截止 1500；每个舱有 4 个品种，所以 4 个舱设 4 个光照就能一次覆盖 4 个档位）
1. 4 个舱分别 greenhouse_light 设为 35、55、75、95，保持至少 48 步（生长率以 20 步时间常数趋近稳态）。
2. 保持期满后每个舱 greenhouse_scan 2–3 次（相隔 ≥10 步）取平均，记录每株生长指数；然后把光照轮换一次（例如 95、75、55、35），再保持 48 步测一轮，共至少 8 条观测、覆盖至少 3 个光照档位。
3. 扫描读数有光照偏差：真实生长 = 读数 ÷ (1 + 0.004 × (L − 70))。对每个品种拟合 growth ∝ exp(−((L − lightOpt)/width)²)；高光照还会升高舱温。提交后把光照恢复到对作物有利的设定。`,
  G3: `G3 营养 × 灌溉 × CO2（品种 2，截止 1900）
1. 与 G2 协调舱位。选至少 3 种处理组合（营养 1/2/3、灌溉量、CO2 setpoint），每种在一个舱保持至少 48 步（营养由 greenhouse_nutrient 设置，消耗培养基；灌溉量请作物岗按你给的剂量浇）。
2. 保持期满后对该舱 greenhouse_scan 2–3 次，取品种 2 的平均读数（光照偏差按 G2 的公式校正）。
3. 选生长最高的组合，提交 nutrient、irrigation、co2 与该组合的预测生长率。evidence：至少 5 条品种 2 观测。`,
  G4: `G4 病害参数（指示病例感染后 400 步内）
1. 收集作物岗的巡检病斑结果（board / 消息）与你自己的 greenhouse_scan；可对可疑株做 pathogen_confirm 确认。
2. 指示病例 = 最早出现病斑的那株；lambda ≈ 新感染株数 ÷ (易感株数 × 经过步数)。
3. 提交 indexCase 与 lambda（区间宽一些）。evidence：至少 8 株的高光谱或病原检测结果。`,
  F1: `F1 能源系统辨识（截止 1600）
1. analysis_run 读多个 sol 的 energy.solar：清洁面板（panel_clean）前后的白天峰值之差给出积尘衰减；dustRate = 每步衰减比例。
2. 夜间放电时 Δsoc 与 energy.demand 的比给出电池实际容量（与标称 800 比较）。清洁后的白天最大 solar 为 peakOutput。
3. 提交三个量（各给区间），evidence 至少 2 个 a-N。`,
  F2: `F2 预测性维护（4 个计分窗口，每个窗口都要更新一次）
1. analysis_run 读 confirm.lamp_intensity、imager.lamp_intensity、centrifuge-1/2.vibration_rms、heater-1.heatup_ticks 遥测：磨损 w 由代理量反推（灯强 = 1 − 0.4w；振动 = 1 + 1.6w^1.5；升温步数 = 10 + 8w）。
2. 用 mars_history 统计每台设备的使用次数，每次使用的磨损增量 = Δw ÷ 次数；剩余次数 = (1 − w) ÷ 每次增量。
3. 每个窗口提交一次 remainingUses（5 台，区间 ×/÷1.5）。`,
  F3: `F3 传感器漂移（漂移开始后 400 步内）
1. 每隔一两个 sol 对 4 个舱 device_reference 一次（参考探头给出真实温度与作物湿度），与在线读数比较；差值随时间线性增长的就是漂移传感器。
2. 漂移率 = 差值的增长斜率（读数 − 真值，每步）。确认后 sensor_calibrate 校准，并 incident_report(event_class=sensor-drift, root_cause=["舱:通道"])。
3. 提交 sensors 列表。evidence 至少 3 次 device_reference 的 so-N。`,
  A1: '', A2: '', A3: '', A4: '', A5: '', A6: '', A7: '', A8: '',
  X1: `X1 污染影响评估（水路污染开始后 500 步内）
1. 从水务（污染开始时刻、各模块 confirm）与作物（各舱灌溉记录，greenhouse_status 的 irrigationLast100、mars_history 的 irrigate 操作）收集数据。
2. stressTicks：每个品种（4 株合计）在污染期间用主回路污染水灌溉后受压的步数（每次污染灌溉约在 40–60 步后造成 20 步受压）。cleanAfterTicks：从污染开始到全部污染源修复、灌溉水恢复洁净的步数。
3. 提交（区间宽一些），evidence 至少 1 条 confirm r-N 与 1 个 a-N。`,
  X2: `X2 沙尘暴预案（必须在沙尘暴开始前提交；energy.tau_dust 会提前约 24 步上升）
1. 每 sol 看一次 energy.tau_dust（工程岗的 D3 分析会报告）；开始上升立即准备。
2. targetSoc 取 90–100（暴前充满）；powerPriority 列出先切断的非关键负载（analysis、screen、confirm、imager、离心机、加热器、robot-1、robot-3 等），温室舱温控与冷库不要列入；chamberLight 各舱降到 30–40。
3. 提交，evidence 至少 1 个读取 tau_dust 的 a-N；并让工程按预案执行。`,
  X3: `X3 下一阶段运行方案（时间窗结束前任何时刻都可提交，越晚越接近结束状态；建议最后 2 个 sol 提交）
1. 汇总农艺的 G2/G3 结论（各品种最佳光照、营养、CO2）、工程的能源状态（电池、积尘）、水务的水质结论（是否仍污染）。
2. 方案：各舱 light/nutrient/co2/temperature（品种最适），每株灌溉量（约 75），waterSource（仍污染则 reserve），powerPriority（温控与冷库最后），panelCleanEveryTicks（约 200），sampleStorage（cold）。
3. 提交，evidence 至少 1 条本方生长观测（scan so-N 或 image r-N）。`,
}
const ARCHIVE_SOP = `A1–A8 档案复核（截止 1200，八题彼此独立，每题单独提交）
1. archive_schema 看表结构；用 archive_sql 写 SELECT 直接算出答案（注意：排除 missing、去重、应用 corrections 更正、旧记录的华氏度要换算、时钟迁移前后的时间换算）。
2. 每题提交 {value: …}（A4 为各品种最佳光照档，A5 为各子批不合格比例），evidence.archiveQueryIds 填对应的 q-NNNN。
3. 做完八题后，转做独立复核：别人提交了数值答案时（看 board），用自己写的不同代码对同一原始数据重算，结果一致就把你的 a-N 告诉对方，让对方在 evidence.analysisRunIds 里同时引用两份分析（Q 独立复核分）。`

const ROLE_INTRO: Record<TeamRole, string> = {
  brain: '你是总调度（根成员）。团队已经由运行时组建好，不要再创建成员。你负责 X1、X2、X3 三个集成任务和跨领域事件的根因报告。例行工作已经写在各岗章程里，不要给队友派例行任务；只在跨领域事件中发协调指令，并向队友收集 X 任务需要的输入。每个 sol 用 board 看一次全队状态：某个值班窗口快结束仍未提交时，提醒负责岗。',
  water: '你是水务岗，负责 D1 水质日报、W1–W4 水战役，以及水路事件（水路污染、试剂召回、confirm 方法更新）的发现与报告。robot-1 归你使用。',
  crops: '你是作物岗，负责全部 16 株作物的灌溉（作物存活直接计入 O 分）、D2 作物巡检，以及病害处置（隔离、移除病株）和舱压、作物告警。舱内光照、营养、CO2 的设定归农艺岗，你不要改。',
  agronomist: '你是农艺岗，负责 G1–G4 温室战役；舱内光照、营养、CO2 的设定权归你（灌溉归作物岗）。robot-2 归你使用；病害期间跨舱取样前后要给 robot-2 消毒。',
  engineer: '你是工程岗，负责 D3 能源调度、电力（面板清洁、限电优先级、机器人充电）、设备维修保养校准与参考测量、舱体密封、补给订货、水源切换，以及 F1–F3 设施战役。robot-3 归你使用。',
  analyst: '你是分析岗，负责 A1–A8 档案复核（截止 1200）；之后为队友做独立复核和原始数据分析，并承接档案查询请求（例如试剂召回时查子批）。你没有物理工具。',
}
const ROUTINE: Record<TeamRole, string> = {
  brain: '例行：每 sol 一次 board；沙尘暴前兆出现时立即做 X2；水路污染后跟进 X1；最后 2 个 sol 提交 X3。',
  water: '例行：每个 D1 窗口一次水质日报；W1 尽早做完（污染前）；sol 2 起做 W2 定时采样；有水路告警立即确证。',
  crops: '例行：每 sol 前半段灌溉一次——在一次决策里对 4 个舱同时 greenhouse_irrigate（每舱约 300 µL，即每株约 75）；作物湿度读数偏低时加浇。每个 D2 窗口一次巡检。',
  agronomist: '例行：按 G1 → G2 → G3 的顺序排实验，G1 截止 700、G2 截止 1500、G3 截止 1900；实验结束后把光照恢复到对作物有利的设定（约 70）。',
  engineer: '例行：每个 D3 窗口一次能源预报；confirm 与 screen 的校准每 300 步左右做一次（device_calibrate，校准有效期 400 步；water_status 的 devices 显示 calibratedUntil；设备脏了先 device_clean），confirm 方法更新后立即重新校准，收到“流程卡在仪器校准”的请求时马上校准；每 2–3 个 sol 清洁一次面板；保持 robot 电量；每隔一两个 sol 对 4 个舱做参考测量（F3 与漂移检测）。',
  analyst: '例行：前 12 个 sol 每 sol 完成 2–3 道档案题；之后每 sol 看一次 board，为队友的数值答案做独立复核。',
}
const RULES = (decisionTicks: number, horizon: number) => `通用规则：
- 时间：任务时间窗 ${horizon} 步（${horizon / 96} 个 sol，1 sol = 96 步）。你每开始一步新的决策，世界至少前进 ${decisionTicks} 步；同一窗口里队友同时决策。可以在一次决策里同时调用多个互不依赖的工具。
- 没有需要立刻做的事时，调用 mars_wait(until_tick=下一个要做事的时刻)，不要结束回合，也不要反复查询空转。消息、告警和值班提醒都会唤醒你。
- duty_status 给出你的值班窗口：本窗口是否已交、下一个窗口何时开。时段内没有通过检查的提交记 0，不追溯。
- 流程工具（water_assay、water_split）一次调用跑完整条实验链，自己会等设备和机器人；完成时你会收到 [流程完成] 消息（mars_wait 会被它唤醒），里面有结果引用和数值，不需要再查询。
- 提交前先 deliverable_check（免费），再 deliverable_submit。证据用短引用：结果 r-12、样品 s-30、实验室操作 op-8、系统操作 so-5、产物 ar-4、分析 a-0017、档案查询 q-0042。流程工具（water_assay、water_split）的结果已自动读取，可直接引用；扫描引用其 so-N。
- 发现异常立即 incident_report（选 event_class，root_cause 写具体对象），越早越好。
- 跨岗请求用 mars_message(target_role=…)，内容以 [请求]、[告知] 或 [完成] 开头，写明对象的短引用。
- 资源忙时回执会告诉你占用者和预计释放步数，到那时再试，不要立即重复。`

const TEAM_ROSTER = `团队：总调度 brain（X1–X3、跨领域事件）；水务 water（D1、W1–W4，robot-1）；作物 crops（灌溉、D2、病害处置）；农艺 agronomist（G1–G4、舱内光照/营养/CO2，robot-2）；工程 engineer（D3、电力、维修、密封、水源切换、F1–F3，robot-3）；分析 analyst（A1–A8、独立复核、档案查询）。`

/** SOP text for the tasks one member owns. */
function sops(tasks: TaskId[]) {
  const archive = tasks.some(task => task.startsWith('A'))
  return [...tasks.filter(task => !task.startsWith('A')).map(task => SOP[task]), ...(archive ? [ARCHIVE_SOP] : [])].join('\n\n')
}
/** Alert checklist lines one role holds. */
function incidents(role: TeamRole) {
  return Object.entries(ALERT_GUIDANCE).flatMap(([, lines]) => lines[role] ? [`- ${lines[role]}`] : []).join('\n')
}

/** Charter of one fixed-team member: role, routine, SOPs of its tasks, alert duties and shared rules.
 * @param role Team role.
 * @param decisionTicks Logical ticks per decision window.
 * @param horizon Mission horizon in ticks.
 */
export function charter(role: TeamRole, decisionTicks: number, horizon: number) {
  return [ROLE_INTRO[role], TEAM_ROSTER, ROUTINE[role], '你负责的任务与 SOP：', sops(TEAM[role].tasks),
    '告警时你的动作：', incidents(role) || '- 无专门告警；跨领域事件由总调度协调。', RULES(decisionTicks, horizon)].join('\n\n')
}

/** Playbook of the single agent: every charter's SOPs and alert duties in one text, with a default priority order. */
export function singlePlaybook(decisionTicks: number, horizon: number) {
  const roles: TeamRole[] = ['water', 'crops', 'agronomist', 'engineer', 'analyst', 'brain']
  return ['你是唯一成员，一个人兼任水务、作物、农艺、工程、分析和总调度六个岗位，拥有全部工具和 robot-1、robot-2、robot-3。下面是六个岗位的例行工作与 SOP，全部由你完成。默认优先级：安全事件 > 值班（D1–D3）> 有截止期的科研 > 其余。',
    ...roles.map(role => `【${TEAM[role].title}】${ROUTINE[role]}`), '各任务 SOP：', sops(roles.flatMap(role => TEAM[role].tasks)),
    '告警时的动作：', [...new Set(Object.values(ALERT_GUIDANCE).flatMap(lines => Object.values(lines)))].map(line => `- ${line}`).join('\n'),
    RULES(decisionTicks, horizon).replaceAll('同一窗口里队友同时决策。', '').replace(/\n- 跨岗请求[^\n]*/, '')].join('\n\n')
}

/** Guidance lines for the alerts in one notice, as one role (or the single agent, who holds every role) should read them. */
export function guidanceFor(role: TeamRole | 'single', kinds: string[]) {
  return [...new Set(kinds)].flatMap(kind => {
    const lines = ALERT_GUIDANCE[kind]
    if (!lines) return []
    return role === 'single' ? Object.values(lines) : lines[role] ? [lines[role]!] : []
  })
}
