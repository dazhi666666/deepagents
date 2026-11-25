/** Stable world coordinates: a 4 x 3 region grid with one single-lane corridor between preparation and analysis. */
export function marsLayout() {
  const columns = 4
  const regions = [
    { id: 'greenhouse-A', label: '温室 A' }, { id: 'greenhouse-B', label: '温室 B' }, { id: 'greenhouse-C', label: '温室 C' }, { id: 'greenhouse-D', label: '温室 D' },
    { id: 'water', label: '水处理' }, { id: 'preparation', label: '前处理' }, { id: 'analysis', label: '分析' }, { id: 'energy', label: '能源与生命支持' },
    { id: 'cold', label: '保存' }, { id: 'warehouse', label: '仓储维修' }, { id: 'robot-bay', label: '机器人停靠' }, { id: 'quarantine', label: '隔离消毒间' },
  ].map((region, index) => ({ ...region, x: (index % columns) * 15, y: Math.floor(index / columns) * 15, width: 12, height: 10 }))
  const at = (regionId: string, dx: number, dy: number) => {
    const region = regions.find(value => value.id === regionId)!
    return { regionId, x: region.x + dx, y: region.y + dy }
  }
  const anchors = [
    { id: 'incubator-1', ...at('greenhouse-A', 4, 4) }, { id: 'incubator-2', ...at('greenhouse-B', 4, 4) },
    { id: 'incubator-3', ...at('greenhouse-C', 4, 4) }, { id: 'incubator-4', ...at('greenhouse-D', 4, 4) },
    { id: 'reservoir', ...at('water', 2, 3) }, { id: 'filter', ...at('water', 6, 3) }, { id: 'pump', ...at('water', 9, 6) },
    { id: 'liquid-handler', ...at('preparation', 2, 3) }, { id: 'centrifuge-1', ...at('preparation', 6, 3) }, { id: 'centrifuge-2', ...at('preparation', 9, 3) },
    { id: 'heater-1', ...at('preparation', 3, 7) }, { id: 'heater-2', ...at('preparation', 8, 7) },
    { id: 'screen', ...at('analysis', 2, 3) }, { id: 'confirm', ...at('analysis', 7, 3) }, { id: 'imager', ...at('analysis', 2, 7) }, { id: 'analysis', ...at('analysis', 7, 7) },
    { id: 'solar-array', ...at('energy', 3, 3) }, { id: 'battery', ...at('energy', 8, 3) }, { id: 'co2-tank', ...at('energy', 5, 7) },
    { id: 'cold-1', ...at('cold', 2, 3) }, { id: 'cold-2', ...at('cold', 6, 3) }, { id: 'freezer', ...at('cold', 9, 7) },
    { id: 'spares', ...at('warehouse', 5, 5) },
    { id: 'robot-1', ...at('robot-bay', 3, 4) }, { id: 'robot-2', ...at('robot-bay', 8, 4) }, { id: 'robot-3', ...at('robot-bay', 5, 8) },
    { id: 'quarantine-bay', ...at('quarantine', 5, 5) },
  ]
  const nodes = [...anchors.map(anchor => ({ id: anchor.id, x: anchor.x, y: anchor.y })),
    ...regions.map(region => ({ id: `door:${region.id}`, x: region.x + 6, y: region.y + 12 }))]
  const edges = anchors.map(anchor => ({ from: anchor.id, to: `door:${anchor.regionId}` }))
  for (const [index, region] of regions.entries()) {
    if (index % columns < columns - 1) edges.push({ from: `door:${region.id}`, to: `door:${regions[index + 1]!.id}` })
    if (index + columns < regions.length) edges.push({ from: `door:${region.id}`, to: `door:${regions[index + columns]!.id}` })
  }
  return { version: '0.3.0', coordinateSystem: 'world-xy', regions, anchors, nodes, edges,
    corridors: [{ from: 'door:preparation', to: 'door:analysis', lanes: 1 }] }
}
