import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { makeWorld, devices, regions, initialCamera, overviewCamera, project } from './immersive-world.mjs'

// Design artifacts only. No experiment directory, database, model, or control connection.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
let sharp
try { sharp = require('sharp') } catch (error) {
  // Existing local rendering dependency; the generated HTML/SVG have no package dependency.
  if (error.code !== 'MODULE_NOT_FOUND') throw error
  sharp = require('sharp')
}
const width = 1680, height = 1050
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const cameraView = camera => `${camera.cx - camera.width / 2} ${camera.cy - camera.width * height / width / 2} ${camera.width} ${camera.width * height / width}`
const world = makeWorld(cameraView(initialCamera))
const template = readFileSync(resolve(root, 'design-assets/immersive-page.template.html'), 'utf8')
const html = template.replace('<!-- WORLD -->', world)
  .replace('/* DEVICES */', JSON.stringify(devices))
  .replace('/* REGIONS */', JSON.stringify(regions))
  .replace('/* INITIAL_CAMERA */', JSON.stringify(initialCamera))
  .replace('/* OVERVIEW_CAMERA */', JSON.stringify(overviewCamera))
if (/\/\* (DEVICES|REGIONS|INITIAL_CAMERA|OVERVIEW_CAMERA) \*\/|<!-- WORLD -->/.test(html)) throw new Error('Design template substitution incomplete')
writeFileSync(resolve(root, 'mars-frontend-page-concept.html'), html)

function uiLabel(camera, anchor, title, state, icon = 'Ⅱ') {
  const [px, py] = anchor, scale = width / camera.width, sx = (px - camera.cx + camera.width / 2) * scale, sy = (py - camera.cy + camera.width * height / width / 2) * scale
  if (sx < 60 || sx > width - 60 || sy < 130 || sy > height - 100) return ''
  if (state === '点击进入区域') {
    const chip = Math.max(88, title.length * 14 + 30)
    return `<g transform="translate(${sx - chip / 2} ${sy - 34})"><path d="M${chip / 2} 34V45" stroke="#c6e1df" opacity=".8"/><rect width="${chip}" height="34" rx="17" fill="#243c46" fill-opacity=".93" stroke="#a2bfc0" stroke-opacity=".55"/><text x="${chip / 2}" y="23" text-anchor="middle" font-size="14">${escape(title)}</text></g>`
  }
  const w = Math.max(132, title.length * 15 + 30)
  return `<g transform="translate(${sx - w / 2} ${sy - 61})"><path d="M${w / 2} 61V78" stroke="#c6e1df" opacity=".8"/><rect width="${w}" height="61" rx="9" fill="#243c46" fill-opacity=".96" stroke="#a2bfc0" stroke-opacity=".72"/><text x="14" y="24" font-size="15">${escape(title)}</text><text x="14" y="46" font-size="14" fill="#73d1df">${icon}</text><text x="35" y="45" font-size="12" fill="#c3d2d2">${escape(state)}</text></g>`
}
function chrome(title = '前处理与分析区', zoom = '1.0×') {
  return `<g class="page-ui"><g transform="translate(35 32)"><circle cx="17" cy="19" r="16" stroke="#f2eee3" fill="none" stroke-width="1.3"/><path d="M2 23Q17 4 33 17M6 29L20 10L28 28M9 25H27" stroke="#f2eee3" fill="none" stroke-width="1.3"/><text x="48" y="25" style="font-family:SimSun,serif" font-size="28" letter-spacing="3">火星实验室</text><text x="50" y="47" font-size="11" fill="#e1e6df" letter-spacing="1">科研基地观察</text></g>
  <g transform="translate(554 26)"><rect width="620" height="53" rx="27" fill="#243c46" fill-opacity=".97" stroke="#9ab2b5" stroke-opacity=".45"/>
  <g fill="none" stroke="#c9d9d9" stroke-width="1.5"><path d="M28 20V29L24 37H39L35 29V20M27 20H36M26 32H37"/><path d="M133 19H144L149 24V37H133ZM143 19V25H149M137 29H145M137 33H143"/><circle cx="281" cy="24" r="4"/><path d="M273 37V34Q273 29 281 29Q289 29 289 34V37M290 24Q297 24 297 29M294 32Q301 32 301 37"/><path d="M414 17L406 29H414L412 39L424 25H416Z"/><path d="M516 22H524V38H516ZM530 18H538V38H530Z"/></g>
  <text x="49" y="33" font-size="15">科研</text><text x="161" y="33" font-size="15">实验记录</text><text x="310" y="33" font-size="15">AI 工作</text><text x="435" y="33" font-size="15">资源</text><text x="552" y="33" font-size="15">对照</text></g>
  <g transform="translate(1550 27)"><rect width="102" height="49" rx="25" fill="#243c46" fill-opacity=".96" stroke="#9ab2b5" stroke-opacity=".45"/><path d="M18 22L27 17L36 22L27 27ZM18 27L27 32L36 27" fill="none" stroke="#d5e5df" stroke-width="1.3"/><text x="46" y="31" font-size="14">场景</text></g>
  <g transform="translate(34 881)"><text y="0" font-size="12" fill="#dfe9dd">↘ 装载　　↻ 处理　　Ⅱ 待机　　✓ 完成</text><text y="59" style="font-family:SimSun,serif" font-size="31" letter-spacing="2">${title}</text><text y="89" font-size="13" fill="#e2e4da">滚轮缩放，拖动探索</text><text y="116" font-size="12" fill="#d2d9d3">设计样例 · 未连接实验记录</text></g>
  <g transform="translate(740 968)"><rect width="170" height="48" rx="24" fill="#243c46" fill-opacity=".97" stroke="#9ab2b5" stroke-opacity=".45"/><path d="M25 15V33M33 15V33" stroke="#e0e9df" stroke-width="2"/><text x="51" y="30" font-size="14">暂停观看</text></g>
  <g transform="translate(1366 968)"><rect width="153" height="48" rx="24" fill="#243c46" fill-opacity=".97" stroke="#9ab2b5" stroke-opacity=".45"/><text x="23" y="30" text-anchor="middle" font-size="24">−</text><text x="76" y="29" text-anchor="middle" font-size="13" fill="#bbcacd">${zoom}</text><text x="130" y="31" text-anchor="middle" font-size="23">+</text><rect x="164" width="120" height="48" rx="24" fill="#243c46" fill-opacity=".97" stroke="#9ab2b5" stroke-opacity=".45"/><text x="224" y="30" font-size="13" text-anchor="middle">回到实验室</text></g></g>`
}
function sheet() {
  return `<rect width="1680" height="1050" fill="#1e3345" opacity=".16"/><g transform="translate(943 113)" class="page-ui"><rect width="700" height="800" rx="18" fill="#243c46" fill-opacity=".99" stroke="#88a8ae" stroke-opacity=".85"/><text x="31" y="58" style="font-family:SimSun,serif" font-size="29">实验记录</text><circle cx="651" cy="45" r="17" fill="#3a5763"/><path d="M645 39L657 51M645 51L657 39" stroke="#e1e9e4" stroke-width="1.5"/><text x="31" y="110" font-size="14">物理操作</text><text x="158" y="110" font-size="14" fill="#bbcacd">异常与事件</text><text x="299" y="110" font-size="14" fill="#bbcacd">可用历史</text><path d="M30 128H670" stroke="#536b73"/><path d="M31 128H95" stroke="#a0dfe3" stroke-width="2"/><text x="31" y="166" font-size="12" fill="#bbcacd">设计样例 · 尚未载入本轮实验记录</text><text x="31" y="218" font-size="20">从记录返回实验室中的对象</text>
  ${[['自动分液站正在装载', '托盘进入分液站，移液头保持停靠。'], ['离心机 1 正在处理', '圆形转子旋转，维护标记独立保留。'], ['确认仪待机', '没有活动操作，工作部件静止。']].map(([name, description], index) => `<g transform="translate(31 ${272 + index * 116})"><circle cx="16" cy="7" r="16" fill="#46616b"/><text x="16" y="12" text-anchor="middle" font-size="18" fill="#c5e9e9">◇</text><text x="48" y="6" font-size="15">${name}</text><text x="48" y="34" font-size="12" fill="#bbcacd">设计样例：${description}</text><rect x="561" y="-10" width="69" height="35" rx="6" fill="#3f606b" stroke="#789ba0"/><text x="595" y="13" text-anchor="middle" font-size="12">定位</text><path d="M0 65H638" stroke="#526e75" opacity=".5"/></g>`).join('')}
  <text x="31" y="697" font-size="13" fill="#bbcacd">关闭面板后继续观察原来的位置。</text><text x="31" y="725" font-size="13" fill="#bbcacd">浮层不改变实验运行状态。</text></g>`
}
function compose(camera, overlay = false) {
  let labels = ''
  if (camera.width > 3000) for (const r of regions) labels += uiLabel(camera, project(r.x + 6, r.y + 5, 100), r.label, '点击进入区域', '◇')
  else for (const d of devices.filter(d => d.primary)) labels += uiLabel(camera, project(d.x, d.y, d.height + 37), d.name, d.state, { loading: '↘', processing: '↻', idle: 'Ⅱ', completed: '✓' }[d.phase])
  const inner = makeWorld(cameraView(camera)).replace('<svg ', '<svg x="0" y="0" width="1680" height="1050" ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="page-title page-desc"><title id="page-title">火星实验室沉浸页面概念${overlay ? '：浮层' : camera.width > 3000 ? '：缩小到全局' : '：默认局部'}</title><desc id="page-desc">艺术方向与交互示意，所有状态为设计数据。场景铺满页面，默认观察局部，滚轮缩小显示完整基地，顶部悬浮入口查看其它页面。</desc><style>.page-ui{fill:#f2f5f3}.page-ui text{font-family:'Microsoft YaHei','Noto Sans SC',sans-serif}</style>${inner}<defs><linearGradient id="page-edge" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#263b46" stop-opacity=".42"/><stop offset=".19" stop-color="#263b46" stop-opacity="0"/><stop offset=".65" stop-color="#283544" stop-opacity="0"/><stop offset="1" stop-color="#283544" stop-opacity=".7"/></linearGradient></defs><rect width="1680" height="1050" fill="url(#page-edge)"/><g class="page-ui">${labels}</g>${chrome(camera.width > 3000 ? '火星科研基地' : '前处理与分析区', (initialCamera.width / camera.width).toFixed(1) + '×')}${overlay ? sheet() : ''}</svg>`
}
const artifacts = [
  ['mars-frontend-page-concept', compose(initialCamera)],
  ['mars-frontend-overview-concept', compose(overviewCamera)],
  ['mars-frontend-overlay-concept', compose(initialCamera, true)],
]
for (const [name, svg] of artifacts) writeFileSync(resolve(root, `${name}.svg`), svg)
const images = await Promise.all(artifacts.map(async ([name, svg]) => {
  const image = await sharp(Buffer.from(svg)).png().toFile(resolve(root, `${name}.png`))
  return { name, width: image.width, height: image.height, bytes: image.size }
}))
console.log(JSON.stringify({ generated: true, designOnly: true, html: 'mars-frontend-page-concept.html', images }))
