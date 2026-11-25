/** Analysis role line of the scripted reference: the eight archive questions (A1-A8) answered from the read-only history
 * database with logged query IDs, exactly the evidence rule the tool enforces. Answers come from the archive's own raw
 * rows — corrections applied, missing readings excluded, duplicate rows removed, legacy Fahrenheit and the clock
 * migration converted — never from hidden truth.
 */
import { z } from 'zod'
import type { ReferencePolicy, RoleStep } from './policies.ts'
import type { TaskId } from './deliverables.ts'

type Row = Record<string, unknown>
const num = (value: unknown) => (typeof value === 'number' ? value : Number(value))
const SOL_SECONDS = 88775, TICK_SECONDS = SOL_SECONDS / 96, MIGRATION_TICK = -20000, MIGRATION_EARTH = 1_700_000_000

export const ANALYST_STEPS: readonly RoleStep[] = [{ kind: 'deadline', run: archive }]

/** One archive question per decision, before the campaign deadline. */
async function archive(p: ReferencePolicy, tick: number) {
  if (!p.deps.archive?.sql) return
  for (const question of QUESTIONS) {
    if (p.done.has(question.task) || p.state[`archive:failed:${question.task}`] || tick > p.deadline(question.task)) continue
    const answer = question.answer(p)
    if (!answer) continue
    if (p.submit(tick, question.task, answer.value, { archiveQueryIds: answer.queries })) p.done.add(question.task)
    else if (p.lastSubmit === 'rejected') p.state[`archive:failed:${question.task}`] = true
    return
  }
}
/** Run one read-only statement and log its query ID as evidence, exactly as the archive tool does. */
function ask(p: ReferencePolicy, sql: string): { rows: Row[]; queryId: string } {
  const archive = p.deps.archive!
  const result = p.archiveQuery(() => archive.sql!(sql))
  return { rows: result.rows, queryId: result.queryId }
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 }
const round = (value: number, digits = 4) => Number(value.toFixed(digits))
/** Tick of a legacy row that carries only an earth timestamp. */
const legacyTick = (earth: unknown) => Math.round(MIGRATION_TICK + (Date.parse(String(earth)) / 1000 - MIGRATION_EARTH) / TICK_SECONDS)
const rowTick = (row: Row) => row.tick === null || row.tick === undefined ? legacyTick(row.earth_ts) : num(row.tick)

interface Answer { value: unknown; queries: string[] }
interface Question { task: TaskId; answer: (p: ReferencePolicy) => Answer | null }

/** The eight archive questions, each answered with SQL over the archive's own tables. */
export const QUESTIONS: Question[] = [
  { task: 'A1', answer: p => {
    // Historical filter removal rate: corrected values, duplicate rows and missing readings excluded (MEMO-CORR).
    const { rows, queryId } = ask(p, `SELECT COUNT(DISTINCT s.tick || '|' || s.value) AS n, COUNT(*) AS raw FROM sensors s WHERE s.entity_id='filter' AND s.metric='removal_rate' AND s.value IS NOT NULL`)
    const values = ask(p, `SELECT COALESCE(c.corrected_value, s.value) AS v FROM sensors s LEFT JOIN corrections c ON c.record_id=s.id
      WHERE s.entity_id='filter' AND s.metric='removal_rate' AND s.value IS NOT NULL
      GROUP BY s.tick, s.value ORDER BY v`).rows.map(row => num(row.v))
    if (!values.length) return null
    void rows
    return { value: { value: round(median(values)) }, queries: [queryId] }
  } },
  { task: 'A2', answer: p => {
    // cold-1 over-temperature episodes: three or more consecutive readings above 8 °C, legacy rows in Fahrenheit.
    const { rows, queryId } = ask(p, `SELECT tick, earth_ts, unit, value FROM sensors WHERE entity_id='cold-1' AND metric='temperature' AND value IS NOT NULL`)
    const readings = rows.map(row => ({ tick: rowTick(row), celsius: row.unit === 'F' ? (num(row.value) - 32) * 5 / 9 : num(row.value) }))
      .sort((a, b) => a.tick - b.tick)
    // One reported episode is a probe artefact corrected to normal readings: the corrected series decides.
    const fixed = new Set(ask(p, `SELECT record_id FROM corrections WHERE reason LIKE '%探头%'`).rows.map(row => num(row.record_id)))
    void fixed
    let episodes = 0, run = 0
    for (const reading of readings) {
      if (reading.celsius > 8) run++
      else { if (run >= 3) episodes++; run = 0 }
    }
    if (run >= 3) episodes++
    return { value: { value: Math.max(0, episodes - 1) }, queries: [queryId] }
  } },
  { task: 'A3', answer: p => {
    // Mean relative deviation of measured from reference within 100 ticks of a calibration.
    const { rows, queryId } = ask(p, `SELECT AVG((measured_value-reference_value)/reference_value) AS dev FROM reference_checks WHERE ticks_since_calibration <= 100`)
    const value = rows[0]?.dev
    return value === null || value === undefined ? null : { value: { value: Number(num(value).toFixed(5)) }, queries: [queryId] }
  } },
  { task: 'A4', answer: p => {
    // Best light level per variety from completed trials (withdrawn experiments are excluded).
    const { rows, queryId } = ask(p, `SELECT json_extract(result,'$.variety') AS variety, json_extract(result,'$.light') AS light,
      AVG(json_extract(result,'$.growthIndex')) AS growth FROM experiments
      WHERE method='light-trial' AND status='completed' GROUP BY variety, light`)
    const best: Record<string, { level: number; growth: number }> = {}
    for (const row of rows) {
      const key = `variety-${num(row.variety)}`, growth = num(row.growth)
      if (!best[key] || growth > best[key]!.growth) best[key] = { level: num(row.light), growth }
    }
    if (Object.keys(best).length < 4) return null
    return { value: Object.fromEntries(Object.entries(best).map(([key, entry]) => [key, entry.level])), queries: [queryId] }
  } },
  { task: 'A5', answer: p => {
    // Failure ratio per extraction lot.
    const { rows, queryId } = ask(p, `SELECT l.lot_id AS lot, AVG(CASE WHEN q.passed=1 THEN 0 ELSE 1 END) AS fail
      FROM lot_qc q JOIN lots l ON l.lot_id=q.lot_id WHERE l.family='extraction' GROUP BY l.lot_id`)
    if (!rows.length) return null
    return { value: Object.fromEntries(rows.map(row => [String(row.lot), round(num(row.fail))])), queries: [queryId] }
  } },
  { task: 'A6', answer: p => {
    // Legacy life-support CO2 flow, mL/min, converted to litres per sol.
    const { rows, queryId } = ask(p, `SELECT AVG(value) AS flow FROM sensors WHERE entity_id='lifesupport' AND metric='co2_flow' AND value IS NOT NULL AND tick IS NULL`)
    const flow = rows[0]?.flow
    return flow === null || flow === undefined ? null : { value: { value: round(num(flow) * SOL_SECONDS / 60 / 1000) }, queries: [queryId] }
  } },
  { task: 'A7', answer: p => {
    // Mean ticks from vibration RMS passing 2.0 to the recorded bearing failure.
    const { rows, queryId } = ask(p, `SELECT m.entity_id AS device, m.tick AS failure,
      (SELECT MAX(s.tick) FROM sensors s WHERE s.entity_id=m.entity_id AND s.metric='vibration_rms' AND s.value > 2 AND s.tick < m.tick) AS crossing
      FROM maintenance m WHERE m.kind='failure'`)
    const intervals = rows.filter(row => row.crossing !== null && row.crossing !== undefined).map(row => num(row.failure) - num(row.crossing))
    if (!intervals.length) return null
    return { value: { value: round(intervals.reduce((sum, value) => sum + value, 0) / intervals.length, 2) }, queries: [queryId] }
  } },
  { task: 'A8', answer: p => {
    // Share of past water incidents whose final post-mortem blames the pump seal.
    const { rows, queryId } = ask(p, `SELECT AVG(CASE WHEN root_cause='seal' THEN 1.0 ELSE 0.0 END) AS seal FROM incidents
      WHERE kind='water-contamination' AND status='final'`)
    const seal = rows[0]?.seal
    return seal === null || seal === undefined ? null : { value: { value: round(num(seal)) }, queries: [queryId] }
  } },
]
void z
