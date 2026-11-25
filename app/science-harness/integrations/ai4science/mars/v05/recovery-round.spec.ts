import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { NativeRounds } from './native-rounds.ts'
import { snapshotMayCommitRound, resumeSlotsSettled } from './recovery-round.ts'

it('distinguishes a mounting team from the normal common decision boundary', () => {
  expect(snapshotMayCommitRound({ v05: true, teamReady: false, infrastructureFailed: false })).toBe(false)
  expect(snapshotMayCommitRound({ v05: true, teamReady: true, infrastructureFailed: true })).toBe(false)
  expect(snapshotMayCommitRound({ v05: true, teamReady: true, infrastructureFailed: false })).toBe(true)
  expect(snapshotMayCommitRound({ v05: false, teamReady: false, infrastructureFailed: false })).toBe(true)
})

it('does not mistake a still-held resumed actor for a completed current-round slot', () => {
  const incomplete = new Set(['water'])
  // The forced startup snapshot is allowed to save, but the separate commit guard keeps the round open.
  expect(resumeSlotsSettled({ v05: true, teamReady: false, incomplete })).toBe(true)
  expect(snapshotMayCommitRound({ v05: true, teamReady: false, infrastructureFailed: false })).toBe(false)
  // Five actors can reach their next boundaries while water is still waking from the mounting gate.
  expect(resumeSlotsSettled({ v05: true, teamReady: true, incomplete })).toBe(false)
  // Only actual stepped.set(water,currentTick) releases the inherited slot.
  incomplete.delete('water')
  expect(resumeSlotsSettled({ v05: true, teamReady: true, incomplete })).toBe(true)
  expect(resumeSlotsSettled({ v05: false, teamReady: true, incomplete: new Set(['legacy']) })).toBe(true)
})

it('keeps a resumed partial round open during the startup snapshot and commits both actors once at the real boundary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mars-startup-round-'))
  const open = async () => {
    const engine = new ExecutionEngine({ directory, providers: [], pollIntervalMs: 5, providerCallTimeoutMs: 1000 })
    await engine.open(); engine.createProject('mars', null)
    const context = engine.issueContext('mars', 'round-host', [])
    return { engine, rounds: new NativeRounds(engine, context, () => 864, 12, () => ['completed', 'unresolved'], () => ({ tick: 864 })) }
  }
  const original = await open()
  original.rounds.queue('completed', 'completed-call', 'research_write', { id: 'already-decided' })
  await original.engine.close()
  const resumed = await open(), applied: string[] = []
  try {
    const apply = async (actorId: string) => { applied.push(actorId); return { accepted: true } }
    if (snapshotMayCommitRound({ v05: true, teamReady: false, infrastructureFailed: false })) await resumed.rounds.commit(apply)
    expect(resumed.rounds.currentCommitted()).toBe(false)
    expect(applied).toEqual([])
    expect(() => resumed.rounds.queue('unresolved', 'resumed-call', 'research_write', { id: 'newly-decided' })).not.toThrow()
    if (snapshotMayCommitRound({ v05: true, teamReady: true, infrastructureFailed: false })) await resumed.rounds.commit(apply)
    expect(resumed.rounds.currentCommitted()).toBe(true)
    expect(applied.sort()).toEqual(['completed', 'unresolved'])
    await resumed.rounds.commit(apply)
    expect(applied).toHaveLength(2)
    expect(resumed.rounds.receipts('completed')).toHaveLength(1)
    expect(resumed.rounds.receipts('unresolved')).toHaveLength(1)
  } finally { await resumed.engine.close() }
})
