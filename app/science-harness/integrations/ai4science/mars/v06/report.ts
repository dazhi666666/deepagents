/** Public report contains outcomes and errors, never private case payloads or simulator state. */
import type { finalizeV06 } from './finalize.ts'
import type { V06Budget } from './budget.ts'
export function renderScientificReport(report: Awaited<ReturnType<typeof finalizeV06>> & { budget?: ReturnType<V06Budget['report']> | null }) {
  const number = (n: number) => n.toFixed(3)
  return ['# Mars v0.6 scientific candidate', '', `Completion: ${report.completionStatus}; stop reason: ${report.stopReason}; tick: ${report.tick}.`, '',
    `R: ${number(report.R)} / 100. Joint pass F: ${report.F}.`, '',
    '| Task | Quality |', '|---|---:|', ...Object.entries(report.q).map(([id, q]) => `| ${id} | ${number(q)} |`), '',
    'Operational outcomes remain separate from R.', '',
    `Alive crops: ${report.O.aliveCrops}/${report.O.cropCount}. Critical power shedding: ${number(report.O.criticalShedFraction)}. Water unavailable ticks: ${report.O.waterUnavailableTicks}.`, '',
    `Actual model cost USD: ${report.budget ? number(report.budget.actualUsd) : 'not applicable (keyless environment)'}. Unresolved reservations: ${report.budget ? number(report.budget.reservedUsd) : '0'}.`, '',
    `Joint conditions not satisfied: ${report.failureReasons.length ? report.failureReasons.join(', ') : 'none'}.`, '',
    `Case manifest hash: ${report.caseManifestHash}. Protocol hash: ${report.protocolHash}.`, '',
    'Candidate tolerances and thresholds require calibration. This result is not a frozen formal ranking.', ''].join('\n')
}
