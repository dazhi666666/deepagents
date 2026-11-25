/** Native Mars planning foundation with real platform operations and viewer data. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { createOrganization } from '../../../../science-harness/integrations/ai4science/platform/organization.ts'
import { installOrganizationTools } from '../../../../science-harness/integrations/ai4science/platform/host-plugin.ts'
import { installExperimentTools } from '../../../../science-harness/integrations/ai4science/platform/experiment-tools.ts'
import { ExecutionEngine } from '../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { Artifacts } from '../../../../science-harness/integrations/ai4science/platform/artifacts.ts'
import type { Json, OperationContext } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { marsScenario } from './scenario.ts'
import { loadTruth } from './truth.ts'
import { publicResources } from './v05/resources.ts'
import { buildEarlyStopReport, writeEarlyStopReport } from './v05/early-stop.ts'
import { renderV05Report } from './v05/report.ts'
import { V05ResearchRecords } from './v05/research-records.ts'
import { V05Ledger } from './v05/ledger.ts'
import { createV05Scenario } from './v05/scenario.ts'
import { finalizeV05 } from './v05/finalize.ts'
import { replayTerminalPlan } from './v05/replay.ts'
import { researchProjection } from './v05/projection.ts'
import { NativeRounds, isV05Mutation } from './v05/native-rounds.ts'
import { snapshotMayCommitRound, resumeSlotsSettled } from './v05/recovery-round.ts'
import { collectEvaluationInput } from './v05/evaluation-input.ts'
import { V05Planning } from './v05/planning.ts'
import { installPlanningTools, V05_PLAN_TOOLS } from './v05/planning-tools.ts'
import { installResearchTools, V05_TOOLS } from './v05/tools.ts'
import { publicMission as v05Mission, V05_TASK_IDS } from './v05/registry.ts'
import { v05Charter } from './v05/team.ts'
import { developmentStages, stageProfileSchema, contentHash } from './v06/contracts.ts'
import { publicMission as v06Mission, V06_TASK_IDS } from './v06/registry.ts'
import { charter as v06Charter, roleTools as v06RoleTools } from './v06/team.ts'
import { DeliveryLedger, deliverySpec, deliveryVersion, followsReceipts } from './v06/delivery.ts'
import { installDeliveryTools, receiptMail, followUpParameter } from './v06/delivery-tools.ts'
import { openProtocol, protocolReport } from './v06/protocol.ts'
import { installResearchTools as installV06ResearchTools } from './v06/tools.ts'
import { sourceManifest } from './v06/source-manifest.ts'
import { scienceProfileSchema, publicScienceProfile } from './v06/profile.ts'
import { compileScenario } from './v06/scenario.ts'
import { V06World } from './v06/world.ts'
import { openScience, scienceInstance, type ScientificCore } from './v06/science.ts'
import { budgetConfigSchema, V06Budget, BudgetExhausted, MonetaryAdmissions } from './v06/budget.ts'
import { renderScientificReport } from './v06/report.ts'
import { planHash } from './v06/actions.ts'
import { PhaseLedger } from './v06/phase-ledger.ts'
import { MarsWorld, initialMarsRules } from './world.ts'
import { openMarsProviders } from './providers.ts'
import { SimulationClock } from '../greenhouse/simulation-clock.ts'
import { powerDemand } from '../greenhouse/laboratory/facilities.ts'
import { apply as mountDirectTransport, directTransportSchema } from '../greenhouse/direct-transport.ts'
import { createMission, tasksForLoad } from './mission.ts'
import { dutySlot, dutyWindow, isDuty } from './deliverables.ts'
import { marsLayout } from './layout.ts'
import { MarsRecords } from './records.ts'
import { Checkpoints, CheckpointChanged, acquireRunLease } from './checkpoints.ts'
import { AdmissionBarrier } from './barrier.ts'
import { MarsAudit } from './audit.ts'
import { AnalysisRegistry } from './analysis.ts'
import { installV2Tools, analysisBindings } from './v2-tools.ts'
import { collectFacts, independentCheck, loadAnswers, loadBaselines, worldView } from './scoring-input.ts'
import { score as computeScore } from './scoring.ts'
import { startHarnessMissionControl, startMarsMissionControl } from './mission-control.ts'
import { MarsMail } from './mail.ts'
import { installPhysicalTools } from './tools.ts'
import { installTeamTools } from './team-tools.ts'
import { Procedures, STORAGE_NAMES } from './procedures.ts'
import { PhysicalObserver } from './physical-observer.ts'
import { ALL_ROBOTS, charter, DUTY_OWNER, HIDDEN_TOOLS, SINGLE_TOOLS, singlePlaybook, SPECIALISTS, TEAM, type TeamRole } from './team.ts'
import { logicalOperationView } from './projection.ts'
import { MarsArchive } from './archive.ts'
import { startViewer } from './viewer.ts'
import { observableIncidentCount, redactScore } from './score-view.ts'
import { COOLING_CODES, ProviderPool } from './provider-pool.ts'
import { Refs } from './refs.ts'
import { taskTruths } from './truth-view.ts'
import type { ViewerEvent, ViewerSnapshot } from './protocol.ts'

export const name = 'science-mars-foundation'
export const inject = ['agents', 'subagents', 'tools', 'systemPrompt', 'llm', 'sessions', 'sessionPersistence', 'scienceExchange']
const schema = z.object({ stopAtTick: z.number().int().positive().optional(), benchmarkVersion: z.enum(['v0.4', 'v0.5', 'v0.6']).default('v0.4'),
  stageProfile: stageProfileSchema.optional(), implementation: z.enum(['protocol_only', 'scientific_candidate']).default('protocol_only'),
  scienceProfile: scienceProfileSchema.optional(), instanceFile: z.string().optional(), budget: budgetConfigSchema.optional(), frozenSourceHash: z.string().length(64).optional(),
  modelSource: z.enum(['real-model', 'scripted-integration', 'environment']).default('real-model'), directory: z.string().min(1), mode: z.enum(['environment', 'single-agent', 'multi-agent']),
  seed: z.number().int().positive(), port: z.number().int().min(0).max(65535),
  model: z.object({ provider: z.string(), model: z.string(), maxTokens: z.number().int().positive() }),
  pollIntervalMs: z.number().int().positive(), providerCallTimeoutMs: z.number().int().positive(),
  resume: z.boolean().optional(), supervised: z.boolean().optional(), automaticCheckpoints: z.boolean().optional(),
  decisionTicks: z.number().int().positive().optional(), checkpointIntervalTicks: z.number().int().positive().optional(),
  truthFile: z.string().min(1), answersFile: z.string().optional(), baselinesFile: z.string().optional(),
  missionControlPort: z.number().int().min(0).max(65535).optional(),
  missionControlPorts: z.object({ harness: z.number().int().min(0).max(65535).optional(), mars: z.number().int().min(0).max(65535).optional() }).strict().optional(),
  modelRequestDeadlineMs: z.number().int().positive().optional(),
  infrastructureRetryLimit: z.number().int().nonnegative().optional(), infrastructureRetryDelayMs: z.number().int().nonnegative().optional(),
  providerPool: z.array(z.string().min(1)).min(1).optional(),
  providerTiers: z.array(z.array(z.string().min(1)).min(1)).min(1).optional(),
  providerCooldownMs: z.number().int().positive().optional(),
  directTransport: directTransportSchema.optional(),
}).strict()
export type Config = z.input<typeof schema>
const capabilities = ['water', 'greenhouse', 'facilities']

/** Mount one isolated planning run. Foundation capabilities are explicit in every snapshot.
 * @param ctx Native Harness services.
 * @param input Validated installation settings.
 * @returns Runtime resources for lifecycle and integration verification.
 */
export async function mountMars(ctx: Context, input: Config) {
  const config = schema.parse(input), directory = resolve(config.directory)
  const v05 = config.benchmarkVersion === 'v0.5', v06 = config.benchmarkVersion === 'v0.6'
  const scientific = v06 && config.implementation === 'scientific_candidate', modern = v05 || scientific, namespace = scientific ? 'v06' : 'v05'
  if (v06 && !scientific && config.mode !== 'environment') throw new Error('v0.6 protocol-only milestone supports environment mode; model admission awaits budget, isolation and scientific acceptance')
  if (!v06 && (config.stageProfile || config.scienceProfile || config.budget || config.instanceFile || config.frozenSourceHash || config.implementation !== 'protocol_only')) throw new Error('Scientific profiles require benchmarkVersion v0.6')
  if (scientific && config.mode !== 'environment' && !config.budget) throw new Error('Scientific Agent mode requires a frozen whole-tree monetary budget')
  let science: ScientificCore | undefined, monetary: V06Budget | undefined
  const scienceProfile = scienceProfileSchema.parse(config.scienceProfile ?? {})
  const stages = stageProfileSchema.parse(config.stageProfile ?? developmentStages)
  const existingManifest = join(directory, 'manifest.public.json')
  if (existsSync(existingManifest)) {
    const version = z.object({ benchmarkVersion: z.enum(['v0.4', 'v0.5', 'v0.6']) }).parse(JSON.parse(readFileSync(existingManifest, 'utf8'))).benchmarkVersion
    if (version !== config.benchmarkVersion) throw new Error('Run benchmark version differs from runtime')
  }
  const mission = (...args: Parameters<typeof createMission>) => v06 ? { ...v06Mission(stages, config.decisionTicks ?? 12, scientific ? 'scientific_candidate' : 'protocol_only'),
      ...(science ? { scientific: science.catalog() } : {}), instructions: config.mode === 'multi-agent'
        ? '六个固定岗位共享三项研究委托，职责不独占。用research_catalog读取目标、证据、模型接口和期限。'
        : v06Charter('single', stages, config.decisionTicks ?? 12, scientific) }
    : v05 ? { ...v05Mission(args[4] ?? 2400, config.decisionTicks ?? 12), instructions: v05Charter('single', config.decisionTicks ?? 12, args[4] ?? 2400) } : createMission(...args)
  const roleTools = (role: TeamRole) => v06 ? [...v06RoleTools(stages), ...(role === 'brain' ? ['org_create'] : [])] : v05 ? [...new Set([...SINGLE_TOOLS.filter(name => !['deliverable_check', 'deliverable_submit', 'deliverable_status', 'duty_status', 'board'].includes(name)), ...V05_TOOLS, ...V05_PLAN_TOOLS, 'round_receipts', ...(role === 'brain' ? ['org_create'] : [])])] : TEAM[role].tools
  if (config.missionControlPort !== undefined) console.warn('missionControlPort is deprecated; use missionControlPorts.harness')
  const controlPorts = config.missionControlPorts ?? (config.missionControlPort === undefined ? undefined : { harness: config.missionControlPort })
  if (controlPorts?.harness && controlPorts.mars && controlPorts.harness === controlPorts.mars)
    throw new Error('Mission Control ports must differ: harness and mars cannot share a listener')
  const providerPool = config.providerPool ?? [config.model.provider]
  if (!providerPool.includes(config.model.provider)) throw new Error('Provider pool must include the default provider')
  if (scientific && config.mode !== 'environment') for (const provider of providerPool) {
    const price = config.budget!.prices.find(p => p.provider === provider && p.model === config.model.model)
    if (!price?.verified || config.model.maxTokens > price.maxOutputTokens) throw new Error('Every scientific model route needs verified price/context bounds and an unchanged output limit')
  }
  const providerTiers = config.providerTiers ?? [providerPool]
  const tiered = providerTiers.flat()
  if (tiered.length !== providerPool.length || new Set(tiered).size !== providerPool.length || !providerPool.every(provider => tiered.includes(provider)))
    throw new Error('providerTiers must list every provider pool entry exactly once')
  const providers = new ProviderPool({ tiers: providerTiers,
    ...(config.providerCooldownMs === undefined ? {} : { cooldownMs: config.providerCooldownMs }) })
  if (config.directTransport) mountDirectTransport(ctx, config.directTransport)
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 })
  const runLease = acquireRunLease(directory, false)
  let cleanup = async () => runLease.close()
  try {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const sourceTruth = loadTruth(config.truthFile)
  const instance = scientific ? scienceInstance(directory, contentHash(sourceTruth), contentHash(scienceProfile), stages, config.instanceFile) : undefined
  const compiled = scientific ? compileScenario(sourceTruth, stages, scienceProfile, instance!.salt) : undefined
  const truth = compiled?.truth ?? sourceTruth, load = truth.load, answers = loadAnswers(config.answersFile)
  if (v06 && truth.horizon !== stages.horizon) throw new Error('v0.6 stage horizon differs from physical world')
  const scenario = compiled?.scenario ?? marsScenario(truth)
  const scenarioFile = join(directory, 'device-scenario.json')
  const serialized = JSON.stringify(scenario)
  if (existsSync(scenarioFile) && readFileSync(scenarioFile, 'utf8') !== serialized) throw new Error('Existing scenario differs')
  writeFileSync(scenarioFile, serialized, { mode: 0o600 })
  const identityFile = join(directory, 'run.json')
  if (existsSync(identityFile) && config.mode !== 'environment' && !config.resume) throw new Error('Run already initialized; native full recovery is not available in foundation stage')
  const identitySchema = z.object({ runId: z.string().uuid(), branchId: z.string(), epoch: z.number().int().positive(), rootSessionId: z.string().optional(), checkpointId: z.string().optional() })
  const identity = identitySchema.parse(existsSync(identityFile) ? identitySchema.parse(JSON.parse(readFileSync(identityFile, 'utf8'))) : { runId: randomUUID(), branchId: 'main', epoch: 1 })
  let recoveryCheckpointId = identity.checkpointId
  if (!existsSync(identityFile)) writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o600, flag: 'wx' })
  const world = scientific ? new V06World(join(directory, 'device'), scenario, initialMarsRules(), truth, scienceProfile, stages)
    : new MarsWorld(join(directory, 'device'), scenario, initialMarsRules(), truth)
  cleanup = async () => { world.close(); runLease.close() }
  const executionStopAt = config.stopAtTick ?? world.horizon
  // Compaction can start before agent/request admission. Initialize termination
  // state before any model middleware is registered, including during resume.
  let ended = false, modelAdmissionClosed = false
  let stopReason: 'normal' | 'budget_exhausted' | 'model_error' | 'infrastructure' = 'normal'
  world.setStopAtTick(executionStopAt)
  const stopNotice = executionStopAt < world.horizon ? `用户已要求本次运行在第${executionStopAt} tick停止，原完整科研任务定义仍为${world.horizon} tick；保存已验证的部分成果，不得把尚未完成的任务当作完成。` : ''
  const clock = new SimulationClock(directory, () => world.advance() !== null,
    error => console.error('Mars logical clock failed', error.message), 'event-driven')
  const opened = openMarsProviders(world, scenarioFile, () => clock.wake())
  let reservationGuard: (operationId: string) => string | null = () => null
  const executionProviders = modern ? opened.providers.map(provider => ({ ...provider, submit: async (operation: Parameters<typeof provider.submit>[0]) => {
    const blocked = reservationGuard(operation.operationId)
    return blocked ? { state: 'failed' as const, detail: blocked } : provider.submit(operation)
  } })) : opened.providers
  const engine = new ExecutionEngine({ directory: join(directory, 'execution'), providers: executionProviders,
    pollIntervalMs: config.pollIntervalMs, providerCallTimeoutMs: config.providerCallTimeoutMs, logicalTick: () => world.observe().tick })
  cleanup = async () => {
    await clock.close()
    await engine.close()
    opened.close()
    world.close(); runLease.close()
  }
    await engine.open()
    engine.createProject('mars', null)
    if (scientific && config.budget) monetary = new V06Budget(`${directory}.budget.sqlite`, config.budget)
    const archive = new MarsArchive(join(directory, 'public/history'), v05 || v06)
    const closeBeforeArchive = cleanup
    cleanup = async () => { archive.close(); await closeBeforeArchive() }
    const admin = engine.issueContext('mars', 'mars-host', capabilities)
    const physicalObserver = scientific ? new PhysicalObserver(engine, world) : undefined
    const reconcile = () => physicalObserver ? physicalObserver.reconcile(admin) : engine.reconcile(admin)
    if (modern) reservationGuard = operationId => {
    const operation = engine.get(admin, operationId), tick = world.observe().tick
    const reservations = new V05Planning(engine, admin, () => world.observe().tick, {}, undefined, namespace).reservations()
    const blocked = reservations.find(item => operation.resources.includes(item.resource) &&
      (item.state === 'active' || item.state === 'committed' && item.start <= tick && tick < item.end) &&
      (item.actorId !== operation.actorId || item.planId !== undefined && item.stepId !== undefined && operation.requestKey !== `${namespace}:${item.planId}:${item.stepId}` && item.operationId !== operation.id))
    return blocked ? `Resource reserved: ${blocked.resource} by ${blocked.actorId} until ${blocked.end}` : null
  }
  const artifacts = new Artifacts(engine), records = new MarsRecords(engine, admin, () => world.observe().tick, v06 ? V06_TASK_IDS : v05 ? V05_TASK_IDS : undefined)
    // Published artifact IDs are long hex digests; give them stable short refs so evidence can cite them.
    const refs = new Refs(world, () => artifacts.list(admin).map(artifact => artifact.id))
    const analysis = new AnalysisRegistry(join(directory, 'analysis'), false, scientific ? { isolatedRealm: true,
      timeoutMs: scienceProfile.analysisTimeoutMs, maxOutputBytes: scienceProfile.analysisOutputBytes } : {})
    archive.resumeNumbering(engine.readFacts(admin).filter(fact => fact.kind === 'mars-archive-query').length)
    const v05Scenario = v05 ? createV05Scenario(truth, world, config.decisionTicks ?? 12) : undefined
    const ledger = v05 ? new V05Ledger(engine, admin, world) : undefined
    if (v05Scenario) {
      mkdirSync(join(directory, 'public/research'), { recursive: true, mode: 0o700 })
      writeFileSync(join(directory, 'public/research/scenario.json'), JSON.stringify(v05Scenario.public), { mode: 0o600 })
      if (!existsSync(join(directory, 'public/resources.json'))) writeFileSync(join(directory, 'public/resources.json'), JSON.stringify(publicResources(world)), { mode: 0o600 })
      // Seed research state through the same versioned fact format; historical observations remain provisional.
      const inherited = new V05ResearchRecords(engine, admin, () => 0)
      for (const record of v05Scenario.public.handover) if (!inherited.read(record.id)) inherited.put(`inherit:${record.id}`, {
        id: record.id, expectedRevision: 0, kind: record.kind as 'claim' | 'study', project: record.project as 'PW' | 'PG' | 'PF', content: z.json().parse(record.content),
        reason: 'Inherited public research handover', basedOn: record.basedOn, status: 'provisional' })
      const privateDirectory = `${directory}.evaluator`
      mkdirSync(privateDirectory, { recursive: true, mode: 0o700 })
      const sourceIdentity = JSON.stringify({ truthHash: createHash('sha256').update(JSON.stringify(truth)).digest('hex'), nodeVersion: process.version })
      const sourceIdentityFile = join(privateDirectory, 'v05-source.json')
      if (existsSync(sourceIdentityFile) && readFileSync(sourceIdentityFile, 'utf8') !== sourceIdentity) throw new Error('Private scenario identity changed during resume')
      writeFileSync(sourceIdentityFile, sourceIdentity, { mode: 0o600 })
      const publicManifest = { schemaVersion: 1, benchmarkVersion: 'v0.5', nodeVersion: process.version,
        horizon: world.horizon, decisionTicks: config.decisionTicks ?? 12, model: config.model, scenarioHash: world.scenarioHash, historyHash: archive.manifest?.sha256 ?? null,
        objectiveContractHash: createHash('sha256').update(JSON.stringify(v05Scenario.public.objectives)).digest('hex'), calibrationStatus: 'not_frozen' }
      const manifestPath = join(directory, 'manifest.public.json')
      if (existsSync(manifestPath)) {
        const previousIdentity = JSON.parse(readFileSync(manifestPath, 'utf8')); delete previousIdentity.stopAtTick; delete previousIdentity.executionTermination
        if (JSON.stringify(previousIdentity) !== JSON.stringify(publicManifest)) throw new Error('Run manifest differs from current runtime or task contracts')
      }
      writeFileSync(manifestPath, JSON.stringify({ ...publicManifest, ...(config.stopAtTick === undefined ? {} : { stopAtTick: executionStopAt, executionTermination: 'user_requested_stop' }) }), { mode: 0o600 })
      ledger?.capture()
    }
    if (scientific && world instanceof V06World) science = openScience({ world, engine, context: admin, analysis, directory,
      salt: instance!.salt, decisionTicks: config.decisionTicks ?? 12, resolveReference: id => refs.resolve(id) })
    const v06Protocol = science ?? (v06 ? openProtocol(engine, admin, () => world.observe().tick, stages, config.decisionTicks ?? 12) : undefined)
    const phaseLedger = science ? new PhaseLedger(`${directory}.phase-seals.jsonl`, identity.runId, v06Protocol!.config.protocolHash) : undefined
    phaseLedger?.synchronize(world.observe().tick, v06Protocol!.stages.seals())
    if (v06Protocol) {
      const sources = sourceManifest()
      if (config.frozenSourceHash && config.frozenSourceHash !== sources.hash) throw new Error('Executable sources changed after scientific installation')
      const manifest = { schemaVersion: 1, benchmarkVersion: 'v0.6', implementation: config.implementation, nodeVersion: process.version,
        sourceHash: sources.hash, horizon: world.horizon, stopAtTick: executionStopAt, stageProfile: stages, protocolHash: v06Protocol.config.protocolHash,
        decisionTicks: config.decisionTicks ?? 12, scenarioHash: world.scenarioHash, mode: config.mode, model: config.model, modelSource: config.mode === 'environment' ? 'environment' : config.modelSource,
        caseManifestHash: science?.manifest.hash ?? null, priceHash: monetary?.report().priceHash ?? null,
        scientificProfile: scientific ? publicScienceProfile(scienceProfile) : null,
        calibrationStatus: 'not_frozen' }
      if (existsSync(existingManifest) && contentHash(JSON.parse(readFileSync(existingManifest, 'utf8'))) !== contentHash(manifest))
        throw new Error('Run manifest differs from current v0.6 protocol')
      writeFileSync(existingManifest, JSON.stringify(manifest, null, 2), { mode: 0o600 })
      mkdirSync(join(directory, 'public'), { recursive: true, mode: 0o700 })
      writeFileSync(join(directory, 'public/source-manifest.json'), JSON.stringify(sources, null, 2), { mode: 0o600 })
      world.setStopAtTick(Math.min(executionStopAt, v06Protocol.stages.nextBoundary()))
      if (scientific) {
        const runtimeIdentity = { implementation: config.implementation, sourceTruthHash: contentHash(sourceTruth), scienceProfile,
          stageProfile: stages, decisionTicks: config.decisionTicks ?? 12, instanceFile: config.instanceFile ?? `${directory}.evaluator/v06-instance.json`,
          budget: config.budget ?? null, stopAtTick: executionStopAt }
        const path = `${directory}.evaluator/v06-runtime.json`
        if (existsSync(path) && contentHash(JSON.parse(readFileSync(path, 'utf8'))) !== contentHash(runtimeIdentity)) throw new Error('Private scientific runtime profile changed')
        if (!existsSync(path)) writeFileSync(path, JSON.stringify(runtimeIdentity), { mode: 0o600, flag: 'wx' })
      }
    }
    let finalScore: unknown = null
    const reproducibility = new Map<string, boolean>()
    let status: ViewerSnapshot['status'] = 'starting'
    let worldCursor = 0
    for (const fact of engine.readFacts(admin)) if (fact.kind === 'mars-device') {
      const event = z.object({ seq: z.number() }).parse(fact.data)
      worldCursor = Math.max(worldCursor, event.seq)
    }
    const members = new Map<string, Agent>(), waiting = new Set<string>()
    const infrastructureFailed = new Map<string, { code: string; tick: number }>(), infrastructureAttempts = new Map<string, number>()
    const infrastructureCode = (code: string, status?: number) => COOLING_CODES.has(code) || ['TRANSPORT', 'NETWORK', 'SERVER', 'TIMEOUT'].includes(code) || (status ?? 0) >= 500
    const markInfrastructureFailure = (actorId: string, code: string) => {
      if (!modern || modelAdmissionClosed || !members.has(actorId)) return
      infrastructureFailed.set(actorId, { code, tick: world.observe().tick })
      engine.recordFact(admin, `mars-${namespace}-infrastructure-pending`, { actorId, code, tick: world.observe().tick })
    }
    let teamReady = false
    const barrier = new AdmissionBarrier(), shutdown = new AbortController()
    const checkpoints = new Checkpoints(directory, `${directory}.checkpoints`, phaseLedger ? { restoreGuard: manifest => phaseLedger.assertCheckpoint(manifest.tick, manifest.metadata) } : {})
    const audit = new MarsAudit(`${directory}.audit.jsonl`)
    const monetaryAdmissions = monetary ? new MonetaryAdmissions(monetary) : undefined
    const stoppedPlanHashes = new Set<string>()
    if (scientific) for (const fact of engine.readFacts(admin).filter(f => f.kind === 'mars-v06-model-admission-closed')) {
      const seal = z.object({ reason: z.enum(['normal', 'budget_exhausted', 'model_error', 'infrastructure']), plans: z.array(z.object({ id: z.string(), hash: z.string() })) }).parse(fact.data)
      modelAdmissionClosed = true; stopReason = seal.reason
      for (const plan of seal.plans) stoppedPlanHashes.add(`${plan.id}:${plan.hash}`)
    }
    const closeModelAdmissions = (reason: 'normal' | 'budget_exhausted' | 'model_error' | 'infrastructure') => {
      if (!scientific || modelAdmissionClosed) return
      modelAdmissionClosed = true; stopReason = reason
      monetaryAdmissions?.close()
      if (status === 'attention-required') status = 'running'
      infrastructureFailed.clear()
      const plans = new V05Planning(engine, admin, () => world.observe().tick, {}, undefined, 'v06').list()
        .filter(p => p.state === 'scheduled' || p.state === 'running').map(p => ({ id: p.id, hash: planHash(p) }))
      for (const plan of plans) stoppedPlanHashes.add(`${plan.id}:${plan.hash}`)
      engine.recordFact(admin, 'mars-v06-model-admission-closed', { reason, tick: world.observe().tick, plans })
      audit.append('model-admission-closed', { reason, tick: world.observe().tick })
      for (const agent of members.values()) agent.cancel({ kind: 'hook', reason: 'Model admission closed; frozen physical work continues' })
      clock.wake()
    }
    if (scientific && v06Protocol?.stages.modelAdmissionClosed()) closeModelAdmissions('normal')
    // v0.4 fixed team (team.ts): the runtime creates the five specialists at mission start, so no member builds the
    // organization. The single agent holds every tool and every charter merged into one playbook.
    const multi = config.mode === 'multi-agent', decisionTicks = config.decisionTicks ?? (v06 ? 12 : 1)
    const preamble = '你在火星基地使用真实工具工作，没有任何外部帮助。下面是你的岗位章程，照章程执行。'
    const template = (instructions: string, tools: string[], creates: Record<string, number> = {}) =>
      ({ instructions: `${preamble}\n${instructions}\n${stopNotice}`, model: config.model, tools, creates, maxInstances: 1 })
    const org = await createOrganization(ctx, { project: 'mars', rootRole: 'brain', maxParticipants: multi ? 1 + SPECIALISTS.length : 1,
      maxDepth: multi ? 1 : 0, relations: [], roles: multi
        ? { brain: template(v06 ? v06Charter('brain', stages, decisionTicks, scientific) : v05 ? v05Charter('brain', decisionTicks, world.horizon) : charter('brain', decisionTicks, world.horizon), roleTools('brain'), Object.fromEntries(SPECIALISTS.map(role => [role, 1]))),
            ...Object.fromEntries(SPECIALISTS.map(role => [role, template(v06 ? v06Charter(role, stages, decisionTicks, scientific) : v05 ? v05Charter(role, decisionTicks, world.horizon) : charter(role, decisionTicks, world.horizon), roleTools(role))])) }
        : { brain: template(v06 ? v06Charter('single', stages, decisionTicks, scientific) : v05 ? v05Charter('single', decisionTicks, world.horizon) : singlePlaybook(decisionTicks, world.horizon), v05 || v06 ? roleTools('brain') : SINGLE_TOOLS) } },
      { readFacts: () => engine.readFacts(admin).filter(fact => fact.kind === 'mars-organization')
          .map(fact => z.object({ kind: z.string(), data: z.json() }).parse(fact.data)),
        record: (kind, data) => {
        engine.recordFact(admin, 'mars-organization', z.json().parse({ kind, data }))
        if (kind === 'organization-closed') {
          const state = world.observe(), systems = world.observeSystems()
          const complete = state.tick >= executionStopAt; void systems
          status = complete ? 'completed' : 'agent-ended'
          audit.append('mission-terminal', { status, tick: state.tick })
        }
      },
        resultReader: id => {
          const artifact = artifacts.list(admin).find(value => value.id === id)
          if (artifact) { artifacts.read(admin, id); return { project: 'mars', ownerSessionId: SessionId(artifact.actorId) } }
          const operation = engine.list(admin).find(value => value.id === id && value.state === 'succeeded')
          return operation ? { project: 'mars', ownerSessionId: SessionId(operation.actorId) } : undefined
        } })
    /** The fixed team the runtime builds at mission start: every role, its tasks, its robots and its tools.
     * `canCreate` is empty because no member ever builds another organization. */
    const organizationCatalog = (currentRole: string) => ({ mode: config.mode, currentRole,
      maxParticipants: multi ? 1 + SPECIALISTS.length : 1, maxDepth: multi ? 1 : 0, canCreate: {},
      members: multi ? (['brain', ...SPECIALISTS] as TeamRole[]).map(role => ({ role, title: TEAM[role].title, tasks: v06 ? V06_TASK_IDS : v05 ? V05_TASK_IDS : TEAM[role].tasks, robots: modern ? ALL_ROBOTS : TEAM[role].robots, tools: roleTools(role) }))
        : [{ role: 'brain', title: '唯一成员（兼任全部岗位）', tasks: 'all', robots: ALL_ROBOTS, tools: v05 || v06 ? roleTools('brain') : SINGLE_TOOLS }] })
    const mail = new MarsMail(ctx, engine, org, admin, directory, () => world.observe().tick, !multi, !modern)
    // Laboratory procedures (procedures.ts) report to their owner, and ask whoever calibrates when a device needs it.
    const procedures = new Procedures({ engine, world, admin, refs, host: engine.issueContext('mars', 'mars-lab', ['facilities']),
      canAdvance: () => !scientific || !modelAdmissionClosed && world.observe().tick < stages.finalTick,
      sweepAbandoned: !scientific,
      ...(physicalObserver ? { observeOperation: physicalObserver.query.bind(physicalObserver) } : {}),
      notify: (role, actorId, key, content) => mail.system(role ?? org.snapshotParticipants().find(participant => participant.id === actorId)?.role ?? 'brain', key, content, shutdown.signal) })
    mail.internalOperation = operationId => procedures.internal(operationId)
    let environmentCursor = 0
    for (const fact of engine.readFacts(admin)) if (fact.kind === 'mars-environment-position') environmentCursor = z.object({ cursor: z.number() }).parse(fact.data).cursor
    // Each duty window that is open now gets one reminder to its owner (the single agent owns all three duties).
    const dutyReminders = () => (v05 || v06 ? [] : tasksForLoad(load)).filter(isDuty).flatMap(task => {
      const tick = world.observe().tick, slot = dutySlot(task, load, tick, world.horizon)
      if (slot === null) return []
      const [from, to] = dutyWindow(task, load, slot, world.horizon)
      return [{ role: multi ? DUTY_OWNER[task] : 'brain', key: `duty-${task}-${slot}`,
        content: `[值班提醒] ${task} 第 ${slot} 个窗口已开：第 ${from}–${to - 1} 步。按 SOP 完成并在窗口内提交（duty_status 可查本窗口是否已交）。` }]
    })
    const dispatchEnvironment = async () => {
      const events = world.events(environmentCursor), reminders = config.mode === 'environment' ? [] : dutyReminders()
      if (!events.length && !reminders.length) return
      if (scientific && modelAdmissionClosed) {
        if (events.length) { environmentCursor = events.at(-1)!.seq; engine.recordFact(admin, 'mars-environment-position', { cursor: environmentCursor, tick: world.observe().tick }) }
        return
      }
      const release = barrier.held ? undefined : barrier.hold()
      barrier.writes++
      try {
        if (events.length) {
          await mail.notifyEnvironment(events, waiting, shutdown.signal)
          environmentCursor = events.at(-1)!.seq
          engine.recordFact(admin, 'mars-environment-position', { cursor: environmentCursor, tick: world.observe().tick })
        }
        for (const reminder of reminders) await mail.system(reminder.role, reminder.key, reminder.content, shutdown.signal)
        await ctx.sessionPersistence.flush()
      } finally { barrier.writes--; release?.() }
    }
    const grants = new WeakMap<Agent, OperationContext>()
    const scopes: Record<string, string[]> = multi ? Object.fromEntries((['brain', ...SPECIALISTS] as TeamRole[]).map(role => [role, modern ? capabilities : TEAM[role].providers])) : { brain: capabilities }
    const access = (agent: Agent, tool: string) => {
      const participant = org.assertActor(agent, tool)
      let grant = grants.get(agent)
      if (!grant) { grant = engine.issueContext('mars', agent.id, scopes[participant.role] ?? []); grants.set(agent, grant) }
      return grant
    }
    const sync = () => {
      for (const event of world.events(worldCursor)) {
        engine.recordFact(admin, 'mars-device', { ...event })
        worldCursor = event.seq
      }
    }
    const synchronizeProtocol = async () => {
      if (!v06Protocol) return
      await reconcile()
      if (science) { await advancePlans(); science.capture() }
      sync()
      if (world.observe().tick >= v06Protocol.stages.nextBoundary()) {
        v06Protocol.stages.synchronize({
          worldHash: contentHash({ laboratory: world.observe(), systems: world.observeSystems(), base: world.observeBase(),
            ...(world instanceof V06World ? { quality: world.quality() } : {}) }),
          worldCursor: world.eventCursor(), ledgerCursor: engine.eventCursor(admin),
        })
        phaseLedger?.synchronize(world.observe().tick, v06Protocol.stages.seals())
      }
      world.setStopAtTick(Math.min(executionStopAt, v06Protocol.stages.nextBoundary()))
      if (scientific && v06Protocol.stages.modelAdmissionClosed()) closeModelAdmissions('normal')
    }
    const eventRow = z.object({ seq: z.number(), type: z.string(), operation_id: z.string().nullable(), data_json: z.string() })
    const events = (after: number): ViewerEvent[] => engine.events(admin, after).map(raw => {
      const row = eventRow.parse(raw), data = z.json().parse(JSON.parse(row.data_json))
      const fact = z.object({ actorId: z.string(), kind: z.string(), data: z.json() }).safeParse(data)
      const tick = z.object({ tick: z.number() }).safeParse(fact.success ? fact.data.data : data)
      const logicalTick = z.object({ logicalTick: z.number() }).safeParse(data)
      const record = fact.success ? fact.data.data : data
      const physical = z.object({ payload: z.json() }).safeParse(record)
      const mutation = z.object({ result: z.json() }).safeParse(record)
      const details = z.object({ id: z.string().optional(), actorId: z.string().optional(), operationId: z.string().optional(), taskId: z.string().nullable().optional(),
        sampleId: z.string().optional(), deviceId: z.string().optional(), robotId: z.string().optional(), chamberId: z.string().optional(),
        objectiveIds: z.array(z.string()).optional(), command: z.object({ deviceId: z.string().optional(), sampleId: z.string().optional(), robotId: z.string().optional(), sourceId: z.string().optional(), chamberId: z.string().optional() }).optional(),
      }).safeParse(physical.success ? physical.data.payload : mutation.success ? mutation.data.result : record)
      const fields = details.success ? details.data : null
      const operationId = row.operation_id || fields?.operationId || (fields?.command ? fields.id : null) || null
      const actorId = fields?.actorId ?? (fact.success && fact.data.actorId !== 'mars-host' ? fact.data.actorId : operationId ? engine.get(admin, operationId).actorId : null)
      return { schemaVersion: 1 as const, ...identity, seq: row.seq, tick: logicalTick.success ? logicalTick.data.logicalTick : tick.success ? tick.data.tick : 0,
        kind: fact.success ? fact.data.kind : row.type, actorId,
        entityIds: [...new Set([fields?.sampleId, fields?.deviceId, fields?.robotId, fields?.chamberId,
          fields?.command?.deviceId, fields?.command?.sampleId, fields?.command?.robotId, fields?.command?.chamberId, fields?.command?.sourceId].filter((value): value is string => typeof value === 'string'))],
        taskId: fields?.taskId ?? (fields?.objectiveIds ? fields.id ?? null : null), operationId, payload: data }
    })
    let scoreCache: { tick: number; value: unknown } | undefined
    const scoringInput = () => {
      const facts = collectFacts(engine, admin, analysis)
      return { truth, answers, view: worldView(world), ...facts, baselines: loadBaselines(config.baselinesFile), reproducible: () => null,
        independent: independentCheck(analysis), asOfTick: world.observe().tick }
    }
    const liveScore = () => {
      const tick = world.observe().tick
      if (v06Protocol) return { benchmarkVersion: 'v0.6', implementation: config.implementation, tick, R: null, O: null, F: null,
        modelAdmissionClosed, stages: v06Protocol.stages.view(), budget: monetary ? { actualUsd: monetary.report().actualUsd, reservedUsd: monetary.report().reservedUsd, availableUsd: monetary.report().availableUsd } : null }
      if (v05) return { benchmarkVersion: 'v0.5', calibrationStatus: 'not_frozen', tick, provisional: true }
      if (!scoreCache || tick - scoreCache.tick >= 24) scoreCache = { tick, value: { provisional: true, tick, ...(computeScore(scoringInput()) as object) } }
      return scoreCache.value
    }
    let observableCache: { tick: number; value: number } | undefined
    const observableIncidents = () => {
      const tick = world.observe().tick
      if (observableCache?.tick !== tick) observableCache = { tick, value: observableIncidentCount(truth, world.events(0), tick) }
      return observableCache.value
    }
    const finalize = async () => {
      if (finalScore) return finalScore
      if (science) {
        if (world.observe().tick < executionStopAt) throw new Error('Scientific execution has not reached its stop boundary')
        await synchronizeProtocol()
        if (stopReason === 'infrastructure') {
          finalScore = { benchmarkVersion: 'v0.6', implementation: 'scientific_candidate', completionStatus: 'infrastructure_invalid', stopReason,
            tick: world.observe().tick, horizon: world.horizon, R: null, O: null, F: null, score: null, formalRankingEligible: false, budget: monetary?.report() ?? null }
          writeFileSync(join(directory, 'infrastructure-invalid-report.json'), JSON.stringify(finalScore, null, 2), { mode: 0o600 })
        } else if (executionStopAt < world.horizon) {
          finalScore = { benchmarkVersion: 'v0.6', implementation: 'scientific_candidate', completionStatus: 'early_stopped', stopReason: 'operator_stop',
            tick: world.observe().tick, horizon: world.horizon, R: null, O: null, F: null, score: null, formalRankingEligible: false, budget: monetary?.report() ?? null }
          writeFileSync(join(directory, 'early-stop-report.json'), JSON.stringify(finalScore, null, 2), { mode: 0o600 })
        } else {
          const report = { ...await science.finalize(stopReason), budget: monetary?.report() ?? null, usage: audit.usage(), mode: config.mode,
            model: config.model, modelSource: config.mode === 'environment' ? 'environment' : config.modelSource,
            costComparisonValid: monetary?.report().costStatus === 'verified' }
          finalScore = report
          writeFileSync(join(directory, 'final-score.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
          mkdirSync(join(directory, 'report'), { recursive: true, mode: 0o700 })
          writeFileSync(join(directory, 'report/summary.md'), renderScientificReport(report), { mode: 0o600 })
        }
        audit.append('mission-terminal', { status: 'completed', tick: world.observe().tick, stopReason })
        status = 'completed'
        return finalScore
      }
      if (v06Protocol) {
        await synchronizeProtocol()
        finalScore = protocolReport(engine, admin, world.observe().tick, executionStopAt)
        writeFileSync(join(directory, 'protocol-report.json'), JSON.stringify(finalScore, null, 2), { mode: 0o600 })
        status = 'completed'
        return finalScore
      }
      if (v05 && world.observe().tick < executionStopAt) throw new Error('Execution has not reached its stop boundary')
      if (v05 && executionStopAt < world.horizon) {
        const partial = buildEarlyStopReport({ engine, context: admin, analysis, world, audit, stopAtTick: executionStopAt })
        mkdirSync(join(directory, 'report'), { recursive: true, mode: 0o700 })
        writeEarlyStopReport(partial, { jsonFile: join(directory, 'early-stop-report.json'), markdownFile: join(directory, 'report/summary.md') })
        finalScore = partial
        writeFileSync(join(directory, 'final-score.json'), JSON.stringify(partial, null, 2), { mode: 0o600 })
        audit.append('mission-terminal', { status: 'stopped_by_user', tick: world.observe().tick, stopAtTick: executionStopAt, originalHorizon: world.horizon, partial: true })
        status = 'completed'
        return finalScore
      }
      if (v05) {
        const evaluationDirectory = `${directory}.evaluator`
        mkdirSync(evaluationDirectory, { recursive: true, mode: 0o700 })
        writeFileSync(join(evaluationDirectory, 'v05-input.json'), JSON.stringify(collectEvaluationInput({ engine, context: admin, analysis, world }), null, 2), { mode: 0o600 })
        ledger?.capture()
        const report = await finalizeV05({ engine, context: admin, analysis, world,
          scenario: createV05Scenario(truth, world, decisionTicks),
          analysisBindings: analysisBindings({ engine, admin, world, archive }, admin),
          replay500: async () => {
            const replay = await replayTerminalPlan({ world, engine, context: admin, directory: evaluationDirectory })
            return replay ? { researchAttainment: replay.researchAttainment, constraintAttainment: replay.constraintAttainment, trajectoryHash: replay.trajectoryHash } : { researchAttainment: 0, constraintAttainment: 0, trajectoryHash: 'no-timely-valid-plan' }
          } })
        finalScore = { ...report, benchmarkVersion: 'v0.5', tick: world.observe().tick, usage: audit.usage() }
        writeFileSync(join(evaluationDirectory, 'ledger.json'), JSON.stringify(ledger?.report()), { mode: 0o600 })
        writeFileSync(join(directory, 'final-score.json'), JSON.stringify(finalScore, null, 2), { mode: 0o600 })
        mkdirSync(join(directory, 'report'), { recursive: true, mode: 0o700 })
        writeFileSync(join(directory, 'report/summary.md'), renderV05Report({ ...report, usage: audit.usage() }), { mode: 0o600 })
        status = 'completed'
        return finalScore
      }
      const input = scoringInput()
      const values = new Map<string, boolean>()
      for (const submission of input.submissions) for (const run of submission.evidence.analysisRunIds) {
        const numbers: number[] = []
        const walk = (value: unknown) => { if (typeof value === 'number') numbers.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk) }
        walk(submission.answer)
        if (!values.has(run)) values.set(run, await analysis.reproduces(run, numbers, analysisBindings({ engine, admin, world, archive }, admin)))
      }
      for (const [run, value] of values) reproducibility.set(run, value)
      finalScore = { provisional: false, tick: world.observe().tick, usage: audit.usage(), ...(computeScore({ ...input, asOfTick: undefined, reproducible: run => values.get(run) ?? null }) as object) }
      writeFileSync(join(directory, 'final-score.json'), JSON.stringify(finalScore, null, 2), { mode: 0o600 })
      audit.append('mission-terminal', z.json().parse({ status: 'completed', tick: world.observe().tick }))
      status = 'completed'
      return finalScore
    }
    const deliverableView = () => {
      const facts = engine.readFacts(admin), deliverables: Json[] = []
      const taskSubmissions: Record<string, { accepted: number; rejected: number }> = {}
      let rejected = 0
      for (const fact of facts) {
        if (!fact.kind.startsWith('mars-deliverable-')) continue
        deliverables.push(z.json().parse({ kind: fact.kind, ...(fact.data as object) }))
        const taskId = z.object({ taskId: z.string() }).parse(fact.data).taskId
        const counts = taskSubmissions[taskId] ??= { accepted: 0, rejected: 0 }
        if (fact.kind === 'mars-deliverable-accepted') counts.accepted++
        else if (fact.kind === 'mars-deliverable-rejected') { counts.rejected++; rejected++ }
      }
      return { facts, deliverables, taskSubmissions, rejected }
    }
    const scoreView = () => {
      const { facts, taskSubmissions, rejected } = deliverableView()
      if (v05 || v06) return finalScore ?? liveScore()
      return redactScore(finalScore ?? liveScore(), status, { observableIncidents: observableIncidents(),
        reportedIncidents: facts.filter(fact => fact.kind === 'mars-incident-report').length, rejectedSubmissions: rejected, taskSubmissions })
    }
    const incidentReports = () => engine.readFacts(admin).filter(fact => fact.kind === 'mars-incident-report').map(fact => ({
      actorId: fact.actorId, ...z.object({ tick: z.number(), entities: z.array(z.string()), category: z.string().optional(),
        suspectedCause: z.string().optional(), actions: z.string().optional() }).parse(fact.data) }))
    const summaryText = (value: unknown) => {
      const text = JSON.stringify(value) ?? 'null'
      return text.length > 400 ? `${text.slice(0, 400)}…` : text
    }
    const analysisRuns = () => {
      const references: Record<string, string[]> = {}
      for (const fact of engine.readFacts(admin)) {
        if (!fact.kind.startsWith('mars-deliverable-')) continue
        const parsed = z.object({ id: z.string(), evidence: z.object({ analysisRunIds: z.array(z.string()).default([]) }).passthrough() }).safeParse(fact.data)
        if (!parsed.success) continue
        for (const id of parsed.data.evidence.analysisRunIds) (references[id] ??= []).push(parsed.data.id)
      }
      return [...analysis.ids()].flatMap(id => {
        const record = analysis.get(id)
        return record ? [{ id, actorId: record.actorId, asOfTick: record.asOfTick, status: record.status, codeSha256: record.codeSha256,
          codeBytes: Buffer.byteLength(record.code), error: record.error, outputSummary: summaryText(record.output), logCount: record.logs.length,
          references: references[id] ?? [], reproducible: reproducibility.get(id) ?? null }] : []
      }).sort((left, right) => left.asOfTick - right.asOfTick || left.id.localeCompare(right.id))
    }
    const publicEventKinds = new Set(['announcement', 'inline-doc-alarm', 'power-shed', 'battery-low', 'chamber-pressure-low',
      'crop-status-changed', 'device-fault', 'method-revised'])
    const announcements = () => {
      const events = world.events(0).filter(event => publicEventKinds.has(event.kind))
      return { total: events.length, events: events.slice(-5000) }
    }
    const evaluation = () => {
      if (status !== 'completed' || !finalScore) return { forbidden: 'Evaluation is available only after the mission completes' }
      if (v06Protocol) return { score: finalScore, research: v06Protocol.stages.view() }
      if (v05) return { score: finalScore, research: researchProjection(engine, admin, world.observe().tick) }
      type Row = { id: string; A?: number; d?: number; r?: number; points?: number }
      const parsed = z.json().parse(finalScore) as { R?: { tasks?: Row[] }; X?: { tasks?: Row[] } }
      const tasks = [...parsed.R?.tasks ?? [], ...parsed.X?.tasks ?? []]
      const systems = world.observeSystems()
      return { score: finalScore, incidents: truth.incidents, answers,
        baselines: loadBaselines(config.baselinesFile) ?? null,
        taskTruths: taskTruths(truth, answers, { crops: systems.crops, base: world.observeBase() }),
        truth: { horizon: truth.horizon, load: truth.load, seed: truth.seed, water: truth.water, bias: truth.bias, lots: truth.lots,
          storms: truth.storms, contamination: truth.contamination, drift: truth.drift, pathogen: truth.pathogen, leak: truth.leak,
          energy: truth.energy, wear: truth.wear, faults: truth.faults, recall: truth.recall, methodUpdate: truth.methodUpdate },
        crops: systems.crops.map(crop => ({ id: crop.id, status: crop.status, removed: crop.removed, infectedSince: crop.infectedSince,
          exposureTicks: crop.exposureTicks, growth: crop.growth })),
        tasks: Object.fromEntries(tasks.map(task => [task.id, { A: task.A, d: task.d, r: task.r, points: task.points }])) }
    }
    const modelActivity = () => {
      const requests = new Map<string, { requestId: string; actorId: string | null; provider: string; model: string; purpose: string; tick: number; at: number | null }>()
      const finishes = new Map<string, { at: number | null; reason: unknown }>()
      for (const record of audit.read()) {
        if (record.kind === 'model-request') {
          const parsed = z.object({ requestId: z.string(), actorId: z.string().nullish(), provider: z.string(), model: z.string(),
            purpose: z.string().optional(), tick: z.number(), at: z.number().optional() }).safeParse(record.data)
          if (parsed.success) requests.set(parsed.data.requestId, { ...parsed.data, actorId: parsed.data.actorId ?? null,
            purpose: parsed.data.purpose ?? 'conversation', at: parsed.data.at ?? null })
        }
        if (record.kind === 'model-finish') {
          const parsed = z.object({ requestId: z.string(), reason: z.json(), at: z.number().optional() }).safeParse(record.data)
          if (parsed.success) finishes.set(parsed.data.requestId, { at: parsed.data.at ?? null, reason: parsed.data.reason })
        }
        if (record.kind === 'model-deadline') {
          const parsed = z.object({ requestId: z.string(), at: z.number().optional() }).safeParse(record.data)
          if (parsed.success) finishes.set(parsed.data.requestId, { at: parsed.data.at ?? null, reason: 'deadline' })
        }
      }
      const roles = new Map<string, string>(org.snapshotParticipants().map(participant => [String(participant.id), participant.role]))
      const now = Date.now(), seconds = (milliseconds: number) => Math.round(milliseconds / 100) / 10
      const active = [...requests.values()].filter(request => !finishes.has(request.requestId)).map(request => ({
        requestId: request.requestId, actorId: request.actorId, role: request.actorId ? roles.get(request.actorId) ?? null : null,
        provider: request.provider, model: request.model, purpose: request.purpose, tick: request.tick,
        startedAt: request.at, waitedSeconds: request.at === null ? null : seconds(Math.max(0, now - request.at)),
      }))
      const recent = [...requests.values()].filter(request => finishes.has(request.requestId)).slice(-50).reverse().map(request => {
        const finish = finishes.get(request.requestId)!
        return { requestId: request.requestId, actorId: request.actorId, role: request.actorId ? roles.get(request.actorId) ?? null : null,
          provider: request.provider, model: request.model, purpose: request.purpose, tick: request.tick, reason: finish.reason,
          durationSeconds: request.at === null || finish.at === null ? null : seconds(Math.max(0, finish.at - request.at)) }
      })
      return { now, active, recent }
    }
    const snapshot = (): ViewerSnapshot => {
      sync()
      const state = world.observe(), systems = world.observeSystems()
      const map = marsLayout()
      const agentUsage = audit.agentUsage()
      const powered = powerDemand(state) <= state.facilities.powerCapacity
      const actualLight = (chamberId: string) => {
        const device = state.devices.find(value => value.id === chamberId)!
        return powered && device.enabled && !device.broken ? systems.light[chamberId] ?? world.rules.lightReference : 0
      }
      const entities: ViewerSnapshot['entities'] = state.devices.map(device => {
        const anchor = map.anchors.find(value => value.id === device.id)
        // Raw chamber temperature is hidden; Agents read the drifted sensor value through `sensors`.
        const { temperature: hiddenTemperature, ...visible } = device
        void hiddenTemperature
        return { id: device.id, kind: device.kind === 'robot' ? 'robot' : 'device',
          position: anchor ? { x: anchor.x, y: anchor.y } : null, state: z.json().parse(device.kind === 'incubator' ? {
            ...visible, lightTarget: systems.light[device.id], lightActual: actualLight(device.id), nutrient: systems.nutrient[device.id] ?? 1,
          } : visible) }
      })
      for (const vehicle of systems.robots) {
        const entity = entities.find(value => value.id === vehicle.id)!
        entity.position = { x: vehicle.x, y: vehicle.y }
        entity.state = z.json().parse({ ...state.devices.find(value => value.id === vehicle.id), ...vehicle,
          cargo: state.samples.filter(sample => sample.location === vehicle.id && sample.volumeUl > 0).map(sample => sample.id) })
      }
      for (const crop of systems.crops) {
        const chamber = map.anchors.find(value => value.id === crop.chamberId)!
        const batch = Number(crop.id.split('-').at(-1))
        // Infection timing and contamination windows are hidden truth; Agents infer them from measurements.
        const { infectedSince: hiddenInfection, contamination: hiddenContamination, ...visible } = crop
        void hiddenInfection, void hiddenContamination
        entities.push({ id: crop.id, kind: 'crop', position: { x: chamber.x + batch * 2 - 2, y: chamber.y + 2 }, state: z.json().parse({ ...visible,
          profile: world.rules.cropProfiles.find(profile => profile.batch === batch), lightActual: actualLight(crop.chamberId) }) })
      }
      const samplesById = new Map(state.samples.map(sample => [sample.id, sample]))
      for (const sample of state.samples) {
        let root = sample
        while (root.parentId) { const parent = samplesById.get(root.parentId); if (!parent) break; root = parent }
        const origin = state.operations.find(operation => operation.outputSampleIds?.includes(sample.id))
        entities.push({ id: sample.id, kind: 'sample', position: entities.find(entity => entity.id === sample.location)?.position ?? null,
          state: z.json().parse({ ...sample, rootSampleId: root.id, sourceId: systems.sampleSources[root.id] ?? null,
            createdTick: origin?.completedTick ?? (systems.sampleConditions[sample.id] as { tick?: number } | undefined)?.tick ?? 0 }) })
      }
      const { facts, deliverables, taskSubmissions, rejected } = deliverableView()
      const reportedIncidents = facts.filter(fact => fact.kind === 'mars-incident-report').length
      return { schemaVersion: 1, stage: v05 || v06 ? 'experiment' : 'foundation', ...identity, cursor: engine.eventCursor(admin),
        tick: state.tick, seed: v05 || v06 ? 0 : config.seed, mode: config.mode, status,
        capabilities: { trajectories: true, cropSimulation: true, objectiveAssessment: !v06 || scientific, checkpointSave: true,
          checkpointRestore: config.supervised === true && existsSync(`${directory}.owner.json`), scoring: !v06 || scientific },
        ...(v06Protocol ? { research: z.json().parse(v06Protocol.stages.view()) } : v05 ? { research: z.json().parse(researchProjection(engine, admin, world.observe().tick)) } : {}),
        model: config.model, mission: mission(load, undefined, true, world.observe().tick, world.horizon), map, rules: z.json().parse(world.rules), history: z.json().parse(archive.manifest), utilities: { ...state.facilities, powerDemand: powerDemand(state) },
        entities, messages: mail.snapshot(), agents: org.snapshotParticipants().map(participant => ({ ...participant, parentId: participant.parentId ?? null,
          status: ctx.agents.get(participant.id)?.status ?? 'inactive', tools: org.config.roles[participant.role]!.tools ?? [],
          model: org.config.roles[participant.role]!.model?.model ?? config.model.model, usage: agentUsage[participant.id] ?? { requests: 0, inputTokens: 0, outputTokens: 0, reportedUsage: false } })), tasks: records.listTasks(), notes: records.listNotes(),
        operations: engine.list(admin).map(value => logicalOperationView(z.json().parse(value), world)), deliverables, sensors: z.json().parse(world.sensors()), usage: audit.usage(),
        score: z.json().parse(v05 || v06 ? (finalScore ?? liveScore()) : redactScore(finalScore ?? liveScore(), status, { observableIncidents: observableIncidents(), reportedIncidents, rejectedSubmissions: rejected, taskSubmissions })) }
    }
    const applyingCalls = new Set<string>()
    const responseBytes = new Map<string, number>()
    const renderBoundedToolResult = (actorId: string, name: string, text: string) => {
      const bytes = Buffer.byteLength(text)
      if (!modern) return text
      const available = Math.max(0, 48000 - (responseBytes.get(actorId) ?? 0))
      const budget = Math.min(12000, available)
      if (bytes <= budget) { responseBytes.set(actorId, (responseBytes.get(actorId) ?? 0) + bytes); return text }
      const project = (length: number) => {
        // Never cut a UTF-16 surrogate pair. JSON escaping is included in the byte budget.
        if (length > 0 && /[\uD800-\uDBFF]/.test(text.charAt(length - 1))) length--
        return JSON.stringify({ truncated: true, tool: name, fullResultBytes: bytes, preview: text.slice(0, length),
          next: 'Complete data remains in the backend. Use paged/filter queries or analysis_run readArtifact/readRaw/archiveSql.' })
      }
      let low = 0, high = Math.min(text.length, budget)
      while (low < high) { const middle = Math.ceil((low + high) / 2); if (Buffer.byteLength(project(middle)) <= budget) low = middle; else high = middle - 1 }
      const projected = Buffer.byteLength(project(low)) <= budget ? project(low) : ''
      responseBytes.set(actorId, (responseBytes.get(actorId) ?? 0) + Buffer.byteLength(projected))
      return projected
    }
    const actorKey = (id: string) => {
      if (!scientific) return id
      const role = org.snapshotParticipants().find(p => String(p.id) === id)?.role
      const rank = ['brain', ...SPECIALISTS].findIndex(r => r === role)
      if (rank >= 0) return String(rank).padStart(2, '0')
      if (config.mode === 'environment') return `reference:${id}`
      throw new Error('Scientific plan actor is not in the frozen team')
    }
    const nativeRounds = new NativeRounds(engine, admin, () => world.observe().tick, decisionTicks,
      () => org.snapshotParticipants().map(participant => String(participant.id)), () => z.json().parse({ tick: world.observe().tick, cursor: engine.eventCursor(admin), sensors: world.sensors() }), namespace, actorKey)
    const delivery = stages.researchWorkflow === deliveryVersion ? new DeliveryLedger(engine, admin, () => world.observe().tick) : null
    const deliveryRoles = multi ? ['brain', ...SPECIALISTS] : ['single']
    const deliveryRole = (id:string) => {
      const p = org.snapshotParticipants().find(p=>p.id===id)
      if (!p) throw new Error('Unknown receipt-work participant')
      return multi ? p.role : 'single'
    }
    let deliveringReceipts = false, deliveryChanged = false
    const publishReceipts = async () => {
      if (!delivery || modelAdmissionClosed || ended || shutdown.signal.aborted) return
      if (deliveringReceipts) { deliveryChanged = true; return }
      deliveringReceipts = true
      try {
        do {
          deliveryChanged = false
          for (const [role,items] of delivery.due()) {
            const participant = org.snapshotParticipants().find(p=>p.role===(multi ? role : 'brain'))
            if (!participant || (ctx.agents.get(participant.id)?.status==='running' && !waiting.has(participant.id))) continue
            const message=receiptMail(role,items)
            await mail.system(role,message.key,message.text,shutdown.signal)
            delivery.notified(message.members)
          }
        } while (deliveryChanged && !modelAdmissionClosed && !shutdown.signal.aborted)
      } finally { deliveringReceipts = false }
    }
    const commitRound = async () => {
      if (!modern) return
      if (infrastructureFailed.size) return
      const applied = await nativeRounds.commit(async (actorId, callId, name, args) => {
        if (scientific && modelAdmissionClosed) return { isError: true, error: { message: 'Model admission closed before pending intent acceptance' } }
        const agent = members.get(actorId)
        if (!agent) throw new Error('Round actor unavailable; resume original participant before committing')
        applyingCalls.add(callId)
        try {
          const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: ToolCallId(callId), name, arguments: JSON.stringify(args) }], agent, signal: shutdown.signal })
          const result = batch.results[0]?.result
          if (!result) throw new Error('Missing applied tool result')
          engine.recordFact(admin, 'mars-tool-result', { actorId, name, callId, isError: result.isError, tick: world.observe().tick })
          if (name === 'analysis_run' && !result.isError) for (const id of analysis.ids()) {
            const run = analysis.get(id)
            if (run?.actorId === actorId && run.status === 'done' && !engine.readFacts(admin).some(fact => fact.kind === `mars-${namespace}-analysis-published` && (fact.data as { id?: string }).id === id)) engine.recordFact(admin, `mars-${namespace}-analysis-published`, { id, tick: world.observe().tick })
          }
          return z.json().parse(result.isError ? { isError: true, error: result.error } : { isError: false, value: result.value })
        } finally { applyingCalls.delete(callId) }
      })
      if (applied) await publishReceipts()
    }
    const register = (name: string, description: string, parameters: ParameterSchemaSpec,
      body: (args: Record<string, unknown>, agent: Agent, signal: AbortSignal) => unknown | Promise<unknown>) => {
      ctx.tools.register(defineTool({ name, description, parameters: delivery && followsReceipts(name) ? {...parameters, follow_up:followUpParameter} : parameters,
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(args, execution) {
          if (!execution.agent) throw new Error('Native participant required')
          access(execution.agent, name)
          return z.json().parse(await body(refs.resolveArgs(args), execution.agent, execution.signal))
        } }))
    }
    if (delivery) installDeliveryTools(register, delivery, world, deliveryRole, deliveryRoles, role=>org.snapshotParticipants().some(p=>p.role===(multi ? role : 'brain')))
    register('round_receipts', 'Read your durable pending-tool outcomes from committed rounds. Mutations return pending until the common round boundary.', delivery ? {call_id:{type:'string'}} : {}, (args,agent) => {
      const rows = nativeRounds.receipts(agent.id, delivery ? z.string().optional().parse(args.call_id) : undefined)
      if (delivery) delivery.readReceipts(deliveryRole(agent.id),agent.id,rows)
      return rows
    })
    const id = { type: 'string', required: true } as const, integer = { type: 'integer', required: true } as const
    const recordFor = (agent: Agent, name: string) => new MarsRecords(engine, access(agent, name), () => world.observe().tick, v06 ? V06_TASK_IDS : v05 ? V05_TASK_IDS : undefined)
    installOrganizationTools(ctx, org)
    installExperimentTools(ctx, engine, access)
    // Robots belong to roles in the fixed team (robot-1 water, robot-2 agronomist, robot-3 engineer); the single agent drives all three.
    const robotsFor = (agent: Agent) => multi && !modern ? TEAM[org.assertActor(agent).role as TeamRole]?.robots ?? [] : ALL_ROBOTS
    const physicalPlanTools = installPhysicalTools(ctx, engine, world, access, refs, { robotsFor,
      ...(scientific ? { referenceSpecification: 'R3 measures chamber reference conditions or a biased fast water probe. Water DOC requires calibration against certified fast-channel standards; it is not laboratory truth.' } : {}),
      ...(v06 ? { objectiveIds: V06_TASK_IDS } : v05 ? { objectiveIds: V05_TASK_IDS } : {}),
      roleOf: actorId => org.snapshotParticipants().find(participant => participant.id === actorId)?.role })
    register('mission_read', 'Read the mission: situation, scoring rules, tasks with answer schemas and their duty windows, priors and physics. Specialist roles see their own domain by default; full=true returns every task.',
      { full: { type: 'boolean' } }, (args, agent) => {
        const role = org.assertActor(agent).role
        return { ...mission(load, config.mode === 'multi-agent' ? role : undefined, args.full === true, world.observe().tick, world.horizon), executionControl: { stopAtTick: executionStopAt, originalHorizon: world.horizon, notice: stopNotice }, organization: organizationCatalog(role) }
      })
    if (v05) installResearchTools({ register, engine, world, analysis, access, decisionTicks, publicScenario: v05Scenario?.public, resolveReference: id => refs.resolve(id) })
    if (v06Protocol) installV06ResearchTools({ register, engine, tick: () => world.observe().tick, profile: stages, decisionTicks, access,
      ...(scientific ? { physicalPlanTools } : {}),
      ...(world instanceof V06World ? { modelTestOptions: { timeoutMs: world.scienceProfile.modelTimeoutMs, memoryMb: world.scienceProfile.modelMemoryMb, maxOutputBytes: world.scienceProfile.modelOutputBytes } } : {}),
      ...(science ? { catalog: () => { const budget = monetary?.report(); return { ...science!.catalog(), budget: budget ? {
        limitUsd: budget.limitUsd, actualUsd: budget.actualUsd, reservedUsd: budget.reservedUsd, availableUsd: budget.availableUsd, costStatus: budget.costStatus } : null } },
        actions: science.actionsFor, serviceReview: science.serviceReview, readPilot: science.readPilot, evidenceCheck: science.evidenceCheck, referencePicker: science.referencePicker } : {}), resolveReference: id => refs.resolve(id),
      resolvers: science?.resolvers ?? { evidence: (id, revision) => {
        if (revision !== undefined && revision !== 1) return null
        const canonical = refs.resolve(id), state = world.observe()
        const result = state.results.find(item => item.id === canonical && item.completedTick !== null)
        if (result) return { availableAt: result.completedTick! }
        const operation = [...state.operations, ...world.observeSystems().operations].find(item => item.id === canonical && item.state === 'succeeded')
        if (operation?.completedTick !== null && operation?.completedTick !== undefined) return { availableAt: operation.completedTick }
        const run = analysis.get(canonical)
        return run?.status === 'done' ? { availableAt: run.asOfTick } : null
      } } })
    const advancePlans = modern ? installPlanningTools({ register, engine, world, access, namespace, actorKey, resolveArgs: input => refs.resolveArgs(input),
      ...(world instanceof V06World ? {currentTick:()=>world.currentTick()} : {}),
      ...(v06 ? { physicalPlanTools } : {}),
      ...(science ? { servicePlans: { commissions: science.manifest.commissions, isCommitted: science.isServiceCommitted, receipts: science.serviceReceipts } } : {}),
      ...(physicalObserver ? { observeOperation: physicalObserver.query.bind(physicalObserver) } : {}),
      admissionOpen: () => !scientific || !modelAdmissionClosed && world.observe().tick < stages.finalTick,
      mayDispatch: plan => !scientific || world.observe().tick < executionStopAt && (science?.mayDispatch(plan) ?? false) &&
        (!modelAdmissionClosed || world.observe().tick >= stages.finalTick || stoppedPlanHashes.has(`${plan.id}:${planHash(plan)}`)) }) : async () => {}
    const logArchive = <T extends { queryId: string }>(agent: Agent, tool: string, result: T) => { engine.recordFact(access(agent, tool), 'mars-archive-query', { queryId: result.queryId }); return result }
    register('archive_search', 'Search historical operating documents, preserving revision and obsolete status.',
      { query: id, offset: { type: 'integer' }, limit: { type: 'integer' } }, (args, agent) => logArchive(agent, 'archive_search', archive.search(String(args.query), Number(args.offset ?? 0), Number(args.limit ?? 20))))
    register('archive_query', 'Page immutable simulated history. Negative ticks precede this mission; current truth comes from live tools.',
      { kind: { type: 'string', enum: ['sensors', 'corrections', 'maintenance', 'experiments', 'documents', 'lots', 'lot_qc', 'reference_checks', 'incidents', 'chromatograms'], required: true }, entity_id: { type: 'string' }, record_id: { type: 'string' },
        from_tick: { type: 'integer' }, to_tick: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, (args, agent) => logArchive(agent, 'archive_query', archive.query({ kind: args.kind,
          ...(args.entity_id === undefined ? {} : { entityId: args.entity_id }), ...(args.record_id === undefined ? {} : { id: args.record_id }),
          ...(args.from_tick === undefined ? {} : { fromTick: args.from_tick }), ...(args.to_tick === undefined ? {} : { toTick: args.to_tick }), offset: args.offset ?? 0, limit: args.limit ?? 50 })))
    register('archive_stats', 'Aggregate a large historical sensor series without loading it into context.', { entity_id: id, metric: id }, (args, agent) => logArchive(agent, 'archive_stats', archive.statistics(String(args.entity_id), String(args.metric))))
    register('mars_inbox', 'Read your own pending project work mail and persist explicit receipts.', {}, (_args, agent) => mail.inbox(agent))
    register('mars_message', 'Send project work directly to a registered role; runtime handles native lineage relay.',
      { request_key: id, target_role: id, content: id, task_id: { type: 'string' } }, (args, agent, signal) => mail.send(agent, access(agent, 'mars_message'), String(args.request_key), String(args.target_role), String(args.content), typeof args.task_id === 'string' ? args.task_id : null, signal))
    register('task_list', 'Read actual Agent-authored tasks; initially empty.', {}, () => records.listTasks())
    register('task_create', 'Create your own task; input_json contains title, objectiveIds, optional description, dependencies and assignee.',
      { request_key: id, input_json: id }, (args, agent) => recordFor(agent, 'task_create').createTask(String(args.request_key), JSON.parse(String(args.input_json))))
    register('task_update', 'Update your plan with current revision; patch_json includes reason.',
      { request_key: id, task_id: id, revision: integer, patch_json: id }, (args, agent) => recordFor(agent, 'task_update').updateTask(String(args.request_key), String(args.task_id), Number(args.revision), JSON.parse(String(args.patch_json))))
    register('note_read', 'Read persistent text by path or search query, with paging.',
      { path: { type: 'string' }, query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' }, start_line: { type: 'integer' }, line_count: { type: 'integer' } }, args => {
        const offset = z.number().int().nonnegative().parse(args.offset ?? 0), limit = z.number().int().min(1).max(200).parse(args.limit ?? 20)
        const notes = records.listNotes().filter(note => (!args.path || note.path === args.path) && (!args.query || note.path.includes(String(args.query)) || note.text.includes(String(args.query))))
        const start = z.number().int().positive().parse(args.start_line ?? 1), count = z.number().int().min(1).max(500).parse(args.line_count ?? 80)
        return { total: notes.length, offset, limit, notes: notes.slice(offset, offset + limit).map(note => {
          const lines = note.text.split('\n')
          return { path: note.path, revision: note.revision, updatedBy: note.updatedBy, updatedTick: note.updatedTick, totalLines: lines.length,
            ...(args.path ? { startLine: start, text: lines.slice(start - 1, start - 1 + count).join('\n') } : { excerpt: note.text.slice(0, 300) }) }
        }) }
      })
    register('note_write', 'Create or edit persistent text; revision zero creates, current revision edits.',
      { request_key: id, path: id, revision: integer, text: id }, (args, agent) => {
        const note = recordFor(agent, 'note_write').writeNote(String(args.request_key), String(args.path), Number(args.revision), String(args.text))
        return { path: note.path, revision: note.revision, updatedBy: note.updatedBy, updatedTick: note.updatedTick, characters: note.text.length }
      })
    register('note_edit', 'Replace exactly one matching text fragment using the current note revision.',
      { request_key: id, path: id, revision: integer, old_text: id, new_text: { type: 'string', required: true } }, (args, agent) => {
        const note = recordFor(agent, 'note_edit').editNote(String(args.request_key), String(args.path), Number(args.revision), String(args.old_text), String(args.new_text))
        return { path: note.path, revision: note.revision, updatedBy: note.updatedBy, updatedTick: note.updatedTick, characters: note.text.length }
      })
    register('mars_observe', 'Read current sensor readings (chambers, crops, water, energy, CO2, spares), devices, running work and managed operations. Readings may drift; use device_reference for ground truth.', {}, () => {
      const state = world.observe(), systems = world.observeSystems()
      return { ...world.sensors(), eventCursor: world.eventCursor(),
        devices: state.devices.map(device => { if (device.kind !== 'incubator') return device; const { temperature: _hidden, ...visible } = device; return visible }),
        operations: state.operations.filter(operation => operation.state === 'running'), systemOperations: systems.operations.filter(operation => operation.state === 'running'),
        pendingManagedOperations: engine.list(admin).filter(operation => !['succeeded', 'failed', 'cancelled'].includes(operation.state)).map(operation => operation.id),
        robots: systems.robots.map(robot => ({ id: robot.id, node: robot.node, energy: robot.energy, operationId: robot.operationId })),
        batches: state.batches, summary: { samples: state.samples.length, measurements: state.results.length } }
    })
    register('mars_catalog', 'Describe your allowed physical capabilities, input schemas and methods.', {}, (_args, agent) => ({ organization: organizationCatalog(org.assertActor(agent).role), providers: engine.descriptions(access(agent, 'mars_catalog')), methods: world.observe().methods, map: marsLayout(), history: archive.manifest, rules: world.rules, sources: [...world.observeSystems().crops.map(crop => crop.id), ...world.observe().devices.filter(device => device.kind === 'water-module').map(device => device.id)] }))
    register('mars_submit', 'Submit a physical action with stable request key through your provider capability.',
      { provider_id: id, request_key: id, input_json: id }, (args, agent) => {
        const input = z.json().parse(refs.resolveArgs(JSON.parse(String(args.input_json))))
        if (z.object({ action: z.literal('process') }).safeParse(input).success) throw new Error('Use a structured scientific tool with task_id, or execute an approved experiment_act stage')
        return engine.submit(access(agent, 'mars_submit'), { providerId: String(args.provider_id), requestKey: String(args.request_key), input })
      })
    const preview = (read: ReturnType<Artifacts['read']>) => read.artifact.path.endsWith('raw.json') && read.content.length > 4000
      ? { artifact: read.artifact, content: null, note: `Raw instrument data (${read.content.length} bytes). Load it inside analysis_run with readArtifact('${read.artifact.id}').`, head: read.content.slice(0, 400) }
      : read
    register('mars_result', 'Query one operation and read its verified output artifacts.', { operation_id: id }, async (args, agent) => {
      const grant = access(agent, 'mars_result'), operation = await engine.query(grant, String(args.operation_id))
      const outputs = operation.artifacts.map(artifact => preview(artifacts.read(grant, artifact.id)))
      engine.recordFact(grant, 'mars-artifact-read', { artifactIds: operation.artifacts.map(artifact => artifact.id), tick: world.observe().tick })
      return { operation, artifacts: outputs }
    })
    const QUIET = new Set(['robot-position', 'logical-decision-progress', 'device-temperature-stable', 'sample-temperature-changed', 'robot-route-accepted', 'operation-processing', 'system-operation-accepted'])
    // Steps of a laboratory procedure finish quietly; the procedure reports once, by mail, when its result is ready.
    const internalStep = (event: { kind: string; payload: unknown }) => ['operation-finished', 'system-operation-settled'].includes(event.kind) &&
      procedures.internal(z.object({ id: z.string() }).passthrough().safeParse(event.payload).data?.id ?? '')
    const notable = (after: number) => world.events(after).filter(event => !QUIET.has(event.kind) && !internalStep(event))
    register('mars_wait', 'Wait until a notable physical event, new mail, or until_tick (if given). Returns notable events since the call.', { until_tick: { type: 'integer' } }, async (args, agent, signal) => {
      if (mail.hasUnread(agent.id)) return { tick: world.observe().tick, reason: 'mail', messages: mail.inbox(agent) }
      const cursor = world.eventCursor(), until = args.until_tick === undefined ? Infinity : Math.min(Number(args.until_tick), executionStopAt)
      const ready = () => notable(cursor).length > 0 || mail.hasUnread(agent.id) || world.observe().tick >= until || world.observe().tick >= executionStopAt
      waiting.add(agent.id)
      const release = clock.waiting(agent.id, ready)
      clock.wake()
      try {
        while (!ready()) {
          signal.throwIfAborted()
          await new Promise<void>(resolve => setTimeout(resolve, 25))
        }
        await barrier.enter(agent.id, signal)
        const events = notable(cursor).slice(-40), guidance = mail.guidance(org.assertActor(agent).role, events.map(event => event.kind))
        return { tick: world.observe().tick, events, ...(guidance.length ? { guidance } : {}), messages: mail.inbox(agent) }
      } finally { release(); waiting.delete(agent.id) }
    })
    register('artifact_read', 'Read a verified project artifact before using it as evidence.', { artifact_id: id }, (args, agent) => {
      const grant = access(agent, 'artifact_read'), artifact = artifacts.read(grant, String(args.artifact_id))
      engine.recordFact(grant, 'mars-artifact-read', { artifactIds: [String(args.artifact_id)], tick: world.observe().tick })
      return preview(artifact)
    })
    installV2Tools({ register, access, engine, admin, world, archive, analysis, load, refs })
    const procedureTool = (kind: 'water_assay' | 'water_split') => async (args: Record<string, unknown>, agent: Agent) => {
      const grant = access(agent, kind), requestKey = String(args.request_key)
      const prior = procedures.byKey(grant.actorId, requestKey)
      if (prior) return { duplicate: true, ...prior }
      const sourceId = typeof args.source_id === 'string' ? args.source_id : undefined, sampleId = typeof args.sample_id === 'string' ? args.sample_id : undefined
      if (kind === 'water_split' || !sampleId) z.enum(['reservoir', 'filter', 'pump'], { error: 'source_id must be reservoir, filter or pump' }).parse(sourceId)
      if (kind === 'water_assay' && sourceId && sampleId) throw new Error('Give source_id (a fresh module sample) or sample_id (a stored water sample), not both')
      const storage = kind === 'water_split' ? z.array(z.enum(STORAGE_NAMES as [string, ...string[]])).min(1).max(3).parse(args.storage) : undefined
      return { ...await procedures.start({ kind, actorId: grant.actorId, requestKey, providers: ['water'], robot: robotsFor(agent).includes('robot-1') ? 'robot-1' : robotsFor(agent)[0] ?? 'robot-1',
        taskId: String(args.task_id), ...(sourceId ? { sourceId } : {}), ...(sampleId ? { sampleId } : {}),
        ...(kind === 'water_assay' ? { method: z.enum(['confirm', 'screen']).parse(args.method ?? 'confirm') } : {}),
        ...(storage ? { storage, copies: z.number().int().min(1).max(5).parse(args.copies ?? 5) } : {}),
        ...(typeof args.extraction_batch === 'string' ? { extractionBatch: args.extraction_batch } : {}) }),
        note: 'The procedure runs on its own; a [流程完成] or [流程失败] message (mars_wait wakes on it) brings the result refs and values.' }
    }
    register('water_assay', 'Measure water in one call: a fresh sample from a module (source_id: reservoir, filter or pump), or a stored raw water sample (sample_id, e.g. an aliquot from water_split), goes through water-prepare and confirm (or straight to screen with method="screen") on the real devices with your robot. Takes tens of ticks; the result r-N is already read and can be cited. Cleaning between uses is automatic; an expired confirm calibration waits for the engineer.',
      { request_key: id, task_id: id, source_id: { type: 'string' }, sample_id: { type: 'string' }, method: { type: 'string', enum: ['confirm', 'screen'] }, extraction_batch: { type: 'string' } }, procedureTool('water_assay'))
    register('water_split', 'Take one mother sample from a module and split it into aliquots kept in the chosen stores (cold-1 or cold-2 at 4 °C, freezer at -10 °C, bench at 22 °C), copies per store (1-5, default 5). For degradation series: later measure each aliquot with water_assay(sample_id=...).',
      { request_key: id, task_id: id, source_id: id, storage: { type: 'array', items: { type: 'string', enum: STORAGE_NAMES }, required: true }, copies: { type: 'integer' } }, procedureTool('water_split'))
    installTeamTools({ register, world, engine, admin, refs, load, multi, roleOf: agent => org.assertActor(agent).role, procedures: actorId => procedures.list(actorId),
      members: () => org.snapshotParticipants().map(participant => ({ id: String(participant.id), role: participant.role, status: ctx.agents.get(participant.id)?.status ?? 'inactive' })),
      mail: () => mail.snapshot() })
    let root: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
    ctx.on('agent/created', async ({ agent }) => {
      if (!agent.session.header.parentSession && agent.id.startsWith('mars-brain-')) await org.registerRoot(agent, mission(load, undefined, true, world.observe().tick, world.horizon).instructions)
      try { org.assertActor(agent); members.set(agent.id, agent) } catch (error) {
        if (agent.id.startsWith('mars-brain-')) throw error
        return
      }
      // v0.4 hides organization, hand-written-experiment and wall-clock-wait tools from every member (team.ts).
      const installed = new Set(ctx.tools.schemas().map(tool => tool.name))
      agent.ctx.tools.restrict({ deny: HIDDEN_TOOLS.filter(name => installed.has(name)) })
    })
    ctx.on('agent/disposed', ({ agent }) => { const grant = grants.get(agent); if (grant) engine.revokeContext(grant); members.delete(agent.id) })
    ctx.on('tools/execute', async (execution, next) => {
      if (!execution.agent || !members.has(execution.agent.id)) return next()
      const applying = applyingCalls.has(execution.callId)
      if (applying) return next()
      if (scientific && (modelAdmissionClosed || world.observe().tick >= stages.finalTick) && isV05Mutation(execution.name, execution.arguments)) throw new Error('Scientific mutation admission closed')
      await barrier.enter(execution.agent.id, execution.signal)
      if (modern && config.mode !== 'environment' && isV05Mutation(execution.name, execution.arguments)) {
        const follow = delivery ? deliverySpec(execution.name, z.record(z.string(),z.unknown()).parse(execution.arguments), deliveryRole(execution.agent.id), deliveryRoles, stages, science?.manifest.commissions) : undefined
        const pending = nativeRounds.queue(execution.agent.id, execution.callId, execution.name, execution.arguments, follow)
        const receipt = follow && delivery ? {...pending,work:delivery.lookup(execution.agent.id,pending.round,execution.callId)} : pending
        return { isError: false as const, value: z.json().parse(receipt), content: [{ type: 'text' as const, text: JSON.stringify(receipt) }] }
      }
      const release = clock.toolStarted(execution.agent.id)
      const writes = execution.name !== 'mars_wait'
      if (writes) barrier.writes++
      try {
        const result = await next()
        engine.recordFact(admin, 'mars-tool-result', { actorId: execution.agent.id, name: execution.name,
          callId: execution.callId, isError: result.isError, tick: world.observe().tick })
        if (result.isError) return result
        if (modern && execution.name === 'analysis_run') {
          for (const id of analysis.ids()) {
            const run = analysis.get(id)
            if (run?.actorId === execution.agent.id && run.status === 'done' && !engine.readFacts(admin).some(fact => fact.kind === `mars-${namespace}-analysis-published` && (fact.data as { id?: string }).id === id))
              engine.recordFact(admin, `mars-${namespace}-analysis-published`, { id, tick: world.observe().tick })
          }
        }
        const value = refs.augment(logicalOperationView(z.json().parse(result.value), world))
        return { ...result, value }
      } finally { if (writes) barrier.writes--; release(); sync(); ledger?.capture(); mail.project() }
    })
    // tools/execute content is re-rendered by core normalization. Post-execute is the
    // authoritative projection seam; only visible content changes, never canonical values.
    ctx.on('tools/post-execute', async (execution, result, next) => {
      const decision = await next()
      if (!modern || !execution.agent || !members.has(execution.agent.id) || applyingCalls.has(execution.callId) || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      const original = decision.content ?? result.content
      const text = original.map(block => block.type === 'text' ? block.text : JSON.stringify(block)).join('\n')
      return { kind: 'accept' as const, content: [{ type: 'text' as const, text: renderBoundedToolResult(execution.agent.id, execution.name, text) }],
        ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) }
    })
    ctx.on('llm/stream', async function* (options, next) {
      if (v06 && !scientific) throw new LlmError('v0.6 protocol-only mode does not admit external model requests', 'ABORTED')
      if (scientific && config.mode === 'environment') throw new LlmError('Keyless scientific environment does not admit model requests', 'ABORTED')
      if (!providerPool.includes(options.provider)) {
        if (scientific) throw new LlmError('Model route outside the frozen scientific provider pool', 'ABORTED')
        return yield* next()
      }
      if (ended || modelAdmissionClosed || world.observe().tick >= executionStopAt || scientific && world.observe().tick >= stages.finalTick)
        throw new LlmError('Model admission closed; no further external model requests', 'ABORTED')
      const requestId = randomUUID()
      if (scientific) {
        if (!monetary) throw new LlmError('Scientific model request has no monetary admission ledger', 'ABORTED')
        const admissionSignal = options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal
        try {
          const bound = monetary.config.prices.find(p => p.provider === options.provider && p.model === options.model)
          await monetaryAdmissions!.reserve(requestId, String(options.sessionId ?? 'host'), options.provider, options.model,
            options.maxTokens ?? bound?.maxOutputTokens ?? config.model.maxTokens, admissionSignal)
        } catch (error) {
          if (!admissionSignal.aborted) {
            if (error instanceof BudgetExhausted) closeModelAdmissions('budget_exhausted')
            else closeModelAdmissions('infrastructure')
          }
          throw new LlmError(error instanceof Error ? error.message : 'Monetary admission refused', 'ABORTED')
        }
      }
      barrier.models++
      const release = clock.modelStarted()
      const requestMetadata = { ...identity, requestId, recoveryCheckpointId: recoveryCheckpointId ?? null,
        actorId: options.sessionId ?? null, at: Date.now() }
      let lastUsage: unknown | null = null, finishes = 0, dispatched = false
      try {
        audit.append('model-request', z.json().parse({ ...requestMetadata, provider: options.provider, model: options.model, purpose: options.purpose ?? 'conversation', tick: world.observe().tick }))
        engine.recordFact(admin, 'mars-model-request', { provider: options.provider, model: options.model, purpose: options.purpose ?? 'conversation', tick: world.observe().tick })
        if (scientific) monetary!.dispatched(requestId)
        dispatched = true
        const deadline = Date.now() + (config.modelRequestDeadlineMs ?? 1200000)
        const iterator = next()[Symbol.asyncIterator]()
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined
          const expired = new Promise<'expired'>(resolve => { timer = setTimeout(() => resolve('expired'), Math.max(0, deadline - Date.now())) })
          const step = await Promise.race([iterator.next(), expired]).finally(() => clearTimeout(timer))
          if (step === 'expired') {
            if (scientific) {
              void iterator.return?.(undefined).catch(error => audit.append('provider-cleanup-error', { requestId, message: String(error) }))
              const owner = options.sessionId ? members.get(String(options.sessionId)) : undefined
              owner?.cancel({ kind: 'hook', reason: 'Model request exceeded frozen deadline' })
            } else await iterator.return?.(undefined)
            audit.append('model-deadline', z.json().parse({ ...requestMetadata, at: Date.now(), tick: world.observe().tick }))
            throw new LlmError('Model request exceeded the runtime deadline', 'TIMEOUT')
          }
          if (step.done) break
          const chunk = step.value
          if (chunk.type === 'usage') {
            lastUsage = chunk.usage
            const data = z.json().parse({ ...requestMetadata, at: Date.now(), provider: options.provider, model: options.model,
              usage: chunk.usage, purpose: options.purpose ?? 'conversation', tick: world.observe().tick })
            audit.append('model-usage', data)
            engine.recordFact(admin, 'mars-model-usage', data)
          }
          if (chunk.type === 'finish') {
            finishes++
            audit.append('model-finish', z.json().parse({ ...requestMetadata, at: Date.now(), reason: chunk.reason, tick: world.observe().tick }))
            if (scientific && chunk.reason.kind === 'error' && !infrastructureCode(chunk.reason.failure.code, chunk.reason.failure.status)) closeModelAdmissions('model_error')
            if (modern && options.sessionId && !modelAdmissionClosed) {
              if (chunk.reason.kind === 'error' && infrastructureCode(chunk.reason.failure.code, chunk.reason.failure.status)) markInfrastructureFailure(String(options.sessionId), chunk.reason.failure.code)
              else if (chunk.reason.kind !== 'error' && (options.purpose ?? 'conversation') === 'conversation' && infrastructureFailed.delete(String(options.sessionId))) {
                infrastructureAttempts.delete(String(options.sessionId))
                engine.recordFact(admin, `mars-${namespace}-infrastructure-recovered`, { actorId: String(options.sessionId), tick: world.observe().tick })
                if (!infrastructureFailed.size && status === 'attention-required') status = 'running'
              }
            }
            if (chunk.reason.kind === 'error' && COOLING_CODES.has(chunk.reason.failure.code)) {
              const cooldown = providers.cool(options.provider, chunk.reason.failure.code)
              const data = z.json().parse({ ...requestMetadata, provider: options.provider, code: chunk.reason.failure.code,
                until: cooldown.until, remainingMs: cooldown.remainingMs, tick: world.observe().tick })
              audit.append('provider-cooldown', data)
              engine.recordFact(admin, 'mars-provider-cooldown', data)
            }
          }
          yield chunk
        }
      } catch (error) {
        if (modern && options.sessionId && !modelAdmissionClosed && error instanceof LlmError && infrastructureCode(error.failure.code, error.failure.status))
          markInfrastructureFailure(String(options.sessionId), error.failure.code)
        throw error
      } finally {
        try {
          if (scientific && monetary) {
            if (!dispatched) monetary.release(requestId)
            else {
              try { monetary.settle(requestId, finishes === 1 ? lastUsage : null) }
              catch (error) {
                monetary.settle(requestId, null)
                audit.append('budget-usage-unverified', { requestId, reason: error instanceof Error ? error.message : String(error) })
                closeModelAdmissions('infrastructure')
              }
              if (finishes > 1 || monetary.report().costStatus === 'invalid_bounds') {
                audit.append('budget-route-invalid', { requestId, finishes, tick: world.observe().tick })
                closeModelAdmissions('infrastructure')
              }
            }
          }
        } finally { monetaryAdmissions?.complete(requestId); barrier.models--; release() }
      }
    })
    ctx.on('session/event', (session, event) => {
      if (!org.snapshotParticipants().some(participant => participant.id === session.id)) return
      if (['assistant/message', 'compaction/summary'].includes(event.type)) {
        const usage = z.object({ usage: z.json().optional() }).parse(event.data).usage
        if (usage !== undefined) audit.append('agent-usage', { actorId: session.id, eventSeq: event.seq, usage, branchId: identity.branchId, purpose: event.type })
      }
    })
    // Decision rounds (spec v0.4 section 3). Every member may take one step per decision window. A new step
    // starts at once when the world has moved at least decisionTicks since the member's previous step began;
    // otherwise, and for a member's first step, it waits for the next round. A round closes when every running
    // member waits for it, waits for an event, or is idle, and then advances the world once for all of them.
    const decisions = new Map<string, string>(), stepped = new Map<string, number>(), atBoundary = new Set<string>(), held = new Set<string>()
    const resumeIncompleteSlots = new Set<string>()
    ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      const requireActiveMission = () => {
        if (members.has(agent.id) && (ended || modelAdmissionClosed || world.observe().tick >= executionStopAt || scientific && world.observe().tick >= stages.finalTick)) throw new Error('Model admission closed; no further decisions')
      }
      requireActiveMission()
      if (members.has(agent.id)) {
        if (modern && !teamReady) {
          held.add(agent.id)
          try { while (!teamReady) { requireActiveMission(); shutdown.signal.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 10)) } } finally { held.delete(agent.id) }
        }
        while (modern && infrastructureFailed.size && !infrastructureFailed.has(agent.id) && stepped.get(agent.id) === world.observe().tick) {
          atBoundary.add(agent.id)
          try { requireActiveMission(); shutdown.signal.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 10)) } finally { atBoundary.delete(agent.id) }
        }
        // No request starts while a checkpoint gathers, saves or advances; it takes the window that follows.
        while (checkpointing) {
          requireActiveMission()
          // A member that has not yet decided at this tick must join the gathering round.
          if (modern && !barrier.held && stepped.get(agent.id) !== world.observe().tick) break
          held.add(agent.id)
          try { await checkpointing.catch(() => undefined); requireActiveMission() } finally { held.delete(agent.id) }
        }
        await barrier.enter(agent.id, shutdown.signal)
        requireActiveMission()
        const key = `${turn}/${step}`
        // A retried request keeps its step's place in time.
        if ((config.automaticCheckpoints || modern) && decisions.get(agent.id) !== key) {
          decisions.set(agent.id, key)
          const last = stepped.get(agent.id)
          const nextDecisionAt = last === undefined ? undefined : Math.min(executionStopAt, last + decisionTicks)
          if (modern ? !infrastructureFailed.has(agent.id) && nextDecisionAt !== undefined && world.observe().tick < nextDecisionAt : last === undefined || nextDecisionAt !== undefined && world.observe().tick < nextDecisionAt) {
            atBoundary.add(agent.id)
            try {
              do {
                await takeCheckpoint(true)
                requireActiveMission()
                while (modern && infrastructureFailed.size && !infrastructureFailed.has(agent.id)) { requireActiveMission(); shutdown.signal.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 10)) }
              } while (modern && nextDecisionAt !== undefined && world.observe().tick < nextDecisionAt)
            } finally { atBoundary.delete(agent.id) }
            await barrier.enter(agent.id, shutdown.signal)
            requireActiveMission()
          }
          stepped.set(agent.id, world.observe().tick)
          resumeIncompleteSlots.delete(agent.id)
        }
        if (modern) { nativeRounds.begin(); responseBytes.set(agent.id, 0) }
      }
      requireActiveMission()
      const request = await next()
      requireActiveMission()
      if (!members.has(agent.id) || !providerPool.includes(request.provider)) return request
      audit.append('agent-request', { actorId: agent.id, turn, step, branchId: identity.branchId })
      // The loop fixes a step's route during preparation. Prefer the first
      // tier with a ready account and rotate inside that tier.
      const provider = providers.select()
      if (provider !== request.provider) agent.model.select({ provider, model: request.model })
      return request
    })
    ctx.on('agent/request-error', async (payload, next) => {
      if (!modern || modelAdmissionClosed || !members.has(payload.agent.id) || !infrastructureCode(payload.failure.code, payload.failure.status)) return next()
      markInfrastructureFailure(payload.agent.id, payload.failure.code)
      const attempts = (infrastructureAttempts.get(payload.agent.id) ?? 0) + 1
      infrastructureAttempts.set(payload.agent.id, attempts)
      held.add(payload.agent.id)
      try {
        await takeCheckpoint(false, true)
        if (attempts > (config.infrastructureRetryLimit ?? 3)) {
          status = 'attention-required'
          engine.recordFact(admin, `mars-${namespace}-infrastructure-interrupted`, { actorId: payload.agent.id, code: payload.failure.code, attempts, tick: world.observe().tick })
          if (scientific) closeModelAdmissions('infrastructure')
          return next()
        }
        payload.signal.throwIfAborted()
        await new Promise<void>(resolve => setTimeout(resolve, config.infrastructureRetryDelayMs ?? 1000))
        payload.signal.throwIfAborted()
        return { kind: 'retry' as const }
      } finally { held.delete(payload.agent.id) }
    })
    ctx.on('agent/status', async () => { clock.wake(); if (delivery) await publishReceipts() })
    if (delivery) ctx.on('agent/turn-stopping', async ({agent,signal,turn}) => {
      if (signal.aborted && members.has(agent.id) && !modelAdmissionClosed && !ended && !shutdown.signal.aborted) {
        delivery.cancelOwner(deliveryRole(agent.id), `${agent.id}/${turn}`)
        await publishReceipts()
      }
    })
    ctx.on('agent/error', ({ agent, error }) => {
      if (!ended && members.has(agent.id)) {
        engine.recordFact(admin, 'mars-agent-error', { actorId: agent.id, error: String(error), tick: world.observe().tick })
        if (scientific) { if (!modelAdmissionClosed) closeModelAdmissions('model_error') }
        else status = 'attention-required'
      }
    })
    let missionSubmitted = false
    let checkpointing: Promise<Awaited<ReturnType<Checkpoints['save']>>> | undefined
    let decisionAdvanceRequested = false, forcedSave = false
    // Resume may inherit a native lifecycle that keeps changing while the
    // startup checkpoint verifies. Seed the last-known checkpoint from the
    // published catalog so a failed verification can fall back instead of
    // blocking the mount. A restore mints a new branchId for this run
    // (checkpoints.ts), so the manifest it resumed from is still on the
    // *previous* branch: accept it by identity as well, or a resumed run
    // would lose its interval bookkeeping and its fallback.
    const published = await checkpoints.published()
    const branchCheckpoints = published.filter((value) => {
      const metadata = value.metadata as { branchId?: string } | null
      return metadata?.branchId === identity.branchId || value.id === recoveryCheckpointId
    })
    let lastSaved: Awaited<ReturnType<Checkpoints['save']>> | undefined = branchCheckpoints[branchCheckpoints.length - 1]
    if (lastSaved) recoveryCheckpointId = lastSaved.id
    const endMission = async () => {
      if (ended) return
      ended = true
      try { await finalize() }
      catch (error) {
        if (!scientific) throw error
        stopReason = 'infrastructure'
        audit.append('scientific-finalization-invalid', { tick: world.observe().tick, error: error instanceof Error ? error.message : String(error) })
        engine.recordFact(admin, 'mars-v06-finalization-invalid', { tick: world.observe().tick })
        finalScore = { benchmarkVersion: 'v0.6', implementation: 'scientific_candidate', completionStatus: 'infrastructure_invalid', stopReason,
          tick: world.observe().tick, horizon: world.horizon, R: null, O: null, F: null, score: null, formalRankingEligible: false, budget: monetary?.report() ?? null }
        writeFileSync(join(directory, 'infrastructure-invalid-report.json'), JSON.stringify(finalScore, null, 2), { mode: 0o600 })
        status = 'completed'
      }
      for (const agent of members.values()) agent.cancel({ kind: 'hook', reason: 'Mission time window ended; final score recorded' })
      const summary = v06 ? z.object({ R: z.number().nullable(), F: z.boolean().nullable(), completionStatus: z.string() }).parse(finalScore) : (finalScore as { S?: number }).S
      console.log(`Mars mission finished at tick ${world.observe().tick}: ${JSON.stringify(summary)}`)
    }
    // Every running member has finished the step it is in: it waits for the next round or for an event, or is parked.
    const settled = () => resumeSlotsSettled({ v05: modern && !modelAdmissionClosed, teamReady, incomplete: resumeIncompleteSlots }) && !barrier.models && !barrier.writes && [...members.values()].every(agent =>
      agent.status !== 'running' || atBoundary.has(agent.id) || held.has(agent.id) || waiting.has(agent.id) || barrier.isParked(agent.id))
    const pause = () => { shutdown.signal.throwIfAborted(); return new Promise<void>(resolve => setTimeout(resolve, 25)) }
    /** Save a checkpoint once every running member has settled, then advance a decision window if one was requested.
     * @param advanceDecision A member waits for the next decision window.
     * @param periodic The event clock asks; like decision rounds, it saves only every checkpointIntervalTicks.
     */
    const takeCheckpoint = (advanceDecision = false, periodic = false) => {
      // Completed missions can still have boundary waiters unwinding. Never save
      // another full snapshot while those cancelled native requests settle.
      if (ended) return checkpointing ?? (lastSaved ? Promise.resolve(lastSaved) : Promise.reject(new Error('Mission ended before a checkpoint was saved')))
      decisionAdvanceRequested ||= advanceDecision
      forcedSave ||= !advanceDecision && !periodic
      if (checkpointing) return checkpointing
      checkpointing = (async () => {
        let release: (() => void) | undefined
        try {
          // Gather without holding admissions, so the tool calls of a step already decided run in that step's
          // window instead of after the advance, and members finishing their steps join this round.
          while (!settled() || barrier.held) await pause()
          release = barrier.hold()
          while (!settled()) await pause()
          await ctx.sessionPersistence.flush()
          if (snapshotMayCommitRound({ v05: modern, teamReady, infrastructureFailed: infrastructureFailed.size > 0 })) await commitRound()
          await synchronizeProtocol()
          sync()
          const advanceDecision = async () => {
            if (modern && infrastructureFailed.size) return
            // A resumed run can mount at the already-reached horizon. Finalize
            // before consulting the decision flag, otherwise the agent keeps
            // taking steps while the clock can no longer advance.
            if (world.observe().tick >= executionStopAt) { await endMission(); return }
            if (!decisionAdvanceRequested) return
            // The last decision window can be shorter than decisionTicks.
            // world.advance() clamps at the mission horizon, so an unclamped
            // horizon would make this loop spin forever at the final window.
            const horizon = Math.min(executionStopAt, world.observe().tick + decisionTicks)
            while (world.observe().tick < horizon) { await advancePlans(); world.advance(horizon); await procedures.step(); ledger?.capture(); await synchronizeProtocol() }
            if (modern) { await reconcile(); ledger?.capture() }
            sync()
            await dispatchEnvironment()
            await ctx.sessionPersistence.flush()
            if (world.observe().tick >= executionStopAt) await endMission()
          }
          for (let attempt = 0; ; attempt += 1) {
            const participants = org.snapshotParticipants()
            const nativeState = { missionSubmitted, participants, benchmarkVersion: config.benchmarkVersion, decisions: Object.fromEntries(decisions), stepped: Object.fromEntries(stepped),
              infrastructureFailed: Object.fromEntries(infrastructureFailed), infrastructureAttempts: Object.fromEntries(infrastructureAttempts) }
            writeFileSync(join(directory, 'native-state.json'), JSON.stringify(nativeState), { mode: 0o600 })
            const state = snapshot()
            writeFileSync(join(directory, 'viewer-state.json'), JSON.stringify(state), { mode: 0o600 })
            const stamp = () => JSON.stringify({ cursor: modern ? { scienceFacts: engine.readFacts(admin).length, operations: engine.list(admin).map(operation => ({ id: operation.id, state: operation.state, progress: operation.progress, detail: operation.detail, resources: operation.resources, artifacts: operation.artifacts.map(artifact => artifact.id) })) } : engine.eventCursor(admin), physical: world.eventCursor(),
              sessions: [...members.values()].map(agent => [agent.id, agent.session.seq]), participants: org.snapshotParticipants() })
            const expected = stamp()
            try {
              const shouldSave = forcedSave || modern && (decisionAdvanceRequested || infrastructureFailed.size > 0) || !lastSaved || state.tick - lastSaved.tick >= (config.checkpointIntervalTicks ?? 1)
              const saved = !shouldSave ? lastSaved! : await checkpoints.save(state.tick, state.cursor, z.json().parse({ ...identity, mode: config.mode, nativeState, model: config.model, providerPool,
                benchmarkVersion: config.benchmarkVersion, decisionTicks, automaticCheckpoints: config.automaticCheckpoints ?? false,
                scenarioHash: world.scenarioHash, rules: world.rules, organization: org.config,
                ...(science ? { protocolHash: science.config.protocolHash, phaseSeals: science.stages.seals().map(s => ({ tick: s.tick, hash: s.hash })) } : {}) }), async () => {
                await ctx.sessionPersistence.flush()
                if (stamp() !== expected) throw new CheckpointChanged('Native lifecycle changed during checkpoint')
              })
              if (shouldSave) { recoveryCheckpointId = saved.id; lastSaved = saved }
              await advanceDecision()
              return saved
            } catch (error) {
              if (!(error instanceof CheckpointChanged)) throw error
              shutdown.signal.throwIfAborted()
              audit.append('checkpoint-retry', z.json().parse({ ...identity, reason: error.message }))
              // A continuously active native lifecycle can fail verification
              // forever. Keep the last verified checkpoint and let the mission
              // advance instead of deadlocking the clock in this loop.
              if (attempt >= 2) {
                if (!lastSaved) throw error
                audit.append('checkpoint-skipped', z.json().parse({ ...identity, reason: error.message, attempts: attempt + 1 }))
                await ctx.sessionPersistence.flush()
                await advanceDecision()
                return lastSaved
              }
              await ctx.sessionPersistence.flush()
            }
          }
        } finally { decisionAdvanceRequested = false; forcedSave = false; release?.(); clock.wake(); checkpointing = undefined }
      })()
      return checkpointing
    }
    const viewer = await startViewer({ runId: () => identity.runId, snapshot, events: after => { sync(); return events(after) },
      score: scoreView,
      sensors: () => world.sensors(),
      telemetryChannels: () => world.telemetryChannels(),
      telemetry: (channels, from, to, limit) => world.telemetry(channels, Math.max(0, from), Math.min(to, world.observe().tick), Math.min(limit, 5000)),
      deliverables: () => deliverableView().deliverables,
      incidentReports,
      analysisRuns,
      analysisRun: id => analysis.get(id) ?? null,
      measurement: resultId => world.measurement(resultId),
      raw: key => world.rawFor(key),
      announcements,
      evaluation,
      modelActivity,
      checkpoints: async () => (await checkpoints.published()).map(value => ({ id: value.id, tick: value.tick, cursor: value.cursor })),
      saveCheckpoint: () => takeCheckpoint(),
      frames: async () => (await checkpoints.published()).filter(value => z.object({ branchId: z.string() }).parse(value.metadata).branchId === identity.branchId)
        .filter(value => value.files.some(file => file.path === 'viewer-state.json')).map(value => ({ id: value.id, tick: value.tick, cursor: value.cursor, branchId: identity.branchId })),
      frame: async id => {
        const frame = await checkpoints.frame(id)
        if (z.object({ branchId: z.string() }).parse(frame).branchId !== identity.branchId) throw new Error('Frame belongs to another branch')
        return frame
      },
      historyQuery: input => archive.query(input),
      historySearch: (query, offset, limit) => archive.search(query, offset, limit),
      artifact: id => ({ ...artifacts.read(admin, id), verified: true, verifiedAtTick: world.observe().tick }),
      infrastructure: () => audit.read().filter(record => record.kind.startsWith('recovery-') || record.kind === 'model-finish' && z.object({ reason: z.object({ kind: z.string() }) }).parse(record.data).reason.kind === 'error'),
      ...(config.supervised ? { requestRecovery: async (input: unknown) => {
        const ownerPath = `${directory}.owner.json`
        if (!existsSync(ownerPath)) throw new Error('Recovery supervisor is not running')
        const owner = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(readFileSync(ownerPath, 'utf8')))
        process.kill(owner.pid, 0)
        const request = z.object({ requestKey: z.string().min(1), checkpointId: z.string().uuid(), failureRequestId: z.string().optional() }).strict().parse(input)
        const existing = audit.read().find(record => record.kind.startsWith('recovery-') && z.object({ requestKey: z.string().optional() }).parse(record.data).requestKey === request.requestKey)
        if (existing) {
          const old = z.object({ requestId: z.string(), checkpointId: z.string(), failureRequestId: z.string().optional() }).parse(existing.data)
          if (old.checkpointId !== request.checkpointId || old.failureRequestId !== request.failureRequestId) throw new Error('Recovery request key changed')
          return { accepted: true, requestId: old.requestId }
        }
        let failureTick = world.observe().tick
        if (config.mode !== 'environment') {
          const failure = audit.read().filter(record => record.kind === 'model-finish').map(record => z.object({ requestId: z.string(), branchId: z.string(), tick: z.number(),
            reason: z.object({ kind: z.string(), failure: z.object({ code: z.string(), status: z.number().optional() }).optional() }) }).parse(record.data))
            .find(value => value.requestId === request.failureRequestId && value.branchId === identity.branchId && value.reason.kind === 'error' &&
              (['TRANSPORT', 'NETWORK', 'SERVER', 'TIMEOUT'].includes(value.reason.failure?.code ?? '') || (value.reason.failure?.status ?? 0) >= 500))
          if (!failure) throw new Error('Recovery requires an observed transport or upstream failure on this branch')
          failureTick = failure.tick
        }
        const eligible = (await checkpoints.published()).filter(value => z.object({ branchId: z.string() }).parse(value.metadata).branchId === identity.branchId && value.tick <= failureTick)
        const latest = eligible.at(-1)
        if (!latest || latest.id !== request.checkpointId) throw new Error('Use the latest checkpoint preceding the observed infrastructure failure')
        await checkpoints.verify(request.checkpointId)
        const command = { requestId: randomUUID(), ...request, reason: config.mode === 'environment' ? 'environment-integration-test' : 'transport-failure' }
        const path = `${directory}.recovery-request.json`, temporary = `${path}.${randomUUID()}.tmp`
        if (existsSync(path)) throw new Error('Another recovery request is pending')
        writeFileSync(temporary, JSON.stringify(command), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path)
        audit.append('recovery-requested', z.json().parse(command))
        return { accepted: true, requestId: command.requestId }
      } } : {}),
    }, config.port)
    writeFileSync(join(directory, 'viewer-connection.json'), JSON.stringify({ origin: viewer.origin, token: viewer.token, runId: identity.runId, stage: 'foundation' }), { mode: 0o600 })
    const missionControls: { close(): Promise<void> }[] = []
    let harness: Awaited<ReturnType<typeof startHarnessMissionControl>> | undefined
    if (controlPorts?.harness !== undefined) {
      try {
        harness = await startHarnessMissionControl({ engine, directory, port: controlPorts.harness, projects: ['mars'], providers: capabilities })
        missionControls.push(harness)
      } catch (error) {
        console.error(`Mission Control (harness) failed to start: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (controlPorts?.mars !== undefined) {
      try {
        missionControls.push(await startMarsMissionControl({ engine, directory, port: controlPorts.mars, projects: ['mars'], providers: capabilities,
          viewer: { origin: viewer.origin, token: viewer.token, runId: identity.runId }, runsIndex: join(dirname(directory), 'index.json'),
          ...(harness ? { harnessUrl: harness.url } : {}) }))
      } catch (error) {
        console.error(`Mission Control (mars) failed to start: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => {
      monetaryAdmissions?.close()
      shutdown.abort(new Error('Mars runtime closing'))
      await Promise.allSettled(checkpointing ? [checkpointing] : [])
      await viewer.close(); await Promise.allSettled(missionControls.map(control => control.close())); await clock.close()
      if (root) { await ctx.subagents.drainDescendants([root.agent]); await root.dispose() }
      archive.close(); await engine.close(); opened.close(); world.close(); monetary?.close(); runLease.close(); status = 'stopped'
    })()
    cleanup = close
    ctx.effect(() => close, 'mars.foundation')
    clock.attach(() => status === 'running' && (!modern || !infrastructureFailed.size) && !barrier.held && barrier.writes === 0 && members.size > 0 && [...members.values()].every(agent => agent.status !== 'running' || clock.blocked(agent.id)), async () => {
      await procedures.step(); await synchronizeProtocol(); sync(); await dispatchEnvironment(); await ctx.sessionPersistence.flush()
      if (world.observe().tick >= executionStopAt) { await endMission(); return }
      if (config.automaticCheckpoints) await takeCheckpoint(false, true)
    })
    if (config.mode !== 'environment') {
      const recoveryNotice = '运行已从持久状态恢复。当前会话、任务、笔记及物理操作均以恢复后的记录为准。' + stopNotice
      if (config.resume) {
        if (!identity.rootSessionId) throw new Error('Checkpoint lacks root session identity')
        const saved = z.object({ benchmarkVersion: z.enum(['v0.4', 'v0.5', 'v0.6']).optional(), decisions: z.record(z.string(), z.string()).optional(), stepped: z.record(z.string(), z.number()).optional(),
          infrastructureFailed: z.record(z.string(), z.object({ code: z.string(), tick: z.number() })).optional(), infrastructureAttempts: z.record(z.string(), z.number()).optional(), missionSubmitted: z.boolean(), participants: z.array(z.object({ id: z.string(), project: z.string(),
          role: z.string(), parentId: z.string().optional(), depth: z.number(), task: z.string() })) }).parse(JSON.parse(readFileSync(join(directory, 'native-state.json'), 'utf8')))
        if ((saved.benchmarkVersion ?? 'v0.4') !== config.benchmarkVersion) throw new Error('Checkpoint benchmark version differs from runtime')
        missionSubmitted = saved.missionSubmitted
        for (const [id, key] of Object.entries(saved.decisions ?? {})) decisions.set(id, key)
        for (const [id, tick] of Object.entries(saved.stepped ?? {})) {
          stepped.set(id, tick)
          if (modern && !modelAdmissionClosed && tick < world.observe().tick) resumeIncompleteSlots.add(id)
        }
        if (!modelAdmissionClosed) for (const [id, failure] of Object.entries(saved.infrastructureFailed ?? {})) infrastructureFailed.set(id, failure)
        for (const [id, attempts] of Object.entries(saved.infrastructureAttempts ?? {})) infrastructureAttempts.set(id, attempts)
        const release = barrier.hold()
        try {
          root = await ctx.agents.resume({ resumeSessionId: SessionId(identity.rootSessionId), agentOptions: config.model })
          for (const participant of saved.participants.filter(value => value.parentId).sort((a, b) => a.depth - b.depth)) {
            const parent = ctx.agents.get(SessionId(participant.parentId!))
            if (!parent) throw new Error('Checkpoint participant parent unavailable')
            await org.resumeChild(parent, { ...participant, id: SessionId(participant.id), parentId: SessionId(participant.parentId!) }, recoveryNotice, shutdown.signal)
          }
          const consents = new Map<string, { parentId: string; childId: string; peerChildId: string }>()
          for (const fact of engine.readFacts(admin)) if (fact.kind === 'mars-organization') {
            const entry = z.object({ kind: z.string(), data: z.json() }).parse(fact.data)
            if (entry.kind === 'consent') {
              const consent = z.object({ parentId: z.string(), childId: z.string(), peerChildId: z.string() }).parse(entry.data)
              consents.set(`${consent.childId}|${consent.peerChildId}`, consent)
            }
            if (entry.kind === 'consent-revoked') {
              const revoked = z.object({ childId: z.string(), peerChildId: z.string() }).parse(entry.data)
              consents.delete(`${revoked.childId}|${revoked.peerChildId}`)
              consents.delete(`${revoked.peerChildId}|${revoked.childId}`)
            }
          }
          for (const consent of consents.values()) {
            const parent = ctx.agents.get(SessionId(consent.parentId))
            if (!parent) throw new Error('Checkpoint consent parent unavailable')
            await org.authorize(parent, SessionId(consent.childId), SessionId(consent.peerChildId), shutdown.signal)
          }
          const claims = new Map<string, string>()
          for (const raw of engine.events(admin)) {
            const entry = z.object({ type: z.string(), data_json: z.string() }).parse(raw)
            if (entry.type === 'experiment-claimed') {
              const claim = z.object({ experimentId: z.string(), actorId: z.string() }).parse(JSON.parse(entry.data_json))
              claims.set(claim.experimentId, claim.actorId)
            }
          }
          for (const experiment of engine.experiments.list(admin)) {
            if (['completed', 'cancelled'].includes(experiment.state)) continue
            const controller = ctx.agents.get(SessionId(claims.get(experiment.id) ?? experiment.createdBy))
            if (controller && members.has(controller.id)) engine.experiments.claim(access(controller, 'mars_catalog'), experiment.id, 'Checkpoint restored with a fresh native controller')
          }
        } finally { release() }
      } else {
        root = await ctx.agents.create({ sessionId: SessionId(`mars-brain-${randomUUID()}`), agentOptions: config.model })
        identity.rootSessionId = root.agent.id
        writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o600 })
      }
      await takeCheckpoint(modern && nativeRounds.currentCommitted())
      // The runtime builds the fixed team before the mission reaches the root, so all six take their first decision in one window.
      if (!missionSubmitted && multi) for (const role of SPECIALISTS)
        await org.create(root.agent, role, `ACTOR ${role}\n你是${TEAM[role].title}岗。岗位章程已在系统提示中。先 mission_read 查看研究使命，再读取可用工具目录与公开证据并开始工作。`, shutdown.signal)
      teamReady = true
      root.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: missionSubmitted ? recoveryNotice : `ACTOR brain\n${JSON.stringify({ ...mission(load, undefined, true, world.observe().tick, world.horizon), organization: organizationCatalog('brain') })}` }] }))
      missionSubmitted = true
    } else { teamReady = true; await takeCheckpoint() }
    status = 'running'
    console.log(`Mars Viewer API: ${viewer.origin} (bearer stored in local viewer-connection.json)` )
    const advanceScientificTo = async (targetTick: number) => {
      if (!science || config.mode !== 'environment') throw new Error('Manual scientific stepping requires a keyless environment run')
      if (!Number.isSafeInteger(targetTick) || targetTick < world.observe().tick || targetTick > executionStopAt) throw new Error(`Invalid scientific advancement target ${targetTick} at tick ${world.observe().tick}, stop ${executionStopAt}`)
      while (world.observe().tick < targetTick) {
        await advancePlans(); world.advance(targetTick); await procedures.step(); await synchronizeProtocol(); sync()
      }
      if (world.observe().tick >= executionStopAt) await endMission()
    }
    return { engine, world, org, records, viewer, snapshot, close, root, takeCheckpoint, checkpoints, finalize, analysis, commitRound,
      v06Protocol, synchronizeProtocol, science, monetary, advanceScientificTo, procedures, refs, archive }
  } catch (error) {
    try { await cleanup() } finally { monetary?.close() }
    throw error
  }
}

/** Standard dsh profile plugin entry. */
export async function apply(ctx: Context, config: Config) { await mountMars(ctx, config) }
