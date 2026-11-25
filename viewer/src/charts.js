import { esc, num, table, empty } from './dom.js'

const COLORS = ['#3987e5', '#d95926']
function thinPoints(points, limit = 1800) {
  if (points.length <= limit) return points
  const result = [], stride = Math.ceil(points.length / (limit / 4))
  for (let i = 0; i < points.length; i += stride) {
    const batch = points.slice(i, i + stride), valid = batch.filter(p => p[1] !== null)
    if (!valid.length) { result.push(batch[0]); continue }
    const min = valid.reduce((a, b) => a[1] < b[1] ? a : b), max = valid.reduce((a, b) => a[1] > b[1] ? a : b)
    const indexes = [...new Set([i, i + batch.length - 1, i + batch.indexOf(min), i + batch.indexOf(max), ...(batch.some(p => p[1] === null) ? [i + batch.findIndex(p => p[1] === null)] : [])])].sort((a, b) => a - b)
    for (const j of indexes) result.push(points[j])
  }
  return result
}
/** One axis per unit; gaps remain gaps. Exact values remain available in the table and hover layer. */
export function lineChart({ title, series, xLabel = 'tick', unit = '', zero = false }) {
  const used = series.filter(s => s.points?.length).slice(0, 2)
  const all = used.flatMap(s => s.points).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (!all.length) return empty(`${title}没有可用测量。`)
  const width = 720, height = 245, pad = { left: 62, right: 22, top: 25, bottom: 40 }
  const xmin = Math.min(...all.map(p => p[0])), xmax = Math.max(...all.map(p => p[0]))
  const low = Math.min(...all.map(p => p[1])), high = Math.max(...all.map(p => p[1])), span = high - low || Math.abs(high) * .1 || 1
  const ymin = zero ? Math.min(0, low) : low - span * .1, ymax = high + span * .1
  const px = x => pad.left + (x - xmin) / (xmax - xmin || 1) * (width - pad.left - pad.right), py = y => height - pad.bottom - (y - ymin) / (ymax - ymin || 1) * (height - pad.top - pad.bottom)
  let svg = ''
  for (let i = 0; i <= 4; i++) {
    const value = ymin + (ymax - ymin) * i / 4, y = py(value)
    svg += `<path d="M${pad.left} ${y}H${width - pad.right}" stroke="#69828b" stroke-opacity=".24"/><text x="${pad.left - 10}" y="${y + 4}" text-anchor="end">${num(value)}</text>`
    const xValue = xmin + (xmax - xmin) * i / 4, x = px(xValue)
    svg += `<text x="${x}" y="${height - 15}" text-anchor="middle">${num(xValue, 1)}</text>`
  }
  used.forEach((s, i) => {
    let d = '', gap = true
    for (const [x, y] of thinPoints(s.points)) {
      if (!Number.isFinite(y)) { gap = true; continue }
      d += `${gap ? 'M' : 'L'}${px(x).toFixed(2)},${py(y).toFixed(2)} `; gap = false
    }
    svg += `<path d="${d}" fill="none" stroke="${COLORS[i]}" stroke-width="2" vector-effect="non-scaling-stroke"/>`
    const last = s.points.findLast(p => Number.isFinite(p[1]))
    if (last) svg += `<circle cx="${px(last[0])}" cy="${py(last[1])}" r="4" fill="${COLORS[i]}" stroke="#243c46" stroke-width="2"/>`
  })
  const packed = esc(JSON.stringify(used.map((s, i) => ({ name: s.name, color: COLORS[i], points: s.points }))))
  const rows = [...new Set(used.flatMap(s => s.points.map(p => p[0])))].sort((a, b) => a - b)
  const dataMaps = used.map(s => new Map(s.points))
  return `<figure class="chart" data-chart="${packed}" data-chart-xmin="${xmin}" data-chart-xmax="${xmax}" data-unit="${esc(unit)}"><figcaption>${esc(title)}${unit ? `<span>${esc(unit)}</span>` : ''}</figcaption><div class="chart-legend">${used.map((s, i) => `<span><i style="background:${COLORS[i]}"></i>${esc(s.name)}</span>`).join('')}</div><div class="chart-plot"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}，${esc(xLabel)} 横轴，${esc(unit)} 纵轴">${svg}<path class="chart-crosshair" d="M0 25V205" hidden/><rect class="chart-hit" x="62" y="25" width="636" height="180" fill="transparent"/></svg><output class="chart-tooltip" hidden></output></div><p class="chart-axis-label">${esc(xLabel)}；缺测保留空档</p><details><summary>数据表（${rows.length} 个位置）</summary>${table([xLabel, ...used.map(s => `${s.name}${unit ? ` / ${unit}` : ''}`)], rows.map(x => [num(x, 2), ...dataMaps.map(m => m.get(x) === null ? '缺测' : num(m.get(x), 4))]))}</details></figure>`
}
export function heatmap(matrix, title) {
  if (!Array.isArray(matrix) || !matrix.length || !matrix.every(row => Array.isArray(row))) return empty('光谱矩阵格式无效。')
  const rows = matrix.length, cols = Math.max(...matrix.map(row => row.length)), values = matrix.flat().filter(Number.isFinite)
  if (!values.length || rows * cols > 65536) return empty('矩阵为空或超过可展示范围。')
  const min = Math.min(...values), max = Math.max(...values), cell = Math.min(26, 560 / cols), width = cols * cell, height = rows * cell
  const color = value => {
    const f = (value - min) / (max - min || 1), a = [62, 100, 121], b = [185, 229, 230]
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',')})`
  }
  const cells = matrix.flatMap((row, y) => row.map((value, x) => `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${Number.isFinite(value) ? color(value) : '#304e59'}"><title>行 ${y + 1}，列 ${x + 1}：${Number.isFinite(value) ? num(value, 5) : '缺测'}</title></rect>`)).join('')
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption><div class="heatmap-wrap"><svg viewBox="0 0 ${width} ${height}" width="${Math.max(240, width)}" role="img" aria-label="${esc(title)}；颜色由深到浅表示数值增加">${cells}</svg></div><p class="source-note">深 → 浅：${num(min, 4)} → ${num(max, 4)}；${rows} 行 × ${cols} 列。悬停查看单元值。</p><details><summary>矩阵数据表</summary>${table(['行 / 列', ...Array.from({ length: cols }, (_, i) => i + 1)], matrix.map((row, i) => [i + 1, ...row.map(v => Number.isFinite(v) ? num(v, 5) : '缺测')]))}</details></figure>`
}
export function bindCharts(root) {
  for (const figure of root.querySelectorAll('[data-chart]')) {
    const series = JSON.parse(figure.dataset.chart), plot = figure.querySelector('.chart-plot'), hit = figure.querySelector('.chart-hit'), tooltip = figure.querySelector('.chart-tooltip'), hair = figure.querySelector('.chart-crosshair')
    const xmin = Number(figure.dataset.chartXmin), xmax = Number(figure.dataset.chartXmax)
    const show = event => {
      const box = plot.getBoundingClientRect(), fraction = Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * 720 - 62) / 636)), x = xmin + fraction * (xmax - xmin)
      const closest = s => s.points.reduce((a, p) => Math.abs(p[0] - x) < Math.abs(a[0] - x) ? p : a, s.points[0])
      const entries = series.map(s => ({ name: s.name, point: closest(s) }))
      tooltip.textContent = entries.map(e => `${e.name}: ${e.point[1] == null ? '缺测' : num(e.point[1], 4)} ${figure.dataset.unit} (${num(e.point[0], 2)})`).join('；')
      tooltip.hidden = false; tooltip.style.left = `${Math.min(box.width - Math.min(320, box.width - 20), Math.max(5, event.clientX - box.left + 12))}px`
      hair.removeAttribute('hidden'); hair.setAttribute('d', `M${62 + fraction * 636} 25V205`)
    }
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerleave', () => { tooltip.hidden = true; hair.setAttribute('hidden', '') })
  }
}
