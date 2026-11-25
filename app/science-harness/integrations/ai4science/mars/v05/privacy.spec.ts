import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { MarsArchive } from '../archive.ts'

it('redacts the evaluator seed from a verified public archive without altering its integrity hash', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mars-v05-public-history-'))
  const file = join(directory, 'history.sqlite'), database = new DatabaseSync(file)
  database.exec('CREATE TABLE historical_observations(value REAL); INSERT INTO historical_observations VALUES(1.2)'); database.close()
  const bytes = readFileSync(file), sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 2, source: 'simulated-history', seed: 49871, sha256, bytes: bytes.length, counts: {} }))
  const modern = new MarsArchive(directory, true), legacy = new MarsArchive(directory)
  try {
    expect(modern.manifest).toMatchObject({ seed: 0, sha256 })
    expect(legacy.manifest?.seed).toBe(49871)
    expect(JSON.stringify(modern.manifest)).not.toContain('49871')
  } finally { modern.close(); legacy.close() }
})
