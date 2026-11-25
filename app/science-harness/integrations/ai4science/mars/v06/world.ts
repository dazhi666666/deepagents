/** v0.6 instrument quality and controls commit in the existing Mars SQLite transaction. */
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { laboratorySampleIds } from '../../greenhouse/laboratory/commands.ts'
import { laboratoryStateSchema, type LaboratoryCommand, type LaboratoryOperation, type LaboratoryScenario, type LaboratoryState } from '../../greenhouse/laboratory/schema.ts'
import { LaboratoryRefusal } from '../../greenhouse/laboratory/world.ts'
import { MarsWorld, marsSystemStateSchema, type MarsRules } from '../world.ts'
import { baseStateSchema, inlineOffset, waterQuality } from '../base.ts'
import type { Truth } from '../truth.ts'
import { contentHash, tickSchema, type StageProfile } from './contracts.ts'
import { clean, contact, fastResponse, measureV06, qualityStateSchema, type QualityState } from './measurement-quality.ts'
import type { ScienceProfile } from './profile.ts'

export const CERTIFICATES = [{ id: 'qc-blank', concentrationMgL: 0 }, { id: 'qc-low', concentrationMgL: 2 }, { id: 'qc-high', concentrationMgL: 8 }] as const

interface Projection<T> { raw: string; copy(): T }
/** Every read checks authoritative SQLite bytes; only unchanged JSON parsing is reused. */
function readProjection<T>(db: DatabaseSync, table: 'world' | 'mars_state' | 'mars_base' | 'mars_v06_quality', previous: Projection<T> | undefined, schema: z.ZodType<T>): Projection<T> {
  const row = z.object({ state: z.string() }).parse(db.prepare(`SELECT state FROM ${table} WHERE id=1`).get())
  if (previous?.raw === row.state) return previous
  const normalized = JSON.stringify(schema.parse(JSON.parse(row.state)))
  return { raw: row.state, copy: () => JSON.parse(normalized) }
}
export class V06World extends MarsWorld {
  private readonly clockColumn = this.db.prepare("SELECT json_extract(state,'$.tick') AS tick FROM world WHERE id=1")
  /** Read the same committed device clock without decoding all samples and operations. */
  currentTick(): number { return tickSchema.parse(this.clockColumn.get()?.tick) }
  private laboratoryProjection: Projection<LaboratoryState> | undefined
  private systemProjection: Projection<z.infer<typeof marsSystemStateSchema>> | undefined
  private baseProjection: Projection<z.infer<typeof baseStateSchema>> | undefined
  private qualityProjection: Projection<QualityState> | undefined
  override observe(): LaboratoryState {
    this.laboratoryProjection = readProjection(this.db, 'world', this.laboratoryProjection, laboratoryStateSchema)
    return this.laboratoryProjection.copy()
  }
  override observeSystems() {
    this.systemProjection = readProjection(this.db, 'mars_state', this.systemProjection, marsSystemStateSchema)
    return this.systemProjection.copy()
  }
  override observeBase() {
    this.baseProjection = readProjection(this.db, 'mars_base', this.baseProjection, baseStateSchema)
    return this.baseProjection.copy()
  }
  constructor(directory: string, scenario: LaboratoryScenario, rules: MarsRules, truth: Truth,
    readonly scienceProfile: ScienceProfile, readonly stages: StageProfile) {
    super(directory, scenario, rules, truth)
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS mars_v06_quality(id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)')
      const existing = this.db.prepare('SELECT state FROM mars_v06_quality WHERE id=1').get()
      const configHash = contentHash({ scienceProfile, stages })
      if (existing) {
        if (this.quality().configHash !== configHash) throw new Error('Scientific instrument profile changed')
      } else {
        if (this.observe().tick !== 0) throw new Error('Cannot attach v0.6 quality to an old world')
        const initialResidual = scienceProfile.condition === 'G1' && truth.seed % 2 === 0 && scienceProfile.residualEnabled ? 0.8 : 0
        const state: QualityState = { configHash, residual: initialResidual, initialResidual, contacts: {}, cleanings: [], trajectories: {}, snapshots: {} }
        this.db.prepare('INSERT INTO mars_v06_quality VALUES(1,?)').run(JSON.stringify(state))
        this.update(() => {
          const base = this.observeBase()
          for (const certificate of CERTIFICATES) base.samples[certificate.id] = { kind: 'water', source: `control:${certificate.id}`,
            doc: certificate.concentrationMgL, decay: 1, lubricant: 0, sampledTick: 0 }
          this.db.prepare('UPDATE mars_base SET state=? WHERE id=1').run(JSON.stringify(baseStateSchema.parse(base)))
        })
      }
    } catch (error) { this.close(); throw error }
  }
  /** Host/evaluator only. No public device object or tool serializes this state. */
  quality(): QualityState {
    this.qualityProjection = readProjection(this.db, 'mars_v06_quality', this.qualityProjection, qualityStateSchema)
    return this.qualityProjection.copy()
  }
  private saveQuality(state: QualityState) { this.db.prepare('UPDATE mars_v06_quality SET state=? WHERE id=1').run(JSON.stringify(qualityStateSchema.parse(state))) }
  private cleaningRefusal(state: LaboratoryState): string | undefined {
    const cleaner = state.batches.find(batch => batch.id === 'qc-cleaning')
    return state.facilities.waterUl < this.scienceProfile.cleaningWaterUl || !cleaner || cleaner.units < 1 ? 'Cleaning requires available water and a cleaning unit' : undefined
  }
  protected override validateExtension(state: LaboratoryState, command: LaboratoryCommand) {
    super.validateExtension(state, command)
    if (command.action === 'clean' && ['screen', 'confirm'].includes(command.deviceId)) {
      const error = this.cleaningRefusal(state)
      if (error) throw new LaboratoryRefusal('supply', error)
    }
  }
  protected override operationFailureExtension(state: LaboratoryState, operation: LaboratoryOperation) {
    const prior = super.operationFailureExtension(state, operation)
    if (prior) return prior
    if (operation.command.action === 'clean' && operation.stage === 'loading' && ['screen', 'confirm'].includes(operation.command.deviceId)) return this.cleaningRefusal(state)
    return undefined
  }
  protected override processingDuration(state: LaboratoryState, operation: LaboratoryOperation, duration: number) {
    const command = operation.command
    if (command.action === 'process' && command.deviceId === 'confirm' && command.methodId === 'confirm') {
      const base = this.observeBase(), concentrations = laboratorySampleIds(command).map(id => base.samples[id])
      if (concentrations.every(sample => sample?.kind === 'water')) {
        const quality = this.quality()
        contact(quality, operation.id, concentrations.map(sample => sample!.kind === 'water' ? sample.doc * sample.decay : 0), state.tick, this.scienceProfile)
        this.saveQuality(quality)
      }
    }
    if (command.action === 'clean' && ['screen', 'confirm'].includes(command.deviceId)) {
      state.facilities.waterUl -= this.scienceProfile.cleaningWaterUl
      state.batches.find(batch => batch.id === 'qc-cleaning')!.units--
      operation.consumedWaterUl += this.scienceProfile.cleaningWaterUl
      operation.consumedBatches.push({ batchId: 'qc-cleaning', units: 1 })
    }
    return super.processingDuration(state, operation, duration)
  }
  protected override finishExtension(state: LaboratoryState, operation: LaboratoryOperation) {
    super.finishExtension(state, operation)
    if (operation.state !== 'succeeded') return
    const command = operation.command
    if (command.action === 'clean' && command.deviceId === 'confirm') {
      const quality = this.quality(); clean(quality, operation.id, this.scienceProfile); this.saveQuality(quality)
    }
    if (command.action === 'process') {
      const base = this.observeBase(), device = state.devices.find(d => d.id === command.deviceId)!
      const calibrationAge = device.calibratedUntil === undefined ? null : state.tick - (device.calibratedUntil - this.scenario.calibrationLifetimeTicks)
      const qualityState = this.quality()
      for (const id of operation.resultIds ?? []) {
        const result = state.results.find(r => r.id === id)!
        const sample = base.samples[result.sampleId]
        if (result.outputSampleId) qualityState.trajectories[result.outputSampleId] = structuredClone(qualityState.trajectories[result.sampleId] ?? [])
        if (!sample || !['screen', 'confirm', 'image'].includes(result.methodId)) continue
        const ordinal = state.results.filter(r => r.methodId === result.methodId).findIndex(r => r.id === id)
        const noiseKey = contentHash({ channel: 'laboratory', source: sample.kind === 'water' ? sample.source : sample.cropId,
          device: command.deviceId, method: result.methodId, version: result.methodVersion, acceptedTick: operation.acceptedTick, tick: state.tick, ordinal })
        const output = measureV06(this.truth, base, { resultId: id, sampleId: result.sampleId, methodId: result.methodId, noiseKey,
          methodVersion: result.methodVersion, batchIds: result.batchIds, tick: state.tick, calibrationAge }, this.scienceProfile,
          this.quality().contacts[operation.id]?.used ?? 0)
        this.db.prepare('INSERT OR REPLACE INTO mars_measurements VALUES(?,?)').run(id, JSON.stringify({ ...z.record(z.string(), z.json()).parse(output.measurement),
          storageTrajectory: qualityState.trajectories[result.sampleId] ?? [], batchIds: result.batchIds }))
        if (output.raw) this.db.prepare('INSERT OR REPLACE INTO mars_raw VALUES(?,?)').run(id, JSON.stringify(output.raw))
      }
      this.saveQuality(qualityState)
    }
  }
  protected override advanceExtension(state: LaboratoryState, previous: LaboratoryState) {
    super.advanceExtension(state, previous)
    const base = this.observeBase()
    for (const source of ['reservoir', 'filter', 'pump']) this.db.prepare('UPDATE mars_telemetry SET value=? WHERE tick=? AND channel=?')
      .run(this.inlineReading(source, state, base), state.tick, `${source}.doc_inline`)
    for (const sample of Object.values(base.samples)) if (sample.kind === 'water' && sample.source.startsWith('control:')) sample.decay = 1
    this.db.prepare('UPDATE mars_base SET state=? WHERE id=1').run(JSON.stringify(baseStateSchema.parse(base)))
    const publicTrace = this.quality()
    for (const sample of state.samples) {
      const truth = base.samples[sample.id]
      if (truth?.kind !== 'water' || truth.source.startsWith('control:') || sample.volumeUl <= 0) continue
      const trace = publicTrace.trajectories[sample.id] ??= structuredClone(sample.parentId ? publicTrace.trajectories[sample.parentId] ?? [] : [])
      const temperature = sample.location === 'robot-2' ? 4 : state.devices.find(d => d.id === sample.location)?.temperature ?? state.facilities.ambientTemperature
      const last = trace.at(-1)
      if (last?.temperature === temperature) last.elapsedTicks++
      else trace.push({ temperature, elapsedTicks: 1 })
    }
    this.saveQuality(publicTrace)
    if ([this.stages.baselineTick, this.stages.finalTick, this.stages.horizon].includes(state.tick)) {
      const quality = this.quality()
      quality.snapshots[String(state.tick)] = z.json().parse({ crops: this.observeSystems().crops, metrics: base.metrics,
        water: waterQuality(this.truth, base, state.tick), energy: base.energy, samples: state.samples,
        ...(this.stages.jointTrial && state.tick === this.stages.horizon ? { jointEnergy: this.db.prepare(
          `SELECT COUNT(*) AS ticks, SUM(value) AS delivered FROM mars_telemetry WHERE channel='energy.demand' AND tick>? AND tick<=?`
        ).get(this.stages.finalTick, state.tick) } : {}) })
      this.saveQuality(quality)
    }
  }
  /** Host-only prospective/realized action snapshots; never exposed through tool projections. */
  captureAction(id: string, phase: 'before' | 'after') {
    const key = `action:${id}:${phase}`
    this.update(state => {
      const quality = this.quality()
      if (quality.snapshots[key] !== undefined) return
      quality.snapshots[key] = z.json().parse({ tick: state.tick, water: waterQuality(this.truth, this.observeBase(), state.tick),
        residual: quality.residual, inlineOffsets: ['reservoir', 'filter', 'pump'].map(id => inlineOffset(this.truth, this.observeBase(), id, state.tick)), samples: state.samples, methodVersion: state.methods.find(m => m.id === 'confirm')?.version ?? 0 })
      this.saveQuality(quality)
    })
  }
  private inlineReading(source: string, state: LaboratoryState, base: ReturnType<MarsWorld['observeBase']>) {
    const water = waterQuality(this.truth, base, state.tick)
    return Number((fastResponse(this.truth, water[source as 'reservoir' | 'filter' | 'pump'], `${this.truth.seed}:inline:${source}:${state.tick}`, this.scienceProfile) +
      inlineOffset(this.truth, base, source, state.tick)).toFixed(4))
  }
  override sensors() {
    const visible = super.sensors(), state = this.observe(), base = this.observeBase()
    visible.water.inlineDoc = Object.fromEntries(['reservoir', 'filter', 'pump'].map(source => [source, this.inlineReading(source, state, base)]))
    return visible
  }
  protected override get includeScanConditions(): boolean { return true }
  protected override observationKey(operationId: string, channel: string, tick: number): string {
    const operations = this.observeSystems().operations, operation = operations.find(o => o.id === operationId)
    if (!operation) throw new Error('Physical observation has no accepted operation')
    const target = (o: (typeof operations)[number]) => o.command.action === 'scan' ? o.command.chamberId : o.command.action === 'device_reference' ? o.command.targetId : o.command.action
    const ordinal = operations.filter(o => o.command.action === operation.command.action && target(o) === target(operation)).findIndex(o => o.id === operationId)
    return contentHash({ channel, target: target(operation), acceptedTick: operation.acceptedTick, tick, ordinal })
  }
  protected override waterReference(targetId: string, operationId: string, state: LaboratoryState, base: ReturnType<MarsWorld['observeBase']>): Json {
    const quality = waterQuality(this.truth, base, state.tick)
    const concentration = quality[targetId as 'reservoir' | 'filter' | 'pump']
    return { targetId, reference: { docInline: fastResponse(this.truth, concentration, `${this.truth.seed}:${this.observationKey(operationId, 'reference', state.tick)}`, this.scienceProfile) },
      tick: state.tick, specification: 'Biased fast probe. Calibrate using certified fast-channel standards; this is not an unknown-sample truth interface.' }
  }
}
