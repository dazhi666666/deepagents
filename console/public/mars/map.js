/* 基地地图：区域、门、设备锚点、机器人、作物状态的俯视图。 */
import { badge, empty, n } from './common.js'

const CROP_TONE = { healthy: '#3ecf8e', stressed: '#f3b64c', lost: '#ef6b6b' }
const KIND_LABEL = {
  incubator: '温室舱', robot: '机器人', 'water-module': '水路模块', cold: '冷藏设备', freezer: '冷冻设备',
  'analysis-device': '分析设备', 'prep-device': '前处理设备', 'solar-array': '太阳能阵列', battery: '电池', 'co2-tank': 'CO₂ 储罐',
  spares: '备件库', 'quarantine-bay': '隔离消毒间',
}

export function createMap(ctx) {
  const { api, t, esc, state } = ctx
  const rootId = 'mars-map-root'
  let busy = false
  let snapshot = null
  let selected = null

  async function load(force) {
    if (busy) return
    busy = true
    try { snapshot = await api.snapshot(force) } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  function detail(entity) {
    if (!entity) return empty(t('悬停或点击地图上的设备、机器人和作物查看读数。'))
    const s = entity.state ?? {}, sensors = snapshot.sensors ?? {}
    if (entity.kind === 'crop') {
      return `<div class="m-detail"><h3>${esc(entity.id)}</h3><div class="m-kv">
        <span>${t('状态')}</span><b>${esc(t({ healthy: '健康', stressed: '受压', lost: '损失' }[s.status] ?? s.status))}</b>
        <span>${t('水分读数')}</span><b>${n(s.moistureReading)}</b><span>${t('舱室')}</span><b>${esc(s.chamberId)}</b>
        <span>${t('累计受压')}</span><b>${n(s.exposureTicks, 0)}</b><span>${t('最近 100 步灌溉')}</span><b>${n(s.irrigationLast100, 0)} µL</b>
        <span>${t('剩余可取样')}</span><b>${n(s.availableSampleUl, 0)} µL</b></div></div>`
    }
    if (entity.kind === 'robot') {
      return `<div class="m-detail"><h3>${esc(entity.id)}</h3><div class="m-kv">
        <span>${t('位置')}</span><b>${esc(s.node ?? '')}</b><span>${t('电量')}</span><b>${n(s.energy)}</b>
        <span>${t('载货')}</span><b>${(s.cargo ?? []).length}</b><span>${t('当前操作')}</span><b class="mono">${esc(s.operationId ?? '—')}</b>
        <span>${t('窄通道占用')}</span><b>${s.blockedEdge ? t('是') : t('否')}</b></div></div>`
    }
    const chamber = sensors.chambers?.find((item) => item.id === entity.id)
    if (chamber) {
      return `<div class="m-detail"><h3>${esc(entity.id)}</h3><div class="m-kv">
        <span>${t('温度读数')}</span><b>${n(chamber.temperatureReading, 2)} °C</b><span>${t('目标温度')}</span><b>${n(chamber.targetTemperature, 1)} °C</b>
        <span>${t('光照')}</span><b>${n(chamber.light, 0)}</b><span>${t('CO₂')}</span><b>${n(chamber.co2, 0)} ppm</b>
        <span>${t('气压')}</span><b>${n(chamber.pressure, 2)} kPa</b><span>${t('营养档')}</span><b>${n(chamber.nutrient, 0)}</b>
        <span>${t('隔离')}</span><b>${chamber.quarantine ? t('是') : t('否')}</b></div></div>`
    }
    return `<div class="m-detail"><h3>${esc(entity.id)}</h3><div class="m-kv">
      <span>${t('类型')}</span><b>${esc(t(KIND_LABEL[s.kind] ?? s.kind ?? ''))}</b>
      <span>${t('故障')}</span><b>${s.broken ? t('是') : t('否')}</b><span>${t('需要清洗')}</span><b>${s.dirty ? t('是') : t('否')}</b>
      <span>${t('限电')}</span><b>${s.shed ? t('是') : t('否')}</b><span>${t('校准有效至')}</span><b>${s.calibratedUntil === undefined ? '—' : t('第 {tick} 步', { tick: s.calibratedUntil })}</b></div></div>`
  }

  function paint() {
    if (!snapshot || !document.getElementById('m-map-svg') || state.view !== 'mars-map') return
    const map = snapshot.map, sensors = snapshot.sensors ?? {}, entities = snapshot.entities ?? []
    const cropEntities = entities.filter((entity) => entity.kind === 'crop')
    const robots = entities.filter((entity) => entity.kind === 'robot')
    const devices = entities.filter((entity) => entity.kind === 'device')
    const byId = new Map(entities.map((entity) => [entity.id, entity]))
    const chamberStatus = (chamberId) => {
      const statuses = (sensors.crops ?? []).filter((crop) => crop.chamberId === chamberId).map((crop) => crop.status)
      return statuses.includes('lost') ? 'lost' : statuses.includes('stressed') ? 'stressed' : 'healthy'
    }
    const nodeAt = (id) => map.nodes.find((node) => node.id === id)
    const edges = map.edges.map((edge) => {
      const from = nodeAt(edge.from), to = nodeAt(edge.to)
      if (!from || !to) return ''
      const corridor = map.corridors.some((item) => item.from === edge.from && item.to === edge.to || item.from === edge.to && item.to === edge.from)
      return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="m-edge${corridor ? ' corridor' : ''}"/>`
    }).join('')
    const regions = map.regions.map((region) => `<g class="m-region"><rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" rx="1.4"/>` +
      `<text x="${region.x + 0.6}" y="${region.y - 0.9}">${esc(region.label)}</text></g>`).join('')
    const anchors = map.anchors.map((anchor) => {
      const entity = byId.get(anchor.id)
      if (!entity) return ''
      const s = entity.state ?? {}
      let tone = 'ok'
      if (s.broken) tone = 'bad'
      else if (s.shed) tone = 'off'
      else if (s.dirty) tone = 'warn'
      const crop = anchor.id.startsWith('incubator-') ? chamberStatus(anchor.id) : null
      if (crop) tone = crop === 'lost' ? 'bad' : crop === 'stressed' ? 'warn' : 'ok'
      const tip = anchor.id.startsWith('incubator-')
        ? `<b>${esc(anchor.id)}</b><br>${t('温度读数')} ${n(sensors.chambers?.find((item) => item.id === anchor.id)?.temperatureReading, 2)} °C<br>${t('CO₂')} ${n(sensors.chambers?.find((item) => item.id === anchor.id)?.co2, 0)} ppm`
        : anchor.id === 'reservoir' || anchor.id === 'filter' || anchor.id === 'pump'
          ? `<b>${esc(anchor.id)}</b><br>${t('在线 DOC')} ${n(sensors.water?.inlineDoc?.[anchor.id], 2)} mg/L`
          : `<b>${esc(anchor.id)}</b><br>${t(KIND_LABEL[s.kind] ?? s.kind ?? '')}${s.broken ? '<br>' + t('故障') : ''}${s.dirty ? '<br>' + t('需要清洗') : ''}${s.shed ? '<br>' + t('限电') : ''}`
      return `<g class="m-anchor tone-${tone}" data-entity="${esc(anchor.id)}" data-tip="${esc(tip)}"><rect x="${anchor.x - 1.2}" y="${anchor.y - 1.2}" width="2.4" height="2.4" rx="0.4"/></g>`
    }).join('')
    const cropDots = cropEntities.map((entity) => {
      const s = entity.state ?? {}, status = s.status ?? 'healthy'
      return `<circle class="m-crop" cx="${entity.position?.x ?? 0}" cy="${entity.position?.y ?? 0}" r="0.55" fill="${CROP_TONE[status]}" data-entity="${esc(entity.id)}" data-tip="${esc(`<b>${entity.id}</b><br>${t('状态')} ${t({ healthy: '健康', stressed: '受压', lost: '损失' }[status] ?? status)}<br>${t('水分读数')} ${n(s.moistureReading)}`)}"/>`
    }).join('')
    const robotDots = robots.map((entity) => {
      const s = entity.state ?? {}, charged = Math.max(0, Math.min(1, (s.energy ?? 0) / 120))
      return `<g class="m-robot${s.blockedEdge ? ' blocked' : ''}" data-entity="${esc(entity.id)}" data-tip="${esc(`<b>${entity.id}</b><br>${t('电量')} ${n(s.energy)}<br>${t('载货')} ${(s.cargo ?? []).length}`)}">
        <circle cx="${entity.position?.x ?? 0}" cy="${entity.position?.y ?? 0}" r="1.1" class="m-robot-body"/>
        <circle cx="${entity.position?.x ?? 0}" cy="${entity.position?.y ?? 0}" r="1.5" class="m-robot-ring" stroke-dasharray="${(charged * 9.4).toFixed(2)} 9.4"/>
        <text x="${entity.position?.x ?? 0}" y="${(entity.position?.y ?? 0) + 0.42}" text-anchor="middle" class="m-robot-label">${esc(entity.id.replace('robot-', 'R'))}</text></g>`
    }).join('')
    document.getElementById('m-map-svg').innerHTML = `<g>${regions}${edges}</g><g>${anchors}${cropDots}${robotDots}</g>`
    document.getElementById('m-map-side').innerHTML = `
      <div class="m-legend"><span><i style="background:${CROP_TONE.healthy}"></i>${t('健康')}</span><span><i style="background:${CROP_TONE.stressed}"></i>${t('受压')}</span><span><i style="background:${CROP_TONE.lost}"></i>${t('损失')}</span><span><i class="m-line"></i>${t('通道')}</span></div>
      <div class="m-kv m-map-stats"><span>${t('机器人')}</span><b>${robots.length}</b><span>${t('作物')}</span><b>${cropEntities.length}</b>
        <span>${t('限电负载')}</span><b>${(sensors.energy?.shed ?? []).length}</b><span>${t('窄通道占用')}</span><b>${robots.filter((robot) => robot.state?.blockedEdge).length}</b></div>
      ${robots.map((robot) => `<div class="m-robot-row"><b>${esc(robot.id)}</b><span>${t('位置')} ${esc(robot.state?.node ?? '')}</span><span>${t('电量')} ${n(robot.state?.energy)}</span>${badge(robot.state?.blockedEdge ? t('占用窄通道') : t('空闲'), robot.state?.blockedEdge ? 'warn' : 'idle')}</div>`).join('')}
      <div id="m-map-detail">${detail(selected ? byId.get(selected) : null)}</div>`
    document.querySelectorAll('[data-entity]').forEach((element) => {
      element.addEventListener('click', () => { selected = element.dataset.entity; document.getElementById('m-map-detail').innerHTML = detail(byId.get(selected)) })
    })
    const tip = document.getElementById('m-map-tip')
    document.querySelectorAll('[data-tip]').forEach((element) => {
      element.addEventListener('mousemove', (event) => {
        tip.innerHTML = element.dataset.tip
        tip.hidden = false
        tip.style.left = `${event.clientX + 14}px`
        tip.style.top = `${event.clientY + 14}px`
      })
      element.addEventListener('mouseleave', () => { tip.hidden = true })
    })
  }

  return {
    section: '火星基地',
    title: '基地地图',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('基地俯视图')}</span><span class="spacer"></span><span class="m-sub" id="m-map-sub"></span></div>
        <div class="m-map-wrap"><section class="card m-map-card"><svg id="m-map-svg" viewBox="-2 -3 62 48" role="img" aria-label="${t('火星基地地图')}"></svg></section>
          <section class="card m-map-panel" id="m-map-side"></section></div>
        <div id="m-map-tip" class="m-tip" hidden></div></div>`
      load(false).then(() => {
        if (document.getElementById('m-map-sub')) document.getElementById('m-map-sub').textContent = t('悬停查看读数，点击锁定详情')
        paint()
      })
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-map') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
