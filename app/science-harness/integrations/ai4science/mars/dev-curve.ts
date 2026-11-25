/** Development runner for the chapter-8 sensitivity curve: both reference arms at every decision cadence, every point in its
 * own process at the same time (each is single-threaded, so a machine with enough cores runs the curve in the time of its
 * slowest point). Writes `<out>/<policy>-<dt>.json` per point and `<out>/curve.json` with the table and the four checks.
 * Usage: tsx dev-curve.ts <truth.json> <history-dir> <out-dir> [ticks...]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [truthFile, history, out, ...rest] = process.argv.slice(2)
if (!truthFile || !history || !out) throw new Error('Usage: tsx dev-curve.ts <truth.json> <history-dir> <out-dir> [ticks...]')
const ticks = (rest.length ? rest : ['2', '4', '8', '12']).map(Number).sort((a, b) => a - b)
const runner = join(dirname(fileURLToPath(import.meta.url)), 'dev-run.ts')
mkdirSync(out, { recursive: true })

/** One curve point as a child process running dev-run.ts under the same TypeScript loader as this script. */
function point(policy: string, decisionTicks: number) {
  const output = join(out!, `${policy}-${decisionTicks}.json`)
  return new Promise<{ S: number; seconds: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, runner, truthFile!, history!, policy, String(decisionTicks), output], { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', chunk => { error += String(chunk) })
    child.on('exit', code => {
      if (code !== 0) { reject(new Error(`${policy} dt=${decisionTicks} exited ${code}: ${error.slice(-2000)}`)); return }
      const result = JSON.parse(readFileSync(output, 'utf8')) as { S: number; seconds: number }
      console.log(`${policy} dt=${decisionTicks} S=${result.S.toFixed(2)} (${result.seconds.toFixed(0)} s)`)
      resolve(result)
    })
  })
}

const jobs = ticks.flatMap(decisionTicks => ['ref-team', 'ref-serial'].map(policy => ({ policy, decisionTicks, run: point(policy, decisionTicks) })))
const rows = await Promise.all(jobs.map(async job => ({ policy: job.policy, decisionTicks: job.decisionTicks, S: Number((await job.run).S.toFixed(2)) })))
const curve = ticks.map(decisionTicks => {
  const team = rows.find(row => row.policy === 'ref-team' && row.decisionTicks === decisionTicks)!.S
  const serial = rows.find(row => row.policy === 'ref-serial' && row.decisionTicks === decisionTicks)!.S
  return { decisionTicks, team, serial, gap: Number((team - serial).toFixed(2)) }
})
const at = (decisionTicks: number) => curve.find(row => row.decisionTicks === decisionTicks)
// The four checks of chapter 8, where the curve includes the cadences they name.
const checks = {
  teamAtLeast60AtDt12: at(12) ? at(12)!.team >= 60 : null,
  gapAtLeast25AtDt12: at(12) ? at(12)!.gap >= 25 : null,
  gapAtMost8AtDt2: at(2) ? Math.abs(at(2)!.gap) <= 8 : null,
  gapNonDecreasingInDt: curve.every((row, index) => index === 0 || row.gap >= curve[index - 1]!.gap),
}
writeFileSync(join(out, 'curve.json'), JSON.stringify({ curve, checks }, null, 2))
for (const row of curve) console.log(`dt=${row.decisionTicks} team=${row.team} serial=${row.serial} gap=${row.gap}`)
console.log(JSON.stringify(checks))
