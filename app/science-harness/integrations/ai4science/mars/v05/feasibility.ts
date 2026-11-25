/** Host-only physical feasibility driver; only sanitized public closures reach the reference policy. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ExecutionEngine } from '../../../../../science-harness/integrations/ai4science/platform/execution.ts'
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import { loadTruth } from '../truth.ts'
import { MarsWorld, initialMarsRules } from '../world.ts'
import { marsScenario } from '../scenario.ts'
import { openMarsProviders } from '../providers.ts'
import { Refs } from '../refs.ts'
import { Procedures } from '../procedures.ts'
import { AnalysisRegistry } from '../analysis.ts'
import { V05ResearchRecords } from './research-records.ts'
import { V05Predictions } from './predictions.ts'
import { V05Observations, collectEvaluationInput } from './evaluation-input.ts'
import { PublicResearchReference, type ReferenceAssay } from './reference.ts'
import { validateFrozenPredictions } from './validation.ts'
import { evaluateV05, type EvaluationManifest } from './evaluator.ts'

export async function runReferenceFeasibility(options: { truthFile: string; directory: string; decisionTicks?: number }) {
  const truth = loadTruth(options.truthFile), scenario = marsScenario(truth), directory = options.directory
  mkdirSync(directory, { recursive: true }); const scenarioFile = join(directory, 'scenario.json'); writeFileSync(scenarioFile, JSON.stringify(scenario))
  const world = new MarsWorld(join(directory, 'device'), scenario, initialMarsRules(), truth)
  const providers = openMarsProviders(world, scenarioFile, () => {})
  const engine = new ExecutionEngine({ directory: join(directory, 'execution'), providers: providers.providers, pollIntervalMs: 5, providerCallTimeoutMs: 10000, logicalTick: () => world.observe().tick })
  await engine.open(); engine.createProject('mars', null)
  const grant = engine.issueContext('mars', 'public-reference', ['water', 'greenhouse', 'facilities'])
  const refs = new Refs(world, () => engine.list(grant).flatMap(operation => operation.artifacts.map(artifact => artifact.id)))
  const procedures = new Procedures({ engine, world, admin: grant, refs, host: grant, notify: async () => {} })
  const analysis = new AnalysisRegistry(join(directory, 'analysis')), now = () => world.observe().tick
  const records = new V05ResearchRecords(engine, grant, now, ref => {
    const run = analysis.get(ref.id); return run?.status === 'done' ? { availableAt: run.asOfTick } : null
  })
  // Independent physical validation is revealed to the evaluator only at the end of this run.
  const predictions = new V05Predictions(engine, grant, now, records, target => target === 'PW-01:holdout' ? { availableAt: world.horizon, policyHash: 'physical-independent-assay-v1' } : null)
  const observations = new V05Observations(engine, grant, now, id => analysis.get(id)?.status === 'done' ? { availableAt: analysis.get(id)!.asOfTick } : null)
  const sessions = new Map<string, { reference?: string | undefined; procedure?: string | undefined; analyzed?: ReferenceAssay; attempts: number }>()
  const failures: { tick: number; action: string; reason: string }[] = []
  const resourceTimeline: { tick: number; waterUl: number; samplesUl: number; batches: { id: string; units: number }[]; robots: { id: string; energy: number; node: string }[] }[] = []
  const action = async (key: string, command: Json) => {
    const kind = (command as { action: string }).action
    try { const op = await engine.submit(grant, { providerId: ['light', 'irrigate', 'scan'].includes(kind) ? 'greenhouse' : 'facilities', requestKey: key, input: command }); return op.id }
    catch (error) { failures.push({ tick: now(), action: key, reason: String(error) }); return null }
  }
  const reference = new PublicResearchReference({
    snapshot: () => ({ tick: now(), methodVersion: world.observe().methods.find(method => method.id === 'confirm')?.version ?? 1,
      announcement: world.events(0).some(event => event.kind === 'announcement' && (event.payload as { kind?: string })?.kind === 'method-notice') }),
    energy: () => world.sensors().energy.solar,
    publish: (key, input) => records.put(key, input), registerModel: (key, input) => predictions.registerModel(key, input),
    commit: (key, input) => predictions.commit(key, input), observe: (key, input) => observations.submit(key, input),
    assay: async key => {
      const session = sessions.get(key) ?? { attempts: 0 }; sessions.set(key, session)
      if (session.analyzed) return session.analyzed
      if (!session.reference) {
        const robot = world.observeSystems().robots.find(robot => robot.id === 'robot-3')!
        if (robot.operationId || robot.energy < 65) return null
        session.reference = await action(`reference-${key}`, { action: 'device_reference', targetId: 'reservoir' }) ?? undefined
        return null
      }
      const probe = world.observeSystems().operations.find(operation => operation.id === session.reference)
      if (probe?.state !== 'succeeded') return null
      const referenceDoc = z.object({ reference: z.object({ docInline: z.number() }) }).parse(probe.result).reference.docInline
      if (!session.procedure) {
        // A maintenance reference parks robot-3 at the sampling module. Clear the shared approach before robot-1 arrives.
        const robot = world.observeSystems().robots.find(robot => robot.id === 'robot-3')!
        if (robot.operationId) return null
        if (robot.node !== robot.id) { await action(`park-${key}-${now()}`, { action: 'move', robotId: robot.id, destination: robot.id }); return null }
        const started = await procedures.start({ kind: 'water_assay', actorId: grant.actorId, requestKey: `assay-${key}-${session.attempts}`, providers: ['water', 'facilities'],
          robot: 'robot-1', taskId: key === 'baseline' ? 'PW-01' : 'PW-03', sourceId: 'reservoir', method: 'confirm' })
        session.procedure = started!.procedure; return null
      }
      const status = procedures.view(session.procedure)
      if (status?.state === 'failed') { failures.push({ tick: now(), action: key, reason: status.detail ?? 'procedure failed' }); session.procedure = undefined; session.attempts++; return null }
      if (status?.state !== 'done') return null
      const resultId = refs.resolve(status.resultIds![0]!), raw = world.rawFor(resultId)
      if (!raw) throw new Error('Successful assay has no raw data')
      const run = await analysis.run(grant.actorId, now(), `return chromatogram(await readRaw(${JSON.stringify(resultId)}));`, () => ({
        readRaw: id => { if (id !== resultId) throw new Error('Only selected result is visible'); return raw }, readArtifact: () => { throw new Error('Unavailable binding') },
        telemetry: () => { throw new Error('Unavailable binding') }, archiveSql: () => { throw new Error('Unavailable binding') },
      }))
      if (run.status !== 'done') throw new Error(run.error ?? 'Analysis failed')
      engine.recordFact(grant, 'mars-v05-analysis-published', { id: run.id, tick: now() })
      const result = world.observe().results.find(result => result.id === resultId)!
      const sampled = world.observeSystems().operations.find(operation => operation.command.action === 'sample' && operation.acceptedTick >= status.startedTick)
      session.analyzed = { id: key, tick: now(), doc: z.object({ doc: z.number().positive() }).parse(run.output).doc, referenceDoc,
        analysisId: run.id, resultId, methodVersion: result.methodVersion, exposureTicks: (result.completedTick ?? now()) - (sampled?.completedTick ?? status.startedTick) }
      return session.analyzed
    },
  })
  let lastPanel = -1000
  try {
    for (;;) {
      const tick = now(), lab = world.observe(), systems = world.observeSystems()
      if (tick % (options.decisionTicks ?? 12) === 0 && tick < world.horizon) {
        resourceTimeline.push({ tick, waterUl: lab.facilities.waterUl, samplesUl: lab.samples.reduce((sum, sample) => sum + sample.volumeUl, 0),
          batches: lab.batches.map(batch => ({ id: batch.id, units: batch.units })), robots: systems.robots.map(robot => ({ id: robot.id, energy: robot.energy, node: robot.node })) })
        await engine.reconcile(grant)
        const busy = (id: string) => engine.list(grant).some(operation => !['succeeded', 'failed', 'cancelled'].includes(operation.state) && (operation.input as { deviceId?: string; robotId?: string }).deviceId === id)
        const confirm = lab.devices.find(device => device.id === 'confirm')!
        if (!confirm.dirty && !busy('confirm') && (!confirm.calibrationId || (confirm.calibratedUntil ?? -1) < tick + 50)) await action(`calibrate-${tick}`, { action: 'calibrate', deviceId: 'confirm' })
        if (tick === 0) for (const chamber of world.sensors().chambers) await action(`light-${chamber.id}`, { action: 'light', chamberId: chamber.id, level: 35 })
        const maintenanceRobot = systems.robots.find(robot => robot.id === 'robot-3')!
        if (!maintenanceRobot.operationId && maintenanceRobot.energy < 65) await action(`charge-maintenance-${tick}`, maintenanceRobot.node !== maintenanceRobot.id ?
          { action: 'move', robotId: maintenanceRobot.id, destination: maintenanceRobot.id } : { action: 'charge', robotId: maintenanceRobot.id })
        else if (!maintenanceRobot.operationId && maintenanceRobot.energy >= 65 && tick - lastPanel >= 200 && reference.phase !== 'baseline' && reference.phase !== 'revision' && reference.phase !== 'validation') {
          await action(`panel-${tick}`, { action: 'panel_clean' }); lastPanel = tick
        }
        for (const chamber of world.sensors().chambers) {
          const crops = world.sensors().crops.filter(crop => crop.chamberId === chamber.id && !crop.removed && crop.moistureReading !== null)
          if (crops.some(crop => crop.moistureReading! < 45)) await action(`irrigate-${chamber.id}-${tick}`, { action: 'irrigate', chamberId: chamber.id, volumeUl: 300 })
        }
        if (lab.facilities.waterUl < 500) await action(`water-${tick}`, { action: 'refill', deviceId: 'water-recovery', volumeUl: 3000 })
        await reference.step()
      }
      await procedures.step()
      if (world.advance() === null) break
    }
    await engine.reconcile(grant)
    const independent = reference.assays[2]
    const manifest: EvaluationManifest = { version: 'v0.5', mode: 'slice', horizon: world.horizon, objectives: [{ id: 'water-independent-validation', duplicateKey: 'independent-current-water',
      component: 'R', taskId: 'PW-01', branch: 'test', points: 1, deadline: world.horizon, validationAvailableAt: world.horizon, predictionTarget: 'PW-01:holdout',
      metric: { kind: 'numeric', target: independent?.referenceDoc ?? 0, tolerance: Math.max(1, (independent?.referenceDoc ?? 1) * 0.25) },
      evidence: [{ kind: 'analysis', count: 1, purpose: 'validation' }] }] }
    const validation = await validateFrozenPredictions(manifest, predictions.models(), predictions.predictions(), independent ? [{ objectiveId: 'water-independent-validation', predictionId: 'water-independent-prediction',
      input: { signal: independent.doc, exposureTicks: independent.exposureTicks }, outputPath: 'prediction', evaluatedAt: world.horizon }] : [])
    const score = evaluateV05(manifest, { ...collectEvaluationInput({ engine, context: grant, analysis, world }), validationResults: validation.validationResults })
    const operations = engine.list(grant)
    const acceptance = {
      physicalClosure: reference.phase === 'done' && reference.assays.length === 3,
      selectiveRevision: records.read('water-calibration')?.revision === 2 && records.read('plant-water-interpretation')?.revision === 2 && records.read('energy-observation')?.revision === 1,
      independentValidation: Boolean(independent && predictions.predictions()[0] && predictions.predictions()[0]!.lockedTick < independent.tick && validation.validationResults.length === 1),
      nonnegativeResources: resourceTimeline.every(frame => frame.waterUl >= 0 && frame.samplesUl >= 0 && frame.batches.every(batch => batch.units >= 0) && frame.robots.every(robot => robot.energy >= 0)),
      fullCoreJointFeasibility: false,
    }
    const report = { version: 'v0.5-slice', tick: now(), phase: reference.phase, acceptance, trace: reference.trace, assays: reference.assays,
      records: records.list(), models: predictions.models(), predictions: predictions.predictions(), score, validation: validation.reports,
      feasibility: { scope: 'method-change water interpretation dependency slice; not full18-card joint feasibility', completed: reference.phase === 'done',
        operationCount: operations.length, successful: operations.filter(operation => operation.state === 'succeeded').length, failures,
        resourceTimeline,
        resources: operations.map(operation => {
          const physical = world.observe().operations.find(item => item.id === operation.id) ?? world.observeSystems().operations.find(item => item.id === operation.id)
          return { id: operation.id, provider: operation.providerId, state: operation.state, input: operation.input,
            acceptedTick: physical?.acceptedTick ?? null, completedTick: physical?.completedTick ?? null }
        }) } }
    writeFileSync(join(directory, 'feasibility-report.json'), JSON.stringify(report, null, 2))
    return report
  } finally { await engine.close(); providers.close(); world.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [truthFile, directory] = process.argv.slice(2)
  if (!truthFile || !directory) throw new Error('Usage: tsx v05/feasibility.ts <private-truth-file> <output-directory>')
  const result = await runReferenceFeasibility({ truthFile, directory })
  console.log(JSON.stringify({ version: result.version, tick: result.tick, phase: result.phase, assays: result.assays.length,
    score: result.score.score, maximum: result.score.maximum, report: join(resolve(directory), 'feasibility-report.json') }))
}
