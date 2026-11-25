# DeepAgents：DeepWorks 科学实验平台

DeepAgents 把实验账本、Provider 执行、产物溯源与数据完整性评估搬进 DeepWorks：
每个对话会话就是一个参与者，几个会话分别扮演大脑、中脑、小脑，在同一份持久账本上完成一次受约束的科研闭环。

Mars v0.6 默认用八角色团队与单 Agent 在两个独立世界完成 2400 tick 实验。新一对实验使用 [九会话运行提示词](docs/mars-run-prompts.md)。工作区默认 agent 为 `mars`。原六角色结果可用原目录和 `teamSize: 6` 核对。

[r6 回执、提交与联合计划](docs/mars-r6-workflow.md)介绍可分别启用的岗位接手、当窗提交和四舱共享计划，以及对应的配对验证命令。

[共享草稿与两阶段联合试验](docs/mars-reviewed-trial.md)介绍可选的 `reviewed-v1` 工作流、服务复核、`pilot-choice-v2` 基线小试与独立舱验证，以及对应开局消息。

火星沉浸式前端位于 [viewer/](viewer/README.md)：默认实验室局部，滚轮缩小查看基地全局，顶部悬浮入口查看科研与记录。双击 `viewer/打开火星实验室.cmd` 可打开独立页面；当前已内嵌结束的 Single 记录，Multi 结算后可只读导入。前端无需连接正在运行的实验。

## 先决条件

- DeepWorks 1.5.x（内置 opencode 1.18.18 引擎）
- Node.js 24+（sidecar 运行实验服务；用到 `node:sqlite` 与 `--experimental-transform-types`）
- Python 3（本机已验证 3.11；原版历史归档生成器仅使用标准库，可用 `SCIENCE_PYTHON` 指定解释器）
- 模型网关默认接实验室内网端点（`10.200.201.13/14/15:18000`，模型 `dsv4f-native`）；
  API key 放在 `data/secrets.json`（本地、已 gitignore），也可以用 `SCIENCE_API_KEY` 环境变量覆盖
- 不需要 key 也能跑 `demo/run-demo.mjs` 自检；只有真实对话会用到网关

## 目录

```
README.md                  本文件
UPSTREAM.json              版本标记（version.ts 读取）
app/
  science/                 实验服务（Node sidecar）
    platform/              执行核心：execution/experiments/journal/artifacts/
                           lifecycle/provider-runtime/config/sdk/version + 两个参考 Provider
    domain.ts              sampling 场景的评估与结束规则（去掉 cordis 包装）
    server.mjs             NDJSON RPC 服务：session -> 参与者，实验/操作/产物/记录
    llm-proxy.mjs          本地模型网关：会话粘性、故障转移、注入 key 与推理强度
  workspace/               DeepWorks 工作区（在 DeepWorks 里打开这个目录）
    opencode.json
    AGENTS.md
    science.json           sidecar 路径与系统提示
    .opencode/agents/      mars 科研配置，以及 cerebrum / midbrain / cerebellum 采样演示配置
    .opencode/plugin/      science.js 插件桥：注册 science_* 工具、携带真实 session 身份
console/                  任务控制中心：火星基地的战报、沙盘、能源、水、作物与科研视图
demo/
  run-demo.mjs             keyless 自检：两个会话跑完整实验闭环
docs/
data/                      运行时数据：secrets.json、实验账本、Provider 日志、records.md
```

整个目录要放在一起；`science.json` 里的相对路径按工作区计算。

## 在 DeepWorks 里运行

1. 打开 DeepWorks，把 `app/workspace` 添加/打开为工作区。
2. 新建对话。工作区提供三个 agent，可在 agent 选择器里切换（界面若只允许默认 agent 也能用，
   记录仍按 session 区分）：
   - `cerebrum`：读记录、登记实验、委派并唤醒执行者、解释产物
   - `midbrain`：领取实验、执行动作、评估、结束
   - `cerebellum`：只读核对操作与产物
3. 一次典型演示（两种方式）：

   **方式一：单对话自动委派（推荐）**

   **对话 A（cerebrum）**
   > 先用 science_status 看看当前实验。然后启动一个 goal 为“验证供水采样完整性”的实验，
   > 记下 experiment id，先用 science_experiment_release 释放控制权（否则执行方无法 claim），
   > 再用 science_delegate 让 midbrain 执行 measure，并记下返回的 childSessionId。
   > 然后用 science_wake 唤醒同一个子会话，让它评估、必要时 supplement，到 sufficient 后 finish，
   > 把实验 id、操作状态和 artifact id 回报给你。
   > 最后用 science_records 汇总，并用 science_artifact 读原始观测给出解释。

   第一次 `science_delegate` 会创建子会话；之后 `science_wake` 只是往同一个子会话里投新消息把它叫醒，
   不会再开新会话。子会话在 DeepWorks 里以 midbrain 身份运行，工具调用和记录都归到它自己的 session。

   **方式二：两个对话手动交接**

   **对话 A（cerebrum）**：`science_experiment_start` → `science_experiment_release`。
   **对话 B（midbrain）**：`science_status` 找到实验 → `science_experiment_act` measure →
   `science_assess` → insufficient 时说明依据并 `supplement` → 再评估到 sufficient → `science_finish`。

4. 记录落在 `data/records.md`，仪器/计算的真实日志在 `data/instrument/`、`data/compute/`；
   sidecar 日志在 `data/sidecar.log`。

## 模型网关

工作区的 `opencode.json` 把 `dspark/dsv4f-native` 指向 `http://127.0.0.1:18080/v1`，插件随引擎
启动 [llm-proxy.mjs](app/science/llm-proxy.mjs)，参数在 `science.json` 的 `llmProxy`。

- **会话粘性**：插件在每个模型请求上带 `x-dw-session: <sessionID>`，网关用 rendezvous 哈希把同一
  session 固定到同一台上游（13/14/15）；跨多轮、跨引擎重启都保持同一 IP，提高前缀缓存命中率。
- **均衡分配**：新会话优先落到当前会话数最少的节点，哈希只用于平局；7 个会话是 3+2+2。
  会话删除时插件调用网关 `/release` 释放配额，24 小时无活动也会自动过期。
- **故障转移**：响应头返回前的连接失败或 5xx 会换下一台，并把故障节点移出轮换 5 分钟；流已开始后中断则结束该请求，不在已输出的内容后拼接另一节点的答案。
- **密钥不落配置**：`opencode.json` 只有占位 key；真实 key 由网关从 `data/secrets.json` 读取
  （或 `SCIENCE_API_KEY` 环境变量）并注入请求头。
- **推理强度**：网关给所有 `/chat/completions` 请求补 `reasoning_effort: "max"`，可在
  `science.json` 的 `llmProxy.reasoning` 改。
- **输出上限**：`llmProxy.maxOutputTokens` 默认 30000；网关在实际 HTTP 请求中合并输出上限别名并钳制为更小值。`outputTokenField` 默认 `max_tokens`，也支持 `max_completion_tokens`。客户端指定的更小上限保留。
- **取消与诊断**：客户端取消或网关关闭会终止所属上游请求；日志记录实际输出上限、结束原因、原生工具调用数量及文本协议异常，不记录提示词或密钥正文。
- 网关只监听 `127.0.0.1:18080`；`GET /health` 返回节点、输出配置与在途数量，日志在 `data/llm-proxy.log`。
- 换 IP 或 key：改 `science.json` 的 `llmProxy.ips` / 替换 `data/secrets.json`，重启引擎即可。

## 无模型自检

```bash
node demo/run-demo.mjs
```

它用两个虚拟会话（cerebrum / midbrain）走完：登记 → 释放控制 → measure → 评估 4/6 不足 →
带证据 supplement → 评估 6/6 足够 → 发布执行报告 → 读产物与记录。失败会以非零码退出。
数据写在 `demo/.run/`，不污染 `data/`。

## 已验证

- 实验服务在 Node 24 + `--experimental-transform-types` 下正常运行（未改执行/事务/产物代码）。
- sidecar 的完整闭环：创建、领取、执行、等待、评估、补测、结束、产物读取、记录导出。
- 插件在引擎里加载成功（`opencode agent list` 能看到三个 agent；`opencode models` 启动时
  sidecar 正常拉起）；插件工具在 Bun 下可调用，并携带 `sessionID/agent` 身份。
- 同一实验的创建者（cerebrum）与执行者（midbrain）分离：创建者显式 `release` 后，执行者
  `claim` 并完成；记录保留双方 actor id。
- `science_delegate` 用 stub 客户端做了 keyless 验证：未知 agent 被拒绝、子会话以 `parentID`
  创建、prompt 带上目标 agent、返回子会话文本、被委派会话不能再委派。真实模型调用需要你在
  DeepWorks 里触发。
- `science_sessions` / `science_wake` 同样用 stub 验证：能列出子会话并标记可唤醒；唤醒复用原
  session id、不新建会话；被委派会话不能反过来唤醒别人；非本会话创建的目标被拒绝。
- 模型网关：7 个 session 首次分配为 2+2+3，重复请求全部保持原节点；7 个并发会话 2.97 s 完成；
  释放一个后 `/health` 计数回到 2+2+2，新会话落到空出的节点；把已宕机的 `.11` 放进上游列表时
  自动切到 `.13`（首次 4.1 s，之后 0.5 s）；`/health` 与日志正常。
- 引擎真实链路：`opencode run` 经网关返回 `OK`，日志记录 `ses_... 10.200.201.15 200`；
  同一 session 续聊两次仍走 `.15`，会话粘性跨引擎进程成立。

## 边界

- 没有实现组织配额、双亲同意、跨分支结果交换、Session 血缘和系统提示分层；
  角色由 DeepWorks 的 agent 配置表达，实验控制权用显式 release/claim 交接。
- 没有实现 v0.6 的模型费用准入（微美元预留）；DeepWorks 用自己的模型与额度。
- `science_*` 采样演示只评估数据完整性；Mars 使用独立的 v0.6 科学核心和 R/O/F finalizer。费用台账与请求前累计限额按世界分开，但仍不等同于微美元预留的费用准入。
- sidecar 使用独立 Node 进程（opencode 引擎跑在 Bun 上，Bun 不支持 `node:sqlite`，实测报
  `ERR_UNKNOWN_BUILTIN_MODULE`）；这是有意的隔离，不是临时绕路。
- 未做多工作区共享一个 sidecar；同一工作区重复启动引擎时，旧 sidecar 会随 stdin 关闭退出。
- 委派只允许一层（被委派的会话不能再委派），默认 5 分钟超时，超时会 abort 子会话；
  子会话使用工作区默认模型，会计入 DeepWorks 自己的用量。
- 模型网关是单进程本地服务：同时跑多个引擎实例时，先启动的进程持有 18080，后来的实例复用它；
  先退出的引擎会带走网关（插件通过 stdin 关闭退出）。IP 健康状态是进程内记忆，重启后重新探测。
- `data/secrets.json` 只是本地文件；Windows 上的权限位不保证 0600。把目录发给别人前先删掉它。


## Mars v0.6（已接入）

工作区挂载 Mars v0.6 的两个世界。各会话先用 `mars_login(role)` 绑定岗位，然后调用公开工具操作所在世界的实验室。

- `mission_read` / `research_catalog` 提供委托、任务、接口和合同。`section=interfaces` 加 `task_id` 可读取模型输入与输出的机器可读结构。T3 附带自造天气序列与负载示例，预测时长由 `weatherFactors` 的长度给出。按 `contract` 查询工具参数，`research_submit` 合同可按任务查看槽位与截止。
- `research_write` / `model_register` / `prediction_commit` / `research_submit`：研究与提交；模型注册前校验同步函数体和支持的 schema，成功落账后用 `model_test` 检查自己提供的公开 JSON 输入；自检不读取隐藏案例，也不认证科学质量；
- `research_read`：按 `id` 查笔记、模型、流水线、预测或前瞻承诺，重名时用 `kind` 指定类型；提交用 `kind=submission, task_id, slot_id` 和可选 `revision` 查询。无参数仍返回总览；
- `water_*` / `greenhouse_*` / `robot_*` / `device_*` 等：真实物理动作，世界在操作进行时推进；
- `water_assay` / `water_split`：一键跑完整水质检测/分样流程，步骤仍走真实设备和机器人；`sample_id` 支持 `s-N` 短引用，新建和恢复流程都先解析为完整 ID。不存在的样本在创建流程前拒绝，恢复时遗留的缺失样本流程结算为失败，不拖停世界时钟；
- `mars_inbox` / `mars_send` 提供持久角色邮件。结构化交接可附上已落账的模型、同槽预测、计划、承诺与证据，以及宿主计算的截止。`request_key` 支持发送者重试同一条交接。`mars_wake` 异步激活闲置同伴，忙碌时仅投递邮件，并发唤醒合并成一个回合。`mars_wake_status` 查询运行状态。
- `mars_start`：brain/single 在登记完成后启动或显式恢复科研运行，团队五个岗位由宿主激活；`mars_wait` 以有效物理事件、邮件或 until_tick 让出屏障，没有墙钟超时；定时自唤醒工具 mars_continue 已移除；
- `experiment_plan` 支持公开工具步骤 `{id,tool,args,at,dependsOn}` 和底层步骤 `{id,providerId,input,at,dependsOn}`。用 `research_catalog({contract:"experiment_plan",tool:"water_sample"})` 查看参数。预检会核对方法耗材、机器人载样数、资源占用和时间下界。登记需提供 `request_key`。`list` 可读实际作业和阻塞原因。
- 服务计划在 `input_json` 中填写 `service` 对象，指定 `commissionId`、`measurementStepId` 和 `retentionStepId`。预检在 `diagnostics.service` 追溯测量与原始母样，报告预计余量、寿命和最早完成 tick。登记后以 `prediction_commit` 锁定对应委托和版本的 T3 承诺，调度器据此放行第一步。通过 `commitmentRecorded` 核对进度，将承诺引用纳入 T3 final。开工前修改计划后需要锁定新版本的承诺。
- `mars_stages` 返回当前 tick、开放槽位的截止与接纳记录、同槽最新预测和阶段封印。`research_submit(action=check)` 的 `evidenceChecks` 按验证组提示当前公开证据是否齐备。由 `action=submit` 的回执确认正式接纳。2400 时宿主生成 final-report.json 并向 brain/single 投递 noReply 报告。

队伍全员登录后由 brain 调用 mars_start。新局的专家通过原开局通知收到负责的交付项。Single 自己启动。调度版本为 `mars-v06-native-steps/1`。宿主准入每个科研模型 step，相邻不同决策至少间隔 12 tick，重试复用同一步位置。全员就绪后先接纳本窗口意图，再推进共享世界。写操作返回 pending 后在下一步读 round_receipts。意图按固定岗位顺序轮转。

例如 step0 提交校准意图，宿主在 tick0 统一接纳并推进到12，step1 才读取回执；不是先让世界走到11再启动设备。如果 mars_wait 已经让世界推进足够，后续决策可直接使用当前逻辑位置，不再机械补一段墙钟等待。初始化只开放公开准备资料，科研查询和动作在启动后执行。

全局模型屏障在推理和压缩期间暂停本世界，没有墙钟超时放行。忙碌状态采用引擎事件和每个世界独立的确认快照，取消 2 秒过期标记与空闲轮询；宿主主动推送控制状态和待投递通知。`mars.controlRetryMs`（默认 250）与 `controlRetryMaxMs`（默认至少 5000）只控制既有持久通知在传输失败后的指数退避，不产生科研轮次。发送结果不明时先核对已存消息，不盲目重复激活。

上下文溢出由引擎自动压缩后重试，不关闭团队准入；重试沿用失败步骤的决策位置。压缩成功后释放辅助屏障，下一次主请求收到留有审计记录的继续指令。Mars 的辅助摘要请求输出上限为 4096 token。摘要请求因上下文过长失败时，宿主记入 `mars_status.round.recentCompactionFailures`，并向团队的 brain 发送接管通知。工作区的压缩触发预留为 20000 token。工作区兼容层同时适配两种 session.get 参数格式，不修改已安装的 DeepWorks 文件。普通文本中出现已声明工具的完整 DSML 错误封套时，仅诊断并允许同一步纠正一次；不执行文本参数，不因普通停止或摘要定时续跑。

不可恢复的模型错误或预算耗尽仍会关闭对应世界的模型准入并进入结算。控制传输或物理时钟故障单独报告为基础设施故障：失败时钟会结束已有等待，并拒绝新的推理、写入和等待，不记成模型失败。mars_wait 使用与原版相同的有效事件过滤，抑制机械噪音和流程内部步骤；工作消息、相关环境事件在同一持久会话中继续，并按已存消息去重。所有成员空闲时也允许推进到后续环境事件，不依赖一定存在操作需求；只有真正的事件和请求触发科研决策，没有固定间隔的自唤醒消息。

baseline 在 720 前实际接纳、final 在 1800 前实际接纳。1800 后关闭新模型请求，允许的已接纳物理工作继续到 2400，宿主自动封存并结算。标题由角色直接命名，工作区不调用额外标题模型。

r4 的数据和日志在 `data/mars-multi-8-r4` 与 `data/mars-single-8-r4`，共同场景输入在 `data/mars/truth.json`。两组均采用 T6 成对生长试验 `paired-growth-v1`。角色、邮件、意图和决策位置随账本恢复。恢复已开始的实验时由原 brain 或 single 调用 `mars_start`。

无模型全流程验收：

```bash
node demo/mars-run.mjs
```

它用六个角色跑完 0→2400 tick：登记 T1 baseline/final、写入 720/1800/2400 三段封印、调用 finalizer
输出 R/O/F。当前样例模型是常量桩，所以 R=0、F=false，失败原因按评测真实列出；换成真实研究后会变。

## Mars 检查点

`brain` / `single` 可调用 `mars_checkpoint` 生成当前 tick 的完整快照，要求没有待提交意图、在途操作、未完成流程或计划。快照用 SQLite `VACUUM INTO` 逐个复制数据库，跳过时钟锁和日志。每个世界单独使用 `<home>.phases.jsonl` 和 `<home>.phase-seals.jsonl` 保存外部封印；另一世界的进度不会阻止本世界恢复。自动快照默认每 240 tick 尝试，忙碌时延后到安全 tick。

恢复必须先退出 DeepWorks（或确认 Mars sidecar 已停止）：

```bash
node app/mars-checkpoint.mjs list --home data/mars-multi-8-r4
```

```bash
node app/mars-checkpoint.mjs restore <checkpoint-id> --home data/mars-multi-8-r4
```

恢复会拒绝任何“晚于快照”的已发布阶段封印，避免回滚 baseline/final/horizon；被替换的运行保留在
`data/mars.before-restore-<时间>`。这是整局快照，不是 v0.6 的多检查点链。

### 八角色团队与 Single 的九会话实验

`mars.dual: true` 和 `mars.teamSize: 8` 使用 `home: ../../data/mars-multi-8-r4` 与 `singleHome: ../../data/mars-single-8-r4`。`mars_login` 将八个团队岗位绑定到共享团队世界，将 `single` 绑定到独立世界。`service` 负责三项服务及留样，`verifier` 负责独立复测和验证计划检查。两臂分别管理 tick、账本和封印，使用配对的场景输入。

`mars.teamSize: 6` 对应原六角色世界。每局的顺序写入 `manifest.public.json` 的 `roles`，旧六角色清单可按其原编制打开。改变编制时为两臂配置一对独立的新目录。

旧写法（只跑一种模式）仍可用：`dual: false` + `mode: "multi"` 或 `"single"`，两种运行放在不同目录、用同一份 truth 和同一个 salt：

```json
"mars": { "mode": "single", "home": "../../data/mars-single", "truth": "../../data/mars/truth.json", "salt": "<保持不变>" }
```

单 Agent 运行只需一个会话 `mars_login(role: "single")`，它拥有全部工具。切换模式或目录后重启 DeepWorks。
每次启动会写 `manifest.public.json`（mode/truthHash/saltHash/stages），不同模式不能复用同一目录。

配对可比性检查：

```bash
node app/mars-pair.mjs data/mars-multi-8-r4 data/mars-single-8-r4
```

两种模式的 truth、salt、阶段、场景、案例、协议、模型配置和历史归档哈希都一致时输出 `comparable: true`。支持清单中的 multi-agent/single-agent 模式名；缺历史哈希的旧局不会被标成完整可比。

## Mars 实时面板（默认关闭）

面板默认不启动（`mars.dashboard: false`）。需要时在 `science.json` 设为 `true` 并重启：

- 多 Agent 世界：<http://127.0.0.1:18081>
- 单 Agent 对照：<http://127.0.0.1:18082>

页面每 2 秒刷新，显示 tick/horizon、当前阶段、阶段封印、在线角色、机器人位置与电量、最近操作。
端口可在 `mars.multiPort` / `mars.singlePort` 改；端口被占用时 sidecar 会记录错误但世界继续运行。

## Mars 离线评分

停止 DeepWorks（或确认 Mars sidecar 已退出）后，可以对已完成的运行做只读复算：

```bash
node --experimental-transform-types app/mars-evaluate.mjs --home data/mars-multi-8-r4 --truth data/mars/truth.json
```

输出 `<home>.evaluation.json`，与在线 `mars_finalize` 使用同一 finalizer 和封印；无模型 2400 tick 样例已逐字段比较 R/O/F/completionStatus 一致。常量模型样例的 R=0、F=false，验证的是协议与评分链路，不代表完成了科研任务。

## 下次全新实验的准备检查

退出 DeepWorks 后只读检查配置和干净运行目录（不读取密钥内容、不访问模型、不创建世界）：

```bash
node demo/mars-preflight.mjs
```

需要重置旧局时先检查，再保留备份并重置：

```bash
node demo/reset-all.mjs --check
```

```bash
node demo/reset-all.mjs
```

重置会先验证 truth 与运行状态，在临时目录准备好要保留的文件，再替换运行目录；缺 truth 或 sidecar 尚在运行时不会移动旧数据。重置后、打开 DeepWorks 前，准备完整历史库：

```bash
node demo/mars-prepare.mjs
```

随后运行 mars-preflight，要求 ready、fresh、pairHistoryMatched 全部为 true。准备阶段使用原版 make-data.py、编译后 effective truth 和原配置的数据规模；不会创建参与者或推进物理时钟。两个世界各持有一份经哈希和行数校验的只读库，public manifest 的 seed 为 0，评测答案留在各自 `.evaluator`。运行中缺归档、归档损坏或内容不匹配时会拒绝启动，不会中途补写不同的历史数据。测试全部落在 `demo/.checks/`，不污染真实运行。

可重复的无模型检查：

```bash
node --experimental-transform-types demo/mars-interface-regression.mjs
```

接口闭环回归覆盖按类型读取产物、提交版本、注册前语法/schema 拒绝、公开输入上的模型/DAG 自检、超时取消、隐藏评分隔离和逻辑时间不变。自检使用已接纳产物，例如 `model_test` 的 `input_json` 为字符串 `{"modelId":"m-v1","inputs":[{"x":1}]}`；`executionValid` 不替代科学验收或提交回执。

```bash
node demo/mars-regression.mjs --quick
```

```bash
node demo/mars-plugin-regression.mjs
```

```bash
node demo/reset-regression.mjs
```

```bash
node demo/mars-history-regression.mjs
```

历史归档回归覆盖同源全量生成、十表行数与哈希、公开 seed 隐去、私有答案隔离、历史工具与 analysis_run、只读拒绝、检查点字节一致及恢复，以及损坏/不完整/中途补库的拒绝。

`mars-native-regression` 和 `mars-plugin-regression` 可加 `--eight` 验证八角色配对，缺省使用六角色兼容配置。原生回归的 `--quick` 覆盖开局准入、职责通知、同一步重试、共享屏障和恢复。完整回归另外验证阶段封印及自动结算。桥接回归验证会话绑定及事件转发。回归使用隔离目录和模拟模型。

控制推送、时钟故障、同一步纠错、计划与网关的专项验收：

```bash
node demo/mars-control-regression.mjs
```

```bash
node demo/mars-busy-sync-regression.mjs
```

```bash
node demo/mars-model-retry-regression.mjs
```

```bash
node --experimental-transform-types demo/mars-planning-regression.mjs
```

```bash
node --experimental-transform-types demo/mars-plan-service-regression.mjs --portfolio
```

加 `--single` 在单会话世界执行相同的服务日程。回归检查开工前的承诺、按期测量、母样留存和承诺在 T3 中的封存。`--commit-only` 可以单独核对承诺和服务步骤的交接回执。

`experiment_plan(action=portfolio)` 联查多份服务草案及已登记的作业。`research_catalog(section=references)` 以任务槽位为单位列出证据、产物和最近一次接纳。T6 的 `paired-growth-v1` 试验规则见[九会话提示](docs/mars-run-prompts.md#t6-成对生长试验配置)。以下回归在两个隔离世界执行同一套实物干预，核对封存报告和离线重算。加 `--full` 使用 720、1800、2400 三个正式时点。

```bash
node --experimental-transform-types demo/mars-joint-trial-regression.mjs
```

```bash
node demo/mars-proxy-regression.mjs
```

这些夹具分别验证忙碌确认与跨世界独立、真实长批次中的控制响应、故障等待释放与新请求拒绝、原决策位置的单次纠错和显式停止、计划阻塞去重与历史短引用、实际 HTTP 输出上限与流取消。网关测试只连接临时本地上游，并强制使用假 key；所有运行目录位于 `demo/.checks/`。完整修复说明与本机验收记录见 [2026-11-17 工程修复记录](docs/mars-engineering-repairs-20261117.md)。

安装版引擎的模型步与结束通知测试：

```bash
node demo/mars-native-engine-regression.mjs 'E:/deepworks/resources/sidecars/opencode-x86_64-pc-windows-msvc.exe'
```

它只连接本机确定性模型，验证工具循环进入0/12/24/36等逻辑窗口、final后无模型请求及noReply报告。`--context-overflow` 注入一次 HTTP 400，验证成功压缩后的同窗恢复。`--fail-compaction` 验证真实辅助请求使用摘要上限，并检查压缩失败的审计记录及结算。`--text-tool-error` 验证同窗工具格式纠正。`--managed-plugin <已安装的 deepworks-compaction-inject.js 路径>` 与压缩选项合用，验证实际 DeepWorks 插件不再请求未解析的 `{id}` 路径，文件本身不修改。该夹具使用短阶段验证边界；自定义阶段只允许 model-source=scripted-integration，真实模型入口仍使用720/1800/2400，完整时窗由 mars-run 和完整 native-regression 验收。

安装版引擎启动验收使用 `demo/mars-bootstrap-regression.mjs <opencode-executable>`：在隔离目录启动真实引擎、加载插件、注册 Mars 工具，并提交 `noReply:true` 的消息检查默认 agent，不生成模型请求。测试会复制已安装依赖到隔离目录。插件初始化只查询 Node sidecar，返回 hooks 后才读取引擎的会话状态，避免启动时的循环等待。`mars-engine-check` 另检查 agent 发现与默认配置。

## 任务控制中心

```bash
node console/server.mjs
```

打开终端打印的 `http://127.0.0.1:2300/#<token>` 链接，左侧切换“火星基地”和“科研工作台”。火星视图读取 `viewer/records/single-v06.json`，设置 `MARS_STATE_URL` 可接运行中的 Mars sidecar；科研工作台后端由控制台自动启动。
