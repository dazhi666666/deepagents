/* 危机时间线：运行中只显示公开事件、报告与处置操作；结算后叠加真实事件与四项分值。 */
import { EVENT_LABEL, EVENT_TONE, badge, empty, eventText, n, settle } from './common.js'

const ACTIONS = ['repair', 'calibrate', 'water_route', 'power_priority', 'seal_repair', 'seal_inspect', 'crop_remove', 'panel_clean', 'robot_sanitize', 'device_service', 'sensor_calibrate', 'quarantine', 'device_reference']
const LANES = [
  { id: 'announcement', label: '公告与报警' },
  { id: 'report', label: '异常报告' },
  { id: 'action', label: '处置操作' },
]

export function createIncidents(ctx) {
  const { api, t, esc, state } = ctx
  const rootId = 'mars-incidents-root'
  let busy = false
  let data = { snapshot: null, announcements: [], reports: [], evaluation: null }

  async function load(force) {
    if (busy) return
    busy = true
    try {
      const snapshot = await api.snapshot(force)
      const [announcements, reports, evaluation] = await settle([
        api.announcements(), api.incidentReports(),
        snapshot.status === 'completed' ? api.evaluation() : Promise.resolve(null),
      ])
      data = { snapshot, announcements: announcements?.events ?? [], reports: reports ?? [], evaluation }
    } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  function marker(tick, horizon, tone, label) {
    return `<span class="m-marker tone-${tone}" style="left:${Math.max(0, Math.min(100, tick / horizon * 100))}%" title="${esc(label)}"></span>`
  }

  function paint() {
    if (!data.snapshot || !document.getElementById('m-timeline') || state.view !== 'mars-incidents') return
    const { snapshot, announcements, reports, evaluation } = data
    const horizon = snapshot.sensors?.horizon || 2400, now = snapshot.tick ?? 0
    const actions = (snapshot.operations ?? []).filter((operation) => ACTIONS.includes(operation.action) && operation.acceptedTick !== null)
    const rows = [
      { ...LANES[0], items: announcements.map((event) => ({ tick: event.tick, tone: EVENT_TONE[event.kind] ?? 'info', label: `${t(EVENT_LABEL[event.kind] ?? event.kind)} · ${eventText(event, t)}` })) },
      { ...LANES[1], items: reports.map((report) => ({ tick: report.tick, tone: 'info', label: `${report.category ?? ''} · ${(report.entities ?? []).join('、')}` })) },
      { ...LANES[2], items: actions.map((operation) => ({ tick: operation.acceptedTick, tone: 'ok', label: `${operation.action} · ${operation.requestKey ?? operation.id}` })) },
    ]
    const truthRow = evaluation ? `<div class="m-lane truth"><span class="m-lane-name">${t('真实事件')}</span><div class="m-lane-track">
      ${(evaluation.incidents ?? []).map((incident) => marker(incident.onset, horizon, 'bad', `${incident.id} ${t('开始于第 {tick} 步', { tick: incident.onset })}`)).join('')}
      ${(evaluation.truth?.storms ?? []).map((storm) => `<span class="m-marker-band" style="left:${storm.onset / horizon * 100}%;width:${storm.duration / horizon * 100}%" title="${storm.event} ${t('持续 {n} 步', { n: storm.duration })}"></span>`).join('')}
      </div></div>` : ''
    document.getElementById('m-timeline').innerHTML = `<div class="m-time-head"><span>0</span><span>${t('当前 {tick}', { tick: now })}</span><span>${horizon}</span></div>
      ${rows.map((row) => `<div class="m-lane"><span class="m-lane-name">${t(row.label)}</span><div class="m-lane-track">${row.items.map((item) => marker(item.tick, horizon, item.tone, item.label)).join('')}</div></div>`).join('')}
      ${truthRow}
      <div class="m-time-foot"><span>0</span><span>${Math.round(horizon / 2)}</span><span>${horizon}</span></div>`

    document.getElementById('m-events').innerHTML = announcements.length
      ? [...announcements].reverse().map((event) => `<div class="m-event tone-${EVENT_TONE[event.kind] ?? 'info'}"><div class="m-event-head"><b>${esc(t(EVENT_LABEL[event.kind] ?? event.kind))}</b><span>${t('第 {tick} 步', { tick: event.tick })}</span></div>
          <div>${esc(eventText(event, t))}</div></div>`).join('')
      : empty(t('还没有公开事件。'))
    document.getElementById('m-reports').innerHTML = reports.length
      ? [...reports].reverse().map((report) => `<div class="m-event"><div class="m-event-head"><b>${esc(report.category ?? t('异常'))}</b><span>${t('第 {tick} 步', { tick: report.tick })}</span><span class="m-sub mono">${esc(String(report.actorId ?? '').slice(-10))}</span></div>
          <div>${t('对象')}：${esc((report.entities ?? []).join('、'))}</div>${report.suspectedCause ? `<div class="m-sub">${t('疑似原因')}：${esc(report.suspectedCause)}</div>` : ''}${report.actions ? `<div class="m-sub">${t('已采取')}：${esc(report.actions)}</div>` : ''}</div>`).join('')
      : empty(t('还没有异常报告。'))

    const incidents = evaluation?.score?.C?.incidents ?? []
    document.getElementById('m-truth').innerHTML = evaluation
      ? `<table class="m-table"><thead><tr><th>${t('事件')}</th><th>${t('开始步')}</th><th>${t('发现')}</th><th>${t('遏制')}</th><th>${t('恢复')}</th><th>${t('正确')}</th><th>${t('得分')}</th></tr></thead><tbody>
        ${incidents.map((incident) => `<tr><td>${esc(incident.id)}</td><td>${incident.onset}</td><td>${n(incident.detect, 2)}</td><td>${n(incident.contain, 2)}</td>
          <td>${incident.recover === null ? '—' : n(incident.recover, 2)}</td><td>${n(incident.correct, 2)}</td><td>${n(incident.score, 2)}</td></tr>`).join('')}</tbody></table>`
      : `<div class="m-note">${t('运行中不显示真实事件开始时间与分值。结算后在这里显示 E1–E13 的发现、遏制、恢复与正确性。')}</div>`
    document.querySelectorAll('.m-event .m-event-head').forEach((head) => head.onclick = () => head.parentElement.classList.toggle('open'))
  }

  return {
    section: '火星基地',
    title: '危机时间线',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('危机时间线')}</span><span class="spacer"></span><span class="m-sub">${t('公开事件与处置 · 结算后叠加真值')}</span></div>
        <section class="card"><div id="m-timeline" class="m-timeline"></div></section>
        <div class="m-two"><section class="card"><div class="card-head"><span class="card-title">${t('公开事件')}</span></div><div id="m-events" class="m-events"></div></section>
          <section class="card"><div class="card-head"><span class="card-title">${t('异常报告')}</span></div><div id="m-reports"></div></section></div>
        <section class="card"><div class="card-head"><span class="card-title">${t('结算后的真值事件与分项')}</span></div><div id="m-truth"></div></section>
      </div>`
      load(false).then(paint)
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-incidents') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
