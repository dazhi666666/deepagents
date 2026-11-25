/** Recompute a stopped scientific run from read-only device/execution snapshots. */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext, Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { laboratoryStateSchema } from '../../greenhouse/laboratory/schema.ts'
import { marsSystemStateSchema } from '../world.ts'
import { baseStateSchema } from '../base.ts'
import { AnalysisRegistry } from '../analysis.ts'
import { loadTruth } from '../truth.ts'
import { scienceProfileSchema } from './profile.ts'
import { contentHash, stageProfileSchema } from './contracts.ts'
import { compileScenario } from './scenario.ts'
import { scienceInstance } from './science.ts'
import { createCases } from './cases.ts'
import { qualityStateSchema } from './measurement-quality.ts'
import { openProtocol } from './protocol.ts'
import { PhaseLedger } from './phase-ledger.ts'
import { budgetConfigSchema, V06Budget } from './budget.ts'
import { finalizeV06, type EvaluationWorld } from './finalize.ts'

export async function reportScientificStopped(input: { directory: string; truthFile: string;
  engine: Pick<ExecutionEngine, 'readFacts' | 'recordFact' | 'list' | 'eventCursor'>; context: OperationContext;
  identity: Json; usage: Json; checks: { name: string; passed: boolean }[] }) {
  const { directory, engine, context } = input
  const settings = z.object({ implementation: z.literal('scientific_candidate'), sourceTruthHash: z.string(), scienceProfile: scienceProfileSchema,
    stageProfile: stageProfileSchema, decisionTicks: z.number().int().positive(), instanceFile: z.string(), budget: budgetConfigSchema.nullable(),
    stopAtTick: z.number().int().positive() }).strict().parse(JSON.parse(readFileSync(`${directory}.evaluator/v06-runtime.json`, 'utf8')))
  const source = loadTruth(input.truthFile)
  if (contentHash(source) !== settings.sourceTruthHash || !existsSync(settings.instanceFile)) throw new Error('Private scientific source or instance is unavailable')
  const instance = scienceInstance(directory, contentHash(source), contentHash(settings.scienceProfile), settings.stageProfile, settings.instanceFile)
  const compiled = compileScenario(source, settings.stageProfile, settings.scienceProfile, instance.salt)
  const manifest = createCases(compiled.truth, settings.scienceProfile, settings.stageProfile, instance.salt)
  const storedCases = JSON.parse(readFileSync(`${directory}.evaluator/v06-cases.json`, 'utf8'))
  if (contentHash(storedCases) !== contentHash(manifest)) throw new Error('Private validation case identity differs')
  const publicManifest = z.object({ scenarioHash: z.string(), caseManifestHash: z.string(), protocolHash: z.string(),
    mode: z.enum(['environment', 'single-agent', 'multi-agent']), model: z.object({ provider: z.string(), model: z.string(), maxTokens: z.number() }),
    modelSource: z.enum(['environment', 'real-model', 'scripted-integration']) }).parse(JSON.parse(readFileSync(join(directory, 'manifest.public.json'), 'utf8')))
  if (contentHash(compiled.scenario) !== publicManifest.scenarioHash || manifest.hash !== publicManifest.caseManifestHash) throw new Error('Scientific scenario differs from its run manifest')
  const nativeOnly = new Set(['real_native_member_lineage', 'tasks_authored_by_actual_native_participants'])
  if (input.checks.some(check => !check.passed && (publicManifest.mode !== 'environment' || !nativeOnly.has(check.name)))) throw new Error('Stopped scientific execution evidence is inconsistent')
  const db = new DatabaseSync(join(directory, 'device/laboratory.sqlite'), { readOnly: true })
  const state = (table: string): unknown => {
    const row = z.object({ state: z.string() }).parse(db.prepare(`SELECT state FROM ${table} WHERE id=1`).get())
    return JSON.parse(row.state)
  }
  let world: EvaluationWorld
  try {
    db.exec('BEGIN')
    const laboratory = laboratoryStateSchema.parse(state('world')), systems = marsSystemStateSchema.parse(state('mars_state')),
      base = baseStateSchema.parse(state('mars_base')), quality = qualityStateSchema.parse(state('mars_v06_quality'))
    world = { observe: () => structuredClone(laboratory), observeSystems: () => structuredClone(systems), observeBase: () => structuredClone(base),
      quality: () => structuredClone(quality), truth: compiled.truth, scienceProfile: settings.scienceProfile, stages: settings.stageProfile, horizon: settings.stageProfile.horizon }
  } finally { db.close() }
  const tick = world.observe().tick
  if (tick < settings.stopAtTick) throw new Error('Scientific run has not reached its configured stop boundary')
  const protocol = openProtocol(engine, context, () => tick, settings.stageProfile, settings.decisionTicks, {},
    { implementation: 'scientific_candidate', caseManifestHash: manifest.hash })
  const identity = z.object({ runId: z.string().uuid() }).parse(input.identity)
  new PhaseLedger(`${directory}.phase-seals.jsonl`, identity.runId, protocol.config.protocolHash, true).synchronize(tick, protocol.stages.seals())
  let money: V06Budget | undefined
  try {
    if (settings.budget) money = new V06Budget(`${directory}.budget.sqlite`, settings.budget, true)
    const admission = engine.readFacts(context).filter(f => f.kind === 'mars-v06-model-admission-closed').at(-1)
    const finalizationInvalid = engine.readFacts(context).some(f => f.kind === 'mars-v06-finalization-invalid')
    const stopReason = finalizationInvalid ? 'infrastructure' : admission ? z.object({ reason: z.enum(['normal', 'budget_exhausted', 'model_error', 'infrastructure']) }).parse(admission.data).reason : 'normal'
    if (stopReason === 'infrastructure' || settings.stopAtTick < world.horizon) return { benchmarkVersion: 'v0.6', implementation: 'scientific_candidate',
      completionStatus: stopReason === 'infrastructure' ? 'infrastructure_invalid' : 'early_stopped', stopReason: stopReason === 'infrastructure' ? 'infrastructure' : 'operator_stop',
      tick, horizon: world.horizon, R: null, O: null, F: null, score: null, formalRankingEligible: false, budget: money?.report() ?? null }
    const analysis = new AnalysisRegistry(join(directory, 'analysis'), true, { isolatedRealm: true,
      timeoutMs: settings.scienceProfile.analysisTimeoutMs, maxOutputBytes: settings.scienceProfile.analysisOutputBytes })
    return { ...await finalizeV06({ world, engine, context, analysis, records: protocol.records, stages: protocol.stages, manifest, stopReason }),
      budget: money?.report() ?? null, usage: input.usage, mode: publicManifest.mode, model: publicManifest.model,
      modelSource: publicManifest.modelSource, costComparisonValid: money?.report().costStatus === 'verified' }
  } finally { money?.close() }
}
