/** Development runner: simulate one scripted policy over a truth file and dump the full trace.
 * Usage: tsx dev-run.ts <truth.json> <history-dir> <null|ref-serial|ref-team> <decisionTicks> <output.json> [untilTick]
 * Each run gets a fresh world directory under runs/dev-sim, so a rerun never resumes an earlier run's devices or journal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTruth } from './truth.ts'
import { simulate, type Policy } from './simulate.ts'

const [truth, history, policy = 'ref-team', decision = '12', output, until] = process.argv.slice(2)
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../runs/dev-sim')
mkdirSync(root, { recursive: true })
const directory = mkdtempSync(join(root, `${policy}-dt${decision}-`))
// The evaluator's archive answers sit beside the history they were derived from, as in a real run.
const result = await simulate(loadTruth(truth!), directory, policy as Policy, join(dirname(truth!), 'archive-answers.json'),
  Number(decision), { ...(history ? { history } : {}), fullTrace: true, ...(until ? { untilTick: Number(until) } : {}) })
rmSync(directory, { recursive: true, force: true })
if (output) writeFileSync(output, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ policy: result.policy, dt: result.decisionTicks, S: Number(result.S.toFixed(2)), O: Number(result.O.toFixed(1)),
  D: Number(result.D.toFixed(1)), C: Number(result.C.toFixed(1)), R: Number(result.R.toFixed(1)), X: Number(result.X.toFixed(1)),
  Q: Number(result.Q.toFixed(2)), sec: Number(result.seconds.toFixed(0)) }))
