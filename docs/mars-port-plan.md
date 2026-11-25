# Mars v0.6 接入 DeepWorks：当前实现

在 DeepWorks 中运行六个固定角色与一个独立 single 对照，保留影响科研结果与比较公平性的核心规则。会话、消息和日志使用 DeepWorks 接口，不逐行复刻原有实现。操作入口见 [七会话提示词](mars-run-prompts.md)。

## 运行结构

- DeepWorks 1.5.x 内置 opencode 1.18.18，工作区默认 agent=mars。
- `app/workspace/.opencode/plugin/science.js` 承接模型步准入、工具 RPC、会话状态、压缩屏障和持久通知。
- `app/mars-server.mjs` 在 Node 24 中装配真实 V06World、Providers、ExecutionEngine、科学核心、分析与评分。
- `app/mars-host/host.mjs` 管理固定角色、NativeRounds、决策窗口、等待、消息、恢复和自动结算。
- `app/mars-host/history.mjs` 使用原版 make-data.py 和编译后 effective truth 安装全量只读历史库；公开 seed=0，答案留在私有 evaluator。
- `app/science/sidecar-rpc.mjs` 管理 NDJSON、进程退出、普通请求超时和可取消的长等待；模型步门控与 mars_wait 不设置墙钟超时。
- 两世界使用独立数据库、时钟、费用和封印，共用同一 truth/salt；模型网关保持 session 的 IP 粘性，七会话分配 2+2+3。

## 核心运行规则

| 项目 | 当前行为 |
|---|---|
| 协议标记 | mars-v06-native-steps/1；写入公开清单，拒绝混用旧协议数据 |
| 初始化 | 角色先加入与阅读公开资料；团队六人齐后 brain 调 mars_start，single 自己开始；费用记录照实，正式科研 step 从 tick0 开始 |
| 决策时机 | 每个模型 step 经宿主准入，不同决策默认至少间隔12逻辑tick；重试复用同一步位置；等待时世界已推进足够可在现tick继续 |
| 统一接纳 | 全员就绪后先提交本窗口意图，再推进共享世界；pending 后下一步读 round_receipts |
| 角色顺序 | brain/water/crops/agronomist/engineer/analyst 的固定排序参与轮转，避免随机 session ID 改变共享资源竞争顺序 |
| 模型屏障 | 推理和压缩时暂停世界，不设“忙够几分钟就放行”的例外 |
| 有效等待 | mars_wait 等有效物理事件、邮件或 until_tick；过滤机械噪音和流程内部步骤；无墙钟超时，取消删除远端等待 |
| 继续执行 | 工具返回后同会话的模型步自动进入宿主门控；已接受工作消息和相关环境通知恢复对应会话，持久去重；无 mars_continue 定时自唤醒 |
| 空闲推进 | 所有成员就绪或空闲时可推进到环境事件，不要求必须有在途物理操作；首窗口等待全部成员进入 |
| 科研与资源 | 原物理工具、研究模型/预测/提交、计划 DAG、校准、耗材、机器人、真实锁与证据规则保留；工具失败可恢复 |
| 历史资料 | 十张完整历史表，数据库哈希/表结构/行数校验；两世界同源；拒绝损坏、不完整或中途补库 |
| 阶段与终止 | baseline720、final1800、horizon2400；1800后关闭新模型请求，允许的已接纳物理工作继续，2400宿主自动结算 |
| 报告 | final-report.json 持久化，brain/single 收到 noReply 宿主报告，不为结算再生成模型请求 |
| 恢复 | 角色、邮件、意图与决策位置从账本恢复；已开始的局重开保持 suspended，控制者显式 mars_start 才恢复 |
| 费用 | 完成消息的用量增量按世界分账，在请求前检查累计上限；不等同于微美元预留的费用准入 |

## 验证入口

全部使用 keyless fixture；测试落在 demo/.checks/，不覆盖真实实验数据。

| 入口 | 验证内容 |
|---|---|
| demo/mars-native-regression.mjs | tick0/12、同一步重试、共同屏障、固定角色竞争、压缩、事件等待、停止准入、自动结算；--quick 只跳过长段阶段推进 |
| demo/mars-native-engine-regression.mjs <opencode> | 安装版真实引擎＋本地确定性模型：工具循环与科研请求的0/12/24/36窗口；不访问真实模型 |
| demo/mars-plugin-regression.mjs | 七个模拟客户端驱动真实桥接：初始化不自调用、角色/世界隔离、工具约束、用量、取消和请求钩子 |
| demo/mars-history-regression.mjs | 全量历史、十表行数、有效场景关联、查询/隔离分析、只读拒绝、检查点字节一致与恢复、损坏/中途补库拒绝 |
| demo/mars-run.mjs | 0→2400，T1 baseline/final 接纳、三阶段封印与 finalizer；常量模型不代表科研成功 |
| demo/mars-bootstrap-regression.mjs <opencode> | 真实引擎启动、工具注册、noReply消息与默认 agent；不生成模型请求 |
| demo/mars-prepare.mjs | 打开应用前生成两份历史库，不启动时钟或参与者 |
| demo/mars-preflight.mjs | 只读检查协议、tick0、未使用状态、历史一致性及密钥存在性，不读取密钥内容 |
| demo/reset-regression.mjs | 缺 truth/活跃 sidecar 时拒绝重置，成功重置保留旧数据 |

## 适配范围

- 两臂使用同一套科研决策时机和物理/评分内核；启动登记、通知展示与角色命名按 DeepWorks 控制面实现。
- 请求准入保证核心逻辑时间规则，不声称不同底座的所有工具包装、模型费用和上下文处理逐项完全相同。
- 费用依赖上游用量上报，尚无微美元预留与费用认证；配对检查验证安装与协议参数，不认证研究质量。
- 单链整局快照支持阶段回滚保护，历史数据库按原字节保存；分支 epoch 检查点链和跨分支交换尚未实现。
- v0.4 旧值班窗口、自由组织、campaign/installer 不属于本次固定角色 v0.6 工作流。仪表面板保持关闭。
