/**
 * DeepWorks session host for the Mars v0.6 world.
 *
 * Owns the participant registry (one DeepWorks conversation per Mars role), the clock that moves
 * virtual time as providers report events, and the tool registry assembled from the original
 * physical, planning and research tool installers. It never creates DSH agents or sessions.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Artifacts } from '../science-harness/integrations/ai4science/platform/artifacts.ts'
import { Refs } from '../science-harness/integrations/ai4science/mars/refs.ts'
import { ALERT_ROUTES, ALL_ROBOTS } from '../science-harness/integrations/ai4science/mars/team.ts'
import { V06_TASK_IDS } from '../science-harness/integrations/ai4science/mars/v06/registry.ts'
import { charter, teamDeliveryBrief } from '../science-harness/integrations/ai4science/mars/v06/team.ts'
import { installPhysicalTools } from '../science-harness/integrations/ai4science/mars/tools.ts'
import { installResearchTools as installV06ResearchTools } from '../science-harness/integrations/ai4science/mars/v06/tools.ts'
import { installPlanningTools } from '../science-harness/integrations/ai4science/mars/v05/planning-tools.ts'
import { installV2Tools } from '../science-harness/integrations/ai4science/mars/v2-tools.ts'
import { SimulationClock } from '../science-harness/integrations/ai4science/greenhouse/simulation-clock.ts'
import { contentHash, identifier } from '../science-harness/integrations/ai4science/mars/v06/contracts.ts'
import { handoffReferenceKinds, workflowHandoffKinds, researchHandoffSchema, resolveResearchHandoff } from '../science-harness/integrations/ai4science/mars/v06/research-handoff.ts'
import { DeliveryLedger, deliverySpec, deliveryVersion, followsReceipts } from '../science-harness/integrations/ai4science/mars/v06/delivery.ts'
import { installDeliveryTools, followUpParameter, receiptMail } from '../science-harness/integrations/ai4science/mars/v06/delivery-tools.ts'
import { NativeRounds, isV05Mutation } from '../science-harness/integrations/ai4science/mars/v05/native-rounds.ts'
import { Procedures, STORAGE_NAMES } from '../science-harness/integrations/ai4science/mars/procedures.ts'
import { PhaseLedger } from '../science-harness/integrations/ai4science/mars/v06/phase-ledger.ts'
import { V05Planning, planNeedsDispatch } from '../science-harness/integrations/ai4science/mars/v05/planning.ts'
import { PhysicalObserver } from '../science-harness/integrations/ai4science/mars/physical-observer.ts'
import { z } from 'zod'
import { setImmediate as yieldIO } from 'node:timers/promises'
import { AdmissionBarrier } from '../science-harness/integrations/ai4science/mars/barrier.ts'
import { TIER_ONE } from '../science-harness/integrations/ai4science/mars/base.ts'
import { marsRoster } from '../science/mars-roster.mjs'

export const SCHEDULING_PROTOCOL = 'mars-v06-native-steps/1'

export function createMarsHost({ directory, world, engine, science, admin, analysis, project = 'mars', decisionTicks = 12, archive, load,
  mode = 'multi', teamSize = 6, checkpointIntervalTicks = 240, runId, protocolHash, modelBarrier = true,
  autoAdvance = true, onControlChange = () => {} }) {
  const teamRoles = marsRoster('multi', teamSize)
  const requiredRoles = marsRoster(mode, teamSize)
  const artifacts = new Artifacts(engine)
  const refs = new Refs(world, () => artifacts.list(admin).map((artifact) => artifact.id))
  const registry = new Map()
  const participants = new Map()
  const byActor = new Map()
  const mailboxes = new Map()
  const handoffRequests = new Map()
  const currentTick = () => world.currentTick()
  const delivery = world.stages.researchWorkflow === deliveryVersion ? new DeliveryLedger(engine, admin, currentTick) : null
  function publishReceipts() {
    if (!delivery || !started || suspended || modelClosed || closing) return
    for (const [role, items] of delivery.due()) {
      const target = [...participants.values()].find(p => p.role === role)
      if (!target) continue
      const id = target.sessionId
      // An already admitted or queued decision can consume these receipts in its own window.
      if (!waits.has(id) && (gates.has(id) || modelHolds.has(id) || busySessions.has(id) || firstDecisions.has(id))) continue
      const mail = receiptMail(role, items)
      if (!handoffRequests.has(mail.key)) post(role, 'host', mail.text, undefined, {key:mail.key, hash:contentHash(mail.text), receiptItems:mail.members})
    }
  }

  const deliverMail = (role, message) => {
    const target = [...participants.values()].find(value => value.role === role)
    if (started && !modelClosed && target && !waits.has(target.sessionId))
      notification(role, 'mail', JSON.stringify({ kind: 'mars-work-mail', message }), `mail:${message.id}`)
    if (!committing && !stepWork) deliverWaits()
  }

  const post = (role, from, text, handoff, handoffRequest) => {
    const box = mailboxes.get(role) ?? []
    const message = { id: `${role}-${box.length + 1}`, from, tick: world.observe().tick, text, read: false,
      ...(handoff ? { handoff } : {}) }
    engine.recordFact(admin, 'mars-mail', { role, message, ...(handoffRequest ? { handoffRequest } : {}) })
    box.push(message)
    mailboxes.set(role, box)
    if (handoffRequest) handoffRequests.set(handoffRequest.key, { hash: handoffRequest.hash, message })
    deliverMail(role, message)
    return message
  }
  // An interrupted write may leave a rejected draft in the journal before its notification is posted.
  function notifyReview(actor, slot, detail, eventId) {
    if (mode !== 'multi' || !world.stages.researchWorkflow) return
    const reviewer = teamRoles.includes('verifier') && byActor.get(actor)?.role !== 'verifier' ? 'verifier' : 'brain'
    if (byActor.get(actor)?.role === reviewer) return
    const key = JSON.stringify(['slot-review', actor, slot.taskId, slot.slotId, eventId])
    if (!handoffRequests.has(key)) post(reviewer, 'host', `[提交复核] ${slot.taskId}/${slot.slotId}。${detail.slice(0, 400)}。用 research_draft(action=read,task_id=${slot.taskId},slot_id=${slot.slotId}) 读取原稿和回执。`, undefined, { key, hash:contentHash(key) })
  }
  function recoverReviewMail() {
    if (mode !== 'multi' || !world.stages.researchWorkflow) return
    for (const slot of science.stages.view().openSlots) {
      const draft = slot.draft, rejection = slot.rejection
      if (rejection && (!draft || rejection.tick > draft.tick) && (!slot.accepted || rejection.tick > slot.accepted.tick))
        notifyReview(rejection.actorId, slot, '已有拒件，请读取具体错误', rejection.id)
      else if (draft?.problem && (!slot.accepted || draft.tick > slot.accepted.tick))
        notifyReview(draft.actorId, slot, draft.problem, `draft-${draft.revision}`)
    }
  }
  const signal = new AbortController()

  const register = (name, description, parameters, body) => {
    if (registry.has(name)) throw new Error(`Duplicate Mars tool: ${name}`)
    registry.set(name, { name, description, parameters, body })
  }
  const access = (agent, _tool) => {
    const participant = byActor.get(agent?.id)
    if (!participant) throw new Error('Unknown Mars participant; call mars_login first')
    return participant.context
  }
  const observer = delivery ? new PhysicalObserver(engine, world) : null
  const observeOperation = observer ? observer.query.bind(observer) : engine.query.bind(engine)
  const labHost = engine.issueContext(project, 'mars-lab', ['facilities'])
  const procedures = new Procedures({
    engine, world, admin, refs, host: labHost,
    canAdvance: () => !modelClosed && world.observe().tick < world.stages.finalTick,
    sweepAbandoned: false,
    observeOperation,
    notify: async (role, actorId, key, content) => {
      post(role ?? byActor.get(actorId)?.role ?? 'brain', 'host', content)
    },
  })

  const ctxShim = {
    tools: {
      register(definition) {
        register(definition.name, definition.description, definition.parameters, (args, agent, toolSignal) =>
          definition.execute(args, { agent, signal: toolSignal }),
        )
      },
    },
    on() {},
    effect() {},
  }

  const physicalPlanTools = installPhysicalTools(ctxShim, engine, world, access, refs, {
    robotsFor: () => ALL_ROBOTS,
    objectiveIds: V06_TASK_IDS,
    referenceSpecification:
      'R3 measures chamber reference conditions or a biased fast water probe. Water DOC requires calibration against certified fast-channel standards; it is not laboratory truth.',
  })

  installV06ResearchTools({
    register,
    engine,
    tick: () => world.observe().tick,
    profile: world.stages,
    decisionTicks,
    access,
    modelTestOptions: { timeoutMs: world.scienceProfile.modelTimeoutMs, memoryMb: world.scienceProfile.modelMemoryMb, maxOutputBytes: world.scienceProfile.modelOutputBytes },
    catalog: () => science.catalog(),
    actions: science.actionsFor,
    serviceReview: science.serviceReview,
    readPilot: science.readPilot,
    physicalPlanTools,
    evidenceCheck: science.evidenceCheck,
    referencePicker: science.referencePicker,
    reviewNeeded: notifyReview,
    resolveReference: (id) => refs.resolve(id),
    resolvers: science.resolvers,
  })

  for (const [alias, target] of [['action_commit', 'prediction_commit'], ['pipeline_register', 'model_register']]) {
    const original = registry.get(target)
    register(alias, `${alias}: ${original.description}`, original.parameters, original.body)
  }

  if (archive) {
    archive.resumeNumbering(engine.readFacts(admin).filter(fact => fact.kind === 'mars-archive-query').length)
    installV2Tools({ register, access, engine, admin, world, archive, analysis, load, refs })
    const queried = (agent, name, result) => {
      engine.recordFact(access(agent, name), 'mars-archive-query', { queryId: result.queryId })
      return result
    }
    register('archive_search', 'Search immutable historical documents, including revision and obsolete status.', {
      query: { type: 'string', required: true }, offset: { type: 'integer' }, limit: { type: 'integer' },
    }, (args, agent) => queried(agent, 'archive_search', archive.search(args.query, args.offset ?? 0, args.limit ?? 20)))
    register('archive_query', 'Read bounded immutable history. Negative ticks precede the mission; current evidence comes from live tools.', {
      kind: { type: 'string', required: true, enum: ['sensors', 'corrections', 'maintenance', 'experiments', 'documents', 'lots', 'lot_qc', 'reference_checks', 'incidents', 'chromatograms'] },
      id: { type: 'string' }, entity_id: { type: 'string' }, from_tick: { type: 'integer' }, to_tick: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' },
    }, (args, agent) => queried(agent, 'archive_query', archive.query({ kind: args.kind,
      ...(args.id === undefined ? {} : { id: args.id }), ...(args.entity_id === undefined ? {} : { entityId: args.entity_id }),
      ...(args.from_tick === undefined ? {} : { fromTick: args.from_tick }), ...(args.to_tick === undefined ? {} : { toTick: args.to_tick }),
      offset: args.offset ?? 0, limit: args.limit ?? 50 })))
    register('archive_stats', 'Aggregate a historical sensor series without copying all rows to the model.', {
      entity_id: { type: 'string', required: true }, metric: { type: 'string', required: true },
    }, (args, agent) => queried(agent, 'archive_stats', archive.statistics(args.entity_id, args.metric)))
  }
  for (const name of ['deliverable_check', 'deliverable_submit', 'deliverable_status']) registry.delete(name)

  const planning = new V05Planning(engine, admin, currentTick, {}, undefined, 'v06')
  const dispatchPlans = installPlanningTools({
    register,
    engine,
    world,
    access,
    namespace: 'v06',
    currentTick,
    admissionOpen: () => currentTick() < world.stages.finalTick,
    mayDispatch: science.mayDispatch,
    servicePlans: { commissions: science.manifest.commissions, isCommitted: science.isServiceCommitted, receipts: science.serviceReceipts },
    actorKey: id => String(Math.max(0, teamRoles.indexOf(byActor.get(id)?.role))).padStart(2, '0'),
    observeOperation,
    physicalPlanTools,
    resolveArgs: input => refs.resolveArgs(input),
    onPlanBlocked: change => post(byActor.get(change.actorId)?.role ?? 'brain', 'host',
      `[计划${change.terminal ? '失败' : '受阻'}] ${change.planId}/${change.stepId}: ${change.reason}。请用 experiment_plan(action=list) 查看状态；状态变化已记录，不代表操作已执行。`),
  })

  register('mars_inbox', 'Read your Mars mailbox: system reminders and messages from other roles. Reading marks them as read.', {}, (_args, agent) => {
    const participant = byActor.get(agent.id)
    return { role: participant?.role ?? null, messages: consumeInbox(participant.role) }
  })
  register('mars_send', 'Send a message to a Mars role. For a team research handoff, give a request_key and handoff with taskId, slotId and 1–8 accepted references. Put the recipient’s next step in text. The Host checks references and includes the submission cutoff in the mailbox message.', {
    to: { type: 'string', required: true, enum: teamRoles },
    text: { type: 'string', required: true },
    request_key: { type: 'string' },
    handoff: { type: 'object', additionalProperties: false, properties: {
      taskId: { type: 'string', required: true, enum: V06_TASK_IDS },
      slotId: { type: 'string', required: true, enum: ['baseline', 'final'] },
      references: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true, enum: world.stages.researchWorkflow ? workflowHandoffKinds : handoffReferenceKinds },
        id: { type: 'string', required: true },
        revision: { type: 'integer' },
        stepId: { type: 'string', description: 'For a T3 service plan, attach the actual host receipt for this step.' },
      } } },
    } },
  }, (args, agent) => {
    const participant = byActor.get(agent.id)
    if (![...teamRoles, 'single'].includes(args.to)) throw new Error(`Unknown Mars role: ${args.to}`)
    if (args.handoff === undefined) {
      post(args.to, participant?.role ?? 'unknown', String(args.text).slice(0, 4000))
      return { delivered: true, to: args.to, tick: world.observe().tick }
    }
    if (mode !== 'multi' || !participant || args.to === participant.role || ![...participants.values()].some(peer => peer.role === args.to))
      throw new Error('Research handoffs require another joined role in this Mars world')
    const requestKey = identifier.parse(args.request_key)
    const key = JSON.stringify([participant.actorId, requestKey])
    const text = z.string().trim().min(1).max(4000).parse(args.text)
    const draft = researchHandoffSchema.parse(args.handoff)
    const hash = contentHash({ to: args.to, text, handoff: draft })
    const receipt = (message, duplicate) => ({ recorded: true, to: args.to, messageId: message.id,
      tick: message.tick, duplicate, handoff: message.handoff })
    const prior = handoffRequests.get(key)
    if (prior) {
      if (prior.hash !== hash) throw new Error('Handoff request key already used with different input')
      if (!prior.message.read && !suspended) deliverMail(args.to, prior.message)
      return receipt(prior.message, true)
    }
    assertClockHealthy()
    if (!started || suspended || modelClosed) throw new Error('Research handoffs require an active Mars run')
    if (autoAdvance && !decisions.has(participant.sessionId)) throw new Error('Enter the first scientific decision before sending a research handoff')
    const handoff = resolveResearchHandoff(draft, world.observe().tick, world.stages, science.recordsFor(participant.context),
      science.actionsFor(participant.context), science.resolvers, id => refs.resolve(id))
    return receipt(post(args.to, participant.role, text, handoff, { key, hash }), false)
  })

  const procedureTool = (kind) => async (args, agent) => {
    const grant = access(agent, kind)
    const requestKey = String(args.request_key)
    const prior = procedures.byKey(grant.actorId, requestKey)
    if (prior) return { duplicate: true, ...prior }
    const sourceId = typeof args.source_id === 'string' ? args.source_id : undefined
    const sampleId = typeof args.sample_id === 'string' ? args.sample_id : undefined
    if (kind === 'water_split' || !sampleId) {
      if (!['reservoir', 'filter', 'pump'].includes(sourceId)) throw new Error('source_id must be reservoir, filter or pump')
    }
    if (kind === 'water_assay' && sourceId && sampleId) throw new Error('Give source_id or sample_id, not both')
    const storage = kind === 'water_split' ? (Array.isArray(args.storage) ? args.storage : []) : undefined
    if (kind === 'water_split' && (storage.length < 1 || storage.length > 3)) throw new Error('storage must list 1-3 stores')
    const started = await procedures.start({
      kind,
      actorId: grant.actorId,
      requestKey,
      providers: ['water'],
      robot: 'robot-1',
      taskId: String(args.task_id),
      ...(sourceId ? { sourceId } : {}),
      ...(sampleId ? { sampleId } : {}),
      ...(kind === 'water_assay' ? { method: args.method === 'screen' ? 'screen' : 'confirm' } : {}),
      ...(storage ? { storage, copies: Math.max(1, Math.min(5, Number.isInteger(args.copies) ? args.copies : 5)) } : {}),
      ...(typeof args.extraction_batch === 'string' ? { extractionBatch: args.extraction_batch } : {}),
    })
    return { ...started, note: 'The procedure runs on its own; a [流程完成] or [流程失败] message brings the result refs.' }
  }
  const toolId = { type: 'string', required: true }
  register('water_assay', 'Measure water in one call: a fresh sample from a module (source_id: reservoir, filter or pump), or a stored raw water sample (sample_id), goes through water-prepare and confirm (or screen) on the real devices with robot-1. Cleaning between uses is automatic; an expired confirm calibration waits for the engineer.',
    { request_key: toolId, task_id: toolId, source_id: { type: 'string' }, sample_id: { type: 'string' }, method: { type: 'string', enum: ['confirm', 'screen'] }, extraction_batch: { type: 'string' } }, procedureTool('water_assay'))
  register('water_split', 'Take one mother sample from a module and split it into aliquots kept in the chosen stores (cold-1, cold-2, freezer, bench), copies per store (1-5, default 5). Later measure each aliquot with water_assay(sample_id=...).',
    { request_key: toolId, task_id: toolId, source_id: toolId, storage: { type: 'array', items: { type: 'string', enum: [...STORAGE_NAMES] }, required: true }, copies: { type: 'integer' } }, procedureTool('water_split'))

  function peekInbox(role) {
    const box = mailboxes.get(role) ?? []
    return { role, unread: box.filter((message) => !message.read).length, total: box.length }
  }

  if (delivery) installDeliveryTools(register, delivery, world, id => byActor.get(id).role, requiredRoles,
    role=>[...participants.values()].some(p=>p.role===role))
  register('round_receipts', 'Read your durable pending-tool outcomes from committed rounds. Mutations return pending until the common round boundary.', delivery ? {call_id:{type:'string'}} : {}, (args, agent) => {
    const rows = nativeRounds.receipts(agent.id, delivery ? args.call_id : undefined)
    delivery?.readReceipts(byActor.get(agent.id).role, agent.id, rows)
    return rows
  })
  register('mars_procedures', 'Read your water assay/split progress and completed result references.', {}, (_args, agent) => procedures.list(agent.id))

  register(
    'mission_read',
    'Read the Mars mission: commissions, tasks, interfaces, resources, services, evidence rules and the stage clock.',
    { full: { type: 'boolean' } },
    (_args, agent) => {
      const participant = byActor.get(agent.id)
      return {
        ...science.catalog(),
        history: archive?.manifest ?? null,
        role: participant?.role ?? 'single',
        requiredRoles,
        charter: charter(participant?.role ?? 'single', world.stages, decisionTicks, true, teamSize),
        executionControl: {
          horizon: world.horizon,
          finalTick: world.stages.finalTick,
          baselineTick: world.stages.baselineTick,
          modelAdmissionOpen: world.observe().tick < world.stages.finalTick,
        },
      }
    },
  )

  function login(sessionId, role) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('A live DeepWorks session is required')
    if (!requiredRoles.includes(role)) throw new Error(`Role ${role} cannot join this Mars roster. Allowed roles: ${requiredRoles.join(', ')}`)
    const holder = [...participants.values()].find((participant) => participant.role === role && participant.sessionId !== sessionId)
    if (holder) throw new Error(`Role ${role} is already held by another live session`)
    const existing = participants.get(sessionId)
    if (existing && existing.role !== role) throw new Error(`Session already joined as ${existing.role}`)
    if (existing) return describe(existing)
    const previous = [...byActor.values()].find(participant => participant.role === role)
    if (started && previous && previous.sessionId !== sessionId)
      throw new Error('Fixed-role session identity is frozen after mars_start; restore the original conversation or start a fresh run')
    const actorId = previous?.actorId ?? `${role}@${sessionId}`
    const context = engine.issueContext(project, actorId, ['water', 'greenhouse', 'facilities'])
    const participant = { sessionId, role, actorId, context, joinedAt: new Date().toISOString() }
    participants.set(sessionId, participant)
    byActor.set(actorId, participant)
    engine.recordFact(admin, 'mars-organization', { kind: 'member-joined', role, actorId, sessionId, tick: world.observe().tick })
    post(role, 'host', `已加入 Mars v0.6。岗位 ${role}；先读 mission_read 和 research_catalog，再决定实验与提交。`)
    return describe(participant)
  }

  function describe(participant) {
    return {
      sessionId: participant.sessionId,
      role: participant.role,
      actorId: participant.actorId,
      tick: world.observe().tick,
      tools: [...registry.keys()].sort(),
    }
  }

  function listTools() {
    return [...registry.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: delivery && followsReceipts(tool.name) ? {...tool.parameters, follow_up:followUpParameter} : tool.parameters,
    }))
  }

  const immediateTools = new Set(['mars_send', 'mars_procedures'])
  const mutation = (name, args) => !immediateTools.has(name) && isV05Mutation(name, args)

  async function callTool(sessionId, name, args, toolSignal, callId) {
    const participant = participants.get(sessionId)
    if (!participant) throw new Error('Call mars_login before using Mars tools')
    activeTools.set(sessionId, toolCount(sessionId) + 1)
    try {
      await barrier.enter(sessionId, toolSignal ?? signal.signal)
      if (stepWork) await stepWork
      if (paused || closing) throw new Error('Mars host is paused or closing')
      const tool = registry.get(name)
      if (!tool) throw new Error(`Unknown Mars tool: ${name}`)
      const input = args ?? {}
      const setupTools = new Set(['mission_read', 'research_catalog', 'research_read', 'archive_schema', 'robot_status', 'mars_inbox', 'round_receipts', 'mars_procedures', 'mars_send'])
      if ((!started || suspended) && !setupTools.has(name)) throw new Error('Scientific tools require mars_start; initialization only reads public setup metadata')
      const missing = Object.entries(tool.parameters ?? {}).filter(([key, spec]) => spec?.required === true
        && (input[key] === undefined || input[key] === null || input[key] === '')).map(([key]) => key)
      if (missing.length) throw new Error(`Missing required arguments: ${missing.join(', ')}`)
      if (typeof input.chamber_id === 'string') {
        const chambers = world.observe().devices.filter(device => device.id.startsWith('incubator-')).map(device => device.id)
        if (!chambers.includes(input.chamber_id)) throw new Error(`Unknown chamber_id: ${input.chamber_id}; valid chambers: ${chambers.join(', ')}`)
      }
      if (mutation(name, input)) {
        assertClockHealthy()
        if (!started || suspended) throw new Error('Call mars_start after all roles have joined, before scientific mutations')
        if (modelClosed || science.stages.modelAdmissionClosed()) throw new Error('Mars model admission is closed')
        if (autoAdvance && !decisions.has(sessionId)) throw new Error('The first scientific model step must enter host admission after mars_start')
        const id = typeof callId === 'string' && callId ? callId : randomUUID()
        const follow = delivery ? deliverySpec(name, input, participant.role, requiredRoles, world.stages, science.manifest.commissions) : undefined
        const receipt = nativeRounds.queue(participant.actorId, id, name, input, follow)
        return { ...receipt, ...(follow ? {work:delivery.lookup(participant.actorId,receipt.round,id)} : {}), note: 'The host commits the common round before admitting the next model step. Read round_receipts on that step; no self-wake is needed.' }
      }
      return await tool.body(input, { id: participant.actorId }, toolSignal ?? signal.signal)
    } finally {
      activeTools.set(sessionId, Math.max(0, toolCount(sessionId) - 1))
      clock.wake()
    }
  }

  let paused = false
  let closing = false
  let started = false
  let suspended = false
  let modelClosed = false
  let stopReason = 'normal'
  let committing = false
  let stepWork = null
  let manualAdvancing = false
  let committedBoundary = -1
  let barrierKnown = !modelBarrier
  let lastAutoCheckpoint = 0
  let environmentCursor = 0
  let finalReport = null
  let finalizing = null
  const busySessions = new Set()
  const modelHolds = new Set()
  const auxModels = new Set()
  const compactionFailures = new Map()
  const firstDecisions = new Set()
  const activeTools = new Map()
  const sessionEpochs = new Map()
  const waits = new Map()
  const decisions = new Map()
  const gates = new Map()
  const notifications = new Map()
  const pendingActivations = new Map()
  const enteredMessages = new Map()
  const verifyingModels = new Map()
  const lastCancellationIds = new Map()
  const stages = science.stages
  const barrier = new AdmissionBarrier()
  const phaseLedger = `${directory}.phases.jsonl`
  const sealedLedger = runId && protocolHash ? new PhaseLedger(`${directory}.phase-seals.jsonl`, runId, protocolHash, false) : null
  const actorKey = id => String(Math.max(0, teamRoles.indexOf(byActor.get(id)?.role))).padStart(2, '0')
  const nativeRounds = new NativeRounds(engine, admin, currentTick, decisionTicks,
    () => [...byActor.keys()].sort(), () => ({ tick: world.observe().tick, cursor: engine.eventCursor(admin), sensors: world.sensors() }), 'v06', actorKey)
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'unknown'])
  const quiet = new Set(['robot-position', 'logical-decision-progress', 'device-temperature-stable', 'sample-temperature-changed', 'robot-route-accepted', 'operation-processing', 'system-operation-accepted'])
  const active = () => engine.list(admin).some(operation => !terminal.has(operation.state))
  const planned = () => planning.list().some(plan => ['scheduled', 'running'].includes(plan.state) && science.mayDispatch(plan))
  const internalStep = event => ['operation-finished', 'system-operation-settled'].includes(event.kind) && procedures.internal(event.payload?.id ?? '')
  const notable = cursor => world.events(cursor).filter(event => !quiet.has(event.kind) && !internalStep(event))
  const controller = sessionId => ['brain', 'single'].includes(participants.get(sessionId)?.role)
  const toolCount = id => activeTools.get(id) ?? 0
  const blocked = id => gates.has(id) && toolCount(id) === 0 || waits.has(id) && toolCount(id) === 1
  const unsettled = () => [...new Set([...busySessions, ...modelHolds])].some(id => !blocked(id))
  const pendingNotifications = () => [...notifications.values()].some(notice => !notice.delivered && notice.kind !== 'closed')
  const settled = () => !auxModels.size && !firstDecisions.size && !pendingActivations.size && !verifyingModels.size && !unsettled() && ![...activeTools].some(([id, count]) => count && !blocked(id))

  for (const fact of engine.readFacts(admin)) {
    if (fact.kind === 'mars-organization') {
      const data = fact.data
      if (data.kind === 'member-joined') {
        if (!requiredRoles.includes(data.role)) throw new Error(`Saved role ${data.role} is outside this Mars roster`)
        const participant = { sessionId: data.sessionId, role: data.role, actorId: data.actorId,
          context: engine.issueContext(project, data.actorId, ['water', 'greenhouse', 'facilities']) }
        participants.set(data.sessionId, participant)
        byActor.set(data.actorId, participant)
      } else if (data.kind === 'member-left') participants.delete(data.sessionId)
    }
    if (fact.kind === 'mars-mail') {
      const { role, message: persisted, handoffRequest } = fact.data
      const box = mailboxes.get(role) ?? []
      const message = { ...persisted }
      box.push(message)
      mailboxes.set(role, box)
      if (handoffRequest) handoffRequests.set(handoffRequest.key, { hash: handoffRequest.hash, message })
    }
    if (fact.kind === 'mars-mail-read') for (const message of mailboxes.get(fact.data.role) ?? []) if (fact.data.ids.includes(message.id)) message.read = true
    if (fact.kind === 'mars-native-compaction-failed') compactionFailures.set(fact.data.messageId, fact.data)
    if (fact.kind === 'mars-native-start') started = true
    if (fact.kind === 'mars-native-decision') decisions.set(fact.data.sessionId, { key: fact.data.key, tick: fact.data.tick })
    if (fact.kind === 'mars-native-notice') notifications.set(fact.data.id, { ...fact.data, delivered: false })
    if (fact.kind === 'mars-native-notice-delivered' && notifications.has(fact.data.id)) {
      notifications.get(fact.data.id).delivered = true
      notifications.get(fact.data.id).messageId = fact.data.messageId ?? null
      if (fact.data.cancelled || fact.data.superseded) notifications.get(fact.data.id).cancelled = true
    }
    if (fact.kind === 'mars-native-environment-position') environmentCursor = fact.data.cursor
    if (fact.kind === 'mars-native-admission-closed') { modelClosed = true; stopReason = fact.data.reason }
  }
  // Reopening a running dataset is an explicit control operation, never an automatic paid continuation.
  suspended = started && !modelClosed && autoAdvance
  if (existsSync(join(directory, 'final-report.json'))) finalReport = JSON.parse(readFileSync(join(directory, 'final-report.json'), 'utf8'))
  if (stages.modelAdmissionClosed()) modelClosed = true
  world.setStopAtTick(Math.min(world.horizon, stages.nextBoundary()))

  function notification(role, kind, text, key, retryKey) {
    if (!autoAdvance) return
    const participant = [...participants.values()].find(value => value.role === role)
    if (!participant) return
    const id = key ?? randomUUID()
    if (notifications.has(id)) return
    const notice = { id, sessionId: participant.sessionId, role, kind, tick: world.observe().tick, text,
      messageId: null, delivered: false, ...(retryKey ? { retryKey } : {}) }
    notifications.set(id, notice)
    engine.recordFact(admin, 'mars-native-notice', notice)
    if (!['closed', 'report'].includes(kind) && !gates.has(participant.sessionId) && !waits.has(participant.sessionId))
      pendingActivations.set(participant.sessionId, { afterKey: decisions.get(participant.sessionId)?.key, noticeId: id })
    onControlChange()
    clock.wake()
  }

  function assertClockHealthy() {
    const failure = realClock.status().failure
    if (failure) throw new Error(`Mars infrastructure failure: ${failure}`)
  }

  function startRun(sessionId) {
    assertClockHealthy()
    if (!controller(sessionId)) throw new Error('Only brain/single may start or resume the run')
    if (modelClosed || world.observe().tick >= stages.profile.finalTick) throw new Error('Model admission is closed')
    const joined = new Set([...participants.values()].map(participant => participant.role))
    const missing = requiredRoles.filter(role => !joined.has(role))
    if (missing.length) throw new Error(`All ${requiredRoles.length} roles must log in before mars_start. Still missing: ${missing.join(', ')}`)
    if (started && !suspended) { recoverReviewMail(); publishReceipts(); return { started: true, tick: world.observe().tick, resumed: false } }
    const resumed = started
    const activation = resumed ? randomUUID() : 'initial'
    if (resumed) suppressPendingNotices()
    started = true; suspended = false
    engine.recordFact(admin, 'mars-native-start', { tick: world.observe().tick, resumed, activation, protocol: SCHEDULING_PROTOCOL })
    if (resumed) { recoverReviewMail(); publishReceipts() }
    if (autoAdvance) for (const participant of participants.values()) {
      firstDecisions.add(participant.sessionId)
      if (participant.sessionId !== sessionId) {
        const guidance = !resumed && participant.role !== 'single' && participant.role !== 'brain'
          ? `查看 mars_inbox 的新消息，按需查 mission_read 和 research_catalog。\n${teamDeliveryBrief(participant.role, teamSize, world.stages.researchWorkflow)}`
          : '先读 mission_read、research_catalog 和 mars_inbox，按真实证据研究、协作与提交。'
        notification(participant.role, 'start',
          `Mars ${resumed ? '恢复' : '开始'}。你是 ${participant.role}，在同一持久会话自主完成岗位科研。模型 step 的逻辑时间由宿主控制。写操作 pending 后下一步读 round_receipts，等待事件用 mars_wait。${guidance}`,
          `${resumed ? 'resume' : 'start'}:${activation}:${participant.sessionId}`)
      }
    }
    onControlChange(); clock.wake()
    return { started: true, resumed, tick: world.observe().tick, protocol: SCHEDULING_PROTOCOL }
  }

  function suppressPendingNotices() {
    pendingActivations.clear()
    for (const notice of notifications.values()) if (!notice.delivered && notice.kind !== 'report') {
      notice.delivered = true; notice.cancelled = true
      engine.recordFact(admin, 'mars-native-notice-delivered', { id: notice.id, messageId: null, superseded: true, tick: world.observe().tick })
    }
  }
  function closeModels(reason = 'normal') {
    if (modelClosed || !started && reason !== 'normal') return
    modelClosed = true; stopReason = reason
    suppressPendingNotices()
    engine.recordFact(admin, 'mars-native-admission-closed', { reason, tick: world.observe().tick })
    firstDecisions.clear(); modelHolds.clear(); auxModels.clear(); verifyingModels.clear()
    for (const [id, gate] of gates) { gates.delete(id); gate.reject(new Error('Mars model admission closed')) }
    for (const [id, wait] of waits) finishWait(id, wait, { stopped: true })
    for (const participant of participants.values()) notification(participant.role, 'closed', 'Mars 模型准入已关闭；已接纳物理工作继续，由宿主在 horizon 自动结算。', `closed:${participant.sessionId}`)
    onControlChange(); clock.wake()
  }

  function synchronize() {
    if (world.observe().tick < stages.nextBoundary()) return
    science.capture()
    const seal = stages.synchronize({
      worldHash: contentHash({ laboratory: world.observe(), systems: world.observeSystems(), base: world.observeBase(), quality: world.quality() }),
      worldCursor: world.eventCursor(), ledgerCursor: engine.eventCursor(admin),
    })
    if (seal) {
      appendFileSync(phaseLedger, JSON.stringify({ stage: seal.stage, tick: seal.tick, hash: seal.hash, at: Date.now() }) + '\n')
      sealedLedger?.synchronize(world.observe().tick, stages.seals())
    }
    world.setStopAtTick(Math.min(world.horizon, stages.nextBoundary()))
    if (stages.modelAdmissionClosed()) closeModels('normal')
  }

  async function commitRound() {
    if (nativeRounds.currentCommitted()) return
    committing = true
    try {
      const applied = await nativeRounds.commit(async (actorId, _callId, name, args) => {
        try {
          if (modelClosed) throw new Error('Model admission closed before pending intent acceptance')
          if (!byActor.has(actorId)) throw new Error('Round participant is unavailable')
          const tool = registry.get(name)
          if (!tool) throw new Error(`Unknown Mars tool: ${name}`)
          return z.json().parse(await tool.body(args, { id: actorId }, signal.signal))
        } catch (error) { return { isError: true, error: error instanceof Error ? error.message : String(error) } }
      })
      if (applied) publishReceipts()
      committedBoundary = world.observe().tick
    } finally { committing = false }
  }

  async function refresh() {
    const states = new Map()
    for (const operation of engine.list(admin)) {
      const current = terminal.has(operation.state) ? operation : await observeOperation(admin, operation.id)
      states.set(operation.id, current.state)
    }
    const now = currentTick()
    const dispatch = delivery ? plan => planNeedsDispatch(plan, now, id => states.get(id)) : plan => ['scheduled','running'].includes(plan.state)
    if (planning.list().some(dispatch) || planning.reservations().some(r => ['committed','active'].includes(r.state))) await dispatchPlans()
    if (!modelClosed) await procedures.step()
    science.capture(); synchronize()
  }

  function environment() {
    const events = world.events(environmentCursor)
    if (!events.length) return
    if (!modelClosed) {
      const grouped = new Map()
      for (const event of events) {
        let roles = event.kind === 'announcement' ? requiredRoles : (ALERT_ROUTES[event.kind] ?? [])
        if (mode === 'multi' && teamSize === 8) {
          if (event.kind === 'sample-preservation-failed') roles = [...roles, 'service']
          if (['method-revised', 'batch-recalled', 'calibration-results-revoked'].includes(event.kind)) roles = [...roles, 'verifier']
        }
        if (event.kind === 'power-shed' && !(event.payload?.shed ?? []).some(id => TIER_ONE.includes(id))) roles = []
        if (['operation-finished', 'system-operation-settled'].includes(event.kind)) {
          if (internalStep(event)) continue
          const operation = engine.list(admin).find(value => value.id === event.payload?.id)
          const owner = operation && byActor.get(operation.actorId)
          roles = owner ? [owner.role] : []
        }
        for (const role of new Set(roles.map(role => mode === 'single' ? 'single' : role))) {
          const participant = [...participants.values()].find(value => value.role === role)
          if (!participant || waits.has(participant.sessionId)) continue
          grouped.set(role, [...grouped.get(role) ?? [], event])
        }
      }
      for (const [role, selected] of grouped) notification(role, 'environment', JSON.stringify({ kind: 'mars-environment-notice', events: selected.slice(-40) }), `environment:${role}:${selected.at(-1).seq}`)
    }
    environmentCursor = events.at(-1).seq
    if (events.some(event => !quiet.has(event.kind)))
      engine.recordFact(admin, 'mars-native-environment-position', { cursor: environmentCursor, tick: world.observe().tick })
  }

  function grant(sessionId, key, retry = false) {
    const tick = world.observe().tick
    firstDecisions.delete(sessionId)
    modelHolds.add(sessionId)
    if (!retry) {
      decisions.set(sessionId, { key, tick })
      nativeRounds.begin()
      engine.recordFact(admin, 'mars-native-decision', { sessionId, actorId: participants.get(sessionId).actorId, key, tick })
    }
    return { tick, decisionTick: decisions.get(sessionId)?.tick ?? tick, retry, protocol: SCHEDULING_PROTOCOL,
      noticeIds: [...notifications.values()].filter(notice => notice.sessionId === sessionId && notice.delivered && notice.messageId).slice(-30).map(notice => notice.messageId) }
  }
  function releaseDecisions() {
    if (barrier.held || pendingNotifications() || modelClosed) return
    for (const [id, gate] of gates) if (world.observe().tick >= gate.at && !nativeRounds.currentCommitted()) {
      gates.delete(id); gate.resolve(grant(id, gate.key))
    }
  }
  async function enterDecision({ sessionId, key, messageId, noticeId }) {
    assertClockHealthy()
    if (!participants.has(sessionId)) throw new Error('Call mars_login first')
    if (!started || suspended) throw new Error('Use mars_start to start or resume the scientific run')
    if (modelClosed || world.observe().tick >= stages.profile.finalTick) throw new Error('Mars model admission closed')
    if (typeof key !== 'string' || !key) throw new Error('A stable model step key is required')
    if (noticeId) {
      const notice = notifications.get(noticeId)
      if (!notice || notice.sessionId !== sessionId || notice.cancelled) throw new Error('Mars decision cancelled: notice is no longer active')
    }
    if (typeof messageId === 'string') enteredMessages.set(sessionId, messageId)
    const activation = pendingActivations.get(sessionId)
    if (activation && (key !== activation.afterKey || messageId && [...notifications.values()].some(n => n.sessionId === sessionId && n.delivered && n.messageId === messageId)))
      pendingActivations.delete(sessionId)
    const epoch = sessionEpochs.get(sessionId) ?? 0
    await barrier.enter(sessionId, signal.signal)
    if (stepWork) await stepWork
    if ((sessionEpochs.get(sessionId) ?? 0) !== epoch) throw new Error('Mars decision cancelled')
    assertClockHealthy()
    if (modelClosed) throw new Error('Mars model admission closed')
    const prior = decisions.get(sessionId)
    if (prior?.key === key) return grant(sessionId, key, true)
    if (!prior || world.observe().tick >= prior.tick + decisionTicks && !nativeRounds.currentCommitted()) return grant(sessionId, key)
    if (gates.has(sessionId)) {
      if (gates.get(sessionId).key !== key) throw new Error('Concurrent distinct model requests for one Mars participant')
      return gates.get(sessionId).promise
    }
    modelHolds.delete(sessionId)
    const at = Math.max(prior.tick + decisionTicks, nativeRounds.currentCommitted() ? (Math.floor(world.observe().tick / decisionTicks) + 1) * decisionTicks : 0)
    let resolveGate, rejectGate
    const promise = new Promise((resolve, reject) => { resolveGate = resolve; rejectGate = reject })
    gates.set(sessionId, { key, at, resolve: resolveGate, reject: rejectGate, promise })
    clock.wake()
    return promise
  }

  function publishReport() {
    if (!finalReport) return
    notification(mode === 'single' ? 'single' : 'brain', 'report', JSON.stringify({ kind: 'mars-final-report', tick: world.observe().tick,
      R: finalReport.R, O: finalReport.O, F: finalReport.F, completionStatus: finalReport.completionStatus, failureReasons: finalReport.failureReasons }), `report:${runId}`)
  }
  async function finishMission() {
    if (finalReport) { publishReport(); return finalReport }
    if (world.observe().tick < world.horizon) throw new Error('Finalization requires the sealed horizon')
    if (!finalizing) finalizing = (async () => {
      finalReport = await science.finalize(stopReason === 'budget_exhausted' ? 'budget_exhausted' : stopReason === 'normal' ? 'normal' : 'model_error')
      writeFileSync(join(directory, 'final-report.json'), JSON.stringify(finalReport, null, 2) + '\n')
      publishReport()
      return finalReport
    })()
    return finalizing
  }

  async function dispatchStep(checkpointRequested) {
    if (checkpointRequested) {
      const release = barrier.hold()
      try {
        await commitRound()
        const target = Math.min(world.horizon, world.observe().tick + decisionTicks)
        while (!closing && world.observe().tick < target) {
          if (world.advance(target) === null) break
          await refresh()
          await yieldIO()
        }
        environment()
      } finally { release() }
      deliverWaits(); releaseDecisions()
    } else {
      await refresh(); environment(); deliverWaits()
      if (settled() && !pendingNotifications()) await commitRound()
      releaseDecisions()
    }
    const tick = world.observe().tick
    if (tick >= world.horizon) { await finishMission(); return }
    const checkpointTick = checkpointIntervalTicks > 0 ? Math.floor(tick / checkpointIntervalTicks) * checkpointIntervalTicks : 0
    if (checkpointTick > lastAutoCheckpoint && !active() && !nativeRounds.pending() && !procedures.hasPending() && !planned() && !gates.size) {
      try { await saveCheckpoint(`auto-${tick}`); lastAutoCheckpoint = checkpointTick }
      catch (error) { process.stderr.write(`mars checkpoint: ${error.message}\n`) }
    }
  }

  mkdirSync(join(directory, 'clock'), { recursive: true })
  let checkpointRequested = false
  const realClock = new SimulationClock(join(directory, 'clock'), () => {
    checkpointRequested = !modelClosed && gates.size > 0
    return checkpointRequested || world.advance() !== null
  }, error => {
    const message = `Mars infrastructure failure: ${error.message}`
    process.stderr.write(`mars clock failed: ${error.message}\n`)
    for (const [id, gate] of gates) { gates.delete(id); gate.reject(new Error(message)) }
    for (const [id, wait] of waits) finishWait(id, wait, { stopped: true, failure: message })
    try { engine.recordFact(admin, 'mars-native-clock-failure', { tick: world.observe().tick, error: error.message }) }
    catch (recordError) { process.stderr.write(`mars failure record unavailable: ${recordError.message}\n`) }
    onControlChange()
  }, 'event-driven')
  const clock = { wake: () => realClock.wake(), close: () => realClock.close() }
  realClock.attach(() => autoAdvance && started && !suspended && barrierKnown && !paused && !closing && !manualAdvancing && !barrier.held
    && world.observe().tick < world.horizon && (modelClosed || settled() && !pendingNotifications()), () => {
    stepWork = dispatchStep(checkpointRequested)
    return stepWork.finally(() => { stepWork = null })
  })

  async function advance(steps) {
    assertClockHealthy()
    if (unsettled()) throw new Error('Cannot advance while Mars sessions are busy')
    if (manualAdvancing || paused) throw new Error('Mars advancement is already in progress or paused')
    manualAdvancing = true
    const release = barrier.hold()
    try {
      if (stepWork) await stepWork
      await commitRound()
      let moved = 0
      while (!closing && moved < steps && world.observe().tick < world.horizon) {
        if (world.advance() === null) break
        moved += 1; stepWork = refresh()
        try { await stepWork } finally { stepWork = null }
        environment(); deliverWaits(); releaseDecisions()
        await yieldIO()
      }
      if (world.observe().tick >= world.horizon) await finishMission()
      return { tick: world.observe().tick, seals: stages.seals().map(seal => seal.stage) }
    } finally { release(); manualAdvancing = false; deliverWaits(); releaseDecisions(); clock.wake() }
  }
  const finalize = () => finishMission()

  function consumeInbox(role) {
    const messages = (mailboxes.get(role) ?? []).filter(message => !message.read)
    for (const message of messages) message.read = true
    if (messages.length) engine.recordFact(admin, 'mars-mail-read', { role, ids: messages.map(message => message.id) })
    return messages
  }
  function waitReady(wait) { return notable(wait.cursor).length > 0 || peekInbox(wait.role).unread > 0 || world.observe().tick >= wait.until || modelClosed }
  function finishWait(sessionId, wait, extra = {}) {
    waits.delete(sessionId)
    activeTools.set(sessionId, Math.max(0, toolCount(sessionId) - 1))
    if (!closing && !modelClosed) modelHolds.add(sessionId)
    wait.resolve({ tick: world.observe().tick, startTick: wait.startTick, untilTick: Number.isFinite(wait.until) ? wait.until : null,
      events: notable(wait.cursor).slice(-40), messages: extra.cancelled || extra.stopped ? [] : consumeInbox(wait.role), timedOut: false, ...extra })
  }
  function deliverWaits() {
    if (committing || barrier.held) return
    for (const [id, wait] of waits) if (waitReady(wait)) finishWait(id, wait)
  }
  async function waitFor(params) {
    assertClockHealthy()
    if (stepWork) await stepWork
    assertClockHealthy()
    if (closing || paused || modelClosed) throw new Error('Mars model admission is closed or paused')
    if (!started || suspended) throw new Error('mars_wait requires mars_start; finish setup and wait for the host activation notice')
    const participant = participants.get(params.sessionId)
    if (!participant) throw new Error('Call mars_login before using mars_wait')
    if (autoAdvance && !decisions.has(params.sessionId)) throw new Error('Wait for the first host-admitted model step after mars_start')
    if (waits.has(params.sessionId)) throw new Error('This session already has a pending mars_wait')
    await barrier.enter(params.sessionId, signal.signal)
    assertClockHealthy()
    const until = params.untilTick === undefined ? world.horizon : Math.min(world.horizon, params.untilTick)
    if (!Number.isSafeInteger(until)) throw new Error('until_tick must be an integer')
    modelHolds.delete(params.sessionId)
    activeTools.set(params.sessionId, toolCount(params.sessionId) + 1)
    return new Promise(resolve => {
      waits.set(params.sessionId, { role: participant.role, startTick: world.observe().tick, until, cursor: world.eventCursor(), resolve })
      publishReceipts(); deliverWaits(); clock.wake()
    })
  }
  function cancelWait(sessionId) {
    const wait = waits.get(sessionId)
    if (wait) finishWait(sessionId, wait, { cancelled: true })
    clock.wake(); return { cancelled: Boolean(wait) }
  }
  function sessionIdle(sessionId, { cancelled = false, cancellationId } = {}) {
    if (cancelled) {
      const role = participants.get(sessionId)?.role
      if (cancellationId && (lastCancellationIds.get(sessionId) === cancellationId || (role && delivery?.wasCancelled(role,cancellationId)))) return { idle: true, duplicate: true }
      if (cancellationId) lastCancellationIds.set(sessionId, cancellationId)
      const activationId = pendingActivations.get(sessionId)?.noticeId, enteredId = enteredMessages.get(sessionId)
      pendingActivations.delete(sessionId); enteredMessages.delete(sessionId)
      for (const [id, owner] of verifyingModels) if (owner === sessionId) verifyingModels.delete(id)
      for (const notice of notifications.values()) if (notice.sessionId === sessionId && !notice.cancelled && !['closed', 'report'].includes(notice.kind)
        && (!notice.delivered || notice.id === activationId || notice.messageId && notice.messageId === enteredId)) {
        notice.delivered = true; notice.cancelled = true
        engine.recordFact(admin, 'mars-native-notice-delivered', { id: notice.id, messageId: notice.messageId, cancelled: true, tick: world.observe().tick })
      }
      onControlChange()
    }
    sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1)
    modelHolds.delete(sessionId); auxModels.delete(sessionId); busySessions.delete(sessionId)
    const gate = gates.get(sessionId)
    if (gate) { gates.delete(sessionId); gate.reject(new Error('Mars decision cancelled')) }
    cancelWait(sessionId); modelHolds.delete(sessionId)
    const participant = participants.get(sessionId)
    if (cancelled && participant && started && !suspended && !modelClosed) delivery?.cancelOwner(participant.role, cancellationId)
    publishReceipts()
    clock.wake(); return { idle: true }
  }
  function logout(sessionId) {
    sessionIdle(sessionId, { cancelled: true })
    if (participants.delete(sessionId)) engine.recordFact(admin, 'mars-organization', { kind: 'member-left', sessionId, tick: world.observe().tick })
    return { closed: true }
  }
  async function auxModel(sessionId, active) {
    if (active) {
      assertClockHealthy()
      const epoch = sessionEpochs.get(sessionId) ?? 0
      await barrier.enter(sessionId, signal.signal)
      if (stepWork) await stepWork
      if ((sessionEpochs.get(sessionId) ?? 0) !== epoch) throw new Error('Mars auxiliary call cancelled')
      assertClockHealthy()
      if (modelClosed) throw new Error('Mars model admission closed')
      auxModels.add(sessionId)
    } else auxModels.delete(sessionId)
    clock.wake()
    return { active: auxModels.has(sessionId) }
  }
  function recordCompactionFailure({ sessionId, messageId, reason }) {
    const participant = participants.get(sessionId)
    if (!participant || typeof messageId !== 'string' || !messageId || messageId.length > 256 || reason !== 'context_overflow')
      throw new Error('Invalid compaction failure report')
    const prior = compactionFailures.get(messageId)
    if (prior) {
      if (prior.sessionId !== sessionId) throw new Error('Compaction failure message belongs to another participant')
      return { recorded: false, duplicate: true }
    }
    if (!started || suspended || modelClosed) return { recorded: false, duplicate: false }
    const failure = { sessionId, messageId, role: participant.role, reason, tick: world.observe().tick,
      decisionTick: decisions.get(sessionId)?.tick ?? null }
    engine.recordFact(admin, 'mars-native-compaction-failed', failure)
    compactionFailures.set(messageId, failure)
    auxModels.delete(sessionId)
    if (mode === 'multi' && participant.role !== 'brain') {
      post('brain', 'host', `岗位 ${participant.role} 在 tick ${failure.tick} 的上下文压缩因上下文过长失败。请核对该岗位待交付事项及真实回执，按当前期限安排接管。`)
    }
    onControlChange()
    clock.wake()
    return { recorded: true, duplicate: false }
  }
  function verifyModel({ sessionId, messageId, active }) {
    if (!participants.has(sessionId) || typeof messageId !== 'string' || typeof active !== 'boolean') throw new Error('Invalid model verification hold')
    if (active) {
      assertClockHealthy()
      if (modelClosed || !started || suspended) throw new Error('Mars decision cancelled: model verification is closed')
      verifyingModels.set(messageId, sessionId)
    } else if (verifyingModels.get(messageId) === sessionId) verifyingModels.delete(messageId)
    onControlChange(); clock.wake()
    return { active: verifyingModels.has(messageId) }
  }
  function retryModel({ sessionId, key, messageId, reason }) {
    const participant = participants.get(sessionId)
    if (!participant || reason !== 'text_tool_call' || typeof key !== 'string' || typeof messageId !== 'string') throw new Error('Invalid model retry request')
    if (!autoAdvance || !started || suspended || modelClosed || realClock.status().failure) return { accepted: false, reason: 'admission_unavailable' }
    if (verifyingModels.get(messageId) !== sessionId) return { accepted: false, reason: 'verification_cancelled' }
    if (decisions.get(sessionId)?.key !== key || gates.has(sessionId) || waits.has(sessionId)) return { accepted: false, reason: 'stale_step' }
    const id = `model-retry:${sessionId}:${key}`
    if (notifications.has(id)) return { accepted: false, reason: 'retry_limit' }
    engine.recordFact(admin, 'mars-native-model-retry', { sessionId, key, messageId, reason, attempt: 1, tick: world.observe().tick })
    notification(participant.role, 'retry', '上一次回复把工具标记写进了普通文本，没有形成实际工具调用。请在同一步使用引擎原生工具通道继续，先读真实回执；不要复述摘要或输出 DSML/invoke 字符串。此格式纠正仅重试一次，不创建新科研窗口。', id, key)
    return { accepted: true, noticeId: id, key }
  }
  function acknowledgeNotice(id, messageId) {
    const notice = notifications.get(id)
    if (notice && !notice.delivered) {
      notice.delivered = true
      notice.messageId = messageId ?? null
      if (notice.messageId && enteredMessages.get(notice.sessionId) === notice.messageId) pendingActivations.delete(notice.sessionId)
      engine.recordFact(admin, 'mars-native-notice-delivered', { id, messageId: notice.messageId, tick: world.observe().tick })
      onControlChange()
    }
    deliverWaits(); releaseDecisions(); clock.wake()
    return { acknowledged: Boolean(notice) }
  }

  function latestSeal() {
    try {
      const lines = readFileSync(phaseLedger, 'utf8').split('\n').filter(Boolean)
      return lines.length ? JSON.parse(lines.at(-1)) : null
    } catch {
      return null
    }
  }

  function copyTree(source, destination) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (['mars-server.pid', 'mars-plugin.log', 'mars-sidecar.log', 'clock'].includes(entry.name)) continue
      const from = join(source, entry.name)
      const to = join(destination, entry.name)
      if (entry.isDirectory()) copyTree(from, to)
      else if (entry.isFile()) {
        if (relative(directory, from).replaceAll('\\', '/') === 'public/history/history.sqlite') {
          copyFileSync(from, to)
        } else if (entry.name.endsWith('.sqlite')) {
          const db = new DatabaseSync(from, { readOnly: true })
          try {
            db.exec('PRAGMA busy_timeout=5000')
            db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`)
          } finally {
            db.close()
          }
        } else if (!entry.name.endsWith('-wal') && !entry.name.endsWith('-shm')) copyFileSync(from, to)
      }
    }
  }

  async function saveCheckpoint(label) {
    if (active() || nativeRounds.pending() > 0 || procedures.hasPending() || planned())
      throw new Error('Cannot checkpoint while operations, procedures, plans or round intents are pending; use mars_wait first')
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}-${String(label).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'manual'}`
    const destination = join(dirname(directory), 'checkpoints', id)
    copyTree(directory, destination)
    const seal = latestSeal()
    const meta = { id, home: directory, createdAt: new Date().toISOString(), tick: world.observe().tick, latestSeal: seal?.hash ?? null, latestStage: seal?.stage ?? null }
    writeFileSync(join(destination, 'checkpoint.json'), `${JSON.stringify(meta, null, 2)}\n`)
    return meta
  }

  async function checkpoint(label = 'manual') {
    if (paused || closing) throw new Error('Mars host is paused or closing')
    paused = true
    try {
      if (stepWork) await stepWork
      return await saveCheckpoint(label)
    } finally { paused = false; clock.wake() }
  }

  async function close() {
    closing = true; signal.abort()
    for (const [id, gate] of gates) { gates.delete(id); gate.reject(new Error('Mars host closing')) }
    for (const [id, wait] of waits) finishWait(id, wait, { cancelled: true })
    await clock.close()
    if (stepWork) await stepWork
  }

  publishReport()
  return {
    login,
    listTools,
    callTool,
    participants: () => [...participants.values()].map(describe),
    peekInbox,
    waitFor,
    cancelWait,
    logout,
    roleOf: (sessionId) => participants.get(sessionId)?.role,
    close,
    wake: () => clock.wake(),
    checkpoint,
    advance,
    finalize,
    stages: () => stages.view(),
    startRun,
    enterDecision,
    sessionIdle,
    closeModels,
    auxModel,
    recordCompactionFailure,
    notices: () => [...notifications.values()].filter(notice => !notice.delivered && (!suspended || notice.kind === 'closed' || notice.kind === 'report')),
    acknowledgeNotice,
    retryModel,
    verifyModel,
    recordContext: ({ sessionId, kind, text }) => {
      if (!participants.has(sessionId) || kind !== 'compaction-resume' || typeof text !== 'string' || text.length > 8192) throw new Error('Invalid model context record')
      engine.recordFact(admin, 'mars-native-model-context', { sessionId, kind, text, tick: world.observe().tick })
      return { recorded: true }
    },
    controlInfo: () => ({ protocol: SCHEDULING_PROTOCOL, started, suspended, modelAdmissionClosed: modelClosed, stopReason,
      clock: realClock.status(), finalized: Boolean(finalReport), activationWaiting: pendingActivations.size, verificationWaiting: verifyingModels.size }),
    roundInfo: () => ({ protocol: SCHEDULING_PROTOCOL, started, suspended, modelAdmissionClosed: modelClosed, stopReason,
      round: Math.floor(world.observe().tick / decisionTicks), pending: nativeRounds.pending(), committedBoundary,
      busy: [...new Set([...busySessions, ...modelHolds])].filter(id => !blocked(id)).length,
      waiting: waits.size, decisionsWaiting: gates.size, firstDecisionsPending: firstDecisions.size, activationWaiting: pendingActivations.size, verificationWaiting: verifyingModels.size, noticesPending: [...notifications.values()].filter(value => !value.delivered).length,
      clock: realClock.status(), finalized: Boolean(finalReport),
      recentCompactionFailures: [...compactionFailures.values()].slice(-8).map(({ role, tick, decisionTick, reason }) => ({ role, tick, decisionTick, reason })),
      report: finalReport ? { R: finalReport.R, F: finalReport.F, completionStatus: finalReport.completionStatus } : null }),
    setBusy: (ids) => {
      if (!modelBarrier) return { busy: 0, enabled: false }
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('busy.set requires a session array')
      barrierKnown = true; busySessions.clear()
      for (const id of ids) busySessions.add(id)
      for (const id of modelHolds) if (!busySessions.has(id) && !toolCount(id) && !gates.has(id)) modelHolds.delete(id)
      publishReceipts(); deliverWaits(); releaseDecisions(); clock.wake()
      return { busy: busySessions.size, enabled: true }
    },
    tick: () => world.observe().tick,
  }
}
