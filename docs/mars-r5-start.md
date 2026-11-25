# r5 开局消息

在 DeepWorks 重新打开 `E:\deepworks比赛\app\workspace`。新建八个团队对话和一个 Single 对话。Multi 使用 `mars-multi-8-r5`，Single 使用 `mars-single-8-r5`。登录后的 `mission_read.stages` 应显示 `researchWorkflow=reviewed-v1`、`jointTrial=pilot-choice-v2` 和 720/1800/2400 三个时点。

## 八个团队对话的首消息

各对话先发送对应一行，完成加入后等待。Brain 的正式启动消息放在下一节。

| 岗位 | 首消息 |
|---|---|
| M-brain | 调用 mars_login，role=brain，再读 mars_status 和 mission_read，核对这是 r5 的 pilot-choice-v2。现在完成加入和公开资料阅读，结束回合，等我发启动消息。 |
| M-water | 调用 mars_login，role=water，再读 mars_status 和 mission_read，重点读 T1/T4、源水实测与同一母样留存。初始化完成后结束回合，等待宿主开局通知。 |
| M-crops | 调用 mars_login，role=crops，再读 mars_status 和 mission_read，重点读 T2 与 T6 两方案小试。初始化完成后结束回合，等待宿主开局通知。 |
| M-agronomist | 调用 mars_login，role=agronomist，再读 mars_status 和 mission_read，重点读 T3、两方案生长与能源预测。初始化完成后结束回合，等待宿主开局通知。 |
| M-engineer | 调用 mars_login，role=engineer，再读 mars_status 和 mission_read，重点读 service_review 与全基地 energy.demand 遥测。初始化完成后结束回合，等待宿主开局通知。 |
| M-analyst | 调用 mars_login，role=analyst，再读 mars_status 和 mission_read，重点读 T5 模型或流水线、证据和正式接纳。初始化完成后结束回合，等待宿主开局通知。 |
| M-service | 调用 mars_login，role=service，再读 mars_status、mission_read 和 research_catalog(section=services)，确认三项服务的测量、留样与承诺。初始化完成后结束回合，等待宿主开局通知。 |
| M-verifier | 调用 mars_login，role=verifier，再读 mars_status 和 mission_read，重点读 research_draft 复核、提交版本与受控验证。初始化完成后结束回合，等待宿主开局通知。 |

## M-brain 第二条消息

八个岗位都完成登录后，把整段发送到本轮 M-brain。

```text
现在开始 r5。先读 mars_status，核对 requiredRoles 的八个岗位都已加入，调用一次 mars_start。你负责 T6，与 crops 商定四株同品种作物。用两个舱做 A/B 光照小试，另外两个舱用于最终处理和对照。720 前提交 T6/baseline，先封存未开工的小试计划。小试完成后用 trial_pilot 的四条真实扫描、water 的本局源水测量、engineer 与 agronomist 对全基地 energy.demand 的分析作出选择，1800 前提交 T6/final 和另一对舱的验证计划。精确字段与选择规则用 research_catalog(contract=research_submit,task_id=T6) 和 section=interfaces 查询。

water、crops、agronomist、analyst 分别负责 T1/T4、T2、T3、T5，跟进到正式接纳。service 与 water 协商同源取样和原始母样留存，工程岗位用 service_review 核查整组路线，service 用准确 reviewId 锁定承诺，agronomist 据此提交 T3。verifier 收到拒件邮件后可直接用 research_draft 读、修和提交同一槽位的草稿。用 mars_stages 查看草稿版本、缺项与正式回执。每次写操作以 round_receipts 为准。

所有岗位只用已注册 Mars 工具及公开数据，按实际邮件、设备回执和 Host 时钟推进。每个不同科研决策默认相隔至少 12 tick。等待有效事件用 mars_wait。1800 后由物理作业继续，2400 由 Host 结算。现在执行。
```

## S-single 首消息

把整段发送到本轮独立的 Single 对话，与团队开局时间尽量接近。

```text
现在开始 r5。调用 mars_login，role=single，核对独立世界和 mission_read.stages 的 reviewed-v1 与 pilot-choice-v2，阅读任务后调用 mars_start。你独立负责 T1–T6、三项服务和基地运转。用两个舱做 A/B 光照小试，另外两个舱用于同品种作物的最终处理和对照。720 前提交 T6/baseline，先封存未开工的小试计划，同时推进可交付的其他 baseline。小试完成后用 trial_pilot 的四条真实扫描、本局源水测量和全基地 energy.demand 分析选择方案，1800 前提交 T6/final 和另一对舱的验证计划。精确字段与选择规则用 research_catalog(contract=research_submit,task_id=T6) 和 section=interfaces 查询。

三项服务一起排程，安排按时测量与同一原始母样的终点留存。用 service_review 核查整组路线，使用当前计划的 reviewId 锁定 T3 服务承诺，按实际回执提交。用 research_draft 保存和修订各任务草稿，用 mars_stages 区分预测、草稿和正式提交。每次写操作以 round_receipts 为准。

只用已注册 Mars 工具及公开数据，按实际设备回执和 Host 时钟推进。每个不同科研决策默认相隔至少 12 tick。等待有效事件用 mars_wait。1800 后由物理作业继续，2400 由 Host 结算。现在执行。
```
