/** Instrument state tests exercise the same SQLite transaction as sample consumption and failures. */
import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { truthFor } from '../fixture.ts'
import { initialMarsRules } from '../world.ts'
import { compileScenario } from './scenario.ts'
import { scienceProfileSchema } from './profile.ts'
import { V06World } from './world.ts'
import { clean, contact, type QualityState } from './measurement-quality.ts'

const roots: string[] = [], worlds: V06World[] = []
afterEach(() => { for (const world of worlds.splice(0)) world.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const profile = scienceProfileSchema.parse({ condition: 'G1' }), stages = { baselineTick: 120, finalTick: 450, horizon: 600 }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mars-v06-quality-')); roots.push(root)
  const source = truthFor(join(root, 'run'), 2).truth, compiled = compileScenario(source, stages, profile)
  // This fixture starts with certified pre-prepared controls already loaded on the real two-slot analyzer.
  for (const s of compiled.scenario.samples) if (['qc-high', 'qc-blank'].includes(s.id)) { s.location = 'confirm'; s.state = 'prepared' }
  compiled.scenario.devices.find(d => d.id === 'confirm')!.capacity = 6
  const directory = join(root, 'device'), world = new V06World(directory, compiled.scenario, initialMarsRules(), compiled.truth, profile, stages); worlds.push(world)
  return { world, directory, compiled }
}
function finish(world: V06World, id: string) {
  for (let i = 0; i < 500 && world.operation(id)?.state === 'running'; i++) world.advance(stages.horizon)
  expect(world.operation(id)?.state).toBe('succeeded')
}
it('returns detached views while checking changed SQLite bytes and rejecting damaged persisted state', () => {
  const { world, directory } = fixture()
  const lab = world.observe(), systems = world.observeSystems(), base = world.observeBase(), quality = world.quality()
  lab.tick = 999; systems.crops[0]!.biomass = 999; base.water.reserve = 0; quality.residual = 999
  expect(world.observe().tick).toBe(0); expect(world.observeSystems().crops[0]!.biomass).toBe(0)
  expect(world.observeBase().water.reserve).toBeGreaterThan(0); expect(world.quality().residual).toBe(0.8)
  const db = new DatabaseSync(join(directory, 'laboratory.sqlite'))
  try {
    const original = String(db.prepare('SELECT state FROM mars_v06_quality WHERE id=1').get()!.state)
    db.prepare('UPDATE mars_v06_quality SET state=? WHERE id=1').run('{}')
    expect(() => world.quality()).toThrow()
    db.prepare('UPDATE mars_v06_quality SET state=? WHERE id=1').run(original)
    expect(world.quality().residual).toBe(0.8)
    world.submit('cached-calibration', 'mars', 'cached-calibration', { action: 'calibrate', deviceId: 'confirm' }); finish(world, 'cached-calibration')
    expect(world.observe().tick).toBeGreaterThan(0)
    expect(world.observe().devices.find(d => d.id === 'confirm')!.calibratedUntil).toBeGreaterThan(world.observe().tick)
  } finally { db.close() }
})
it('shares pre-batch memory, reduces it by cleaning and never double applies a contact', () => {
  const state: QualityState = { configHash: 'fixture', residual: 1, initialResidual: 1, contacts: {}, cleanings: [], trajectories: {}, snapshots: {} }
  expect(contact(state, 'batch', [2, 8], 10, profile)).toBe(1)
  expect(state.residual).toBeCloseTo(1 * profile.residualRetention + 5 * profile.residualContact)
  const next = state.residual
  contact(state, 'batch', [2, 8], 10, profile); expect(state.residual).toBe(next)
  clean(state, 'wash', profile); const after = state.residual
  clean(state, 'wash', profile); expect(state.residual).toBe(after)
  expect(() => contact(state, 'bad', [Infinity], 10, profile)).toThrow('range')
})
it('keeps dirty/calibration constraints, generates affected raw data and charges each real extra cleaning', () => {
  const { world } = fixture()
  world.submit('cal', 'mars', 'cal', { action: 'calibrate', deviceId: 'confirm' }); finish(world, 'cal')
  world.submit('high', 'mars', 'high', { action: 'process', deviceId: 'confirm', sampleId: 'qc-high', volumeUl: 10, methodId: 'confirm', methodVersion: 2 }); finish(world, 'high')
  const residual = world.quality().residual
  expect(world.quality().contacts.high!.used).toBe(0.8)
  expect(residual).toBeGreaterThan(0.8)
  const result = world.operation('high')!.resultIds![0]!
  expect(world.rawFor(result)).toMatchObject({ kind: 'chromatogram', points: expect.any(Array) })
  expect(JSON.stringify(world.measurement(result))).not.toContain('residual')
  expect(() => world.prepare('mars', { action: 'process', deviceId: 'confirm', sampleId: 'qc-blank', volumeUl: 10, methodId: 'confirm', methodVersion: 2 })).toThrow('clean')
  const units = world.observe().batches.find(b => b.id === 'qc-cleaning')!.units
  world.submit('wash', 'mars', 'wash', { action: 'clean', deviceId: 'confirm' }); finish(world, 'wash')
  expect(world.quality().residual).toBeCloseTo(residual * profile.cleaningRetention)
  expect(world.observe().devices.find(d => d.id === 'confirm')!.dirty).toBe(false)
  expect(world.operation('wash')!.consumedWaterUl).toBe(profile.cleaningWaterUl)
  expect(world.observe().batches.find(b => b.id === 'qc-cleaning')!.units).toBe(units - 1)
  const washed = world.quality().residual
  world.submit('cal-again', 'mars', 'cal-again', { action: 'calibrate', deviceId: 'confirm' }); finish(world, 'cal-again')
  expect(world.quality().residual).toBe(washed)
  world.submit('wash-again', 'mars', 'wash-again', { action: 'clean', deviceId: 'confirm' }); finish(world, 'wash-again')
  expect(world.quality().residual).toBeCloseTo(washed * profile.cleaningRetention)
})
it('retains contact effects after cancellation, deduplicates resubmission and restores private state', () => {
  const { world, directory, compiled } = fixture()
  world.submit('cal', 'mars', 'cal', { action: 'calibrate', deviceId: 'confirm' }); finish(world, 'cal')
  world.submit('interrupted', 'mars', 'interrupted', { action: 'process', deviceId: 'confirm', sampleId: 'qc-high', volumeUl: 10, methodId: 'confirm', methodVersion: 2 })
  while (world.operation('interrupted')!.stage !== 'processing') world.advance(stages.horizon)
  const contactState = world.quality()
  world.cancel('interrupted')
  expect(world.quality()).toEqual(contactState)
  const command = world.operation('interrupted')!.command
  world.submit('interrupted', 'mars', 'interrupted', command)
  expect(world.quality()).toEqual(contactState)
  world.close(); worlds.splice(worlds.indexOf(world), 1)
  const restored = new V06World(directory, compiled.scenario, initialMarsRules(), compiled.truth, profile, stages); worlds.push(restored)
  expect(restored.quality()).toEqual(contactState)
  expect(restored.operation('interrupted')!.consumedUl).toBe(10)
})
it('keeps physical reference noise independent of operation identity and hides private quality state', () => {
  const first = fixture().world, second = fixture().world
  const results = [first, second].map((world, index) => {
    const id = `different-native-id-${index}`
    world.submitSystem(id, 'mars', `different-owner-${index}`, { action: 'device_reference', targetId: 'pump' })
    for (let i = 0; i < 500 && world.observeSystems().operations.find(o => o.id === id)!.state === 'running'; i++) world.advance(stages.horizon)
    const result = world.observeSystems().operations.find(o => o.id === id)!.result as { tick: number; reference: { docInline: number } }
    expect(result.tick).toBe(world.observe().tick)
    return result.reference.docInline
  })
  expect(results[0]).toBe(results[1])
  expect(JSON.stringify(first.sensors())).not.toContain('initialResidual')
  expect(JSON.stringify(first.observe().devices)).not.toContain('contacts')
})
