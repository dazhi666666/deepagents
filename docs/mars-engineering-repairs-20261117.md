# Mars v0.6 工程修复与隔离验收

日期：2026-11-17。适用范围：DeepWorks 1.5.3 / opencode 1.18.18 的工作区插件、Node sidecar、研究与计划接口、本地模型网关。本文记录复盘后修复的当前实现；原始观察保留在 [实验复盘](mars-run-postmortem-20261117.md)。

## 修复结果

| 问题 | 当前行为 | 主要实现 |
|---|---|---|
| 忙碌同步被长请求拖住、确认状态失真 | NDJSON 请求直接复用连接并发发送；每个世界独立合并 busy 快照，成功确认后才更新 accepted 状态。取消 2 秒过期标记；引擎事件优先于迟到的初始 REST 快照。长物理批次让出 I/O，但保持模型准入屏障。 | [sidecar-rpc.mjs](../app/science/sidecar-rpc.mjs)、[mars-control.mjs](../app/science/mars-control.mjs)、[Host](../app/mars-host/host.mjs) |
| 高频 status/notices 轮询与通知重投 | sidecar 主动推送带 revision 的控制快照。通知确认前读取引擎真实消息并关联 messageId；响应丢失时先核对落盘，不盲目重发。两个世界分别排空自己的通知。 | [mars-server.mjs](../app/mars-server.mjs)、[science.js](../app/workspace/.opencode/plugin/science.js) |
| 压缩结束后未释放屏障，或继续输出摘要 | 处理实际 session.compacted 事件；先确认释放辅助模型屏障，再移除压缩标记。压缩请求不注入主科研执行提示，首次恢复的主请求收到已写审计的继续指令。上下文溢出重试复用原步骤。 | [science.js](../app/workspace/.opencode/plugin/science.js) |
| DeepWorks 压缩插件请求 `%7Bid%7D` | 工作区对注入 SDK 的 session.get 同时适配 path.id 和 sessionID，拒绝冲突标识，dispose 时还原。已使用实际安装的压缩插件验证；未编辑安装目录。 | [opencode-client-compat.mjs](../app/science/opencode-client-compat.mjs) |
| DSML/invoke 工具标记留在普通文本里 | 只识别未引用、包含已声明工具名和完整关闭标记的错误封套。先核对持久化 assistant 消息确实没有原生工具部分，再允许一次原步骤格式纠正。文本参数从不执行；普通 stop、摘要或引号内例子不产生自动续行。 | [mars-model-format.mjs](../app/science/mars-model-format.mjs)、[Host](../app/mars-host/host.mjs) |
| 取消与通知投递竞态 | 显式停止按 cancellationId 去重，撤销该会话尚待激活或当前通知；已取消通知不能在稍后重新进入推理。普通 EOS 保留真实的待激活通知和格式核验屏障。 | [Host](../app/mars-host/host.mjs)、[science.js](../app/workspace/.opencode/plugin/science.js) |
| 配置写了 30000，但真实上游请求仍可带 32000 | 网关统一输出 token 别名，按配置和调用方较小值钳制实际 HTTP 请求；默认规范字段 max_tokens，也支持 max_completion_tokens。非法上限返回 400，不转发。 | [llm-proxy.mjs](../app/science/llm-proxy.mjs)、[science.json](../app/workspace/science.json) |
| 取消后上游仍在计算、流中断被当成可拼接重试 | 客户端取消及网关退出会销毁所属上游请求。只在响应头返回前切换节点；流已开始后中断会结束本请求。响应字节及编码头保留；观察器只提取有界诊断，不改答案。 | [llm-proxy.mjs](../app/science/llm-proxy.mjs) |
| 时钟故障后等待永不返回，基础设施错误被归成模型失败 | 发布独立的 clock.failure 控制状态和故障审计；已有准入门拒绝、事件等待带 failure 返回。Host 拒绝故障后的新推理、辅助模型、写意图、等待及推进；只读诊断仍可用。不会因此调用 model.close(model_error)。 | [Host](../app/mars-host/host.mjs)、[science.js](../app/workspace/.opencode/plugin/science.js) |
| 坏样本流程持久化后拖停世界，合法短引用恢复失败 | 新建前解析短引用并校验存在性；恢复时再次解析旧短引用，遗留缺失样本流程结算为失败。合法旧流程继续使用原记录，不改写历史。 | `procedures.ts` |
| 计划长期重复阻塞，没有可用反馈 | check/schedule 校验真实物理输入、设备、样本归属、体积与过期状态。暂时占用记录步骤 blocked；永久无效结束为 partial_failed 并给出 failureReason。相同原因不逐 tick 重写；变化通知计划所属岗位。 | `planning.ts`、`planning-tools.ts` |
| 计划引用解析或静态校验误伤合法工作 | 只解析步骤 input 中的物理引用，不改步骤 id/dependsOn；声明前驱的 $step 输出可延迟解析，伪造占位文本不能绕过检查。同 key 重放先返回原回执；修订只重验尚未接纳的工作，已接纳步骤仍不可改写。 | `planning.ts`、`planning-tools.ts` |
| 已接纳模型读不到、不可执行代码到评分才暴露 | research_read 按产物类型和提交版本读取；model_register 在落新账前校验同步函数体、外层 return、大小和支持的 schema；model_test 用原隔离执行器测试调用方公开输入，并约束整个请求的时间、输出与取消。旧产物和同 key 原回执保留。 | `research-read.ts`、`model-test.ts`、`records.ts` |

## 调度和数据约束

- 仍使用 mars-v06-native-steps/1。科研推理前由 Host 准入，不同决策默认至少间隔 12 个逻辑 tick；同一步重试不占新窗口。
- 思考和压缩不折算成 tick，不给角色单独时钟，不根据墙钟自动发“继续”。正常停止后的工作仍由真实消息、环境事件、有效等待或用户请求触发。
- controlRetryMs=250、controlRetryMaxMs=5000 只对已经存在的持久通知进行传输退避；不是新的科研决策定时器。空闲且没有通知时不轮询。
- 固定六角色团队与 single 的独立世界比较保持原样；两个世界均已开始后，不允许额外未绑定 Mars 会话默认进入模型调用。
- 真实运行的 720/1800/2400 封存边界保持不变；1800 后不放新模型，2400 由 Host 结算。短阶段仅用于 model-source=scripted-integration 的隔离验收。
- model_test 不读取隐藏案例或私有目标，不写科学证据，不推进物理 tick；executionValid 只说明公开输入上的执行和声明 IO 合法。

## 隔离验收记录

全部检查使用本地确定性输入或假模型；没有新增付费上游调用、没有准备或启动新正式实验。夹具 home 位于 demo/.checks，与 data/mars-multi、data/mars-single 分离。

| 检查 | 验证内容 | 结果 |
|---|---|---|
| mars-control-regression | 忙碌确认、失败保留 accepted 快照、跨世界独立、无空闲轮询、响应丢失去重、实际安装压缩插件的 SDK 兼容、普通文本/引用例子不触发纠正 | 通过 |
| mars-busy-sync-regression | 实际挂起的 wait、600 tick 物理批次期间的控制响应；仅向夹具注入时钟故障，验证已有等待释放及新请求拒绝 | 通过 |
| mars-model-retry-regression | 一步只纠正一次、通知 ACK 后仍保留准入位置、普通 EOS 与显式停止的区别、取消通知不能重入 | 通过 |
| mars-plugin-regression | 七个模拟会话驱动真实桥接；迟到 REST 不覆盖新事件、无逐次 REST 同步、压缩/费用/取消/跨世界错误隔离、固定角色约束 | 通过 |
| mars-interface-regression | 注册前校验、跨类型读取与提交版本、公开模型/DAG 自检、超时取消、哈希损坏独立报错、旧产物幂等兼容、截止边界 | 通过 |
| mars-procedure-regression | 新缺失样本拒绝、旧坏流程结算、当前 runId/tick 续接、新旧短引用、历史事实不改写 | 通过 |
| mars-planning-regression | 样本与未来输出引用、阻塞去重、失败通知、旧计划恢复；资源变化后的同 key 重放和未来步骤修订 | 通过 |
| mars-proxy-regression | 实际出站字段和上限、小上限保留、非法请求不出站、分片 UTF-8/SSE 字节一致、流故障、取消与关机清理、回环上游切换 | 通过 |
| mars-native-regression --quick | 0/12 决策、共同屏障、压缩暂停、固定角色竞争、取消、持久意图/身份/邮件/决策位置恢复 | 通过 |
| mars-native-regression（完整） | 720/1800/2400 阶段、1800 后拒绝主模型和压缩、2400 自动结算 | 通过 |
| 安装版引擎 + context-overflow + text-tool-error + 实际 managed plugin | 真引擎收到本地 HTTP 400 后压缩；未污染压缩提示；错误文本含写动作但没有执行；原步骤只纠正一次；后续窗口与 noReply 报告正常 | 通过 |

安装版组合用例的主决策位置为 [0,12,24,36]；溢出、压缩和格式纠正均位于 12。原生物理操作总数为 1，错误文本里的 screen 校准没有进入执行。实际 DeepWorks 压缩插件已执行，日志没有 %7Bid%7D。短阶段于 60 关闭模型，84 投递无需回复的报告，真实模型调用数为 0。

完整原生调度用例 native-5S7Ln7 已到达 2400 并 finalized；三段封印实际为 [720,1800,2400]，previousSealHash 链接一致。另检查了 24 个源码/测试文件的语法、science.json 的 JSON 解析和 32 个文档本地链接，均通过。所有隔离夹具进程已退出，没有遗留测试 sidecar 或引擎。

计划回归的第一次启动命令遗漏 --experimental-transform-types，Node strip-only 模式因此拒绝参数属性语法，尚未执行测试；补齐与 sidecar 相同的启动参数后通过。README 已使用正确命令。

可复现命令见 [README 专项验收](../README.md)。组合引擎验收命令：

```bash
node demo/mars-native-engine-regression.mjs E:/deepworks/resources/sidecars/opencode-x86_64-pc-windows-msvc.exe --context-overflow --text-tool-error --managed-plugin C:/Users/user/AppData/Roaming/com.deepexi.deepworks/deepworks-engine-data/config/opencode/deepworks-plugins/deepworks-compaction-inject.js
```

## 已完成实验的完整性

两个原运行仍在 tick 2400，runId 与原结果一致。修复后重新按字节计算 final-report.json 的 SHA256，均与修复前记录相同。

| 世界 | runId | R | F | 报告 SHA256 |
|---|---|---:|---|---|
| multi | 81712321-7afa-4539-9c40-3bcf4153cd2f | 1.6666666666666667 | false | ad8c1ca97763989f7fbcf7f6ad8c9634c397d69622a9c722bb9d6a46ee070fdc |
| single | 01b44445-1215-4e53-8c97-67fe27458055 | 0 | false | 58b101560403f91d0450d37cd7a2d0b623ec7e9820672733fa58718be1f06d6b |

未重新评分、回滚阶段、重写封存证据或重置正式数据。原复盘中的中途维修、非等额推理用量和 candidate_not_frozen 等实验条件也未被这次源码修复追溯消除。

## 生效方式与验收范围

新代码和 science.json 在下次引擎及其所属 sidecar/网关重新加载后生效；本次没有对已完成运行做新的热补丁或自动续跑。测试覆盖本机安装引擎和工作区桥接，不包含新的真实 dsv4f-native 兼容探测。

格式纠正只针对可确认的文本协议错误，压缩恢复指令也不能保证模型永远不输出摘要或提前停止。可执行自检不能保证科学质量、计划设计或按时提交成功；这些仍由真实证据、阶段封印和 finalizer 判定。此次没有修改科研答案、评分权重、正式标定状态或两个世界的预算条件。
