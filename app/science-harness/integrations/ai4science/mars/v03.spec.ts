/** v0.3 task mechanics: duty slots, block weights, short refs, duty slot scoring and independent replication. */
import { expect, it } from 'vitest'
import { dutySchedule, dutySlot, dutySlots, dutyWindow, nextDutyWindow, TASKS, type TaskId } from './deliverables.ts'
import { taskWeights, createMission } from './mission.ts'
import { Refs } from './refs.ts'
import { dutySlotScore } from './scoring-accuracy.ts'
import { minimumEvidence } from './scoring-progress.ts'
import { independentCheck } from './scoring-input.ts'
import type { AnalysisRegistry } from './analysis.ts'
import { CROP_IDS } from './truth.ts'

it('gives every tick below the horizon exactly one D3 window, forecast half a sol ahead', () => {
  expect([0, 47, 48, 95, 96, 143, 144, 2399].map(tick => dutySlot('D3', 'L2', tick, 2400))).toEqual([0, 0, 1, 1, 1, 1, 2, 24])
  expect(dutySlots('D3', 'L2', 2400)).toBe(25)
  expect(dutySlot('D3', 'L2', 2400, 2400)).toBeNull()
  expect(dutySlot('D3', 'L2', -1, 2400)).toBeNull()
  // Windows tile the horizon: each opens where the previous one is half over, the last runs to the horizon.
  const windows = Array.from({ length: 25 }, (_, slot) => dutyWindow('D3', 'L2', slot, 2400))
  expect(windows[0]).toEqual([0, 48])
  expect(windows[1]).toEqual([48, 144])
  expect(windows[3]).toEqual([240, 336])
  expect(windows[24]).toEqual([2256, 2400])
  expect(windows.every(([from], index) => index === 0 || from === windows[index - 1]![1])).toBe(true)
})

it('keeps D1 and D2 on contiguous periods of their own length', () => {
  expect([0, 95, 96, 2399].map(tick => dutySlot('D1', 'L2', tick, 2400))).toEqual([0, 0, 1, 24])
  expect(dutySlots('D1', 'L2', 2400)).toBe(25)
  expect([0, 47, 48].map(tick => dutySlot('D2', 'L3', tick, 2400))).toEqual([0, 0, 1])
  expect(dutySlots('D2', 'L4', 2400)).toBe(50)
  expect(dutyWindow('D2', 'L4', 49, 2400)).toEqual([2352, 2400])
})

it('publishes every duty window with its bounds and names the window that still accepts a submission', () => {
  expect(dutyWindow('D1', 'L2', 3, 2400)).toEqual([288, 384])
  const schedule = dutySchedule('D3', 'L2', 2400, 270)
  expect(schedule).toHaveLength(25)
  expect(schedule[3]).toEqual({ slot: 3, from: 240, to: 336, open: true, closed: false })
  expect(schedule[1]!.closed).toBe(true)
  // Both duties accept a submission at every tick below the horizon, so a rejected one has a window to point at.
  for (const tick of [0, 40, 100, 1199, 2399]) {
    expect(nextDutyWindow('D3', 'L2', 2400, tick)).not.toBeNull()
    expect(nextDutyWindow('D1', 'L2', 2400, tick)).toEqual({ slot: Math.floor(tick / 96), from: Math.floor(tick / 96) * 96, to: Math.floor(tick / 96) * 96 + 96 })
  }
  expect(nextDutyWindow('D3', 'L2', 2400, 2400)).toBeNull()
  expect(nextDutyWindow('D1', 'L2', 2400, 3000)).toBeNull()
})

it('keeps every block total at each load level', () => {
  for (const load of ['L1', 'L2', 'L4']) {
    const weights = taskWeights(load), sum = (block: string) => Object.entries(weights).filter(([id]) => TASKS[id as TaskId].block === block).reduce((s, [, w]) => s + w, 0)
    expect(sum('D')).toBeCloseTo(20); expect(sum('R')).toBeCloseTo(30); expect(sum('X')).toBeCloseTo(10)
  }
})

it('shows specialists only their domain unless the full mission is requested', () => {
  const ids = (mission: ReturnType<typeof createMission>) => mission.tasks.map(task => task.id)
  // v0.4 assigns every task to one fixed-team role (team.ts); the brain and the single agent see all 25.
  expect(ids(createMission('L2', 'water', false))).toEqual(['D1', 'W1', 'W2', 'W3', 'W4'])
  expect(ids(createMission('L2', 'agronomist', false))).toEqual(['G1', 'G2', 'G3', 'G4'])
  expect(ids(createMission('L2', 'engineer', false))).toEqual(['D3', 'F1', 'F2', 'F3'])
  expect(ids(createMission('L2', 'analyst', false))).toHaveLength(8)
  expect(ids(createMission('L2', 'water', true))).toHaveLength(25)
  expect(ids(createMission('L2', 'brain', false))).toHaveLength(25)
  expect(ids(createMission('L2', undefined, false))).toHaveLength(25)
})

it('resolves short refs only in ID arguments and annotates long IDs in outputs', () => {
  const world = { observe: () => ({ results: [{ id: 'result:aaa' }], samples: [{ id: 'sample:bbb' }], operations: [{ id: 'lab-op' }] }),
    observeSystems: () => ({ operations: [{ id: 'sys-op' }] }) } as never
  const refs = new Refs(world, () => ['artifact:ccc'])
  expect(refs.resolve('r-1')).toBe('result:aaa')
  expect(refs.resolve('so-1')).toBe('sys-op')
  expect(refs.resolve('ar-1')).toBe('artifact:ccc')
  expect(refs.resolve('r-9')).toBe('r-9')
  expect(refs.resolveArgs({ request_key: 'op-1', sample_id: 's-1', additional_sample_ids: ['s-1'], nested: { operationId: 'op-1' } }))
    .toEqual({ request_key: 'op-1', sample_id: 'sample:bbb', additional_sample_ids: ['sample:bbb'], nested: { operationId: 'lab-op' } })
  expect(refs.augment({ id: 'lab-op', resultIds: ['result:aaa'], artifactIds: ['artifact:ccc'], note: 'result:aaa' }))
    .toEqual({ id: 'lab-op', ref: 'op-1', resultIds: ['result:aaa'], resultIdsRefs: ['r-1'], artifactIds: ['artifact:ccc'], artifactIdsRefs: ['ar-1'], note: 'result:aaa', noteRef: 'r-1' })
})

const evidence = (over: Partial<{ resultIds: string[]; operationIds: string[]; analysisRunIds: string[] }>) =>
  ({ resultIds: [], artifactIds: [], operationIds: [], archiveQueryIds: [], analysisRunIds: [], ...over })

it('accepts one water source for D1 and counts the operation that produced a cited result', () => {
  const view = {
    lab: { samples: [{ id: 'sample:r', volumeUl: 500 }], operations: [
      { id: 'op-confirm', state: 'succeeded', command: { action: 'process', deviceId: 'confirm' }, acceptedTick: 40, completedTick: 60 },
      { id: 'op-prepare', state: 'succeeded', command: { action: 'process', deviceId: 'heater-2' }, acceptedTick: 30, completedTick: 35 }],
      results: [{ id: 'result:r', operationId: 'op-confirm', sampleId: 'sample:r', methodId: 'confirm', methodVersion: 1, batchIds: [], completedTick: 60 }] },
    crops: [], base: { history: { snapshots: {}, sols: {}, contaminationClean: {} } }, systemOps: [],
    sampleSources: { 'sample:r': 'reservoir' }, sampleConditions: { 'sample:r': { tick: 20 } }, measurement: () => null,
  } as never
  const check = { tick: 100, load: 'L2', horizon: 2400, analysisTick: () => undefined, answered: 4 }
  // One reservoir confirm is enough, even though filter and pump have no evidence at all.
  expect(minimumEvidence('D1', evidence({ resultIds: ['result:r'] }), view, check)).toEqual([])
  // Citing the operation that produced the confirm cites that result too, so the source is covered.
  expect(minimumEvidence('D1', evidence({ operationIds: ['op-confirm'] }), view, check)).toEqual([])
  // An unrelated operation is not evidence of a water measurement.
  expect(minimumEvidence('D1', evidence({ operationIds: ['op-prepare'] }), view, check)).toHaveLength(1)
  expect(minimumEvidence('W1', evidence({ resultIds: ['result:r'], analysisRunIds: ['a-0001'] }), view, check)).toHaveLength(1)
})

const truth = { load: 'L2', horizon: 2400, energy: { battery: 700, cellFailure: null } } as never
const submission = (answer: unknown) => ({ id: 's', taskId: 'D1' as TaskId, tick: 50, actorId: 'a', answer: answer as Record<string, unknown>, evidence: { resultIds: [], artifactIds: [], operationIds: [], archiveQueryIds: [], analysisRunIds: [] } })

it('scores duty slots against the recorded truth snapshot and zero for a missed slot', () => {
  const crops = Object.fromEntries(CROP_IDS.map((id, index) => [id, index === 0 ? 'infected' : 'healthy']))
  const view = { base: { history: { snapshots: {
    48: { water: { reservoir: 4, filter: 1.5, pump: 1.8 }, faultySensors: ['pump'], crops, latent: [] },
    96: { water: { reservoir: 4, filter: 1.5, pump: 1.8 }, faultySensors: [], crops, latent: ['crop-1-1'] } },
    sols: { 0: { solar: 1300, minSoc: 400, tierOneShedTicks: 0 } }, contaminationClean: {} } } } as never
  const exact = (value: number) => ({ est: value, lo: value, hi: value })
  expect(dutySlotScore(truth, view, 'D1', 0, submission({ reservoir: exact(4), filter: exact(1.5), pump: exact(1.8), sensors: { reservoir: 'ok', filter: 'ok', pump: 'faulty' } }))).toBeCloseTo(1)
  expect(dutySlotScore(truth, view, 'D1', 0, undefined)).toBe(0)
  expect(dutySlotScore(truth, view, 'D1', 3, undefined)).toBeNull()
  const allHealthy = Object.fromEntries(CROP_IDS.map(id => [id, 'healthy']))
  expect(dutySlotScore(truth, view, 'D2', 0, submission({ crops: allHealthy, latent: [] }))).toBeCloseTo(0.8 * 0.5)
  expect(dutySlotScore(truth, view, 'D2', 0, submission({ crops, latent: ['crop-1-1'] }))).toBeCloseTo(1)
  expect(dutySlotScore(truth, view, 'D3', 0, submission({ energy: exact(1300), minSoc: exact(400) }))).toBeCloseTo(1)
})

it('counts independent replication only for two runs with different code that reproduce the values', () => {
  const records: Record<string, { status: string; codeSha256: string; output: unknown }> = {
    'a-0001': { status: 'done', codeSha256: 'x', output: { k: 0.5, w: 2 } },
    'a-0002': { status: 'done', codeSha256: 'y', output: [0.5, 2] },
    'a-0003': { status: 'done', codeSha256: 'x', output: { k: 0.5, w: 2 } },
    'a-0004': { status: 'done', codeSha256: 'z', output: { k: 9 } },
  }
  const check = independentCheck({ get: (id: string) => records[id] } as unknown as AnalysisRegistry)
  expect(check(['a-0001', 'a-0002'], [0.5, 2])).toBe(true)
  expect(check(['a-0001', 'a-0003'], [0.5, 2])).toBe(false)
  expect(check(['a-0001', 'a-0004'], [0.5, 2])).toBe(false)
})
