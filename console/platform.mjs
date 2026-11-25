#!/usr/bin/env node
/**
 * 启动 AI4Science 平台并开放 dashboard API。
 *
 * 控制台的“科研工作台”通过 /workspace/api/* 代理到这里。平台使用
 * console/platform.config.json 的本地配置（instrument 与 compute 两个 Provider）。
 *
 * 运行：node --experimental-transform-types console/platform.mjs [--port 8787] [--config <file>]
 * 输出一行 JSON：{"url":"http://127.0.0.1:8787","token":"..."}
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const port = Number(arg('port', process.env.DEEPAGENTS_PLATFORM_PORT || 8787))
const configPath = resolve(arg('config', process.env.DEEPAGENTS_PLATFORM_CONFIG || `${here}/platform.config.json`))
const platform = pathToFileURL(`${here}/../app/science-harness/integrations/ai4science/platform/`).href

const { openConfiguredEngine } = await import(`${platform}config.ts`)
const { startDashboard } = await import(`${platform}dashboard.ts`)

const { engine, config } = await openConfiguredEngine(configPath, 'controller')
for (const project of config.management.projects) {
  if (!engine.projects().some((item) => item.id === project)) engine.createProject(project, 10000)
}
const controller = new AbortController()
const dashboard = await startDashboard(engine, config, { port, refreshMs: 1000, signal: controller.signal })
process.stdout.write(JSON.stringify({ url: dashboard.url, token: dashboard.token }) + '\n')

async function shutdown() {
  controller.abort()
  try {
    await dashboard.close()
  } finally {
    await engine.close()
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
await dashboard.closed
await engine.close()
