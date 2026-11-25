# Mars v0.5 实现与验收

v0.5 的运行、任务、记录、调度、评分、回放和研究面板已接入原生宿主。实现依据 [完整实施方案](../../../../docs/Mars_v0.5完整实施方案.md)。真实模型试跑按用户要求未执行；参数保留 `not_frozen`，不把工程测试写成科研优越性结论。

## 运行入口

安装时增加 `--benchmark-version v0.5`，其他 home、directory、mode 和凭据环境名参数沿用主安装器。新版本使用2400 tick，旧版基线不会混入。默认未指定版本时仍兼容v0.4。安装只生成环境和配置，不自动调用模型。

从harness工作目录执行类型检查和测试：

```powershell
& .\node_modules\.bin\tsc.cmd -p integrations/ai4science/mars/tsconfig.json --noEmit
& .\node_modules\.bin\vitest.cmd run --config integrations/ai4science/mars/vitest.config.ts
```

仅跑公开参考策略的真实物理验收，不调用LLM：

```powershell
& .\node_modules\.bin\tsx.cmd integrations/ai4science/mars/v05/feasibility.ts <private-truth.json> <new-output-directory>
```

离线重算使用安装器生成的 `mars-evaluate-*` profile；它按版本调用v0.5终局评测，不使用旧S公式。`collect-runs.py`按公开场景ID收集新版本原始分、分项、项目质量与成本，对照面板不将其与旧S*混合。

## 已实现的完整链路

| 范围 | 实现 |
|---|---|
| 任务与场景 | 18张任务卡，逐实体固定目标，100分私有manifest，来自真实模拟公式的盲测，历史标准/作物观测/能源研究接班资料 |
| 科研记录 | study、claim、commitment、精确版本依赖、证据用途、CAS、幂等、不可覆盖历史 |
| 模型与预测 | 不可变代码/参数/依赖哈希，宿主锁定时间，验证前提交，实际隔离子进程执行与输出Schema检查 |
| 数据支持 | 分析绑定记录实际数据访问；常量输出不能冒充数据分析；物理证据按任务/对象约束 |
| 同步轮 | 修改和分析先返回pending，边界确定性接纳；同轮成员共同开始，慢成员结束后才推进；下一轮读取round_receipts |
| 计划与资源 | 真实provider DAG、定时派发、容量与区间预约、活动预约到物理完成、取消不回滚、直接操作也检查预约 |
| 局部结果引用 | `$step:<id>:outputSampleId` 等引用只从成功前置步骤解析，真实采样后搬运无需预知生成ID |
| 恢复 | round意图/回执、决策位置、研究、预约、模型及预测入持久检查点；已提交轮恢复后进入下一轮，不重复执行 |
| 物理账本 | 样品采集、前处理、检测、结果发布时间及母样链；资源、体积、耗材、能量和操作状态 |
| 科学评分 | R50/K15/J15/O15/Q5，固定分母、逐目标证据、真实模型盲测、全输出复现、防事后选择预测 |
| 终局回放 | 精确计划版本及提案前模型，从实际终局SQLite分支推进500 tick，保留故障和库存，不改变源运行 |
| 回放科研判定 | 固定16作物预测目标并要求新扫描支持；只有操作完成率时科研分为0，运行约束另算 |
| 前端与报告 | 项目/研究版本/证据/模型/预测/预约/实际执行、v0.5对照与项目分、公开终局JSON及Markdown报告 |
| 信息隔离 | 真值、种子、探针和目标只存私有评测层；公开seed=0表示遮蔽，token不打印；界面只获公开事实和终局指标 |

## 使用约定

先调用 `research_catalog` 查看逐实体目标ID、公开接班资料、输入字段与模型输出字段。模型需要按契约返回字段和实体键，而不是一个无范围的标量。

修改工具返回pending代表意图已登记。下一轮使用 `round_receipts` 查看真实接纳结果，操作完成仍要查询物理状态。一个响应可以提交多个独立动作；依赖链使用计划DAG。

研究写入使用 `request_key` 与 `input_json`。例如：

```json
{"request_key":"water-state-1","input_json":"{\"id\":\"water-state\",\"expectedRevision\":0,\"kind\":\"study\",\"project\":\"PW\",\"content\":{\"question\":\"当前水质解释是否适用\"},\"reason\":\"开始当前验证\"}"}
```

PX-04提案的value为 `{planId,planRevision,modelId}`。planRevision必须指向提案之前存在的版本，modelId对应提案前注册的不可变模型。模型输入为 `{sensors,elapsedTicks:500}`，输出为 `{growth_increment_by_crop:{cropId:number}}`。没有模型只有扫描，不获得科研验证分；无效最新提案不会回退挑选旧的高分方案。

## 已取得的验收证据

完整回归30个测试文件、119项通过；包含停机重算、共享轮、失败冻结、重试耗尽恢复和私有信息隔离验收。测试使用真实执行引擎、MarsWorld、providers、原生Agent fixture和模型程序子进程，不调用外部LLM。

保留的公开参考闭环位于 `runs/v05/reference-public/feasibility-report.json`：真实推进2400 tick，三次检测及原始色谱分析，方法公告触发选择性修订，独立模型预测先锁定后验证。此轨迹64个操作成功、资源非负；该单项独立验证约0.924/1。它是水质与输入解释修订的闭环验收，不是完整100分结果。

六成员原生测试证明五个快成员等待慢成员再统一提交。恢复测试证明从已提交未推进的检查点续接不重复旧效果。500 tick测试证明故障保留、计划精确版本、提案后模型拒绝和源状态隔离。

## 冻结与研究边界

完整代码链路可执行，不代表全部科学任务已通过联合物理可行性与数值容差标定。当前参考验收明确标记 `fullCoreJointFeasibility:false`；不将单条闭环扩大为全部18卡可同时高质量完成的证明。

部分联合目标评价实际运行与恢复结果，具体含义在终局报告 `outcomeSemantics` 中说明，不能仅凭这些指标断言信息论价值或因果科学能力已获认证。终局生长预测容差0.15为候选值。

正式冻结仍需在开发场景上完成全项目联合资源/辨识性验收并固定容差；多智能体是否优于增强single需要真实模型配对运行。未做这些实验时保留候选状态，不根据预期分差调关卡。
