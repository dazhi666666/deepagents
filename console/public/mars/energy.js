/* 能源与大气：最近 4 sol 的发电/需求/SOC、沙尘、限电优先级、四舱大气与备件。 */
import { SOL_TICKS, badge, empty, n } from './common.js'
import { legend, lineChart } from './charts.js'

const TIER_ONE = ['incubator-1', 'incubator-2', 'incubator-3', 'incubator-4', 'cold-1', 'cold-2', 'freezer', 'robot-2']
const CO2_TANK_INITIAL = 12000

export function createEnergy(ctx) {
  const { api, t, esc, state } = ctx
  const rootId = 'mars-energy-root'
  let busy = false
  let data = { snapshot: null, energy: null, atmosphere: null }

  async function load(force) {
    if (busy) return
    busy = true
    try {
      const snapshot = await api.snapshot(force)
      const now = snapshot.tick ?? 0
      const from = Math.max(0, now - 4 * SOL_TICKS)
      const [energy, atmosphere] = await Promise.all([
        api.telemetry(['energy.solar', 'energy.demand', 'energy.soc', 'energy.tau_dust'], from, now, 600),
        api.telemetry(['incubator-1.co2', 'incubator-2.co2', 'incubator-3.co2', 'incubator-4.co2',
          'incubator-1.pressure', 'incubator-2.pressure', 'incubator-3.pressure', 'incubator-4.pressure'],
        Math.max(0, now - 200), now, 300),
      ])
      data = { snapshot, energy, atmosphere }
    } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  const points = (series, channel) => (series?.[channel] ?? []).map(([tick, value]) => [tick, value])

  function paint() {
    if (!data.snapshot || !document.getElementById('m-energy-main') || state.view !== 'mars-energy') return
    const { snapshot, energy, atmosphere } = data
    const sensors = snapshot.sensors ?? {}, current = sensors.energy ?? {}
    const now = snapshot.tick ?? 0
    const bands = []
    for (let sol = Math.floor((now - 4 * SOL_TICKS) / SOL_TICKS); sol <= Math.floor(now / SOL_TICKS); sol++) {
      const from = sol * SOL_TICKS + SOL_TICKS / 2, to = (sol + 1) * SOL_TICKS
      if (from <= now) bands.push({ from, to: Math.min(to, now), color: 'rgba(80,110,200,.08)', label: t('夜间') })
    }
    const series = [
      { name: t('太阳能'), color: '#f3b64c', points: points(energy, 'energy.solar') },
      { name: t('需求'), color: '#ef7d6b', points: points(energy, 'energy.demand') },
      { name: t('电池 SOC'), color: '#38e1ff', points: points(energy, 'energy.soc'), axis: 'right' },
    ]
    document.getElementById('m-energy-main').innerHTML = lineChart({ series, bands, xMin: Math.max(0, now - 4 * SOL_TICKS), xMax: now, yMin: 0, rightMin: 0, rightMax: 800 }) + legend(series)
    document.getElementById('m-energy-dust').innerHTML = lineChart({
      width: 720, height: 130, series: [{ name: 'τ_dust', color: '#c084fc', points: points(energy, 'energy.tau_dust') }],
      refs: [{ y: 1.0, color: '#ef6b6b', label: t('沙尘预警') }], xMin: Math.max(0, now - 4 * SOL_TICKS), xMax: now,
    })
    const exceed = (energy?.['energy.tau_dust'] ?? []).some(([, value]) => value !== null && value > 1)
    document.getElementById('m-dust-sub').textContent = exceed ? t('沙尘预警：τ_dust 已超过 1.0') : t('τ_dust 正常')

    const shed = current.shed ?? [], priority = current.priority ?? [], shedTicks = current.shedTicksByLoad ?? {}
    document.getElementById('m-shed').innerHTML = `
      <div class="m-kv"><span>${t('当前限电负载')}</span><b>${shed.length ? shed.join('、') : t('无')}</b>
        <span>${t('一级负载被切断')}</span><b>${shed.some((id) => TIER_ONE.includes(id)) ? t('是') : t('否')}</b>
        <span>${t('累计一级限电步')}</span><b>${n(current.tierOneShedTicks, 0)}</b></div>
      <table class="m-table"><thead><tr><th>${t('优先级')}</th><th>${t('负载')}</th><th>${t('累计被切步数')}</th><th>${t('当前')}</th></tr></thead><tbody>
        ${priority.map((id, index) => `<tr class="${TIER_ONE.includes(id) ? 'tier-one' : ''}"><td>${index + 1}</td><td>${esc(id)}${TIER_ONE.includes(id) ? ' · ' + t('一级') : ''}</td><td>${n(shedTicks[id] ?? 0, 0)}</td><td>${shed.includes(id) ? badge(t('已切断'), 'bad') : badge(t('供电'), 'idle')}</td></tr>`).join('')}
      </tbody></table>`

    const chambers = sensors.chambers ?? []
    document.getElementById('m-atmos').innerHTML = chambers.map((chamber) => {
      const co2 = (atmosphere?.[`${chamber.id}.co2`] ?? []).map(([tick, value]) => [tick, value])
      const pressure = (atmosphere?.[`${chamber.id}.pressure`] ?? []).map(([tick, value]) => [tick, value])
      return `<div class="m-mini"><div class="m-mini-head"><b>${esc(chamber.id)}</b><span>${n(chamber.co2, 0)} ppm · ${n(chamber.pressure, 2)} kPa${chamber.quarantine ? ' · ' + t('隔离') : ''}</span></div>
        ${lineChart({ width: 340, height: 110, series: [{ name: 'CO₂', color: '#38e1ff', points: co2 }, { name: t('气压'), color: '#f3b64c', points: pressure, axis: 'right' }], xMin: Math.max(0, now - 200), xMax: now })}</div>`
    }).join('')
    const tank = sensors.co2TankUnits ?? 0
    document.getElementById('m-tank').innerHTML = `<div class="m-kpi-head"><span>${t('CO₂ 储罐余量')}</span><b>${n(tank, 0)} <small>/ ${CO2_TANK_INITIAL}</small></b></div>
      <div class="m-bar"><i style="width:${Math.max(0, Math.min(100, tank / CO2_TANK_INITIAL * 100))}%"></i></div>`
    const spares = sensors.spares ?? {}
    document.getElementById('m-spares').innerHTML = `<table class="m-table"><thead><tr><th>${t('备件')}</th><th>${t('剩余')}</th></tr></thead><tbody>
      ${Object.entries(spares).map(([id, value]) => `<tr><td>${esc(id)}</td><td>${n(value, 0)}</td></tr>`).join('')}</tbody></table>`
  }

  return {
    section: '火星基地',
    title: '能源与大气',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('能源与大气')}</span><span class="spacer"></span><span class="m-sub">${t('最近 4 个 sol')}</span></div>
        <section class="card"><div class="card-head"><span class="card-title">${t('发电 · 需求 · 电池')}</span><span class="spacer"></span><span class="m-sub" id="m-dust-sub"></span></div><div id="m-energy-main"></div></section>
        <section class="card"><div class="card-head"><span class="card-title">${t('沙尘光学厚度')}</span><span class="spacer"></span><span class="m-sub">${t('次轴参考线 1.0')}</span></div><div id="m-energy-dust"></div></section>
        <div class="m-two"><section class="card"><div class="card-head"><span class="card-title">${t('限电与优先级')}</span><span class="spacer"></span><span class="m-sub">${t('只读')}</span></div><div id="m-shed"></div></section>
          <section class="card"><div class="card-head"><span class="card-title">${t('CO₂ 储罐')}</span></div><div id="m-tank"></div><div class="card-head" style="margin-top:14px"><span class="card-title">${t('备件库存')}</span></div><div id="m-spares"></div></section></div>
        <section class="card"><div class="card-head"><span class="card-title">${t('四舱大气')}</span><span class="spacer"></span><span class="m-sub">${t('最近 200 步')}</span></div><div class="m-grid2" id="m-atmos"></div></section>
      </div>`
      load(false).then(paint)
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-energy') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
