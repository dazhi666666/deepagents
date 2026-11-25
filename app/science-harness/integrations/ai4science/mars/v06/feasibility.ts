/** Drive the public reference through actual providers; private state never enters the policy port. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { mountMars, type Config } from '../runtime.ts'
import { fitChromatogram } from '../chromatography.ts'
import { analysisBindings } from '../v2-tools.ts'
import { V05Planning } from '../v05/planning.ts'
import { planResources } from '../v05/planning-tools.ts'
import { LaboratoryRefusal } from '../../greenhouse/laboratory/world.ts'
import { runPublicReference, type PublicReferencePort, type PublicScan, type PublicAssay } from './reference.ts'

type Runtime = Awaited<ReturnType<typeof mountMars>>
const scanSchema = z.object({ chamberId: z.string(), tick: z.number(), values: z.array(z.object({ cropId: z.string(), growthIndex: z.number().optional() }).passthrough()),
  conditions: z.object({ light: z.number(), nutrient: z.number(), temperature: z.number(), co2: z.number(), irrigationByCrop: z.record(z.string(), z.number()) }) })
/** Only explicitly public measurements, catalogs and the same physical command API are reachable here. */
export function referencePort(runtime: Runtime, signal?: AbortSignal): PublicReferencePort {
  if (!runtime.science) throw new Error('Public feasibility requires the scientific candidate')
  const { world, engine, science } = runtime, grant = engine.issueContext('mars', 'public-reference', ['water', 'greenhouse', 'facilities'])
  const now = () => world.observe().tick, records = science.recordsFor(grant), actions = science.actionsFor(grant)
  const publicPlans = new V05Planning(engine, grant, now, {}, undefined, 'v06')
  let onTick: (() => Promise<void>) | null = null, insideTick = false, lastTick = -100000, cooperativeTurns = 0
  const stepTo = async (target: number) => {
    while (now() < target) {
      signal?.throwIfAborted()
      if (!insideTick && onTick && now() < world.horizon && now() < science.stages.profile.finalTick && now() - lastTick >= science.config.decisionTicks) {
        lastTick = now(); insideTick = true
        try { await onTick() } finally { insideTick = false }
      }
      if (now() < target) await runtime.advanceScientificTo(Math.min(target, now() + 1))
      if (++cooperativeTurns % 64 === 0) await yieldTurn()
    }
  }
  const physical = (id: string) => world.operation(id) ?? world.observeSystems().operations.find(o => o.id === id)
  const command: PublicReferencePort['command'] = async (key, providerId, input) => {
    let lastFailure = ''
    for (let attempt = 0; attempt < 240; attempt++) {
      signal?.throwIfAborted()
      if (now() >= science.stages.profile.finalTick) throw new Error(`Reference action missed final admission: ${key}: ${lastFailure}`)
      try {
        const job = await engine.submit(grant, { providerId, requestKey: `${key}:${attempt}`, input })
        while (!physical(job.id) || physical(job.id)!.state === 'running') await stepTo(now() + 1)
        await engine.query(grant, job.id)
        const result = physical(job.id)!
        if (result.state !== 'succeeded') throw new Error(`${key}: ${'detail' in result ? result.detail ?? result.state : result.state}`)
        const output = world.operation(job.id)
        return { id: job.id, completedTick: result.completedTick ?? now(), result: output ? z.json().parse({ outputSampleId: output.outputSampleId ?? null,
          outputSampleIds: output.outputSampleIds ?? [], resultId: output.resultId ?? null, resultIds: output.resultIds ?? [], consumedUl: output.consumedUl }) :
          world.observeSystems().operations.find(o => o.id === job.id)!.result }
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error)
        const temporarilyBlocked = error instanceof LaboratoryRefusal && ['busy', 'capacity', 'unavailable'].includes(error.code)
        if (!temporarilyBlocked && !/busy|reserved|accepted work|accepted traffic|route conflict|current calibration|Charge|capacity|position/i.test(lastFailure))
          throw new Error(`${key} at tick ${now()}: ${lastFailure}`, { cause: error })
        await stepTo(now() + 1)
      }
    }
    throw new Error(`Reference action remained blocked at tick ${now()}: ${key}: ${lastFailure}`)
  }
  const transfer = async (key: string, sampleId: string, destination: string) => {
    const sample = world.observe().samples.find(s => s.id === sampleId)
    if (!sample) throw new Error('Public sample unavailable')
    if (sample.location !== destination) await command(key, 'water', { action: 'transfer', deviceId: 'robot-1', sampleId, destination })
  }
  const ensureCalibration = async (deviceId: string) => {
    const device = world.observe().devices.find(d => d.id === deviceId)!
    if ((device.calibratedUntil ?? -1) >= now() + 120) return
    if (device.dirty) await command(`clean-for-calibration-${deviceId}-${now()}`, 'facilities', { action: 'clean', deviceId })
    await command(`calibration-${deviceId}-${now()}`, 'facilities', { action: 'calibrate', deviceId })
  }
  const carrier = async (key: string) => {
    for (let wait = 0; ; wait++) {
      signal?.throwIfAborted()
      const robot = world.observeSystems().robots.find(r => r.id === 'robot-1')!
      if (!robot.operationId) {
        if (robot.energy < 60) {
          if (robot.node !== robot.id) await command(`${key}:dock`, 'water', { action: 'move', robotId: robot.id, destination: robot.id })
          await command(`${key}:charge`, 'water', { action: 'charge', robotId: robot.id })
        }
        return
      }
      if (wait >= 300 || now() >= science.stages.profile.finalTick) throw new Error(`Batch carrier unavailable: ${key}`)
      await stepTo(now() + 1)
    }
  }
  const readAssay = (id: string): PublicAssay => {
    const result = world.observe().results.find(r => r.id === id)!
    const measurement = z.record(z.string(), z.json()).parse(world.measurement(id)), raw = world.rawFor(id)
    const fitted = result.methodId === 'confirm' ? fitChromatogram(z.object({ points: z.array(z.number()) }).parse(raw).points) : null
    return { id, methodVersion: result.methodVersion, completedTick: result.completedTick,
      sourceId: world.observeSystems().sampleSources[result.rootSampleId] ?? null, sampleId: result.sampleId,
      value: fitted?.doc ?? z.number().parse(measurement.value), lubricant: fitted?.lubricant ?? 0,
      calibrationAge: z.number().parse(measurement.calibrationAgeTicks ?? 0),
      trajectory: z.array(z.object({ temperature: z.number(), elapsedTicks: z.number() })).parse(measurement.storageTrajectory ?? []) }
  }
  const storeOutputs = async (key: string, ids: string[]) => {
    if (!ids.length) return
    await carrier(key)
    await command(`${key}:store`, 'water', { action: 'transfer', deviceId: 'robot-1', sampleId: ids[0]!, ...(ids.length > 1 ? { additionalSampleIds: ids.slice(1) } : {}), destination: 'cold-2' })
    await command(`${key}:park`, 'water', { action: 'move', robotId: 'robot-1', destination: 'robot-1' })
  }
  const screenBatch: PublicReferencePort['screenBatch'] = async (key, sampleIds) => {
    if (sampleIds.length < 1 || sampleIds.length > 2) throw new Error('Public screen batch requires one or two samples')
    const finished = world.observe().samples.filter(s => s.location === 'screen' && s.volumeUl > 0 && ['screened', 'confirmed', 'reviewed'].includes(s.state))
    if (finished.length) await storeOutputs(`${key}:clear`, finished.map(s => s.id))
    if (new Set(sampleIds.map(id => world.observe().samples.find(s => s.id === id)!.location)).size > 1) {
      for (const id of sampleIds) if (world.observe().samples.find(s => s.id === id)!.location !== 'liquid-handler') {
        await carrier(`${key}:gather:${id}`)
        await transfer(`${key}:gather:${id}`, id, 'liquid-handler')
      }
    }
    await carrier(key)
    await command(`${key}:load`, 'water', { action: 'transfer', deviceId: 'robot-1', sampleId: sampleIds[0]!, ...(sampleIds.length > 1 ? { additionalSampleIds: sampleIds.slice(1) } : {}), destination: 'screen' })
    const results: PublicAssay[] = [], outputs: string[] = []
    // Cargo is batched; the one-sample method still performs and pays for each measurement cycle.
    for (const [index, sampleId] of sampleIds.entries()) {
      if (world.observe().devices.find(d => d.id === 'screen')!.dirty) await command(`${key}:wash:${index}`, 'facilities', { action: 'clean', deviceId: 'screen' })
      await ensureCalibration('screen')
      const volumeUl = world.observe().samples.find(s => s.id === sampleId)!.volumeUl
      const processed = await command(`${key}:process:${index}`, 'water', { action: 'process', deviceId: 'screen', sampleId, volumeUl, methodId: 'screen', methodVersion: 1 })
      const output = z.object({ resultIds: z.array(z.string()).length(1), outputSampleIds: z.array(z.string()).length(1) }).passthrough().parse(processed.result)
      results.push(readAssay(output.resultIds[0]!)); outputs.push(output.outputSampleIds[0]!)
    }
    await storeOutputs(`${key}:output`, outputs)
    return results
  }
  const confirmPrepared: PublicReferencePort['confirmPrepared'] = async (key, sampleId, volumeUl) => {
    if (world.observe().samples.find(s => s.id === sampleId)?.location !== 'confirm') { await carrier(key); await transfer(`${key}:load`, sampleId, 'confirm') }
    if (world.observe().devices.find(d => d.id === 'confirm')!.dirty) await command(`${key}:wash`, 'facilities', { action: 'clean', deviceId: 'confirm' })
    await ensureCalibration('confirm')
    const version = world.observe().methods.find(method => method.id === 'confirm')!.version
    const completed = await command(`${key}:process`, 'water', { action: 'process', deviceId: 'confirm', sampleId, volumeUl, methodId: 'confirm', methodVersion: version })
    const resultId = z.object({ resultIds: z.array(z.string()).length(1) }).passthrough().parse(completed.result).resultIds[0]!
    return readAssay(resultId)
  }
  const assay: PublicReferencePort['assay'] = async (key, input) => {
    if (input.method === 'screen') {
      let sampleId = input.sampleId
      if (!sampleId && input.sourceId) {
        const sampled = await command(`${key}:sample`, 'water', { action: 'sample', sourceId: input.sourceId, volumeUl: 25, container: 'vial' })
        sampleId = `sample:${sampled.id}`
      }
      if (!sampleId) throw new Error('Fast assay requires an actual source or sample')
      return (await screenBatch(key, [sampleId]))[0]!
    }
    await ensureCalibration('confirm')
    const procedure = await runtime.procedures.start({ kind: 'water_assay', actorId: grant.actorId, requestKey: key, providers: ['water', 'facilities'],
      robot: 'robot-1', taskId: 'T1', method: input.method, ...(input.confirmVolumeUl === undefined ? {} : { confirmVolumeUl: input.confirmVolumeUl }), ...(input.sourceId ? { sourceId: input.sourceId } : {}), ...(input.sampleId ? { sampleId: input.sampleId } : {}) })
    for (;;) {
      const current = runtime.procedures.view(procedure!.procedure)!
      if (current.state === 'failed') throw new Error(`Actual assay failed: ${current.detail}`)
      if (now() >= science.stages.profile.finalTick) throw new Error(`Assay ${key} missed final admission at ${now()}: ${current.phase}: ${current.blockedBy ?? current.state}`)
      if (current.state === 'done') {
        return readAssay(runtime.refs.resolve(current.resultIds![0]!))
      }
      if (current.blockedBy?.includes('calibration')) await ensureCalibration('confirm')
      await stepTo(now() + 1)
    }
  }
  const readScan = (id: string): PublicScan => {
    const raw = world.observeSystems().operations.find(o => o.id === id && o.state === 'succeeded')
    if (!raw) throw new Error('Scan has no physical completion')
    const result = scanSchema.parse(raw.result)
    return { id, tick: result.tick, chamberId: result.chamberId, conditions: result.conditions, raw: world.rawFor(`scan:${id}`),
      values: result.values.flatMap(v => v.growthIndex === undefined ? [] : [{ cropId: v.cropId, growthIndex: v.growthIndex }]) }
  }
  return {
    progress: entry => {
      engine.recordFact(grant, 'mars-v06-reference-progress', z.json().parse(entry))
      writeFileSync(join(world.directory, '..', 'reference-progress.json'), JSON.stringify(entry), { mode: 0o600 })
    },
    state: () => {
      const sensors = world.sensors(), lab = world.observe(), systems = world.observeSystems(), operations = engine.list(grant)
      return { tick: sensors.tick, baselineTick: science.stages.profile.baselineTick, finalTick: science.stages.profile.finalTick, horizon: world.horizon,
        methodVersion: lab.methods.find(m => m.id === 'confirm')?.version ?? 1, chambers: sensors.chambers, crops: sensors.crops,
        robots: systems.robots.map(r => ({ id: r.id, node: r.node, energy: r.energy, busy: r.operationId !== null })),
        devices: lab.devices.map(d => ({ id: d.id, kind: d.kind, dirty: d.dirty, broken: d.broken,
          calibratedUntil: d.calibratedUntil ?? null, busy: operations.some(o => !['failed', 'succeeded', 'cancelled'].includes(o.state) && o.resources.includes(`laboratory:device:${d.id}`)) })),
        batches: lab.batches.filter(b => b.disposition === 'available' && b.expiresAt >= sensors.tick).map(b => ({ id: b.id, kind: b.kind, units: b.units })),
        samples: lab.samples.map(s => ({ id: s.id, location: s.location, state: s.state, volumeUl: s.volumeUl,
          busy: operations.some(o => !['failed', 'succeeded', 'cancelled'].includes(o.state) && o.resources.includes(`laboratory:sample:${s.id}`)) })),
        inlineDoc: sensors.water.inlineDoc, waterRoute: sensors.water.irrigationSource, solar: sensors.energy.solar, soc: sensors.energy.batteryCharge, tankUl: sensors.water.tankUl }
    },
    onTick: callback => { onTick = callback }, completedScans: planId => {
      const plan = publicPlans.list().find(p => p.id === planId)
      return Object.values(plan?.operations ?? {}).filter(id => world.observeSystems().operations.some(o => o.id === id && o.state === 'succeeded' && o.command.action === 'scan')).map(readScan)
    },
    completedAssays: planId => {
      const plan = publicPlans.list().find(p => p.id === planId)
      const operations = new Set(Object.values(plan?.operations ?? {}))
      return world.observe().results.filter(result => operations.has(result.operationId) && ['screen', 'confirm'].includes(result.methodId)).map(result => readAssay(result.id))
    },
    waitUntil: target => stepTo(Math.min(target, world.horizon)), command, assay, screenBatch, confirmPrepared,
    aliquot: async (key, sampleId, volumeUl) => {
      await transfer(`${key}:to-handler`, sampleId, 'liquid-handler')
      const operation = await command(key, 'water', { action: 'aliquot', deviceId: 'liquid-handler', sampleId, volumeUl, container: 'vial' })
      return z.object({ outputSampleId: z.string() }).parse(operation.result).outputSampleId
    }, store: transfer,
    split: async key => {
      const procedure = await runtime.procedures.start({ kind: 'water_split', actorId: grant.actorId, requestKey: key, providers: ['water', 'facilities'],
        robot: 'robot-1', taskId: 'T1', sourceId: 'reservoir', storage: ['cold-2', 'bench'], copies: 2 })
      for (;;) {
        const current = runtime.procedures.view(procedure!.procedure)!
        if (current.state === 'failed') throw new Error(`Actual split failed: ${current.detail}`)
        if (now() >= science.stages.profile.finalTick) throw new Error(`Split ${key} missed final admission at ${now()}: ${current.phase}: ${current.blockedBy ?? current.state}`)
        if (current.state === 'done') {
          const samples = current.sampleIds!.map(id => world.observe().samples.find(s => s.id === runtime.refs.resolve(id))!)
          return { byStorage: { 'cold-2': samples.filter(s => s.location === 'cold-2').map(s => s.id), bench: samples.filter(s => s.location === 'liquid-handler').map(s => s.id) } }
        }
        await stepTo(now() + 1)
      }
    },
    scan: async (key, chamberId) => readScan((await command(key, 'greenhouse', { action: 'scan', chamberId })).id),
    analyze: async code => {
      const run = await runtime.analysis.run(grant.actorId, now(), code, analysisBindings({ engine, admin: grant, world, archive: runtime.archive }, grant))
      if (run.status !== 'done') throw new Error(run.error ?? 'Reference analysis failed')
      engine.recordFact(grant, 'mars-v06-analysis-published', { id: run.id, tick: now() })
      return { id: run.id, output: run.output }
    },
    catalog: () => ({ handover: science.catalog().handover.map(r => ({ id: r.id, content: r.content })), services: science.manifest.commissions.map(c => ({ id: c.id, sourceId: c.sourceId, deadline: c.deadline })) }),
    registerModel: (key, model) => records.registerModel(key, model), commit: (key, prediction) => records.commitPrediction(key, prediction), submit: (key, value) => records.submit(key, value),
    schedule: (key, value) => {
      const lab = world.observe(), capacities = Object.fromEntries([...lab.devices.map(d => [`laboratory:device:${d.id}`, 1] as const),
        ...lab.samples.map(s => [`laboratory:sample:${s.id}`, 1] as const), ...lab.batches.map(b => [`mars:batch:${b.id}`, 1] as const),
        ...['reservoir', 'filter', 'pump'].map(id => [`mars:source:${id}`, 1] as const), ...['mars:water-route', 'mars:solar-array'].map(id => [id, 1] as const)])
      for (const c of world.sensors().chambers) { capacities[`mars:sensor:${c.id}`] = 1; capacities[`mars:seal:${c.id}`] = 1 }
      for (const id of ['reservoir', 'filter', 'pump']) capacities[`mars:sensor:${id}`] = 1
      const plan = new V05Planning(engine, grant, now, capacities, { resourcesOf: planResources }, 'v06').schedule(key, value)
      return { id: plan.id, createdTick: plan.createdTick }
    }, actionForecast: (key, value) => actions.commit(key, value),
  }
}

/** Run only keyless environment profiles. This is a feasibility strategy, not an LLM performance result. */
export async function runReferenceFeasibility(ctx: Context, config: Config, options: { signal?: AbortSignal; failFast?: boolean } = {}) {
  if (config.mode !== 'environment' || config.benchmarkVersion !== 'v0.6' || config.implementation !== 'scientific_candidate') throw new Error('Reference requires a keyless v0.6 scientific environment')
  const runtime = await mountMars(ctx, config), port = referencePort(runtime, options.signal)
  let policy: Awaited<ReturnType<typeof runPublicReference>> | null = null, failure: string | null = null
  try {
    try { policy = await runPublicReference(port) }
    catch (error) {
      failure = error instanceof Error ? error.message : String(error); port.onTick(null)
      if (options.signal?.aborted || options.failFast) {
        writeFileSync(join(config.directory, 'feasibility-report.json'), JSON.stringify({ version: 'v0.6-reference', modelCalls: 0,
          policyCompleted: false, failure: `${options.signal?.aborted ? 'Host abort' : 'Public strategy error'} at tick ${runtime.world.observe().tick}: ${failure}`,
          stack: error instanceof Error ? error.stack : null, jointFeasibility: false, score: null }, null, 2), { mode: 0o600 })
        throw error
      }
      await runtime.advanceScientificTo(runtime.world.horizon)
    }
    const score = z.record(z.string(), z.json()).parse(await runtime.finalize())
    const operations = runtime.engine.list(runtime.engine.issueContext('mars', 'reference-report', []))
    const runIdentity = z.object({ sourceHash: z.string(), caseManifestHash: z.string(), protocolHash: z.string() })
      .parse(JSON.parse(readFileSync(join(config.directory, 'manifest.public.json'), 'utf8')))
    const report = { version: 'v0.6-reference', ...runIdentity, modelCalls: 0, referenceCase: { condition: config.scienceProfile?.condition ?? 'G0', seed: config.seed }, scope: 'public observations and actual shared-world operations; no matched LLM compute budget',
      policyCompleted: policy !== null, failure, jointFeasibility: score.F === true, score, policy,
      physicalOperations: operations.length, succeeded: operations.filter(o => o.state === 'succeeded').length, failed: operations.filter(o => o.state === 'failed').length }
    writeFileSync(join(config.directory, 'feasibility-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    return report
  } finally { await runtime.close() }
}
