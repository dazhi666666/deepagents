/** Optional loopback dashboards over the current execution API and Mars viewer. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { HARNESS_BASELINE } from '../../../../science-harness/integrations/ai4science/platform/version.ts'
import { startDashboard } from '../../../../science-harness/integrations/ai4science/platform/dashboard.ts'

interface MarsPage { url: string; launchUrl: string; close(): Promise<void> }
/** The project-local page is optional and loaded only when its port is configured. */
async function startMarsPage(upstreams: { science: { url: string; token: string }; mars: { viewer: { origin: string; token: string; runId: string } } },
  options: { port: number; harnessUrl?: string; runsIndex?: string }): Promise<MarsPage> {
  const page = await import(new URL('../../mission-control/server.ts', import.meta.url).href)
  return page.startMissionControl(upstreams, options)
}

interface ControlInput {
  engine: ExecutionEngine
  directory: string
  port: number
  projects: string[]
  providers: string[]
  /** Viewer API of this run; the Mars panel proxies it with a server-side bearer. */
  viewer?: { origin: string; token: string; runId: string }
  /** Origin of the execution dashboard, without its launch token. */
  harnessUrl?: string
  /** Static index of settled runs for the comparison view. */
  runsIndex?: string
}

/** Merge one launch link into the run's control record without dropping the other panel. */
function record(directory: string, key: 'harness' | 'mars', launchUrl: string) {
  const path = join(directory, 'mission-control.json')
  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) existing = value as Record<string, unknown>
    } catch (error) { /* An unreadable optional launch record is replaced. */ }
  }
  delete existing.launchUrl
  writeFileSync(path, JSON.stringify({ ...existing, [key]: { launchUrl } }), { mode: 0o600 })
}

function dashboard(input: ControlInput, port: number, signal: AbortSignal) {
  return startDashboard(input.engine, {
    apiVersion: 1, enabled: true, baseline: HARNESS_BASELINE, directory: join(input.directory, 'execution'),
    providerCallTimeoutMs: 10000, pollIntervalMs: 1000,
    management: { actorId: 'mission-control-viewer', projects: input.projects, allowedProviders: input.providers },
    providers: [{ module: 'mars-runtime', config: {} }],
  }, { port, refreshMs: 1000, signal })
}

/** Start the maintained execution dashboard; the retired router is not required. */
export async function startHarnessMissionControl(input: Omit<ControlInput, 'viewer' | 'harnessUrl'>) {
  const abort = new AbortController()
  const control = await dashboard(input, input.port, abort.signal)
  try {
    record(input.directory, 'harness', control.launchUrl)
    return { url: control.url, launchUrl: control.launchUrl, close: async () => { abort.abort(); await control.closed } }
  } catch (error) { abort.abort(); await control.closed; throw error }
}

/** Start the Mars panel with authenticated execution and viewer reads, without a router upstream. */
export async function startMarsMissionControl(input: ControlInput & { viewer: { origin: string; token: string; runId: string } }) {
  const abort = new AbortController()
  const control = await dashboard(input, 0, abort.signal)
  let page: Awaited<ReturnType<typeof startMarsPage>> | undefined
  try {
    page = await startMarsPage({ science: { url: control.url, token: control.token }, mars: { viewer: input.viewer } },
      { port: input.port, ...(input.harnessUrl ? { harnessUrl: input.harnessUrl } : {}), ...(input.runsIndex ? { runsIndex: input.runsIndex } : {}) })
    record(input.directory, 'mars', page.launchUrl)
    const mounted = page
    return { url: mounted.url, launchUrl: mounted.launchUrl, close: async () => {
      try { await mounted.close() } finally { abort.abort(); await control.closed }
    } }
  } catch (error) {
    try { await page?.close() } finally { abort.abort(); await control.closed }
    throw error
  }
}
