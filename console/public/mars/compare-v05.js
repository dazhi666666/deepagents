export function renderV05Comparison(runs, esc) {
  const groups = new Map()
  const number = value => typeof value === 'number' ? value.toFixed(2) : '—'
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  for (const run of runs) {
    const key = `${run.scenarioId ?? run.directory}:${run.load ?? ''}`
    const group = groups.get(key) ?? { id: run.scenarioId ?? '未声明配对场景', single: [], multi: [] }
    if (run.mode === 'single-agent') group.single.push(run)
    if (run.mode === 'multi-agent') group.multi.push(run)
    groups.set(key, group)
  }
  const score = rows => mean(rows.map(run => run.score).filter(value => typeof value === 'number'))
  const table = `<table class="m-table"><thead><tr><th>配对场景</th><th>Single 数量</th><th>Multi 数量</th><th>Single 原始分</th><th>Multi 原始分</th><th>差值</th></tr></thead><tbody>${[...groups.values()].map(group => {
    const single = score(group.single), multi = score(group.multi)
    return `<tr><td>${esc(group.id.slice(0, 16))}</td><td>${group.single.length}</td><td>${group.multi.length}</td><td>${number(single)}</td><td>${number(multi)}</td><td>${single !== null && multi !== null ? number(multi - single) : '—'}</td></tr>`
  }).join('')}</tbody></table>`
  const parts = `<table class="m-table"><thead><tr><th>运行</th><th>R</th><th>K</th><th>J</th><th>O</th><th>Q</th><th>输入 token</th><th>输出 token</th><th>配置状态</th></tr></thead><tbody>${runs.map(run => `<tr><td>${esc(run.mode)} ${esc(String(run.scenarioId ?? '').slice(0, 8))}</td>${['R', 'K', 'J', 'O', 'Q'].map(key => `<td>${number(run.components?.[key])}</td>`).join('')}<td>${number(run.usage?.inputTokens)}</td><td>${number(run.usage?.outputTokens)}</td><td>${esc(run.calibrationStatus ?? '')}</td></tr>`).join('')}</tbody></table>`
  const projects = `<table class="m-table"><thead><tr><th>运行</th><th>PW /18</th><th>PG /20</th><th>PF /12</th><th>最低项目比例</th></tr></thead><tbody>${runs.map(run => {
    const sums = ['PW', 'PG', 'PF'].map(prefix => Object.entries(run.tasks ?? {}).filter(([key]) => key.startsWith(prefix)).reduce((sum, [, task]) => sum + task.score, 0))
    return `<tr><td>${esc(run.mode)} ${esc(String(run.scenarioId ?? '').slice(0, 8))}</td>${sums.map(value => `<td>${number(value)}</td>`).join('')}<td>${number(Math.min(...sums.map((value, index) => value / [18, 20, 12][index])))}</td></tr>`
  }).join('')}</tbody></table>`
  return { table, parts, projects }
}
