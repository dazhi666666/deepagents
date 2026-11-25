# r6b 开局消息单

本轮同时启用岗位回执工作流 `delivery-v2` 和四舱联合计划 `shared-plan-v3`。在 DeepWorks 关闭旧工作区，再重新打开 `E:\deepworks比赛\app\workspace`。新建 **8 个团队对话和 1 个 Single 对话**。团队世界为 `mars-multi-8-r6b`，独立世界为 `mars-single-8-r6b`。

先发八条团队登录消息。M-brain 的第一次回复应从 `mission_read.stages` 读出上面两个版本。等八岗到齐，再发 **M-brain 第二条消息**，并在相近时间向 **S-single 发首条消息**。Single 的首条消息会启动它自己的世界。

## 八岗登录

**M-brain 首条**

```text
调用 mars_login(role=brain)，读取 mars_status 和 mission_read。请在回复里写出本世界的 researchWorkflow、jointTrial 和 tick，预期为 delivery-v2、shared-plan-v3 和 0。现在仅完成加入和公开资料阅读，结束本回合，等待我在这个会话发送启动消息。
```

**M-water 首条**

```text
调用 mars_login(role=water)，读取 mars_status 和 mission_read，了解 T1/T4、源水实测、校准和同一原始母样留存。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-crops 首条**

```text
调用 mars_login(role=crops)，读取 mars_status 和 mission_read，查阅 T2、T6 的公开契约，了解四舱布局、养护与验证步骤。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-agronomist 首条**

```text
调用 mars_login(role=agronomist)，读取 mars_status 和 mission_read，了解 T3 能源预测、服务承诺与 T6 两方案的生长和用能预测。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-engineer 首条**

```text
调用 mars_login(role=engineer)，读取 mars_status 和 mission_read，了解共享设备、机器人返桩、供电供水和全基地能源计量。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-analyst 首条**

```text
调用 mars_login(role=analyst)，读取 mars_status 和 mission_read，了解 T5 跨项目模型或流水线、预测及实际证据。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-service 首条**

```text
调用 mars_login(role=service)，读取 mars_status、mission_read 和 research_catalog(section=services)，核对三项委托的测量截止、留样及承诺要求。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-verifier 首条**

```text
调用 mars_login(role=verifier)，读取 mars_status 和 mission_read，了解公开证据复核、回执接手和 T2/T6 的 stepIds。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

## M-brain 第二条消息

发到**刚才已经登录 r6b 的 M-brain 原对话**。

```text
现在开始 r6b。核对 mission_read.stages 为 delivery-v2、shared-plan-v3，mars_status 中八个岗位都已加入后调用一次 mars_start。

你主责 T6，crops 主责 T2。先商定四个不同舱的同品种作物，用两个舱做 A/B 光照小试，另两个舱作最终处理和对照。tick 720 前登记未开工的小试计划并正式提交 T6/baseline，payload 包含 planId 和 pilot，核对 acceptedTick。各任务负责人同时推进自己的 baseline。小试成功后用 trial_pilot 取四条前后扫描。water 提供本局源水测量，engineer 和 agronomist 根据实际 energy.demand 分析全基地用能，按公开规则在 A、B 两个预测方案中选案。

在 tick 1800 前，你与 crops 商定一份尚未开工的全基地验证计划，由一位负责人登记一次，再把回执里的 planId 和分项步骤 ID 发给另一位。所有步骤安排在 [1800,2400)。T2/final 和 T6/final 分别正式提交，两份都引用同一 planId 和同一计划规格，各自的 payload.stepIds 列出该任务认领的步骤。T2 对四株固定作物安排实际有效的处理及随后的扫描，引用模型和预测。T6 提交 choice 并引用小试四条扫描、源水和全基地能源分析，纳入试验两舱的全部干预，包括预注册的对照养护。处理后在验证期最后四分之一扫描两舱。全基地养护和供电也要覆盖模型关闭后的时间。需要修订计划时，在截止前核对两项 final 都已引用最新规格。用 research_catalog(contract=research_submit,task_id=T2) 和 research_catalog(contract=research_submit,task_id=T6) 分别查槽位字段，并用 section=interfaces 查任务接口。

water 同时跟进 T1/T4，agronomist 跟进 T3，analyst 跟进 T5。service 和 water 开局读取 service_review，协调三份委托的测量及原始母样留存。engineer 核对整组路线与返桩，service 用有效 reviewId 锁定承诺并交给 agronomist。verifier 根据真实拒件接手复核。所有合法科研工具对各岗开放。

科研写入返回 pending 后按 callId 读 round_receipts(call_id=...)。需要后续动作时可附 follow_up，用 receipt_work 的工作 ID 接手或完成。research_changes 按上次的两个游标读取新增事项。按 kind 选择 references，用 research_submit(action=check_submit) 当窗正式提交并核对 revision 与 acceptedTick。仅用已注册 Mars 工具和公开资料。等待真实事件用 mars_wait，推理与压缩暂停时钟，相邻不同决策默认至少 12 tick。1800 后由已获准的物理作业继续，2400 由 Host 结算。现在执行。
```

## S-single 首条消息

发到**本轮新建的 Single 独立对话**。这条消息同时完成登录和开局。

```text
现在开始 r6b。调用 mars_login(role=single)，读取 mars_status 和 mission_read，核对独立世界为 delivery-v2、shared-plan-v3，调用一次 mars_start。你独立负责 T1–T6、三项服务和基地运行。

先在四个不同舱选择同品种作物，用两舱做 A/B 光照小试，另外两舱用于最终处理和对照。tick 720 前登记未开工的小试计划并正式提交 T6/baseline，payload 包含 planId 和 pilot，核对 acceptedTick。同时推进可交付的其他 baseline。小试成功后用 trial_pilot 取四条前后扫描，结合本局源水测量和对实际 energy.demand 的全基地用能分析，按公开规则在 A、B 两个预测方案中选案。

在 tick 1800 前登记一份尚未开工的全基地验证计划，所有步骤安排在 [1800,2400)。分别正式提交 T2/final 和 T6/final，两份都引用同一 planId 和同一计划规格，各自的 payload.stepIds 列出所用步骤。T2 对四株固定作物安排实际有效的处理及随后的扫描，引用模型和预测。T6 提交 choice 并引用小试四条扫描、源水和全基地能源分析，纳入试验两舱的全部干预，包括预注册的对照养护。处理后在验证期最后四分之一扫描两舱。全基地养护和供电也要覆盖模型关闭后的时间。需要修订计划时，在截止前核对两项 final 都已引用最新规格。用 research_catalog(contract=research_submit,task_id=T2) 和 research_catalog(contract=research_submit,task_id=T6) 分别查槽位字段，并用 section=interfaces 查任务接口。

开局读取 service_review，协调三份委托的按时测量、同一原始母样留存与运输返桩，用有效 reviewId 锁定承诺并纳入 T3。科研写入返回 pending 后按 callId 读 round_receipts(call_id=...)。可用 follow_up 和 receipt_work 处理后续动作，research_changes 按上次的两个游标读取新增事项。按 kind 选择 references，用 research_submit(action=check_submit) 当窗正式提交并核对 revision 与 acceptedTick。仅用已注册 Mars 工具和公开资料。等待真实事件用 mars_wait，推理与压缩暂停时钟，相邻不同决策默认至少 12 tick。1800 后由已获准的物理作业继续，2400 由 Host 结算。现在执行。
```
