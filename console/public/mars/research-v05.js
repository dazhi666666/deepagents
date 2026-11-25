/* Public research state, revisions and actual schedules. Hidden evaluator inputs never enter this view. */
export function renderV05Research(snapshot, evaluation, esc) {
  const research = snapshot.research ?? {}
  const table = (head, rows) => `<div class="m-table-wrap"><table class="m-table"><thead><tr>${head.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  const cell = x => `<td>${esc(String(x ?? '—'))}</td>`
  const json = value => `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`
  const projects = (research.projects ?? []).map(project => `<section class="card"><div class="card-head"><b>${esc(project.project)} 科研项目</b></div>
    <p>${project.records.length} 条当前研究状态，${project.open} 条待验证或复核。</p>
    ${table(['任务', '研究目标', '分值'], project.tasks.map(task => `<tr>${cell(task.id)}${cell(task.question)}${cell(task.weight)}</tr>`))}</section>`).join('')
  const records = (research.records ?? []).map(record => `<details class="card"><summary>${esc(record.id)} @${record.revision} · ${esc(record.project)} · ${esc(record.status)}</summary>
    <p>声明状态由 Agent 提供，不代表评测认证。</p>${json(record.content)}<p>依据：${esc(record.basedOn.map(ref => `${ref.id}@${ref.revision}`).join(', ') || '未声明')}</p>
    <p>证据用途：${esc(record.evidence.map(ref => `${ref.id} (${ref.purpose})`).join(', ') || '未声明')}</p>
    ${table(['版本', '时刻', '状态', '修改原因'], (research.revisions ?? []).filter(item => item.id === record.id).map(item => `<tr>${cell(item.revision)}${cell(item.updatedTick)}${cell(item.status)}${cell(item.reason)}</tr>`))}</details>`).join('')
  const models = table(['模型', '哈希', '依赖版本'], (research.models ?? []).map(model => `<tr>${cell(model.id)}${cell(model.hash.slice(0, 16))}${cell(model.basedOn.map(ref => `${ref.id}@${ref.revision}`).join(', '))}</tr>`))
  const predictions = table(['预测', '目标', '锁定时刻', '验证可见时刻'], (research.predictions ?? []).map(item => `<tr>${cell(item.id)}${cell(item.target)}${cell(item.lockedTick)}${cell(item.validationAvailableAt)}</tr>`))
  const plans = table(['计划', '执行者', '状态', '实际接纳操作'], (research.plans ?? []).map(plan => `<tr>${cell(plan.title)}${cell(plan.actorId)}${cell(plan.state)}${cell(Object.values(plan.operations).join(', '))}</tr>`))
  const reservations = table(['资源', '执行者', '区间', '状态'], (research.reservations ?? []).map(item => `<tr>${cell(item.resource)}${cell(item.actorId)}${cell(`[${item.start}, ${item.end})`)}${cell(item.state)}</tr>`))
  const submissions = table(['目标', '提交者', '时刻', '引用用途'], (research.observations ?? []).map(item => `<tr>${cell(item.objectiveId)}${cell(item.actorId)}${cell(item.submittedAt)}${cell(item.evidence.map(ref => `${ref.id}: ${ref.purpose}`).join(', '))}</tr>`))
  return `${projects}<section class="card"><h3>研究理解与修订</h3>${records || '<p>尚未发布研究状态。</p>'}</section>
    <section class="card"><h3>模型与前瞻预测</h3>${models}${predictions}</section>
    <section class="card"><h3>实验与资源排程</h3>${plans}${reservations}</section>
    <section class="card"><h3>科学提交与证据用途</h3>${submissions}</section>
    <section class="card"><h3>评测</h3>${snapshot.status === 'completed' && evaluation ? json(evaluation.score ?? evaluation) : '<p>运行中只展示公开事实与 Agent 声明，科学准确度在终局评价。</p>'}</section>`
}
