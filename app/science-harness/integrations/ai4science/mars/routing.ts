/** Deterministic routes with timed exclusive edge and arrival-node reservations. */
import { marsLayout } from './layout.ts'

export interface RouteSegment {
  from: string; to: string; startTick: number; endTick: number
  fromPosition?: { x: number; y: number } | undefined; toPosition?: { x: number; y: number } | undefined
  reservationKey?: string | undefined
}
const edgeKey = (from: string, to: string) => [from, to].sort().join('|')
const overlaps = (start: number, end: number, otherStart: number, otherEnd: number) => start < otherEnd && otherStart < end

/** Find a physically connected route which avoids accepted traffic intervals.
 * @param from Current map node.
 * @param to Destination node.
 * @param startTick Earliest departure.
 * @param traffic Active reserved route segments.
 * @param speed World units per logical tick.
 * @returns A deterministic route or null when all available routes conflict.
 */
export function planRoute(from: string, to: string, startTick: number, traffic: RouteSegment[], speed: number,
  originPosition?: { x: number; y: number }, originEdge?: RouteSegment | null): RouteSegment[] | null {
  const map = marsLayout(), nodes = new Map(map.nodes.map(node => [node.id, node]))
  if (!nodes.has(from) || !nodes.has(to) || speed <= 0) throw new Error('Unknown route node or invalid speed')
  const initial: RouteSegment[] = []
  const origin = nodes.get(from)!
  if (originPosition && (originPosition.x !== origin.x || originPosition.y !== origin.y)) {
    const duration = Math.max(1, Math.ceil(Math.hypot(origin.x - originPosition.x, origin.y - originPosition.y) / speed))
    const reservationKey = originEdge ? originEdge.reservationKey ?? edgeKey(originEdge.from, originEdge.to) : edgeKey(`offset:${from}`, from)
    if (traffic.some(segment =>
      (segment.reservationKey ?? edgeKey(segment.from, segment.to)) === reservationKey && overlaps(startTick, startTick + duration, segment.startTick, segment.endTick) ||
      segment.from === from && segment.to === from && overlaps(startTick, startTick + duration + 1, segment.startTick, segment.endTick))) return null
    initial.push({ from: `offset:${from}`, to: from, startTick, endTick: startTick + duration,
      fromPosition: originPosition, toPosition: { x: origin.x, y: origin.y }, reservationKey })
  }
  const pending = [{ node: from, tick: initial.at(-1)?.endTick ?? startTick, segments: initial }], visited = new Set<string>()
  while (pending.length) {
    pending.sort((a, b) => a.tick - b.tick || a.node.localeCompare(b.node))
    const current = pending.shift()!
    if (current.node === to) return current.segments
    if (visited.has(current.node)) continue
    visited.add(current.node)
    const neighbors = map.edges.flatMap(edge => edge.from === current.node ? [edge.to] : edge.to === current.node ? [edge.from] : []).sort()
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue
      const origin = nodes.get(current.node)!, destination = nodes.get(neighbor)!
      const endTick = current.tick + Math.max(1, Math.ceil(Math.hypot(destination.x - origin.x, destination.y - origin.y) / speed))
      const conflict = traffic.some(segment =>
        (segment.reservationKey ?? edgeKey(segment.from, segment.to)) === edgeKey(current.node, neighbor) && overlaps(current.tick, endTick, segment.startTick, segment.endTick) ||
        segment.from === neighbor && segment.to === neighbor && overlaps(current.tick, endTick + 1, segment.startTick, segment.endTick) ||
        segment.to === neighbor && overlaps(endTick, endTick + 1, segment.endTick, segment.endTick + 1))
      if (!conflict) pending.push({ node: neighbor, tick: endTick, segments: [...current.segments, { from: current.node, to: neighbor, startTick: current.tick, endTick }] })
    }
  }
  return null
}

/** Project a confirmed robot trajectory at a committed logical tick.
 * @param node Last known resting node.
 * @param segments Persisted route.
 * @param tick Confirmed logical tick.
 * @returns Position and most recent reached node.
 */
export function routePosition(node: string, segments: RouteSegment[], tick: number) {
  const nodes = new Map(marsLayout().nodes.map(value => [value.id, value]))
  let current = nodes.get(node)!
  for (const segment of segments) {
    if (tick < segment.startTick) break
    const from = segment.fromPosition ?? nodes.get(segment.from)!, to = segment.toPosition ?? nodes.get(segment.to)!
    if (tick >= segment.endTick) { current = nodes.get(segment.to)!; continue }
    const fraction = (tick - segment.startTick) / (segment.endTick - segment.startTick)
    return { node: nodes.has(segment.from) ? segment.from : segment.to, x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction }
  }
  return { node: current.id, x: current.x, y: current.y }
}
