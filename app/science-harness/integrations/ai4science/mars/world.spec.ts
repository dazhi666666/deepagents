/** v0.2 physical world: base subsystems, measurements with raw data, incidents and scoring. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarsWorld, initialMarsRules } from './world.ts'
import { marsScenario } from './scenario.ts'
import { truthFor } from './fixture.ts'
import { simulate } from './simulate.ts'
import { measure, chromatogram } from './observation.ts'
import { initialBase } from './base.ts'
import { numeric } from './scoring-common.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const open = (seed = 1) => {
  const root = mkdtempSync(join(tmpdir(), 'mars-v2-')); roots.push(root)
  const { truth } = truthFor(join(root, 'run'), seed)
  return { truth, world: new MarsWorld(join(root, 'run/device'), marsScenario(truth), initialMarsRules(), truth), root }
}
const until = (world: MarsWorld, done: () => boolean, limit = 400) => { for (let i = 0; i < limit && !done(); i++) world.advance() }

it('steps base subsystems tick by tick and keeps hidden truth out of sensor views', () => {
  const { world, truth } = open()
  try {
    for (let i = 0; i < 60; i++) world.advance()
    const sensors = world.sensors(), base = world.observeBase()
    expect(sensors.tick).toBe(60)
    expect(sensors.crops).toHaveLength(16)
    expect(world.observeSystems().crops.every(crop => crop.growth > 0)).toBe(true)
    expect(base.energy.solar).toBeGreaterThanOrEqual(0)
    expect(world.telemetry(['energy.soc', 'incubator-1.temperature'], 0, 60)['energy.soc']!.length).toBeGreaterThan(50)
    expect(JSON.stringify(sensors)).not.toContain(String(truth.water.reservoir))
    expect(world.advance()).toBe(61)
  } finally { world.close() }
})

it('produces measured values and raw chromatograms for confirm, with method and batch bias', () => {
  const { truth, world } = open()
  world.close()
  const base = initialBase(truth, [])
  base.samples.s = { kind: 'water', source: 'pump', doc: 2, lubricant: 1, decay: 1, sampledTick: 0 }
  const v1 = measure(truth, base, { resultId: 'r1', methodId: 'confirm', methodVersion: 1, sampleId: 's', batchIds: [truth.lots.A2], calibrationAge: 0, tick: 0 })
  const raw = v1.raw as { points: number[] }
  expect(raw.points).toHaveLength(600)
  const summary = (v1.measurement as { instrumentSummary: number }).instrumentSummary
  expect(summary).toBeGreaterThan(2 * truth.bias.confirmV1 * truth.bias.extractionA2)
  const clean = chromatogram('x', 2, 0, 0)
  expect(clean.summary).toBeGreaterThan(1.9)
  expect(measure(truth, base, { resultId: 'r1', methodId: 'confirm', methodVersion: 1, sampleId: 's', batchIds: [truth.lots.A2], calibrationAge: 0, tick: 0 })).toEqual(v1)
})

it('runs sampling, transport and processing through the shared tank and records the measurement', () => {
  const { world, truth } = open()
  try {
    world.submitSystem('sample', 'mars', 'sample', { action: 'sample', sourceId: 'reservoir', volumeUl: 100, container: 'vial' })
    until(world, () => world.observeSystems().operations.find(op => op.id === 'sample')?.state !== 'running')
    const sampleId = 'sample:sample'
    world.submit('carry', 'mars', 'carry', { action: 'transfer', deviceId: 'robot-2', sampleId, destination: 'heater-1' })
    until(world, () => world.operation('carry')?.state !== 'running')
    expect(world.operation('carry')?.state).toBe('succeeded')
    world.submit('prep', 'mars', 'prep', { action: 'process', methodId: 'water-prepare', deviceId: 'heater-1', sampleId, volumeUl: 50, methodVersion: 1, consumables: [{ batchId: truth.lots.B, units: 1 }] })
    until(world, () => world.operation('prep')?.state !== 'running')
    expect(world.operation('prep')?.state).toBe('succeeded')
    const resultId = world.operation('prep')!.resultIds![0]!
    expect(world.measurement(resultId)).toMatchObject({ channel: 'none' })
    expect(world.observeBase().samples[world.operation('prep')!.outputSampleIds![0]!]).toMatchObject({ kind: 'water', source: 'reservoir' })
  } finally { world.close() }
})

it('scores interval estimates and reaches the horizon under the null policy', async () => {
  expect(numeric({ est: 1, lo: 0.9, hi: 1.1 }, 1, 0.1)).toBeCloseTo(1 - 0.3 * 0.2 / 0.4, 5)
  expect(numeric({ est: 2, lo: 2, hi: 2 }, 1, 0.1)).toBe(0)
  const { truth, root } = open(2)
  const result = await simulate(truth, join(root, 'sim'), 'null')
  expect(result.tick).toBe(truth.horizon)
  expect(result.crops.every(crop => crop.includes(':lost'))).toBe(true)
  expect(result.S).toBeGreaterThan(0)
}, 120000)
