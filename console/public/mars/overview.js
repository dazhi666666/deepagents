/* 战报：时钟、四项评分、结算后基线位置、实时告警流与成本。 */
import { EVENT_LABEL, EVENT_TONE, STATUS_LABEL, STATUS_TONE, badge, bar, empty, eventText, mean, n, pct, settle } from './common.js'

export function createOverview(ctx) {
  const { api, t, esc, state, go } = ctx
  const rootId = 'mars-overview-root'
  let busy = false
  let data = { snapshot: null, score: null, announcements: [], activity: null, evaluation: null }

  async function load(force) {
    if (busy) return
    busy = true
    try {
      const snapshot = await api.snapshot(force)
      const [score, announcements, activity, evaluation] = await settle([
        api.score(), api.announcements(), api.modelActivity(),
        snapshot.status === 'completed' ? api.evaluation() : Promise.resolve(null),
      ])
      data = { snapshot, score: score ?? snapshot.score, announcements: announcements?.events ?? [], activity, evaluation }
    } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  function paint() {
    if (!document.getElementById(rootId) || state.view !== 'mars-overview' || !data.snapshot) return
    const { snapshot, score, announcements, activity, evaluation } = data
    const sensors = snapshot.sensors ?? {}, O = score?.O ?? {}, C = score?.C ?? {}, R = score?.R ?? {}, Q = score?.Q ?? {}
    const running = snapshot.status !== 'completed'
    const tasks = R.tasks ?? []
    const progress = mean(tasks.map((task) => task.P))
    const validity = mean(tasks.map((task) => task.V))

    document.getElementById('m-clock').innerHTML = `
      <div class="m-clock-main">
        <span class="m-sol">${t('Sol {n}', { n: sensors.sol ?? Math.floor((snapshot.tick ?? 0) / 96) })}</span>
        <span class="m-phase">${(sensors.solPhase ?? 0) < 0.5 ? '☀' : '☾'}</span>
        <div><div class="m-tick">${t('TICK {tick} / {horizon}', { tick: snapshot.tick ?? 0, horizon: sensors.horizon ?? 2400 })}</div>
          <div class="m-sub">${t('负载 {load} · 种子 {seed} · {mode}', { load: snapshot.mission?.load ?? '—', seed: snapshot.seed ?? '—', mode: snapshot.mode ?? '' })}</div></div>
      </div>
      <div class="m-clock-side">
        ${badge(t(STATUS_LABEL[snapshot.status] ?? snapshot.status), STATUS_TONE[snapshot.status] ?? 'idle')}
        <span class="m-sub">${esc(snapshot.model?.provider ?? '')} · ${esc(snapshot.model?.model ?? '')}</span>
        <button class="btn small ghost" id="m-refresh">${t('刷新')}</button>
      </div>`
    document.getElementById('m-refresh').onclick = () => load(true).then(paint)

    const oParts = [['crops', t('作物'), 12], ['energy', t('能源'), 3], ['water', t('水'), 3], ['atmosphere', t('大气'), 2], ['samples', t('样品'), 2]]
    document.getElementById('m-scorecards').innerHTML = `
      <section class="card m-kpi"><div class="m-kpi-head"><span>${t('运营 O')}</span><b>${n(O.total)} <small>/ 22</small></b></div>
        ${oParts.map(([key, label, max]) => `<div class="m-kpi-row"><span>${label}</span><span>${n(O[key])} / ${max}</span></div>${bar((O[key] ?? 0) / max)}`).join('')}</section>
      <section class="card m-kpi"><div class="m-kpi-head"><span>${t('危机 C')}</span><b>${running ? t('{n} 起', { n: C.observable ?? 0 }) : `${n(C.total)} <small>/ 27</small>`}</b></div>
        <div class="m-kpi-row"><span>${running ? t('可观测事件') : t('事件数')}</span><span>${running ? n(C.observable ?? 0) : n((C.incidents ?? []).length, 0)}</span></div>
        <div class="m-kpi-row"><span>${running ? t('已提交报告') : t('分项')}</span><span>${running ? n(C.reported ?? 0) : t('已结算')}</span></div>
        <p class="m-note">${running ? t('运行中只显示已经产生公告或报警的事件，不给分值。') : t('结算后显示完整危机分项。')}</p>
        <button class="btn small ghost" data-mars-go="mars-incidents">${t('危机时间线')}</button></section>
      <section class="card m-kpi"><div class="m-kpi-head"><span>${t('科研 R')}</span><b>${running ? `${pct(progress) ?? 0}% <small>P</small>` : `${n(R.total)} <small>/ 100</small>`}</b></div>
        <div class="m-kpi-row"><span>${t('证据有效率 V')}</span><span>${pct(validity) ?? 0}%</span></div>
        <div class="m-task-strip">${tasks.map((task) => `<i title="${esc(task.id)} · P ${pct(task.P) ?? 0}% · V ${pct(task.V) ?? 0}%" style="--p:${Math.round((task.P ?? 0) * 100)}"></i>`).join('')}</div>
        <p class="m-note">${t('{n} 项任务；运行中不显示准确度 A。', { n: tasks.length })}</p>
        <button class="btn small ghost" data-mars-go="mars-research">${t('科研交付')}</button></section>
      <section class="card m-kpi"><div class="m-kpi-head"><span>${t('过程 Q')}</span><b>${running ? n(Q.submissions) : `${n(Q.total)} <small>/ 25</small>`}</b></div>
        <div class="m-kpi-row"><span>${t('被拒提交')}</span><span>${n((snapshot.deliverables ?? []).filter((entry) => entry.kind === 'mars-deliverable-rejected').length, 0)}</span></div>
        ${running ? '' : `<div class="m-kpi-row"><span>${t('资源效率')}</span><span>${n(Q.efficiency)}</span></div><div class="m-kpi-row"><span>${t('证据稳健')}</span><span>${n(Q.robustness)}</span></div><div class="m-kpi-row"><span>${t('可复现')}</span><span>${n(Q.reproducibility)}</span></div>`}
        <p class="m-note">${running ? t('提交质量分 {s}，满分 2。', { s: n(Q.submissions) }) : t('Q 分项在结算后完整显示。')}</p></section>`

    const finalBlock = running ? '' : finalCard(score, evaluation)
    document.getElementById('m-final').innerHTML = finalBlock

    const TIER_ONE = ['incubator-1', 'incubator-2', 'incubator-3', 'incubator-4', 'cold-1', 'cold-2', 'freezer', 'robot-2']
    const events = [...announcements].filter((event) => event.kind !== 'power-shed' ||
      (event.payload?.shed ?? []).some((id) => TIER_ONE.includes(id)) || (event.payload?.shed ?? []).length === 0).slice(-20).reverse()
    document.getElementById('m-alerts').innerHTML = events.length
      ? events.map((event) => `<div class="m-alert tone-${EVENT_TONE[event.kind] ?? 'info'}" data-tick="${event.tick}">
          <div class="m-alert-head"><b>${esc(t(EVENT_LABEL[event.kind] ?? event.kind))}</b><span>${t('第 {tick} 步', { tick: event.tick })}</span></div>
          <div class="m-alert-body">${esc(eventText(event, t))}</div></div>`).join('')
      : empty(t('还没有公开告警。'))

    const usage = snapshot.usage ?? {}, active = activity?.active ?? []
    const waited = active.map((request) => request.waitedSeconds ?? 0)
    document.getElementById('m-cost').innerHTML = `
      <div class="m-cost-item"><span>${t('模型请求')}</span><b>${n(usage.requests ?? 0, 0)}</b></div>
      <div class="m-cost-item"><span>${t('输入 token')}</span><b>${n(usage.inputTokens ?? 0, 0)}</b></div>
      <div class="m-cost-item"><span>${t('输出 token')}</span><b>${n(usage.outputTokens ?? 0, 0)}</b></div>
      <div class="m-cost-item"><span>${t('进行中的请求')}</span><b class="${waited.some((value) => value > 600) ? 'bad' : waited.some((value) => value > 120) ? 'warn' : ''}">${active.length}</b></div>
      <div class="m-cost-wait">${active.length ? t('最长等待 {s} 秒；决策轮会等待全部请求完成。', { s: Math.max(...waited) }) : t('当前没有等待中的模型请求。')}</div>`

    document.querySelectorAll('[data-mars-go]').forEach((button) => (button.onclick = () => go(button.dataset.marsGo)))
  }

  function finalCard(score, evaluation) {
    if (!score || score.S === undefined) return ''
    const baselines = evaluation?.baselines
    let axis = ''
    if (baselines && Number.isFinite(baselines.null) && Number.isFinite(baselines.ref)) {
      const low = Math.min(baselines.null, baselines.ref, score.S), high = Math.max(baselines.null, baselines.ref, score.S)
      const at = (value) => 4 + (value - low) / (high - low || 1) * 92
      axis = `<div class="m-baseline"><div class="m-baseline-track"></div>
        <span class="m-baseline-point null" style="left:${at(baselines.null)}%"><i></i>${t('零动作')} ${n(baselines.null)}</span>
        <span class="m-baseline-point ref" style="left:${at(baselines.ref)}%"><i></i>${t('参考策略')} ${n(baselines.ref)}</span>
        <span class="m-baseline-point run" style="left:${at(score.S)}%"><i></i>${t('本运行')} ${n(score.S)}</span></div>`
    }
    return `<section class="card m-final"><div class="m-kpi-head"><span>${t('最终得分')}</span><b class="m-final-score">${n(score.S)} <small>/ 100</small></b></div>
      <div class="m-final-sub">${t('归一化 S* {s}', { s: score.normalized === null || score.normalized === undefined ? '—' : n(score.normalized) })} · ${t('结算步 {tick}', { tick: score.tick ?? '—' })}</div>${axis}</section>`
  }

  return {
    section: '火星基地',
    title: '战报',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="m-clockbar" id="m-clock"></div>
        <div class="m-kpis" id="m-scorecards"></div>
        <div id="m-final"></div>
        <div class="m-two"><section class="card"><div class="card-head"><span class="card-title">${t('实时告警流')}</span><span class="spacer"></span><span class="m-sub">${t('公开公告与报警')}</span></div><div class="m-alerts" id="m-alerts"></div></section>
          <section class="card"><div class="card-head"><span class="card-title">${t('成本与等待')}</span><span class="spacer"></span><span class="m-sub">${t('audit.jsonl')}</span></div><div class="m-cost" id="m-cost"></div></section></div>
      </div>`
      load(false).then(paint)
    },
    update(kind) {
      if (document.hidden) return
      if (kind === 'poll' && state.view !== 'mars-overview') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
