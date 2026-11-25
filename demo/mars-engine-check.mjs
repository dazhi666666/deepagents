#!/usr/bin/env node
/** List agents in the installed engine, with isolated data and model gateway disabled. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const executable = process.argv[2]
if (!executable) throw new Error('Pass the installed opencode executable path')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = join(root, 'demo', '.checks')
mkdirSync(checks, { recursive: true })
const fixture = mkdtempSync(join(checks, 'engine-'))
const config = join(fixture, 'science.json')
writeFileSync(config, JSON.stringify({ home: join(fixture, 'runtime'), llmProxy: { enabled: false }, mars: { enabled: false } }))
const run = args => {
  const result = spawnSync(executable, args, { cwd: join(root, 'app', 'workspace'),
    env: { ...process.env, SCIENCE_CONFIG: config, SCIENCE_HOME: join(fixture, 'runtime') }, encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return result.stdout
}
const agents = run(['agent', 'list'])
assert.match(agents, /^mars \(primary\)/m)
const resolved = JSON.parse(run(['debug', 'config']))
assert.equal(resolved.default_agent, 'mars', 'New conversations must use Mars without UI selection')
const names = agents.split('\n').map(line => line.trim()).filter(line => /^[\w-]+ \((primary|subagent|all)\)/.test(line))
console.log(JSON.stringify({ passed: true, defaultAgent: resolved.default_agent, engineAgents: names, modelCalls: 0 }))
