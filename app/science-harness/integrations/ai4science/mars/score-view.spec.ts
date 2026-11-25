/** Running score views must expose progress and observable counts but never accuracy, totals or truth values. */
import { expect, it } from 'vitest'
import { observableIncidentCount, redactScore } from './score-view.ts'
import type { Truth } from './truth.ts'

const full = {
  provisional: true, tick: 512,
  S: 41.25, normalized: 17.5,
  O: { total: 13.5, crops: 6.5, energy: 2.5, water: 2.5, atmosphere: 1.5, samples: 0.5 },
  C: { total: 12.75, incidents: [{ id: 'E1', onset: 987654, detect: 0.75, contain: 0.5, recover: null, correct: 1, score: 0.75 }] },
  D: { total: 6.5, duties: [{ id: 'D1', weight: 7, slots: 25, scored: 5, submitted: 4, mean: 0.66, points: 4.5 }] },
  R: { total: 14.25, tasks: [{ id: 'W1', weight: 2, P: 0.8, V: 0.9, A: 12345.678, d: 1, r: 0.86, points: 1.72 }] },
  X: { total: 2.5, tasks: [{ id: 'X1', weight: 3, P: 0.5, V: 1, A: 0.25, d: 1, r: 0.35, points: 1.05 }] },
  Q: { total: 0.75, efficiency: 1.5, independent: 0.25, reproducibility: 0.5, usage: {} },
  waterStillContaminated: true,
} as const

it('keeps observable operations, crisis counts and research progress while hiding final terms', () => {
  const view = redactScore(full, 'running', { observableIncidents: 2, reportedIncidents: 1, rejectedSubmissions: 3,
    taskSubmissions: { W1: { accepted: 2, rejected: 1 } } }) as Record<string, any>
  expect(view).toEqual({
    provisional: true, tick: 512,
    O: { total: 13.5, crops: 6.5, energy: 2.5, water: 2.5, atmosphere: 1.5, samples: 0.5 },
    D: { duties: [{ id: 'D1', weight: 7, slots: 25, submitted: 4 }] },
    C: { observable: 2, reported: 1 },
    R: { tasks: [{ id: 'W1', weight: 2, P: 0.8, V: 0.9, d: 1, submissions: 2, rejected: 1 }] },
    X: { tasks: [{ id: 'X1', weight: 3, P: 0.5, V: 1, d: 1, submissions: 0, rejected: 0 }] },
    Q: { rejected: 3 },
  })
  const serialized = JSON.stringify(view)
  for (const hidden of ['"S"', '"normalized"', '"A"', '"r"', '"points"', '"mean"', '"onset"', '12345.678', '987654']) expect(serialized).not.toContain(hidden)
  expect(view.C.total).toBeUndefined()
  expect(view.R.total).toBeUndefined()
  expect(view.Q.total).toBeUndefined()
})

it('returns the complete final score only after the mission is completed', () => {
  const final = { ...full, provisional: false, S: 41.25 }
  expect(redactScore(final, 'completed')).toBe(final)
  expect((redactScore(final, 'agent-ended') as Record<string, any>).S).toBeUndefined()
})

it('counts only incidents with a public signal and never exposes silent drift', () => {
  const truth = { incidents: [
    { id: 'E1', onset: 100 }, { id: 'E2', onset: 200 }, { id: 'E3', onset: 300 }, { id: 'E4', onset: 400 },
    { id: 'E9', onset: 500 }, { id: 'E10', onset: 600 },
  ] } as unknown as Truth
  const events = [
    { tick: 90, kind: 'power-shed', payload: { shed: ['cold-1'] } },
    { tick: 210, kind: 'device-fault', payload: { deviceId: 'cold-1' } },
    { tick: 305, kind: 'inline-doc-alarm', payload: { module: 'pump' } },
    { tick: 505, kind: 'chamber-pressure-low', payload: { chamberId: 'incubator-2' } },
    { tick: 610, kind: 'crop-status-changed', payload: { id: 'crop-1-1', status: 'stressed' } },
  ]
  expect(observableIncidentCount(truth, events, 250)).toBe(2)
  expect(observableIncidentCount(truth, events, 620)).toBe(5)
  expect(observableIncidentCount(truth, [], 620)).toBe(0)
})
