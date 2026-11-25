/* 原始数据：色谱、 高光谱单波段与 b6/b4 比值、舱内扫描分页。只读，不给自动结论。 */
import { empty, n } from './common.js'
import { heatmap, lineChart, ratioMatrix } from './charts.js'

const BAND_NAMES = ['b1', 'b2', 'b3', 'b4-red', 'b5', 'b6', 'b7-nir', 'b8']

export function createRaw(ctx) {
  const { api, t, esc, state, mars } = ctx
  const rootId = 'mars-raw-root'
  let busy = false
  let data = { snapshot: null, deliverables: [], raw: null, measurement: null, key: null }
  let band = 5, crop = null

  async function load(force) {
    if (busy) return
    busy = true
    try {
      const snapshot = await api.snapshot(force)
      const deliverables = await api.deliverables().catch(() => [])
      const keys = candidates(snapshot, deliverables)
      const key = mars.rawKey && keys.includes(mars.rawKey) ? mars.rawKey : keys[0] ?? null
      let raw = null, measurement = null
      if (key) {
        raw = await api.raw(key).catch(() => null)
        if (!key.startsWith('scan:')) measurement = await api.measurement(key).catch(() => null)
      }
      data = { snapshot, deliverables, keys, raw, measurement, key }
    } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  function candidates(snapshot, deliverables) {
    const keys = []
    for (const entry of deliverables ?? []) for (const id of entry.evidence?.resultIds ?? []) if (!keys.includes(id)) keys.push(id)
    for (const operation of snapshot.operations ?? []) {
      for (const id of operation.resultIds ?? []) if (!keys.includes(id)) keys.push(id)
      if (operation.action === 'scan' && operation.physicalState === 'succeeded' && !keys.includes(`scan:${operation.id}`)) keys.push(`scan:${operation.id}`)
    }
    return keys
  }

  function chromatogram(raw, measurement) {
    const points = (raw.points ?? []).map((value, index) => [index * (raw.dtMinutes ?? 0.02), value])
    return `<section class="card"><div class="card-head"><span class="card-title">${t('色谱')}</span><span class="spacer"></span><span class="m-sub">${t('{n} 点 · dt {dt} min', { n: points.length, dt: raw.dtMinutes ?? 0.02 })}</span></div>
      ${lineChart({ series: [{ name: t('信号'), color: '#38e1ff', points }], xRefs: [
        { x: 5.1, color: '#f3b64c', label: t('DOC 峰 5.1') }, { x: 5.4, color: '#c084fc', label: t('干扰峰 5.4') }, { x: 7.8, color: '#3ecf8e', label: t('内标 7.8') },
      ], bands: [{ from: 4.8, to: 5.6, color: 'rgba(56,225,255,.08)', label: t('v1 积分窗口 4.8–5.6') }], xMin: 0, yMin: 0 })}
      <div class="m-legend"><span><i style="background:#f3b64c"></i>${t('DOC 参考 5.1')}</span><span><i style="background:#c084fc"></i>${t('干扰峰 5.4')}</span><span><i style="background:#3ecf8e"></i>${t('内标 7.8')}</span><span>${t('阴影为旧版积分窗口')}</span></div>
      ${measurement ? `<div class="m-kv"><span>${t('仪器摘要')}</span><b>${n(measurement.instrumentSummary, 3)}</b><span>${t('摘要方法')}</span><b>${esc(measurement.summaryMethod ?? '')}</b>
        <span>${t('方法版本')}</span><b>v${esc(measurement.methodVersion)}</b><span>${t('校准年龄')}</span><b>${n(measurement.calibrationAgeTicks, 0)}</b>
        <span>${t('标记')}</span><b>${(measurement.flags ?? []).join(', ') || '—'}</b></div>` : ''}</section>`
  }

  function cubeView(cube) {
    if (cube.kind === 'chamber-scan') {
      const ids = Object.keys(cube.cubes ?? {})
      if (!ids.length) return empty(t('这次扫描没有可用的作物立方体。'))
      const active = crop && ids.includes(crop) ? crop : ids[0]
      return `<section class="card"><div class="card-head"><span class="card-title">${t('舱内扫描')}</span><span class="spacer"></span><span class="m-sub">${t('第 {tick} 步 · {n} 株', { tick: cube.tick, n: ids.length })}</span></div>
        <div class="m-chip-row">${ids.map((id) => `<button class="chip-btn ${id === active ? 'active' : ''}" data-crop-tab="${esc(id)}">${esc(id)}</button>`).join('')}</div>
        <div id="m-cube">${cubeView(cube.cubes[active])}</div></section>`
    }
    if (cube.kind === 'hyperspectral') {
      const ratio = band === -1
      const matrix = ratio ? ratioMatrix(cube) : cube.data[band]
      const label = ratio ? 'b6 / b4' : (cube.bandNames?.[band] ?? BAND_NAMES[band])
      return `<div class="m-cube-wrap"><div class="m-band-row">${cube.bandNames.map((name, index) => `<button class="chip-btn ${band === index ? 'active' : ''}" data-band="${index}">${esc(name)}</button>`).join('')}<button class="chip-btn ${ratio ? 'active' : ''}" data-band="-1">${t('b6/b4 病斑')}</button></div>
        <div class="m-heat-wrap">${heatmap(matrix, ratio ? { from: [20, 40, 30], to: [240, 90, 60] } : {})}<div class="m-sub">${t('单波段 {band} · {w} × {h}', { band: label, w: cube.width, h: cube.height })}</div></div></div>`
    }
    return `<pre>${esc(JSON.stringify(cube, null, 2).slice(0, 4000))}</pre>`
  }

  function bind() {
    document.querySelectorAll('[data-raw-key]').forEach((button) => (button.onclick = () => {
      mars.rawKey = button.dataset.rawKey
      load(true).then(paint)
    }))
    document.querySelectorAll('[data-band]').forEach((button) => (button.onclick = () => { band = Number(button.dataset.band); paint() }))
    document.querySelectorAll('[data-crop-tab]').forEach((button) => (button.onclick = () => { crop = button.dataset.cropTab; paint() }))
    document.querySelectorAll('[data-copy]').forEach((button) => (button.onclick = async () => {
      try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = t('已复制') } catch { button.textContent = t('复制失败') }
    }))
  }

  function paint() {
    if (!data.snapshot || !document.getElementById('m-raw-body') || state.view !== 'mars-raw') return
    const { keys, raw, measurement, key } = data
    document.getElementById('m-raw-picker').innerHTML = keys.length
      ? `<div class="m-chip-row">${keys.map((item) => `<button class="chip-btn ${item === key ? 'active' : ''}" data-raw-key="${esc(item)}">${item.startsWith('scan:') ? t('扫描') : t('结果')} <span class="mono">${esc(item.replace('scan:', '').slice(0, 18))}</span></button>`).join('')}</div>`
      : empty(t('还没有可浏览的原始数据。先让 Agent 完成检测或扫描。'))
    document.getElementById('m-raw-body').innerHTML = raw
      ? (raw.kind === 'chromatogram' ? chromatogram(raw, measurement) : cubeView(raw))
      : (keys.length ? empty(t('这个键暂时没有原始数据。')) : '')
    bind()
  }

  return {
    section: '火星基地',
    title: '原始数据',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('原始数据浏览')}</span><span class="spacer"></span><span class="m-sub">${t('色谱与高光谱 · 只读')}</span></div>
        <section class="card"><div class="card-head"><span class="card-title">${t('选择数据')}</span></div><div id="m-raw-picker"></div></section>
        <div id="m-raw-body"></div>
        <div class="m-note">${t('这里只渲染仪器原始数据，不提供自动分析结论。')}</div>
      </div>`
      load(false).then(paint)
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-raw') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
