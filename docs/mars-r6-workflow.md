# Mars r6 回执、提交与联合计划

Multi 和 Single 共享工具、作物目标、预算口径和物理时钟。每项新行为由实验配置选入。为区分工作流和任务效果，每对世界选同一行，使用新的数据目录。

| 配对 | `mars.researchWorkflow` | `mars.jointTrial` | 主要观察项 |
|---|---|---|---|
| 工作流对照 | `delivery-v2` | `pilot-choice-v2` | 服务回执到下一次有效决策的间隔、按时测量和留样、T6 基线接纳率、总 token 与耗时 |
| 联合任务 | `delivery-v2` | `shared-plan-v3` | 四株 T2 干预、T6 独立处理效果、终点存活、关键断供，以及两项任务共同使用的实际操作 |

两个版本字段进入协议身份。正式实验的封存时点仍为 720、1800、2400。每个不同科研决策经 Host 准入，相邻窗口至少 12 tick。比较时记录每个场景的成对分差，同时保留完成时间、达到共同目标的时间、账本 token、未封存比例和总分。等总 token 的对照另行报告。

### 准备新配对

第一组可选 `data/mars-multi-8-r6a` 和 `data/mars-single-8-r6a`，第二组可选尾缀 `r6b` 的两个新目录。使用原八岗登录流程，Multi 全员到齐后由 brain 启动，Single 在自己的会话中启动。以下是两组都能使用的开局要点，任务版本以实际 `mission_read.stages` 为准。

**团队开局重点**　water 与 service 开局先读三份委托，协调本局源水测量与留存。engineer 复核路线并提供能源分析，crops 与 brain 在 720 前封存 T6 小试。研究产物使用真实回执交给负责人，verifier 处理具体拒件。各岗用 `check_submit` 主动完成本槽位的正式提交。若启用 `shared-plan-v3`，两项 final 共同引用全基地计划，各自列出使用的步骤。

**Single 开局重点**　先核对任务版本，自主安排三项测量与留存、能源分析、小试与养护。使用相同的服务窗口、回执视图和当窗提交。720 前封存小试，1800 前从真实扫描、源水和用能证据中选择方案，并为余下验证期登记计划。

## 回执进入原岗位或替补

`analysis_run`、计划登记、模型与预测登记、科研提交等写入进入共同回合后，Host 记录原始 callId、任务、负责人、替补、截止 tick 和下一步。可在工具顶层提供 `follow_up`，例如：

```json
{"task":"service-1","next":"根据测量窗口核对留样位置并锁定承诺","backup":"engineer","beforeTick":1206}
```

同一负责人一次可收到一批已经落账的回执。正在推理或排队的岗位在原决策链读取；等待实际事件或空闲的岗位收到原会话邮件。取消后，尚未完成的事项转给指定替补。Single 的取消事项保存在原岗位，供恢复后读取。复核截止使用逻辑 tick。

- `round_receipts(call_id=...)` 读取这次写入的真实结果。
- `receipt_work(action=list)` 查看本人开放事项，可用 `role` 和 `offset` 查看同世界其他岗。
- `receipt_work(action=get,id=...)` 读取原结果。作者、现任负责人或指定替补通过 `include_input=true` 可同时取回原始工具输入。默认事项由负责人读取回执后移出待办，仍可按 pending 中的工作 ID 显式交接给下一岗。显式 `follow_up` 或手动交接的事项用 `done` 完成，或用 `handoff` 交给另一个已加入的岗位。两种写入都要给出 `id`、当前 `revision` 和 `request_key`；交接另给 `to` 和 `next`。
- `research_changes(cursor=...,device_cursor=...)` 分页读取新证据、提交、设备状态和阻塞。接着使用上次返回的两个游标。相同静态契约本岗首次读取返回全文，再次读取返回 `contractTag`，`refresh=true` 可重读全文。库存、服务和当前证据每次读取实时值。
- `service_review` 从开局显示三份委托、样本最早可保留至终点的采样完成 tick、及时实测结果及其同一原始母样的库存。water 与 service 据此协调取样，engineer 按计划版本检查运输。终局再核对实际保存质量。

## 当窗校验并正式提交

调用 `research_submit(action=check_submit,request_key=...,input_json=...)`。`references` 从 `research_catalog(section=references,task_id=...,slot_id=...)` 选择；每个观测还需选择科学用途。例如 T6/baseline：

```json
{
  "taskId":"T6", "slotId":"baseline", "expectedRevision":0,
  "references":[{"kind":"plan","id":"<已登记的小试计划>"}],
  "payload":{"pilot":{"arms":{"A":{"cropId":"crop-3-1","light":80},"B":{"cropId":"crop-4-1","light":50}},"treatmentCropId":"crop-1-1","controlCropId":"crop-2-1"}}
}
```

模型、预测、计划、承诺进入对应的 payload 字段，实测结果、操作、分析或笔记进入 evidence。选择本槽位的预测可以自动填写其已注册的模型或流水线。也接受完整的旧格式草稿；同时出现在 payload 与 evidence 的同一产物 ID 仅在不对应任何真实观测时去重。陌生 ID、字段冲突、过期版本和封存后的新请求返回拒件。替补可指定原 `rejectionId`、任务槽位和 `expectedRevision`，附上要修改的字段。格式和引用通过后，本次共同回合就记录正式版本，以回执中的 `acceptedTick` 和 `revision` 为准。

## 一份计划供 T2、T6 共同使用

`shared-plan-v3` 的小试沿用 r5 两阶段流程。准备 final 时登记一份尚未开工的全基地计划，把每一步安排在 `[finalTick,horizon)`。T2/final 和 T6/final 各自在 payload 里给出同一 `planId` 及本任务的 `stepIds`。重叠步骤可以是同一次灌溉或同一次扫描，物理系统只执行一次。任一计划规格修订后，应在 final 截止前使两个正式版本都引用新的哈希。

T2 选择针对固定株或其全舱的处理以及随后的扫描。T6 选择试验两舱的处理、对照养护和末段扫描，把对照舱的维持性灌溉事先写进计划。两舱额外干预仍会影响对照判定。其他舱的养护和供电作业可在同一份计划内单列。全基地总用能仍由验证期的实际电表测量。

报告的 `sharedPlan` 给出两项任务是否封存同一份规格、共同引用的操作数、去重后的操作数和全计划完成状态。`joint:sealed-plan` 要求同一冻结规格及通过 T6 验收。各固定株的终点生长、处理和复测仍单独评分。

## 已复演的故障

r5 的 T6 原稿在 tick 708 因计划 ID 重复出现在 evidence 被拒。隔离的内存回放使用同一份公开计划和另一个原始证据，新入口在 708 返回 revision 1，仍会拒绝额外加入的无效观测。432 tick 和标准 2400 tick 双世界正对照均完成 T2 四株干预并通过 T6，各有 16 株存活。标准时长的 T2 质量为 0.75325，17 项重叠步骤各执行一次，源水实测完成 1/3、原始母样终点留存 0/3，整体验收 F 未通过。在线报告的每个原字段均可离线复现。此处使用公开输入和相同脚本决策，真实模型的得分与成本由下一轮实测。

## 本地验证

下列脚本使用隔离世界或只读历史记录，均可从安装根目录运行。

```bash
node --experimental-transform-types demo/mars-delivery-regression.mjs
```

```bash
node --experimental-transform-types demo/mars-r6-submission-replay.mjs
```

```bash
node --experimental-transform-types demo/mars-reviewed-choice-regression.mjs --shared
```
