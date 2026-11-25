/** Run the world without Agents to the horizon: the null policy (no actions) or a scripted reference policy.
 * The reference policies act through the real laboratory stack — the same execution engine, providers, procedures and
 * archive the model-driven members use — so device, robot, power, consumable and crew-time costs are identical.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { MarsWorld, initialMarsRules } from './world.ts'
import { marsScenario } from './scenario.ts'
import { loadTruth, CHAMBERS, type Truth } from './truth.ts'
import { score } from './scoring.ts'
import { worldView, loadAnswers } from './scoring-input.ts'
import { ReferencePolicy, type PolicyMode } from './policies.ts'
import { openMarsProviders } from './providers.ts'
import { Procedures } from './procedures.ts'
import { Refs } from './refs.ts'
import { MarsArchive } from './archive.ts'
import { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'

export type Policy = 'null' | 'ref-serial' | 'ref-team'
export const POLICY_MODES: Record<Exclude<Policy, 'null'>, PolicyMode> = { 'ref-serial': 'serial', 'ref-team': 'team' }

export interface SimulateOptions {
  /** Directory holding the public archive (history.sqlite plus manifest.json); archive tasks are skipped without it. */
  history?: string | undefined
  /** Stop after this many logical ticks instead of the truth horizon (development runs). */
  untilTick?: number | undefined
  /** Keep every trace line instead of the last 400. */
  fullTrace?: boolean | undefined
  /** Development probe called after each policy step, before the world advances. */
  onTick?: ((context: { tick: number; world: MarsWorld; engine: ExecutionEngine; procedures: Procedures; policy: ReferencePolicy | null }) => void | Promise<void>) | undefined
}

/** Run one scripted policy to the horizon.
 * @param truth Hidden truth for this run.
 * @param directory Private run directory for the device database, execution journal and artifacts.
 * @param policy Scripted policy name.
 * @param answersFile Evaluator archive answers, used to score the A tasks.
 * @param decisionTicks Logical ticks per decision window.
 * @param options Optional public archive location and development switches.
 */
export async function simulate(truth: Truth, directory: string, policy: Policy, answersFile?: string, decisionTicks = 4, options: SimulateOptions = {}) {
  const started = Date.now()
  const scenario = marsScenario(truth)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const scenarioFile = join(directory, 'scenario.json')
  writeFileSync(scenarioFile, JSON.stringify(scenario), { mode: 0o600 })
  const world = new MarsWorld(join(directory, 'device'), scenario, initialMarsRules(), truth)
  const opened = openMarsProviders(world, scenarioFile, () => {})
  const engine = new ExecutionEngine({ directory: join(directory, 'execution'), providers: opened.providers,
    pollIntervalMs: 5, providerCallTimeoutMs: 60000, logicalTick: () => world.observe().tick })
  try {
    await engine.open()
    engine.createProject('mars', null)
    const admin = engine.issueContext('mars', 'mars-sim', ['water', 'greenhouse', 'facilities'])
    const refs = new Refs(world, () => engine.list(admin).flatMap(operation => operation.artifacts.map(artifact => artifact.id)))
    const archive = options.history ? new MarsArchive(options.history) : null
    const procedures = new Procedures({ engine, world, admin, refs, host: engine.issueContext('mars', 'mars-sim-lab', ['facilities']),
      notify: async () => {} })
    const agent = policy === 'null' ? null : new ReferencePolicy(world, {
      engine, grant: admin, procedures, refs,
      archive: archive?.manifest ? { query: input => archive.query(input), statistics: (entityId, metric) => archive.statistics(entityId, metric),
        sql: sql => { const result = archive.sql(sql); return { queryId: result.queryId, rows: result.rows } } } : null,
    }, POLICY_MODES[policy], decisionTicks)
    let tick = world.observe().tick
    const end = Math.min(truth.horizon, options.untilTick ?? truth.horizon)
    while (tick < end) {
      await agent?.step(tick)
      await procedures.step()
      await options.onTick?.({ tick, world, engine, procedures, policy: agent })
      const next = world.advance()
      if (next === null) break
      tick = next
    }
    await procedures.step()
    while (world.observe().tick < end) { if (world.advance() === null) break }
    const view = worldView(world)
    const facts = engine.readFacts(admin)
    const readArtifacts = new Set(facts.filter(fact => fact.kind === 'mars-artifact-read')
      .flatMap(fact => z.object({ artifactIds: z.array(z.string()) }).parse(fact.data).artifactIds))
    const archiveQueries = new Set(facts.filter(fact => fact.kind === 'mars-archive-query').map(fact => z.object({ queryId: z.string() }).parse(fact.data).queryId))
    const artifactsOf = new Map(engine.list(admin).map(operation => [operation.id, operation.artifacts.map(artifact => artifact.id)]))
    const result = score({ truth, answers: loadAnswers(answersFile), view, submissions: agent?.submissions ?? [], rejections: agent?.rejected.length ?? 0,
      reports: agent?.reports ?? [],
      evidence: { analysisRuns: new Set(agent?.analysisRuns.keys() ?? []), archiveQueries, readArtifacts, artifactsOf: id => artifactsOf.get(id) ?? [] },
      reproducible: () => null }) as Record<string, unknown> & { S: number }
    const total = (key: string) => (result[key] as { total: number }).total
    return { policy, decisionTicks, tick, seconds: (Date.now() - started) / 1000, S: result.S,
      O: total('O'), D: total('D'), C: total('C'), R: total('R'), X: total('X'), Q: total('Q'), breakdown: { D: result.D, R: result.R, X: result.X, C: result.C },
      submissions: Object.entries((agent?.submissions ?? []).reduce((acc, value) => { acc[value.taskId] = (acc[value.taskId] ?? 0) + 1; return acc }, {} as Record<string, number>)),
      rejected: (agent?.rejected ?? []), decisions: agent?.decisions ?? {}, progress: options.fullTrace ? agent?.trace ?? [] : (agent?.trace ?? []).slice(-400),
      crops: view.crops.map(crop => `${crop.id}:${crop.status}:exp${crop.exposureTicks}:rm${crop.removed}:inf${crop.infectedSince}`),
      energy: { soc: view.base.energy.soc, dust: view.base.energy.dust, shedTicks: view.base.metrics.tierOneShedTicks },
      water: { tank: view.lab.facilities.waterUl, unavailable: view.base.metrics.waterUnavailableTicks }, chambers: CHAMBERS.map(id => view.base.atmosphere[id]),
      systemOps: Object.entries(view.systemOps.reduce((acc, op) => { const key = `${op.command.action}:${op.state}`; acc[key] = (acc[key] ?? 0) + 1; return acc }, {} as Record<string, number>)).sort(),
      labOps: Object.entries(view.lab.operations.reduce((acc, op) => { const key = `${op.command.action}:${op.state}`; acc[key] = (acc[key] ?? 0) + 1; return acc }, {} as Record<string, number>)).sort() }
  } finally {
    await engine.close()
    opened.close()
    world.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const [truthFile, policy = 'null', answersFile, output, decision, history] = process.argv.slice(2)
  const result = await simulate(loadTruth(truthFile!), join(resolve(output ? resolve(output).replace(/[^\\/]+$/, '') : '.', `sim-${policy}-${decision ?? 4}`), 'private'),
    policy as Policy, answersFile, decision ? Number(decision) : 4, { history })
  if (output) writeFileSync(output, JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ policy: result.policy, decisionTicks: result.decisionTicks, S: result.S, O: result.O, D: result.D, C: result.C, R: result.R, X: result.X, Q: result.Q, seconds: result.seconds }))
}
void (null as unknown as OperationContext)
