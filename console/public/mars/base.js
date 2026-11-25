/* 基地沙盘：整页只放火星基地的等距动画，读数来自 Mission Control 的 Mars 代理。 */
import { MarsScene, mapMarsSnapshot } from './vendor/mars-scene.js'
import { STATUS_LABEL } from './common.js'

const LAYERS = [
  ['status', '运行状态'],
  ['logistics', '样品物流'],
  ['utilities', '能源水路'],
  ['risk', '风险范围'],
]

export function createBase(ctx) {
  const { api, t, esc, state } = ctx
  const rootId = 'mars-base-root'
  let scene = null
  let stageElement = null
  let snapshot = null
  let mappedSnapshot = null
  let busy = false
  let selected = null
  let layer = 'status'
  let followId = null
  let readouts = false

  async function load(force) {
    if (busy) return
    busy = true
    try {
      snapshot = await api.snapshot(force)
      const error = document.getElementById('mars-base-error')
      if (error) error.hidden = true
    } catch (caught) {
      const error = document.getElementById('mars-base-error')
      if (error) {
        error.hidden = false
        error.textContent = caught instanceof Error ? caught.message : String(caught)
      }
      const loading = document.getElementById('mars-base-loading')
      if (loading) loading.hidden = true
    } finally {
      busy = false
    }
  }

  function paint() {
    if (!scene || !snapshot || state.view !== 'mars-base') return
    let mapped
    try {
      mapped = mapMarsSnapshot(snapshot)
      mappedSnapshot = mapped
    } catch (caught) {
      const error = document.getElementById('mars-base-error')
      if (error) {
        error.hidden = false
        error.textContent = caught instanceof Error ? caught.message : String(caught)
      }
      const loading = document.getElementById('mars-base-loading')
      if (loading) loading.hidden = true
      return
    }
    scene.setState(mapped, Number(snapshot.tick ?? 0), selected, layer, followId)
    paintFollow(mapped)
    paintReadout(mapped)
    const loading = document.getElementById('mars-base-loading')
    if (loading) loading.hidden = true
  }

  function paintReadout(mapped = mappedSnapshot) {
    const readout = document.getElementById('mars-base-readout')
    if (!readout || !mapped) return
    const tick = String(mapped.tick ?? 0).padStart(3, '0')
    const statusKey = { attention: 'attention-required', failed: 'agent-ended' }[mapped.status] ?? mapped.status
    const status = t(STATUS_LABEL[statusKey] ?? mapped.status)
    const zoom = scene ? scene.zoomLabel : '100%'
    readout.innerHTML = `<i class="lot live"></i><span>${t('T+{tick}', { tick })}</span><span class="sep">·</span><span>${esc(status)}</span><span class="sep">·</span><span class="zoom">${zoom}</span>`
  }

  function paintFollow(mapped) {
    const select = document.getElementById('mars-base-follow')
    if (!select) return
    const robots = mapped.entities.filter((entity) => entity.kind === 'robot')
    const signature = robots.map((robot) => robot.id).join(',')
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature
      select.innerHTML = `<option value="">${t('自由镜头')}</option>` +
        robots.map((robot) => `<option value="${esc(robot.id)}">${esc(t('跟随 {name}', { name: robot.name }))}</option>`).join('')
      select.value = followId ?? ''
    }
  }

  function setZoom(factor) {
    scene?.zoomBy(factor)
    paintReadout()
  }

  function mount(stage) {
    stageElement = stage
    stage.classList.add('mars-base-stage')
    stage.innerHTML = `<div id="${rootId}" class="mars-base">
      <div class="mars-base-scene" id="mars-base-scene">
        <canvas id="mars-base-canvas" role="img" aria-label="${t('火星基地等距动画')}"></canvas>
      </div>
      <div class="mars-base-tools" role="toolbar" aria-label="${t('基地沙盘控制')}">
        <div class="mars-base-seg" role="group" aria-label="${t('图层')}">
          ${LAYERS.map(([value, label]) => `<button type="button" data-base-layer="${value}" class="${value === layer ? 'on' : ''}">${t(label)}</button>`).join('')}
        </div>
        <button type="button" class="mars-base-toggle ${readouts ? 'on' : ''}" data-base-readouts aria-pressed="${readouts}" title="${t(readouts ? '隐藏全部读数' : '显示全部读数')}">${t('读数')}</button>
        <button type="button" class="mars-base-icon" data-base-zoom="out" title="${t('缩小')}" aria-label="${t('缩小')}">−</button>
        <button type="button" class="mars-base-icon" data-base-zoom="in" title="${t('放大')}" aria-label="${t('放大')}">+</button>
        <button type="button" class="mars-base-icon" data-base-fit title="${t('适配全景')}" aria-label="${t('适配全景')}">⤢</button>
        <button type="button" class="mars-base-icon" data-base-full title="${t('全屏')}" aria-label="${t('全屏')}">⛶</button>
        <select id="mars-base-follow" aria-label="${t('跟随机器人')}"><option value="">${t('自由镜头')}</option></select>
      </div>
      <div class="mars-base-readout" id="mars-base-readout">${t('连接基地…')}</div>
      <div class="mars-base-legend">
        <span><i class="lot green"></i>${t('正常')}</span>
        <span><i class="lot amber"></i>${t('受压 / 等待')}</span>
        <span><i class="lot red"></i>${t('失败 / 损失')}</span>
        <span><i class="lot gray"></i>${t('待机')}</span>
      </div>
      <div class="mars-base-loading" id="mars-base-loading">${t('连接基地…')}</div>
      <div class="mars-base-error" id="mars-base-error" hidden></div>
    </div>`

    const canvas = document.getElementById('mars-base-canvas')
    const container = document.getElementById('mars-base-scene')
    scene = new MarsScene(canvas, container, {
      tooltips: false,
      hoverLabels: false,
      onSelect: (kind, id) => {
        selected = id
        scene?.setSelected(id)
      },
      onBackground: () => {
        selected = null
        scene?.setSelected(null)
      },
    })
    scene.setReadouts(readouts)

    document.querySelectorAll('[data-base-layer]').forEach((button) => {
      button.addEventListener('click', () => {
        layer = button.dataset.baseLayer
        document.querySelectorAll('[data-base-layer]').forEach((item) => item.classList.toggle('on', item === button))
        scene?.setLayer(layer)
      })
    })
    document.querySelectorAll('[data-base-zoom]').forEach((button) => {
      button.addEventListener('click', () => setZoom(button.dataset.baseZoom === 'in' ? 1.22 : 1 / 1.22))
    })
    document.querySelector('[data-base-readouts]')?.addEventListener('click', (event) => {
      readouts = !readouts
      const button = event.currentTarget
      button.classList.toggle('on', readouts)
      button.setAttribute('aria-pressed', String(readouts))
      button.title = t(readouts ? '隐藏全部读数' : '显示全部读数')
      scene?.setReadouts(readouts)
    })
    document.querySelector('[data-base-fit]')?.addEventListener('click', () => {
      followId = null
      const select = document.getElementById('mars-base-follow')
      if (select) select.value = ''
      scene?.fitView()
      paintReadout()
    })
    document.getElementById('mars-base-follow')?.addEventListener('change', (event) => {
      followId = event.target.value || null
      scene?.setFollow(followId)
    })
    document.querySelector('[data-base-full]')?.addEventListener('click', () => {
      const root = document.getElementById(rootId)
      if (!root) return
      if (document.fullscreenElement) document.exitFullscreen?.()
      else root.requestFullscreen?.()
    })

    void load(false).then(paint)
  }

  function destroy() {
    scene?.destroy()
    scene = null
    snapshot = null
    mappedSnapshot = null
    if (stageElement) stageElement.classList.remove('mars-base-stage')
    stageElement = null
  }

  return {
    section: '火星基地',
    title: '基地沙盘',
    mount,
    destroy,
    update(kind) {
      if (document.hidden || state.view !== 'mars-base' || !scene) return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
