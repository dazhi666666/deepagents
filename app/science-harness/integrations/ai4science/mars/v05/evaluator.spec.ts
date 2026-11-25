import { describe, expect, it } from 'vitest'
import { evaluateV05, validateEvaluationManifest, type EvaluationInput, type EvaluationManifest, type Objective } from './evaluator.ts'
import { publicMission, V05_TASK_IDS, V05_TASKS } from './registry.ts'
import { LEGACY_ROLE_MAP, v05Charter } from './team.ts'
import { V05Observations, collectEvaluationInput } from './evaluation-input.ts'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { AnalysisRegistry } from '../analysis.ts'

const target = (overrides: Partial<Objective> = {}): Objective => ({ id: 'water-concentration', duplicateKey: 'water-concentration', component: 'R', taskId: 'PW-01', branch: 'accuracy',
  points: 1, metric: { kind: 'numeric', target: 5, tolerance: 1 }, deadline: 100,
  evidence: [{ kind: 'measurement', count: 1, purpose: 'current-estimate', metadata: { module: 'reservoir' } }], ...overrides })
const manifest = (objectives: Objective[] = [target()]): EvaluationManifest => ({ version: 'v0.5', mode: 'slice', horizon: 200, objectives })
const input = (): EvaluationInput => ({ facts: [{ id: 'm1', kind: 'measurement', availableAt: 20, completedAt: 18, state: 'succeeded', metadata: { module: 'reservoir' } }],
  observations: [{ objectiveId: 'water-concentration', id: 'answer1', submittedAt: 30, value: 5, evidence: [{ id: 'm1', purpose: 'current-estimate' }] }], predictions: [] })

describe('v0.5 public registry and organization', () => {
  it('defines exactly eighteen cards with the published project weights', () => {
    expect(V05_TASK_IDS).toHaveLength(18)
    const sum = (project: string) => V05_TASK_IDS.filter(id => V05_TASKS[id].project === project).reduce((n, id) => n + V05_TASKS[id].weight, 0)
    expect(['PW', 'PG', 'PF', 'PX'].map(sum)).toEqual([18, 20, 12, 15])
    expect(publicMission().status).toBe('design_not_frozen')
    expect(() => publicMission(0)).toThrow()
  })
  it('gives a single actor every research responsibility without leaking scenario-specific procedures', () => {
    const single = v05Charter('single')
    for (const id of V05_TASK_IDS) expect(single).toContain(id)
    for (const role of Object.keys(LEGACY_ROLE_MAP) as (keyof typeof LEGACY_ROLE_MAP)[]) expect(v05Charter(role)).toContain('角色是责任划分')
  })
})

describe('offline scientific evaluation', () => {
  it('scores a correct raw estimate with actual timely supporting evidence', () => {
    const result = evaluateV05(manifest(), input())
    expect(result.score).toBe(1)
    expect(result.maximum).toBe(1)
    expect(result.components.R).toBe(1)
    expect(result.tasks['PW-01']).toEqual({ score: 1, maximum: 1 })
  })
  it('keeps fixed denominators when the actor does nothing', () => {
    const result = evaluateV05(manifest(), { facts: [], observations: [], predictions: [] })
    expect(result.score).toBe(0)
    expect(result.maximum).toBe(1)
    expect(result.objectives[0]?.reason).toBe('missing')
  })
  it('rejects perfect guesses without evidence, future evidence and wrong metadata', () => {
    const data = input()
    data.observations[0]!.evidence = []
    expect(evaluateV05(manifest(), data).score).toBe(0)
    data.observations[0]!.evidence = [{ id: 'm1', purpose: 'current-estimate' }]
    data.facts[0]!.availableAt = 40
    expect(evaluateV05(manifest(), data).score).toBe(0)
    data.facts[0]!.availableAt = 20
    data.facts[0]!.metadata.module = 'pump'
    expect(evaluateV05(manifest(), data).score).toBe(0)
  })
  it('cannot dilute a missing evidence class by adding or duplicating unrelated citations', () => {
    const objective = target({ evidence: [...target().evidence, { kind: 'analysis', count: 1, purpose: 'current-estimate' }] })
    const data = input()
    data.observations[0]!.evidence.push(...Array.from({ length: 30 }, () => ({ id: 'm1', purpose: 'current-estimate' })))
    expect(evaluateV05(manifest([objective]), data).score).toBe(0)
  })
  it('accepts declared equivalent physical provenance while rejecting unrelated operations', () => {
    const objective = target({ evidence: [{ kind: 'operation', count: 1, purpose: 'current-estimate', anyMetadata: [{ action: 'scan' }, { action: 'process', methodId: 'image' }] }] })
    const data = input()
    data.facts[0]!.kind = 'operation'; data.facts[0]!.metadata = { action: 'charge' }
    expect(evaluateV05(manifest([objective]), data).score).toBe(0)
    data.facts[0]!.metadata = { action: 'process', methodId: 'image' }
    expect(evaluateV05(manifest([objective]), data).score).toBe(1)
  })
  it('allows recalled observations for bias studies, without accepting them as normal current estimates', () => {
    const data = input()
    data.facts[0]!.revokedAt = 25
    data.facts[0]!.permittedPurposes = ['bias-study']
    expect(evaluateV05(manifest(), data).score).toBe(0)
    data.observations[0]!.evidence = [{ id: 'm1', purpose: 'bias-study' }]
    expect(evaluateV05(manifest([target({ evidence: [{ kind: 'measurement', count: 1, purpose: 'bias-study' }] })]), data).score).toBe(1)
  })
  it('does not backfill a prediction locked after validation became visible', () => {
    const objective = target({ branch: 'test', points: 1, validationAvailableAt: 50 })
    const data = input()
    data.observations[0]!.submittedAt = 40
    data.observations[0]!.predictionId = 'p1'
    data.predictions.push({ id: 'p1', target: 'water-concentration', lockedAt: 50, modelHash: 'frozen-code', dependencyAvailableAt: [20] })
    data.validationResults = [{ objectiveId: 'water-concentration', predictionId: 'p1', value: 5, evaluatedAt: 50 }]
    expect(evaluateV05(manifest([objective]), data).score).toBe(0)
    data.predictions[0]!.lockedAt = 40
    expect(evaluateV05(manifest([objective]), data).score).toBe(1)
    data.observations[0]!.submittedAt = 50
    expect(evaluateV05(manifest([objective]), data).score).toBe(0) // selecting the best precommit after seeing validation is also leakage
    data.observations[0]!.submittedAt = 40
    data.validationResults = []
    expect(evaluateV05(manifest([objective]), data).objectives[0]?.reason).toBe('missing_frozen_model_validation')
    data.validationResults = [{ objectiveId: 'water-concentration', predictionId: 'p1', value: 5, evaluatedAt: 50 }]
    data.facts[0]!.availableAt = 45
    expect(evaluateV05(manifest([objective]), data).score).toBe(0)
  })
  it('evaluates the latest timely revision, never the best retrospectively chosen answer', () => {
    const data = input()
    data.observations.push({ ...data.observations[0]!, id: 'revision2', submittedAt: 40, value: 9 })
    expect(evaluateV05(manifest(), data).score).toBe(0)
    data.observations[1]!.submittedAt = 101
    expect(evaluateV05(manifest(), data).score).toBe(1)
  })
  it('rejects duplicate scientific targets and incomplete core manifests before scoring', () => {
    expect(() => validateEvaluationManifest(manifest([target(), target({ id: 'another' })]))).toThrow('Duplicate')
    expect(() => validateEvaluationManifest({ ...manifest(), mode: 'core' })).toThrow()
    expect(() => validateEvaluationManifest(manifest([target({ metric: { kind: 'numeric', target: 2, tolerance: 0 } })]))).toThrow('tolerance')
  })
  it('validates a complete 100-point manifest without normalizing missing work away', () => {
    const objectives: Objective[] = []
    for (const id of V05_TASK_IDS) {
      const t = V05_TASKS[id]
      if (t.project === 'PX') objectives.push(target({ id, duplicateKey: id, component: 'J', taskId: id, branch: undefined, points: t.weight }))
      else for (const branch of ['accuracy', 'test'] as const) objectives.push(target({ id: `${id}:${branch}`, duplicateKey: `${id}:${branch}`, taskId: id, branch,
        points: t.weight * (branch === 'accuracy' ? 0.65 : 0.35), ...(branch === 'test' ? { validationAvailableAt: 90 } : {}) }))
    }
    for (const [component, points] of [['K', 15], ['O', 15], ['Q', 5]] as const) objectives.push(target({ id: component, duplicateKey: component, component, taskId: undefined, branch: undefined, points }))
    const core = { ...manifest(objectives), mode: 'core' as const }
    const result = evaluateV05(core, { facts: [], observations: [], predictions: [] })
    expect(result.maximum).toBeCloseTo(100)
    expect(result.score).toBe(0)
    expect(result.tasks['PX-03']!.maximum).toBe(4)
  })
  it('scores uncertain intervals and set membership from raw values', () => {
    const data = input()
    data.observations[0]!.value = { est: 5, lo: 4.9, hi: 5.1 }
    expect(evaluateV05(manifest([target({ metric: { kind: 'numeric', target: 5, tolerance: 1, interval: true } })]), data).score).toBeCloseTo(0.985)
    data.observations[0]!.value = ['inlet', 'seal']
    expect(evaluateV05(manifest([target({ metric: { kind: 'set', target: ['inlet'] } })]), data).score).toBe(0.5)
  })
})

describe('host observation journal and collection', () => {
  it('stamps host time, survives reconstruction and cannot accept self-certified evidence', () => {
    const rows: { kind: string; data: unknown }[] = []
    const engine = { readFacts: () => rows, recordFact: (_context: unknown, kind: string, data: unknown) => rows.push({ kind, data }) } as unknown as ExecutionEngine
    const context = { projectId: 'mars', actorId: 'single', allowedProviders: [] } as OperationContext
    let now = 12
    const request = { objectiveId: 'PW-01:reservoir', value: 5, evidence: [{ id: 'm1', purpose: 'current-estimate' }] }
    const store = new V05Observations(engine, context, () => now, () => ({ availableAt: 10 }))
    const answer = store.submit('same-key', request)
    now = 36
    expect(new V05Observations(engine, context, () => now).submit('same-key', request)).toEqual(answer)
    expect(answer.submittedAt).toBe(12)
    expect(() => store.submit('same-key', { ...request, value: 7 })).toThrow('different input')
    expect(() => new V05Observations(engine, context, () => now).submit('new-key', request)).toThrow('Evidence unavailable')
    expect(() => store.submit('extra-field', { ...request, submittedAt: 0 } as never)).toThrow()
  })
  it('only certifies actual succeeded operations with known host logical completion times', () => {
    const operations = [
      { id: 'op1', state: 'succeeded', input: { module: 'reservoir' }, providerId: 'water', artifacts: [{ id: 'ar1', sha256: 'hash' }] },
      { id: 'op2', state: 'failed', input: {}, providerId: 'water', artifacts: [] },
      { id: 'op3', state: 'succeeded', input: {}, providerId: 'water', artifacts: [] },
    ]
    const engine = { readFacts: () => [], list: () => operations, events: () => [{ operation_id: 'op1', data_json: JSON.stringify({ state: 'succeeded', logicalTick: 24 }) }] } as unknown as ExecutionEngine
    const context = { projectId: 'mars', actorId: 'host', allowedProviders: ['water'] } as OperationContext
    const analysis = { ids: () => new Set<string>() } as unknown as AnalysisRegistry
    const result = collectEvaluationInput({ engine, context, analysis })
    expect(result.facts.map(f => f.id)).toEqual(['op1', 'ar1'])
    expect(result.facts[0]?.availableAt).toBe(24)
    expect(result.facts[0]?.metadata.module).toBe('reservoir')
  })
  it('uses analysis publication time rather than the earlier data snapshot tick', () => {
    const rows: { kind: string; data: unknown }[] = []
    const engine = { readFacts: () => rows, list: () => [], events: () => [] } as unknown as ExecutionEngine
    const context = { projectId: 'mars', actorId: 'host', allowedProviders: [] } as OperationContext
    const analysis = { ids: () => new Set(['a-0001']), get: () => ({ id: 'a-0001', status: 'done', actorId: 'single', asOfTick: 12, codeSha256: 'hash' }) } as unknown as AnalysisRegistry
    expect(collectEvaluationInput({ engine, context, analysis }).facts).toEqual([])
    rows.push({ kind: 'mars-v05-analysis-published', data: { id: 'a-0001', tick: 24 } })
    const fact = collectEvaluationInput({ engine, context, analysis }).facts[0]
    expect(fact?.availableAt).toBe(24)
    expect(fact?.completedAt).toBe(24)
  })
})
