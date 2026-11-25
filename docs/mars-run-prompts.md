# Mars v0.6 九会话运行提示词

在 DeepWorks 打开 `E:\deepworks比赛\app\workspace`，新建普通对话即可；工作区默认 agent 为 mars，不需要在界面选择。登录后会话自动命名为 M-brain/M-water/... 或 S-single。

**本轮开跑用 [r6b 专用消息单](mars-r6b-start.md)。** 当前工作区选用 `data/mars-multi-8-r6b` 和 `data/mars-single-8-r6b`，版本为 `delivery-v2` 与 `shared-plan-v3`。

r6a 已在独立目录备作工作流对照，版本为 `delivery-v2` 与 `pilot-choice-v2`。切换到 r6a 配置后使用 [r6a 对照消息单](mars-r6a-start.md)。两组的配置与测量口径见 [r6 工作流说明](mars-r6-workflow.md)。

r5 使用 `reviewed-v1` 与 `pilot-choice-v2`，原始开局文本保存于 [r5 消息单](mars-r5-start.md)。本页下方为 r4 的历史操作说明。

r4 使用 `mars-v06-native-steps/1`、`teamSize: 8` 和九个新会话。Multi 在 `data/mars-multi-8-r4`，Single 在 `data/mars-single-8-r4`。两组均使用新版 T6 `paired-growth-v1`。已结算的 r3 保存在 `data/mars-multi-8-r3` 与 `data/mars-single-8-r3`。

下轮若启用 `reviewed-v1` 或 `pilot-choice-v2`，按[共享草稿与两阶段试验说明](mars-reviewed-trial.md)核对配置。新版 T6 有 baseline 小试，使用该说明中的 Single 首消息和 brain 第二条消息。

## 启动前

准备配置中的两个世界并运行只读检查。每一对实验使用未开跑的目录。

```bash
node demo/mars-prepare.mjs
```

```bash
node demo/mars-preflight.mjs
```

r4 预检应显示 `ready`、`fresh`、`pairHistoryMatched` 均为 true，`sessions` 为 9，`jointTrial` 为 `paired-growth-v1`。然后打开 DeepWorks 工作区。

操作是 **九条首消息和 brain 一次启动消息**。八个团队会话的首消息用于初始化。Brain 调用 `mars_start` 后，七个专家收到开局职责。Single 在首消息中独立启动。

## 共同运行规则

- 初始化阶段只加入、读取公开资料；团队全部登录后 brain 调一次 mars_start。single 自己 mars_start。初始化登记属于 DeepWorks 控制面，正式科研模型 step 从启动后的 tick 0 窗口开始，费用仍照实记录。
- 每一次科研模型 step 都经宿主逻辑时间准入，默认相邻不同决策至少间隔 12 tick；重试沿用同一步位置。不能把界面对话回合当成实验轮次。Single 与团队使用同一套准入规则。
- 写操作先返回 pending/callId。记下 callId，下一模型步用 round_receipts 取真实结果；宿主先统一提交，再让下一决策窗口进入。无需先设置一个自唤醒定时器，也不必为 pending 额外轮询等待。isError 表示该次失败，应修正，不能当作成功。
- 任务没完成时继续工具循环，不要仅输出“稍后继续”便结束。需要等测量、邮件或实际节点时用 mars_wait({until_tick:节点})，也可无目标等待。它过滤机械噪音和流程内部步骤，没有墙钟超时，不会每隔几分钟制造一个新推理步骤。
- 模型推理与上下文压缩时世界暂停。所有参与者就绪后才允许推进；全部空闲时也可继续到环境事件。真实运行耗时不直接换算为实验 tick。
- 工作消息和相关环境事件由宿主主动推送到原会话并去重。用 mars_send 协调；确需显式激活同伴时可 mars_wake，不能 wait:true 或反复唤醒忙碌角色。不要创建额外会话。通知传输失败的重试只投递同一个事件，不生成新的科研分析轮次。
- 压缩成功后先查状态和回执，再从原科研任务继续。压缩摘要过长失败时，`mars_status.round.recentCompactionFailures` 会记录岗位和 tick，团队的 brain 会收到接管通知。工具走引擎原生通道。已确认的原生工具封套格式错误最多在原决策窗口纠正一次。
- `experiment_plan` 的步骤可写成 `{id,tool,args,at,dependsOn}`，其中 `args` 使用现有物理工具参数。`research_catalog({contract:"experiment_plan",tool:"water_sample"})` 可查精确结构。步骤 `args` 只填公开契约列出的物理参数。`schedule` 在外层提供 `request_key`，宿主按计划和步骤生成执行键。未来样本引用用声明前驱的 `$step:步骤:outputSampleId`。`check` 返回标准化计划 `plan` 和资源诊断 `diagnostics`，并核对当前方法耗材和载样能力。用 `research_catalog(section=resources, resource_kind=batch)` 查可用耗材批次，或用 `resource_kind=robot` 查载样能力。可用 `deadline_tick` 检查下界是否超过截止。已落账的计划进度用 `list` 核对。
- 用 `mars_stages.openSlots` 追踪开放槽位、最新预测和接纳回执。`accepted: null` 表示该槽位尚无接纳版本。`research_submit(action=check)` 核对格式、引用与当前已取得的公开证据，`evidenceChecks` 会列出各验证组的缺项。用 `action=submit` 正式提交，并确认 `round_receipts` 返回的 `revision` 和 `acceptedTick`。按 `expectedRevision` 可在截止前修订已接纳版本。
- 用 `research_catalog(section=services)` 核对方法、测量截止和母样留存要求。每项服务在计划的 `input_json` 中填写 `service` 对象，包含 `commissionId`、`measurementStepId` 和 `retentionStepId`。从同一原始母样分配测量与留存用量，检查 `diagnostics.service` 的体积、寿命和最早完成 tick。`schedule` 回执给出 `planId`，随后用 `prediction_commit` 锁定匹配该委托的 T3 承诺。宿主等承诺落账再放行第一步。用 `experiment_plan(action=list)` 的 `commitmentRecorded` 和步骤回执检查进度，把承诺 ID 交给 T3 提交负责人。
- 每局 T6 验收见 `research_catalog(section=interfaces,task_id=T6)`。启用 `paired-growth-v1` 的成对试验还须在 final 前登记处理株、同品种对照株、预期单位时间生长差、水预算及能源预算。按公开 T6 契约提交，使用所封存的计划在验证期执行灌溉、补光和双舱扫描。
- 720 前实际接纳 baseline，1800 前实际接纳 final。T2 final 所引用的计划应安排封存后的处理与扫描验证。1800 后宿主停止新模型请求，已接纳且获准的作业继续。2400 自动结算，向 brain/single 投递无需模型回复的 R/O/F 报告。
- 研究写工具用 input_json（JSON 字符串）+ request_key；model_register 的 code 直接在同步函数体中 return 有限 JSON，不包 function 或箭头函数。先用 round_receipts 确认注册接纳，再用 model_test 的 input_json JSON 字符串提供 modelId 或 pipelineId 与 inputs 数组，自检公开输入上的执行与输出。executionValid 不等于科学达标或提交接纳。research_read 按 id 读取产物，重名用 kind；提交版本用 task_id+slot_id+revision。analysis_run.code 是异步函数体，可 await 公开数据绑定。舱名 incubator-1..4。
- `research_catalog` 的分页 `limit` 为 1–10。用 `section=interfaces` 和 `task_id` 查精确模型字段，T3 的公开示例可直接送入 `model_test`。按 `contract` 查工具参数，`contract=research_submit, task_id=T2` 可同时查 baseline 和 final 的 payload。DeepWorks 也可直接调用 `action_commit` 和 `pipeline_register`。历史归档先用 archive_schema，再用 archive_query/archive_search/archive_stats 或只读 archive_sql。历史 tick<0，当前任务的实测证据需来自本局。
- 只用已注册 Mars 工具，不读源码、隐藏 truth、凭据或本地文件，不套用 science_* 采样演示的角色限制。所有合法科研工具向每个岗位开放，角色只是默认职责。

## 八个团队首消息

| 对话 | 首消息 |
|---|---|
| M-brain | 调用 mars_login，role=brain，然后 mars_status、mission_read，汇总三项委托和 T1–T6。现在只完成加入和公开资料阅读，结束回合，等待我的启动消息，不调用 mars_start，不安排科研写操作。 |
| M-water | 调用 mars_login，role=water，然后 mars_status、mission_read，重点读 T1/T4 与供水检测接口。现在只做初始化和公开资料阅读，结束回合，等待宿主启动通知。 |
| M-crops | 调用 mars_login，role=crops，然后 mars_status、mission_read，重点读 T2 作物接口。现在只做初始化和公开资料阅读，结束回合，等待宿主启动通知。 |
| M-agronomist | 调用 mars_login，role=agronomist，然后 mars_status、mission_read，重点读 T2/T3、资源与能源接口。现在只做初始化和公开资料阅读，结束回合，等待宿主启动通知。 |
| M-engineer | 调用 mars_login，role=engineer，再用 mars_status 和 mission_read 阅读能源、供水、设备及物流规则。读完结束初始化回合，等待开局通知。 |
| M-analyst | 调用 mars_login，role=analyst，再用 mars_status 和 mission_read 阅读 T5、模型和流水线契约。读完结束初始化回合，等待开局通知。 |
| M-service | 调用 mars_login，role=service，再用 mars_status、mission_read 与 research_catalog 的 services 页阅读三项服务的测量、截止和留样要求。读完结束初始化回合，等待开局通知。 |
| M-verifier | 调用 mars_login，role=verifier，再用 mars_status、mission_read 阅读公开证据、独立复测和阶段计划规则。读完结束初始化回合，等待开局通知。 |

## S-single 首消息

```text
调用 mars_login，role=single，确认是单 Agent 独立世界。先 mission_read 和 research_catalog 读取 T1–T6、公开接口、合同、证据要求、资源与三项服务，然后调用 mars_start 开始本局。

你一个人兼任全部岗位，自主研究到最终阶段，不等待 brain，不创建额外成员。科研逻辑时间由宿主管理，每个模型 step 受同样的 12 tick 决策窗口准入；写操作 pending 后下一步先 round_receipts 取结果，失败先修正。等待实际事件、邮件或节点用 mars_wait；不要自己设置自唤醒，不要仅说“稍后继续”就结束任务。

本轮 T6 使用 paired-growth-v1。先读 research_catalog(section=interfaces,task_id=T6)。选不同舱的同品种处理株和对照株，在 1800 前登记尚未开工的计划，取得 planId 后正式提交 T6/final。payload 包含 planId 和 trial，填写 treatmentCropId、controlCropId、forecastGainPerTick、waterBudgetUl、energyBudget。evidence 引用本局源水测量和已完成的实际能源遥测分析。验证期按计划给处理株灌溉、设置区别于对照的光照，两舱在处理完成且达到 tick 2250 后扫描，最迟于 2400 完成。

0–720：开局就将三项服务草案一起交给 experiment_plan(action=portfolio) 检查。在公开测量截止和母样寿命允许的窗口内安排测量与保留，并为资源冲突预留替代路线。根据公开任务和证据要求设计真实水质、认证标准、保存条件、作物处理、能源实验，形成可运行模型与可提交的 baseline。water_assay/water_split 可运行真实流程，用 mars_procedures 看进度；历史库用 archive_* 或 analysis_run 中 await archiveSql。当前未知水和作物仍需要真实测量。

720–1800：根据新证据选择性修订，完成 T1/T2/T3/T5 final、T4 诊断与处置、T6 联合计划和三项服务交付。按各委托的公开截止安排三项服务，使用 experiment_plan 的 service 对象关联委托、测量步骤与原始母样留存步骤。登记后用已接纳的 planId 锁定对应的 T3 承诺，宿主随后放行开工。将获接纳的承诺 ID 纳入 T3 final。T4 前瞻承诺须在首次计划动作前锁定。模型、预测和提交各步均核对实际回执。

研究写工具用 input_json JSON 字符串加 request_key。模型代码同步 return 有限 JSON。analysis_run 可 await 公开数据绑定。舱名 incubator-1..4。每次主要决策先查 mars_inbox、round_receipts、mars_status。用 mars_stages.openSlots 跟踪预测与正式接纳，预留修正和取回执的窗口。每项服务按自己的公开截止安排测量与留样。用 experiment_plan(action=portfolio) 联查三项委托的机器人返桩、设备位置、清洗和截止余量。用 research_catalog(section=references,task_id=任务) 按字段选证据，封存前核对 acceptedTick 和 revision。

1800 后宿主停止模型，允许的物理工作继续到2400，自动结算并投递报告。现在开始执行。
```

## brain 的第二次消息

八个团队岗位完成首消息后，把整段发给 M-brain。专家开局通知和阶段推进由宿主处理。

```text
现在开始整局自主科研。用 mars_status 核对 requiredRoles 中八个岗位都已加入，然后调用一次 mars_start。宿主随开局通知激活七位专家。

你主责 T6 联合计划和正式提交，同时协调共享资源与期限。所有岗位使用同一套公开科研工具。八位成员的主要交付为 water 的 T1/T4、crops 的 T2、agronomist 的 T3 和 analyst 的 T5。Engineer 负责供电、供水、设备和资源协调。Service 负责三项服务的测量、同一母样终点留存与前瞻承诺。Verifier 安排独立复测、公开模型自检和封存后的验证，并将证据交给提交负责人。

本轮 T6 使用 paired-growth-v1。先读 research_catalog(section=interfaces,task_id=T6)。选不同舱的同品种处理株和对照株，在 1800 前登记尚未开工的计划，取得 planId 后正式提交 T6/final。payload 包含 planId 和 trial，填写 treatmentCropId、controlCropId、forecastGainPerTick、waterBudgetUl、energyBudget。evidence 引用本局源水测量和已完成的实际能源遥测分析。验证期按计划给处理株灌溉、设置区别于对照的光照，两舱在处理完成且达到 tick 2250 后扫描，最迟于 2400 完成。

Service 用 experiment_plan 的 service 对象关联委托、测量步骤与原始母样留存步骤。登记后用已接纳的 planId 锁定对应的 T3 承诺，宿主随后放行开工。Service 统一负责登记三份计划和承诺，engineer 用 experiment_plan(action=portfolio) 联查全部草案的返桩电量、接收位置与清洗窗口。交接服务步骤时在 handoff.references 放 `{kind:"plan",id:planId,stepId}`，宿主会附上发送时的 operationId、接纳及完成 tick、物理状态和阻塞原因。Agronomist 同时推进能源模型，收到已接纳的服务承诺后更新 T3 final。Crops 可请 agronomist 协助设计，analyst 可请 water 和 agronomist 提供 T5 所需的证据。各任务负责人跟进到正式接纳。

各岗位收到开局通知后推进独立工作。资源协商用 mars_send 的普通 text。交付成果时加 request_key 和 handoff，填写 taskId、slotId 和 references，在 text 写出接收者下一步。宿主核对已有记录并附上提交截止。你用 mars_stages 查缺项和接纳版本，协调阻塞并在截止前补位。

运行规则：每个模型step经宿主逻辑时间门控，默认相邻决策至少12tick，推理与压缩时世界暂停。写操作pending后下一步先round_receipts，宿主负责统一接纳与推进；等结果或实际节点用mars_wait。没有定时自唤醒工具；任务未完成时继续工具循环，不要只输出“稍后检查”后结束。

每次主要决策查 mars_inbox、round_receipts、mars_status。用 mars_stages.openSlots 跟踪各槽的预测与正式接纳，预留修正和取回执的窗口。720 前接纳 baseline，1800 前接纳 final。每项服务按自己的公开截止安排测量与留样。用 experiment_plan(action=portfolio) 联查三项委托的机器人返桩、设备位置、清洗和截止余量。用 research_catalog(section=references,task_id=任务) 按字段选证据，封存前核对 acceptedTick 和 revision。T3/T4 前瞻预测先于计划动作，T5 交联合模型或有限 DAG，T6 交联合计划。研究写工具用 input_json 加 request_key，模型 code 同步 return 有限 JSON。analysis_run 可 await 公开数据。舱名 incubator-1..4。

阶段转换由宿主执行，不等人工再发final指令；你负责在有效模型阶段内追踪缺失项、组织修订和资源协商。1800后宿主关闭模型请求，继续允许的物理验证到2400，并自动结算、投递无需回复的报告。现在执行。
```

## T6 成对生长试验配置

在一对新世界的工作区配置中设置 `mars.jointTrial` 为 `paired-growth-v1`，两组即使用相同的试验契约。默认 v0.6 使用原 T6。版本随阶段配置进入协议哈希，配对检查会核对它。正常实验仍使用 720、1800、2400 三个封存时点。

Pilot 的 `T6/final.payload` 包含 `planId` 与 `trial`。在计划开工前声明 `treatmentCropId`、`controlCropId`、`forecastGainPerTick`、`waterBudgetUl`、`energyBudget`。用 `research_catalog(section=interfaces,task_id=T6)` 查本局容差和预算上限。T6 只在所引用计划里安排验证期处理及扫描。终点报告的 `jointTrial.checks` 列出水质与能源证据、起点匹配、实际处理、双舱扫描、生长差、预测与预算的验收结果。该结果用于 F 的联合计划条件，R 继续按 T1–T5 计算。

## 恢复和验证

- 会话结束后的继续由实际工作消息与相关环境事件驱动；没有每30秒固定的“继续”消息。手动停止会取消当前等待/请求；需要恢复时用原会话明确继续。
- 重新打开一个已开始但未结束的数据集时，宿主保持 suspended，brain/single 明确调用 mars_start 后恢复并通知原团队。不要把旧协议数据当成新局；删除原对话后不能保证完整恢复。
- 整局检查点和离线评分仍可用，命令见 README。配对检查包含 schedulingProtocol，防止新旧调度混比。
- 控制面使用 DeepWorks 的会话/消息 API；启动登记、通知显示、近似费用记录和单链检查点是适配实现。这里对齐影响科研机会的核心调度规则，不宣称与费用预留或分支恢复逐项完全相同。
- 修改工作区插件、sidecar 或网关配置后，要重新加载引擎和其所属 sidecar/网关才生效；已运行进程仍持有加载时的代码。修复说明与隔离验收见 [工程修复记录](mars-engineering-repairs-20261117.md)。
