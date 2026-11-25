import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { AnalysisRegistry } from '../analysis.ts'
import { truthFor, python } from '../fixture.ts'
import { marsScenario } from '../scenario.ts'
import { MarsWorld, initialMarsRules } from '../world.ts'
import { reportStopped } from '../report.ts'
import { buildEarlyStopReport, earlyStopMarkdown } from './early-stop.ts'

it('reports actual progress at the user cutoff without scoring, validating predictions or changing deadlines', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-partial-report-')), { truth } = truthFor(join(root, 'run'))
  const world = new MarsWorld(join(root, 'device'), marsScenario(truth), initialMarsRules(), truth)
  const engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: [], pollIntervalMs: 5, providerCallTimeoutMs: 1000 })
  await engine.open(); engine.createProject('mars', null)
  const context = engine.issueContext('mars', 'host', []), analysis = new AnalysisRegistry(join(root, 'analysis'))
  try {
    while (world.observe().tick < 12) world.advance()
    const report = buildEarlyStopReport({ engine, context, analysis, world, stopAtTick: 1200 })
    expect(report).toMatchObject({ status: 'partial', terminationReason: 'user_requested_stop', tick: 12,
      stopAtTick: 1200, worldHorizon: truth.horizon, stopTargetReached: false, score: null, normalized: null, formalRankingEligible: false })
    expect(report.progress.tasks).toHaveLength(18)
    expect(report.predictions).toEqual([])
    expect(report.costs.usage).toBeNull()
    expect(report.scientificAssessment).toBe('not_performed_for_partial_run')
    expect(earlyStopMarkdown(report)).toContain('不进入正式排名')
    expect(world.truth.horizon).toBe(truth.horizon)
  } finally { await engine.close(); world.close() }
})

it('recomputes a stopped partial run descriptively rather than invoking terminal evaluation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-offline-partial-')), directory = join(root, 'run'), fixture = truthFor(directory)
  const world = new MarsWorld(join(directory, 'device'), marsScenario(fixture.truth), initialMarsRules(), fixture.truth)
  const engine = new ExecutionEngine({ directory: join(directory, 'execution'), providers: [], pollIntervalMs: 5, providerCallTimeoutMs: 1000 })
  await engine.open(); engine.createProject('mars', null)
  while (world.observe().tick < 12) world.advance()
  writeFileSync(join(directory, 'run.json'), JSON.stringify({ runId: 'partial-unit', branchId: 'main', epoch: 1 }))
  writeFileSync(join(directory, 'manifest.public.json'), JSON.stringify({ benchmarkVersion: 'v0.5', stopAtTick: 12 }))
  await engine.close(); world.close()
  const report = await reportStopped({ directory, truthFile: fixture.path })
  expect(report).toMatchObject({ status: 'partial', terminationReason: 'user_requested_stop', tick: 12, stopAtTick: 12, score: null, formalRankingEligible: false })
  expect(report).not.toHaveProperty('validation')
})

it('keeps partial runs out of formal scores even when a stale final-score file exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-partial-index-')), partial = join(root, 'partial'), complete = join(root, 'complete')
  mkdirSync(partial); mkdirSync(complete)
  writeFileSync(join(partial, 'early-stop-report.json'), JSON.stringify({ version: 'v0.5', status: 'partial', terminationReason: 'user_requested_stop', tick: 1200, worldHorizon: 2400, stopAtTick: 1200 }))
  writeFileSync(join(partial, 'final-score.json'), JSON.stringify({ S: 999, tick: 1200 }))
  writeFileSync(join(complete, 'final-score.json'), JSON.stringify({ version: 'v0.5', score: 42, maximum: 100, tick: 2400 }))
  const script = fileURLToPath(new URL('../collect-runs.py', import.meta.url)), output = join(root, 'index.json')
  execFileSync(python, [script, '--runs', root, '--output', output])
  let index = JSON.parse(readFileSync(output, 'utf8')) as { runs: unknown[]; partialRuns: { S: null; formalRankingEligible: boolean }[] }
  expect(index.runs).toHaveLength(1); expect(index.partialRuns).toEqual([])
  execFileSync(python, [script, '--runs', root, '--output', output, '--include-partial'])
  index = JSON.parse(readFileSync(output, 'utf8')) as typeof index
  expect(index.runs).toHaveLength(1); expect(index.partialRuns).toHaveLength(1)
  expect(index.partialRuns[0]).toMatchObject({ S: null, formalRankingEligible: false })
})
