/** Shared physical evidence predicates for preflight and sealed evaluation. */
import { z } from 'zod'
import type { AnalysisRegistry } from '../analysis.ts'
import type { CaseGroup } from './cases.ts'
import type { Submission, TaskId } from './contracts.ts'
import type { V06World } from './world.ts'

type EvidenceInput = Pick<Submission, 'evidence' | 'acceptedTick'>
type EvidenceWorld = Pick<V06World, 'observe' | 'observeSystems' | 'observeBase'>

const water = 'Cite a current source-water screen or confirm result.'
const calibration = 'Cite measurements of at least two distinct certified concentrations.'
const storage = 'Cite two measurement ticks on distinct descendants of one mother sample and transfers across two storage temperatures.'
const energy = 'Cite a completed analysis that accessed actual energy.solar or energy.soc telemetry.'

/** Inspect an as-of world projection. Returned diagnostics contain evidence checks, not labels or predictions. */
export function createEvidenceView(world: EvidenceWorld, analysis: Pick<AnalysisRegistry, 'get'>, coreCrops: readonly string[]) {
  const lab = world.observe(), systems = world.observeSystems(), base = world.observeBase()
  const citedResults = (submission: EvidenceInput | null) => submission ? submission.evidence.flatMap(e => {
    const result = lab.results.find(r => r.id === e.id && r.completedTick <= submission.acceptedTick)
    return result && !lab.revocations.some(v => v.resultId === result.id && v.tick <= submission.acceptedTick) ? [result] : []
  }) : []
  const waterResults = (submission: EvidenceInput | null) => citedResults(submission).filter(r => {
    const sample = base.samples[r.sampleId]
    return sample?.kind === 'water' && ['screen', 'confirm'].includes(r.methodId)
  })
  const unknownWater = (submission: EvidenceInput | null) => waterResults(submission).filter(r => {
    const sample = base.samples[r.sampleId]
    return sample?.kind === 'water' && !sample.source.startsWith('control:')
  })
  const calibrations = (submission: EvidenceInput | null) => new Set(waterResults(submission).flatMap(r => {
    const sample = base.samples[r.sampleId]
    return sample?.kind === 'water' && sample.source.startsWith('control:') ? [sample.doc] : []
  })).size >= 2
  const telemetryAnalysis = (submission: EvidenceInput | null, demandOnly = false) => Boolean(submission?.evidence.some(e => {
    const run = analysis.get(e.id)
    return run?.status === 'done' && run.asOfTick <= submission.acceptedTick
      && run.dataAccesses?.some(access => {
        if (access.kind !== 'telemetry') return false
        if (!demandOnly) return /energy\.(solar|soc)/.test(access.id)
        const range = z.object({ channels:z.array(z.string()), from:z.number(), to:z.number() }).safeParse(JSON.parse(access.id))
        return range.success && range.data.channels.includes('energy.demand') && Math.max(1,range.data.from) <= Math.min(range.data.to,run.asOfTick)
      })
  }))
  const storageEvidence = (submission: EvidenceInput | null) => {
    const results = unknownWater(submission)
    for (const root of new Set(results.map(r => r.rootSampleId))) {
      const rows = results.filter(r => r.rootSampleId === root)
      if (new Set(rows.map(r => r.sampleId)).size < 2 || new Set(rows.map(r => r.completedTick)).size < 2) continue
      const family = new Set(lab.samples.filter(sample => {
        let current = sample
        while (current.parentId) {
          const parent = lab.samples.find(s => s.id === current.parentId)
          if (!parent) break
          current = parent
        }
        return current.id === root
      }).map(s => s.id))
      const temperatures = new Set(lab.operations.flatMap(o => {
        const c = o.command
        return o.state === 'succeeded' && c.action === 'transfer' && family.has(c.sampleId)
          ? [lab.devices.find(d => d.id === c.destination)?.targetTemperature ?? lab.facilities.ambientTemperature] : []
      }))
      if (temperatures.size >= 2) return true
    }
    return false
  }
  const cropLightCoverage = (submission: EvidenceInput | null) => coreCrops.map(cropId => {
    const chamber = `incubator-${cropId.split('-')[1]}`
    const scans = submission?.evidence.flatMap(e => systems.operations.filter(o => o.id === e.id && o.state === 'succeeded'
      && o.command.action === 'scan' && o.command.chamberId === chamber && (o.completedTick ?? Infinity) <= submission.acceptedTick)) ?? []
    const levels = scans.map(scan => {
      const latest = systems.operations.findLast(o => o.state === 'succeeded' && o.command.action === 'light'
        && o.command.chamberId === chamber && (o.completedTick ?? Infinity) <= (scan.completedTick ?? 0))
      return latest?.command.action === 'light' ? latest.command.level : 70
    })
    const imageLevels = citedResults(submission).flatMap(r => {
      const sample = base.samples[r.sampleId]
      if (r.methodId !== 'image' || sample?.kind !== 'crop' || sample.cropId !== cropId) return []
      const parsed = z.object({ light: z.number() }).safeParse(systems.sampleConditions[r.rootSampleId])
      return parsed.success ? [parsed.data.light] : []
    })
    return { cropId, distinctLights: new Set([...levels, ...imageLevels]).size }
  })
  const missingForGroup = (group: CaseGroup, submission: EvidenceInput | null): string[] => {
    switch (group) {
      case 'current_accuracy':
      case 'dependent_pipeline': return [...(unknownWater(submission).length ? [] : [water]), ...(calibrations(submission) ? [] : [calibration])]
      case 'storage_accuracy': return [...(storageEvidence(submission) ? [] : [storage]), ...(calibrations(submission) ? [] : [calibration])]
      case 'holdout_accuracy': return cropLightCoverage(submission).filter(row => row.distinctLights < 3)
        .map(row => `Cite scans or images at three light levels for ${row.cropId}; found ${row.distinctLights}.`)
      case 'energy_forecast':
      case 'independent_pipeline': return telemetryAnalysis(submission) ? [] : [energy]
    }
  }
  const inspect = (task: TaskId, submission: EvidenceInput) => {
    const groupsByTask: Partial<Record<TaskId, CaseGroup[]>> = {
      T1: ['current_accuracy', 'storage_accuracy'], T2: ['holdout_accuracy'], T3: ['energy_forecast'],
      T5: ['dependent_pipeline', 'independent_pipeline'],
    }
    const checks = (groupsByTask[task] ?? []).map(group => {
      const missing = missingForGroup(group, submission)
      return { group, eligible: missing.length === 0, missing }
    })
    if (task === 'T4') {
      const missing = [...(unknownWater(submission).length >= 2 ? [] : ['Cite at least two current source-water measurements.']),
        ...(calibrations(submission) ? [] : [calibration])]
      return [...checks, { group: 'diagnosis_evidence', eligible: missing.length === 0, missing }]
    }
    return checks
  }
  return { waterResults, unknownWater, calibrations, telemetryAnalysis, missingForGroup, inspect }
}
