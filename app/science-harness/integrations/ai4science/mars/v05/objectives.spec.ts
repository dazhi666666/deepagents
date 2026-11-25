import { expect, it } from 'vitest'
import { V05_TASK_IDS, V05_TASKS } from './registry.ts'
import { publicObjectiveContracts, V05_OBJECTIVES } from './objectives.ts'

it('publishes every task with fixed subgoals and exactly the published task and branch weights', () => {
  expect(new Set(V05_OBJECTIVES.map(o => o.objectiveId)).size).toBe(V05_OBJECTIVES.length)
  for (const taskId of V05_TASK_IDS) {
    const objectives = V05_OBJECTIVES.filter(o => o.taskId === taskId), task = V05_TASKS[taskId]
    expect(objectives.length).toBeGreaterThan(0)
    expect(objectives.reduce((n, o) => n + o.points, 0)).toBeCloseTo(task.weight)
    if (!taskId.startsWith('PX')) {
      expect(objectives.filter(o => o.branch === 'accuracy').reduce((n, o) => n + o.points, 0)).toBeCloseTo(task.weight * 0.65)
      expect(objectives.filter(o => o.branch === 'test').reduce((n, o) => n + o.points, 0)).toBeCloseTo(task.weight * 0.35)
    } else expect(objectives.every(o => o.validation === 'actual-execution')).toBe(true)
  }
  expect(V05_OBJECTIVES.reduce((n, o) => n + o.points, 0)).toBeCloseTo(65)
})

it('publishes candidate units and tolerance metadata without scenario target values', () => {
  const catalog = publicObjectiveContracts()
  expect(catalog.calibrationStatus).toBe('candidate_not_calibrated')
  for (const objective of catalog.objectives) {
    expect(objective).not.toHaveProperty('target')
    expect(objective.units.length).toBeGreaterThan(0)
    expect(objective.scope.length).toBeGreaterThan(0)
    expect(objective.aggregation).toBe('fixed-entity-mean')
    if (objective.metric === 'numeric') {
      expect(objective.candidateTolerance?.value).toBeGreaterThan(0)
      expect(objective.candidateTolerance?.absoluteFloor).toBeGreaterThan(0)
    } else expect(objective.candidateTolerance).toBeNull()
    if (objective.branch === 'test') expect(objective.predictionTarget).toBe(`${objective.taskId}:holdout`)
  }
})

it('supports project entry filtering without exposing mutable shared definitions', () => {
  const first = publicObjectiveContracts('PW-01')
  expect(first.objectives.every(o => o.taskId === 'PW-01')).toBe(true)
  first.objectives[0]!.points = 999
  expect(publicObjectiveContracts('PW-01').objectives[0]!.points).not.toBe(999)
})
