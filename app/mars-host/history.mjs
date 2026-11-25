/** Install the original immutable Mars history before accepting any participant or world action. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { MarsArchive } from '../science-harness/integrations/ai4science/mars/archive.ts'

const generator = fileURLToPath(new URL('../science-harness/integrations/ai4science/mars/make-data.py', import.meta.url))
const tables = ['sensors', 'corrections', 'maintenance', 'experiments', 'documents', 'lots', 'lot_qc', 'reference_checks', 'incidents', 'chromatograms']
const digest = value => createHash('sha256').update(value).digest('hex')
const identityFile = home => `${home}.evaluator/history-installation.json`

/** Verify public bytes, schema, counts and the source/generator identity; never repair a published archive. */
export function openMarsHistory(home, expected = {}) {
  const directory = join(home, 'public', 'history')
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.seed !== 0) throw new Error('Public historical manifest must redact the evaluator seed')
  const installation = JSON.parse(readFileSync(identityFile(home), 'utf8'))
  if (installation.version !== 1 || installation.generatorHash !== digest(readFileSync(generator)))
    throw new Error('Historical archive generator differs from the installed run')
  if (expected.effectiveTruthHash && installation.effectiveTruthHash !== expected.effectiveTruthHash)
    throw new Error('Historical archive was generated from another effective scientific instance')
  if (installation.archiveHash !== manifest.sha256 || installation.bytes !== manifest.bytes)
    throw new Error('Historical archive installation identity differs from its manifest')
  if (!existsSync(`${home}.evaluator/archive-answers.json`) || !existsSync(`${home}.evaluator/v06-effective-truth.json`))
    throw new Error('Historical archive private preparation files are incomplete')
  const archive = new MarsArchive(directory, true)
  try {
    if (!archive.manifest) throw new Error('Historical archive is not installed')
    const schema = archive.schema()
    for (const table of tables) {
      if (!schema[table]?.length || !Number.isSafeInteger(manifest.counts?.[table]) || manifest.counts[table] <= 0)
        throw new Error(`Historical archive table is missing or empty: ${table}`)
      if (expected.verifyCounts) {
        const count = archive.sqlAll(`SELECT COUNT(*) AS n FROM ${table}`)[0].n
        if (count !== manifest.counts[table]) throw new Error(`Historical archive row count differs: ${table}`)
      }
    }
    return { archive, manifest: archive.manifest, installation }
  } catch (error) { archive.close(); throw error }
}

function assertFreshWorld(home) {
  const path = join(home, 'device', 'laboratory.sqlite')
  if (!existsSync(path)) return
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT state FROM world WHERE id=1').get()
    const state = row ? JSON.parse(row.state) : null
    if (!state || state.tick !== 0 || state.operations.length > 0)
      throw new Error('Cannot add historical data to an existing experiment; preserve it and prepare a fresh run')
  } finally { db.close() }
}

function generateHistory(python, truthFile, directory, answers) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, ['-I', '-X', 'utf8', generator, '--directory', directory, '--truth', truthFile, '--answers', answers],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    // The original generator prints its unredacted manifest. It stays off the public logs and model outputs.
    child.stdout.resume()
    let stderr = ''
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-3000) })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Mars history generation exceeded 300 seconds')) }, 300000)
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Cannot start Mars history generator: ${error.message}`)) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`Mars history generator exited ${code}: ${stderr.trim()}`))
    })
  })
}

/** Generate from compiled truth in a fresh private staging directory, then publish an immutable public archive. */
export async function prepareMarsHistory({ home, effectiveTruth, effectiveTruthHash, python = process.env.SCIENCE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }) {
  home = resolve(home)
  const directory = join(home, 'public', 'history')
  const present = ['history.sqlite', 'manifest.json'].map(file => existsSync(join(directory, file)))
  if (present.every(Boolean)) return openMarsHistory(home, { effectiveTruthHash })
  if (present.some(Boolean)) throw new Error('Incomplete historical archive; preserve the directory and prepare a fresh run')
  assertFreshWorld(home)
  const evaluator = `${home}.evaluator`
  mkdirSync(evaluator, { recursive: true, mode: 0o700 })
  const stage = mkdtempSync(join(evaluator, 'history-build-'))
  try {
    const truthFile = join(stage, 'v06-effective-truth.json')
    const answers = join(stage, 'archive-answers.json')
    const publicHistory = join(stage, 'public')
    writeFileSync(truthFile, JSON.stringify(effectiveTruth, null, 2) + '\n', { mode: 0o600 })
    await generateHistory(python, truthFile, publicHistory, answers)
    const manifest = JSON.parse(readFileSync(join(publicHistory, 'manifest.json'), 'utf8'))
    manifest.seed = 0
    writeFileSync(join(publicHistory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    const installation = { version: 1, effectiveTruthHash, generatorHash: digest(readFileSync(generator)),
      archiveHash: manifest.sha256, bytes: manifest.bytes }
    // All sensitive outputs are outside public/. A missing commit after interruption fails verification on restart.
    for (const [source, destination] of [[truthFile, join(evaluator, 'v06-effective-truth.json')], [answers, join(evaluator, 'archive-answers.json')]]) {
      if (existsSync(destination)) {
        if (!readFileSync(source).equals(readFileSync(destination))) throw new Error('Existing private history preparation differs')
      } else renameSync(source, destination)
    }
    const record = identityFile(home)
    if (existsSync(record) && JSON.stringify(JSON.parse(readFileSync(record, 'utf8'))) !== JSON.stringify(installation))
      throw new Error('Existing history installation differs')
    writeFileSync(record, JSON.stringify(installation, null, 2) + '\n', { mode: 0o600 })
    mkdirSync(join(home, 'public'), { recursive: true })
    renameSync(publicHistory, directory)
    return openMarsHistory(home, { effectiveTruthHash, verifyCounts: true })
  } finally { rmSync(stage, { recursive: true, force: true }) }
}
