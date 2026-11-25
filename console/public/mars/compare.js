/* 对照页：负载档上的单/多 Agent S*、四项分解与同种子配对表。数据来自静态 runs 索引。 */
import { empty, n } from './common.js'
import { lineChart } from './charts.js'
import { renderV05Comparison } from './compare-v05.js'

const LOADS = ['L1', 'L2', 'L3', 'L4']
const SERIES = [
  { key: 'single-agent', label: 'Single', color: '#38e1ff' },
  { key: 'multi-agent', label: 'Multi', color: '#f3b64c' },
]

export function createCompare(ctx) {
  const { api, t, esc, state } = ctx
  const rootId = 'mars-compare-root'
  let busy = false
  let data = { runs: [], error: null }

  async function load() {
    if (busy) return
    busy = true
    try { data = { runs: (await api.comparison()).runs ?? [], error: null } }
    catch (error) { data = { runs: [], error: error.message } }
    finally { busy = false }
  }

  function grouped(runs, mode) {
    return LOADS.map((load) => {
      const selected = runs.filter((run) => run.mode === mode && run.load === load)
      return [LOADS.indexOf(load) + 1, selected.length ? selected.reduce((total, run) => total + (run.normalized ?? 0), 0) / selected.length : null]
    }).filter(([, value]) => value !== null)
  }

  function paint() {
    if (!document.getElementById('m-compare-main') || state.view !== 'mars-compare') return
    if (data.error) { document.getElementById('m-compare-main').innerHTML = empty(esc(data.error)); return }
    const runs = data.runs
    const modern = runs.filter(run => run.benchmarkVersion === 'v0.5')
    if (modern.length) {
      const rendered = renderV05Comparison(modern, esc)
      document.getElementById('m-compare-main').innerHTML = '<p>v0.5 原始得分。同一场景重复运行展示组内均值；不与旧版 S* 混合。</p>' + rendered.table
      document.getElementById('m-compare-parts').innerHTML = rendered.parts
      document.getElementById('m-compare-pairs').innerHTML = rendered.projects
      return
    }
    if (!runs.length) {
      document.getElementById('m-compare-main').innerHTML = empty(t('还没有已结算的运行。collect-runs.py 只收录带 final-score.json 的运行。'))
      return
    }
    const series = SERIES.map((item) => ({ name: t(item.label), color: item.color, points: grouped(runs, item.key) }))
    document.getElementById('m-compare-main').innerHTML = runs.length
      ? `${lineChart({ series, xMin: 1, xMax: 4, xTicks: [1, 2, 3, 4], xFormat: (value) => `L${value}`, yMin: 0, yMax: 100, yFormat: (value) => n(value, 0) })}
        <div class="m-legend">${SERIES.map((item) => `<span><i style="background:${item.color}"></i>${esc(t(item.label))}</span>`).join('')}</div>`
      : empty(t('还没有已结算的运行。'))
    const parts = [['O', 22], ['C', 20], ['R', 48], ['Q', 10]]
    document.getElementById('m-compare-parts').innerHTML = parts.map(([key, max]) => `<div class="m-mini"><div class="m-mini-head"><b>${key}</b><span>${t('满分 {n}', { n: max })}</span></div>
      ${lineChart({ width: 300, height: 110, series: SERIES.map((item) => ({ name: t(item.label), color: item.color,
        points: LOADS.map((load, index) => {
          const selected = runs.filter((run) => run.mode === item.key && run.load === load)
          return [index + 1, selected.length ? selected.reduce((total, run) => total + (run[key] ?? 0), 0) / selected.length : null]
        }).filter(([, value]) => value !== null) })), xMin: 1, xMax: 4, xTicks: [1, 2, 3, 4], xFormat: (value) => `L${value}`, yMin: 0, yMax: max })}</div>`).join('')

    const pairs = []
    for (const single of runs.filter((run) => run.mode === 'single-agent')) {
      const multi = runs.find((run) => run.mode === 'multi-agent' && run.load === single.load && run.seed === single.seed)
      if (multi) pairs.push({ load: single.load, seed: single.seed, single, multi })
    }
    document.getElementById('m-compare-pairs').innerHTML = pairs.length
      ? `<table class="m-table"><thead><tr><th>${t('负载')}</th><th>${t('种子')}</th><th>S* Single</th><th>S* Multi</th><th>ΔS*</th><th>O</th><th>C</th><th>R</th><th>Q</th><th>token 成本</th><th>S* / 百万 token</th></tr></thead><tbody>
        ${pairs.map((pair) => {
          const delta = (pair.multi.normalized ?? 0) - (pair.single.normalized ?? 0)
          const part = (key) => `${n((pair.multi[key] ?? 0) - (pair.single[key] ?? 0), 2)}`
          const tokens = pair.multi.tokens || 0
          return `<tr><td>${pair.load}</td><td>${pair.seed}</td><td>${n(pair.single.normalized)}</td><td>${n(pair.multi.normalized)}</td>
            <td class="${delta >= 0 ? 'good' : 'bad'}">${delta >= 0 ? '+' : ''}${n(delta)}</td><td>${part('O')}</td><td>${part('C')}</td><td>${part('R')}</td><td>${part('Q')}</td>
            <td>${n(tokens, 0)}</td><td>${tokens ? n((pair.multi.normalized ?? 0) / (tokens / 1e6), 2) : '—'}</td></tr>`
        }).join('')}</tbody></table>`
      : `<div class="m-note">${t('还没有同负载、同种子的单/多配对。')}</div>`
  }

  return {
    section: '火星基地',
    title: '对照',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('单 / 多 Agent 对照')}</span><span class="spacer"></span><span class="m-sub">${t('已结算运行 · 静态索引')}</span></div>
        <section class="card"><div class="card-head"><span class="card-title">${t('按版本与场景对照')}</span><span class="spacer"></span><span class="m-sub">${t('评分口径随版本显示')}</span></div><div id="m-compare-main"></div></section>
        <section class="card"><div class="card-head"><span class="card-title">${t('分项得分')}</span></div><div class="m-grid2" id="m-compare-parts"></div></section>
        <section class="card"><div class="card-head"><span class="card-title">${t('配对与项目结果')}</span></div><div id="m-compare-pairs"></div></section>
      </div>`
      load().then(paint)
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-compare') return
      load().then(paint)
    },
  }
}
