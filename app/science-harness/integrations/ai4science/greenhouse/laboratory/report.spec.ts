/** Saved laboratory reports preserve the recorded result without running devices or Agents. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Report from './report.ts'
const contexts: Context[] = [], roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('serves an immutable read-only pair and rejects invalid display counters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'laboratory-report-')); roots.push(root)
  const file = join(root, 'report.json')
  const run = { directory: '/fixture/single', source: 'scripted', mode: 'single-agent', success: true, tick: 10, tasks: 3, validDeliveries: 3,
    evidenceValid: true, workflowCompleted: true, completionRate: 1, outcome: { status: 'completed', terminal: true },
    assistance: { used: false, interventionCount: 0, autonomousCompletionRate: 1, completionRateAfterAssistance: null as number | null },
    operations: 8, measurements: 3, messages: 0, allTaskCompletionTick: 10, meanTaskLatencyTicks: 5, operatorSubmittedOperations: 0,
    perRoute: { scripted: { requests: 30, inputTokens: 0, outputTokens: 0 } }, operatingMetrics: { powerOverloadTicks: 0, waterUnavailableTicks: 0, unsafeSampleTicks: 0 },
    compactionEventsByRole: { lead: { start: 0, summary: 0, end: 0 } }, checks: [{ name: 'fixture', passed: true }] }
  const report = { scope: 'descriptive-laboratory-pair', comparisonReady: false, assistedEvidenceReady: false, matchingChecks: { both_real_model: false } as Record<string, boolean>,
    single: run, multi: { ...run, assistance: { ...run.assistance }, mode: 'multi-agent' }, scientificQuality: 'not-assessed', architectureAdvantage: 'not-assessed' }
  writeFileSync(file, JSON.stringify(report))
  const ctx = new Context(); contexts.push(ctx)
  const lines: string[] = [], log = vi.spyOn(console, 'log').mockImplementation(value => lines.push(String(value)))
  try { await ctx.plugin(Report, { reportFile: file, port: 0 }) } finally { log.mockRestore() }
  const launch = new URL(lines.find(line => line.startsWith('Mission Control: '))!.slice('Mission Control: '.length))
  const headers = { Authorization: `Bearer ${launch.hash.slice(1)}` }
  expect((await fetch(`${launch.origin}/mc/laboratory`)).status).toBe(401)
  expect((await fetch(`${launch.origin}/mc/laboratory`, { method: 'POST', headers })).status).toBe(405)
  const read = () => fetch(`${launch.origin}/mc/laboratory`, { headers }).then(response => response.json())
  expect(await read()).toMatchObject({ mode: 'saved-report', comparison: { comparisonReady: false, single: { validDeliveries: 3,
    evidenceValid: true, completionRate: 1, outcome: { status: 'completed' }, assistance: { interventionCount: 0 } } } })
  expect(existsSync(join(root, 'device'))).toBe(false)
  run.validDeliveries = 0; writeFileSync(file, JSON.stringify(report))
  expect((await read()).comparison.single.validDeliveries).toBe(3)
  run.operations = -1; writeFileSync(file, JSON.stringify(report))
  const invalid = new Context(); contexts.push(invalid)
  await expect(Report.apply(invalid, { reportFile: file, port: 0 })).rejects.toThrow()
  run.operations = 8; run.validDeliveries = 3; run.success = false; run.operatorSubmittedOperations = 1
  Object.assign(run.assistance, { used: true, interventionCount: 1, autonomousCompletionRate: 0, completionRateAfterAssistance: 1 })
  report.assistedEvidenceReady = true; report.matchingChecks = { shared_fixture: true, no_operator_actions: false }
  writeFileSync(file, JSON.stringify(report))
  const assisted = new Context(); contexts.push(assisted)
  const assistedLines: string[] = [], assistedLog = vi.spyOn(console, 'log').mockImplementation(value => assistedLines.push(String(value)))
  try { await assisted.plugin(Report, { reportFile: file, port: 0 }) } finally { assistedLog.mockRestore() }
  const assistedLaunch = new URL(assistedLines.find(line => line.startsWith('Mission Control: '))!.slice('Mission Control: '.length))
  const assistedRead = () => fetch(`${assistedLaunch.origin}/mc/laboratory`, { headers: { Authorization: `Bearer ${assistedLaunch.hash.slice(1)}` } }).then(response => response.json())
  expect((await assistedRead()).comparison).toMatchObject({ comparisonReady: false, assistedEvidenceReady: true,
    single: { assistance: { interventionCount: 1, autonomousCompletionRate: 0, completionRateAfterAssistance: 1 } } })
  const createView: (input: { api: () => Promise<object>, t: (value: string) => string, esc: (value: string) => string,
    num: (value: number) => string, available: () => boolean }) => { mount: (stage: object) => void } =
    runInNewContext(readFileSync(new URL('../../../mission-control/public/laboratory.js', import.meta.url), 'utf8').replace('export function', 'function') + '\ncreateLaboratoryView')
  const display = { innerHTML: '', textContent: '' }, stage = { innerHTML: '', querySelector: () => display }
  createView({ api: assistedRead, t: value => value, esc: value => value, num: String, available: () => true }).mount(stage)
  await vi.waitFor(() => expect(display.innerHTML).toContain('辅助对照条件通过'))
  expect(display.innerHTML).toContain('<td>人工介入次数</td><td>1</td><td>0</td>')
  expect(display.innerHTML).toContain('<td>自主阶段完成率</td><td>0%</td><td>100%</td>')
  expect(display.innerHTML).toContain('<td>人工介入后完成率</td><td>100%</td><td>—</td>')
  report.assistedEvidenceReady = false; writeFileSync(file, JSON.stringify(report))
  const inconsistent = new Context(); contexts.push(inconsistent)
  await expect(Report.apply(inconsistent, { reportFile: file, port: 0 })).rejects.toThrow('Assisted readiness')
})
