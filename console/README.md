# DeepAgents 控制台

一个入口，左侧切换两个页面：

- 火星基地：任务控制中心（来自 mission-control 的火星变体），包含战报、沙盘、地图、能源、水、作物、科研交付、原始数据、分析、危机时间线、团队与对照。数据来自 `viewer/records/*.json`。
- 科研工作台：AI4Science Workspace 面板（来自 platform/dashboard），包含 Overview、Providers、Artifacts。需要平台后端；未接入时页面显示未启动提示。

## 启动

```bash
node console/server.mjs --port 2300
```

打开终端打印的 `http://127.0.0.1:2300/#<token>`，在左侧切换“火星基地”和“科研工作台”；`?tab=workspace` 可直接打开工作台。

- 科研工作台后端默认随控制台自动启动（`console/platform.mjs`），使用 `console/platform.config.json` 的本地 Provider 配置，数据写在 `console/runtime/`。`--no-platform` 可关闭，`DEEPAGENTS_PLATFORM_PORT` 可改端口。
- `MARS_STATE_URL`：指向运行中的 Mars sidecar（如 `http://127.0.0.1:18081/api/state`），战报的 tick、机器人状态与操作会改用实时值。
- `MARS_VIEWER_URL`：把 `/mc/mars/*` 代理到完整 Viewer API。
- `--record <file>`：指定任务控制中心使用的运行记录。
