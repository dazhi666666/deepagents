#!/usr/bin/env node
/** Prepare both immutable historical archives before opening DeepWorks. No model, clock or participant starts. */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertMarsRoster, marsRoster } from '../app/science/mars-roster.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = join(root, 'app', 'workspace')
const argv = process.argv.slice(2)
const index = argv.indexOf('--config')
const configFile = index === -1 ? join(workspace, 'science.json') : resolve(argv[index + 1])
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const mars = config.mars
if (!mars?.enabled) throw new Error('Mars is not enabled in the selected science configuration')
const teamSize = mars.teamSize ?? 6
const homes = [{ home: resolve(workspace, process.env.SCIENCE_MARS_HOME || mars.home || '../../data/mars-multi'), mode: mars.dual ? 'multi' : mars.mode ?? 'multi' }]
if (mars.dual) homes.push({ home: resolve(workspace, process.env.SCIENCE_MARS_SINGLE_HOME || mars.singleHome || '../../data/mars-single'), mode: 'single' })
if (new Set(homes.map(world => world.home)).size !== homes.length) throw new Error('Mars Multi and Single homes must differ')
for (const { home, mode } of homes) {
  const roles = marsRoster(mode, teamSize)
  const manifestFile = join(home, 'manifest.public.json')
  if (existsSync(manifestFile)) assertMarsRoster(JSON.parse(readFileSync(manifestFile, 'utf8')), mode, roles)
  const file = join(home, 'mars-server.pid')
  if (!existsSync(file)) continue
  const pid = Number(readFileSync(file, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid Mars PID file')
  try { process.kill(pid, 0) }
  catch (error) { if (error.code === 'ESRCH') continue; throw error }
  throw new Error('Quit DeepWorks before preparing a new pair')
}
const results = []
for (const { home, mode } of homes) {
  const prepared = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', resolve(workspace, mars.server ?? '../mars-server.mjs'),
      '--home', home, '--mode', mode, '--team-size', String(teamSize), '--truth', resolve(workspace, mars.truth || '../../data/mars/truth.json'),
      '--salt', mars.salt, '--model-source', mars.modelSource ?? 'real-model',
      ...(mars.jointTrial ? ['--joint-trial', mars.jointTrial] : []),
      ...(mars.researchWorkflow ? ['--research-workflow', mars.researchWorkflow] : []),
      ...(mars.stageProfile ? ['--stage-profile', JSON.stringify(mars.stageProfile)] : []), '--prepare-only'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-3000) })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`Mars ${mode} preparation failed (${code}): ${stderr.trim()}`))
      try { resolvePromise(JSON.parse(stdout.trim())) } catch (error) { reject(error) }
    })
  })
  results.push(prepared)
  console.log(JSON.stringify(prepared))
}
if (new Set(results.map(result => result.historyHash)).size !== 1) throw new Error('Paired historical archives differ')
console.log(JSON.stringify({ ready: true, pairHistoryMatched: true, modelCalls: 0,
  worlds: results.map(({ mode, roles, historyHash, counts }) => ({ mode, roles, historyHash, counts })) }))
