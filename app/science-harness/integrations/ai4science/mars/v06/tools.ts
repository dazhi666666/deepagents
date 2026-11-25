/** Version-specific research JSON tools; the host supplies only public evidence metadata. */
import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { Json, OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { V05ResearchRecords, researchPutSchema } from '../v05/research-records.ts'
import { modelInputSchema, predictionInputSchema, submissionInputSchema, submissionPayloadSchema,
  submissionCutoff, taskIdSchema, type StageProfile, type Submission } from './contracts.ts'
import { publicMission, taskSlots } from './registry.ts'
import { V06Records, type RecordResolvers } from './records.ts'
import { actionInputSchema, type V06Actions } from './actions.ts'
import { pipelineInputSchema } from './pipeline.ts'
import { readResearch } from './research-read.ts'
import { materializeSubmission, selectedSubmissionSchema } from './selected-submission.ts'
import { contentHash } from './contracts.ts'
import { isChoiceTrial } from './pilot-choice-contract.ts'
import { SubmissionDrafts, publicProblem, type DraftSlot } from './submission-drafts.ts'
import { referenceKinds, type referenceDirectory } from './reference-directory.ts'
import { modelTestInputSchema, modelTestLimits, testModel, type ModelTestLimits } from './model-test.ts'
import { publicPlanContract } from '../v05/planning-tools.ts'
import type { PhysicalPlanTools } from '../tools.ts'

type Register = (name: string, description: string, parameters: ParameterSchemaSpec,
  body: (args: Record<string, unknown>, agent: Agent, signal: AbortSignal) => unknown | Promise<unknown>) => void

const researchContracts = z.object({ research_write: researchPutSchema, model_register: modelInputSchema, model_test: modelTestInputSchema,
  prediction_commit: predictionInputSchema, action_commit: actionInputSchema, pipeline_register: pipelineInputSchema,
  research_submit: submissionInputSchema })
const contractNameSchema = researchContracts.keyof()
type ContractName = z.infer<typeof contractNameSchema>

function publicContract(name: ContractName, profile: StageProfile) {
  const schema = name === 'action_commit' && !profile.researchWorkflow ? actionInputSchema.omit({ reviewId:true }) : researchContracts.shape[name]
  const tool = name === 'action_commit' ? 'prediction_commit' : name === 'pipeline_register' ? 'model_register' : name
  return { ...z.toJSONSchema(schema, { io: 'input' }),
    'x-mars-call': { tool, requiredArgs: name === 'model_test' ? ['input_json'] : ['input_json', 'request_key'],
      ...(name === 'research_submit' ? { actions: ['check', 'submit', ...(profile.researchWorkflow === 'delivery-v2' ? ['check_submit'] : [])], defaultAction: 'submit',
        ...(profile.researchWorkflow === 'delivery-v2' ? {checkSubmitInput:z.toJSONSchema(selectedSubmissionSchema,{io:'input'})} : {}) } : {}) } }
}

/** Install public research IO and caller-input execution checks without scientific labels. */
export function installResearchTools(input: { register: Register; engine: ExecutionEngine; tick: () => number;
  profile: StageProfile; decisionTicks: number; access(agent: Agent, name: string): OperationContext; resolvers: RecordResolvers;
  catalog?: () => unknown; actions?: (grant: OperationContext) => V06Actions; resolveReference?: (id: string) => string;
  reviewNeeded?: (actor: string, slot: DraftSlot, detail: string, eventId: string) => void
  serviceReview?: () => unknown
  readPilot?: () => unknown
  modelTestOptions?: ModelTestLimits; physicalPlanTools?: PhysicalPlanTools
  referencePicker?: (query: Parameters<typeof referenceDirectory>[6]) => ReturnType<typeof referenceDirectory>
  evidenceCheck?: (taskId: Submission['taskId'], draft: Pick<Submission, 'acceptedTick' | 'evidence'>, slotId: Submission['slotId']) => { group: string; eligible: boolean; missing: string[] }[] }) {
  const testLimits = modelTestLimits(input.modelTestOptions)
  const stores = (agent: Agent, tool: string) => {
    const grant = input.access(agent, tool)
    const notes = new V05ResearchRecords(input.engine, grant, input.tick, reference =>
      input.resolvers.evidence?.(reference.id, reference.revision) ?? null, 'mars-v06-research')
    const records = new V06Records(input.engine, grant, input.tick, input.profile, { ...input.resolvers,
      dependency: (id, revision) => {
        const note = notes.read(id, revision)
        return note ? { availableAt: note.availableAt } : null
      } })
    const actions = input.actions?.(grant)
    return { notes, records, drafts: new SubmissionDrafts(input.engine, grant, input.tick, input.profile, records, input.evidenceCheck), ...(actions ? { actions } : {}) }
  }
  const payload = { input_json: { type: 'string', required: true }, request_key: { type: 'string', required: true } } as const
  const parse = (args: Record<string, unknown>) => {
    const request = z.record(z.string(), z.unknown()).parse(JSON.parse(String(args.input_json)))
    if (Array.isArray(request.evidence)) request.evidence = request.evidence.map(item => {
      const reference = z.record(z.string(), z.unknown()).parse(item)
      return { ...reference, ...(typeof reference.id === 'string' ? { id: input.resolveReference?.(reference.id) ?? reference.id } : {}) }
    })
    return request
  }
  const registerWrite = (name: string, description: string, write: (request: Record<string, unknown>, key: string,
    agent: Agent, args: Record<string, unknown>) => unknown, extra: ParameterSchemaSpec = {}) => {
    input.register(name, description, { ...payload, ...extra }, (args, agent) => {
      try {
        return write(parse(args), String(args.request_key), agent, args)
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error
        throw new Error(error.issues.map(issue => `${issue.path.map(String).join('.') || 'input_json'}: ${issue.message}`).join('\n'))
      }
    })
  }
  const planHelp = input.physicalPlanTools ? ' For experiment_plan add tool for one step argument schema.' : ''
  const delivery = input.profile.researchWorkflow === 'delivery-v2'
  const pages = new Map<string,{ value:Record<string,Json>; tag:string; seen:Set<string> }>()
  const registerCatalog: Register = !delivery ? input.register : (name, description, parameters, lookup) => input.register(name, description + ' Repeated static pages return a contractTag; refresh=true reads the full page again.',
    {...parameters,refresh:{type:'boolean'},if_none_match:{type:'string'}}, async (args,agent,signal) => {
      const section=args.section ?? (args.contract ? 'contracts' : 'summary')
      if (!['tasks','contracts','interfaces'].includes(String(section))) return lookup(args,agent,signal)
      const {refresh,if_none_match,...query}=args, key=contentHash(query)
      let page=pages.get(key)
      if (!page) {
        const value=z.record(z.string(),z.json()).parse(await lookup(query,agent,signal))
        page={value,tag:contentHash(value),seen:new Set()}
        if (pages.size>=96) pages.delete(pages.keys().next().value!)
        pages.set(key,page)
      }
      const known=page.seen.has(agent.id) || if_none_match===page.tag
      page.seen.add(agent.id)
      if (known && refresh!==true) return {unchanged:true,contractTag:page.tag,section,readFull:'refresh=true'}
      return {...page.value,contractTag:page.tag}
    })
  registerCatalog('research_catalog', `Read the compact v0.6 directory. Set contract for the exact input schema.${planHelp} For research_submit add task_id=T1..T6 for slot payloads. Use section=references with task_id, optional slot_id and reference_kind for available evidence IDs, payload fields and accepted submission receipts. Filter resources with resource_kind, for example batch or robot. Paged sections use limit=1..10.`,
    { section: { type: 'string', enum: ['summary', 'tasks', 'interfaces', 'resources', 'services', 'handover', 'evidence', 'references', 'contracts'] },
      task_id: { type: 'string' }, slot_id: { type: 'string', enum: ['baseline', 'final'] }, reference_kind: { type: 'string', enum: [...referenceKinds] }, contract: { type: 'string' }, tool: { type: 'string' },
      resource_kind: { type: 'string', enum: ['device', 'method', 'robot', 'batch', 'rules'] }, offset: { type: 'integer' }, limit: { type: 'integer' } }, args => {
      if (args.section === 'contracts' || (args.section === undefined && args.contract !== undefined)) {
        if (args.contract === 'experiment_plan' && input.physicalPlanTools)
          return { experiment_plan: publicPlanContract(input.physicalPlanTools, z.string().optional().parse(args.tool)) }
        if (args.contract === undefined) return { ...Object.fromEntries(contractNameSchema.options.map(name => [name, publicContract(name, input.profile)])),
          ...(input.physicalPlanTools ? { experiment_plan: publicPlanContract(input.physicalPlanTools) } : {}) }
        const name = contractNameSchema.parse(args.contract)
        const result = { [name]: publicContract(name, input.profile) }
        if (name !== 'research_submit' || args.task_id === undefined) return result
        const taskId = taskIdSchema.parse(args.task_id)
        return { ...result, taskId, slots: taskSlots(taskId, input.profile).map(slotId => ({ slotId,
          acceptBeforeTick: submissionCutoff(input.profile, slotId),
          payloadSchema: z.toJSONSchema(submissionPayloadSchema(taskId, slotId, input.profile), { io: 'input' }) })) }
      }
      const offset = z.number().int().nonnegative().parse(args.offset ?? 0), limit = z.number().int().min(1).max(10).parse(args.limit ?? 3)
      if (args.section === 'references') {
        if (!input.referencePicker) throw new Error('Reference directory requires a scientific world')
        const taskId = taskIdSchema.parse(args.task_id), slotId = z.enum(['baseline', 'final']).parse(args.slot_id ?? 'final')
        if (!taskSlots(taskId, input.profile).includes(slotId)) throw new Error(`No ${slotId} slot for ${taskId}`)
        return input.referencePicker({ taskId, slotId, kind: z.enum(referenceKinds).optional().parse(args.reference_kind), offset, limit })
      }
      const catalog = z.record(z.string(), z.json()).parse(input.catalog?.() ?? publicMission(input.profile, input.decisionTicks))
      const page = (items: unknown[]) => ({ total: items.length, offset, limit, items: items.slice(offset, offset + limit) })
      const tasks = z.array(z.object({ id: z.string(), title: z.string(), slots: z.array(z.string()), components: z.record(z.string(), z.number()) }).passthrough()).parse(catalog.tasks)
      if (args.section === 'tasks') return page(tasks.filter(t => args.task_id === undefined || t.id === args.task_id))
      if (args.section === 'interfaces') {
        const interfaces = z.record(z.string(), z.json()).parse(catalog.modelInterfaces)
        if (args.task_id !== undefined) return { taskId: String(args.task_id), interface: interfaces[String(args.task_id)] ?? null }
        return page(Object.entries(interfaces).map(([taskId, value]) => ({ taskId, interface: value })))
      }
      if (args.section === 'resources') {
        const resources = z.object({ devices: z.array(z.json()), methods: z.array(z.json()), robots: z.array(z.json()), rules: z.json(),
          batches: z.array(z.json()).default([]) }).parse(catalog.resources)
        const inventory = [...resources.devices.map(value => ({ kind: 'device', value })), ...resources.methods.map(value => ({ kind: 'method', value })),
          ...resources.robots.map(value => ({ kind: 'robot', value })), { kind: 'rules', value: resources.rules },
          ...resources.batches.map(value => ({ kind: 'batch', value }))]
        return page(inventory.filter(item => args.resource_kind === undefined || item.kind === args.resource_kind))
      }
      if (args.section === 'services') return page(z.array(z.json()).parse(catalog.services))
      if (args.section === 'handover') return page(z.array(z.json()).parse(catalog.handover))
      if (args.section === 'evidence') return { evidenceRules: catalog.evidenceRules ?? null, instruments: catalog.instruments ?? null, requiredConditions: catalog.requiredConditions ?? null }
      return { version: catalog.version, status: catalog.status, stages: catalog.stages, horizon: catalog.horizon, decisionTicks: catalog.decisionTicks,
        commissions: catalog.commissions, scoring: catalog.scoring, orderingPolicy: catalog.orderingPolicy ?? null, executionRuntime: catalog.executionRuntime ?? null, budget: catalog.budget ?? null,
        ...(input.profile.researchWorkflow ? {workflowTools:['research_draft','service_review',...(delivery ? ['receipt_work','research_changes'] : [])]} : {}),
        ...(isChoiceTrial(input.profile.jointTrial) ? {pilotRead:'trial_pilot'} : {}),
        tasks: tasks.map(({ id, title, slots, components }) => ({ id, title, slots, components })),
        sections: ['tasks', 'interfaces', 'resources', 'services', 'handover', 'evidence', 'references', 'contracts'],
        contractNames: [...contractNameSchema.options, ...(input.physicalPlanTools ? ['experiment_plan'] : [])],
        instructions: 'Use contract for the exact schema. For experiment_plan add tool for step args. For research_submit add task_id for slot payloads. Analyse raw arrays through analysis_run.' }
    })
  input.register('research_read', 'Read by id across notes/models/pipelines/predictions/actions; use kind if an ID is ambiguous. Submissions use task_id+slot_id and optional revision. No arguments retain the aggregate view; no scientific feedback.',
    { id: { type: 'string' }, revision: { type: 'integer' }, kind: { type: 'string', enum: ['auto', 'research', 'model', 'pipeline', 'prediction', 'action', 'submission'] },
      task_id: { type: 'string', enum: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'] }, slot_id: { type: 'string', enum: ['baseline', 'final'] } },
    (args, agent) => readResearch(stores(agent, 'research_read'), args))
  registerWrite('research_write', 'Revise research notes with expectedRevision. Support is Agent-authored, never certified truth.', (request, key, agent) => {
    if (input.tick() >= input.profile.finalTick) throw new Error('Final research admission closed')
    return stores(agent, 'research_write').notes.put(key, researchPutSchema.parse(request))
  })
  registerWrite('model_register', 'Register immutable code with syntax/schema preflight, or a finite DAG using pipelineId. code is a synchronous function body that returns finite JSON. Include parameters in the model payload. Use model_test on public inputs after acceptance.',
    (request, key, agent) => {
      const { records } = stores(agent, 'model_register')
      return Object.hasOwn(request, 'pipelineId') ? records.registerPipeline(key, request) : records.registerModel(key, request)
    })
  input.register('model_test', 'Execute a registered model/pipeline on 1-16 caller-supplied public JSON inputs. input_json contains modelId OR pipelineId and inputs. Checks runtime and declared IO only; executionValid never means scientific acceptance or hidden-case accuracy.',
    { input_json: { type: 'string', required: true } }, async (args, agent, signal) => {
      if (input.tick() >= input.profile.finalTick) throw new Error('Public model tests close at the final model-admission boundary')
      const { records } = stores(agent, 'model_test')
      return testModel(records, JSON.parse(String(args.input_json)), testLimits, signal)
    })
  registerWrite('prediction_commit', 'Lock a model or pipeline with inputDomain for installed scientific cases. To lock an unstarted T3/T4 plan and its forecast, use the action_commit contract with planId.',
    (request, key, agent) => {
      const { records, actions } = stores(agent, 'prediction_commit')
      if (Object.hasOwn(request, 'planId')) {
        if (!actions) throw new Error('Physical forecast policy is not installed')
        return actions.commit(key, request)
      }
      return records.commitPrediction(key, request)
    })
  if (isChoiceTrial(input.profile.jointTrial) && input.readPilot) input.register('trial_pilot', 'Read the completed baseline pilot, observed scan changes, and four citable operation IDs for T6 final.', {}, (_args, agent) => {
    input.access(agent, 'trial_pilot'); return input.readPilot!()
  })
  if (input.profile.researchWorkflow) {
    input.register('research_draft', 'Shared slot editor. read returns current draft, last rejected request and actual accepted revision. save with revision (0 to create), request_key and input_json={payload?,evidence?,expectedRevision?,rejectionId?}. Payload fields merge; evidence replaces the list. Selecting a prediction fills its registered model/pipeline. submit with the exact draft revision and a request_key, then read round_receipts. All roles can take over.',
      { action: { type: 'string', required: true, enum: ['read','save','submit'] }, task_id: { type: 'string', required: true }, slot_id: { type: 'string', required: true },
        revision: { type: 'integer' }, input_json: { type: 'string' }, request_key: { type: 'string' } }, (args, agent) => {
        const s = { taskId: taskIdSchema.parse(args.task_id), slotId: z.enum(['baseline','final']).parse(args.slot_id) }
        if (!taskSlots(s.taskId, input.profile).includes(s.slotId)) throw new Error('Unavailable task slot')
        const { drafts } = stores(agent, 'research_draft')
        if (args.action === 'read') return drafts.read(s)
        const key = z.string().trim().min(1).max(160).parse(args.request_key), revision = z.number().int().nonnegative().parse(args.revision)
        if (args.action === 'submit') return drafts.submit(s, revision, key)
        if (args.action !== 'save') throw new Error('Choose read, save or submit')
        const saved = drafts.save(s, revision, key, parse(args))
        if (saved.draft.problem && !saved.replay) input.reviewNeeded?.(agent.id, s, `草稿版本 ${saved.draft.revision}，${saved.draft.problem}`, `draft-${saved.draft.revision}`)
        return { ...saved, accepted: false, scientificValidation: 'not_evaluated' }
      })
    if (input.serviceReview) input.register('service_review', 'Read version-bound checks for all active service plans. Resolve the first route or deadline blocker, then attach that plan’s reviewId to its T3 action commitment.' + (delivery ? ' The commissions page includes each source, deadline, earliest retained sample completion and matching measured mothers even before scheduling.' : ''), {}, (_args, agent) => {
      input.access(agent, 'service_review'); return input.serviceReview!()
    })
  }
  registerWrite('research_submit', 'Submit a task/slot revision with real references. action=check validates format and references and lists missing public evidence when available. Submit explicitly before the cutoff and verify the accepted revision in round_receipts.',
    (request, key, agent, args) => {
      const { records, drafts } = stores(agent, 'research_submit')
      let recoverable = request
      try {
        if (args.action === 'check_submit') {
          if (!delivery || !input.referencePicker) throw new Error('Typed check_submit requires delivery-v2 in a scientific world')
          const picker=input.referencePicker
          const accepted=records.submitResolved(contentHash(['check_submit',key]), {selection:request}, () => {
            const cutoff=submissionCutoff(input.profile,z.enum(['baseline','final']).parse(request.slotId))
            if (input.tick()>=cutoff) throw new Error(`Submission slot closed: acceptedTick must be < ${cutoff}`)
            if (request.rejectionId !== undefined) {
              const target=selectedSubmissionSchema.pick({taskId:true,slotId:true,expectedRevision:true}).parse({taskId:request.taskId,slotId:request.slotId,expectedRevision:request.expectedRevision})
              const base=drafts.rejected(target,z.string().parse(request.rejectionId))
              const patch=z.record(z.string(),z.json()).parse(request.payload ?? {})
              recoverable={...base,...request,payload:{...z.record(z.string(),z.json()).parse(base.payload ?? {}),...patch}}
            }
            recoverable=materializeSubmission(recoverable, records, picker, id=>input.resolveReference?.(id) ?? id,
              (id,revision)=>{const e=input.resolvers.evidence?.(id,revision);return Boolean(e && e.availableAt<=input.tick())})
            return recoverable
          })
          return {...accepted,accepted:true,scientificValidation:'not_evaluated'}
        }
        if (args.action !== undefined && args.action !== 'submit' && args.action !== 'check') throw new Error('Unknown research submission action')
        if (args.action !== 'check') return { ...records.submit(key, request), accepted: true }
        const { request: { taskId, slotId, expectedRevision, evidence }, now } = records.check(request)
        const evidenceChecks = input.evidenceCheck?.(taskId, { evidence, acceptedTick: now }, slotId)
        return { taskId, slotId, expectedRevision, checkedTick: now, acceptBeforeTick: submissionCutoff(input.profile, slotId),
          formatValid: true, accepted: false, scientificValidation: 'not_evaluated', nextAction: 'submit',
          ...(evidenceChecks ? { evidenceChecks } : {}) }
      } catch (error) {
        if (input.profile.researchWorkflow) {
          const rejection = drafts.rememberFailure(key, recoverable, publicProblem(error))
          if (rejection) input.reviewNeeded?.(agent.id, rejection, rejection.problem, rejection.id)
        }
        throw error
      }
    }, { action: { type: 'string', enum: ['check', 'submit', ...(delivery ? ['check_submit'] : [])], ...(delivery ? {description:'check_submit validates selected references and formally submits in this window. Use references=[{kind,id,purpose?}] plus task-specific payload.'} : {}) } })
}
