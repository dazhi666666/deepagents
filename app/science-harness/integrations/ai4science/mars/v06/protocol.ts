/** Protocol-only milestone: no science score or model spending is reported as verified. */
import { z } from 'zod'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { canonicalJson } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { contentHash, stageProfileSchema, digestSchema, type StageProfile } from './contracts.ts'
import { publicMission, protocolHash } from './registry.ts'
import { V06Records, type ResearchJournal, type RecordResolvers } from './records.ts'
import { V06Stages } from './stages.ts'

const configSchema = z.object({ version: z.literal('v0.6'), implementation: z.enum(['protocol_only', 'scientific_candidate']),
  stages: stageProfileSchema, decisionTicks: z.number().int().positive(), protocolHash: digestSchema,
  caseManifestHash: digestSchema.nullable().default(null) }).strict()
export type ProtocolConfig = z.infer<typeof configSchema>

/** Open one versioned journal; profile changes and nonzero worlds without protocol history fail closed. */
export function openProtocol(journal: ResearchJournal, context: OperationContext, tick: () => number,
  profile: StageProfile, decisionTicks: number, resolvers: RecordResolvers = {},
  options: { implementation?: 'protocol_only' | 'scientific_candidate'; caseManifestHash?: string } = {}) {
  const implementation = options.implementation ?? 'protocol_only', caseManifestHash = options.caseManifestHash ?? null
  if (profile.researchWorkflow && implementation !== 'scientific_candidate') throw new Error('Reviewed service commitments require the scientific world')
  if (profile.jointTrial && implementation !== 'scientific_candidate') throw new Error('T6 paired growth requires the scientific evaluator')
  const config = configSchema.parse({ version: 'v0.6', implementation, stages: profile, caseManifestHash,
    decisionTicks, protocolHash: contentHash({ publicProtocol: protocolHash(profile, decisionTicks, implementation), caseManifestHash }) })
  const history = journal.readFacts(context), stored = history.filter(f => f.kind === 'mars-v06-config')
  if (stored.length > 1) throw new Error('Duplicate v0.6 protocol configuration')
  if (stored.length) {
    if (canonicalJson(z.json().parse(configSchema.parse(stored[0]!.data))) !== canonicalJson(z.json().parse(config))) throw new Error('Persisted protocol profile differs')
  } else {
    if (tick() !== 0 || history.some(f => f.kind.startsWith('mars-v05-') || f.kind.startsWith('mars-v06-')))
      throw new Error('Cannot introduce v0.6 into an existing scientific run')
    journal.recordFact(context, 'mars-v06-config', z.json().parse(config))
  }
  const records = new V06Records(journal, context, tick, profile, resolvers)
  const stages = new V06Stages(journal, context, profile, config.protocolHash, tick, records)
  return { config, records, stages, mission: publicMission(profile, decisionTicks, implementation) }
}

/** Reconstruct the candidate report from durable protocol facts; missing science remains explicit. */
export function protocolReport(journal: ResearchJournal, context: OperationContext, tick: number, stopAtTick: number) {
  const entries = journal.readFacts(context).filter(f => f.kind === 'mars-v06-config')
  if (entries.length !== 1) throw new Error('Expected exactly one v0.6 protocol configuration')
  const config = configSchema.parse(entries[0]!.data)
  if (config.implementation !== 'protocol_only') throw new Error('Scientific runs require the scientific evaluator')
  const protocol = openProtocol(journal, context, () => tick, config.stages, config.decisionTicks)
  if (tick < stopAtTick) throw new Error('Protocol execution has not reached its stop boundary')
  if (stopAtTick > config.stages.horizon) throw new Error('Stop boundary exceeds protocol horizon')
  const seals = protocol.stages.seals()
  if (tick >= config.stages.horizon && seals.at(-1)?.stage !== 'horizon') throw new Error('Protocol horizon has not been sealed')
  return { benchmarkVersion: 'v0.6' as const, implementation: 'protocol_only' as const,
    calibrationStatus: 'not_frozen' as const, completionStatus: 'protocol_only' as const,
    evaluationStatus: 'scientific_evaluation_not_installed' as const, tick, stopAtTick,
    reachedHorizon: tick === config.stages.horizon, protocolHash: config.protocolHash, stages: protocol.stages.view(),
    submissions: protocol.records.submissions(), score: null, R: null, O: null, F: null,
    evidenceValid: null, formalRankingEligible: false,
    costStatus: 'not_applicable_no_model_admission' as const,
    limitations: ['E1/E2, scientific cases, full plan execution and budget/isolation acceptance remain pending'] }
}
