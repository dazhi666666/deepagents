/* 作物：4 × 4 网格、水分曲线、受压进度、灌溉量；结算后叠加真实感染信息。 */
import { badge, empty, n, pct } from './common.js'
import { sparkline } from './charts.js'

const STATUS = { healthy: ['健康', 'idle'], stressed: ['受压', 'warn'], lost: ['损失', 'bad'] }
const CHAMBERS = ['incubator-1', 'incubator-2', 'incubator-3', 'incubator-4']

export function createCrops(ctx) {
  const { api, t, esc, state } = ctx
  const rootId = 'mars-crops-root'
  let busy = false, filter = 'all'
  let data = { snapshot: null, telemetry: null, evaluation: null }

  async function load(force) {
    if (busy) return
    busy = true
    try {
      const snapshot = await api.snapshot(force), now = snapshot.tick ?? 0
      const crops = snapshot.sensors?.crops ?? []
      const [telemetry, evaluation] = await Promise.all([
        api.telemetry(crops.map((crop) => `${crop.id}.moisture`), Math.max(0, now - 200), now, 300),
        snapshot.status === 'completed' ? api.evaluation() : Promise.resolve(null),
      ])
      data = { snapshot, telemetry, evaluation }
    } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  function paint() {
    if (!data.snapshot || !document.getElementById('m-crops-grid') || state.view !== 'mars-crops') return
    const { snapshot, telemetry, evaluation } = data
    const sensors = snapshot.sensors ?? {}, crops = sensors.crops ?? [], profiles = snapshot.rules?.cropProfiles ?? []
    const byId = new Map((snapshot.entities ?? []).filter((entity) => entity.kind === 'crop').map((entity) => [entity.id, entity.state ?? {}]))
    const visible = crops.filter((crop) => filter === 'all' || crop.status === filter)
    const truth = new Map((evaluation?.crops ?? []).map((crop) => [crop.id, crop]))
    document.getElementById('m-crops-grid').innerHTML = CHAMBERS.map((chamber) => `<div class="m-crop-row">
      <div class="m-crop-chamber">${esc(chamber)}<span>${n((sensors.chambers ?? []).find((item) => item.id === chamber)?.temperatureReading, 1)} °C</span></div>
      ${[1, 2, 3, 4].map((variety) => {
        const id = `crop-${CHAMBERS.indexOf(chamber) + 1}-${variety}`
        const crop = crops.find((item) => item.id === id)
        if (!crop) return '<div class="m-crop-cell empty"></div>'
        if (filter !== 'all' && !visible.some((item) => item.id === id)) return '<div class="m-crop-cell filtered"></div>'
        const profile = profiles.find((item) => item.batch === variety) ?? {}
        const tolerance = profile.exposureToleranceTicks || 1
        const entity = byId.get(id) ?? {}
        const ratio = Math.min(1, (entity.exposureTicks ?? 0) / tolerance)
        const history = (telemetry?.[`${id}.moisture`] ?? []).map(([, value]) => value)
        const affected = truth.get(id)
        const infection = affected?.infectedSince !== null && affected?.infectedSince !== undefined
          ? `<div class="m-crop-truth">${t('真实感染于第 {tick} 步', { tick: affected.infectedSince })}${affected.removed ? ' · ' + t('已移除') : ''}</div>` : ''
        return `<div class="m-crop-cell status-${crop.status}">
          <div class="m-crop-top"><b>${esc(id)}</b>${badge(t(STATUS[crop.status]?.[0] ?? crop.status), STATUS[crop.status]?.[1] ?? 'idle')}</div>
          <div class="m-crop-main"><svg viewBox="0 0 40 40" class="m-ring" aria-hidden="true"><circle cx="20" cy="20" r="15" class="track"/><circle cx="20" cy="20" r="15" class="bar" stroke-dasharray="${(ratio * 94.2).toFixed(1)} 94.2"/></svg>
            <div><div class="m-crop-value">${n(crop.moistureReading)}</div><div class="m-sub">${t('水分读数')}</div></div>
            <div class="m-crop-meta"><span>${t('受压 {p}%', { p: pct(ratio) ?? 0 })}</span><span>${t('生长 {g}', { g: n(entity.growth, 2) })}</span></div></div>
          ${sparkline(history, crop.status === 'lost' ? '#ef6b6b' : crop.status === 'stressed' ? '#f3b64c' : '#3ecf8e', 200, 28)}
          <div class="m-sub">${t('最近 100 步灌溉 {v} µL', { v: n(crop.irrigationLast100, 0) })}</div>${infection}</div>`
      }).join('')}
    </div>`).join('') || empty(t('没有符合条件的作物。'))

    const counts = { healthy: crops.filter((crop) => crop.status === 'healthy').length, stressed: crops.filter((crop) => crop.status === 'stressed').length, lost: crops.filter((crop) => crop.status === 'lost').length }
    document.getElementById('m-crops-summary').innerHTML = `<span>${t('共 {n} 株', { n: crops.length })}</span><span class="m-dot healthy"></span>${t('健康')} ${counts.healthy}<span class="m-dot stressed"></span>${t('受压')} ${counts.stressed}<span class="m-dot lost"></span>${t('损失')} ${counts.lost}`
    const note = document.getElementById('m-crops-note')
    if (note) note.textContent = evaluation ? t('结算后已叠加真实感染时刻；运行中只显示可观测读数。') : t('运行中只显示可观测的水分读数、状态与自己的操作；真实感染时刻只在结算后出现。')
    document.querySelectorAll('[data-crop-filter]').forEach((button) => {
      button.classList.toggle('active', button.dataset.cropFilter === filter)
      button.onclick = () => { filter = button.dataset.cropFilter; paint() }
    })
  }

  return {
    section: '火星基地',
    title: '作物',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('4 × 4 作物网格')}</span><span class="spacer"></span><span class="m-sub" id="m-crops-summary"></span></div>
        <div class="m-chip-row">${[['all', '全部'], ['stressed', '只看受压'], ['lost', '只看损失']].map(([key, label]) => `<button class="chip-btn" data-crop-filter="${key}">${t(label)}</button>`).join('')}</div>
        <section class="card"><div id="m-crops-grid" class="m-crops"></div></section>
        <div class="m-note" id="m-crops-note"></div>
      </div>`
      load(false).then(paint)
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-crops') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
