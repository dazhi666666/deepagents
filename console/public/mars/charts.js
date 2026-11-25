/* Small dependency-free SVG charts for the Mars panel. All inputs are plain numbers from the API. */
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const range = (values) => {
  const numbers = values.filter(finite)
  if (!numbers.length) return [0, 1]
  let low = Math.min(...numbers), high = Math.max(...numbers)
  if (low === high) { low -= 1; high += 1 }
  const pad = (high - low) * 0.08
  return [low - pad, high + pad]
}
const scaled = (value, low, high, from, to) => from + (value - low) / (high - low || 1) * (to - from)
const ticks = (low, high, count = 4) => Array.from({ length: count + 1 }, (_, index) => low + (high - low) * index / count)

/** Line chart with optional night bands, reference lines and a right-hand axis.
 * @param {object} options Series are `{ name, color, points: [[x, y|null]], dashed, axis }`.
 * @returns {string} SVG markup.
 */
export function lineChart(options) {
  const width = options.width ?? 720, height = options.height ?? 220
  const series = (options.series ?? []).map((item) => ({ ...item, points: item.points.filter(([x, y]) => finite(x) && finite(y)) }))
  const all = series.flatMap((item) => item.points)
  if (!all.length) return '<div class="mars-empty">没有数据</div>'
  const [xLowDefault, xHighDefault] = range(all.map(([x]) => x))
  const xLow = options.xMin ?? xLowDefault, xHigh = options.xMax ?? xHighDefault
  const left = series.filter((item) => item.axis !== 'right')
  const [yLowDefault, yHighDefault] = range(left.flatMap((item) => item.points.map(([, y]) => y)))
  const yLow = options.yMin ?? yLowDefault, yHigh = options.yMax ?? yHighDefault
  const rightSeries = series.filter((item) => item.axis === 'right')
  const [rightLowDefault, rightHighDefault] = range(rightSeries.flatMap((item) => item.points.map(([, y]) => y)))
  const rightLow = options.rightMin ?? rightLowDefault, rightHigh = options.rightMax ?? rightHighDefault
  const pad = { left: 48, right: rightSeries.length ? 52 : 16, top: 12, bottom: 24 }
  const x = (value) => scaled(value, xLow, xHigh, pad.left, width - pad.right)
  const y = (value, axis) => scaled(value, axis === 'right' ? rightLow : yLow, axis === 'right' ? rightHigh : yHigh, height - pad.bottom, pad.top)
  const fmt = options.yFormat ?? ((value) => Math.abs(value) >= 100 ? Math.round(value) : Number(value.toFixed(1)))
  const xfmt = options.xFormat ?? ((value) => String(Math.round(value)))
  const bands = (options.bands ?? []).map((band) => `<rect x="${x(band.from).toFixed(1)}" y="${pad.top}" width="${Math.max(0, x(band.to) - x(band.from)).toFixed(1)}" height="${height - pad.top - pad.bottom}" fill="${band.color ?? 'rgba(120,140,255,.08)'}"><title>${band.label ?? ''}</title></rect>`).join('')
  const grid = ticks(yLow, yHigh).map((value) => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" class="m-grid"/><text x="${pad.left - 7}" y="${(y(value) + 3).toFixed(1)}" text-anchor="end" class="m-axis">${fmt(value)}</text>`).join('')
  const xgrid = (options.xTicks ?? ticks(xLow, xHigh, 4)).map((value) => `<text x="${x(value).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="m-axis">${xfmt(value)}</text>`).join('')
  const refs = (options.refs ?? []).map((ref) => ref.axis === 'right'
    ? `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(ref.y, 'right').toFixed(1)}" y2="${y(ref.y, 'right').toFixed(1)}" stroke="${ref.color ?? 'var(--red)'}" stroke-dasharray="5 4" class="m-ref"/>`
    : `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(ref.y).toFixed(1)}" y2="${y(ref.y).toFixed(1)}" stroke="${ref.color ?? 'var(--red)'}" stroke-dasharray="5 4" class="m-ref"><title>${ref.label ?? ''}</title></line>`).join('')
  const xrefs = (options.xRefs ?? []).map((ref) => `<line x1="${x(ref.x).toFixed(1)}" x2="${x(ref.x).toFixed(1)}" y1="${pad.top}" y2="${height - pad.bottom}" stroke="${ref.color ?? 'var(--dim)'}" stroke-dasharray="4 4" class="m-ref"><title>${ref.label ?? ''}</title></line>`).join('')
  const paths = series.map((item) => {
    const points = item.points.map(([px, py]) => `${x(px).toFixed(1)},${y(py, item.axis).toFixed(1)}`).join(' ')
    return `<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="${item.width ?? 1.8}" stroke-linejoin="round" stroke-linecap="round"${item.dashed ? ' stroke-dasharray="6 4"' : ''}/>`
  }).join('')
  const rightAxis = rightSeries.length
    ? ticks(rightLow, rightHigh).map((value) => `<text x="${width - pad.right + 7}" y="${(y(value, 'right') + 3).toFixed(1)}" class="m-axis">${Number(value.toFixed(1))}</text>`).join('')
    : ''
  return `<svg viewBox="0 0 ${width} ${height}" class="m-chart" role="img">${bands}<g>${grid}${xgrid}${rightAxis}</g>${refs}${xrefs}${paths}</svg>`
}

export function legend(series) {
  return `<div class="m-legend">${series.map((item) => `<span><i style="background:${item.color}"></i>${item.name}</span>`).join('')}</div>`
}

/** Compact sparkline for cards. */
export function sparkline(values, color = 'var(--accent)', width = 140, height = 34) {
  const points = values.filter(finite)
  if (points.length < 2) return '<span class="muted">–</span>'
  const [low, high] = range(points)
  const step = points.length > 1 ? (width - 4) / (points.length - 1) : 0
  const path = points.map((value, index) => `${(2 + index * step).toFixed(1)},${(height - 2 - (value - low) / (high - low) * (height - 4)).toFixed(1)}`).join(' ')
  return `<svg viewBox="0 0 ${width} ${height}" class="m-spark" aria-hidden="true"><polyline points="${path}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`
}

/** Single-band heatmap; values are a rectangular matrix. */
export function heatmap(matrix, options = {}) {
  if (!matrix?.length || !matrix[0]?.length) return '<div class="mars-empty">没有数据</div>'
  const rows = matrix.length, columns = matrix[0].length
  const values = matrix.flat().filter(finite)
  const [low, high] = options.min !== undefined && options.max !== undefined ? [options.min, options.max] : range(values)
  const cell = options.cell ?? 14, gap = 1
  const color = (value) => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low || 1)))
    const from = options.from ?? [18, 30, 52], to = options.to ?? [255, 170, 90]
    return `rgb(${Math.round(from[0] + (to[0] - from[0]) * t)},${Math.round(from[1] + (to[1] - from[1]) * t)},${Math.round(from[2] + (to[2] - from[2]) * t)})`
  }
  const cells = matrix.map((row, y) => row.map((value, x) => `<rect x="${x * (cell + gap)}" y="${y * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${color(value)}"><title>${y},${x}: ${Number(value).toFixed(3)}</title></rect>`).join('')).join('')
  return `<svg viewBox="0 0 ${columns * (cell + gap)} ${rows * (cell + gap)}" class="m-heat" role="img">${cells}</svg>`
}

/** Normalise a matrix to 0..1. */
export function normalize(matrix) {
  const values = matrix.flat().filter(finite)
  if (!values.length) return matrix
  const low = Math.min(...values), high = Math.max(...values)
  return matrix.map((row) => row.map((value) => finite(value) ? (value - low) / (high - low || 1) : 0))
}

/** b6 / b4 ratio view used for lesions. */
export function ratioMatrix(cube) {
  const b4 = cube.data[3], b6 = cube.data[5]
  return b6.map((row, y) => row.map((value, x) => value / (b4[y][x] || 1e-9)))
}
