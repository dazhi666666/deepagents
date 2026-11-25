#!/usr/bin/env node
/** Preserve the old runtime before starting afresh. Credentials are copied as bytes, never parsed. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function checkRuntime(data) {
  if (!existsSync(data)) throw new Error('No data directory to reset')
  if (!existsSync(join(data, 'mars', 'truth.json'))) throw new Error('Mars truth is missing; the existing data directory has not been moved')
  const homes = ['mars', 'mars-multi', 'mars-single', 'mars-multi-8', 'mars-single-8',
    'mars-multi-8-r2', 'mars-single-8-r2', 'mars-multi-8-r3', 'mars-single-8-r3', 'mars-multi-8-r4', 'mars-single-8-r4']
  for (const home of homes) {
    const file = join(data, home, 'mars-server.pid')
    if (!existsSync(file)) continue
    const pid = Number(readFileSync(file, 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid PID file for ${home}; inspect it before resetting`)
    try { process.kill(pid, 0) }
    catch (error) { if (error.code === 'ESRCH') continue; throw error }
    throw new Error(`Mars sidecar is still running for ${home}; quit DeepWorks first`)
  }
  return { data, ready: true, kept: ['secrets.json', 'mars/truth.json'].filter(file => existsSync(join(data, file))) }
}

export function resetRuntime(data) {
  const checked = checkRuntime(data)
  const staging = mkdtempSync(`${data}.reset-staging-`)
  mkdirSync(join(staging, 'mars'), { recursive: true })
  for (const file of checked.kept) cpSync(join(data, file), join(staging, file))
  const backup = `${data}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSync(data, backup)
  try { renameSync(staging, data) }
  catch (error) {
    if (!existsSync(data)) renameSync(backup, data)
    throw error
  }
  return { reset: true, backup, kept: checked.kept }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const data = join(root, 'data')
  console.log(JSON.stringify(process.argv.includes('--check') ? checkRuntime(data) : resetRuntime(data), null, 2))
}
