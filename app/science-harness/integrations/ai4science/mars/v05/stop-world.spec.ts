/** Execution limits stop every advancement route without rewriting scientific truth. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { truthFor } from '../fixture.ts'
import { marsScenario } from '../scenario.ts'
import { MarsWorld, initialMarsRules } from '../world.ts'
import { SimulationClock } from '../../greenhouse/simulation-clock.ts'

const roots: string[] = [], worlds: MarsWorld[] = [], clocks: SimulationClock[] = []
afterEach(async () => { for (const clock of clocks.splice(0)) await clock.close(); for (const world of worlds.splice(0)) world.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(horizon = 24) {
  const root = mkdtempSync(join(tmpdir(), 'mars-stop-world-')); roots.push(root)
  const generated = truthFor(join(root, 'run')).truth, truth = { ...generated, horizon }
  const world = new MarsWorld(join(root, 'device'), marsScenario(truth), initialMarsRules(), truth); worlds.push(world)
  return { root, world }
}

it('clamps unbounded and explicit advancement while keeping horizon and truth unchanged', () => {
  const { world } = fixture()
  world.setStopAtTick(12)
  expect(world.horizon).toBe(24); expect(world.truth.horizon).toBe(24); expect(world.stopAtTick).toBe(12)
  for (let i = 0; i < 50; i++) world.advance(i % 2 ? undefined : 9999)
  expect(world.observe().tick).toBe(12)
  expect(world.advance()).toBeNull(); expect(world.advance(24)).toBeNull()
  expect(world.horizon).toBe(24); expect(world.truth.horizon).toBe(24)
  // An explicitly revised execution policy can continue; the world never rewrote its scientific horizon.
  world.setStopAtTick(24)
  while (world.advance() !== null) { /* advance actual events */ }
  expect(world.observe().tick).toBe(24)
})

it('rejects invalid, retroactive and beyond-horizon stop limits', () => {
  const { world } = fixture()
  for (const tick of [NaN, Infinity, -1, 1.5, 25]) expect(() => world.setStopAtTick(tick)).toThrow('Stop tick')
  world.advance()
  expect(() => world.setStopAtTick(0)).toThrow('Stop tick')
  world.setStopAtTick(world.observe().tick)
  expect(world.advance()).toBeNull()
})

it('stops an event-driven waiting clock exactly at the limit without a caller-supplied horizon', async () => {
  const { root, world } = fixture()
  world.setStopAtTick(12)
  const errors: Error[] = [], observed: number[] = []
  const clock = new SimulationClock(root, () => world.advance() !== null, error => errors.push(error), 'event-driven'); clocks.push(clock)
  clock.attach(() => true, async () => { observed.push(world.observe().tick) })
  const releaseWait = clock.waiting('waiting-member', () => world.observe().tick >= 12)
  try {
    await vi.waitFor(() => expect(world.observe().tick).toBe(12))
    expect(observed.at(-1)).toBe(12)
    expect(observed.every(tick => tick <= 12)).toBe(true)
    expect(world.advance()).toBeNull()
    expect(errors).toEqual([])
    expect(world.horizon).toBe(24)
  } finally { releaseWait() }
})
