#!/usr/bin/env node
/**
 * Check whether two Mars runs are a valid single/multi pair.
 *
 *   node app/mars-pair.mjs <multi-home> <single-home>
 *
 * Comparable runs must share truth, salt, stages, horizon and decision cadence; only the mode and
 * the resulting research may differ.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertMarsRoster, marsRoster } from './science/mars-roster.mjs'

const homes = process.argv.slice(2).map((value) => resolve(value))
if (homes.length !== 2) {
  console.log('Usage: node app/mars-pair.mjs <run-home-a> <run-home-b>')
  process.exit(1)
}
const read = (home) => {
  const path = join(home, 'manifest.public.json')
  if (!existsSync(path)) throw new Error(`Missing manifest: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}
const [a, b] = homes.map(read)
const keys = ['benchmarkVersion', 'truthHash', 'saltHash', 'horizon', 'decisionTicks', 'stages', 'scenarioHash', 'caseManifestHash', 'protocolHash', 'historyHash', 'historyManifestHash', 'model', 'modelSource', 'schedulingProtocol']
const differences = keys.filter((key) => a[key] === undefined || b[key] === undefined || JSON.stringify(a[key]) !== JSON.stringify(b[key]))
const normalizeMode = mode => mode === 'multi-agent' ? 'multi' : mode === 'single-agent' ? 'single' : mode
const modes = [normalizeMode(a.mode), normalizeMode(b.mode)].sort()
function roleList(manifest, side) {
  const mode = normalizeMode(manifest.mode)
  try {
    const roles = marsRoster(mode, manifest.roles?.length === 8 ? 8 : 6)
    assertMarsRoster(manifest, mode, roles)
    return roles
  } catch {
    differences.push(`${side}.roles`)
    return null
  }
}
const roles = { a: roleList(a, 'a'), b: roleList(b, 'b') }
const comparable = differences.length === 0 && modes[0] === 'multi' && modes[1] === 'single'
console.log(JSON.stringify({ comparable, modes: { a: a.mode, b: b.mode }, roles, differences,
  a: { truthHash: a.truthHash, saltHash: a.saltHash, horizon: a.horizon },
  b: { truthHash: b.truthHash, saltHash: b.saltHash, horizon: b.horizon } }, null, 2))
process.exit(comparable ? 0 : 1)
