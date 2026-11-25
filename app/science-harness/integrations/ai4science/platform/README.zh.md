# AI4Science 智能体工具

[English](README.md) | 中文

## 接口参考

结果引用工具接受明确成员 ID 或唯一可见角色：`org_send_result` 使用 `target_id` 或 `target_role`；`org_authorize` 使用 `child_id` 或 `child_role`，以及 `peer_child_id` 或 `peer_role`。每个成员必须且只能提供一种选择方式，角色选择要求 `org_discover`；缺失或有歧义时报错，发现不授予权限。原生血缘、双方父节点同意和结果访问检查保留。普通消息与 inbox 等待使用原生 `send_message({agent,message})`、`list_agents`、`wait_agent({timeout_ms})`，等待返回 `{timedOut}`，最短 10000 毫秒；原 `org_message`、`org_wait` 已移除。

组织成员与配额按新鲜登记的原生根节点从持久事实恢复，旧 ID 和同意不带来授权。组合代码等待 `createOrganization`、`registerRoot`，同时提供两个事实钩子或使用宿主 storage-domain。参见[成员迁移指南](../upgrade-guide/v0.2.2-rc.1/organization-membership/README.zh.md)。

实验读取在一致快照下使用 schema-4 `experiment_view`，事实、审计与投影同事务更新。操作者通过 `archive` 命令按 `retentionDays`（默认 30）归档终态审计，主库和归档继续保持序号及权限检查，不移动通用事实与执行记录，也不查询活跃设备。参见[投影迁移指南](../upgrade-guide/v0.2.2-rc.1/experiment-projection/README.zh.md)。

`execution_facts(operations_only=true)` 返回可访问操作，不附项目历史；省略该字段保留完整响应。已知操作时使用 `execution_result(operation_id)` 直接读取。

[first-loop 场景](scenes/first-loop.ts)接受结构化参数：`scenario_submit(requestKey, phase, conditions, decisionId?)`、`scenario_analyze(operationIds, method, rationale)`、`scenario_choose_followup(branch, analysisIds, conditions, rationale)`。每个条件包含 `value` 和 `samples`。这些工具不再接受编码在 `request_json` 内的 JSON；参见[迁移指南](../upgrade-guide/v0.2.1-alpha.2/science-scene-tools/README.zh.md)。

`scenario_report(markdown, source_ids?)` 根据指向现有项目产物与操作输出文件的链接推导来源。项目路径会规范化为相对报告目录的路径，所有平台均使用正斜杠；输入也可以使用工具返回的本地路径。来源必须可访问且通过大小与哈希检查。显式 `source_ids` 必须是正文中有链接的产物 ID，不能是操作 ID。`project-artifacts/`、`artifacts/` 或 `../artifacts/` 下的失效链接会被拒绝。不评估科研结论正确性。

场景的 Loader 入口 `apply` 不返回安装对象；进程内组合使用 `mountScene`。场景专用的分支名称与实验阶段仍仅属于该示例。这些工具改动不引入固定团队人数、强制消息交流、模型请求预算或项目运行时限；执行和实验策略仍由各自配置管理。

## 可选角色 preset

角色可以通过 `preset` 选择 `ai4science-cerebrum`、`ai4science-midbrain`、`ai4science-cerebellum` 或自定义原生 preset ID。Profile 需要显式挂载原生 `agent-preset-registry` 并选择自己的默认值；[presets.patch.yml](presets.patch.yml) 仅添加三个可选声明。模板通过隔离的 `ai4scienceRoleDefaults` 服务推荐指令和工具，不规定模型提供方、Agent 数量、创建矩阵或树结构。参见[紧凑 preset 示例](examples/sampling.compact.presets.organization.json)，它与[显式角色示例](examples/sampling.compact.organization.json) 使用同一采样方法。

显式的角色 `instructions`、`tools` 替换模板建议，空工具列表也有效；模型字段逐项覆盖建议，未指定部分继承原生路由。不提供 `ai4scienceRoleDefaults` 的自定义 preset 必须显式声明指令和工具。无 preset 的角色继续要求显式指令、完整模型路由和工具白名单。`creates`、`maxInstances`、组织配额与 `relations` 仍需显式配置；Provider 权限继续来自宿主组合的 `roleProviders`。

在 Host Loader 激活完成后调用 `registerRoot`。登记在接纳组织工作前拒绝缺失、损坏或泄漏服务的 preset；从仍在加载的 Host 行调用会明确失败，避免等待自身激活。空白根节点可以选择角色 preset；已有 turn 的根节点必须已经保存相同身份。显式子节点 preset 使用原生 `agentPreset`，省略时保持原生继承。恢复核对已保存的 preset 身份及工具上限，拒绝移除、替换或扩大已有授权；原生冷恢复使用该 ID 的当前定义。角色覆盖仍受继承的 Host 限制约束，最终调用守卫覆盖 preset 局部工具并核对真实活跃成员。未授权局部工具可能仍显示在 schema 中，但不能执行。

## 执行读取与产物校验

`execution.ts` 负责公开授权、准入与生命周期协调；内部 `journal.ts` 负责 schema 迁移、短写事务、读取快照、审计访问和准备语句，`provider-runtime.ts` 负责 Provider 调用、观测、取消确认及真实调用结束后的锁释放。公开 API 与 schema 4 保持不变。准备语句归单个连接所有，仅缓存 SQL 程序；每次读取仍使用当前事实和权限。操作列表在一个快照内用两次查询取得操作与产物。参考 Provider 保持每次调用独立的连接生命周期。

操作台状态检查使用每个操作台独立持有的有界校验缓存。`artifactVerificationCacheEntries` 接受 0–100000，默认 1024，设为 0 禁用复用。复用核对真实路径、设备、inode、大小、纳秒 mtime/ctime 以及预期哈希和字节数；每次遍历仍检查当前访问权限、递归来源引用和真实路径。这依赖可靠的文件系统变更元数据，无法依赖时应设为 0。产物内容读取、下载、导出及发布时的来源验证始终读取并哈希字节。缓存不保存内容或授权；读取还会比较读前读后的描述符与路径身份。
