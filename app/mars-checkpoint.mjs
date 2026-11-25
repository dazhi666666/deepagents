#!/usr/bin/env node
/**
 * Mars checkpoint list / restore.
 *
 * Snapshots are created from inside the run with the mars_checkpoint tool (or the sidecar RPC).
 * Restore requires the Mars sidecar to be stopped and refuses when a published phase seal is newer
 * than the checkpoint, so a final/baseline seal can never be rolled back.
 *
 *   node app/mars-checkpoint.mjs list
 *   node app/mars-checkpoint.mjs restore <checkpoint-id>
 */
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const home = resolve(arg('home', join(here, '..', 'data', 'mars-multi')))
const checkpointRoot = join(dirname(home), 'checkpoints')
const ledgerPath = `${home}.phases.jsonl`
const restoreLog = join(dirname(home), 'mars-restore.log')
const command = argv[0]

function list() {
  if (!existsSync(checkpointRoot)) return []
  return readdirSync(checkpointRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return JSON.parse(readFileSync(join(checkpointRoot, entry.name, 'checkpoint.json'), 'utf8'))
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
}

function latestSeal() {
  if (!existsSync(ledgerPath)) return null
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
  return lines.length ? JSON.parse(lines.at(-1)) : null
}

function pidAlive() {
  const path = join(home, 'mars-server.pid')
  if (!existsSync(path)) return false
  const pid = Number(readFileSync(path, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

if (command === 'list') {
  const items = list()
  if (!items.length) console.log('No checkpoints.')
  for (const item of items) console.log(`${item.id}  tick=${item.tick}  seal=${item.latestStage ?? 'none'}`)
  process.exit(0)
}

if (command === 'restore') {
  const id = argv[1]
  if (!id) throw new Error('Usage: node app/mars-checkpoint.mjs restore <checkpoint-id>')
  if (pidAlive()) throw new Error('Mars sidecar is still running; quit DeepWorks or stop the sidecar before restoring')
  const source = join(checkpointRoot, id)
  if (!existsSync(join(source, 'checkpoint.json'))) throw new Error(`Unknown checkpoint: ${id}`)
  const meta = JSON.parse(readFileSync(join(source, 'checkpoint.json'), 'utf8'))
  if (meta.home && resolve(meta.home) !== home) throw new Error(`Checkpoint belongs to another run: ${meta.home}`)
  const current = latestSeal()
  if ((current?.hash ?? null) !== (meta.latestSeal ?? null))
    throw new Error(
      `Refusing restore: published phase seal differs (checkpoint ${meta.latestStage ?? 'none'}, current ${current?.stage ?? 'none'})`,
    )
  const displaced = `${home}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`
  if (existsSync(home)) renameSync(home, displaced)
  cpSync(source, home, { recursive: true, filter: (path) => !path.endsWith('checkpoint.json') })
  appendFileSync(restoreLog, `${JSON.stringify({ kind: 'restore', id, at: Date.now(), displaced })}\n`)
  console.log(`Restored ${id} (tick ${meta.tick}) into ${home}`)
  console.log(`Previous run kept at ${displaced}`)
  process.exit(0)
}

console.log('Usage: node app/mars-checkpoint.mjs list | restore <id> [--home <dir>]')
process.exit(1)
