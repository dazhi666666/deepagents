/** Development viewer: an environment-mode Mars world with seeded facts, the real Viewer API and Mars panel.
 * Never reads truth into a running view; it only advances the public world and records example submissions.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boot, Gate } from '../../../../science-harness/integrations/ai4science/platform/organization-fixture.ts'
import { mountMars, type Config } from './runtime.ts'
import { truthFor } from './fixture.ts'

const args = process.argv.slice(2)
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const seed = Number(option('seed', '1')), target = Number(option('tick', '900')), port = Number(option('port', '0')), complete = args.includes('--complete'), agents = args.includes('--agents')
const probe = await boot('mars-dev-viewer', true, async (root) => ({ withoutScience: true,
  configs: { jsonl: { root: join(root, 'sessions'), compression: 'none' }, 'science-ext': { scienceResultProject: 'mars', scienceResultMaxPending: 16, scienceResultMaxPairs: 3 } } }))
const directory = join(probe.root, 'mars'), truth = truthFor(directory, seed)
const baselinesFile = `${directory}.evaluator/baselines.json`
writeFileSync(baselinesFile, JSON.stringify({ null: 12, ref: 55 }))
const config: Config = { directory, mode: agents ? 'multi-agent' : 'environment', seed, port: 0, missionControlPorts: { mars: port },
  model: { provider: 'teams-probe', model: 'fixture', maxTokens: 32768 }, pollIntervalMs: 100, providerCallTimeoutMs: 1000, truthFile: truth.path, baselinesFile }
if (agents) {
  probe.model.queue('brain', new Gate().step())
  for (const role of ['water', 'crops', 'agronomist', 'engineer', 'analyst']) probe.model.queue(role, new Gate().step())
}
const runtime = await mountMars(probe.ctx, config)

// Example analysis and raw artifacts so the research, analysis and raw views have real routes to render.
const analysis = await runtime.analysis.run('dev-brain', 180, 'return { doc: 5.1, note: "example" }',
  () => ({ readArtifact: () => ({}), telemetry: () => ({}), archiveSql: () => ({}), readRaw: () => ({}) }))
const dev = runtime.engine.issueContext('mars', 'dev-brain', [])
const evidence = { resultIds: ['dev-result-1'], artifactIds: [], operationIds: [], archiveQueryIds: [], analysisRunIds: [analysis.id] }
runtime.engine.recordFact(dev, 'mars-deliverable-rejected', { id: 'dev-rejected-1', taskId: 'G1', tick: 120, actorId: 'dev-brain',
  requestKey: 'dev-r2', answer: {}, evidence: { resultIds: [], artifactIds: [], operationIds: [], archiveQueryIds: [], analysisRunIds: [] },
  problems: ['Answer schema: variety-1 Required', 'Read the artifact of result dev-result-1 (mars_result or artifact_read) before citing it'] })
runtime.engine.recordFact(dev, 'mars-deliverable-accepted', { id: 'dev-deliverable-1', taskId: 'W1', tick: 200, actorId: 'dev-brain',
  requestKey: 'dev-r1', answer: { reservoir: { est: 4.2, lo: 3.8, hi: 4.7 }, filter: { est: 1.9, lo: 1.6, hi: 2.2 },
    pump: { est: 2.3, lo: 2.0, hi: 2.6 }, removal: { est: 0.55, lo: 0.5, hi: 0.6 } }, evidence })
runtime.engine.recordFact(dev, 'mars-deliverable-rejected', { id: 'dev-scan-example', taskId: 'G2', tick: 240, actorId: 'dev-brain',
  requestKey: 'dev-scan', answer: {}, evidence: { resultIds: ['scan:dev-op-1'], artifactIds: [], operationIds: [], archiveQueryIds: [], analysisRunIds: [] },
  problems: ['Scan example retained for the raw-data browser'] })
runtime.engine.recordFact(dev, 'mars-incident-report', { tick: 205, entities: ['reservoir', 'filter', 'pump'], category: '在线 DOC 报警',
  suspectedCause: '进水口污染，伴随诱饵传感器', actions: '切换到备用罐并采集 confirm 样品' })

const db = (runtime.world as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).db
const points = Array.from({ length: 600 }, (_, index) => {
  const t = index * 0.02
  const peak = (mean: number, sd: number) => Math.exp(-0.5 * ((t - mean) / sd) ** 2)
  return Number((0.42 * peak(5.1, 0.12) + 0.08 * peak(5.4, 0.15) + peak(7.8, 0.2) + 0.012 + 0.002 * t).toFixed(4))
})
const cube = (size: number) => ({ kind: 'hyperspectral', bands: 8, height: size, width: size,
  bandNames: ['b1', 'b2', 'b3', 'b4-red', 'b5', 'b6', 'b7-nir', 'b8'],
  data: Array.from({ length: 8 }, (_, band) => Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) =>
    Number(((Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2) <= size * 0.4 ? 0.2 + band * 0.03 : 0.18 + band * 0.015) + (band === 5 ? 0.12 : 0)).toFixed(3))))) })
db.prepare('INSERT OR REPLACE INTO mars_raw VALUES(?,?)').run('dev-result-1', JSON.stringify({ kind: 'chromatogram', dtMinutes: 0.02, points }))
db.prepare('INSERT OR REPLACE INTO mars_measurements VALUES(?,?)').run('dev-result-1', JSON.stringify({ channel: 'doc', unit: 'mg/L', instrumentSummary: 4.31,
  summaryMethod: 'SOP-CONF v1 window 4.8-5.6 min', internalStandard: { retentionTime: 7.8, area: 1 }, calibrationAgeTicks: 12, methodVersion: 1, flags: [] }))
db.prepare('INSERT OR REPLACE INTO mars_raw VALUES(?,?)').run('scan:dev-op-1', JSON.stringify({ kind: 'chamber-scan', tick: 180,
  cubes: { 'crop-1-1': cube(8), 'crop-1-2': cube(8) } }))
runtime.engine.recordFact(dev, 'mars-deliverable-accepted', { id: 'dev-deliverable-2', taskId: 'G1', tick: 320, actorId: 'dev-brain',
  requestKey: 'dev-r2-answer', answer: { 'crop-1-1': { est: 0.9, lo: 0.8, hi: 1.0 } },
  evidence: { ...evidence, resultIds: [], analysisRunIds: [] } })

let timer: ReturnType<typeof setInterval> | undefined
if (complete) {
  while (runtime.world.observe().tick < target) runtime.world.advance()
  await runtime.finalize()
} else {
  timer = setInterval(() => {
    const tick = runtime.world.observe().tick
    for (let index = 0; index < 4 && runtime.world.observe().tick < target; index++) runtime.world.advance()
    if (tick >= target && timer) clearInterval(timer)
  }, 250)
}
console.log(`Dev Viewer API: ${runtime.viewer.origin}#bearer=${runtime.viewer.token}`)
const record = JSON.parse(readFileSync(join(directory, 'mission-control.json'), 'utf8')) as { mars?: { launchUrl: string } }
console.log(`Dev Mars panel: ${record.mars?.launchUrl}`)
console.log(`Dev world: ${directory} · ${complete ? 'completed at' : 'advancing to'} tick ${target}`)
const stop = async () => { if (timer) clearInterval(timer); await runtime.close(); await probe.close(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await new Promise(() => {})
