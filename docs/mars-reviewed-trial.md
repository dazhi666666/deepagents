# Mars 共享提交与两阶段联合试验

八岗位和 Single 使用同一套工具、仪器、模型和逻辑时钟。工作流 `reviewed-v1` 与 T6 契约 `pilot-choice-v2` 可独立选择。要测量团队流程本身的效果，两组都先启用工作流并使用原 T6。要测量新任务，再给下一对世界同时选用两阶段试验。每对实验使用各自全新的 Multi 和 Single 目录。

## 下一对世界的配置

在新实验的 `science.json` 的 `mars` 对象中合并以下字段，保留现有模型、网关和世界来源设置。先用 `mars-prepare.mjs` 准备新目录，再用 `mars-preflight.mjs` 核对 `fresh`、`pairHistoryMatched`、`researchWorkflow`、`jointTrial` 和九个岗位绑定位置。正式模型实验使用 720、1800、2400 三个时点。真实模型的启动由操作者在 DeepWorks 的原角色会话中发起。

```json
{
  "home": "../../data/mars-multi-8-r5",
  "singleHome": "../../data/mars-single-8-r5",
  "researchWorkflow": "reviewed-v1",
  "jointTrial": "pilot-choice-v2"
}
```

## 共享草稿与复核

每个世界按 `task_id` 和 `slot_id` 共享一份草稿。`research_draft(action=read)` 返回最新草稿、最近被拒的直接提交、正式接纳版本和截止 tick。保存和提交先返回 pending，用 `round_receipts` 核对结果。检查失败的直接提交会保留可解析的原稿；Multi 的 Host 给 verifier 投递一封实际拒件通知。六岗由 brain 接收，Single 可以在同一槽位处理。

以 T2 为例，作者或 verifier 从 `lastRejection` 取 ID，从 `research_catalog(section=references,task_id=T2)` 选实际观测。调用 `research_draft(action=save,task_id=T2,slot_id=final,revision=0,request_key=...)`，`input_json` 用以下结构。替换占位符为本世界接纳的 ID。

```json
{
  "rejectionId": "<lastRejection.id>",
  "payload": {"predictionId": "<本槽位预测>", "planId": "<干预计划>"},
  "evidence": [{"id": "<已完成的作物扫描>", "purpose": "validation"}]
}
```

`payload` 按字段更新，选定已登记预测后可从记录补全模型或流水线。`removePayloadFields` 删除原稿多余的字段。`evidence` 替换整份证据。草稿的 `revision` 解决两人同时修改的冲突，`expectedRevision` 对应正式提交的已有版本。收到 `draft.problem=null` 后，以确切草稿版本调用 `research_draft(action=submit,...)` 并核对 `acceptedTick`。科学证据覆盖和预测质量仍由各任务独立评价。

`mars_stages.openSlots` 同时显示草稿版本、拒件和正式接纳回执。Multi 可用 `mars_send` 在 `handoff.references` 里填写 `{"kind":"draft","id":"T2/final","revision":2}` 交接确切版本。工程复核可填写 `{"kind":"service-review","id":"<reviewId>"}`，收件人会看到发送当时的第一条阻塞与截止。服务承诺接纳时 Host 再核对现场状态。

## 服务承诺

service 用 `experiment_plan(action=portfolio)` 联查草案，登记计划后由 engineer 或 Single 调用 `service_review`。它列出各计划的 `firstBlocker`、其余阻塞、建议项和截止余量。拿到目标计划的 `reviewId` 后，将它连同 `planId`、`commissionId`、`forecast` 写入 T3 的 `action_commit`。Host 在接纳时重新核算整组已登记计划的路线。返桩余量不足、电量不足、异地充电、路线不通或预计逾期会指明具体步骤。进入新计划、修订规格或撤销计划后重新读取复核结果。设备接收位置和清洗提示需要继续结合实际物理回执检查。

## T6 的基线小试与最终选案

1. 在 tick 720 前选择同一品种的四株作物，分别位于四个舱。两个舱用于 A、B 小试，另外两个用作验证期处理和对照。登记尚未开工的小试计划，并向 **T6/baseline** 提交 `planId` 及 `pilot`。每个小试舱在同一计划内用直接依赖连接前测扫描、该舱唯一的候选光照设置和后测扫描。设置完成到后测接纳至少相隔 12 tick。可在计划中安排养护灌溉。所有小试步骤在 720 到 1800 之间执行。
2. 小试完成后，`trial_pilot` 提供两株的扫描变化与四条操作 ID。用 `analysis_run` 分析本局 `energy.demand` 实测时序，结合源水实测资料，分别估计 A、B 在验证期的处理相对对照生长差和全基地总用能。增益可为负数或零。供电预算覆盖整个基地的 600 tick。
3. 在预算可行的候选中，选择预测增益最大的一个，同分选预测能耗较低者，再同分选 A。登记独立两舱的验证计划，在 **T6/final** 提交 `planId` 和 `choice`。证据包含四条小试扫描、当前源水测量和已完成的全基地用能分析。各槽的精确字段可查 `research_catalog(contract=research_submit,task_id=T6)`。
4. 1800 后，封存计划给处理株灌溉并设置选中光照，维持对照舱条件，在验证期最后四分之一且处理完成后扫描两舱。2400 的报告给出实际生物量增益、零效应参照误差、相对该参照的预测改进、能源预测绝对误差以及预算兑现情况。预测改进以生物量/tick 计，正值表示预测比零效应参照更准确。有实测效应时，预测检验要求误差严格小于零效应参照。实测和预测同时为零时，预测检验也通过。生产目标要求实际增益至少 0.02/tick。`R` 衡量 T1–T5，联合试验进入 `F`。

## 对比与复现

每对实验用相同任务版本、场景、归档、模型和工具。按场景记录 Multi 和 Single 的研发分 R、服务测量与母样留存、T6 小试与独立验证的完成情况、实际生长差、全基地用能、账本 token 和耗时。没有封存试验的世界计入完成率；对有有效受控终点的世界报告 `validatedForecastImprovement`。使用多个新场景比较成对分差，并单列相同总推理预算的配对结果。

从安装根目录运行脚本对照。每次 Host 试验使用 `demo/.checks` 中独立的新世界。完整测试在两个世界执行同样的公开决策，核对三次封存和离线报告。

```bash
node --experimental-transform-types demo/mars-reviewed-choice-regression.mjs --full
```

```bash
node --experimental-transform-types demo/mars-plan-service-regression.mjs --reviewed --portfolio
```

## 开局消息

八岗登录仍用原运行说明中的八条初始化消息。下列文本用于本版 Single 首消息和 brain 第二条消息，`mission_read` 返回所选版本的完整任务。

**Single 首消息**

```text
调用 mars_login(role=single)，阅读 mission_read 和 T6 的 baseline/final 契约，调用 mars_start。你独立完成 T1–T6 和三项服务。在 720 前封存 T6 两方案小试和可交付的其他 baseline。在 1800 前用 trial_pilot 的真实扫描、本局源水及全基地 energy.demand 分析选案，封存另一对舱的验证计划。用共享草稿和 service_review 处理提交、服务测量、同一母样留存与承诺。每项重要写操作从 round_receipts 确认。使用已注册的 Mars 工具，等待实际事件用 mars_wait，按 Host 时钟推进至结算。
```

**M-brain 第二条消息**

```text
核对八岗已加入并调用 mars_start。你负责 T6，立即与 crops 商定两舱小试和另外两舱验证。720 前提交 T6/baseline；小试完成后由 crops 提供四条真实扫描，water 提供源水实测，engineer 与 agronomist 核算两方案全基地总能耗和生长增益，1800 前提交 T6/final。water、crops、agronomist、analyst 分别跟进 T1/T4、T2、T3、T5 至正式接纳。service 和 water 协商同源取样和留存，engineer 复核全组路线，service 以准确 reviewId 锁定服务承诺。verifier 收到拒件后可直接读、修、提交同一版本草稿。只用已注册 Mars 工具，按真实回执交接，用 mars_wait 等实际事件，由 Host 在 2400 结算。
```
