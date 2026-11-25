/** Read-only joint projection of public service work. Physical admission and receipts stay authoritative. */
import { z } from 'zod'
import type { Json } from '../../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsWorld } from '../world.ts'
import { planRoute } from '../routing.ts'
import { parsePlanOutputReference, type Plan, type PlanDraft } from '../v05/planning.ts'
import { ROBOT_JOBS, SHORT_TICKS } from '../world-system.ts'
import type { Commission } from './cases.ts'

const durations = new Map<string, number>(Object.entries(SHORT_TICKS))
for (const [action, job] of Object.entries(ROBOT_JOBS)) durations.set(action, job.ticks)
export type ServiceReceipt = { id: string; acceptedTick: number; actorId: string }
type Entry = { id: string; draft: PlanDraft; saved?: Plan; committed: boolean; commitmentReceipts?: ServiceReceipt[] }
const commandFields = z.object({ action: z.string(), robotId: z.string().optional(), deviceId: z.string().optional(),
  chamberId: z.string().optional(), destination: z.string().optional(), sourceId: z.string().optional(), sampleId: z.string().optional(),
  additionalSampleIds: z.array(z.string()).optional(), methodId: z.string().optional(), volumeUl: z.number().optional() })

export function inspectServicePortfolio(world: Pick<MarsWorld, 'observe' | 'observeSystems' | 'rules' | 'scenario'>,
  commissions: readonly Commission[], entries: Entry[], resolve: (input: Json) => Json) {
  const lab = world.observe(), systems = world.observeSystems(), now = lab.tick, rules = world.rules
  const devices = new Map(lab.devices.map(d => [d.id, d])), methods = new Map(lab.methods.map(m => [m.id, m]))
  const samples = new Map(lab.samples.map(s => [s.id, { location: s.location, volume: s.volumeUl }]))
  // Account for already accepted cargo at its reserved destination, including other actors' transfers.
  for (const op of lab.operations) if (op.command.action === 'transfer' && !['failed', 'cancelled', 'succeeded'].includes(op.state)) {
    for (const id of [op.command.sampleId, ...(op.command.additionalSampleIds ?? [])]) {
      const sample = samples.get(id)
      if (sample) sample.location = op.command.destination
    }
  }
  const actual = new Map([...lab.operations, ...systems.operations].map(o => [o.id, o]))
  const robots = new Map(systems.robots.map(r => [r.id, { node: r.node, energy: r.energy }]))
  const dirty = new Set(lab.devices.filter(d => d.dirty).map(d => d.id))
  const locks = new Map<string, { until: number; owner: string }>()
  const issues: { planId: string; stepId: string; code: string; detail: string }[] = []
  const outputIds = new Map<string, string[]>(), ends = new Map<string, number>()
  const key = (id: string, step: string) => JSON.stringify([id, step])
  const rows: { planId: string; stepId: string; startTick: number | null; endTick: number | null; status: string; operationId: string | null }[] = []
  const all = entries.flatMap(entry => entry.draft.steps.map(step => ({ entry, step,
    c: commandFields.parse(resolve(step.input)), key: key(entry.id, step.id) })))
  if (all.length > 256) throw new Error('Portfolio supports up to 256 steps per view. Select planIds in input_json.')
  const diagnostic = (id: string, step: string, code: string, detail: string) => issues.push({ planId: id, stepId: step, code, detail })
  const routeTicks = (from: string, to: string) => {
    const path = planRoute(from, to, 0, [], rules.speed)
    if (!path) throw new Error(`No connected route from ${from} to ${to}`)
    return path.at(-1)?.endTick ?? 0
  }
  for (const r of systems.robots) if (r.operationId) {
    const end = systems.transports.find(t => t.operationId === r.operationId)?.finishTick ?? actual.get(r.operationId)?.nextTick ?? now
    locks.set(r.id, { until: end, owner: 'live operation' })
    const projected = robots.get(r.id)!
    projected.node = r.segments.at(-1)?.to ?? r.node
    projected.energy = actual.get(r.operationId)?.command.action === 'charge' ? rules.energyCapacity : Math.max(0, r.energy - Math.max(0, end - now) * rules.energyPerTick)
  }
  for (const op of lab.operations) if (op.completedTick == null && !['failed','cancelled','succeeded'].includes(op.state)) {
    const until = Math.max(now, op.nextTick ?? now, systems.transports.find(t => t.operationId === op.id)?.finishTick ?? now)
    for (const id of [op.command.deviceId, ...(op.command.action === 'transfer' ? [op.command.destination] : [])])
      if ((locks.get(id)?.until ?? -1) < until) locks.set(id, { until, owner: 'live operation' })
  }
  const resolveSample = (planId: string, id: string) => {
    const link = parsePlanOutputReference(id)
    if (!link) return id
    return outputIds.get(key(planId, link.stepId))?.[Number(link.field.split('.')[1] ?? 0)] ?? key(planId, id)
  }
  const inputs = (id: string, c: z.infer<typeof commandFields>) => (c.sampleId ? [c.sampleId, ...(c.additionalSampleIds ?? [])] : []).map(ref => resolveSample(id, ref))
  const pending = all.slice()
  while (pending.length) {
    const ready = pending.filter(n => n.step.dependsOn.every(id => ends.has(key(n.entry.id, id)))).map(n => {
      const deps = Math.max(now, n.step.at, ...n.step.dependsOn.map(id => ends.get(key(n.entry.id, id))!))
      const resources = [n.c.deviceId, n.c.robotId, n.c.destination, n.c.chamberId].filter((s): s is string => !!s)
      const opId = n.entry.saved?.operations[n.step.id]
      const start = opId ? actual.get(opId)?.acceptedTick ?? now : Math.max(deps, ...resources.map(r => locks.get(r)?.until ?? now))
      return { n, resources, deps, start, opId }
    }).sort((a, b) => a.start - b.start)
    const next = ready[0]
    if (!next) throw new Error('Service plan has an unresolved dependency')
    const { n, resources, deps, start, opId } = next, { entry, step, c } = n, id = entry.id
    pending.splice(pending.indexOf(n), 1)
    if (!opId && entry.saved && ['cancelled', 'partial_failed'].includes(entry.saved.state)) {
      ends.set(n.key, now)
      rows.push({ planId: id, stepId: step.id, startTick: null, endTick: null, status: 'not_dispatched', operationId: null })
      continue
    }
    const warn = (code: string, detail: string) => diagnostic(id, step.id, code, detail)
    const refs = inputs(id, c), produced = n.key, device = c.deviceId ?? '', existing = opId ? actual.get(opId) : undefined
    const method = methods.get(c.methodId ?? ''), places = (dest: string) => [...samples.values()].filter(s => s.location === dest && s.volume > 0).length
    const block = entry.saved?.blocked?.[step.id]
    if (block) warn('observed_block', `${block.reason} (since tick ${block.sinceTick})`)
    let end: number
    if (opId) {
      end = existing?.completedTick ?? Math.max(now, systems.transports.find(t => t.operationId === opId)?.finishTick ?? existing?.nextTick ?? now)
      const op = lab.operations.find(o => o.id === opId)
      outputIds.set(n.key, op?.outputSampleIds ?? (op?.outputSampleId ? [op.outputSampleId] : c.action === 'sample' ? [`sample:${opId}`] : refs))
      if (existing?.state !== 'succeeded') warn('operation_receipt', `Check operation ${opId}: ${existing?.state ?? 'unavailable'}`)
    } else {
      for (const r of resources) { const lock = locks.get(r); if (lock && lock.until > deps && lock.owner !== id) warn('shared_window', `${r} occupied by ${lock.owner} until ${lock.until}`) }
      let duration = durations.get(c.action) ?? 1
      const destination = c.destination, robotId = c.robotId ?? device, robot = robots.get(robotId)
      if (c.action === 'sample' && c.sourceId) {
        duration = rules.sampleTicks; outputIds.set(n.key, [produced]); samples.set(produced, { location: c.sourceId, volume: c.volumeUl ?? 0 })
      } else if (c.action === 'charge' && robot) {
        duration = rules.chargeTicks
        if (robot.node !== robotId) warn('charge_off_dock', `Return ${robotId} to its home dock before charging`)
        else robot.energy = rules.energyCapacity
      } else if ((c.action === 'transfer' || c.action === 'move') && destination && robot) {
        const pickup = c.action === 'move' ? robot.node : samples.get(refs[0] ?? '')?.location
        duration = world.scenario.loadingTicks + world.scenario.handlingTicks
        if (!pickup) warn('unknown_pickup', 'Confirm the predecessor sample location from its physical receipt')
        else try {
          duration += routeTicks(robot.node, pickup === robotId ? robot.node : pickup) + routeTicks(pickup === robotId ? robot.node : pickup, destination)
          const remaining = robot.energy - duration * rules.energyPerTick
          const homeCost = (routeTicks(destination, robotId) + world.scenario.loadingTicks + world.scenario.handlingTicks) * rules.energyPerTick
          if (remaining < 0) warn('insufficient_charge', `${robotId} needs ${duration * rules.energyPerTick} energy for this route; projected ${robot.energy}`)
          else if (destination !== robotId && remaining < homeCost) warn('dock_reserve', `${robotId} would have ${remaining} energy at ${destination}; return needs ${homeCost}`)
          for (const [other, state] of robots) if (other !== robotId && (state.node === pickup || state.node === destination)) warn('occupied_node', `${other} occupies ${state.node}; verify a departure window`)
          robot.node = destination; robot.energy = remaining
        } catch (error) { warn('route_unavailable', error instanceof Error ? error.message : String(error)) }
        if (c.action === 'transfer') {
          if (places(destination) + refs.length > (devices.get(destination)?.capacity ?? 0)) warn('destination_full', `${destination} needs ${refs.length} free sample positions`)
          for (const ref of refs) { const sample = samples.get(ref); if (sample) sample.location = destination }
          outputIds.set(n.key, refs.slice(0, 1))
        }
      } else if (c.action === 'clean' || c.action === 'calibrate') {
        duration = world.scenario.loadingTicks + world.scenario.maintenanceTicks
        if (c.action === 'clean') dirty.delete(device)
        else if (dirty.has(device)) warn('clean_first', `Clean ${device} before calibration`)
      } else if (c.action === 'aliquot' || c.action === 'process') {
        duration = world.scenario.loadingTicks + (method?.processingTicks ?? world.scenario.handlingTicks)
        if (dirty.has(device)) warn('clean_first', `Clean ${device} before ${step.id}`)
        if (method?.dirtiesDevice) dirty.add(device)
        const ids = refs.map((ref, i) => { const sample = samples.get(ref), volume = c.volumeUl ?? 0
          if (sample) sample.volume -= volume
          const output = `${produced}:${i}`; samples.set(output, { location: device, volume }); return output })
        outputIds.set(n.key, ids)
        if (places(device) > (devices.get(device)?.capacity ?? 0)) warn('destination_full', `${device} also needs space for the output sample`)
      }
      end = start + duration
      for (const r of resources) locks.set(r, { until: end, owner: id })
    }
    ends.set(n.key, end)
    rows.push({ planId: id, stepId: step.id, startTick: start, endTick: end, status: existing?.state ?? (opId ? 'receipt_unavailable' : block ? 'blocked' : 'projected'), operationId: opId ?? null })
  }
  const activeEntries = entries.filter(e => !e.saved || ['running', 'scheduled'].includes(e.saved.state))
  const services = entries.map(e => {
    const tag = e.draft.service!, commission = commissions.find(c => c.id === tag.commissionId)!, deadline = commission.deadline
    const measured = rows.find(r => r.planId === e.id && r.stepId === tag.measurementStepId)!
    const result = measured.operationId && lab.results.find(r => r.operationId === measured.operationId && commission.methods.includes(r.methodId)
      && systems.sampleSources[r.rootSampleId] === commission.sourceId && !lab.revocations.some(v => v.resultId === r.id && v.tick <= now))
    const mother = result && lab.samples.find(s => s.id === result.rootSampleId)
    const measuredResult = result ? { id: result.id, completedTick: result.completedTick, deadlineMet: result.completedTick <= deadline,
      rootSampleId: result.rootSampleId, motherNow: mother ? { volumeUl: mother.volumeUl, location: mother.location, expiresAt: mother.expiresAt, disposition: mother.disposition } : null } : null
    if (measured.endTick !== null && measured.endTick > deadline) diagnostic(e.id, measured.stepId, 'deadline', `Measurement completion ${measured.endTick} exceeds ${deadline}`)
    if (activeEntries.includes(e) && activeEntries.some(other => other !== e && other.draft.service?.commissionId === tag.commissionId)) diagnostic(e.id, measured.stepId, 'duplicate_commission', `Check who owns the active plan for ${tag.commissionId}`)
    const hasBlock = e.saved?.blocked && Object.keys(e.saved.blocked).length > 0
    let outlook = 'projected'
    if (measured.status === 'succeeded') outlook = 'measurement_completed'
    else if (e.saved && ['cancelled', 'partial_failed'].includes(e.saved.state)) outlook = 'terminal'
    else if (hasBlock) outlook = 'observed_block'
    else if (issues.some(issue => issue.planId === e.id)) outlook = 'review_projection'
    else if (!e.committed) outlook = 'awaiting_commitment'
    return { planId: e.id, commissionId: tag.commissionId, actorId: e.saved?.actorId ?? null, state: e.saved?.state ?? 'draft', commitmentRecorded: e.committed, commitmentReceipts: e.commitmentReceipts ?? [], outlook,
      measurement: measured, measuredResult, retention: rows.find(r => r.planId === e.id && r.stepId === tag.retentionStepId)!, deadline, slackTicks: measured.endTick === null ? null : deadline - measured.endTick }
  })
  return { asOfTick: now, services, issues, steps: rows, assumptions: 'Advisory shared-device projection with unobstructed route times. Uncommitted drafts assume immediate release. Recheck actual receipts, traffic, reservations and storage quality.' }
}
