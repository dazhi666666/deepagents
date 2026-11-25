/** Read-only laboratory comparison profile, using the existing Mission Control shell. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { startMissionControl } from '../../../mission-control/server.ts'

export const name = 'ai4science-laboratory-report'
export const inject = []
const count = z.number().int().nonnegative()
const rate = z.number().min(0).max(1).nullable()
const runSchema = z.object({ directory: z.string(), source: z.enum(['scripted', 'real-model']), mode: z.enum(['single-agent', 'multi-agent']),
  success: z.boolean(), tick: count, tasks: count, validDeliveries: count, operations: count, measurements: count, messages: count,
  evidenceValid: z.boolean().optional(), workflowCompleted: z.boolean().optional(), completionRate: rate.optional(),
  outcome: z.object({ status: z.enum(['running', 'completed', 'irrecoverable-material-loss']), terminal: z.boolean() }).optional(),
  assistance: z.object({ used: z.boolean(), interventionCount: count, autonomousCompletionRate: rate, completionRateAfterAssistance: rate }).optional(),
  allTaskCompletionTick: count.nullable(), meanTaskLatencyTicks: z.number().nonnegative().nullable(),
  operatorSubmittedOperations: count, perRoute: z.record(z.string(), z.object({ requests: count, inputTokens: count, outputTokens: count })),
  operatingMetrics: z.object({ powerOverloadTicks: count, waterUnavailableTicks: count, unsafeSampleTicks: count }),
  compactionEventsByRole: z.record(z.string(), z.object({ start: count, summary: count, end: count })),
  compactionContinuity: z.object({ pendingTaskOpportunities: count, verifiedPendingTaskClosures: count,
    failedCompactionAttempts: count.optional(), pendingTasksDuringFailedAttempts: count.optional() }).optional(),
  resources: z.object({ throughTick: count, anyOperationBusyTicks: count, twoOrMoreOperationsBusyTicks: count, peakConcurrentOperations: count }).optional(),
  repeats: z.object({ additionalSameRootMethodVersionMeasurements: count, identicalActionToolCallRepeats: count, requestKeysUsedWithDifferentArguments: count, invalidJsonToolArguments: count }).optional(),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean() })),
})
const reportSchema = z.object({ scope: z.literal('descriptive-laboratory-pair'), comparisonReady: z.boolean(), assistedEvidenceReady: z.boolean().optional(),
  matchingChecks: z.record(z.string(), z.boolean()), single: runSchema, multi: runSchema,
  scientificQuality: z.literal('not-assessed'), architectureAdvantage: z.literal('not-assessed') }).superRefine((report, ctx) => {
  const checks = Object.values(report.matchingChecks)
  if (report.comparisonReady !== (checks.length > 0 && checks.every(Boolean)))
    ctx.addIssue({ code: 'custom', message: 'Comparison readiness does not match its recorded checks' })
  const assisted = Boolean(report.single.assistance?.used || report.multi.assistance?.used) && checks.length > 0 &&
    Object.entries(report.matchingChecks).filter(([name]) => name !== 'no_operator_actions').every(([, passed]) => passed)
  if (report.assistedEvidenceReady !== undefined && report.assistedEvidenceReady !== assisted)
    ctx.addIssue({ code: 'custom', message: 'Assisted readiness does not match its recorded checks' })
  if (report.single.mode !== 'single-agent' || report.multi.mode !== 'multi-agent')
    ctx.addIssue({ code: 'custom', message: 'Comparison requires one Single and one Multi run' })
})
const configSchema = z.object({ reportFile: z.string().min(1), port: z.number().int().min(0).max(65535) }).strict()
export type Config = z.input<typeof configSchema>

/** Load one immutable comparison and mount a credential-free read-only view.
 * @param ctx Owning profile lifecycle.
 * @param input Saved comparison file and loopback port.
 */
export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = configSchema.parse(input), report = reportSchema.parse(JSON.parse(readFileSync(resolve(config.reportFile), 'utf8')))
  const mission = await startMissionControl({ laboratory: { snapshot: () => ({ mode: 'saved-report', comparison: report, events: [] }) } }, { port: config.port })
  ctx.effect(() => () => mission.close(), 'laboratory.report')
  console.log(`Mission Control: ${mission.launchUrl}`)
}
