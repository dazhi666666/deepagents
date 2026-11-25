import { marsLayout, deviceCatalog, ACTION_NAMES, PHASE_NAMES } from './layout.js'

export const BUNDLE_VERSION = 'mars-viewer/1'
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024
export function pick(value, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [key, value[key]]))
}
export function publicCommand(value = {}) {
  return pick(value, ['action', 'deviceId', 'sampleId', 'additionalSampleIds', 'destination', 'robotId', 'targetId', 'chamberId', 'cropId', 'sourceId', 'methodId', 'methodVersion', 'volumeUl', 'container', 'enabled', 'targetTemperature', 'kind', 'level', 'value', 'setpoint', 'nutrient', 'dose', 'consumables', 'batchId', 'target', 'order', 'point', 'channel'])
}
export function publicOperation(value) {
  return { ...pick(value, ['id', 'projectId', 'state', 'stage', 'acceptedTick', 'nextTick', 'completedTick', 'detail', 'outputSampleIds', 'outputSampleId', 'resultIds', 'resultId', 'result']), command: publicCommand(value.command) }
}
export function publicEvent(value) {
  const p = value.payload ?? {}
  const payload = pick(p, ['id', 'deviceId', 'robotId', 'operationId', 'sampleId', 'resultId', 'state', 'stage', 'acceptedTick', 'completedTick', 'nextTick', 'detail', 'observed', 'reason', 'module', 'reading', 'threshold', 'shed', 'targetId', 'chamberId', 'cropId', 'methodId', 'version', 'cargo', 'pickupTick', 'finishTick', 'outputSampleId', 'outputSampleIds', 'resultIds'])
  if (p.command) payload.command = publicCommand(p.command)
  if (p.position) payload.position = pick(p.position, ['x', 'y', 'node'])
  if (p.segments) payload.segments = p.segments.map(s => ({ ...pick(s, ['from', 'to', 'startTick', 'endTick']), ...(s.fromPosition ? { fromPosition: pick(s.fromPosition, ['x', 'y']) } : {}), ...(s.toPosition ? { toPosition: pick(s.toPosition, ['x', 'y']) } : {}) }))
  return { source: 'physical', seq: value.seq, tick: value.tick, kind: value.kind, payload }
}

/** Explicit public projection: config, hidden sample truth, quality contacts, faults and evaluator history are never exported. */
export function publicSnapshot(lab, systems = {}, base = {}) {
  return {
    devices: (lab.devices ?? []).map(d => pick(d, ['id', 'kind', 'methods', 'capacity', 'maximumBatchSamples', 'batchMultiple', 'waterRole', 'dirty', 'broken', 'enabled', 'shed', 'temperature', 'targetTemperature', 'calibrationId', 'calibratedUntil'])),
    samples: (lab.samples ?? []).map(s => pick(s, ['id', 'parentId', 'container', 'location', 'volumeUl', 'state', 'expiresAt', 'disposition', 'batchIds', 'exposureTicks'])),
    robots: (systems.robots ?? []).map(r => pick(r, ['id', 'x', 'y', 'node', 'energy', 'operationId', 'updatedTick', 'blockedEdge', 'segments'])),
    crops: (systems.crops ?? []).map(c => pick(c, ['id', 'chamberId', 'status', 'removed', 'availableSampleUl'])),
    facilities: pick(lab.facilities, ['ambientTemperature', 'powerCapacity', 'waterUl', 'waterCapacityUl']),
    batches: lab.batches ?? [], methods: lab.methods ?? [], results: lab.results ?? [], revocations: lab.revocations ?? [],
    energy: pick(base.energy, ['soc', 'solar', 'demand', 'tauDust', 'priority', 'shed', 'lowBattery']),
    atmosphere: Object.fromEntries(Object.entries(base.atmosphere ?? {}).map(([id, air]) => [id, pick(air, ['co2', 'pressure', 'setpoint', 'quarantine', 'lowPressure'])])),
    water: pick(base.water, ['reserve', 'route', 'inlineAlarm']),
    co2Tank: base.co2Tank ?? null, spares: base.spares ?? {}, metrics: pick(base.metrics, ['ticks', 'tierOneShedTicks', 'waterUnavailableTicks', 'shedTicksByLoad', 'sampleTicks']),
  }
}
export function publicReport(report) {
  return report ? pick(report, ['benchmarkVersion', 'version', 'tick', 'completionStatus', 'stopReason', 'R', 'q', 'O', 'F', 'jointConditions', 'failureReasons', 'components', 'services', 'commitments', 'response', 'phaseSeals', 'baselineMissing', 'calibrationStatus', 'formalRankingEligible', 'protocolHash', 'caseManifestHash', 'resultHash']) : null
}

export function compileOperations(labOperations, systemOperations, executionOperations, events) {
  const byId = new Map(), executions = new Map(executionOperations.map(o => [o.id, o]))
  for (const value of [...labOperations, ...systemOperations]) byId.set(value.id, { ...publicOperation(value), phases: [] })
  for (const event of events) {
    if (!['operation-accepted', 'operation-processing', 'operation-finished', 'system-operation-accepted', 'system-operation-settled', 'system-operation-refused'].includes(event.kind)) continue
    const p = event.payload, id = p.id
    if (!id) continue
    const op = byId.get(id) ?? { ...publicOperation(p), phases: [] }
    if (!op.command?.action && p.command) op.command = publicCommand(p.command)
    const phase = event.kind.endsWith('accepted') ? event.kind.startsWith('system-') ? 'processing' : 'loading' : event.kind === 'operation-processing' ? 'processing' : p.state === 'succeeded' ? 'completed' : p.state === 'cancelled' ? 'cancelled' : 'failed'
    op.phases.push({ tick: event.tick, phase, seq: event.seq })
    byId.set(id, op)
  }
  for (const op of byId.values()) {
    const execution = executions.get(op.id)
    op.actorId = execution?.actorId ?? null
    op.providerId = execution?.providerId ?? null
    op.phases.sort((a, b) => a.tick - b.tick || a.seq - b.seq)
    op.acceptedTick ??= op.phases[0]?.tick ?? 0
    op.deviceId = commandTarget(op.command)
    op.sampleIds = [...new Set([op.command?.sampleId, ...(op.command?.additionalSampleIds ?? [])].filter(Boolean))]
    op.resultIds = [...new Set([op.resultId, ...(op.resultIds ?? [])].filter(Boolean))]
    op.processingTick = op.phases.find(p => p.phase === 'processing')?.tick ?? null
  }
  return [...byId.values()].sort((a, b) => a.acceptedTick - b.acceptedTick || a.id.localeCompare(b.id))
}
export function commandTarget(command = {}) {
  if (command.action === 'panel_clean') return 'solar-array'
  if (command.action === 'power_priority') return 'battery'
  if (command.action === 'water_route') return 'pump'
  return command.deviceId ?? command.robotId ?? command.targetId ?? command.chamberId ?? (command.sourceId && ['reservoir', 'filter', 'pump'].includes(command.sourceId) ? command.sourceId : null)
}
export function actionTitle(op) {
  const action = op?.command?.action
  return action === 'process' ? ({ screen: '批次筛查', confirm: '确认检测', image: '样品成像', centrifuge: '样品离心' }[op.command.methodId] ?? '样品处理') : ACTION_NAMES[action] ?? action ?? '操作未记录'
}
export function phaseAt(op, tick, endTick) {
  if (tick < op.acceptedTick) return null
  const phases = op.phases.filter(p => p.tick <= tick)
  const phase = phases.at(-1)
  if (phase && ['completed', 'failed', 'cancelled'].includes(phase.phase)) return phase.tick === Math.floor(tick) ? phase.phase : null
  if (op.completedTick != null && tick >= op.completedTick) return tick < op.completedTick + 1 ? (op.state === 'succeeded' ? 'completed' : op.state === 'cancelled' ? 'cancelled' : 'failed') : null
  if (phase) return phase.phase
  if (tick === endTick && op.state === 'running') return op.stage === 'loading' ? 'loading' : 'processing'
  return 'unknown'
}
export function routePosition(route, tick, layout) {
  const nodes = new Map(layout.nodes.map(n => [n.id, n]))
  const segments = route?.segments ?? []
  if (!segments.length) return null
  let position = segments[0].fromPosition ?? nodes.get(segments[0].from)
  for (const segment of segments) {
    if (tick < segment.startTick) break
    const from = segment.fromPosition ?? nodes.get(segment.from), to = segment.toPosition ?? nodes.get(segment.to)
    if (!from || !to) return null
    if (tick >= segment.endTick) { position = to; continue }
    const f = Math.max(0, Math.min(1, (tick - segment.startTick) / Math.max(1, segment.endTick - segment.startTick)))
    return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f }
  }
  return position ? { x: position.x, y: position.y } : null
}
/** Restore only recorded work and routes. Historical health and inventory do not inherit the terminal snapshot. */
export function frameAt(run, inputTick) {
  const tick = Math.max(0, Math.min(run.tick, inputTick)), terminal = tick === run.tick
  const finalDevices = new Map(run.snapshot.devices.map(d => [d.id, d])), finalRobots = new Map(run.snapshot.robots.map(r => [r.id, r]))
  const roles = new Map(run.participants.map(p => [p.actorId, p.role]))
  const relevant = run.operations.filter(op => phaseAt(op, tick, run.tick))
  const observedFaults = new Set()
  if (!terminal) for (const event of run.events) {
    if (event.tick > tick) continue
    if (event.kind === 'device-fault' && event.payload.deviceId) observedFaults.add(event.payload.deviceId)
    if (event.kind === 'operation-finished' && event.payload.state === 'succeeded' && event.payload.command?.action === 'repair') observedFaults.delete(event.payload.command.deviceId)
  }
  const views = deviceCatalog(run.layout).map(meta => {
    const health = terminal ? finalDevices.get(meta.id) : null
    const related = relevant.filter(op => op.deviceId === meta.id || run.routes.some(r => r.robotId === meta.id && r.operationId === op.id))
    const active = related.findLast(op => !['completed', 'failed', 'cancelled'].includes(phaseAt(op, tick, run.tick))) ?? related.at(-1)
    let phase = active ? phaseAt(active, tick, run.tick) : health ? 'idle' : run.coverage.operationHistory ? 'idle' : 'unknown'
    const action = active?.command?.action
    if (phase === 'processing' && ['clean', 'calibrate', 'repair', 'sensor_calibrate', 'robot_sanitize', 'device_service', 'seal_inspect', 'seal_repair', 'panel_clean'].includes(action)) phase = 'maintenance'
    if (phase === 'processing' && meta.id.startsWith('robot-') && ['move', 'transfer', 'repair'].includes(action)) phase = 'moving'
    const flags = []
    if (health?.broken || observedFaults.has(meta.id)) flags.push('设备故障')
    if (health?.enabled === false) flags.push('已停用')
    if (health?.shed) flags.push('供电切断')
    if (health?.dirty) flags.push('下次使用前需清洗')
    if (health?.calibratedUntil != null && health.calibratedUntil < tick) flags.push('校准已过期')
    const view = { ...meta, phase, state: phase === 'maintenance' ? actionTitle(active) : PHASE_NAMES[phase], operation: active ?? null, flags, healthKnown: Boolean(health), health: health ?? null, actor: active ? roles.get(active.actorId) ?? active.actorId ?? '未记录' : null, samples: active?.sampleIds ?? [], positionKnown: !meta.id.startsWith('robot-') }
    if (meta.id.startsWith('robot-')) {
      if (terminal && finalRobots.has(meta.id)) { Object.assign(view, pick(finalRobots.get(meta.id), ['x', 'y', 'energy', 'node'])); view.positionKnown = true }
      else {
        const route = run.routes.filter(r => r.robotId === meta.id && r.tick <= tick).at(-1)
        if (route) {
          const settled = run.events.findLast(e => e.kind === 'robot-operation-settled' && e.payload.operationId === route.operationId && e.payload.robotId === meta.id && e.tick <= tick)
          const finish = run.operations.find(op => op.id === route.operationId)?.completedTick
          const position = settled?.payload.position ?? routePosition(route, Math.min(tick, finish ?? Infinity), run.layout)
          if (position) { Object.assign(view, pick(position, ['x', 'y'])); view.positionKnown = true }
        } else if (run.coverage.operationHistory) view.positionKnown = true
      }
    }
    view.motion = !flags.some(f => ['设备故障', '已停用', '供电切断'].includes(f)) && view.positionKnown
    view.alert = flags.includes('设备故障') ? 'fault' : flags.includes('供电切断') ? 'power' : null
    view.labelState = view.alert ? `${view.state} / ${view.alert === 'fault' ? '故障' : '限电'}` : view.phase === 'idle' && flags.includes('下次使用前需清洗') ? '待机 / 待清洗' : view.state
    return view
  })
  const crops = run.snapshot.crops.map(c => ({ id: c.id, chamberId: c.chamberId, status: terminal ? c.status : 'unknown', removed: terminal ? c.removed : false }))
  return { tick, terminal, devices: views, crops, inventoryTick: run.tick }
}

export function pairCompatibility(a, b) {
  if (!a || !b) return { compatible: false, reasons: ['需要两个已导入世界'] }
  const reasons = []
  if (a.id === b.id || a.mode === b.mode) reasons.push('需要不同运行的 Multi 与 Single')
  for (const key of ['benchmarkVersion', 'truthHash', 'saltHash', 'scenarioHash', 'caseManifestHash', 'protocolHash', 'horizon', 'decisionTicks']) {
    const x = key === 'benchmarkVersion' ? a.benchmarkVersion : a.manifest[key], y = key === 'benchmarkVersion' ? b.benchmarkVersion : b.manifest[key]
    if (x == null || y == null || x !== y) reasons.push(`${key} 未匹配`)
  }
  return { compatible: reasons.length === 0, reasons }
}
function requireValue(test, message) { if (!test) throw new Error(`数据包无效：${message}`) }
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const tickValue = x => Number.isSafeInteger(x) && x >= 0
const identifier = x => typeof x === 'string' && x.length > 0 && x.length <= 512 && !/[<>\x00-\x1f]/.test(x)
export function validateBundle(input) {
  requireValue(object(input) && input.version === BUNDLE_VERSION, '不支持的数据版本')
  requireValue(['experiment', 'fixture'].includes(input.source), '来源必须是 experiment 或 fixture')
  requireValue(Array.isArray(input.runs) && input.runs.length > 0 && input.runs.length <= 12, '应包含 1–12 个世界')
  const ids = new Set()
  for (const run of input.runs) {
    requireValue(object(run) && identifier(run.id) && !ids.has(run.id), '运行 ID 缺失或重复'); ids.add(run.id)
    requireValue(['multi', 'single'].includes(run.mode) && run.benchmarkVersion === 'v0.6', '只支持 v0.6 Multi / Single')
    requireValue(tickValue(run.tick) && tickValue(run.horizon) && run.horizon > 0 && run.tick <= run.horizon, '逻辑时间越界')
    requireValue(object(run.manifest) && object(run.snapshot) && object(run.coverage), '缺少元信息、快照或历史范围')
    requireValue(run.layout?.version === '0.3.0' && Array.isArray(run.layout.regions) && Array.isArray(run.layout.anchors) && Array.isArray(run.layout.nodes) && Array.isArray(run.layout.edges), '不支持的地图')
    const frozen = marsLayout()
    requireValue(JSON.stringify(run.layout.anchors) === JSON.stringify(frozen.anchors) && JSON.stringify(run.layout.nodes) === JSON.stringify(frozen.nodes) && run.layout.regions.length === 12 && run.layout.regions.every((r, i) => ['id', 'x', 'y', 'width', 'height'].every(key => r[key] === frozen.regions[i][key])), '地图锚点与当前版本不一致')
    for (const field of ['events', 'operations', 'routes', 'participants', 'facts', 'analyses', 'measurements', 'raw']) requireValue(Array.isArray(run[field]) && run[field].length <= 1000000, `${field} 不是记录数组`)
    for (const field of ['devices', 'samples', 'robots', 'crops', 'results', 'batches', 'methods', 'revocations']) requireValue(Array.isArray(run.snapshot[field]) && run.snapshot[field].every(object), `缺少终态 ${field}`)
    for (const field of ['devices', 'samples', 'robots', 'crops', 'batches']) requireValue(run.snapshot[field].every(row => identifier(row.id)) && new Set(run.snapshot[field].map(row => row.id)).size === run.snapshot[field].length, `终态 ${field} ID 无效`)
    for (const crop of run.snapshot.crops) requireValue(identifier(crop.chamberId) && ['healthy', 'stressed', 'lost'].includes(crop.status) && typeof crop.removed === 'boolean', '植株状态无效')
    requireValue(tickValue(run.coverage.fromTick) && tickValue(run.coverage.toTick) && run.coverage.fromTick <= run.coverage.toTick && run.coverage.toTick === run.tick && typeof run.coverage.operationHistory === 'boolean' && Array.isArray(run.coverage.warnings), '历史范围无效')
    for (const device of run.snapshot.devices) requireValue(object(device) && identifier(device.id), '器材 ID 无效')
    for (const participant of run.participants) requireValue(object(participant) && identifier(participant.actorId) && typeof participant.role === 'string', '角色记录无效')
    for (const row of [...run.raw, ...run.measurements]) requireValue(object(row) && identifier(row.id) && Object.hasOwn(row, 'data'), '原始数据引用无效')
    for (const a of run.analyses) requireValue(object(a) && identifier(a.id) && typeof a.code === 'string' && tickValue(a.asOfTick) && (a.dataAccesses == null || Array.isArray(a.dataAccesses) && a.dataAccesses.every(d => object(d) && typeof d.kind === 'string' && typeof d.id === 'string')), '分析记录无效')
    for (const f of run.facts) {
      requireValue(object(f) && typeof f.kind === 'string' && object(f.data) && Number.isSafeInteger(f.seq) && f.seq > 0 && (f.tick == null || tickValue(f.tick) && f.tick <= run.tick), '执行事实结构无效')
      if (f.kind === 'mars-v06-record') {
        requireValue(object(f.data.result) && typeof f.data.operation === 'string', '科研收据无效')
        if (f.data.operation === 'submission') requireValue(typeof f.data.result.taskId === 'string' && Array.isArray(f.data.result.evidence) && f.data.result.evidence.every(e => object(e) && identifier(e.id)) && Array.isArray(f.data.result.references), '提交证据结构无效')
      }
      if (f.kind === 'mars-v06-research') requireValue(object(f.data.record) && identifier(f.data.record.id) && (f.data.record.evidence == null || Array.isArray(f.data.record.evidence)), '研究记录结构无效')
    }
    if (run.catalog?.tasks) requireValue(Array.isArray(run.catalog.tasks) && run.catalog.tasks.every(t => object(t) && identifier(t.id) && typeof t.title === 'string'), '任务目录无效')
    if (run.report) {
      requireValue(object(run.report) && (run.report.R == null || Number.isFinite(run.report.R) && run.report.R >= 0 && run.report.R <= 100) && (run.report.F == null || typeof run.report.F === 'boolean'), '结算字段无效')
      if (run.report.q) requireValue(object(run.report.q) && Object.values(run.report.q).every(v => Number.isFinite(v) && v >= 0 && v <= 1 + 1e-9), '科研质量字段无效')
      for (const field of ['jointConditions', 'phaseSeals', 'failureReasons']) if (run.report[field] != null) requireValue(Array.isArray(run.report[field]), '结算记录数组无效')
    }
    const opIds = new Set()
    for (const op of run.operations) {
      requireValue(identifier(op.id) && !opIds.has(op.id) && object(op.command) && Array.isArray(op.phases), '操作结构或 ID 无效'); opIds.add(op.id)
      requireValue(tickValue(op.acceptedTick) && op.acceptedTick <= run.tick && (op.completedTick == null || tickValue(op.completedTick) && op.completedTick >= op.acceptedTick && op.completedTick <= run.tick), '操作时间无效')
      let prior = -1
      for (const p of op.phases) { requireValue(tickValue(p.tick) && p.tick >= op.acceptedTick && p.tick <= run.tick && p.tick >= prior && ['loading', 'processing', 'completed', 'failed', 'cancelled'].includes(p.phase), '操作阶段无效'); prior = p.tick }
      requireValue(Array.isArray(op.sampleIds) && Array.isArray(op.resultIds), '操作关联缺失')
    }
    let priorSeq = 0
    for (const e of run.events) { requireValue(tickValue(e.tick) && e.tick <= run.tick && Number.isSafeInteger(e.seq) && e.seq > priorSeq && typeof e.kind === 'string' && object(e.payload), '物理事件顺序无效'); priorSeq = e.seq }
    for (const route of run.routes) {
      requireValue(identifier(route.robotId) && identifier(route.operationId) && tickValue(route.tick) && route.tick <= run.tick && Array.isArray(route.segments), '路线结构无效')
      for (const s of route.segments) requireValue(tickValue(s.startTick) && tickValue(s.endTick) && s.endTick >= s.startTick && identifier(s.from) && identifier(s.to) && (!s.fromPosition || Number.isFinite(s.fromPosition.x) && Number.isFinite(s.fromPosition.y)) && (!s.toPosition || Number.isFinite(s.toPosition.x) && Number.isFinite(s.toPosition.y)), '路线片段无效')
    }
    requireValue(object(run.telemetry), '遥测缺失')
    for (const [channel, rows] of Object.entries(run.telemetry)) {
      requireValue(identifier(channel) && Array.isArray(rows), '遥测通道无效')
      let at = -1
      for (const row of rows) { requireValue(Array.isArray(row) && row.length === 2 && tickValue(row[0]) && row[0] <= run.tick && row[0] >= at && (row[1] === null || Number.isFinite(row[1])), '遥测点无效'); at = row[0] }
    }
    for (const r of run.snapshot.robots) requireValue(identifier(r.id) && Number.isFinite(r.x) && Number.isFinite(r.y), '机器人坐标无效')
    if (input.source === 'experiment') requireValue(run.tick === run.horizon && run.report?.completionStatus === 'finalized' && run.report.tick === run.tick, '实验尚未完成正式结算')
  }
  return input
}
