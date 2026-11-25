**Mars v0.6 本轮配对实验复盘（2026-11-17）**

本报告针对已经封存的 multi 六角色团队与 single 单 Agent 两局。复核使用最终报告、只读 SQLite 账本、DeepWorks 会话和现有评分代码；另在原隔离运行器中，用合成输入复现了已冻结模型的执行错误。没有访问隐藏验证目标来修正模型，没有调用新的真实模型，没有改写原始提交、封印或得分。

**主要结论**

本轮完成了运行生命周期，但科研交付链大面积断裂。Single 没有任何接纳的预测或提交；multi 接纳了四项 final，但主要科学验证项全部为零。Multi 的 1.67 分全部来自一次服务测量的部分分。平台接口缺陷、产物可执行性错误、计划/证据不匹配和最后阶段的续行行为相互叠加，不能只归因为任务复杂或 Agent 数量不足，也不能据此定量判断多 Agent 组织优劣。

| 指标 | Multi | Single |
|---|---:|---:|
| 最终 tick / 状态 | 2400 / finalized | 2400 / finalized |
| R / F | 1.6667 / false | 0 / false |
| baseline 接纳 | T3 | 无 |
| final 接纳 | T1、T2、T3、T5 | 无 |
| 原运行器合成输入复核 | 7 个已注册模型全部失败 | 3 个已注册模型全部失败 |
| 科学验证组通过 | 0/6 | 0/6 |
| 完整服务交付 | 0/3 | 0/3 |
| 作物存活 | 7/16（43.75%） | 5/16（31.25%） |
| 成功执行作业数（非科研成功数） | 203 | 98 |
| 输入 token 累计 | 50,554,973 | 6,337,798 |
| 输出 token 累计 | 1,890,162 | 250,185 |

**1. 得分到底来自哪里**

Multi 的 service-1 在 tick 752 完成过测量，但未满足留样条件；另外两项服务没有达成评分器认可的测量。评分器对单项服务取“测量、留样”的平均，故服务部分为 (0.5+0+0)/3=1/6。T3 的服务权重为 0.5，得到 q(T3)=1/12；其他任务 q 均为零，总分 R=100×(1/12)/5=1.6667。

这份部分分没有证明能源模型或科研流水线预测正确。最终报告中 current_accuracy、storage_accuracy、holdout_accuracy、energy_forecast、dependent_pipeline、independent_pipeline 全部为零。F 是 27 项条件的合取；两局均仅通过关键供电与供水两项。

需要澄清两个字段：

- 当前评分器固定返回 `calibrationStatus: candidate_not_frozen` 与 `formalRankingEligible: false`。它们表示评分器的开发状态，不是本轮表现不好后才产生的惩罚；也不表示仪器从未校准。
- 当前 R 主要依据 final 产物和实际交付计算。`baselineMissing` 是单独记录的缺项，不能把它误解为“缺 baseline 就自动把 R 清零”。本轮直接给零的原因是 final 缺失、模型执行失败或证据不合格。

依据：`evaluator.ts:24`、`finalize.ts:80`。

**2. 已注册的科学模型没有成为可执行产物**

契约要求 `code` 是接收 `input`、`parameters` 的同步函数体，直接 `return` 有限 JSON。运行器会把它编译为函数体，不会自动调用其中另写的函数。

| 冻结模型 | 代码形态 | 原运行器复现 |
|---|---|---|
| multi：m-energy-v1、m-energy-v2、m-growth-v1 | 裸的 `function(input){...}` | `Isolated program syntax is invalid`；函数声明缺少名称 |
| multi：m-water-cal-v1/v2、m-water-effect-v1/v2 | 顶层仅有 `(input) => {...}` 表达式 | `Frozen synchronous model failed`；没有顶层返回 JSON |
| single：mod-wtr-v1、mod-crp-v1、mod-ene-v1 | 裸的 `function(input){...}` | `Isolated program syntax is invalid` |

因此，大部分科学项在执行或证据资格检查阶段就被判无效，还没有进入数值准确度比较。Multi T1/T3 的报告理由是 `model_execution_failed_or_invalid_output`；T2、T5 的部分验证组还在更早的证据门槛处失败。

Agent 的工作区提示已经写明“同步 return 有限 JSON 的函数体”，所以这里确实存在模型未遵循契约的问题。同时，`registerModel` 目前只验证数据结构和依赖后落账，不编译代码；`research_submit(action=check)` 明确只检查格式、引用和可见性，不做科学验证。这使不可运行的代码可以一路注册、锁定并提交，缺少一个及时、公开、可理解的反馈点。

依据：[Agent 参数说明](E:/deepworks比赛/app/workspace/.opencode/agents/mars.md:37)、`records.ts:76`、`records.ts:134`、`model-runner.mjs:29`。

**3. 已存在模型按 ID 读取为 null，是确认的接口缺陷**

`research_read` 的说明允许读取模型、承诺和提交；但传入 `id` 时，当前实现只查询研究笔记。读取已注册模型会返回 `{current:null, history:[]}`，只有不传 ID 时才列出模型集合。

在确认模型已接纳之后，仍读到 null 的调用共有 35 次：multi 29 次、single 6 次。Single 末期摘要还把“模型未持久化确认”列为阻塞，而账本显示三个模型早在 tick 910 已接纳。

这是反馈误导，不应全部算作 Agent 没有检查。它会引发重复定位和重复注册；single 在 tick 1115 重用旧模型 ID 时又收到 `Model ID is immutable`。但现有记录不足以量化这一个缺陷单独损失了多少得分。

依据：`tools.ts:74`。

**4. Single 的主要直接失败：没有把研究变成预测和最终提交**

关键时间线如下：

- tick 706：首次集中尝试注册三个模型、一个 pipeline、三项 action commitment。回执分别指出 parameters/basedOn/units 结构错误、pipeline 节点为空或 outputs 类型错误，以及前瞻承诺晚于计划操作。
- tick 720：baseline 四项均缺失。
- tick 910：三个模型终于接纳，但代码仍是不可执行的裸函数声明。
- tick 946/947：错误样本使时钟失败，随后原位恢复；此故障发生在 baseline 封存之后。
- 全局记录：没有接纳任何 prediction、pipeline、action commitment 或 submission；会话工具记录中没有调用过 `research_submit`。
- 最后阶段：在只余约 90 tick 时，Mars 主角色输出了一份“Objective / Work State / Next Move”交接摘要，列出了未完成项后 `finish=stop`，没有真正完成后续提交。

这解释了 single 的六个科学组为何都是 `required_evidence_missing_or_invalid`。模型注册、预测锁定、证据引用、提交接纳是不同环节，不能用“有模型草稿、做过分析或调用完成”代替。

**5. Multi 的主要直接失败：交付之间不相容，四份 final 也不等于四项科研通过**

Multi 有更多实际产物，但最后接纳的组合存在以下问题：

- T1 final 在 tick 1609 接纳，引用 m-water-cal-v2；该模型是没有顶层返回值的箭头表达式，原运行器执行失败。
- T2 final 在 tick 1765 才接纳，引用 m-growth-v1、分析记录 a-0015/a-0019，以及计划 plan-360-1。生长模型语法无效；评分器要求的多条件实测证据和后半程干预计划也没有形成合格链路。
- T3 final 在 tick 1237 接纳，能源模型不可执行，三项承诺挂在未成功执行的计划上。
- T5 final 在 tick 1237 接纳，使用能源模型和 a-0005，并填入四个 incubator 名称作为 scopeIds；两次 pipeline 注册分别因单位不匹配、未声明绑定字段失败，没有接纳任何 pipeline。后续替换又遇到预测/流水线引用不一致。
- T4、T6 最终没有接纳的提交。

协作中的版本管理也有实际失败：multi 的科研回执包含 4 次 submission revision 冲突；T3 的末次替换在 tick 1789 仍因 revision 改变被拒绝，T5 的一次替换在 tick 1741 因 pipeline/prediction 不匹配被拒绝。

需要以 `mars-v06-native-receipt` 和 `mars-v06-record` 为准：SDK 的工具 `completed` 可能只返回 pending。Multi 共 242 份 native 回执中有 37 份失败；single 为 71 份中的 9 份。

**6. 计划没有覆盖真实交付，后半程也没有作物干预**

Multi 只有一次接纳的计划变更：tick 360 的 plan-360-1，标题是“J-C services delivery”，内容仅一步——在 confirm 上处理 `qc-blank`。它随后从 tick 361 至 2400 产生了 1917 条 `Sample is unavailable for this project` 阻塞记录，计划没有成功落地。

三项服务承诺都引用同一份计划，T2 final 也引用了它。它的内容并未形成三源采样、留样和作物干预各自所需的实际操作链。服务承诺确实曾被接纳，但“有承诺”与“承诺的计划实际完成”是两回事。

Multi 的 service-1 测量虽然发生在 tick 752，其母样到终点时体积为 0、已隔离且已过有效期，因此留样不合格；不能用“做过测量”替代完整交付。Single 三项服务均未达成评分器认可的测量。

两组在 1800 前有不少实际作物动作：multi 104 次、single 36 次成功的灌溉/光照/扫描等系统操作；但 1800 后两组都没有成功的这类动作。评分器要求的是已封存计划在后半程实现干预并验证效果，这部分没有完成。最终作物存活分别为 7/16、5/16，均低于 12/16 的要求。不能据此把每株作物的损失都归为同一个生理原因，但缺少后半程计划已是独立的验收缺口。

**7. 自主续行和工具格式也出现了异常，但归因有边界**

除了普通 API 参数错误，还观察到：

- engineer 曾只输出 5 个异常 token 后正常 stop；single 有一条完成回复仅含混杂语言推理，没有正文或工具调用。
- brain 最后一条回复把 `<invoke name="mars_inbox">...` 和 DSML 结束标记写进普通文本，消息以 `finish=stop` 结束；这些字符串没有对应的工具调用记录。
- single 末期续行输出交接摘要后结束回合，剩余动作留在“Next Move”，没有执行。

能确认的是模型/适配链路没有稳定地产生并执行正确的工具调用；仅凭会话存档，还不能判定异常来自模型生成、上游原生工具解析、长上下文处理还是 SDK 转换。需要对照脱敏的原始上游响应与 SDK 消息，不能直接认定是哪一层损坏。

**8. 平台故障的影响不能抹去，也不能包揽所有失分**

本轮有两次确认的平台时钟故障并发生人工恢复：single 在 tick 947，multi 在 tick 1045。Multi 的 s-18/s-21 本来是有效短引用；当时旧运行代码未解析它们，随后空指针让整局时钟失败。修复保留了原账本和封印，并追加恢复记录；两个检测流程最终完成 confirm。

两个故障都发生在 tick 720 之后，不能解释此前已经缺失的 baseline；恢复时也没有回退逻辑时间，因此不能把几十分钟墙钟挂起直接折算成损失了多少科研 tick。与此同时，请求取消、额外恢复通知、运行中换代码会改变轨迹，所以这不是一份未经干预的干净配对运行。

控制 RPC 超时累计为 busy.set 4 次、通知查询 153 次；压缩附近仍有 `%7Bid%7D` 会话路径错误。它们的逐项影响尚未定量定位，不能把所有耗时或交付失败都归到这些日志上。

**9. 资源投入不相等，这轮不足以比较组织优劣**

Multi 累计输入 token 约为 single 的 7.98 倍，输出约为 7.56 倍，合计约为 7.96 倍。配置中的 budgetUsd、budgetTokens 均为 null。本轮没有实行相等的推理预算，也只有一对运行，中途还经历了不同的恢复。

这些是 usage 累计，包含重复上下文和压缩，不是独立信息量，也不是实际付费账单；账本 costUsd=0 不足以证明调用免费。Multi 接纳更多提交是事实，但其 1.67 分不足以证明多 Agent 的科研模型更准确，single 的 0 分也不能用于推断其能力上限。

**建议的修复和复测顺序**

1. 先修复模型交付闭环：让 research_read(id) 正确读取模型/流水线/预测/承诺；注册时即时检查函数体语法与支持的 schema；增加仅使用公开输入的可执行性预检，明确输出和错误。不要使用隐藏验证答案指导修正。
2. 固化当前已验证的短引用解析、坏流程隔离和恢复能力，验证新建、恢复及全部活跃世界一致生效。增加时钟失败的显式健康状态，避免模型长时间挂在准入门口才被发现。
3. 做真实上游的兼容验收：覆盖长上下文、压缩后续行、并行工具调用；对照脱敏原始响应与 SDK part，查清纯文本 DSML/摘要替代行动的问题。
4. 在同一个 Mars 世界与固定 6+1 设置下跑通一条最小交付链：可执行模型 → 预测 → 实测证据 → 提交回执 → 阶段封存；再覆盖服务留样和 1800 后计划执行。明确每份提交的负责人、备用负责人和 revision，避免靠文字宣称交付。
5. 平台和协议稳定后，用同一冻结实现、同一任务和配对场景，约束或明确报告两世界推理预算，做少量完整配对重复，再讨论协作效果。候选评分器的冻结与正式排名资格应单独处理。

以上是后续建议，本次复盘未实施新的代码修复，也没有重跑或改动已结束的实验。

**可核验来源**

- [multi 最终报告](E:/deepworks比赛/data/mars-multi/final-report.json)
- [single 最终报告](E:/deepworks比赛/data/mars-single/final-report.json)
- 各自 `execution/execution.sqlite`：`mars-v06-record`（真正接纳产物）、`mars-v06-native-receipt`（异步执行结果）、`mars-v06-seal`（封存选择）、`mars-native-recovery`（恢复审计）、`mars-v06-plan-blocked`（计划阻塞）。
- DeepWorks 会话：本实验工作区的 M-* / S-single 的 message、part 记录。
- `evaluator.ts:45`、`finalize.ts:80`、`validation.ts:65`。

运行标识：multi `81712321-7afa-4539-9c40-3bcf4153cd2f`；single `01b44445-1215-4e53-8c97-67fe27458055`。

最终报告 SHA-256：

```text
multi  ad8c1ca97763989f7fbcf7f6ad8c9634c397d69622a9c722bb9d6a46ee070fdc
single 58b101560403f91d0450d37cd7a2d0b623ec7e9820672733fa58718be1f06d6b
```
