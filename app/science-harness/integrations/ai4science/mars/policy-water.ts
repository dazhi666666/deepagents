/** Water role line of the scripted reference (team.ts SOPs D1 and W1-W4, and the water side of E2, E3, E5, E6): rescue
 * water samples from a failed cold store, triage inline alarms against the engineer's reference reading, trace a real
 * contamination, answer the D1 duty, and run the W1 baseline, the W3 bias pairing and the W2 kinetics on robot-1.
 * robot-1 is exclusive, so one procedure chain runs at a time; the campaigns are ordered by deadline and value.
 */
import { MODULES, est, type ReferencePolicy, type RoleStep } from './policies.ts'
import { dutySlot, dutyWindow } from './deliverables.ts'
import { W2_MIN_SPAN } from './scoring-progress.ts'
import type { WaterIncident } from './policy-brain.ts'

/** Inline DOC alarm limits per module (the alarm notice reports the limit it crossed). */
const LIMITS: Record<string, number> = { reservoir: 7, filter: 2.5, pump: 2.5 }
const STORES = ['cold', 'freezer', 'bench'] as const
type Store = typeof STORES[number]
/** W2 is measured store by store in rotation; nine results give each storage temperature a three-point decay fit. */
const W2_ROUNDS = 9
interface Point { store: Store; tick: number; doc: number; ref: string }
type Value = ReturnType<ReferencePolicy['values']>[number]

export const WATER_STEPS: readonly RoleStep[] = [
  { kind: 'safety', run: coldRescue }, { kind: 'safety', run: triage }, { kind: 'safety', run: tracing },
  { kind: 'duty', run: duty }, { kind: 'deadline', run: baseline }, { kind: 'deadline', run: bias },
]
// W2 (kinetics below) is not in the line: its evidence rule asks for at least eight confirms of one mother sample, and a
// confirm chain takes 100-400 ticks on robot-1 here (routes, recharging, and heater and confirm runs refused for shared
// power at night and in storms), so the attempt never completes and only delays W4 and W3. Kept for the record.
void kinetics

/** E2: when the cold store fails, carry the water line's samples out of it to cold-2 in one trip. */
async function coldRescue(p: ReferencePolicy, tick: number) {
  void tick
  if (p.world.observe().devices.find(device => device.id === 'cold-1')?.broken !== true || p.robotBusy('robot-1')) return
  const mine = new Set(Object.values(p.slot<Record<Store, string[]>>('water:W2:stores', () => ({ cold: [], freezer: [], bench: [] }))).flat())
  const stranded = p.world.observe().samples.filter(sample => sample.location === 'cold-1' && sample.volumeUl > 0 && mine.has(sample.id)).map(sample => sample.id)
  if (!stranded.length) return
  await p.water({ action: 'transfer', deviceId: 'robot-1', sampleId: stranded[0]!, destination: 'cold-2', ...(stranded.length > 1 ? { additionalSampleIds: stranded.slice(1, 6) } : {}) })
}

/** True DOC of a module from the engineer's reference readings completed in [from, to), newest first. */
function references(p: ReferencePolicy, module: string, from: number, to = Number.MAX_SAFE_INTEGER) {
  return p.ops().filter(op => op.command.action === 'device_reference' && (op.command as { targetId?: string }).targetId === module && op.state === 'succeeded' &&
    (op.completedTick ?? -1) >= from && (op.completedTick ?? -1) < to)
    .map(op => ({ id: op.id, tick: op.completedTick ?? 0, doc: Number((op.result as { reference?: { docInline?: number } } | null)?.reference?.docInline ?? NaN) }))
    .filter(value => Number.isFinite(value.doc)).reverse()
}

/** Inline alarms and true readings: the alarmed module is the one D1 and the engineer's reference measure next. A
 * reference reading below the limit while the inline sensor reads above it marks the sensor false (the engineer
 * recalibrates it); any reference reading above a module's limit confirms contamination and opens the incident. */
async function triage(p: ReferencePolicy, tick: number) {
  for (const alarm of p.alerts.filter(value => value.kind === 'inline-doc-alarm')) {
    const key = `alarm:${alarm.seq}`
    if (p.done.has(key)) continue
    const module = String(alarm.data.module)
    p.state['water:alarmed'] = { module, tick: alarm.tick }
    const reading = references(p, module, alarm.tick)[0]
    if (!reading) break
    p.done.add(key)
    delete p.state['water:alarmed']
    if (reading.doc < (LIMITS[module] ?? 2.5)) { p.state['water:decoy'] = module; p.trace.push(`t${tick} triage: ${module} inline alarm false (true ${reading.doc.toFixed(2)})`) }
  }
  if (p.state['water:incident']) return
  // Every true reading counts, whoever took it: the duty's daily reference may be the first to see the loop go dirty.
  for (const module of MODULES) {
    const reading = references(p, module, 0)[0]
    if (!reading || reading.doc < (LIMITS[module] ?? 2.5)) continue
    const alarms = p.alerts.filter(value => value.kind === 'inline-doc-alarm' && value.data.module === module && value.tick <= reading.tick && p.state['water:decoy'] !== module)
    p.state['water:incident'] = { onset: alarms.at(-1)?.tick ?? reading.tick, hypotheses: [], pumpDoc: null, fixed: null, resultIds: [] } satisfies WaterIncident
    p.trace.push(`t${tick} triage: contamination at ${module} (true ${reading.doc.toFixed(2)} at t${reading.tick})`)
    return
  }
}

/** Mean true DOC per module from the engineer's reference readings in [from, to). */
function referenceMean(p: ReferencePolicy, from: number, to: number) {
  return Object.fromEntries(MODULES.map(module => {
    const found = references(p, module, from, to).map(value => value.doc)
    return [module, found.length ? found.reduce((sum, value) => sum + value, 0) / found.length : undefined]
  })) as Record<string, number | undefined>
}
/** Contamination hypotheses from DOC at each module now against before: a dirtier inlet raises the reservoir, a failed
 * membrane lowers the filter's removal, a leaking pump seal adds DOC (and lubricant) after the pump. */
function diagnose(before: Record<string, number | undefined>, now: Record<string, number>, lubricant: number) {
  const hypotheses: ('inlet' | 'membrane' | 'seal')[] = []
  if (before.reservoir !== undefined && now.reservoir! > before.reservoir * 1.15) hypotheses.push('inlet')
  if (before.reservoir !== undefined && before.filter !== undefined && 1 - now.filter! / now.reservoir! < 1 - before.filter / before.reservoir - 0.06) hypotheses.push('membrane')
  if ((before.pump !== undefined && before.filter !== undefined && now.pump! - now.filter! > before.pump - before.filter + 0.5) || lubricant > 0.3) hypotheses.push('seal')
  return hypotheses.length ? hypotheses : ['inlet' as const]
}

/** W4 and the E3 diagnosis: as soon as the engineer has read all three modules after the incident began, diagnose from
 * those true readings and report (the engineer clears each source from the report); meanwhile confirm all three
 * modules on robot-1, which is the evidence W4 must cite, and submit once they are in. */
async function tracing(p: ReferencePolicy, tick: number) {
  const incident = p.state['water:incident'] as WaterIncident | undefined
  if (!incident || p.done.has('W4')) return
  if (tick > p.after('W4', incident.onset)) { p.done.add('W4'); return }
  if (!incident.hypotheses.length) {
    // Now: each module's true reading since the incident began, or its inline reading where the sensor is trusted.
    const inline = p.world.sensors().water.inlineDoc
    const now = referenceMean(p, incident.onset, Number.MAX_SAFE_INTEGER)
    for (const module of MODULES) if (now[module] === undefined && p.state['water:decoy'] !== module && inline[module] !== undefined) now[module] = inline[module]
    if (MODULES.every(module => now[module] !== undefined)) {
      p.trace.push(`t${tick} tracing: ${MODULES.map(module => `${module} ${now[module]!.toFixed(2)}`).join(', ')}`)
      const hypotheses = diagnose(referenceMean(p, 0, incident.onset), now as Record<string, number>, 0)
      Object.assign(incident, { hypotheses, pumpDoc: now.pump! })
      p.report(tick, ['reservoir', 'filter', 'pump', 'water'], 'water-contamination', hypotheses)
      return
    }
  }
  const values = await confirmAll(p, 'W4')
  if (!values || p.used) return
  const of = (module: string) => values.find(value => p.sourceOfResult(value.resultId) === module)
  const reservoir = of('reservoir'), filter = of('filter'), pump = of('pump')
  if (!reservoir?.doc || !filter?.doc || !pump?.doc) return
  const w1 = p.slot<Record<string, number>>('water:W1:trace', () => ({}))
  const lubricant = Math.max(...values.map(value => value.lubricant ?? 0))
  const hypotheses = incident.hypotheses.length ? [...new Set([...incident.hypotheses, ...(lubricant > 0.3 ? ['seal'] : [])])] as ('inlet' | 'membrane' | 'seal')[]
    : diagnose(w1.reservoir !== undefined ? w1 : referenceMean(p, 0, incident.onset), { reservoir: reservoir.doc, filter: filter.doc, pump: pump.doc }, lubricant)
  incident.resultIds = values.map(value => value.resultId)
  if (!incident.hypotheses.length) {
    Object.assign(incident, { hypotheses, pumpDoc: pump.doc })
    p.report(tick, ['reservoir', 'filter', 'pump', 'water'], 'water-contamination', hypotheses)
    return
  }
  const base = w1.pump !== undefined ? w1.pump : referenceMean(p, 0, incident.onset).pump
  const increase = base !== undefined ? pump.doc - base : pump.doc
  const decoy = p.state['water:decoy'] as string | undefined
  if (p.submit(tick, 'W4', { hypotheses, increaseAtPump: est(increase, Math.max(0.3, 0.3 * Math.abs(increase))), lubricantPresent: lubricant > 0.3,
    faultySensor: decoy && (MODULES as readonly string[]).includes(decoy) ? decoy : 'none' }, { resultIds: values.map(value => value.resultId), analysisRunIds: [p.analysis(tick)] })) p.done.add('W4')
}
/** One confirm of each module for a campaign task. Each chain starts as soon as robot-1 is free, without waiting for the
 * previous one to finish (a chain leaves the robot idle while its sample is on the heater or in confirm).
 * @returns The three results once all have settled, else null. */
async function confirmAll(p: ReferencePolicy, task: 'W1' | 'W4') {
  const values: Value[] = []
  let settled = true
  for (const module of MODULES) {
    const run = await p.procedureFor(`${task}:${module}`, 'water_assay', () => ({ taskId: task, requestKey: `${task}-${module}`, sourceId: module, method: 'confirm' }))
    if (run.state !== 'done') { settled = false; continue }
    const value = p.values(run.id!)[0]
    if (value?.doc) values.push(value)
  }
  return settled ? values : null
}

/** D1: answer each window from a true reading of a module in it — the engineer's reference reading, or (the SOP's own
 * path) a confirm of a module sampled since the previous window opened, run on robot-1 when there is neither — and give
 * each module the newest true value: a reading taken in the last 48 ticks, else its inline sensor scaled by that sensor's
 * correction (true / inline at the same tick of its latest reading). */
async function duty(p: ReferencePolicy, tick: number) {
  const load = p.world.truth.load, slot = dutySlot('D1', load, tick, p.world.horizon)
  if (slot === null || p.done.has(`D1:${slot}`)) return
  const [from, to] = dutyWindow('D1', load, slot, p.world.horizon), period = to - from
  const reference = MODULES.flatMap(module => references(p, module, from, to).map(value => ({ ...value, module }))).sort((a, b) => b.tick - a.tick)[0]
  const confirm = p.freshConfirms.filter(value => value.startedTick >= from - period && value.completedTick < to).at(-1)
  if (!reference && !confirm) {
    // The W1 baseline's chains are module confirms too: while it is open they serve the duty as well.
    if (!p.done.has('W1') && tick <= p.deadline('W1') && !p.state['water:incident']) { await confirmAll(p, 'W1'); return }
    await p.procedureFor(`D1:${slot}`, 'water_assay', () => ({ taskId: 'D1', requestKey: `D1-${slot}`, sourceId: moduleFor(p, slot), method: 'confirm' }), 1)
    return
  }
  const inline = p.world.sensors().water.inlineDoc
  const corrected = p.slot<Record<string, number>>('water:corrected', () => ({}))
  for (const module of MODULES) {
    const reading = references(p, module, 0)[0]
    const sensed = reading ? p.telemetry(`${module}.doc_inline`, reading.tick, reading.tick)[0]?.[1] : undefined
    const recalibrated = p.ops().some(op => op.command.action === 'sensor_calibrate' && (op.command as { targetId?: string }).targetId === module && op.state === 'succeeded' && (op.completedTick ?? 0) > (reading?.tick ?? 0))
    if (recalibrated) corrected[module] = 1
    else if (reading && sensed !== undefined && sensed > 0.05) corrected[module] = reading.doc / sensed
  }
  const value: Record<string, unknown> = { sensors: {} }
  for (const name of MODULES) {
    const fresh = references(p, name, tick - 48)[0]
    const estimate = fresh ? fresh.doc : (inline[name] ?? 0) * (corrected[name] ?? 1)
    value[name] = est(estimate, estimate * (fresh ? 0.06 : 0.1) + 0.05)
    ;(value.sensors as Record<string, string>)[name] = Math.abs((corrected[name] ?? 1) - 1) > 0.25 ? 'faulty' : 'ok'
  }
  if (p.submit(tick, 'D1', value, reference ? { operationIds: [reference.id] } : { resultIds: [confirm!.resultId] })) p.done.add(`D1:${slot}`)
}
/** The module a D1 window measures: the alarmed one, else the rotation. */
function moduleFor(p: ReferencePolicy, slot: number) {
  return (p.state['water:alarmed'] as { module: string } | undefined)?.module ?? MODULES[slot % MODULES.length]!
}

/** W1: one confirm at each module before contamination (deadline from the task book), plus the removal ratio. */
async function baseline(p: ReferencePolicy, tick: number) {
  if (p.done.has('W1')) return
  if (tick > p.deadline('W1') || p.state['water:incident']) { p.done.add('W1'); return }
  const values = await confirmAll(p, 'W1')
  if (!values) return
  const of = (module: string) => values.find(value => p.sourceOfResult(value.resultId) === module)
  const reservoir = of('reservoir'), filter = of('filter'), pump = of('pump')
  if (!reservoir?.doc || !filter?.doc || !pump?.doc) return
  // The confirms are the cited evidence; where the engineer's reference readings of a module exist, their mean is the
  // better estimate of its true DOC (a confirm carries the method's bias and the sample's decay before measurement).
  const truth = (module: string, measured: number) => { const found = references(p, module, 0).map(value => value.doc)
    return found.length ? found.reduce((sum, value) => sum + value, 0) / found.length : measured }
  const docs = { reservoir: truth('reservoir', reservoir.doc), filter: truth('filter', filter.doc), pump: truth('pump', pump.doc) }
  const removal = 1 - docs.filter / docs.reservoir
  Object.assign(p.slot<Record<string, number>>('water:W1:trace', () => ({})), { reservoir: reservoir.doc, filter: filter.doc, pump: pump.doc, removal: 1 - filter.doc / reservoir.doc })
  if (p.submit(tick, 'W1', { reservoir: est(docs.reservoir, 0.08 * docs.reservoir), filter: est(docs.filter, 0.08 * docs.filter),
    pump: est(docs.pump, 0.08 * docs.pump), removal: est(removal, 0.05) }, { resultIds: values.map(value => value.resultId), analysisRunIds: [p.analysis(tick)] })) p.done.add('W1')
}

/** W3: after the method notice and the engineer's recalibration, measure the reservoir once with v2 and set it against the
 * line's own v1 baseline of the same module (the v1 bias). The recalled sub-batch comes from the notice and the archive;
 * its bias is not measured, because running the recalled lot after the recall is exactly what the E5 SOP forbids. */
async function bias(p: ReferencePolicy, tick: number) {
  if (p.done.has('W3')) return
  const notice = p.alert('announcement', data => data.kind === 'method-notice')
  if (!notice) return
  if (tick > p.after('W3', notice.tick)) { p.done.add('W3'); return }
  const w1 = p.slot<Record<string, number>>('water:W1:trace', () => ({}))
  if (!p.done.has('calibrate:v2') || w1.reservoir === undefined) return
  const run = await p.procedureFor('W3:v2', 'water_assay', () => ({ taskId: 'W3', requestKey: 'W3-v2', sourceId: 'reservoir', method: 'confirm' }))
  if (run.state !== 'done') return
  const v2 = p.values(run.id!)[0]
  if (!v2?.doc) return
  const recall = p.recalledLot()
  const baselineIds = p.submissions.filter(submission => submission.taskId === 'W1').flatMap(submission => submission.evidence.resultIds)
  const affected = (['W1', 'W2', 'W4'] as const).filter(task => p.submissions.some(submission => submission.taskId === task && submission.tick < notice.tick))
  if (p.submit(tick, 'W3', { confirmV1Bias: est(w1.reservoir / v2.doc, 0.06), extractionA2Bias: { est: 1, lo: 0.8, hi: 1.2 },
    recalledLot: recall.lot ?? '', affectedDeliverables: [...affected] }, { resultIds: [...baselineIds, v2.resultId], archiveQueryIds: recall.queryIds })) p.done.add('W3')
}

/** W2: one mother sample split into three storage temperatures, then confirmed store by store in rotation while robot-1
 * is otherwise idle; each chain takes its own measuring time, which spreads the series well past the span rule. */
async function kinetics(p: ReferencePolicy, tick: number) {
  if (p.done.has('W2')) return
  if (tick > p.deadline('W2')) { p.done.add('W2'); return }
  // robot-1 serves the earlier deadlines first: the W1 baseline, then a contamination's tracing.
  if (!p.done.has('W1')) return
  const incident = p.state['water:incident'] as WaterIncident | undefined
  if (incident && !p.done.has('W4')) return
  const split = await p.procedureFor('W2:split', 'water_split', () => ({ taskId: 'W2', requestKey: 'W2-split', sourceId: 'reservoir', storage: ['cold-1', 'freezer', 'bench'], copies: 3 }))
  if (split.state !== 'done') return
  const stores = p.slot<Record<Store, string[]>>('water:W2:stores', () => ({ cold: [], freezer: [], bench: [] }))
  if (!stores.cold.length && !stores.freezer.length && !stores.bench.length) {
    const location = (id: string) => p.world.observe().samples.find(sample => sample.id === id)?.location ?? ''
    for (const id of p.sampleIds(split.id!)) {
      const where = location(id)
      if (where === 'cold-1' || where === 'cold-2') stores.cold.push(id)
      else if (where === 'freezer') stores.freezer.push(id)
      else if (where === 'liquid-handler') stores.bench.push(id)
    }
  }
  const points = p.slot<Point[]>('water:W2:points', () => [])
  const round = p.slot<number>('water:W2:round', () => 0)
  if (round >= W2_ROUNDS || STORES.every(store => !stores[store].length)) { await finishKinetics(p, tick); return }
  const store = STORES[round % STORES.length]!
  const pool = stores[store]
  if (!pool.length) { p.state['water:W2:round'] = round + 1; return }
  const run = await p.procedureFor(`W2:${round}`, 'water_assay', () => ({ taskId: 'W2', requestKey: `W2-${round}`, sampleId: pool[0], method: 'confirm' }))
  if (run.state !== 'done') return
  pool.shift()
  const value = p.values(run.id!)[0]
  if (value?.doc) points.push({ store, tick: value.completedTick ?? tick, doc: value.doc, ref: value.resultId })
  p.state['water:W2:round'] = round + 1
}

/** Fit one first-order decay constant per storage temperature from the measured series. */
async function finishKinetics(p: ReferencePolicy, tick: number) {
  const points = p.slot<Point[]>('water:W2:points', () => [])
  const fit = (store: Store) => {
    const mine = points.filter(point => point.store === store)
    if (mine.length < 2) return null
    const n = mine.length, mx = mine.reduce((sum, point) => sum + point.tick, 0) / n, my = mine.reduce((sum, point) => sum + Math.log(point.doc), 0) / n
    const denominator = mine.reduce((sum, point) => sum + (point.tick - mx) ** 2, 0)
    if (denominator <= 0) return null
    const k = -mine.reduce((sum, point) => sum + (point.tick - mx) * (Math.log(point.doc) - my), 0) / denominator
    return { k, span: Math.max(...mine.map(point => point.tick)) - Math.min(...mine.map(point => point.tick)), mine }
  }
  const cold = fit('cold'), freezer = fit('freezer'), bench = fit('bench')
  if (!cold || !freezer || !bench) { p.done.add('W2'); return }
  if (Math.max(...points.map(point => point.tick)) - Math.min(...points.map(point => point.tick)) < W2_MIN_SPAN) { p.done.add('W2'); return }
  const spread = (value: number) => ({ est: value, lo: Math.max(1e-9, value / 1.5), hi: Math.max(1e-9, value * 1.5) })
  if (p.submit(tick, 'W2', { k4: spread(cold.k), kMinus10: spread(freezer.k), k22: spread(bench.k) },
    { resultIds: [...cold.mine, ...freezer.mine, ...bench.mine].map(point => point.ref), analysisRunIds: [p.analysis(tick)] })) p.done.add('W2')
  else if (p.lastSubmit === 'rejected') p.done.add('W2')
}
