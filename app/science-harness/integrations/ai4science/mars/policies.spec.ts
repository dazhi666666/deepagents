/** v0.4 scripted reference policies (docs/实验任务重设计v0.4.md, chapter 8): public inputs only, one SOP step per role per
 * decision window (one per window for the serial arm), and every answer checked one decision before it is submitted. */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { simulate } from './simulate.ts'
import { archiveFor, truthFor } from './fixture.ts'

const here = dirname(fileURLToPath(import.meta.url))
const POLICY_FILES = ['policies.ts', 'policy-water.ts', 'policy-facilities.ts', 'policy-greenhouse.ts', 'policy-brain.ts', 'policy-archive.ts']

it('reads no hidden truth: only the public load level and the public constants of truth.ts', () => {
  for (const file of POLICY_FILES) {
    const source = readFileSync(join(here, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    // `./truth.ts` imports only the public constants (chambers, crop IDs); `truth.load` is the public load level.
    expect([...source.matchAll(/\btruth\.(?!ts['"])(\w+)/g)].map(match => match[1]).filter(name => name !== 'load'), file).toEqual([])
    expect(source, file).not.toMatch(/oraclePlan|activeHypotheses|observeBase\(|\.audit\(|scoring-plan|scoring-accuracy|contaminationImpact/)
  }
})

it('decides once per window alone and once per role per window as a team, checking every answer before submitting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-policies-'))
  const { path, truth } = truthFor(join(root, 'run'))
  const { history, answers } = archiveFor(join(root, 'run'), path)
  const until = 288, perSol = 96 / 12
  const serial = await simulate(truth, join(root, 'serial'), 'ref-serial', answers, 12, { history, untilTick: until, fullTrace: true })
  const team = await simulate(truth, join(root, 'team'), 'ref-team', answers, 12, { history, untilTick: until, fullTrace: true })
  const sum = (row: number[]) => row.reduce((total, value) => total + (value ?? 0), 0)
  const sols = until / 96
  // The serial arm is one person: all roles together take at most one decision per window.
  for (let sol = 0; sol < sols; sol++) expect(Object.values(serial.decisions).reduce((total, row) => total + (row[sol] ?? 0), 0)).toBeLessThanOrEqual(perSol)
  // As a team, each role takes at most one decision per window, and together they take more than one person can.
  for (const row of Object.values(team.decisions)) for (const value of row) expect(value ?? 0).toBeLessThanOrEqual(perSol)
  expect(Object.values(team.decisions).reduce((total, row) => total + sum(row), 0)).toBeGreaterThan(Object.values(serial.decisions).reduce((total, row) => total + sum(row), 0))
  // A submission needs a check in an earlier decision, so nothing is accepted in the first window.
  for (const result of [serial, team]) {
    const accepted = (result.progress as string[]).map(line => /^t(\d+) \w+ accepted$/.exec(line)).filter(match => match !== null).map(match => Number(match![1]))
    expect(accepted.length).toBeGreaterThan(0)
    expect(Math.min(...accepted)).toBeGreaterThanOrEqual(12)
  }
}, 300000)
