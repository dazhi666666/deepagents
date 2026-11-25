/** Public-only scripted research closure. This module never receives a world, truth or evaluator object. */
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { ResearchPut } from './research-records.ts'
export interface ReferenceAssay { id: string; tick: number; doc: number; referenceDoc: number; analysisId: string; resultId: string; methodVersion: number; exposureTicks: number }
export interface ReferencePublicPort {
  snapshot(): { tick: number; methodVersion: number; announcement: boolean }
  assay(key: string): Promise<ReferenceAssay | null>
  publish(key: string, input: ResearchPut): unknown
  registerModel(key: string, input: { id: string; code: string; parameters: Json; inputSchema: Json; outputSchema: Json; runtimeVersion: string; basedOn: { id: string; revision: number }[] }): unknown
  commit(key: string, input: { id: string; target: string; modelId: string; inputDomain: Json }): unknown
  observe(key: string, input: { objectiveId: string; value: Json; evidence: { id: string; purpose: string }[]; predictionId?: string }): unknown
  energy(): number
}
export class PublicResearchReference {
  phase: 'baseline' | 'await-method' | 'revision' | 'validation' | 'done' = 'baseline'
  readonly trace: { tick: number; event: string; refs: string[] }[] = []
  readonly assays: ReferenceAssay[] = []
  constructor(private readonly port: ReferencePublicPort) {}
  async step() {
    const view = this.port.snapshot()
    if (this.phase === 'done') return
    if (this.phase === 'await-method') {
      if (!view.announcement || view.methodVersion <= 1) return
      this.trace.push({ tick: view.tick, event: 'public-method-announcement', refs: [] }); this.phase = 'revision'
    }
    const key = this.phase
    const assay = await this.port.assay(key)
    if (!assay) return
    this.assays.push(assay)
    this.trace.push({ tick: view.tick, event: `${key}-actual-assay-analysis`, refs: [assay.resultId, assay.analysisId] })
    const correction = assay.referenceDoc / assay.doc
    if (key === 'baseline') {
      this.port.publish('water-baseline', { id: 'water-calibration', expectedRevision: 0, kind: 'claim', project: 'PW', content: { correction, methodVersion: assay.methodVersion },
        evidence: [{ id: assay.analysisId, purpose: 'calibration' }], reason: 'Current raw chromatogram compared to independent public reference' })
      this.port.publish('plant-baseline', { id: 'plant-water-interpretation', expectedRevision: 0, kind: 'study', project: 'PG', content: { correction, scope: 'water input interpretation; not a crop-growth model' },
        basedOn: [{ id: 'water-calibration', revision: 1 }], reason: 'Plant exposure analysis depends on the water measurement interpretation' })
      this.port.publish('energy-baseline', { id: 'energy-observation', expectedRevision: 0, kind: 'claim', project: 'PF', content: { observedSolar: this.port.energy(), scope: 'unrelated energy observation' },
        reason: 'Preserve independent energy evidence when the water method changes' })
      this.phase = 'await-method'
    } else if (key === 'revision') {
      this.port.publish('water-revision', { id: 'water-calibration', expectedRevision: 1, kind: 'claim', project: 'PW', content: { correction, methodVersion: assay.methodVersion },
        evidence: [{ id: assay.analysisId, purpose: 'calibration' }], reason: 'New method requires a newly measured correction, not a global invalidation' })
      this.port.publish('plant-revision', { id: 'plant-water-interpretation', expectedRevision: 1, kind: 'study', project: 'PG', content: { correction, scope: 'water input interpretation; not a crop-growth model' },
        basedOn: [{ id: 'water-calibration', revision: 2 }], reason: 'Use the revised input interpretation in subsequent plant exposure work' })
      // Explicit empirical exposure correction: a constant correction cannot transfer across different queue lengths.
      const decayPerTick = Math.log(correction) / Math.max(1, assay.exposureTicks)
      this.port.registerModel('revised-model', { id: 'water-model-v2', code: 'return { prediction: input.signal * Math.exp(parameters.decayPerTick * input.exposureTicks) }', parameters: { decayPerTick },
        inputSchema: { type: 'object', required: ['signal', 'exposureTicks'], properties: { signal: { type: 'number' }, exposureTicks: { type: 'number', minimum: 0 } }, additionalProperties: false },
        outputSchema: { type: 'object', required: ['prediction'], properties: { prediction: { type: 'number' } }, additionalProperties: false },
        runtimeVersion: 'mars-model-v1', basedOn: [{ id: 'water-calibration', revision: 2 }, { id: 'plant-water-interpretation', revision: 2 }] })
      this.port.commit('revised-prediction', { id: 'water-independent-prediction', target: 'PW-01:holdout', modelId: 'water-model-v2', inputDomain: { source: 'reservoir', methodVersion: assay.methodVersion } })
      this.port.observe('prediction-selection', { objectiveId: 'water-independent-validation', value: null, evidence: [{ id: assay.analysisId, purpose: 'validation' }], predictionId: 'water-independent-prediction' })
      this.trace.push({ tick: view.tick, event: 'selective-revision-and-frozen-prediction', refs: ['water-calibration@2', 'plant-water-interpretation@2', 'energy-observation@1'] })
      this.phase = 'validation'
    } else {
      this.trace.push({ tick: view.tick, event: 'independent-current-assay', refs: [assay.resultId] })
      this.phase = 'done'
    }
  }
}
