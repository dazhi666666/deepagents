/* 科研交付：13 项任务表、提交历史、证据跳转与结算后的答案/真值对照。 */
import { badge, empty, n, pct } from './common.js'
import { renderV05Research } from './research-v05.js'

const TONE = { accepted: ['已接受', 'succeeded'], rejected: ['被拒', 'failed'] }

export function createResearch(ctx) {
  const { api, t, esc, state, go, mars } = ctx
  const rootId = 'mars-research-root'
  let busy = false
  let data = { snapshot: null, score: null, deliverables: [], evaluation: null }
  let selected = null

  async function load(force) {
    if (busy) return
    busy = true
    try {
      const snapshot = await api.snapshot(force)
      const [score, deliverables, evaluation, runs] = await Promise.all([
        api.score(), api.deliverables(),
        snapshot.status === 'completed' ? api.evaluation() : Promise.resolve(null),
        api.analysisRuns().catch(() => []),
      ])
      data = { snapshot, score: score ?? snapshot.score, deliverables: deliverables ?? [], evaluation, runs: runs ?? [] }
    } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  const byTask = (submissions) => {
    const map = new Map()
    for (const entry of submissions) {
      const list = map.get(entry.taskId) ?? []
      list.push(entry)
      map.set(entry.taskId, list)
    }
    return map
  }

  function evidenceChips(evidence) {
    const chips = []
    for (const id of evidence?.resultIds ?? []) chips.push(`<button class="chip-btn" data-raw="${esc(id)}">${t('结果')} <span class="mono">${esc(id.slice(-8))}</span></button>`)
    for (const id of evidence?.analysisRunIds ?? []) chips.push(`<button class="chip-btn" data-analysis="${esc(id)}">${t('分析运行')} <span class="mono">${esc(id.slice(-8))}</span></button>`)
    for (const id of evidence?.operationIds ?? []) chips.push(`<span class="chip">${t('操作')} <span class="mono">${esc(id.slice(-8))}</span></span>`)
    for (const id of evidence?.archiveQueryIds ?? []) chips.push(`<span class="chip">${t('档案查询')} <span class="mono">${esc(id.slice(-8))}</span></span>`)
    for (const id of evidence?.artifactIds ?? []) chips.push(`<span class="chip">${t('产物')} <span class="mono">${esc(id.slice(-8))}</span></span>`)
    return chips.length ? `<div class="m-chip-row">${chips.join('')}</div>` : `<span class="muted">${t('没有证据引用')}</span>`
  }

  function interval(answer, truthValue) {
    if (!answer || typeof answer !== 'object' || typeof answer.lo !== 'number' || typeof answer.hi !== 'number') return ''
    const low = Math.min(answer.lo, answer.hi, typeof truthValue === 'number' ? truthValue : answer.lo)
    const high = Math.max(answer.lo, answer.hi, typeof truthValue === 'number' ? truthValue : answer.hi)
    const at = (value) => 2 + (value - low) / (high - low || 1) * 96
    return `<div class="m-interval"><div class="m-interval-track"></div>
      <span class="m-interval-range" style="left:${at(answer.lo)}%;width:${Math.max(0, at(answer.hi) - at(answer.lo))}%"></span>
      <span class="m-interval-est" style="left:${at(answer.est)}%" title="${t('估计')} ${n(answer.est, 3)}"></span>
      ${typeof truthValue === 'number' ? `<span class="m-interval-truth" style="left:${at(truthValue)}%" title="${t('真值')} ${n(truthValue, 3)}"></span>` : ''}</div>
      <div class="m-sub">${t('估计 {est} · 区间 [{lo}, {hi}]', { est: n(answer.est, 3), lo: n(answer.lo, 3), hi: n(answer.hi, 3) })}${typeof truthValue === 'number' ? ` · ${t('真值 {v}', { v: n(truthValue, 3) })}` : ''}</div>`
  }

  function answerView(answer, truth, path = '') {
    if (!answer || typeof answer !== 'object') return `<span class="mono">${esc(String(answer))}</span>`
    if (typeof answer.est === 'number' && typeof answer.lo === 'number' && typeof answer.hi === 'number')
      return interval(answer, typeof truth === 'number' ? truth : truth?.value ?? truth?.est)
    const entries = Object.entries(answer)
    return `<div class="m-answer-tree">${entries.map(([key, value]) => {
      const childPath = path ? `${path}.${key}` : key
      const childTruth = truth && typeof truth === 'object' && key in truth ? truth[key] : undefined
      return `<div class="m-answer-row"><span class="m-answer-key">${esc(key)}</span><div>${answerView(value, childTruth, childPath)}</div></div>`
    }).join('')}</div>`
  }

  function detail(task, submissions, scoreTask, evaluation) {
    const accepted = submissions.filter((entry) => entry.kind === 'mars-deliverable-accepted')
    const rejected = submissions.filter((entry) => entry.kind === 'mars-deliverable-rejected')
    const latest = accepted.at(-1)
    const truth = evaluation?.taskTruths?.[task.id]
    const evaluationTask = evaluation?.tasks?.[task.id]
    return `<section class="card m-research-detail" id="m-research-detail">
      <div class="card-head"><span class="card-title">${esc(task.id)} · ${esc(task.title)}</span><span class="spacer"></span>
        ${evaluationTask ? badge(t('准确度 A {a}', { a: n(evaluationTask.A, 3) }), evaluationTask.A >= 0.6 ? 'succeeded' : evaluationTask.A > 0 ? 'warn' : 'failed') : badge(t('运行中不显示准确度'), 'idle')}</div>
      <p>${esc(task.question)}</p><p class="m-note">${t('最低证据')}：${esc(task.minimumEvidence)}</p>
      <div class="m-kv"><span>${t('权重')}</span><b>${n(task.weight)}</b><span>${t('截止')}</span><b>${esc(task.deadline)}</b>
        <span>${t('已接受提交')}</span><b>${accepted.length}</b><span>${t('被拒提交')}</span><b>${rejected.length}</b>
        ${scoreTask ? `<span>${t('进度 P')}</span><b>${pct(scoreTask.P) ?? 0}%</b><span>${t('证据有效率 V')}</span><b>${pct(scoreTask.V) ?? 0}%</b>
          <span>${t('截止因子 d')}</span><b>${n(scoreTask.d, 2)}</b>${evaluationTask ? `<span>${t('得分')}</span><b>${n(evaluationTask.points, 2)}</b>` : ''}` : ''}</div>
      <div class="block-title">${t('答案与真值')}</div>
      ${latest ? answerView(latest.answer, truth, '') : `<div class="m-note">${t('还没有被接受的答案。')}</div>`}
      ${latest?.answer ? `<details><summary>${t('原始答案 JSON')}</summary><pre>${esc(JSON.stringify(latest.answer, null, 2))}</pre></details>` : ''}
      <div class="block-title">${t('提交历史')}</div>
      ${submissions.length ? `<table class="m-table"><thead><tr><th>${t('步')}</th><th>${t('结果')}</th><th>${t('执行者')}</th><th>${t('公开检查')}</th><th>${t('证据')}</th></tr></thead><tbody>
        ${submissions.map((entry) => `<tr><td>${entry.tick}</td><td>${badge(t(TONE[entry.kind === 'mars-deliverable-accepted' ? 'accepted' : 'rejected'][0]), TONE[entry.kind === 'mars-deliverable-accepted' ? 'accepted' : 'rejected'][1])}</td>
          <td class="mono">${esc(String(entry.actorId ?? '').slice(-10))}</td><td>${(entry.problems ?? []).map((problem) => `<div class="m-problem">${esc(problem)}</div>`).join('') || '—'}</td>
          <td>${evidenceChips(entry.evidence)}</td></tr>`).join('')}</tbody></table>` : empty(t('还没有提交。'))}
    </section>`
  }

  function paint() {
    if (!data.snapshot || !document.getElementById('m-research-table') || state.view !== 'mars-research') return
    const { snapshot, score, deliverables, evaluation } = data
    if (snapshot.research?.version === 'v0.5') {
      document.getElementById('m-research-table').innerHTML = renderV05Research(snapshot, evaluation, esc)
      document.getElementById('m-research-detail').innerHTML = ''
      return
    }
    const tasks = snapshot.mission?.tasks ?? [], scoreTasks = new Map((score?.R?.tasks ?? []).map((task) => [task.id, task]))
    const submissions = byTask(deliverables)
    document.getElementById('m-research-table').innerHTML = `<table class="m-table m-research-table"><thead><tr>
      <th>${t('任务')}</th><th>${t('权重')}</th><th>${t('截止')}</th><th>${t('提交')}</th><th>${t('首次合格')}</th><th>P</th><th>V</th>${evaluation ? '<th>A</th><th>d</th><th>' + t('得分') + '</th>' : ''}</tr></thead><tbody>
      ${tasks.map((task) => {
        const list = submissions.get(task.id) ?? []
        const accepted = list.filter((entry) => entry.kind === 'mars-deliverable-accepted')
        const scoreTask = scoreTasks.get(task.id)
        const evaluationTask = evaluation?.tasks?.[task.id]
        const latestRejected = list.filter((entry) => entry.kind === 'mars-deliverable-rejected').at(-1)
        return `<tr data-task="${esc(task.id)}" class="${selected === task.id ? 'active' : ''} ${accepted.length ? 'has-answer' : ''}">
          <td><div class="m-task-name"><b>${esc(task.id)}</b> ${esc(task.title)}</div>${latestRejected ? `<div class="m-problem">${esc(latestRejected.problems?.[0] ?? '')}</div>` : ''}</td>
          <td>${n(task.weight)}</td><td class="m-sub">${esc(task.deadline)}</td><td>${accepted.length} / ${list.length}</td>
          <td>${accepted[0]?.tick ?? '—'}</td><td>${pct(scoreTask?.P) ?? 0}%</td><td>${pct(scoreTask?.V) ?? 0}%</td>
          ${evaluation ? `<td>${n(evaluationTask?.A, 3)}</td><td>${n(evaluationTask?.d, 2)}</td><td>${n(evaluationTask?.points, 2)}</td>` : ''}</tr>`
      }).join('')}</tbody></table>`
    document.querySelectorAll('[data-task]').forEach((row) => (row.onclick = () => {
      selected = row.dataset.task
      const task = tasks.find((item) => item.id === selected)
      document.getElementById('m-research-detail').innerHTML = detail(task, submissions.get(selected) ?? [], scoreTasks.get(selected), evaluation)
      bindDetailActions()
      paint()
    }))
    if (selected) {
      const task = tasks.find((item) => item.id === selected)
      if (task) {
        const box = document.getElementById('m-research-detail')
        if (!box.innerHTML.trim()) { box.innerHTML = detail(task, submissions.get(selected) ?? [], scoreTasks.get(selected), evaluation); bindDetailActions() }
      }
    }
  }

  function bindDetailActions() {
    document.querySelectorAll('[data-raw]').forEach((button) => (button.onclick = (event) => {
      event.stopPropagation()
      mars.rawKey = button.dataset.raw
      go('mars-raw')
    }))
    document.querySelectorAll('[data-analysis]').forEach((button) => (button.onclick = (event) => {
      event.stopPropagation()
      mars.analysisId = button.dataset.analysis
      go('mars-analysis')
    }))
  }

  return {
    section: '火星基地',
    title: '科研交付',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('科研交付')}</span><span class="spacer"></span><span class="m-sub">${t('点击任务查看提交与证据')}</span></div>
        <section class="card"><div id="m-research-table"></div></section>
        <div id="m-research-detail"></div>
      </div>`
      load(false).then(paint)
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-research') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
