/** Host-owned scientific assembly. Public tools receive only the explicit catalog and visibility resolvers. */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { AnalysisRegistry } from '../analysis.ts'
import { createHandover } from '../v05/scenario.ts'
import { publicResources } from '../v05/resources.ts'
import { V05Planning, type Plan } from '../v05/planning.ts'
import { V05ResearchRecords } from '../v05/research-records.ts'
import { contentHash, type StageProfile, type Submission, type TaskId } from './contracts.ts'
import { V06Records, type RecordResolvers } from './records.ts'
import { SubmissionDrafts } from './submission-drafts.ts'
import { V06Actions, planHash } from './actions.ts'
import { reviewServices, requireServiceReview, serviceWindows } from './service-review.ts'
import { createCases } from './cases.ts'
import { publicModelInterfaces } from './public-model-interfaces.ts'
import { createEvidenceView } from './evidence-view.ts'
import { referenceDirectory } from './reference-directory.ts'
import { openProtocol } from './protocol.ts'
import { checkJointPlan } from './joint-trial.ts'
import { publicScienceProfile } from './profile.ts'
import { finalizeV06, sealedSubmission } from './finalize.ts'
import { isChoiceTrial, publicTrialPolicy, sharedPlanVersion } from './pilot-choice-contract.ts'
import { checkCropScope, guardTrialChambers, pendingScope } from './shared-plan.ts'
import { baselinePayload, choicePayload, sharedChoicePayload, checkPilotPlan, checkChoice, pilotObservations } from './pilot-choice.ts'
import { V06World } from './world.ts'

const instanceSchema = z.object({ version: z.literal(1), sourceHash: z.string(), profileHash: z.string(), stagesHash: z.string(), salt: z.string().min(32) }).strict()
/** The optional file allows a paired Single/Multi installation to reuse precisely the same private instance. */
export function scienceInstance(directory: string, sourceHash: string, profileHash: string, stages: StageProfile, sharedFile?: string) {
  const path = resolve(sharedFile ?? `${directory}.evaluator/v06-instance.json`)
  if (path.replaceAll('\\', '/').split('/').some(segment => segment.toLowerCase() === 'secrets')) throw new Error('Instance data must not be read from a credentials directory')
  const expected = { version: 1 as const, sourceHash, profileHash, stagesHash: contentHash(stages) }
  if (existsSync(path)) {
    const instance = instanceSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (contentHash({ ...instance, salt: '' }) !== contentHash({ ...expected, salt: '' })) throw new Error('Shared scientific instance differs from source/profile/stages')
    return instance
  }
  if (sharedFile) throw new Error('Shared scientific instance file must already exist')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const instance = instanceSchema.parse({ ...expected, salt: randomBytes(32).toString('hex') })
  writeFileSync(path, JSON.stringify(instance, null, 2), { mode: 0o600, flag: 'wx' })
  return instance
}

export function openScience(input: { world: V06World; engine: ExecutionEngine; context: OperationContext; analysis: AnalysisRegistry;
  directory: string; salt: string; decisionTicks: number; resolveReference?: (id: string) => string }) {
  const { world, engine, context, analysis } = input, tick = () => world.currentTick(), profile = world.scienceProfile
  const manifest = createCases(world.truth, profile, world.stages, input.salt)
  const privateFile = `${input.directory}.evaluator/v06-cases.json`
  mkdirSync(dirname(privateFile), { recursive: true, mode: 0o700 })
  if (existsSync(privateFile) && contentHash(JSON.parse(readFileSync(privateFile, 'utf8'))) !== contentHash(manifest)) throw new Error('Private scientific cases changed during recovery')
  if (!existsSync(privateFile)) writeFileSync(privateFile, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
  const planReader = new V05Planning(engine, context, tick, {}, undefined, 'v06'), plans = () => planReader.list()
  const serviceReview = () => ({...reviewServices(world, manifest.commissions, plans()),
    ...(world.stages.researchWorkflow === 'delivery-v2' ? {commissions:serviceWindows(world,manifest.commissions)} : {})})
  const actionsFor = (grant: OperationContext) => new V06Actions(engine, grant, tick, world.stages.finalTick, manifest.commissions.map(c => c.id),
    action => world.captureAction(action.id, 'before'), world.stages.researchWorkflow ? (id, receipt) => requireServiceReview(serviceReview(), id, receipt) : undefined)
  const hostActions = actionsFor(context)
  const resolve = (id: string) => input.resolveReference?.(id) ?? id
  const resolvers: RecordResolvers = {
    draftReceipt: (taskId, slotId) => {
      const draft = new SubmissionDrafts(engine, context, tick, world.stages, protocol.records).read({taskId,slotId}).draft
      return draft ? { revision:draft.revision, tick:draft.tick, actorId:draft.actorId, problem:draft.problem?.slice(0,240) ?? null } : null
    },
    serviceReviewReceipt: id => serviceReview().plans.find(plan => plan.reviewId === id) ?? null,
    serviceStep: (planId, stepId) => {
      const plan = plans().find(p => p.id === planId)
      if (!plan?.service || !plan.steps.some(step => step.id === stepId)) return null
      const operationId = plan.operations[stepId] ?? null, block = plan.blocked?.[stepId]
      const operation = operationId ? world.observe().operations.find(o => o.id === operationId) ?? world.observeSystems().operations.find(o => o.id === operationId) : null
      let state = 'scheduled'
      if (operation) state = operation.state
      else if (operationId) state = 'receipt_unavailable'
      else if (plan.state === 'cancelled' || plan.state === 'partial_failed') state = 'not_dispatched'
      else if (block) state = 'blocked'
      return { commissionId: plan.service.commissionId, stepId, state, operationId,
        acceptedTick: operation?.acceptedTick ?? null, completedTick: operation?.completedTick ?? null, blockedReason: block?.reason ?? null }
    },
    checkCropPlan: payload => {
      const {planId}=z.object({planId:z.string()}).parse(payload)
      checkCropScope(pendingScope(plans().find(p=>p.id===planId),payload,world.stages),manifest.coreCrops)
    },
    checkJointTrial: (payload, slotId, evidence) => {
      const { planId } = z.object({ planId: z.string() }).parse(payload)
      const plan = plans().find(p => p.id === planId)
      if (!isChoiceTrial(world.stages.jointTrial)) return checkJointPlan(plan, payload, world.stages)
      if (slotId === 'baseline') return checkPilotPlan(plan, baselinePayload.parse(payload).pilot, world.stages)
      const observed = readPilot()
      const view = createEvidenceView(world, analysis, manifest.coreCrops), draft = { evidence, acceptedTick:tick() }
      if (!view.unknownWater(draft).length || !view.telemetryAnalysis(draft, true)) throw new Error('Cite current source-water data and an analysis of measured energy.demand')
      if (world.stages.jointTrial === sharedPlanVersion) {
        const selected = pendingScope(plan,payload,world.stages)
        guardTrialChambers(plan!,selected,observed.pilot)
        return checkChoice(selected,sharedChoicePayload.parse(payload).choice,observed,evidence,world.stages)
      }
      checkChoice(plan, choicePayload.parse(payload).choice, observed, evidence, world.stages)
    },
    validation: (task, _slot) => manifest.caseHashes[task] ? { availableAt: world.stages.horizon, caseSetHash: manifest.caseHashes[task]! } : null,
    evidence: (id, revision) => {
      const canonical = resolve(id), state = world.observe()
      const note = new V05ResearchRecords(engine, context, tick, undefined, 'mars-v06-research').read(canonical, revision)
      if (note) return { availableAt: note.availableAt, revision: note.revision }
      if (revision !== undefined && revision !== 1) return null
      const result = state.results.find(r => r.id === canonical)
      if (result) return { availableAt: result.completedTick }
      const operation = [...state.operations, ...world.observeSystems().operations].find(o => o.id === canonical && o.state === 'succeeded')
      if (operation?.completedTick !== undefined) return { availableAt: operation.completedTick }
      const run = analysis.get(canonical)
      return run?.status === 'done' ? { availableAt: run.asOfTick } : null
    },
    dependency: (id, revision) => {
      const note = new V05ResearchRecords(engine, context, tick, undefined, 'mars-v06-research').read(id, revision)
      return note ? { availableAt: note.availableAt } : null
    },
    reference: (kind, id) => {
      if (kind === 'plan') { const plan = plans().find(p => p.id === id); return plan ? { kind, id, hash: planHash(plan) } : null }
      if (kind === 'response' || kind === 'commitment') {
        const action = hostActions.list().find(a => a.id === id && a.taskId === (kind === 'response' ? 'T4' : 'T3'))
        return action ? { kind, id, hash: action.hash } : null
      }
      return null
    },
  }
  const protocol = openProtocol(engine, context, tick, world.stages, input.decisionTicks, resolvers,
    { implementation: 'scientific_candidate', caseManifestHash: manifest.hash })
  function readPilot() {
    const sealed = sealedSubmission(protocol.records, protocol.stages, 'T6', 'baseline')
    const id = sealed?.references.find(r => r.kind === 'plan')?.id
    return pilotObservations(world, sealed, plans().find(p => p.id === id) ?? null, tick())
  }
  const inherited = new V05ResearchRecords(engine, context, () => 0, undefined, 'mars-v06-research')
  for (const record of createHandover(world.truth)) if (!inherited.read(record.id)) inherited.put(`inherit:${record.id}`, {
    id: record.id, kind: record.kind === 'claim' ? 'claim' : 'study', project: record.project === 'PW' ? 'PW' : record.project === 'PG' ? 'PG' : 'PF',
    expectedRevision: 0, content: z.json().parse(record.content), basedOn: record.basedOn, reason: 'Public historical handover', status: 'provisional' })
  const recordsFor = (grant: OperationContext) => new V06Records(engine, grant, tick, world.stages, resolvers)
  const capture = () => {
    const actions = hostActions.list()
    if (!actions.length) return
    const snapshots = world.quality().snapshots, currentPlans = plans()
    for (const action of actions) {
      if (Object.hasOwn(snapshots, `action:${action.id}:after`)) continue
      const plan = currentPlans.find(p => p.id === action.planId && planHash(p) === action.planHash)
      if (plan && ['succeeded', 'partial_failed', 'cancelled'].includes(plan.state)) world.captureAction(action.id, 'after')
    }
  }
  const matchingServiceActions = (plan: Plan) => {
    if (!plan.service) return []
    const hash = planHash(plan)
    return hostActions.list().filter(action => action.taskId === 'T3' && action.commissionId === plan.service?.commissionId
      && action.planId === plan.id && action.planHash === hash)
  }
  const serviceReceipts = (plan: Plan) => matchingServiceActions(plan).map(({ id, acceptedTick, actorId }) => ({ id, acceptedTick, actorId }))
  const isServiceCommitted = (plan: Plan) => matchingServiceActions(plan).length > 0
  const mayDispatch = (plan: Plan) => {
    if (plan.service && !isServiceCommitted(plan)) return false
    if (tick() < world.stages.finalTick) return true
    const references = protocol.stages.seals().find(s => s.stage === 'final')?.selections.flatMap(s => s.references) ?? []
    if (references.some(r => r.kind === 'plan' && r.id === plan.id && r.hash === planHash(plan))) return true
    return references.filter(r => r.kind === 'response' || r.kind === 'commitment').some(ref =>
      hostActions.list().some(a => a.id === ref.id && a.hash === ref.hash && a.planId === plan.id && a.planHash === planHash(plan)))
  }
  const catalog = () => ({ ...protocol.mission, orderingPolicy: 'Fixed-role rotation at common decision boundaries; observation noise uses physical device/source/time/ordinal, not actor UUID.', instruments: publicScienceProfile(profile), resources: publicResources(world, 'v0.6'),
    ...(world.stages.researchWorkflow==='delivery-v2' || world.stages.jointTrial===sharedPlanVersion ? {instructions:'三个委托共享一个持续世界。按本局 tasks 和 jointTrial 的时限封存。用公开证据与接纳回执组织交付，行动预测在首次动作前锁定。'} : {}),
    services: manifest.commissions, entities: { T1: ['reservoir', 'filter', 'pump'], T2: manifest.coreCrops, T3: manifest.commissions.map(c => c.id),
      T4: ['water-anomaly'], T5: ['impact-water', 'impact-irrigation', 'independent-energy'], T6: ['J-A', 'J-B', 'J-C'] },
    executionRuntime: { preferred: 'mars-model-v06-sync-v1', legacyAlias: 'mars-analysis-v1', mode: 'synchronous finite JSON only; fresh realm per case/node; no Host await or filesystem/network binding' },
    modelInterfaces: {
      T1: { ...publicModelInterfaces.T1, output: { concentrationAtSampling: 'mg/L' },
        domain: { concentrationMgL: [0, profile.maximumConcentration], temperature: [-10, 22], elapsedTicks: [0, 240], methodVersion: [1, 2] } },
      T2: { ...publicModelInterfaces.T2, output: { growthIndex: 'physical simulation growth index' },
        domain: { light: [40, 100], nutrient: [1, 3], irrigation: [45, 120], co2: [600, 1200], temperature: [16, 30] } },
      T3: { ...publicModelInterfaces.T3, output: { generation: 'simulation energy units', minimumSoc: 'simulation energy units' },
        ...(world.stages.researchWorkflow ? {routeReview:'After scheduling, obtain reviewId from service_review. Resolve blocking routes before submitting your T3 service commitment.'} : {}),
        actionCommit: 'Register an experiment_plan with service.{commissionId,measurementStepId,retentionStepId}. Use the accepted planId in prediction_commit with taskId=T3, the same commissionId and forecast={completedTick,remainingUl}. Read round_receipts and cite the accepted commitment in T3 final.' },
      T4: { output: 'Final diagnosis uses the declared cause set. prediction_commit taskId=T4 locks planId and forecast={completedTick,postResponseMgL} before any plan step is accepted. Safe physical actions do not require a prediction.' },
      T5: { ...publicModelInterfaces.T5, output: { waterStress: 'active water-contamination stress: main source, positive dose, DOC > 2.5 mg/L, elapsed >= 40 and < 60 ticks', generation: 'energy case only', minimumSoc: 'energy case only' },
        representation: 'one joint model or a finite declared model DAG; same public inputs and scientific cases' },
      T6: world.stages.jointTrial ? publicTrialPolicy(world.stages.jointTrial) : { output: 'Previously registered finite joint planId. No additional points.' },
    }, evidenceRules: { water: 'Current unknown-water measurements plus at least two distinct certified concentrations; raw chromatogram or valid fast path.',
      storage: 'Two time points from distinct descendants of one mother sample, with actual transfers spanning at least two declared storage temperatures.',
      crop: 'For each fixed crop/chamber, actual scans or traceable sample imaging at three or more distinct light settings.',
      energy: 'A completed data-accessing analysis of actual energy.solar or energy.soc telemetry.',
      alternatives: 'Equivalent methods are accepted when their public metadata and task accuracy requirements are satisfied.' },
    handover: inherited.list().map(r => ({ id: r.id, revision: r.revision, content: r.content })),
    requiredConditions: { scienceQuality: profile.minimumScienceQuality, prospectiveCommitments: manifest.commissions.map(c => c.id),
      response: 'The selected response plan must causally address diagnosed physical causes, retain successful before/after states and obtain a subsequent independent measurement. Fresh method-QC evidence supports corrections to a revised analytical method.',
      cropSurvival: profile.minimumCropSurvival,
      maximumCriticalShedFraction: profile.maximumCriticalShedFraction, maximumWaterUnavailableFraction: profile.maximumWaterUnavailableFraction, interventionTarget: profile.interventionTarget },
  })
  return { ...protocol, manifest, recordsFor, actionsFor, serviceReview, readPilot, resolvers, mayDispatch, isServiceCommitted, serviceReceipts, capture, catalog,
    referencePicker: (query: Parameters<typeof referenceDirectory>[6]) => referenceDirectory(world, analysis, protocol.records, inherited, planReader, hostActions, query),
    evidenceCheck: (taskId: TaskId, draft: Pick<Submission, 'evidence' | 'acceptedTick'>, slotId: Submission['slotId'] = 'final') => {
      if (taskId === 'T6' && isChoiceTrial(world.stages.jointTrial) && slotId === 'baseline') return []
      const view = createEvidenceView(world, analysis, manifest.coreCrops)
      if (taskId === 'T6' && world.stages.jointTrial) {
        const demandOnly = isChoiceTrial(world.stages.jointTrial)
        const water = view.unknownWater(draft).length > 0, energy = view.telemetryAnalysis(draft, demandOnly)
        return [{ group: 'trial_water', eligible: water, missing: water ? [] : ['Cite a current source-water measurement.'] },
          { group: 'trial_energy', eligible: energy, missing: energy ? [] : [demandOnly ? 'Cite an analysis of measured energy.demand.' : 'Cite an analysis of measured energy.solar or energy.soc.'] }]
      }
      return view.inspect(taskId, draft)
    },
    finalize: (stopReason: 'normal' | 'budget_exhausted' | 'model_error') => finalizeV06({ world, engine, context, analysis,
      records: protocol.records, stages: protocol.stages, manifest, stopReason }) }
}
export type ScientificCore = ReturnType<typeof openScience>
