#!/usr/bin/env node
/** Read-only check of a prepared, unused pair. Credentials are never parsed and clocks never advance. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openMarsHistory } from '../app/mars-host/history.mjs'
import { assertMarsRoster, marsRoster } from '../app/science/mars-roster.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = join(root, 'app', 'workspace')
const config = JSON.parse(readFileSync(join(workspace, 'science.json'), 'utf8'))
const opencode = JSON.parse(readFileSync(join(workspace, 'opencode.json'), 'utf8'))
const issues = []
if (Number(process.versions.node.split('.')[0]) < 24) issues.push('Node 24+ required')
if (!config.mars?.enabled || !config.mars?.dual) issues.push('Dual Mars worlds must be enabled')
if (opencode.default_agent !== (config.mars.agent ?? 'mars')) issues.push('The workspace default agent must be mars')
if (config.mars?.modelBarrier !== true) issues.push('Global model barrier must be enabled')
if (config.mars?.schedulingProtocol !== 'mars-v06-native-steps/1') issues.push('The configured scheduling protocol is not the native-step protocol')
if (config.mars?.dashboard !== false) issues.push('Dashboard should remain disabled for this run')
if (!/^[a-f0-9]{64}$/i.test(config.mars?.salt ?? '')) issues.push('Invalid paired salt')
const jointTrial = config.mars.jointTrial ?? config.mars.stageProfile?.jointTrial ?? null
if (jointTrial !== null && !['paired-growth-v1','pilot-choice-v2','shared-plan-v3'].includes(jointTrial)) issues.push('Unknown T6 joint trial version')
const workflow = config.mars.researchWorkflow ?? config.mars.stageProfile?.researchWorkflow ?? null
if (workflow !== null && !['reviewed-v1','delivery-v2'].includes(workflow)) issues.push('Unknown research workflow')
const teamSize = config.mars.teamSize ?? 6
const teamRoles = marsRoster('multi', teamSize)
const multi = resolve(workspace, process.env.SCIENCE_MARS_HOME || config.mars.home || '../../data/mars-multi')
const single = resolve(workspace, process.env.SCIENCE_MARS_SINGLE_HOME || config.mars.singleHome || '../../data/mars-single')
if (multi === single) issues.push('Single/Multi homes must differ')
for (const file of [config.mars.server, config.mars.truth, '.opencode/plugin/science.js', '.opencode/agents/mars.md'])
  if (!existsSync(resolve(workspace, file))) issues.push(`Missing required file: ${file}`)
if (config.llmProxy?.enabled !== true || config.llmProxy?.ips?.length !== 3) issues.push('Three-node session gateway is not configured')
const model = opencode.provider?.dspark?.models?.['dsv4f-native']
if (model?.limit?.context !== 131072 || model?.limit?.output !== 30000) issues.push('Unexpected model context/output limits')
const keyPresent = Boolean(process.env.SCIENCE_API_KEY) || existsSync(resolve(workspace, config.llmProxy.keyFile))
if (!keyPresent) issues.push('No local key file or API key environment variable')
const worlds = []
let fresh = true
for (const [mode, home] of [['multi', multi], ['single', single]]) {
  let tick = 0, participants = 0
  const roles = marsRoster(mode, teamSize)
  const manifestFile = join(home, 'manifest.public.json')
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    try { assertMarsRoster(manifest, mode, roles) }
    catch (error) { issues.push(`${mode}: ${error.message}`) }
    if ((manifest.stages?.researchWorkflow ?? null) !== workflow) issues.push(`${mode}: research workflow differs from configuration`)
    if ((manifest.stages?.jointTrial ?? null) !== jointTrial) issues.push(`${mode}: T6 trial version differs from configuration`)
    if (manifest.schedulingProtocol !== config.mars.schedulingProtocol)
      issues.push(`${mode} uses another scheduling protocol; start a fresh dataset`)
  }
  const deviceFile = join(home, 'device/laboratory.sqlite')
  if (existsSync(deviceFile)) {
    const db = new DatabaseSync(deviceFile, { readOnly: true })
    try {
      const state = JSON.parse(db.prepare('SELECT state FROM world WHERE id=1').get().state)
      tick = state.tick
      if (tick !== 0 || state.operations.length > 0) fresh = false
    } finally { db.close() }
  }
  const executionFile = join(home, 'execution/execution.sqlite')
  if (existsSync(executionFile)) {
    const db = new DatabaseSync(executionFile, { readOnly: true })
    try {
      participants = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='fact' AND json_extract(data_json,'$.kind')='mars-organization'").get().n
      if (participants > 0) fresh = false
    } finally { db.close() }
  }
  let history = null
  try {
    const opened = openMarsHistory(home, { verifyCounts: true })
    history = { sha256: opened.manifest.sha256, bytes: opened.manifest.bytes, counts: opened.manifest.counts, effectiveTruthHash: opened.installation.effectiveTruthHash }
    opened.archive.close()
  } catch (error) { issues.push(`${mode} history is not ready: ${error.message}; run node demo/mars-prepare.mjs`) }
  worlds.push({ mode, roles, tick, participants, history })
  const pidFile = join(home, 'mars-server.pid')
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    try { process.kill(pid, 0); issues.push('A Mars sidecar is already running; run this check before opening DeepWorks') }
    catch (error) { if (error.code !== 'ESRCH') issues.push('Could not verify a sidecar PID') }
  }
}
const pairHistoryMatched = worlds.every(world => world.history) && worlds[0].history.sha256 === worlds[1].history.sha256
  && worlds[0].history.effectiveTruthHash === worlds[1].history.effectiveTruthHash
if (!pairHistoryMatched) issues.push('Paired historical archives are missing or differ')
if (!fresh) issues.push('The pair has already been used; preserve/reset it before a fresh experiment')
console.log(JSON.stringify({ ready: issues.length === 0, fresh, pairHistoryMatched, keyPresent, worlds,
  jointTrial, researchWorkflow: workflow, defaultAgent: opencode.default_agent, schedulingProtocol: config.mars.schedulingProtocol, sessions: teamRoles.length + 1,
  teamRoles, gatewayNodes: config.llmProxy.ips.length, model: opencode.model,
  contextTokens: model?.limit.context, outputTokens: model?.limit.output, modelBarrier: config.mars.modelBarrier,
  dashboard: config.mars.dashboard, issues }, null, 2))
if (issues.length) process.exitCode = 1
