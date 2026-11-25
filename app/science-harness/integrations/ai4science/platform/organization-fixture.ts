/** Platform organization tests use real Loader entries and allow assignment text after actor markers. */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as ScienceExtension from '../science/plugin.ts'
import { bootHost, toolValue as readToolValue, type HostCustomization, type Probe } from './test-host.ts'
import { HARNESS_BASELINE } from './version.ts'

export { branch, execute, Gate, lead, payload, ScriptedModel, signal, spawn, stored, text } from './test-host.ts'
export type { Probe, ScriptStep, Trace } from './test-host.ts'
export const revision = HARNESS_BASELINE

/** Read actual tool JSON, including failed tool content in platform diagnostics.
 * @param options Recorded model request.
 * @param callId Tool-call identifier.
 * @returns The parsed successful tool value.
 */
export function toolValue(options: GenerateOptions, callId: string): unknown {
  return readToolValue(options, callId, true)
}

/** Compose the platform host, optionally customizing source modules and their configs.
 * @param label Temporary-workspace label.
 * @param enabled Whether to mount cross-branch science exchange; defaults to true.
 * @param customize Optional workspace setup and module/config overrides.
 * @returns A real Loader host with owned teardown.
 */
export function boot(
  label: string,
  enabled = true,
  customize?: (root: string) => Promise<HostCustomization>,
): Promise<Probe> {
  return bootHost({
    label,
    workspace: 'platform',
    actorMarker: 'line',
    report: { baselineRevision: revision, enabled },
    modules: { 'science-ext': ScienceExtension },
    configs: {
      subagents: {},
      science: { project: 'cross-branch-project', provider: 'spawn', maxDepth: 3, crossBranchResults: enabled },
      'science-ext': enabled
        ? { scienceResultProject: 'cross-branch-project', scienceResultMaxPending: 8, scienceResultMaxPairs: 3 }
        : {},
    },
    omit: enabled ? [] : ['science-ext'],
    ...(customize ? { customize } : {}),
  })
}
