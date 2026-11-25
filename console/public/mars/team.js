/* 团队与模型：组织树、进行中的模型请求、消息流与任务看板摘要。 */
import { badge, empty, n, settle } from './common.js'

const AGENT_STATUS = { running: ['运行中', 'live'], idle: ['空闲', 'idle'], inactive: ['可续接', 'finished'] }
const TASK_STATE = { pending: '待执行', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' }

export function createTeam(ctx) {
  const { api, t, esc, state } = ctx
  const rootId = 'mars-team-root'
  let busy = false
  let data = { snapshot: null, activity: null }

  async function load(force) {
    if (busy) return
    busy = true
    try {
      const snapshot = await api.snapshot(force)
      const [activity] = await settle([api.modelActivity()])
      data = { snapshot, activity }
    } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  function tree(agents) {
    const children = new Map()
    for (const agent of agents) {
      const key = agent.parentId ?? 'root'
      if (!children.has(key)) children.set(key, [])
      children.get(key).push(agent)
    }
    const render = (parent, depth) => (children.get(parent) ?? []).map((agent) => {
      const status = AGENT_STATUS[agent.status] ?? [agent.status, 'idle']
      const usage = agent.usage ?? {}
      return `<div class="m-agent" style="--depth:${depth}"><div class="m-agent-main">
          <b>${esc(agent.role)}</b>${badge(t(status[0]), status[1])}<span class="m-sub mono">${esc(String(agent.id).slice(-12))}</span></div>
        <div class="m-agent-meta"><span>${esc(agent.task ?? '')}</span><span>${t('模型')} ${esc(agent.model ?? '')}</span>
          <span>${t('请求 {n}', { n: usage.requests ?? 0 })}</span><span>${t('输入 {i} / 输出 {o} token', { i: n(usage.inputTokens ?? 0, 0), o: n(usage.outputTokens ?? 0, 0) })}</span></div>
        ${render(agent.id, depth + 1)}</div>`
    }).join('')
    return render('root', 0) || empty(t('还没有成员。'))
  }

  function paint() {
    if (!data.snapshot || !document.getElementById('m-team-tree') || state.view !== 'mars-team') return
    const { snapshot, activity } = data
    const agents = snapshot.agents ?? [], messages = snapshot.messages ?? [], tasks = snapshot.tasks ?? []
    document.getElementById('m-team-tree').innerHTML = tree(agents)
    const active = activity?.active ?? [], recent = activity?.recent ?? []
    const slow = active.filter((request) => (request.waitedSeconds ?? 0) > 120), stalled = active.filter((request) => (request.waitedSeconds ?? 0) > 600)
    document.getElementById('m-team-waiting').innerHTML = active.length
      ? `${stalled.length ? `<div class="m-notice bad">${t('决策轮正在等待 {n} 个超过 10 分钟的模型请求。', { n: stalled.length })}</div>` : slow.length ? `<div class="m-notice warn">${t('{n} 个请求已等待超过 2 分钟。', { n: slow.length })}</div>` : ''}
        <table class="m-table"><thead><tr><th>${t('成员')}</th><th>${t('用途')}</th><th>${t('模型')}</th><th>${t('已等待')}</th></tr></thead><tbody>
        ${active.map((request) => `<tr><td>${esc(request.role ?? request.actorId ?? '—')}</td><td>${esc(request.purpose ?? '')}</td><td>${esc(request.model ?? '')}</td>
          <td class="${(request.waitedSeconds ?? 0) > 600 ? 'bad' : (request.waitedSeconds ?? 0) > 120 ? 'warn' : ''}">${request.waitedSeconds === null ? '—' : `${n(request.waitedSeconds, 1)} s`}</td></tr>`).join('')}</tbody></table>`
      : `<div class="m-note">${t('当前没有进行中的模型请求。')}</div>`
    document.getElementById('m-team-recent').innerHTML = recent.length
      ? `<table class="m-table"><thead><tr><th>${t('成员')}</th><th>${t('用途')}</th><th>${t('耗时')}</th><th>${t('结束状态')}</th></tr></thead><tbody>
        ${recent.slice(0, 12).map((request) => `<tr><td>${esc(request.role ?? request.actorId ?? '—')}</td><td>${esc(request.purpose ?? '')}</td>
          <td>${request.durationSeconds === null ? '—' : `${n(request.durationSeconds, 1)} s`}</td><td class="mono">${esc(typeof request.reason === 'string' ? request.reason : request.reason?.kind ?? '')}</td></tr>`).join('')}</tbody></table>`
      : `<div class="m-note">${t('还没有已完成的请求。')}</div>`

    const summary = new Map()
    for (const task of tasks) summary.set(task.state, (summary.get(task.state) ?? 0) + 1)
    document.getElementById('m-team-tasks').innerHTML = `<div class="m-kv">${[...summary].map(([key, value]) => `<span>${t(TASK_STATE[key] ?? key)}</span><b>${value}</b>`).join('')}</div>
      ${tasks.length ? `<table class="m-table"><thead><tr><th>${t('任务')}</th><th>${t('负责人')}</th><th>${t('状态')}</th><th>${t('修订')}</th></tr></thead><tbody>
        ${tasks.slice(-12).reverse().map((task) => `<tr><td>${esc(task.title)}</td><td>${esc(task.assignee ?? '—')}</td><td>${t(TASK_STATE[task.state] ?? task.state)}</td><td>${n(task.revision, 0)}</td></tr>`).join('')}</tbody></table>` : empty(t('任务板为空。'))}`

    document.getElementById('m-team-messages').innerHTML = messages.length
      ? messages.slice(-30).reverse().map((message) => `<div class="m-message"><div class="m-msg-head"><b>${esc(message.senderRole)}</b> → <b>${esc(message.targetRole)}</b>
          <span>${t('第 {tick} 步', { tick: message.tick })}</span>${badge(message.read ? t('已读') : t('未读'), message.read ? 'idle' : 'warn')}${message.taskId ? `<span class="m-sub">${esc(message.taskId)}</span>` : ''}</div>
        <div class="m-msg-body">${esc(message.content)}</div></div>`).join('')
      : empty(t('还没有项目消息。'))
  }

  return {
    section: '火星基地',
    title: '团队与模型',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('团队与模型')}</span><span class="spacer"></span><span class="m-sub">${t('组织树 · 等待中的请求 · 消息流')}</span></div>
        <div class="m-two"><section class="card"><div class="card-head"><span class="card-title">${t('组织树')}</span></div><div id="m-team-tree" class="m-tree"></div></section>
          <section class="card"><div class="card-head"><span class="card-title">${t('进行中的模型请求')}</span></div><div id="m-team-waiting"></div>
            <div class="card-head" style="margin-top:14px"><span class="card-title">${t('最近请求耗时')}</span></div><div id="m-team-recent"></div></section></div>
        <div class="m-two"><section class="card"><div class="card-head"><span class="card-title">${t('任务看板摘要')}</span></div><div id="m-team-tasks"></div></section>
          <section class="card"><div class="card-head"><span class="card-title">${t('消息流')}</span></div><div id="m-team-messages"></div></section></div>
      </div>`
      load(false).then(paint)
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-team') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
