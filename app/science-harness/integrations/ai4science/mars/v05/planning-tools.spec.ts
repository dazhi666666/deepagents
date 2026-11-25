/** Native planning bridge over the real world, providers and execution journal; no LLM. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { truthFor } from '../fixture.ts'
import { MarsWorld, initialMarsRules } from '../world.ts'
import { marsScenario } from '../scenario.ts'
import { openMarsProviders } from '../providers.ts'
import { installPlanningTools } from './planning-tools.ts'
import type { Plan, Reservation } from './planning.ts'
import { V05Ledger } from './ledger.ts'

const roots: string[] = [], cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function bridge() {
  const root = mkdtempSync(join(tmpdir(), 'mars-v05-planning-tools-')); roots.push(root)
  const { truth } = truthFor(join(root, 'run')), scenario = marsScenario(truth)
  const path = join(root, 'scenario.json'); writeFileSync(path, JSON.stringify(scenario))
  const world = new MarsWorld(join(root, 'device'), scenario, initialMarsRules(), truth)
  const opened = openMarsProviders(world, path, () => {})
  let engine: ExecutionEngine
  const agent = { id: 'planner' } as Agent
  async function attach() {
    engine = new ExecutionEngine({ directory: join(root, 'execution'), providers: opened.providers, logicalTick: () => world.observe().tick, pollIntervalMs: 5, providerCallTimeoutMs: 1000 })
    await engine.open(); engine.createProject('mars', null)
    const grant = engine.issueContext('mars', 'planner', ['water', 'greenhouse', 'facilities'])
    const callbacks = new Map<string, (args: Record<string, unknown>, agent: Agent, signal: AbortSignal) => unknown | Promise<unknown>>()
    const advance = installPlanningTools({ register: (name, _description, _parameters, callback) => { callbacks.set(name, callback) }, engine, world, access: () => grant })
    const invoke = (name: string, args: Record<string, unknown>) => callbacks.get(name)!(args, agent, new AbortController().signal)
    return { engine, grant, advance, invoke, write: (name: string, action: string, key: string, input: unknown) => invoke(name, { action, request_key: key, input_json: JSON.stringify(input) }) }
  }
  let attached = await attach()
  cleanup.push(async () => { await engine.close(); opened.close(); world.close() })
  return { world, current: () => attached, restart: async () => { await engine.close(); attached = await attach(); return attached },
    until: (tick: number) => { while (world.observe().tick < tick) world.advance() } }
}

it('dispatches at the exact scheduled tick and waits for actual physical dependency completion', async () => {
  const fixture = await bridge(), { world, until } = fixture, { advance, write, engine, grant, invoke } = fixture.current()
  const plan = await write('experiment_plan', 'schedule', 'schedule', { title: 'scan then set co2', steps: [
    { id: 'scan', providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-1' }, at: 12 },
    { id: 'co2', providerId: 'greenhouse', input: { action: 'co2', chamberId: 'incubator-1', setpoint: 800 }, at: 12, dependsOn: ['scan'] },
  ] }) as Plan
  until(11); await advance(); expect(engine.list(grant)).toHaveLength(0)
  until(12); await advance()
  let physical = world.observeSystems().operations
  expect(physical).toHaveLength(1); expect(physical[0]?.acceptedTick).toBe(12); expect(physical[0]?.command.action).toBe('scan')
  await advance(); expect(world.observeSystems().operations).toHaveLength(1)
  until(14); await advance()
  physical = world.observeSystems().operations
  expect(physical).toHaveLength(2)
  expect(physical.find(v => v.command.action === 'scan')?.state).toBe('succeeded')
  expect(physical.find(v => v.command.action === 'co2')?.acceptedTick).toBe(14)
  until(15); await advance()
  const plans = await invoke('experiment_plan', { action: 'list' }) as Plan[]
  expect(plans.find(v => v.id === plan.id)?.state).toBe('succeeded')
  expect(Object.keys(plans[0]!.operations).sort()).toEqual(['co2', 'scan'])
})

it('rejects unknown resources and exposes physical resource capacities', async () => {
  const fixture = await bridge(), { invoke, write } = fixture.current()
  const status = await invoke('resource_reservation', { action: 'list' }) as { semantics: string; capacities: Record<string, number> }
  expect(status.semantics).toBe('scheduler-enforced')
  expect(status.capacities['laboratory:device:confirm']).toBe(1)
  expect(() => write('resource_reservation', 'reserve', 'unknown', { resource: 'imaginary-device', start: 12, end: 24 })).toThrow('Unknown public resource')
  expect(() => write('resource_reservation', 'reserve', 'prototype', { resource: 'toString', start: 12, end: 24 })).toThrow('Unknown public resource')
  const reservation = await write('resource_reservation', 'reserve', 'confirm', { resource: 'laboratory:device:confirm', start: 12, end: 24 }) as Reservation
  expect(reservation.state).toBe('committed')
  expect(() => write('resource_reservation', 'reserve', 'conflict', { resource: 'laboratory:device:confirm', start: 23, end: 25 })).toThrow('capacity')
  expect((await write('resource_reservation', 'reserve', 'adjacent', { resource: 'laboratory:device:confirm', start: 24, end: 25 }) as Reservation).start).toBe(24)
})

it('binds reservations to real plan resources and holds occupancy through actual completion', async () => {
  const fixture = await bridge(), { world, until } = fixture, { write, invoke, advance } = fixture.current()
  const input = { title: 'reserved scan', steps: [{ id: 'scan', providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-1' }, at: 12 }] }
  const first = await write('experiment_plan', 'schedule', 'reserved-plan', input) as Plan
  await write('experiment_plan', 'schedule', 'other-plan', { ...input, title: 'competing scan' })
  expect(() => write('resource_reservation', 'reserve', 'wrong-target', { resource: 'laboratory:device:confirm', start: 12, end: 13, planId: first.id, stepId: 'scan' })).toThrow('does not belong')
  await write('resource_reservation', 'reserve', 'right-target', { resource: 'laboratory:device:incubator-1', start: 12, end: 13, planId: first.id, stepId: 'scan' })
  until(12); await advance(); expect(world.observeSystems().operations).toHaveLength(1)
  until(13); await advance(); expect(world.observeSystems().operations).toHaveLength(1)
  const active = await invoke('resource_reservation', { action: 'list' }) as { reservations: Reservation[] }
  expect(active.reservations[0]?.state).toBe('active')
  expect(() => invoke('resource_reservation', { action: 'release', request_key: 'early-release', id: active.reservations[0]!.id, revision: active.reservations[0]!.revision })).toThrow('still owns')
  until(14); await advance()
  expect(world.observeSystems().operations).toHaveLength(2)
  const status = await invoke('resource_reservation', { action: 'list' }) as { reservations: Reservation[] }
  expect(status.reservations[0]?.state).toBe('released')
})

it('records public sample timing, physical usage and energy without private concentrations', async () => {
  const fixture = await bridge(), { world } = fixture, { write, advance, engine, grant } = fixture.current()
  const ledger = new V05Ledger(engine, grant, world)
  await write('experiment_plan', 'schedule', 'sample-plan', { title: 'sample', steps: [{ id: 'sample', providerId: 'water', input: { action: 'sample', sourceId: 'reservoir', volumeUl: 50, container: 'vial' } }] })
  ledger.capture(); ledger.capture()
  expect(ledger.snapshots()).toHaveLength(1)
  await advance(); ledger.capture()
  for (let i = 0; i < 30 && world.observeSystems().operations[0]?.state === 'running'; i++) { world.advance(); await advance(); ledger.capture() }
  const operation = world.observeSystems().operations[0]!
  expect(operation.state).toBe('succeeded')
  const report = ledger.report()
  expect(report.samples.find(v => v.id === `sample:${operation.id}`)?.sampled_at).toBe(operation.completedTick)
  expect(report.snapshots.at(-1)?.energy.batteryCharge).toBeTypeOf('number')
  expect(report.snapshots.at(-1)?.samples.find(v => v.id === `sample:${operation.id}`)?.volumeUl).toBe(50)
  const serialized = JSON.stringify(report)
  for (const hidden of ['docEffective', 'confirmV1', 'extractionA2', 'contamination', 'sampledTick']) expect(serialized).not.toContain(hidden)
  const restored = new V05Ledger(engine, grant, world)
  expect(restored.report()).toEqual(report)
})

it('takes multi-resource jobs together and fails missed linked windows without holding partial locks', async () => {
  const fixture = await bridge(), { world, until } = fixture, { write, invoke, advance, engine, grant } = fixture.current()
  await write('experiment_plan', 'schedule', 'panels', { title: 'clean panels', steps: [{ id: 'panels', providerId: 'facilities', input: { action: 'panel_clean' } }] })
  const blocked = await write('resource_reservation', 'reserve', 'block-panels', { resource: 'mars:solar-array', start: 0, end: 10 }) as Reservation
  await advance()
  expect(engine.list(grant)).toHaveLength(0)
  expect(world.observeSystems().robots.find(v => v.id === 'robot-3')?.operationId).toBeNull()
  await invoke('resource_reservation', { action: 'release', request_key: 'unblock-panels', id: blocked.id, revision: 1 })
  await advance()
  expect(world.observeSystems().operations.find(v => v.command.action === 'panel_clean')?.state).toBe('running')
  const missed = await write('experiment_plan', 'schedule', 'missed', { title: 'late scan', steps: [{ id: 'scan', providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-1' }, at: 12 }] }) as Plan
  await write('resource_reservation', 'reserve', 'missed-slot', { resource: 'laboratory:device:incubator-1', start: 12, end: 13, planId: missed.id, stepId: 'scan' })
  until(14); await advance()
  const plans = await invoke('experiment_plan', { action: 'list' }) as Plan[]
  expect(plans.find(v => v.id === missed.id)?.state).toBe('partial_failed')
  expect(world.observeSystems().operations.filter(v => v.command.action === 'scan')).toHaveLength(0)
})

it('resolves declared predecessor sample outputs only after actual sampling completes', async () => {
  const fixture = await bridge(), { world } = fixture, { write, advance, invoke } = fixture.current()
  const input = { title: 'sample then carry unknown generated sample', steps: [
    { id: 'sample', providerId: 'water', input: { action: 'sample', sourceId: 'reservoir', volumeUl: 50, container: 'vial' } },
    { id: 'carry', providerId: 'water', input: { action: 'transfer', deviceId: 'robot-1', sampleId: '$step:sample:outputSampleIds.0', destination: 'heater-1' }, dependsOn: ['sample'] },
  ] }
  const plan = await write('experiment_plan', 'schedule', 'local-output', input) as Plan
  await advance()
  expect(world.observe().operations.filter(op => op.command.action === 'transfer')).toHaveLength(0)
  for (let i = 0; i < 60 && !world.observe().operations.some(op => op.command.action === 'transfer'); i++) { world.advance(); await advance() }
  const sampled = world.observeSystems().operations.find(op => op.command.action === 'sample')!
  const carry = world.observe().operations.find(op => op.command.action === 'transfer')!
  expect(sampled.state).toBe('succeeded')
  expect(carry).toBeDefined()
  expect(carry.command).toMatchObject({ sampleId: `sample:${sampled.id}` })
  expect(carry.acceptedTick).toBeGreaterThanOrEqual(sampled.completedTick!)
  expect((await invoke('experiment_plan', { action: 'list' }) as Plan[]).find(p => p.id === plan.id)?.operations.carry).toBe(carry.id)
  const invalid = (sampleId: string, dependsOn: string[]) => ({ ...input, steps: [input.steps[0], { ...input.steps[1], dependsOn, input: { ...input.steps[1]!.input, sampleId } }] })
  expect(() => write('experiment_plan', 'check', 'bad-dependency', invalid('$step:sample:outputSampleId', []))).toThrow('declared predecessor')
  expect(() => write('experiment_plan', 'check', 'prototype-path', invalid('$step:sample:__proto__.polluted', ['sample']))).toThrow('Invalid local')
  expect(() => write('experiment_plan', 'check', 'unknown-path', invalid('$step:missing:outputSampleId', ['sample']))).toThrow('declared predecessor')
})

it('reopens the journal without redispatching accepted work and cancels only future steps', async () => {
  const fixture = await bridge(), { world, until } = fixture
  const first = fixture.current()
  const scheduled = await first.write('experiment_plan', 'schedule', 'persist', { title: 'two scans', steps: [
    { id: 'first', providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-1' }, at: 12 },
    { id: 'future', providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-2' }, at: 48 },
  ] }) as Plan
  until(12); await first.advance()
  const accepted = world.observeSystems().operations[0]!.id
  const reopened = await fixture.restart()
  await reopened.advance()
  expect(world.observeSystems().operations.map(v => v.id)).toEqual([accepted])
  const plans = await reopened.invoke('experiment_plan', { action: 'list' }) as Plan[], current = plans.find(v => v.id === scheduled.id)!
  const cancelled = await reopened.invoke('experiment_plan', { action: 'cancel', request_key: 'cancel', id: current.id, revision: current.revision }) as Plan
  expect(cancelled.operations).toEqual(current.operations)
  until(48); await reopened.advance()
  expect(world.observeSystems().operations.map(v => v.id)).toEqual([accepted])
  expect(world.observeSystems().operations[0]?.state).toBe('succeeded')
})

it('serializes amendment against an in-flight native dispatch and preserves cancellation', async () => {
  const fixture = await bridge(), { world, until } = fixture, { engine, advance, write, invoke } = fixture.current()
  const input = { title: 'two independent scans', steps: [
    { id: 'first', providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-1' }, at: 12 },
    { id: 'second', providerId: 'greenhouse', input: { action: 'scan', chamberId: 'incubator-2' }, at: 12 },
  ] }
  const plan = await write('experiment_plan', 'schedule', 'race', input) as Plan
  const original = engine.submit.bind(engine)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const spy = vi.spyOn(engine, 'submit').mockImplementation(async (...args) => { await gate; return original(...args) })
  until(12)
  const pending = advance()
  try {
    expect(spy).toHaveBeenCalledOnce()
    expect(() => invoke('experiment_plan', { action: 'amend', request_key: 'race-amend', id: plan.id, revision: 1, input_json: JSON.stringify(input) })).toThrow('in progress')
    await invoke('experiment_plan', { action: 'cancel', request_key: 'race-cancel', id: plan.id, revision: 1 })
  } finally { release(); await pending; spy.mockRestore() }
  const plans = await invoke('experiment_plan', { action: 'list' }) as Plan[]
  expect(plans.find(v => v.id === plan.id)?.state).toBe('cancelled')
  expect(world.observeSystems().operations).toHaveLength(1)
  expect(Object.keys(plans[0]!.operations)).toEqual(['first'])
})
