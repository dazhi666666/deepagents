# r6a 开局消息单

本单供 r6a 对照组单独开跑时使用。确认工作区已切到 `mars-multi-8-r6a`、`mars-single-8-r6a`、`delivery-v2` 和 `pilot-choice-v2` 后，重新打开 `E:\deepworks比赛\app\workspace`，新建八个团队对话和一个 Single 对话。当前开跑轮次的入口见[运行说明](mars-run-prompts.md)。

先将下面八条登录消息逐条发到各自的新对话。等团队八岗全部加入，再把 M-brain 第二条消息和 S-single 首消息相继发出。**Single 的首条消息会启动它自己的世界。**

## 八岗登录

**M-brain 首条**

```text
调用 mars_login(role=brain)，读取 mars_status 和 mission_read，核对本局为 delivery-v2、pilot-choice-v2。现在仅完成加入和公开资料阅读，结束本回合，等待我在这个会话发送启动消息。
```

**M-water 首条**

```text
调用 mars_login(role=water)，读取 mars_status 和 mission_read，重点了解 T1/T4、源水测量、校准与同一原始母样留存。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-crops 首条**

```text
调用 mars_login(role=crops)，读取 mars_status 和 mission_read，重点了解 T2 作物干预及 T6 的小试舱、验证舱和受控处理。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-agronomist 首条**

```text
调用 mars_login(role=agronomist)，读取 mars_status 和 mission_read，重点了解 T3 能源预测、服务承诺和 T6 两方案的增益与用能估计。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-engineer 首条**

```text
调用 mars_login(role=engineer)，读取 mars_status 和 mission_read，重点了解供电、用水、共享设备、机器人返桩与服务承诺复核。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-analyst 首条**

```text
调用 mars_login(role=analyst)，读取 mars_status 和 mission_read，重点了解 T5 跨项目模型、流水线和证据引用。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-service 首条**

```text
调用 mars_login(role=service)，读取 mars_status、mission_read 和 research_catalog(section=services)，识别三份委托的测量截止、留样要求和承诺。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

**M-verifier 首条**

```text
调用 mars_login(role=verifier)，读取 mars_status 和 mission_read，重点了解公开证据复核、草稿接手和正式接纳回执。现在仅完成初始化，结束本回合，等待宿主开局通知。
```

## M-brain 第二条消息

八岗全部登录后，发送到**本轮已登录的 M-brain 原对话**。

```text
开始 r6a。用 mars_status 核对 Multi 及八个岗位的实际绑定，核对 mission_read.stages 为 delivery-v2、pilot-choice-v2，八岗到齐后调用一次 mars_start。

你统筹 T6，与 crops 确认四个不同舱的同品种作物。两舱做 A/B 光照小试，另外两舱用于最终处理和对照。在 tick 720 前向 T6/baseline 正式提交未开工的小试计划与 pilot 声明。小试实际完成后，用 trial_pilot 的四条扫描、本局源水测量和对全基地 energy.demand 的分析比较两方案。按各槽位公开契约，在 tick 1800 前完成 T6/final 选案与验证计划，并安排验证期的基地养护。用 research_catalog(contract=research_submit,task_id=T6) 和 section=interfaces 查具体字段。

water、crops、agronomist、analyst 分别主责 T1/T4、T2、T3、T5。service 与 water 开局就读 service_review，协调三项按时测量及所测原始母样的终点留存。engineer 核对整组路线和设备，service 用当前 reviewId 锁定承诺，再把已接纳的承诺交给 agronomist。verifier 收到实际拒件时可直接接手。各岗自主推进公开科研工作，使用相同的合法科研工具。

写操作返回 pending 后按 callId 读 round_receipts(call_id=...)。有具体后续动作时在写入中附 follow_up，按 receipt_work 的工作 ID 读原结果、交接或完成。research_changes 使用上次返回的两个游标。研究提交可按 kind 选择 references，用 research_submit(action=check_submit) 在同一窗口正式提交，核对 acceptedTick 和 revision。思考与压缩暂停物理时间，相邻不同决策默认至少 12 tick。等待真实事件用 mars_wait。1800 后物理计划继续，2400 由 Host 结算。仅使用已注册 Mars 工具和公开资料。现在执行。
```

## S-single 首条消息

发送到**本轮新建的 Single 独立对话**，与团队开局尽量接近。

```text
开始 r6a。调用 mars_login(role=single)，读取 mars_status 和 mission_read，核对独立世界及 delivery-v2、pilot-choice-v2，阅读公开任务后调用一次 mars_start。你独立负责 T1–T6、三份服务与基地运转。

在四个不同舱选择同品种作物。两舱做 A/B 光照小试，另外两舱用于最终处理和对照。在 tick 720 前向 T6/baseline 正式提交未开工的小试计划与 pilot 声明，并推进其他可交付的 baseline。小试实际完成后，用 trial_pilot 的四条扫描、本局源水测量和对全基地 energy.demand 的分析比较两方案。按各槽位公开契约，在 tick 1800 前完成选案、验证计划和各项科研提交，并安排验证期的基地养护。用 research_catalog(contract=research_submit,task_id=T6) 和 section=interfaces 查具体字段。

开局就读 service_review，协调三项按时测量及所测原始母样的终点留存。核对整组路线、设备和返桩能量，用当前 reviewId 锁定承诺，将已接纳的承诺用于 T3。写操作返回 pending 后按 callId 读 round_receipts(call_id=...)。有具体后续动作可附 follow_up，在 receipt_work 读取结果并完成工作。research_changes 使用上次返回的两个游标。按 kind 选择 references，用 research_submit(action=check_submit) 在同一窗口正式提交，核对 acceptedTick 和 revision。思考与压缩暂停物理时间，相邻不同决策默认至少 12 tick。等待真实事件用 mars_wait。1800 后物理计划继续，2400 由 Host 结算。仅使用已注册 Mars 工具和公开资料。现在执行。
```
