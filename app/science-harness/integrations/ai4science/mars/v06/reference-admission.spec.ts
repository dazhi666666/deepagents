/** Public-policy maintenance must stop when an awaited physical action crosses the final boundary. */
import { expect, it } from 'vitest'
import { runPublicReference, type PublicReferencePort, type ReferenceState } from './reference.ts'

async function maintenanceFixture() {
  const state: ReferenceState = { tick: 0, baselineTick: 720, finalTick: 1800, horizon: 2400, methodVersion: 1,
    chambers: [1, 2, 3, 4].map(id => ({ id: `incubator-${id}`, temperatureReading: 22, light: 70, nutrient: 1, co2: 800 })),
    crops: [], robots: [{ id: 'robot-3', energy: 120, node: 'robot-3', busy: false }], devices: [], batches: [], samples: [],
    inlineDoc: { reservoir: 4, filter: 1, pump: 1 }, waterRoute: 'main', solar: 40, soc: 800, tankUl: 5000 }
  const callbacks: { tick: (() => Promise<void>) | null } = { tick: null }, calls: string[] = []
  const unused = () => { throw new Error('Unexpected research work in maintenance fixture') }
  const port: PublicReferencePort = {
    state: () => structuredClone(state), progress: unused, onTick: callback => { callbacks.tick = callback },
    command: async key => {
      if (key === 'controls-to-handler') throw new Error('Maintenance callback captured')
      if (state.tick >= state.finalTick) throw new Error('New physical action after final admission closed')
      calls.push(key); state.tick += 3
      return { id: key, completedTick: state.tick, result: null }
    },
    catalog: () => ({ handover: [], services: [] }), schedule: () => ({ id: 'service-plan', createdTick: state.tick }),
    actionForecast: unused, completedScans: unused, completedAssays: unused, waitUntil: unused, assay: unused,
    confirmPrepared: unused, screenBatch: unused, aliquot: unused, store: unused, split: unused, scan: unused,
    analyze: unused, registerModel: unused, commit: unused, submit: unused,
  }
  await expect(runPublicReference(port)).rejects.toThrow('Maintenance callback captured')
  calls.length = 0
  return { state, calls, advance: async () => { expect(callbacks.tick).not.toBeNull(); await callbacks.tick!() } }
}

it('retains accepted irrigation and stops the chamber loop after it crosses final admission', async () => {
  const fixture = await maintenanceFixture()
  fixture.state.tick = 1793
  await fixture.advance()
  expect(fixture.state.tick).toBe(1802)
  expect(fixture.calls).toEqual(['routine-water-incubator-1-1793', 'routine-water-incubator-2-1793', 'routine-water-incubator-3-1793'])
})

it('retains an accepted docking move without issuing a new charge after final admission', async () => {
  const fixture = await maintenanceFixture()
  fixture.state.tick = 1798; fixture.state.chambers = []
  fixture.state.robots[0] = { id: 'robot-3', energy: 40, node: 'solar-panel', busy: false }
  await fixture.advance()
  expect(fixture.state.tick).toBe(1801)
  expect(fixture.calls).toEqual(['dock-robot-3-1798'])
})
