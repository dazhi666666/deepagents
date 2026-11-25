/** Generated public history supports bounded retrieval, read-only SQL and integrity checks; answers come from the same data. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, chmodSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarsArchive } from './archive.ts'
import { archiveFor, truthFor } from './fixture.ts'
import { archiveAnswersSchema } from './truth.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('queries history, answers questions reproducibly from SQL and detects corruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-archive-')); roots.push(root)
  const run = join(root, 'run'), { path } = truthFor(run, 1, 'L1')
  const { history, answers } = archiveFor(run, path)
  const archive = new MarsArchive(history)
  try {
    const page = archive.query({ kind: 'sensors', entityId: 'filter', limit: 3 })
    expect(page.items).toHaveLength(3)
    expect(page.queryId).toMatch(/^q-\d{4}$/)
    expect(archive.search('积分').items.length).toBeGreaterThan(0)
    expect(() => archive.sql('DELETE FROM sensors')).toThrow()
    const expected = archiveAnswersSchema.parse(JSON.parse(readFileSync(answers, 'utf8')))
    const q8 = archive.sql(`WITH latest AS (SELECT id, root_cause, MAX(revision) r FROM incidents WHERE kind='water-contamination' GROUP BY id)
      SELECT AVG(root_cause='seal') AS share FROM latest`).rows[0] as { share: number }
    expect(q8.share).toBeCloseTo(expected.Q8, 3)
    archive.close()
    chmodSync(join(history, 'history.sqlite'), 0o600)
    appendFileSync(join(history, 'history.sqlite'), 'corrupted')
    expect(() => new MarsArchive(history)).toThrow('integrity')
  } finally { archive.close() }
}, 120000)
