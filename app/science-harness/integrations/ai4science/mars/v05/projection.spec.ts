import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { V05ResearchRecords } from './research-records.ts'
import { V05Predictions } from './predictions.ts'
import { researchProjection } from './projection.ts'

const engines: ExecutionEngine[] = [], roots: string[] = []
afterEach(async () => { for (const engine of engines.splice(0)) await engine.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('projects public research and revision history without evaluator facts, code bodies or scientific scores', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-v05-projection-')); roots.push(root)
  const engine = new ExecutionEngine({ directory: root, providers: [], pollIntervalMs: 5, providerCallTimeoutMs: 1000 })
  engines.push(engine); await engine.open(); engine.createProject('mars', null)
  const grant = engine.issueContext('mars', 'public-reader', [])
  engine.recordFact(grant, 'private-evaluator-target', { truth: 'DO_NOT_PROJECT_PRIVATE_TARGET', score: 99 })
  engine.recordFact(grant, 'legacy-final-score', { S: 99, answers: 'DO_NOT_PROJECT_PRIVATE_TARGET' })
  let now = 12
  const records = new V05ResearchRecords(engine, grant, () => now)
  const first = { id: 'public-claim', expectedRevision: 0, kind: 'claim' as const, project: 'PW' as const, content: { estimate: 7 }, reason: 'observed' }
  records.put('first', first); now = 24
  records.put('second', { ...first, expectedRevision: 1, content: { estimate: 8 }, reason: 'revised' })
  new V05Predictions(engine, grant, () => now, records).registerModel('model', { id: 'public-model', code: 'return "MODEL_CODE_SHOULD_BE_REFERENCED"', parameters: {}, inputSchema: {}, outputSchema: {},
    runtimeVersion: 'mars-model-v1', basedOn: [{ id: first.id, revision: 2 }] })
  const view = researchProjection(engine, grant, now)
  expect(view.records[0]?.revision).toBe(2)
  expect(view.revisions.map(record => record.revision)).toEqual([1, 2])
  expect(view.projects.find(project => project.project === 'PW')?.tasks).toHaveLength(5)
  expect(view.models[0]).toMatchObject({ id: 'public-model', basedOn: [{ id: first.id, revision: 2 }] })
  expect(view.models[0]).not.toHaveProperty('code')
  expect(JSON.stringify(view)).not.toContain('DO_NOT_PROJECT_PRIVATE_TARGET')
  expect(JSON.stringify(view)).not.toContain('MODEL_CODE_SHOULD_BE_REFERENCED')
  for (const key of ['truth', 'score', 'accuracy', 'probes', 'targets', 'answers']) expect(view).not.toHaveProperty(key)
  const source = readFileSync(fileURLToPath(new URL('./projection.ts', import.meta.url)), 'utf8')
  expect(source).not.toMatch(/\.truth\b|loadTruth\(|scoring-accuracy|scoring-plan|observeBase\(/)
})
