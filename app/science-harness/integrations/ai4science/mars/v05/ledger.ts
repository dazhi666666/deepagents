/** Public physical ledger. Captures observations, never private sample concentration or evaluator truth. */
import { createHash } from 'node:crypto'
import type { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import { canonicalJson, type Json, type OperationContext } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from '../world.ts'

export class V05Ledger {
  constructor(private readonly engine: ExecutionEngine, private readonly context: OperationContext, private readonly world: MarsWorld) {}
  /** Call after each actual world event and after operation queries publish results. */
  capture() {
    const lab = this.world.observe(), systems = this.world.observeSystems(), sensors = this.world.sensors()
    const snapshot = {
      tick: lab.tick,
      samples: lab.samples.map(sample => ({ id: sample.id, parentId: sample.parentId ?? null, location: sample.location, volumeUl: sample.volumeUl,
        state: sample.state, exposureTicks: sample.exposureTicks, batchIds: sample.batchIds, disposition: sample.disposition })),
      laboratory: lab.operations.map(op => ({ id: op.id, command: op.command, state: op.state, stage: op.stage, acceptedTick: op.acceptedTick,
        completedTick: op.completedTick ?? null, consumedUl: op.consumedUl, consumedWaterUl: op.consumedWaterUl, consumedBatches: op.consumedBatches,
        outputSampleIds: op.outputSampleIds ?? (op.outputSampleId ? [op.outputSampleId] : []), resultIds: op.resultIds ?? (op.resultId ? [op.resultId] : []) })),
      systems: systems.operations.map(op => ({ id: op.id, command: op.command, state: op.state, acceptedTick: op.acceptedTick, completedTick: op.completedTick ?? null })),
      execution: this.engine.list(this.context).map(op => ({ id: op.id, actorId: op.actorId, requestKey: op.requestKey, resources: op.resources,
        state: op.state, artifacts: op.artifacts.map(artifact => artifact.id) })),
      devices: lab.devices.map(device => ({ id: device.id, targetTemperature: device.targetTemperature ?? null, enabled: device.enabled, broken: device.broken })),
      robots: systems.robots.map(robot => ({ id: robot.id, energy: robot.energy, operationId: robot.operationId })),
      energy: sensors.energy, water: { tankUl: sensors.water.tankUl, reserveUl: sensors.water.reserveUl },
      batches: lab.batches.map(batch => ({ id: batch.id, units: batch.units })),
      chamberReadings: sensors.chambers.map(chamber => ({ id: chamber.id, temperatureReading: chamber.temperatureReading })),
    }
    const value = JSON.parse(JSON.stringify(snapshot)) as Json
    const hash = createHash('sha256').update(canonicalJson(value)).digest('hex')
    if (!this.engine.readFacts(this.context).some(fact => fact.kind === 'mars-v05-ledger' && (fact.data as { hash?: string }).hash === hash))
      this.engine.recordFact(this.context, 'mars-v05-ledger', { hash, snapshot: value })
    return snapshot
  }
  snapshots() { return this.engine.readFacts(this.context).filter(fact => fact.kind === 'mars-v05-ledger').map(fact => (fact.data as unknown as { snapshot: ReturnType<V05Ledger['capture']> }).snapshot) }
  report() {
    const snapshots = this.snapshots()
    const timings = new Map<string, { id: string; sampled_at: number | null; prepared_at: number | null; assay_started_at: number | null; assay_completed_at: number | null; result_available_at: number | null }>()
    const measurements = new Map<string, { operation_id: string; sample_id: string; method: string; method_version: number; assay_started_at: number | null; assay_completed_at: number | null; result_available_at: number | null }>()
    const timing = (id: string) => { let value = timings.get(id); if (!value) { value = { id, sampled_at: null, prepared_at: null, assay_started_at: null, assay_completed_at: null, result_available_at: null }; timings.set(id, value) } return value }
    for (const snapshot of snapshots) {
      for (const op of snapshot.systems) if (op.command.action === 'sample' && op.state === 'succeeded' && op.completedTick !== null) timing(`sample:${op.id}`).sampled_at = op.completedTick
      for (const op of snapshot.laboratory) {
        if (!('sampleId' in op.command)) continue
        const sample = timing(op.command.sampleId)
        if (op.command.action === 'process') {
          if (op.command.methodId === 'water-prepare' && op.state === 'succeeded') {
            sample.prepared_at = op.completedTick
            for (const id of op.outputSampleIds) timing(id).prepared_at = op.completedTick
          }
          if (op.command.methodId === 'confirm' || op.command.methodId === 'screen' || op.command.methodId === 'image') {
            // The first observed processing transition is exact when capture follows each event;
            // absent transition observations stay null instead of inventing a start timestamp.
            if (op.stage === 'processing' && sample.assay_started_at === null) sample.assay_started_at = snapshot.tick
            if (op.state === 'succeeded') sample.assay_completed_at = op.completedTick
            if (snapshot.execution.some(v => v.id === op.id && v.state === 'succeeded' && v.artifacts.length) && sample.result_available_at === null) sample.result_available_at = snapshot.tick
            let measurement = measurements.get(op.id)
            if (!measurement) { measurement = { operation_id: op.id, sample_id: op.command.sampleId, method: op.command.methodId, method_version: op.command.methodVersion,
              assay_started_at: null, assay_completed_at: null, result_available_at: null }; measurements.set(op.id, measurement) }
            if (op.stage === 'processing' && measurement.assay_started_at === null) measurement.assay_started_at = snapshot.tick
            if (op.state === 'succeeded') measurement.assay_completed_at = op.completedTick
            if (snapshot.execution.some(v => v.id === op.id && v.state === 'succeeded' && v.artifacts.length) && measurement.result_available_at === null) measurement.result_available_at = snapshot.tick
          }
        }
      }
    }
    const parents = new Map(snapshots.flatMap(snapshot => snapshot.samples.filter(sample => sample.parentId !== null).map(sample => [sample.id, sample.parentId!] as const)))
    for (const sample of timings.values()) {
      let parent = parents.get(sample.id); const visited = new Set([sample.id])
      while (parent && !visited.has(parent)) { visited.add(parent); const inherited = timings.get(parent)
        if (sample.sampled_at === null && inherited?.sampled_at !== null && inherited?.sampled_at !== undefined) sample.sampled_at = inherited.sampled_at
        if (sample.prepared_at === null && inherited?.prepared_at !== null && inherited?.prepared_at !== undefined) sample.prepared_at = inherited.prepared_at
        parent = parents.get(parent)
      }
    }
    return { schemaVersion: 1, semantics: 'observed-public-facts', timingRequirement: 'capture after each world event and result publication',
      samples: [...timings.values()], measurements: [...measurements.values()], snapshots, latestTick: snapshots.at(-1)?.tick ?? null }
  }
}
