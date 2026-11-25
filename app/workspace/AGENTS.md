# DeepWorks 科学实验室工作区

这个工作区把 AI4Science 实验平台接入 DeepWorks。平台代码在 `../science/`（Node sidecar），
DeepWorks 的每个对话会话就是一个平台参与者；会话里调用的 `science_*` 工具全部落到同一份持久实验账本。

## 角色

工作区提供三个可选 agent：

| Agent | 职责 | 关键工具 |
|---|---|---|
| `cerebrum` | 提出目标、登记实验、委派并唤醒执行者、解释结果 | `science_experiment_start`、`science_delegate`、`science_wake`、`science_experiment_release`、`science_artifact` |
| `midbrain` | 领取实验、执行动作、评估并结束 | `science_experiment_act`、`science_assess`、`science_finish` |
| `cerebellum` | 只读核对仪器操作与产物 | `science_status`、`science_operation`、`science_artifact` |

如果界面只允许使用默认 agent，也不影响记录：每个会话仍以自己的 session 身份登记为参与者，
记录里会显示 `agent@session`。

## 实验闭环

1. 大脑登记实验（`bounded-sampling`，默认要求 6 个唯一观测，最多 2 次动作）。
2. 大脑先 `science_experiment_release` 释放控制权（否则执行方无法 `claim`），再用 `science_delegate`
   拉起 midbrain 子会话，把实验 id 和任务交给它，并记下 `childSessionId`；后续评估、补测、结束用
   `science_wake` 唤醒同一个子会话，而不是反复创建。中脑领取后执行 `measure`。
3. 中脑评估：4/6 不足，执行带证据的 `supplement`，再评估到 6/6。
4. 中脑 `science_finish`，平台发布执行报告；全过程写入 `../../data/records.md`。

平台只判定数据完整性，不评价科学结论；任何结论必须引用真实 artifact id。

## 数据

- 运行时数据：`../../data/`（`platform/`、`instrument/`、`compute/`、`records.md`、`sidecar.log`）
- 仪器与计算的持久日志由各 Provider 自己持有；删除数据目录等于放弃当前实验室，需重新开始。
- sidecar 由插件自动启动，不需要手动运行；日志在 `data/sidecar.log`。

## Mars v0.6

Mars 使用 `mars` agent 配置，岗位由 `mars_login` 指定。上面的 science_* 采样演示和大脑/中脑/小脑限制不用于 Mars；所有岗位都能直接使用合法科研与物理工具。

- 默认实验有八个团队岗位 `brain`、`water`、`crops`、`agronomist`、`engineer`、`analyst`、`service`、`verifier`。团队全员登录后由 brain 启动。`single` 在独立对照世界兼任全部职责。每个会话绑定一个世界和岗位。
- delivery-v2 的各岗按收到的邮件、callId 或游标读取本次变化；其他版本在每次开始时读 `mars_inbox`、`round_receipts`、`mars_status`。用 `mission_read` 和 `research_catalog` 查公开任务、接口和合同。分页 `limit` 为 1–10。用 `contract=research_submit` 加 `task_id` 查看对应任务的槽位与 payload。登录后仅使用已注册 Mars 工具提供的公开数据。源码、隐藏 truth 和凭据由宿主保管。
- 历史归档已按原版生成，`mission_read.history` / `mars_status.history` 提供哈希和表行数。先 `archive_schema` 读表；`archive_query` / `archive_search` / `archive_stats` 分页检索，`archive_sql` 仅单条 SELECT/WITH；大数组在 `analysis_run` 中 await archiveSql 聚合。历史 tick<0，不能当作当前未知水或当前作物的实测证据。
- 研究写工具用 `input_json`（JSON 字符串）+ `request_key`；以 `research_catalog(section=contracts)` 为准。`model_register` 内部的 code 是同步函数体，return 有限 JSON；`analysis_run.code` 是异步函数体，可以 await 公开数据绑定。舱名用 `incubator-1` 至 `incubator-4`。
- 启动前完成加入和公开资料阅读。团队由 brain 调用一次 `mars_start`，single 自己调用。新局的专家收到各自的开局职责后即可推进本岗工作。Service 负责固定委托与母样留存，verifier 提供独立复测与验证计划检查。交接带上任务槽、已落账 ID、下一步和截止。正式决策从 tick 0 开始。
- 科研运行采用 `mars-v06-native-steps/1`：每个模型 step 都经宿主准入，相邻不同决策默认至少间隔 12 个逻辑 tick，重试复用同一步位置。共同参与者就绪后先提交本窗口意图，再推进世界；不能把一个界面对话回合当成一个实验轮次。
- 写操作返回 pending/callId；记录 callId，在下一步读 round_receipts。提交和等待下一决策窗口由宿主接管，不需要定时自唤醒，没有 mars_continue 工具。isError 是该次失败，需要修正，不可当作成功。
- 等待物理结果或邮件时用 `mars_wait({until_tick:节点})`，也可不填目标。它只因有效事件、新邮件或逻辑目标返回，过滤机械噪音与流程内部步骤，没有墙钟超时。任务没完成时继续工具循环，不要仅输出“稍后继续”便结束。
- `mars_send` 投递工作消息。Multi 交接已落账产物时可加 `request_key` 和 `handoff`（`taskId`、`slotId`、`references`），并在 `text` 写收件人的下一步。引用可包含模型、流水线、预测、计划、前瞻承诺、响应或证据，宿主核对实参并附上截止。`mars_inbox` 或在途 `mars_wait` 返回持久交接。重复使用同一发送者的同一请求键和内容会返回原消息 ID。相关环境事件和流程结果由宿主投递到原会话。
- `delivery-v2` 时，可按 `round_receipts(call_id=...)` 读本次结果，用 `receipt_work` 分配已发生的回执，用 `research_changes` 的两个游标读取新增事项。`service_review` 给出三份委托与已测原始母样。模型、计划、观测按 `kind` 选择后用 `research_submit(action=check_submit)` 在同一共同回合正式提交。`shared-plan-v3` 的 T2、T6 final 分别在同一未开工计划中选 `stepIds`，共同使用的操作只执行一次。
- 启用 `reviewed-v1` 或 `delivery-v2` 时，用 `research_draft` 读、修或提交当前任务草稿。verifier 从实际拒件邮件接手，Single 可直接修改。服务计划登记后，用 `service_review` 核对同组路线与返桩余量，在 T3 服务承诺中填写目标计划的 `reviewId`。
- `mission_read.stages.jointTrial=pilot-choice-v2` 时，T6 有两个槽位。720 前把 A/B 小试计划提交给 baseline。实际小试完成后用 `trial_pilot` 取得四个扫描操作引用，分析全基地 `energy.demand`，1800 前把所选方案和另两舱的验证计划提交给 final。精确字段见 `research_catalog(contract=research_submit,task_id=T6)`。
- 模型推理和上下文压缩时世界暂停，没有墙钟超时放行。所有参与者处于下个模型步的准入门、事件等待或空闲时才允许推进；全部空闲也可继续到环境事件，不要求一定存在物理操作。single 与 multi 使用同一决策时机规则。
- 压缩成功后先核对状态和回执，再继续原科研工具循环。摘要请求上下文过长失败时，宿主会记录岗位和 tick 到 `mars_status.round.recentCompactionFailures`，并通知团队的 brain 接管。原生工具调用的格式纠正沿用原决策窗口。
- `research_catalog({contract:"experiment_plan"})` 列出可进入计划的物理工具，加 `tool` 查看对应参数。计划步骤写 `{id,tool,args,at,dependsOn}`，登记时外层提供 `request_key`。未来样本引用使用声明前驱的 `$step:步骤:outputSampleId`。预检给出当前占用、预约冲突和时间下界，可用 `deadline_tick` 对照截止。`list` 查看作业状态和阻塞原因。
- `mars_stages.openSlots` 给出开放的提交槽位、截止 tick、`expectedRevision`、正式接纳记录和最新预测。`research_submit(action=check)` 查格式、引用和公开证据缺口，回执中的 `evidenceChecks` 按验证组列出缺项。正式提交用 `action=submit`，通过 `round_receipts` 确认 `revision` 和 `acceptedTick`。在截止前可基于当前 `expectedRevision` 修订。
- 八岗团队由 service 统一登记三项服务计划、承诺和实测，engineer 核对整组运输、返桩充电、设备位置和清洗窗口。agronomist 根据已接纳 ID 提交 T3。Single 也可用 `experiment_plan(action=portfolio, input_json=JSON.stringify({drafts:[...] }))` 联查多份草案；不带参数时检查已登记的在途服务。交接服务进度时使用 T3 的 `references:[{kind:"plan",id:planId,stepId}]`。宿主按发送时刻附上操作 ID、物理状态与阻塞原因；收件人可按 planId 读取最新进展。封存前 verifier 用 `research_catalog(section=references, task_id=...)` 协助任务负责人核对证据和正式提交回执。
- 服务计划填写 `service: {commissionId, measurementStepId, retentionStepId}`。预检在 `diagnostics.service` 给出同一原始母样的预计余量、到期时间及完成时间下界。登记后用 `prediction_commit` 锁定匹配委托和计划版本的 T3 承诺，宿主据此放行第一步。用 `experiment_plan(action=list)` 确认 `commitmentRecorded` 状态，随后将承诺纳入 T3 final。
- 720 前实际接纳 baseline，1800 前实际接纳 final。T4 前瞻承诺须早于首次计划动作。T2 final 引用的计划应安排封存后的处理与验证。DeepWorks 的 `pipeline_register` 和 `action_commit` 可直接调用。目录的 `x-mars-call.tool` 给出通用工具名。
- 1800 后宿主关闭新模型请求，继续允许的已接纳物理工作；2400 自动结算并向 brain/single 投递无模型回复的报告，不要求再用模型调用 finalize。
- `mars_procedures` 查询 water_assay/water_split 进度。`mars_checkpoint` 仅 brain/single 可调用，要求没有待提交意图、在途操作、未完成流程或计划；不能为等快照空耗临近截止时间。`mars_stages` 查看封印和缺失项，`mars_budget` 分世界记账。
