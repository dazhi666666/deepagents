/** Public v0.3 physical layout, migrated from app/.../mars/layout.ts. No world or evaluator dependency. */
export function marsLayout() {
  const regions = [
    ['greenhouse-A', '温室 A'], ['greenhouse-B', '温室 B'], ['greenhouse-C', '温室 C'], ['greenhouse-D', '温室 D'],
    ['water', '水处理'], ['preparation', '前处理'], ['analysis', '分析区'], ['energy', '能源与生命支持'],
    ['cold', '保存区'], ['warehouse', '仓储维修'], ['robot-bay', '机器人停靠'], ['quarantine', '隔离消毒'],
  ].map(([id, label], index) => ({ id, label, x: index % 4 * 15, y: Math.floor(index / 4) * 15, width: 12, height: 10 }))
  const anchors = []
  const add = (regionId, entries) => {
    const region = regions.find(r => r.id === regionId)
    for (const [id, dx, dy] of entries) anchors.push({ id, regionId, x: region.x + dx, y: region.y + dy })
  }
  for (let i = 0; i < 4; i++) add(`greenhouse-${'ABCD'[i]}`, [[`incubator-${i + 1}`, 4, 4]])
  add('water', [['reservoir', 2, 3], ['filter', 6, 3], ['pump', 9, 6]])
  add('preparation', [['liquid-handler', 2, 3], ['centrifuge-1', 6, 3], ['centrifuge-2', 9, 3], ['heater-1', 3, 7], ['heater-2', 8, 7]])
  add('analysis', [['screen', 2, 3], ['confirm', 7, 3], ['imager', 2, 7], ['analysis', 7, 7]])
  add('energy', [['solar-array', 3, 3], ['battery', 8, 3], ['co2-tank', 5, 7]])
  add('cold', [['cold-1', 2, 3], ['cold-2', 6, 3], ['freezer', 9, 7]])
  add('warehouse', [['spares', 5, 5]])
  add('robot-bay', [['robot-1', 3, 4], ['robot-2', 8, 4], ['robot-3', 5, 8]])
  add('quarantine', [['quarantine-bay', 5, 5]])
  const nodes = [...anchors.map(({ id, x, y }) => ({ id, x, y })), ...regions.map(r => ({ id: `door:${r.id}`, x: r.x + 6, y: r.y + 12 }))]
  const edges = anchors.map(a => ({ from: a.id, to: `door:${a.regionId}` }))
  regions.forEach((r, i) => {
    if (i % 4 < 3) edges.push({ from: `door:${r.id}`, to: `door:${regions[i + 1].id}` })
    if (i + 4 < regions.length) edges.push({ from: `door:${r.id}`, to: `door:${regions[i + 4].id}` })
  })
  return { version: '0.3.0', coordinateSystem: 'world-xy', regions, anchors, nodes, edges, corridors: [{ from: 'door:preparation', to: 'door:analysis', lanes: 1 }] }
}

export const DEVICE_NAMES = {
  'liquid-handler': '自动分液站', 'centrifuge-1': '离心机 1', 'centrifuge-2': '离心机 2',
  'heater-1': '恒温台 1', 'heater-2': '恒温台 2', screen: '筛查仪', confirm: '确认仪', imager: '成像台', analysis: '分析工作台',
  reservoir: '储水罐', filter: '过滤单元', pump: '水泵', 'cold-1': '冷藏柜 1', 'cold-2': '冷藏柜 2', freezer: '冷冻柜',
  'robot-1': 'R1 运输机器人', 'robot-2': 'R2 冷链机器人', 'robot-3': 'R3 维护机器人',
  'solar-array': '太阳能阵列', battery: '储能电池', 'co2-tank': '二氧化碳罐', spares: '备件仓', 'quarantine-bay': '隔离消毒间',
  'incubator-1': '温室 A 控制台', 'incubator-2': '温室 B 控制台', 'incubator-3': '温室 C 控制台', 'incubator-4': '温室 D 控制台',
}
export const ACTION_NAMES = {
  aliquot: '分液', process: '样品处理', transfer: '运输样品', clean: '清洗', repair: '维修', calibrate: '校准', configure: '设置器材',
  refill: '补水', order: '订购耗材', sample: '采样', scan: '温室扫描', move: '移动', light: '调节光照', irrigate: '灌溉', charge: '充电',
  co2: '调节二氧化碳', nutrient: '调整营养', quarantine: '隔离', crop_remove: '移除植株', water_route: '切换水源', power_priority: '设置供电优先级', panel_clean: '清洁太阳能板', seal_inspect: '检查密封', seal_repair: '修复密封', device_service: '设备保养', robot_sanitize: '机器人消毒', sensor_calibrate: '传感器校准', device_reference: '现场参考测量',
}
export const PHASE_NAMES = { idle: '待机', unknown: '状态未记录', loading: '正在装载', processing: '处理中', maintenance: '维护中', moving: '运输中', completed: '操作完成', failed: '操作失败', cancelled: '已取消', blocked: '受阻' }
export const PHASE_ICONS = { idle: 'Ⅱ', unknown: '?', loading: '↘', processing: '↻', maintenance: '⚒', moving: '↗', completed: '✓', failed: '!', cancelled: '×', blocked: '⌛' }
export const TASKS = [
  { id: 'T1', title: '可靠水质与保存校正', slots: ['baseline', 'final'] },
  { id: 'T2', title: '受约束作物干预', slots: ['baseline', 'final'] },
  { id: 'T3', title: '研究组合与资源管理', slots: ['baseline', 'final'] },
  { id: 'T4', title: '异常根因与处置验证', slots: ['final'] },
  { id: 'T5', title: '跨项目证据与选择性修订', slots: ['baseline', 'final'] },
  { id: 'T6', title: '联合交付与持续运行', slots: ['final'] },
]
export function deviceCatalog(layout = marsLayout()) {
  return layout.anchors.map(anchor => {
    const id = anchor.id
    const height = id === 'confirm' ? 183 : id === 'liquid-handler' ? 163 : id === 'imager' ? 148 : id.startsWith('robot') ? 85 : id.startsWith('centrifuge') ? 98 : id.startsWith('heater') ? 57 : id === 'screen' ? 111 : id.startsWith('cold') ? 145 : id === 'freezer' ? 100 : id === 'reservoir' ? 160 : id === 'filter' ? 145 : id === 'analysis' ? 160 : 120
    return { ...anchor, name: DEVICE_NAMES[id] ?? id, height, phase: 'unknown', state: '状态未记录', primary: ['liquid-handler', 'centrifuge-1', 'confirm', 'robot-1'].includes(id) }
  })
}
