import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Checkpoints } from '../checkpoints.ts'
import { contentHash } from './contracts.ts'
import { PhaseLedger } from './phase-ledger.ts'
import { V06Budget } from './budget.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it('rejects an older phase before replacing files, preserves money and permits a matching sealed checkpoint', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'mars-phase-restore-')); roots.push(temp)
  const root = join(temp, 'run'); mkdirSync(join(root, 'execution'), { recursive: true })
  const runId = randomUUID(), protocolHash = contentHash('protocol')
  const phases = new PhaseLedger(`${root}.phase-seals.jsonl`, runId, protocolHash)
  const checkpoints = new Checkpoints(root, `${root}.checkpoints`, { restoreGuard: manifest => phases.assertCheckpoint(manifest.tick, manifest.metadata) })
  writeFileSync(join(root, 'state.txt'), 'before')
  const earlier = await checkpoints.save(0, 0, { runId, protocolHash, phaseSeals: [] })
  const body = { stage: 'baseline' as const, tick: 3, protocolHash, previousSealHash: null,
    worldHash: contentHash('world'), worldCursor: 1, ledgerCursor: 1, selections: [], missing: [] }
  const seal = { ...body, hash: contentHash(body) }
  phases.synchronize(3, [seal])
  const price = { limitUsd: 0.001, prices: [{ provider: 'fixture', model: 'mock', inputPerMillion: 1, cacheReadPerMillion: 0,
    cacheWritePerMillion: 1, outputPerMillion: 1, maxInputTokens: 10, maxOutputTokens: 5, verified: true, singleAttempt: true as const }] }
  const money = new V06Budget(`${root}.budget.sqlite`, price)
  try {
    money.reserve('paid', 'root', 'fixture', 'mock', 5); money.dispatched('paid'); money.settle('paid', { inputTokens: 10, outputTokens: 0 })
    writeFileSync(join(root, 'state.txt'), 'sealed')
    const matching = await checkpoints.save(3, 3, { runId, protocolHash, phaseSeals: [{ tick: 3, hash: seal.hash }] })
    writeFileSync(join(root, 'state.txt'), 'later')
    await expect(checkpoints.restoreStopped(earlier.id)).rejects.toThrow('published phase')
    expect(readFileSync(join(root, 'state.txt'), 'utf8')).toBe('later')
    await checkpoints.restoreStopped(matching.id)
    expect(readFileSync(join(root, 'state.txt'), 'utf8')).toBe('sealed')
    expect(money.report().actualUsd).toBeCloseTo(0.00001)
    expect(phases.published()).toHaveLength(1)
  } finally { money.close() }
}, 60000)
it('refuses replayed hashes, a changed protocol and read-only publication of a missing seal', () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-phase-integrity-')); roots.push(root)
  const path = join(root, 'phases.jsonl'), runId = randomUUID(), protocolHash = contentHash('one')
  const phases = new PhaseLedger(path, runId, protocolHash)
  const body = { stage: 'baseline' as const, tick: 3, protocolHash, previousSealHash: null, worldHash: contentHash('world'), worldCursor: 1, ledgerCursor: 1, selections: [], missing: [] }
  const seal = { ...body, hash: contentHash(body) }
  expect(() => new PhaseLedger(path, runId, protocolHash, true).synchronize(3, [seal])).toThrow('unpublished')
  phases.synchronize(3, [seal]); phases.synchronize(3, [seal])
  expect(phases.published()).toHaveLength(1)
  expect(() => new PhaseLedger(path, runId, contentHash('two')).published()).toThrow('different')
  expect(() => phases.synchronize(0, [])).toThrow('reopen')
})
