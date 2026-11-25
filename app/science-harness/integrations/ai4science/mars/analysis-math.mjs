/** Public instrument peak fitting shared by both analysis workers. */
export const SPECTRUM_PEAKS = [[5.1, 0.12], [5.4, 0.15], [7.8, 0.2]]
export function chromatogram(input) {
  const raw = input && input.raw && Array.isArray(input.raw.points) ? input.raw : input
  if (!raw || !Array.isArray(raw.points)) throw new Error('chromatogram() needs a raw chromatogram: readRaw("r-N") or its .raw')
  const points = raw.points, dtMinutes = raw.dtMinutes ?? 0.02, size = SPECTRUM_PEAKS.length + 2
  const normal = new Float64Array(size * size), target = new Float64Array(size), row = new Float64Array(size)
  points.forEach((value, index) => {
    const t = index * dtMinutes
    SPECTRUM_PEAKS.forEach(([center, width], peak) => { row[peak] = Math.exp(-0.5 * ((t - center) / width) ** 2) / (width * Math.sqrt(2 * Math.PI)) })
    row[size - 2] = 1; row[size - 1] = t
    for (let i = 0; i < size; i++) {
      target[i] = target[i] + row[i] * value
      for (let j = 0; j < size; j++) normal[i * size + j] = normal[i * size + j] + row[i] * row[j]
    }
  })
  for (let column = 0; column < size; column++) {
    let pivot = column
    for (let r = column + 1; r < size; r++) if (Math.abs(normal[r * size + column]) > Math.abs(normal[pivot * size + column])) pivot = r
    for (let j = 0; j < size; j++) { const swap = normal[column * size + j]; normal[column * size + j] = normal[pivot * size + j]; normal[pivot * size + j] = swap }
    const swap = target[column]; target[column] = target[pivot]; target[pivot] = swap
    for (let r = column + 1; r < size; r++) {
      const factor = normal[r * size + column] / normal[column * size + column]
      for (let j = column; j < size; j++) normal[r * size + j] = normal[r * size + j] - factor * normal[column * size + j]
      target[r] = target[r] - factor * target[column]
    }
  }
  const solution = new Float64Array(size)
  for (let r = size - 1; r >= 0; r--) {
    let sum = target[r]
    for (let j = r + 1; j < size; j++) sum -= normal[r * size + j] * solution[j]
    solution[r] = sum / normal[r * size + r]
  }
  const round = value => Number(value.toFixed(4))
  return { doc: round(solution[0] / 0.1), lubricant: round(solution[1] / 0.1), internalStandard: round(solution[2]) }
}
