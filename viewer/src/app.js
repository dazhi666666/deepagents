import { validateBundle, MAX_BUNDLE_BYTES, frameAt, actionTitle } from './data.js'
import { createScene } from './scene.js'
import { initialCamera } from './scene-art.js'
import { PHASE_ICONS, DEVICE_NAMES } from './layout.js'
import { PANEL_DEFINITIONS, renderPanel } from './panels.js'
import { bindCharts } from './charts.js'
import { esc, num, actionButton, downloadJson } from './dom.js'

/** Offline UI entry. No fetch, WebSocket, simulation imports, or model/control methods. */
export function startViewer(initialBundle) {
  let bundle = validateBundle(initialBundle), run = bundle.runs[0], frame = null
  const $ = id => document.getElementById(id), sheet = $('page-sheet')
  const state = { selected: null, tick: bundle.source === 'fixture' ? Math.min(run.tick, run.operations.find(o => o.command.action === 'aliquot')?.processingTick ?? run.tick) : run.tick,
    paused: false, playing: false, speed: 12, panel: null, tab: 0, options: {}, returnFocus: null, replayOpen: false, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }
  let lastFrame = null, lastDetailKey = '', lastFrameTick = null, toastTimer, panelPause = null, mergeWorlds = true
  const scene = createScene($('scene'), $('labels'), { onSelect: selectDevice, onBackground: () => toggleMenu(false), onCamera: camera => { $('location-title').textContent = camera.regionName; $('zoom-level').textContent = (initialCamera.width / camera.width).toFixed(1) + '×' } })
  function notify(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true }, 3500) }
  function updateSource() {
    $('source-label').dataset.source = bundle.source
    $('source-label').textContent = `${bundle.source === 'fixture' ? '集成样例' : '实验记录'} · ${run.label} · ${state.tick === run.tick ? '终态' : '回看'} tick ${Math.floor(state.tick)} / ${run.tick}`
    $('identity-source').textContent = `${bundle.source === 'fixture' ? '集成样例' : '已结束运行'} · ${run.label}`
    $('tick-slider').value = Math.floor(state.tick); $('tick-output').textContent = `${Math.floor(state.tick)} / ${run.tick}`
  }
  function updatePause() {
    document.body.classList.toggle('paused', state.paused); document.body.classList.toggle('reduced', state.reduced)
    $('pause-view').setAttribute('aria-pressed', String(state.paused)); $('pause-view').querySelector('span').textContent = state.paused ? '继续观看' : '暂停观看'
    $('pause-view').querySelector('path').setAttribute('d', state.paused ? 'M8 5L19 12L8 19Z' : 'M8 5V19M16 5V19')
    $('play-history').textContent = state.playing ? '暂停过程' : '播放过程'
  }
  function refresh(force = false) {
    frame = frameAt(run, state.tick); scene.setFrame(frame, run.layout, run.routes)
    if (force || Math.floor(state.tick) !== lastFrameTick) { updateSource(); updateDetail(force); lastFrameTick = Math.floor(state.tick) }
  }
  function setTime(tick, stop = true) {
    state.tick = Math.max(run.coverage.fromTick ?? 0, Math.min(run.tick, Number(tick) || 0))
    if (stop) { state.playing = false; state.paused = true }
    lastFrame = null; refresh(true); updatePause()
  }
  function openReplay(open = true) {
    state.replayOpen = open; $('replay-tools').hidden = !open; $('open-replay').setAttribute('aria-expanded', String(open)); document.body.classList.toggle('history-open', open)
  }
  function toggleMenu(open) { $('scene-menu').hidden = !open; $('scene-menu-toggle').setAttribute('aria-expanded', String(open)) }
  function updateWorldOptions() {
    $('world-picker').replaceChildren(...bundle.runs.map(r => { const option = document.createElement('option'); option.value = r.id; option.textContent = `${r.label} · ${r.id.slice(0, 18)}`; return option }))
    $('world-picker').value = run.id; $('tick-slider').max = run.tick; $('tick-slider').min = run.coverage.fromTick ?? 0
    $('replay-coverage').textContent = `仅控制观看。操作与路线来自事件；健康与库存仅在终态快照可用。${run.coverage.operationHistory ? '' : ' 事件存在缺口。'}`
  }
  function changeWorld(id) {
    const next = bundle.runs.find(r => r.id === id); if (!next) return
    const terminal = state.tick === run.tick; run = next
    state.tick = terminal ? next.tick : Math.min(next.tick, Math.max(next.coverage.fromTick ?? 0, state.tick))
    state.playing = false; state.paused = true; lastFrame = null; lastDetailKey = ''; updateWorldOptions(); refresh(true); updatePause()
    if (state.panel && sheet.open) paintPanel()
  }
  function selectDevice(id) {
    if (!frame.devices.some(d => d.id === id)) return
    state.selected = id; scene.select(id); $('device-detail').hidden = false; updateDetail(true)
    const d = frame.devices.find(d => d.id === id); $('selection-status').textContent = `已选择${d.name}，${d.state}`
  }
  function clearSelection() { state.selected = null; scene.select(null); $('device-detail').hidden = true; lastDetailKey = '' }
  function updateDetail(force = false) {
    if (!state.selected) return
    const d = frame.devices.find(d => d.id === state.selected); if (!d) { clearSelection(); return }
    const key = `${d.id}:${d.phase}:${d.operation?.id}:${d.flags.join(',')}:${frame.terminal}:${Math.floor(state.tick)}`
    if (!force && key === lastDetailKey) return
    lastDetailKey = key
    $('detail-title').textContent = d.name; $('detail-kind').textContent = run.layout.regions.find(r => r.id === d.regionId)?.label ?? '基地设施'
    $('detail-icon').textContent = PHASE_ICONS[d.phase] ?? '?'; $('detail-state').textContent = d.state
    $('detail-operation').textContent = d.operation ? actionTitle(d.operation) : d.phase === 'unknown' ? '此时没有可确认的操作状态' : '此时无活动操作'
    $('detail-description').textContent = d.operation ? `${d.operation.id} · ${d.motion ? '按记录的工作阶段显示' : '部件停止'}` : '在实验记录中可查看这台器材的工作过程。'
    const samples = d.operation ? d.samples : frame.terminal ? run.snapshot.samples.filter(s => s.location === d.id).map(s => s.id) : []
    const values = [['所见 tick', Math.floor(state.tick)], ['样品', samples.length ? samples.join('、') : '未记录'], ['调用角色', d.actor ?? '—']]
    if (d.operation) values.push(['接纳 tick', d.operation.acceptedTick], ['记录中的结束 tick', d.operation.completedTick ?? '尚未结束'])
    if (d.health?.temperature != null) values.push(['终态温度', `${num(d.health.temperature)} °C`])
    if (d.energy != null && frame.terminal) values.push(['终态电量', num(d.energy)])
    $('detail-values').innerHTML = values.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`).join('')
    $('detail-health').textContent = d.healthKnown ? d.flags.join('；') || '终态未标记故障、清洗或供电问题' : d.flags.length ? `已记录：${d.flags.join('；')}。其他健康标记未完整记录。` : '此时的健康与维护标记未记录'
    $('focus-device').disabled = !d.positionKnown
    const related = run.operations.filter(op => op.deviceId === d.id || op.command.destination === d.id || run.routes.some(r => r.robotId === d.id && r.operationId === op.id)).slice(-5)
    $('detail-related').innerHTML = `<div class="detail-rule"></div><h3>关联操作</h3>${related.length ? related.map(o => actionButton('operation', o.id, `${actionTitle(o)} · ${o.acceptedTick}`)).join('') : '<p class="detail-explainer">没有已导出的关联操作。</p>'}`
  }
  function openPanel(key, tab = 0, options = {}, opener = document.activeElement) {
    if (!PANEL_DEFINITIONS[key]) return
    if (!sheet.open) { state.returnFocus = opener; panelPause = { playing: state.playing, paused: state.paused }; state.playing = false; state.paused = true; updatePause() }
    state.panel = key; state.tab = tab; state.options = { ...options }; toggleMenu(false); $('sheet-title').textContent = PANEL_DEFINITIONS[key].title
    $('sheet-tabs').replaceChildren(...PANEL_DEFINITIONS[key].tabs.map((text, i) => {
      const b = document.createElement('button'); b.id = `sheet-tab-${i}`; b.role = 'tab'; b.textContent = text; b.setAttribute('aria-controls', 'sheet-content'); b.setAttribute('aria-selected', String(i === tab)); b.tabIndex = i === tab ? 0 : -1
      b.addEventListener('click', () => { state.tab = i; state.options = {}; paintPanel() }); return b
    }))
    paintPanel(); if (!sheet.open) sheet.showModal()
    document.querySelectorAll('.main-nav [data-panel]').forEach(b => b.setAttribute('aria-expanded', String(b.dataset.panel === key)))
  }
  function paintPanel() {
    if (!state.panel) return
    const content = $('sheet-content'); content.innerHTML = renderPanel({ bundle, run, frame }, state.panel, state.tab, state.options); content.setAttribute('aria-labelledby', `sheet-tab-${state.tab}`); content.scrollTop = 0
    $('sheet-tabs').querySelectorAll('button').forEach((b, i) => { b.setAttribute('aria-selected', String(i === state.tab)); b.tabIndex = i === state.tab ? 0 : -1 })
    bindCharts(content)
  }
  function closePanel(resume = true) {
    if (!resume) { panelPause = { playing: false, paused: true }; state.playing = false; state.paused = true; updatePause() }
    if (sheet.open) sheet.close()
  }
  sheet.addEventListener('close', () => {
    if (sheet.open) return
    state.panel = null
    if (panelPause) { Object.assign(state, panelPause); panelPause = null; lastFrame = null; updatePause() }
    document.querySelectorAll('.main-nav [data-panel]').forEach(b => b.setAttribute('aria-expanded', 'false'))
    if (state.returnFocus?.isConnected && !state.returnFocus.closest('#page-sheet')) state.returnFocus.focus({ preventScroll: true })
  })
  sheet.addEventListener('click', event => {
    if (event.target !== sheet) return
    const r = sheet.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closePanel()
  })
  function showOperation(id) {
    const op = run.operations.find(o => o.id === id); if (!op) { notify('这条操作没有导出。'); return }
    closePanel(false); openReplay(); setTime(op.processingTick ?? op.acceptedTick)
    if (op.deviceId && frame.devices.some(d => d.id === op.deviceId)) { selectDevice(op.deviceId); scene.focusDevice(op.deviceId) }
  }
  function handleAction(action, value) {
    if (action === 'locate') { closePanel(false); selectDevice(value); scene.focusDevice(value) }
    else if (action === 'region') { closePanel(false); scene.jumpRegion(value) }
    else if (action === 'operation') showOperation(value)
    else if (action === 'operation-detail') { state.options.opId = value; paintPanel() }
    else if (action === 'task') { state.options.taskId = value; paintPanel() }
    else if (action === 'raw') openPanel('research', 2, { rawId: value })
    else if (action === 'analysis') openPanel('research', 3, { analysisId: value })
    else if (action === 'page') { state.options.page = Math.max(0, Number(value) || 0); paintPanel() }
    else if (action === 'seek') { closePanel(false); openReplay(); setTime(Number(value)) }
    else if (action === 'replay') { closePanel(false); openReplay() }
    else if (action === 'world') { closePanel(false); changeWorld(value) }
    else if (action === 'import') { mergeWorlds = $('merge-worlds')?.checked ?? true; closePanel(false); $('bundle-file').click() }
    else if (action === 'export-bundle') downloadJson(bundle, 'mars-viewer-records.json')
    else if (action === 'download-raw') downloadJson({ raw: run.raw.find(r => r.id === value), measurement: run.measurements.find(r => r.id === value) }, 'mars-raw-record.json')
    else if (action === 'download-analysis') downloadJson(run.analyses.find(r => r.id === value), 'mars-analysis-record.json')
  }
  $('sheet-content').addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) handleAction(button.dataset.action, button.dataset.value) })
  $('detail-related').addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button) handleAction(button.dataset.action, button.dataset.value) })
  $('sheet-content').addEventListener('submit', event => { if (event.target.id !== 'record-filter') return; event.preventDefault(); state.options.query = new FormData(event.target).get('query'); state.options.page = 0; paintPanel() })
  const pickers = { 'raw-picker': 'rawId', 'analysis-picker': 'analysisId', 'crop-picker': 'cropId', 'band-picker': 'band', 'telemetry-picker': 'channel', 'compare-left': 'leftId', 'compare-right': 'rightId', 'chamber-picker': 'chamberId' }
  $('sheet-content').addEventListener('change', event => { const key = pickers[event.target.id]; if (key) { state.options[key] = event.target.id === 'band-picker' ? Number(event.target.value) : event.target.value; paintPanel() } })
  $('sheet-tabs').addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); const tabs = [...$('sheet-tabs').querySelectorAll('button')], i = tabs.indexOf(document.activeElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    tabs[next].click(); tabs[next].focus()
  })
  document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.panel, 0, {}, button)))
  document.querySelectorAll('[data-region]').forEach(button => button.addEventListener('click', () => { scene.jumpRegion(button.dataset.region); toggleMenu(false) }))
  $('scene-menu-toggle').addEventListener('click', () => toggleMenu($('scene-menu').hidden)); $('world-picker').addEventListener('change', event => changeWorld(event.target.value))
  $('close-sheet').addEventListener('click', () => closePanel()); $('expand-sheet').addEventListener('click', () => { const wide = sheet.dataset.wide !== 'true'; sheet.dataset.wide = String(wide); $('expand-sheet').setAttribute('aria-pressed', String(wide)); $('expand-sheet').setAttribute('aria-label', wide ? '恢复面板大小' : '扩大面板') })
  $('show-labels').addEventListener('change', event => scene.setLabels(event.target.checked))
  $('reduced-motion').checked = state.reduced
  $('reduced-motion').addEventListener('change', event => { state.reduced = event.target.checked; updatePause() })
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => { state.reduced = event.matches; $('reduced-motion').checked = state.reduced; updatePause() })
  $('pause-view').addEventListener('click', () => { state.paused = !state.paused; if (state.paused) state.playing = false; lastFrame = null; updatePause() })
  $('zoom-out').addEventListener('click', () => scene.zoom(1.23)); $('zoom-in').addEventListener('click', () => scene.zoom(1 / 1.23)); $('reset-camera').addEventListener('click', () => scene.reset())
  $('close-detail').addEventListener('click', clearSelection); $('focus-device').addEventListener('click', () => scene.focusDevice(state.selected))
  $('device-records').addEventListener('click', () => openPanel('records', 0, { query: state.selected, opId: frame.devices.find(d => d.id === state.selected)?.operation?.id }))
  $('open-replay').addEventListener('click', () => openReplay(!state.replayOpen)); $('close-replay').addEventListener('click', () => openReplay(false)); $('tick-slider').addEventListener('input', event => setTime(Number(event.target.value)))
  $('replay-speed').addEventListener('change', event => { state.speed = Number(event.target.value) })
  $('play-history').addEventListener('click', () => {
    if (state.playing) { state.playing = false; state.paused = true }
    else { if (state.tick >= run.tick) state.tick = run.operations[0]?.acceptedTick ?? run.coverage.fromTick ?? 0; state.playing = true; state.paused = false }
    lastFrame = null; refresh(true); updatePause()
  })
  $('terminal-view').addEventListener('click', () => setTime(run.tick))
  function nextEvent(direction) { const ticks = [...new Set(run.events.map(e => e.tick))].sort((a, b) => a - b); const next = direction > 0 ? ticks.find(t => t > state.tick) : ticks.findLast(t => t < state.tick); if (next != null) setTime(next) }
  $('previous-event').addEventListener('click', () => nextEvent(-1)); $('next-event').addEventListener('click', () => nextEvent(1))
  $('bundle-file').addEventListener('change', async event => {
    const files = [...event.target.files]; if (!files.length) return
    try {
      const imported = []
      for (const file of files) { if (file.size > MAX_BUNDLE_BYTES) throw new Error('单个文件不能超过 200 MiB'); imported.push(validateBundle(JSON.parse(await file.text()))) }
      if (new Set(imported.map(b => b.source)).size !== 1) throw new Error('请分别导入集成样例和正式实验记录')
      const source = imported[0].source, existing = mergeWorlds && source === bundle.source ? bundle.runs : []
      const candidates = [...new Map([...existing, ...imported.flatMap(b => b.runs)].map(r => [r.id, r])).values()]
      const next = validateBundle({ version: bundle.version, source, createdAt: imported[0].createdAt, runs: candidates })
      if (new Blob([JSON.stringify(next)]).size > MAX_BUNDLE_BYTES) throw new Error('合并后超过 200 MiB，请分开查看')
      bundle = next; run = candidates.find(r => r.id === run.id) ?? candidates[0]; state.tick = run.tick; state.playing = false; state.paused = true; lastFrame = null
      clearSelection(); $('import-error').hidden = true; updateWorldOptions(); refresh(true); updatePause(); notify(`已载入 ${candidates.length} 个世界`)
    } catch (error) { $('import-error').querySelector('span').textContent = `未导入：${error.message}。原记录已保留。`; $('import-error').hidden = false }
    finally { event.target.value = '' }
  })
  $('import-error').querySelector('button').addEventListener('click', () => { $('import-error').hidden = true })
  document.addEventListener('keydown', event => {
    if (sheet.open) return
    if (event.key === 'Escape') { if (!$('scene-menu').hidden) { toggleMenu(false); $('scene-menu-toggle').focus() } else clearSelection() }
  })
  document.addEventListener('visibilitychange', () => { lastFrame = null })
  function animate(now) {
    if (state.playing && !state.paused && !document.hidden && !sheet.open) {
      const dt = lastFrame == null ? 0 : Math.min(.25, (now - lastFrame) / 1000)
      state.tick = Math.min(run.tick, state.tick + dt * state.speed); refresh()
      if (state.tick >= run.tick) { state.playing = false; state.paused = true; refresh(true); updatePause() }
    }
    lastFrame = now; requestAnimationFrame(animate)
  }
  updateWorldOptions(); refresh(true); updatePause(); requestAnimationFrame(animate)
  // Inspection returns copies; it cannot change experiment state or access the filesystem.
  window.marsViewer = { inspect: () => ({ source: bundle.source, runId: run.id, tick: state.tick, paused: state.paused, playing: state.playing, selected: state.selected, panel: state.panel, camera: scene.getCamera(), devices: frame.devices.map(d => ({ id: d.id, phase: d.phase, x: d.x, y: d.y, healthKnown: d.healthKnown, positionKnown: d.positionKnown })) }) }
}
