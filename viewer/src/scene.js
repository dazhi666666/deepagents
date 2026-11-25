import { makeWorld, project, initialCamera } from './scene-art.js'
import { PHASE_ICONS } from './layout.js'

/** Full-window camera and screen-space labels. This module has no clock or experiment connection. */
export function createScene(container, labelRoot, options) {
  const camera = { ...initialCamera }, labelPoints = new Map()
  let world = null, frame = null, layout = null, selected = null, showLabels = true, labelKey = '', pointer = null
  let moved = false, regionName = '前处理与分析区', drawBase = new Map(), currentRoutes = [], cropKey = ''
  const dimensions = () => ({ width: container.clientWidth || 1, height: container.clientHeight || 1 })
  function dockOffset(d) {
    if (!d.id.startsWith('robot-') || !frame) return [0, 0]
    const nearest = Math.min(...frame.devices.filter(other => !other.id.startsWith('robot-')).map(other => Math.hypot(other.x - d.x, other.y - d.y)))
    const weight = Math.max(0, 1 - nearest / 1.5)
    return [25 * weight, 90 * weight]
  }
  const viewBox = () => {
    const { width, height } = dimensions(), h = camera.width * height / width
    return { x: camera.cx - camera.width / 2, y: camera.cy - h / 2, width: camera.width, height: h }
  }
  function labelsUpdate(rebuild = false) {
    if (!frame || !world) return
    const overview = camera.width > 3000
    const views = overview ? layout.regions : frame.devices.filter(d => d.positionKnown && (d.primary || d.alert || d.id === selected || !['idle', 'unknown'].includes(d.phase) || camera.width < 1400))
      .filter(d => {
        const v = viewBox(), b = dimensions(), p = project(d.x, d.y, d.height + 32), offset = dockOffset(d)
        const x = (p[0] + offset[0] - v.x) / v.width * b.width, y = (p[1] + offset[1] - v.y) / v.height * b.height
        return x > 35 && x < b.width - 35 && y > (b.width < 760 ? 205 : 115) && y < b.height - 95
      })
      .sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || Number(Boolean(b.alert)) - Number(Boolean(a.alert)) || Number(!['idle', 'unknown'].includes(b.phase)) - Number(!['idle', 'unknown'].includes(a.phase)) || Number(b.primary) - Number(a.primary))
    const key = `${overview}:${selected}:${views.map(d => `${d.id}:${d.phase}:${d.labelState ?? d.state}`).join('|')}`
    if (rebuild || key !== labelKey) {
      labelKey = key; labelRoot.replaceChildren(); labelPoints.clear()
      for (const d of views) {
        const button = document.createElement('button'); button.className = `device-label${overview ? ' region-label' : ''}${d.id === selected ? ' is-selected' : ''}`
        button.dataset[overview ? 'region' : 'object'] = d.id
        if (overview) { button.textContent = d.label; button.setAttribute('aria-label', `移动到${d.label}`) }
        else {
          const name = document.createElement('strong'), state = document.createElement('span'), icon = document.createElement('i')
          button.dataset.phase = d.phase; name.textContent = d.name; icon.className = 'state-icon'; icon.textContent = PHASE_ICONS[d.phase] ?? '?'
          state.append(icon, document.createTextNode(d.labelState ?? d.state)); button.append(name, state)
          button.setAttribute('aria-label', `${d.name}，${d.state}`)
        }
        labelRoot.append(button); labelPoints.set(button, d.id)
      }
    }
    labelRoot.hidden = !showLabels
    const v = viewBox(), b = dimensions(), occupied = []
    for (const [button, id] of labelPoints) {
      const d = overview ? layout.regions.find(r => r.id === id) : frame.devices.find(r => r.id === id)
      const p = overview ? project(d.x + 6, d.y + 5, 115) : project(d.x, d.y, d.height + 32)
      const offset = overview ? [0, 0] : dockOffset(d)
      const x = (p[0] + offset[0] - v.x) / v.width * b.width, y = (p[1] + offset[1] - v.y) / v.height * b.height
      const width = button.offsetWidth || 118, height = button.offsetHeight || 57
      let top = y
      for (let i = 0; i < 5 && occupied.some(o => Math.abs(o.x - x) < (width + o.w) / 2 + 9 && Math.abs(o.y - top) < (height + o.h) / 2 + 12); i++) top -= height + 15
      button.hidden = x < 35 || x > b.width - 35 || top < (b.width < 760 ? 150 : 115) || top > b.height - 95
      if (button.hidden) continue
      button.style.left = `${Math.max(width / 2 + 12, Math.min(b.width - width / 2 - 12, x))}px`
      button.style.top = `${top}px`; occupied.push({ x, y: top, w: width, h: height })
    }
  }
  function cameraUpdate(rebuild = false) {
    if (world) { const v = viewBox(); world.setAttribute('viewBox', `${v.x} ${v.y} ${v.width} ${v.height}`) }
    labelsUpdate(rebuild); options.onCamera?.({ ...camera, regionName: camera.width > 3000 ? '火星科研基地' : regionName })
  }
  function reset() {
    if (dimensions().width < 760) { const [x, y] = project(22, 20, 30); Object.assign(camera, { cx: x, cy: y, width: 650 }) }
    else Object.assign(camera, initialCamera)
    regionName = '前处理与分析区'; cameraUpdate(true)
  }
  function zoom(factor, clientX, clientY) {
    const b = dimensions(), v = viewBox(), next = Math.max(b.width < 760 ? 430 : 850, Math.min(5100, camera.width * factor))
    const fx = (clientX ?? b.width / 2) / b.width - .5, fy = (clientY ?? b.height / 2) / b.height - .5
    camera.cx += fx * (camera.width - next); camera.cy += fy * (v.height - next * b.height / b.width); camera.width = next
    camera.cx = Math.max(-1400, Math.min(1900, camera.cx)); camera.cy = Math.max(0, Math.min(1900, camera.cy)); cameraUpdate()
  }
  function jumpRegion(id) {
    if (id === 'lab') { reset(); return }
    const region = layout?.regions.find(r => r.id === id)
    if (!region) return
    const [x, y] = project(region.x + 6, region.y + 5, 30)
    Object.assign(camera, { cx: x, cy: y, width: dimensions().width < 760 ? 700 : 1450 }); regionName = region.label; cameraUpdate(true)
  }
  function focusDevice(id = selected) {
    const d = frame?.devices.find(d => d.id === id)
    if (!d || !d.positionKnown) return
    const [x, y] = project(d.x, d.y, 60), mobile = dimensions().width < 760
    Object.assign(camera, { cx: x + (mobile ? 0 : 170), cy: y, width: mobile ? 570 : 1100 }); regionName = d.name; cameraUpdate(true)
  }
  function drawRoutes() {
    const g = world?.querySelector('#route-layer'); if (!g) return
    g.replaceChildren()
    const chosen = frame?.devices.find(d => d.id === selected)?.operation
    const routes = currentRoutes.filter(r => r.operationId === chosen?.id && r.tick <= frame.tick)
    const nodes = new Map(layout.nodes.map(n => [n.id, n]))
    for (const route of routes) for (const segment of route.segments) {
      const from = segment.fromPosition ?? nodes.get(segment.from), to = segment.toPosition ?? nodes.get(segment.to)
      if (!from || !to) continue
      const a = project(from.x, from.y, 12), b = project(to.x, to.y, 12), line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      line.setAttribute('d', `M${a.join(',')}L${b.join(',')}`); line.setAttribute('class', 'accepted-route'); line.setAttribute('vector-effect', 'non-scaling-stroke'); g.append(line)
    }
  }
  function setFrame(next, nextLayout, routes) {
    frame = next; layout = nextLayout; currentRoutes = routes ?? []
    const roster = frame.crops.map(c => `${c.id}:${c.chamberId}`).join('|')
    if (!world || roster !== cropKey) {
      const first = !world; cropKey = roster
      container.innerHTML = makeWorld(undefined, undefined, frame.crops)
      world = container.querySelector('svg')
      const routeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g'); routeLayer.id = 'route-layer'; routeLayer.setAttribute('aria-hidden', 'true'); world.append(routeLayer)
      drawBase = new Map([...world.querySelectorAll('[data-device]')].map(el => [el.dataset.device, el]))
      if (first) reset(); else cameraUpdate(true)
    }
    for (const d of frame.devices) {
      const el = drawBase.get(d.id); if (!el) continue
      el.dataset.phase = d.phase; el.dataset.alert = d.alert ?? ''; el.dataset.motion = String(d.motion); el.classList.toggle('is-selected', d.id === selected)
      el.style.visibility = d.positionKnown ? '' : 'hidden'
      const origin = project(Number(el.dataset.originX), Number(el.dataset.originY)), p = project(d.x, d.y), offset = dockOffset(d)
      el.setAttribute('transform', `translate(${p[0] - origin[0] + offset[0]} ${p[1] - origin[1] + offset[1]})`)
      const link = el.querySelector('.dock-link'); link.setAttribute('d', offset[1] ? `M${origin[0] - offset[0]},${origin[1] - offset[1]}L${origin.join(',')}` : '')
      el.setAttribute('aria-label', `${d.name}，${d.state}`); el.querySelector('title').textContent = `${d.name}：${d.state}`
    }
    const crops = new Map(frame.crops.map(c => [c.id, c]))
    for (const plant of world.querySelectorAll('[data-crop]')) {
      const crop = crops.get(plant.dataset.crop); if (!crop) continue
      plant.dataset.status = crop.status; plant.dataset.removed = String(crop.removed)
      plant.querySelector('title').textContent = `${crop.id}：${crop.removed ? '已移除' : crop.status === 'unknown' ? '此时状态未记录' : crop.status}`
    }
    labelsUpdate(); drawRoutes()
  }
  function select(id) { selected = id; if (frame) for (const d of frame.devices) drawBase.get(d.id)?.classList.toggle('is-selected', d.id === selected); labelsUpdate(true); drawRoutes() }
  const wheel = event => { event.preventDefault(); zoom(Math.exp(Math.max(-100, Math.min(100, event.deltaY * (event.deltaMode === 1 ? 16 : 1))) * .0022), event.clientX, event.clientY) }
  container.addEventListener('wheel', wheel, { passive: false }); labelRoot.addEventListener('wheel', wheel, { passive: false })
  labelRoot.addEventListener('click', event => { const b = event.target.closest('button'); if (b?.dataset.region) jumpRegion(b.dataset.region); else if (b?.dataset.object) options.onSelect(b.dataset.object) })
  container.addEventListener('pointerdown', event => { if (event.button !== 0) return; pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, cx: camera.cx, cy: camera.cy, target: event.target }; moved = false; container.setPointerCapture(event.pointerId) })
  container.addEventListener('pointermove', event => {
    if (!pointer || event.pointerId !== pointer.id) return
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y
    if (Math.hypot(dx, dy) > 5) moved = true
    if (!moved) return
    container.classList.add('dragging'); const b = dimensions()
    camera.cx = Math.max(-1400, Math.min(1900, pointer.cx - dx / b.width * camera.width)); camera.cy = Math.max(0, Math.min(1900, pointer.cy - dy / b.width * camera.width)); cameraUpdate()
  })
  container.addEventListener('pointerup', event => {
    if (!pointer || event.pointerId !== pointer.id) return
    const target = pointer.target; pointer = null; container.classList.remove('dragging')
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId)
    if (!moved) { const d = target.closest('[data-device]'); if (d) options.onSelect(d.dataset.device); else options.onBackground?.() }
  })
  const release = () => { pointer = null; container.classList.remove('dragging') }
  container.addEventListener('pointercancel', release); container.addEventListener('lostpointercapture', release)
  container.addEventListener('dblclick', event => { const d = event.target.closest('[data-device]'); if (d) { options.onSelect(d.dataset.device); focusDevice(d.dataset.device) } })
  window.addEventListener('resize', () => cameraUpdate(true))
  return { setFrame, select, focusDevice, jumpRegion, reset, zoom, getCamera: () => ({ ...camera }), setLabels: enabled => { showLabels = enabled; labelsUpdate() } }
}
