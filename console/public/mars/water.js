/* 水：三个在线 DOC 读数、报警阈值、水箱与备用罐、结算后污染与诱饵时段。 */
import { SOL_TICKS, badge, empty, n } from './common.js'
import { legend, lineChart, sparkline } from './charts.js'

const MODULES = [
  { id: 'reservoir', label: '原水罐', threshold: 7 },
  { id: 'filter', label: '过滤出口', threshold: 2.5 },
  { id: 'pump', label: '泵出口', threshold: 2.5 },
]

export function createWater(ctx) {
  const { api, t, esc, state } = ctx
  const rootId = 'mars-water-root'
  let busy = false
  let data = { snapshot: null, telemetry: null, evaluation: null }

  async function load(force) {
    if (busy) return
    busy = true
    try {
      const snapshot = await api.snapshot(force), now = snapshot.tick ?? 0
      const [telemetry, evaluation] = await Promise.all([
        api.telemetry(['reservoir.doc_inline', 'filter.doc_inline', 'pump.doc_inline'], Math.max(0, now - 4 * SOL_TICKS), now, 600),
        snapshot.status === 'completed' ? api.evaluation() : Promise.resolve(null),
      ])
      data = { snapshot, telemetry, evaluation }
    } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  function paint() {
    if (!data.snapshot || !document.getElementById('m-water-main') || state.view !== 'mars-water') return
    const { snapshot, telemetry, evaluation } = data
    const sensors = snapshot.sensors ?? {}, water = sensors.water ?? {}, now = snapshot.tick ?? 0
    const series = MODULES.map((module, index) => ({ name: t(module.label), color: ['#38e1ff', '#3ecf8e', '#f3b64c'][index],
      points: (telemetry?.[`${module.id}.doc_inline`] ?? []).map(([tick, value]) => [tick, value]) }))
    const bands = []
    if (evaluation?.truth?.contamination) for (const event of evaluation.truth.contamination) {
      bands.push({ from: Math.max(0, event.onset - 30), to: event.onset + 30, color: 'rgba(239,107,107,.12)', label: `${event.event} ${t('污染开始')}` })
      bands.push({ from: Math.max(0, event.decoyOnset - 30), to: event.decoyOnset + 30, color: 'rgba(192,132,252,.10)', label: `${event.event} ${t('诱饵传感器')}` })
    }
    document.getElementById('m-water-main').innerHTML = lineChart({
      series, bands, xMin: Math.max(0, now - 4 * SOL_TICKS), xMax: now, yMin: 0,
      refs: MODULES.map((module) => ({ y: module.threshold, color: module.id === 'reservoir' ? '#ef6b6b' : '#f3b64c', label: `${module.label} ${module.threshold}` })),
    }) + legend(series)

    const readings = MODULES.map((module) => {
      const value = water.inlineDoc?.[module.id]
      const alarm = typeof value === 'number' && value > module.threshold
      const history = (telemetry?.[`${module.id}.doc_inline`] ?? []).map(([, item]) => item)
      return `<div class="m-water-card ${alarm ? 'alarm' : ''}"><div class="m-kpi-head"><span>${t(module.label)}</span><b>${n(value, 2)} <small>mg/L</small></b></div>
        <div class="m-kpi-row"><span>${t('阈值')}</span><span>${module.threshold}</span></div>${sparkline(history, alarm ? '#ef6b6b' : '#38e1ff')}
        ${alarm ? badge(t('超过报警阈值'), 'bad') : badge(t('正常'), 'idle')}</div>`
    }).join('')
    const tank = water.tankUl ?? 0, capacity = water.capacityUl || 5000, reserve = water.reserveUl ?? 0
    document.getElementById('m-water-side').innerHTML = `<div class="m-water-grid">${readings}</div>
      <div class="m-kv"><span>${t('共享水箱')}</span><b>${n(tank, 0)} / ${n(capacity, 0)} µL</b><span>${t('备用净水罐')}</span><b>${n(reserve, 0)} µL</b>
        <span>${t('灌溉水源')}</span><b>${water.irrigationSource === 'reserve' ? t('备用罐') : t('主回路')}</b></div>
      ${evaluation ? `<div class="m-note">${t('结算后叠加显示真实污染开始与诱饵传感器时段，用背景色带标出。')}</div>` : `<div class="m-note">${t('运行中只显示可观测的在线读数与报警，不显示真实污染时段。')}</div>`}`
  }

  return {
    section: '火星基地',
    title: '水',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('水循环')}</span><span class="spacer"></span><span class="m-sub">${t('在线 DOC · 最近 4 个 sol')}</span></div>
        <section class="card"><div class="card-head"><span class="card-title">${t('三个在线 DOC 读数')}</span><span class="spacer"></span><span class="m-sub">${t('报警阈值：原水 7 · 过滤 2.5 · 泵 2.5 mg/L')}</span></div><div id="m-water-main"></div></section>
        <section class="card" id="m-water-side"></section>
      </div>`
      load(false).then(paint)
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-water') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
