import { esc, num, table, kv, jsonView, empty, actionButton, recordRow } from './dom.js'
import { TASKS, DEVICE_NAMES, PHASE_NAMES } from './layout.js'
import { actionTitle, pairCompatibility } from './data.js'
import { lineChart, heatmap } from './charts.js'

export const PANEL_DEFINITIONS = {
  research: { title: '科研', tabs: ['目标与提交', '研究记录', '原始数据', '分析运行', '运行总览'] },
  records: { title: '实验记录', tabs: ['物理操作', '异常与事件', '样品与耗材', '可用历史'] },
  team: { title: 'AI 工作', tabs: ['团队与决策', '工作消息', '任务看板'] },
  resources: { title: '资源', tabs: ['能源', '水路', '温室', '全部遥测'] },
  compare: { title: '对照', tabs: ['Multi / Single', '联合条件', '运行清单'] },
  equipment: { title: '器材列表', tabs: ['器材与设施'] },
  dataset: { title: '运行记录', tabs: ['导入与来源'] },
  map: { title: '基地定位', tabs: ['房间', '通道'] },
}
function roles(run) { return new Map(run.participants.map(p => [p.actorId, p.role])) }
function phaseLabel(value) { return ({ running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', completed: '已完成', pending: '待执行' })[value] ?? value ?? '未记录' }
function fieldSelect(id, values, selected) { return `<select id="${esc(id)}">${values.map(([value, text]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>` }
function filterForm(query, label = '搜索记录') { return `<form class="record-filter" id="record-filter"><label><span class="sr-only">${esc(label)}</span><input name="query" type="search" placeholder="${esc(label)}" value="${esc(query ?? '')}"></label><button type="submit">查找</button></form>` }
function pageRows(rows, options) {
  const query = String(options.query ?? '').toLocaleLowerCase(), filtered = query ? rows.filter(row => JSON.stringify(row).toLocaleLowerCase().includes(query)) : rows
  const page = Math.max(0, Math.min(Math.floor((filtered.length - 1) / 50), options.page ?? 0))
  return { rows: filtered.slice(page * 50, page * 50 + 50), pagination: `<div class="pagination">${actionButton('page', Math.max(0, page - 1), '上一页')}<span>${filtered.length ? page * 50 + 1 : 0}–${Math.min((page + 1) * 50, filtered.length)} / ${filtered.length}</span>${actionButton('page', page + 1, '下一页')}</div>` }
}
function recordReceipts(run, kind) { return run.facts.filter(f => f.kind === 'mars-v06-record' && f.data?.operation === kind && f.data.result).map(f => ({ ...f.data.result, actorId: f.data.actorId ?? f.actorId })) }
function resultLink(run, id) {
  if (run.raw.some(r => r.id === id) || run.measurements.some(r => r.id === id)) return actionButton('raw', id, id)
  if (run.analyses.some(r => r.id === id)) return actionButton('analysis', id, id)
  if (run.operations.some(r => r.id === id)) return actionButton('operation', id, id)
  const result = run.snapshot.results.find(r => r.id === id)
  return result ? actionButton('operation', result.operationId, id) : `<span class="reference-id">${esc(id)}（关联未导出）</span>`
}
function science(run, tab, options) {
  if (tab === 0) {
    const submissions = recordReceipts(run, 'submission'), selected = options.taskId ?? 'T1', tasks = run.catalog?.tasks?.length ? run.catalog.tasks : TASKS
    const byRole = roles(run)
    const task = tasks.find(t => t.id === selected) ?? tasks[0]
    const history = submissions.filter(s => s.taskId === task?.id)
    return `<p class="source-note">${esc(run.catalog?.instructions ?? 'v0.6 科研记录；baseline 为诊断，R 取最终 T1–T5，O 与 F 分别展示。')}</p>`
      + table(['任务', '最终提交', '基线提交', 'q（0–1）'], tasks.map(task => [actionButton('task', task.id, `${task.id} ${task.title}`), submissions.filter(s => s.taskId === task.id && s.slotId === 'final').length, submissions.filter(s => s.taskId === task.id && s.slotId === 'baseline').length, task.id === 'T6' ? '联合条件' : num(run.report?.q?.[task.id], 3)]))
      + `<h3>${esc(task?.id)} ${esc(task?.title)}</h3>` + (history.length ? history.map(s => `<article class="submission"><h4>${esc(s.slotId)} · 修订 ${num(s.revision, 0)} · tick ${num(s.acceptedTick, 0)}</h4><p class="source-note">提交者 ${esc(byRole.get(s.actorId) ?? s.actorId ?? '未记录')}</p><div class="reference-list">${(s.evidence ?? []).map(e => resultLink(run, e.id)).join('') || '无证据引用'}</div>${jsonView(s.payload, '查看提交内容')}${jsonView(s.references, '查看冻结引用')}</article>`).join('') : empty('该任务没有已导出的提交。'))
      + `<h3>模型、管线与前瞻提交</h3>` + table(['类型', 'ID', '接纳 tick', '任务'], ['model', 'pipeline', 'prediction'].flatMap(kind => recordReceipts(run, kind).map(r => [esc(kind), esc(r.id ?? r.pipelineId), num(r.acceptedTick, 0), esc(r.taskId ?? '—')])))
  }
  if (tab === 1) {
    const entries = run.facts.filter(f => f.kind === 'mars-v06-research').map(f => f.data.record).filter(Boolean)
    const latest = [...new Map(entries.map(r => [r.id, r])).values()], page = pageRows(latest, options)
    return filterForm(options.query, '搜索研究记录') + (page.rows.length ? page.rows.map(r => `<article class="submission"><h4>${esc(r.id)} · ${esc(r.kind)} · 修订 ${num(r.revision, 0)}</h4><p class="source-note">${esc(r.project)} · 可用 tick ${num(r.availableAt, 0)}</p>${jsonView(r.content, '查看记录内容')}<div class="reference-list">${(r.evidence ?? []).map(e => resultLink(run, e.id)).join('')}</div></article>`).join('') : empty()) + page.pagination
  }
  if (tab === 2) return rawData(run, options)
  if (tab === 3) return analysisData(run, options)
  return overview(run)
}
function rawData(run, options) {
  const ids = [...new Set([...run.raw.map(r => r.id), ...run.measurements.map(r => r.id)])]
  if (!ids.length) return empty('这份记录中没有仪器原始数据或测量结果。')
  const id = ids.includes(options.rawId) ? options.rawId : ids[0], raw = run.raw.find(r => r.id === id)?.data, measurement = run.measurements.find(r => r.id === id)?.data
  const result = run.snapshot.results.find(r => r.id === id)
  let html = `<div class="filter-row"><label>结果 ${fieldSelect('raw-picker', ids.map(id => [id, id]), id)}</label>${actionButton('download-raw', id, '下载本条数据')}${result ? actionButton('operation', result.operationId, '定位检测') : ''}</div>`
  if (raw?.kind === 'chromatogram' && Array.isArray(raw.points)) {
    html += lineChart({ title: '仪器原始色谱', xLabel: '分钟', unit: '信号', series: [{ name: '信号', points: raw.points.map((value, i) => [i * (raw.dtMinutes ?? .02), value]) }] })
    html += `<p class="source-note">曲线来自原始数据；页面不自动判断峰或浓度。</p>`
  } else if (raw?.kind === 'hyperspectral' || raw?.kind === 'chamber-scan') {
    let cube = raw
    if (raw.kind === 'chamber-scan') {
      const crops = Object.keys(raw.cubes ?? {}), active = crops.includes(options.cropId) ? options.cropId : crops[0]
      html += `<label class="filter-row">植株 ${fieldSelect('crop-picker', crops.map(id => [id, id]), active)}</label>`; cube = raw.cubes?.[active]
    }
    if (cube?.data?.length) {
      const bands = cube.bandNames ?? cube.data.map((_, i) => `波段 ${i + 1}`), index = options.band === -1 ? -1 : Math.max(0, Math.min(bands.length - 1, Number(options.band) || 0))
      html += `<label class="filter-row">波段 ${fieldSelect('band-picker', [...bands.map((name, i) => [i, name]), [-1, 'b6 / b4']], index)}</label>`
      const matrix = index === -1 ? cube.data[5]?.map((row, y) => row.map((v, x) => Number.isFinite(v) && cube.data[3]?.[y]?.[x] ? v / cube.data[3][y][x] : null)) : cube.data[index]
      html += heatmap(matrix, index === -1 ? 'b6 / b4' : bands[index])
    } else html += empty('本次扫描未包含可显示的光谱立方体。')
  } else if (raw) html += jsonView(raw, '查看原始数据')
  else html += empty('这条结果只有测量摘要，没有对应原始文件。')
  return html + (measurement ? jsonView(measurement, '仪器测量摘要') : '')
}
function analysisData(run, options) {
  if (!run.analyses.length) return empty('这份运行记录没有已保存的分析程序。')
  const record = run.analyses.find(a => a.id === options.analysisId) ?? run.analyses[0]
  return `<div class="filter-row"><label>分析 ${fieldSelect('analysis-picker', run.analyses.map(a => [a.id, `${a.id} · ${a.status}`]), record.id)}</label>${actionButton('download-analysis', record.id, '下载分析记录')}</div>`
    + kv([['状态', record.status], ['可用 tick', record.asOfTick], ['执行者', roles(run).get(record.actorId) ?? record.actorId], ['程序哈希', record.codeSha256]])
    + (record.error ? `<p class="notice">${esc(record.error)}</p>` : '')
    + `<h3>记录的输出</h3><pre class="data-pre">${esc(JSON.stringify(record.output, null, 2))}</pre><h3>程序</h3><pre class="data-pre">${esc(record.code)}</pre>`
    + `<p class="source-note">程序仅供查看，不在浏览器执行。</p>`
    + table(['访问类型', '引用'], (record.dataAccesses ?? []).map(a => [esc(a.kind), resultLink(run, a.id)])) + jsonView(record.logs, '程序日志')
}
function overview(run) {
  const r = run.report
  return kv([['运行', run.id], ['版本', run.benchmarkVersion], ['终态 tick', `${run.tick} / ${run.horizon}`], ['物理操作', run.operations.length], ['样品', run.snapshot.samples.length], ['原始数据', run.raw.length], ['分析程序', run.analyses.length], ['结算', r?.completionStatus ?? '未记录']])
    + `<h3>科研与运行结算</h3>` + (r ? kv([['R 科研分', num(r.R)], ['F 联合条件', r.F === true ? '全部通过' : r.F === false ? '存在未通过条件' : '未记录'], ['评价状态', r.calibrationStatus], ['正式排名资格', r.formalRankingEligible === true ? '有' : '无']]) + jsonView(r.O, 'O 运行诊断') + jsonView(r, '完整公开报告') : empty('未附带结算报告。'))
}
function records(run, tab, options) {
  if (tab === 0) {
    const page = pageRows(run.operations, options), selected = run.operations.find(o => o.id === options.opId), byRole = roles(run)
    let html = filterForm(options.query, '搜索操作、器材或样品') + table(['操作', '器材', '状态', '起止 tick', '调用者'], page.rows.map(o => [actionButton('operation-detail', o.id, `${o.id} · ${actionTitle(o)}`), esc(DEVICE_NAMES[o.deviceId] ?? o.deviceId ?? '未记录'), esc(phaseLabel(o.state)), `${num(o.acceptedTick, 0)}–${num(o.completedTick, 0)}`, esc(byRole.get(o.actorId) ?? o.actorId ?? '未记录')])) + page.pagination
    if (selected) html += `<h3>${esc(selected.id)} · ${esc(actionTitle(selected))}</h3><div class="filter-row">${actionButton('operation', selected.id, '回看并定位')}${selected.deviceId ? actionButton('locate', selected.deviceId, '定位器材') : ''}</div>` + kv([['阶段记录', selected.phases.map(p => `${p.tick} ${PHASE_NAMES[p.phase]}`).join(' / ')], ['输入样品', selected.sampleIds.join('、') || '无'], ['结果', selected.resultIds.join('、') || '无'], ['详情', selected.detail ?? '—']]) + `<div class="reference-list">${selected.resultIds.map(id => resultLink(run, id)).join('')}</div>` + jsonView(selected.command, '操作参数')
    return html
  }
  if (tab === 1) {
    const entries = run.events.filter(e => !['operation-accepted', 'operation-processing', 'operation-finished', 'robot-route-accepted', 'robot-operation-settled', 'system-operation-accepted', 'system-operation-settled', 'laboratory-created'].includes(e.kind)), page = pageRows(entries, options)
    return filterForm(options.query, '搜索事件') + (page.rows.length ? page.rows.map(e => `<article class="submission"><h4>tick ${num(e.tick, 0)} · ${esc(e.kind)}</h4>${jsonView(e.payload, '事件内容')}${actionButton('seek', e.tick, '回看此刻')}</article>`).join('') : empty('没有已导出的异常或额外事件。')) + page.pagination
  }
  if (tab === 2) {
    const page = pageRows(run.snapshot.samples, options)
    return `<p class="source-note">终态库存，tick ${num(run.tick, 0)}。过去库存未完整记录时不进行反向推测。</p>` + filterForm(options.query, '搜索样品') + table(['样品', '父样品', '位置', '余量 / μL', '状态', '有效至'], page.rows.map(s => [esc(s.id), esc(s.parentId ?? '—'), DEVICE_NAMES[s.location] ? actionButton('locate', s.location, DEVICE_NAMES[s.location]) : esc(s.location), num(s.volumeUl, 0), esc(`${s.state} / ${s.disposition}`), num(s.expiresAt, 0)])) + page.pagination
      + `<h3>耗材与备件</h3>` + table(['耗材批次', '类型', '余量', '状态'], run.snapshot.batches.map(b => [esc(b.id), esc(b.kind), num(b.units, 0), esc(b.disposition)])) + kv(Object.entries(run.snapshot.spares ?? {}))
  }
  return history(run)
}
function history(run) {
  return kv([['可用事件范围', `${run.coverage.fromTick}–${run.coverage.toTick} tick`], ['物理事件', run.events.length], ['完整操作阶段', run.coverage.operationHistory ? '是' : '否，缺口不补造'], ['终态快照', `tick ${run.tick}`], ['历史健康状态', '仅显示有依据的阶段；终态维护标记不回填'], ['历史库存', '不提供未记录的历史库存']])
    + `<div class="filter-row">${actionButton('replay', '', '打开回看')}${actionButton('seek', run.tick, '回到终态')}</div>`
    + (run.coverage.warnings ?? []).map(w => `<p class="notice">${esc(w)}</p>`).join('')
    + `<h3>封存记录</h3>` + table(['阶段', 'tick', '哈希'], (run.report?.phaseSeals ?? []).map(s => [esc(s.stage), num(s.tick, 0), esc(s.hash)]))
}
function team(run, tab, options) {
  const byRole = roles(run)
  if (tab === 0) {
    const decisions = run.facts.filter(f => f.kind === 'mars-native-decision'), page = pageRows(decisions, options)
    return table(['角色', '执行者', '记录的科研准入次数'], run.participants.map(p => [esc(p.role), esc(p.actorId), decisions.filter(d => (d.data.actorId ?? d.actorId) === p.actorId).length]))
      + `<p class="source-note">此处统计 Host 记录的科研决策准入，不等同于模型 API 请求数。记录不含实时在线状态。</p>` + filterForm(options.query, '搜索角色或 tick')
      + table(['来源序号', 'tick', '角色'], page.rows.map(d => [d.seq, num(d.tick, 0), esc(byRole.get(d.data.actorId ?? d.actorId) ?? d.actorId)])) + page.pagination
      + jsonView(run.facts.filter(f => f.kind === 'mars-model-usage').map(f => f.data), '已导出的模型用量记录')
  }
  if (tab === 1) {
    const messages = run.facts.filter(f => ['mars-mail', 'mars-mail-created'].includes(f.kind)), page = pageRows(messages, options)
    return filterForm(options.query, '搜索工作消息') + (page.rows.length ? page.rows.map(f => {
      const d = f.data, m = d.message ?? d
      return recordRow(`${m.from ?? m.senderRole ?? '未记录'} → ${d.role ?? m.targetRole ?? '未记录'} · tick ${num(m.tick ?? f.tick, 0)}`, m.text ?? m.content ?? '')
    }).join('') : empty('没有已导出的工作消息。')) + page.pagination
  }
  const tasks = [...new Map(run.facts.filter(f => f.kind === 'mars-record-mutation' && f.data.result?.title && f.data.result?.state).map(f => [f.data.result.id, f.data.result])).values()]
  return table(['任务', '负责人', '状态', '修订', '结果'], tasks.map(t => [esc(t.title), esc(byRole.get(t.assignee) ?? t.assignee ?? '未分配'), esc(phaseLabel(t.state)), num(t.revision, 0), esc(t.reason ?? '—')]))
}
function telemetryChart(run, title, channels, unit = '') {
  return lineChart({ title, unit, series: channels.map(([key, name]) => ({ name, points: run.telemetry[key] ?? [] })) })
}
function resources(run, tab, options) {
  const snapshot = run.snapshot
  const scope = `<p class="source-note">终态读数 tick ${num(run.tick, 0)}；曲线展示本次运行导出的完整遥测，缺测保留空档。</p>`
  if (tab === 0) return scope + kv([['终态太阳能', num(snapshot.energy?.solar)], ['终态需求', num(snapshot.energy?.demand)], ['终态储能', num(snapshot.energy?.soc)], ['当前切断负载', snapshot.energy?.shed?.join('、') || '无'], ['一级限电 tick', num(snapshot.metrics?.tierOneShedTicks, 0)]])
    + telemetryChart(run, '发电与需求', [['energy.solar', '发电'], ['energy.demand', '需求']], '模拟功率单位')
    + telemetryChart(run, '电池储能', [['energy.soc', '储能']], '模拟能量单位') + telemetryChart(run, '沙尘读数', [['energy.tau_dust', 'τ_dust']])
    + table(['优先级', '负载', '累计切断 tick', '终态'], (snapshot.energy?.priority ?? []).map((id, i) => [i + 1, esc(DEVICE_NAMES[id] ?? id), num(snapshot.metrics?.shedTicksByLoad?.[id] ?? 0, 0), snapshot.energy?.shed?.includes(id) ? '切断' : '供电']))
  if (tab === 1) return scope + kv([['水箱 / μL', num(snapshot.facilities?.waterUl, 0)], ['水箱标称容量 / μL', num(snapshot.facilities?.waterCapacityUl, 0)], ['备用水 / μL', num(snapshot.water?.reserve, 0)], ['灌溉水源', snapshot.water?.route], ['水不可用 tick', num(snapshot.metrics?.waterUnavailableTicks, 0)]])
    + `<div class="filter-row">${['reservoir', 'filter', 'pump'].map(id => actionButton('locate', id, DEVICE_NAMES[id])).join('')}</div>`
    + telemetryChart(run, '水箱与备用水', [['water.tank', '水箱'], ['water.reserve', '备用水']], 'μL')
    + ['reservoir', 'filter', 'pump'].map(id => telemetryChart(run, `${DEVICE_NAMES[id]}在线读数`, [[`${id}.doc_inline`, '在线 DOC']], 'mg/L')).join('')
  if (tab === 2) {
    const chambers = [1, 2, 3, 4].map(i => `incubator-${i}`), chamber = chambers.includes(options.chamberId) ? options.chamberId : chambers[0]
    return scope + table(['植株', '温室', '终态', '可采样 / μL'], snapshot.crops.map(c => [esc(c.id), actionButton('locate', c.chamberId, DEVICE_NAMES[c.chamberId] ?? c.chamberId), esc(c.removed ? '已移除' : c.status), num(c.availableSampleUl, 0)]))
      + `<label class="filter-row">温室 ${fieldSelect('chamber-picker', chambers.map((id, i) => [id, `温室 ${'ABCD'[i]}`]), chamber)}</label>`
      + telemetryChart(run, '温度', [[`${chamber}.temperature`, '温度读数']], '°C') + telemetryChart(run, '二氧化碳', [[`${chamber}.co2`, 'CO₂']], 'ppm') + telemetryChart(run, '气压', [[`${chamber}.pressure`, '气压']], 'kPa')
  }
  const channels = Object.keys(run.telemetry).sort(), channel = channels.includes(options.channel) ? options.channel : channels[0]
  return channels.length ? scope + `<label class="filter-row">通道 ${fieldSelect('telemetry-picker', channels.map(c => [c, c]), channel)}</label>` + telemetryChart(run, channel, [[channel, channel]]) : empty('没有已导出的遥测。')
}
function comparison(bundle, tab, options) {
  const left = bundle.runs.find(r => r.id === options.leftId) ?? bundle.runs.find(r => r.mode === 'multi') ?? bundle.runs[0]
  const right = bundle.runs.find(r => r.id === options.rightId) ?? bundle.runs.find(r => r.mode === 'single')
  const result = pairCompatibility(left, right)
  const selectors = `<div class="filter-row"><label>左侧 ${fieldSelect('compare-left', bundle.runs.map(r => [r.id, `${r.label} · ${r.id.slice(0, 18)}`]), left?.id)}</label><label>右侧 ${fieldSelect('compare-right', [['', '选择世界'], ...bundle.runs.map(r => [r.id, `${r.label} · ${r.id.slice(0, 18)}`])], right?.id ?? '')}</label></div>`
  if (!right) return selectors + empty('导入另一个世界后显示对照。')
  if (!result.compatible) return selectors + `<p class="notice">这两个世界未通过配对检查，差值与联合对照暂不显示。</p>` + result.reasons.map(r => `<p>${esc(r)}</p>`).join('')
  if (tab === 2) return selectors + table(['清单字段', left.label, right.label], Object.keys(left.manifest).map(key => [esc(key), esc(JSON.stringify(left.manifest[key])), esc(JSON.stringify(right.manifest[key]))]))
  if (tab === 1) {
    const a = new Map((left.report?.jointConditions ?? []).map(c => [c.id, c.passed])), b = new Map((right.report?.jointConditions ?? []).map(c => [c.id, c.passed]))
    return selectors + table(['联合条件', left.label, right.label], [...new Set([...a.keys(), ...b.keys()])].map(id => [esc(id), a.has(id) ? a.get(id) ? '✓ 通过' : '! 未通过' : '未记录', b.has(id) ? b.get(id) ? '✓ 通过' : '! 未通过' : '未记录']))
  }
  const a = left.report, b = right.report
  return selectors + `<p class="source-note">已核对版本、场景、真值身份、实例、协议与逻辑时间规则。R 为科研分；O 为独立运行诊断；F 为联合条件，不叠加到 R。${bundle.source === 'fixture' ? '当前全部是集成样例。' : ''}</p>`
    + table(['结算', left.label, right.label, '左 − 右'], [['R 科研分', num(a?.R), num(b?.R), typeof a?.R === 'number' && typeof b?.R === 'number' ? num(a.R - b.R) : '未记录'], ['F 联合条件', a?.F ? '通过' : '未通过', b?.F ? '通过' : '未通过', '—'], ...['T1', 'T2', 'T3', 'T4', 'T5'].map(t => [t, num(a?.q?.[t], 3), num(b?.q?.[t], 3), typeof a?.q?.[t] === 'number' && typeof b?.q?.[t] === 'number' ? num(a.q[t] - b.q[t], 3) : '未记录'])])
    + `<h3>O 运行诊断</h3>` + table(['项目', left.label, right.label], [...new Set([...Object.keys(a?.O ?? {}), ...Object.keys(b?.O ?? {})])].map(key => [esc(key), esc(a?.O?.[key] ?? '未记录'), esc(b?.O?.[key] ?? '未记录')]))
    + `<p class="source-note">${esc(a?.calibrationStatus ?? '未记录')}；正式排名资格：${a?.formalRankingEligible && b?.formalRankingEligible ? '已具备' : '未具备'}。</p>`
    + `<div class="filter-row">${actionButton('world', left.id, `观察 ${left.label}`)}${actionButton('world', right.id, `观察 ${right.label}`)}</div>`
}
function dataset(bundle, run) {
  return `<p class="source-note">${bundle.source === 'fixture' ? '当前是独立集成样例，所有数值与事件均用于验证前端。' : '当前载入已完成实验的只读记录。'}</p>`
    + `<div class="filter-row">${actionButton('import', '', '导入数据包')}${actionButton('export-bundle', '', '下载当前数据包')}</div>`
    + `<label class="merge-option"><input id="merge-worlds" type="checkbox" checked>追加其它已结束世界；导入正式数据时自动移除集成样例</label>`
    + table(['世界', '运行 ID', '终态 tick', '查看'], bundle.runs.map(r => [esc(r.label), esc(r.id), num(r.tick, 0), actionButton('world', r.id, '切换')]))
    + `<h3>当前世界的来源与完整性</h3>` + history(run) + table(['源文件', 'SHA-256'], (run.sources ?? []).map(s => [esc(s.file), esc(s.sha256)]))
}
export function renderPanel(context, key, tab, options = {}) {
  const { bundle, run, frame } = context
  let html
  if (key === 'research') html = science(run, tab, options)
  else if (key === 'records') html = records(run, tab, options)
  else if (key === 'team') html = team(run, tab, options)
  else if (key === 'resources') html = resources(run, tab, options)
  else if (key === 'compare') html = comparison(bundle, tab, options)
  else if (key === 'dataset') html = dataset(bundle, run)
  else if (key === 'equipment') html = `<div class="equipment-list">${frame.devices.map(d => `<button data-action="locate" data-value="${esc(d.id)}"><b>${esc(d.name)}</b><span>${esc(d.state)}${d.flags.length ? ' · ' + esc(d.flags.join('、')) : ''}</span></button>`).join('')}</div>`
  else if (key === 'map') html = tab === 0 ? `<div class="equipment-list">${run.layout.regions.map(r => `<button data-action="region" data-value="${esc(r.id)}"><b>${esc(r.label)}</b><span>${r.width} × ${r.height}</span></button>`).join('')}</div>` : table(['通道起点', '通道终点', '通行'], run.layout.corridors.map(c => [esc(c.from), esc(c.to), `${c.lanes} 车道`]))
  else html = empty()
  return `<p class="source-note panel-scope">${bundle.source === 'fixture' ? '集成样例' : '实验记录'} · ${esc(run.label)} · 终态 tick ${num(run.tick, 0)}</p>${html}`
}
