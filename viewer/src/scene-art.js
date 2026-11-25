/** Isometric artwork migrated from the approved design; all device states come from the loaded run. */
import { marsLayout, deviceCatalog } from './layout.js'
const escapeSvg = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
export const project = (x, y, z = 0) => [(x - y) * 37, (x + y) * 19 - z]
const n = value => Number(value.toFixed(2))
const point = p => p.map(n).join(',')
const polygon = (points, fill, extra = '') => `<polygon points="${points.map(point).join(' ')}" fill="${fill}" ${extra}/>`
const line = (a, b, color = '#81969c', width = 1, extra = '') => `<path d="M${point(a)}L${point(b)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${extra}/>`
const path = (d, fill, extra = '') => `<path d="${d}" fill="${fill}" ${extra}/>`
const ellipse = (x, y, rx, ry, fill, extra = '') => `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${rx}" ry="${ry}" fill="${fill}" ${extra}/>`
const circle = (x, y, radius, fill, extra = '') => `<circle cx="${n(x)}" cy="${n(y)}" r="${radius}" fill="${fill}" ${extra}/>`
const text = (x, y, content, size = 13, fill = '#d7e5e4', extra = '') => `<text x="${n(x)}" y="${n(y)}" font-size="${size}" fill="${fill}" ${extra}>${escapeSvg(content)}</text>`
const plate = (x, y, w, d, z, fill, extra = '') => polygon([project(x, y, z), project(x + w, y, z), project(x + w, y + d, z), project(x, y + d, z)], fill, extra)
function box(x, y, w, d, h, z = 0, colors = ['#dfe8e5', '#a6b6b7', '#78919a'], extra = '') {
  const a = project(x, y, z + h), b = project(x + w, y, z + h), c = project(x + w, y + d, z + h), e = project(x, y + d, z + h)
  const b0 = project(x + w, y, z), c0 = project(x + w, y + d, z), e0 = project(x, y + d, z)
  return `<g ${extra}>${polygon([e, c, c0, e0], colors[1])}${polygon([b, c, c0, b0], colors[2])}${polygon([a, b, c, e], colors[0])}${line(a, b, '#f1f4e9', .8, 'opacity=".65"')}${line(a, e, '#f1f4e9', .8, 'opacity=".55"')}</g>`
}
function frontPanel(x, y, w, h, z, fill, extra = '') {
  return polygon([project(x, y, z + h), project(x + w, y, z + h), project(x + w, y, z), project(x, y, z)], fill, extra)
}
function sidePanel(x, y, d, h, z, fill, extra = '') {
  return polygon([project(x, y, z + h), project(x, y + d, z + h), project(x, y + d, z), project(x, y, z)], fill, extra)
}
function shadow(x, y, rx = 65, ry = 27) {
  const [sx, sy] = project(x, y)
  return polygon([[sx-rx*.65,sy-ry*.5],[sx+rx*.5,sy-ry*.4],[sx+rx*.95+38,sy+ry+40],[sx-rx*.3+38,sy+ry+40]], '#304b59', 'opacity=".12"') + ellipse(sx + 14, sy + 12, rx, ry, '#233c49', 'opacity=".16"')
}
function tinyScreen(x, y, w = .7, z = 35, h = 24) {
  let out = frontPanel(x, y, w, h, z, '#2b4550')
  const a = project(x + .12, y, z + h - 7), b = project(x + w - .1, y, z + h - 7)
  out += line(a, b, '#b8d6d8', 1.5)
  out += line(project(x + .12, y, z + 8), project(x + w * .6, y, z + 8), '#83a8b2', 1.4)
  return out
}
function vents(x, y, count, z = 15) {
  let out = ''
  for (let i = 0; i < count; i++) out += line(project(x + i * .13, y, z), project(x + i * .13, y, z + 8), '#486571', 1.4)
  return out
}
function cylinder(x, y, radius, height, z = 0, fill = 'url(#tank-metal)') {
  const [cx, cy] = project(x, y, z)
  const rx = radius * 43, ry = radius * 22
  return path(`M${cx - rx},${cy - height} A${rx},${ry} 0 0 1 ${cx + rx},${cy - height} V${cy} A${rx},${ry} 0 0 1 ${cx - rx},${cy}Z`, fill)
    + ellipse(cx, cy - height, rx, ry, '#e2e9df', 'stroke="#6e8990" stroke-width="1"')
    + ellipse(cx, cy, rx, ry, 'none', 'stroke="#3b5863" stroke-width="1" opacity=".35"')
}
const regions = marsLayout().regions
export const initialCamera = { cx: 225, cy: 850, width: 1750 }
export const overviewCamera = { cx: 315, cy: 865, width: 4490 }
const definitions = `<defs>
  <linearGradient id="terrain" x1="0" y1="0" x2=".75" y2="1"><stop stop-color="#a77d66"/><stop offset=".48" stop-color="#956b5b"/><stop offset="1" stop-color="#66545a"/></linearGradient>
  <radialGradient id="ground-light" cx=".19" cy=".04" r=".94"><stop stop-color="#d2ac7e" stop-opacity=".35"/><stop offset="1" stop-color="#bd9078" stop-opacity="0"/></radialGradient>
  <linearGradient id="tank-metal"><stop stop-color="#769399"/><stop offset=".3" stop-color="#d0dfda"/><stop offset=".6" stop-color="#b1c6c5"/><stop offset="1" stop-color="#577580"/></linearGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="1" y2=".5"><stop stop-color="#b8ddd8" stop-opacity=".23"/><stop offset=".5" stop-color="#749ca8" stop-opacity=".14"/><stop offset="1" stop-color="#addbd0" stop-opacity=".38"/></linearGradient>
  <linearGradient id="door-glass"><stop stop-color="#45646b"/><stop offset=".5" stop-color="#7eabae"/><stop offset="1" stop-color="#4c717c"/></linearGradient>
  <linearGradient id="ceramic"><stop stop-color="#e8eee5"/><stop offset="1" stop-color="#b7cdcf"/></linearGradient>
  <radialGradient id="worklight"><stop stop-color="#99e5ec" stop-opacity=".42"/><stop offset="1" stop-color="#7bdde6" stop-opacity="0"/></radialGradient>
</defs>`
export const sceneStyle = `<style>
  .world-art text{font-family:'Microsoft YaHei','Noto Sans SC',sans-serif}
  .world-art .device{cursor:pointer;outline:none}
  .world-art .selection-ring{opacity:0;transition:opacity .15s}
  .world-art .device:hover .selection-ring,.world-art .device:focus-visible .selection-ring,.world-art .device.is-selected .selection-ring{opacity:1}
  .world-art .rotor-spin{animation:rotor 1.3s linear infinite;transform-box:fill-box;transform-origin:center}
  .world-art .load-tray{animation:load-tray 4.8s ease-in-out infinite}
  .world-art .work-head{animation:work-head 4s ease-in-out infinite}
  .world-art .detector-band{animation:detector 2.7s ease-in-out infinite;opacity:.8}
  .world-art .device:not([data-phase="processing"]) .rotor-spin,.world-art .device:not([data-phase="processing"]) .work-head,.world-art .device:not([data-phase="loading"]) .load-tray{animation:none}
  .world-art .device:not([data-phase="processing"]) .detector-band{animation:none;opacity:0}
  @keyframes detector{0%,100%{transform:translateY(0)}50%{transform:translateY(-60px)}}
  .world-art .crop-plant[data-status="unknown"] .leaf{fill:#8b9f9a}
  .world-art .crop-plant[data-status="stressed"] .leaf{fill:#b6a36d}
  .world-art .crop-plant[data-status="lost"] .leaf{fill:#8a7867;opacity:.4}
  .world-art .crop-plant[data-removed="true"]{display:none}
  .world-art .activity-light{opacity:0}
  .world-art .device[data-phase="loading"] .activity-light,.world-art .device[data-phase="processing"] .activity-light,.world-art .device[data-phase="moving"] .activity-light{opacity:1}
  .world-art .health-indicator{display:none}
  .world-art .device[data-alert="fault"] .health-indicator,.world-art .device[data-alert="power"] .health-indicator{display:block}
  .world-art .maintenance-glyph{display:none}
  .world-art .device[data-phase="maintenance"] .maintenance-glyph{display:block}
  .world-art .device[data-phase="failed"] .selection-ring{opacity:1;stroke:#e99891;fill:#e99891;stroke-dasharray:5 5}
  .world-art .device[data-motion="false"] *{animation-play-state:paused!important}
  .world-art .scan-band{animation:detector 2.6s ease-in-out infinite;opacity:.7}
  .world-art .device:not([data-phase="processing"]) .scan-band{display:none;animation:none}
  .paused .world-art *,.reduced .world-art *{animation-play-state:paused!important}
  @media(prefers-reduced-motion:reduce){.world-art *{animation:none!important}}
  @keyframes rotor{to{transform:rotate(360deg)}}
  @keyframes load-tray{0%,15%,100%{transform:translate(-17px,9px)}50%,70%{transform:translate(0,0)}}
  @keyframes work-head{0%,100%{transform:translate(0,0)}40%{transform:translate(27px,14px)}65%{transform:translate(27px,22px)}}
</style>`
function ground() {
  let out = '<rect x="-6500" y="-5000" width="14000" height="11000" fill="url(#terrain)"/><rect x="-6500" y="-5000" width="14000" height="11000" fill="url(#ground-light)"/>'
  out += path('M-3100 940C-1800 1300 -1700 180 -450 40S1250 40 2500 -500L3200 -1100H-3200Z', '#b8896e', 'opacity=".2"')
  out += path('M-2800 1800C-1600 1290 -1100 2200 300 1800S1800 1250 2900 1810L3300 3200H-3000Z', '#635563', 'opacity=".26"')
  out += path('M-2800 1570C-1800 1250 -2100 1980 -1050 1710S1000 1780 2350 1270', 'none', 'stroke="#b48971" stroke-width="20" opacity=".18"')
  let seed = 93761
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  for (let i = 0; i < 640; i++) {
    const x = -22 + rand() * 104, y = -18 + rand() * 82
    if (x > -2 && x < 60 && y > -2 && y < 44) continue
    const [sx, sy] = project(x, y), r = 2 + rand() * 11
    out += ellipse(sx + 3, sy + 3, r * 1.35, r * .4, '#454451', 'opacity=".2"')
    out += polygon([[sx - r, sy], [sx - r * .3, sy - r * .65], [sx + r * .5, sy - r * .35], [sx + r, sy + r * .2], [sx, sy + r * .35]], i % 3 ? '#af826b' : '#775e59')
    if (i % 4 === 0) out += line([sx - r, sy], [sx - r * .3, sy - r * .65], '#d3a17b', 1, 'opacity=".4"')
  }
  for (const [x, y, r] of [[-8, 12, 160], [67, 37, 125], [40, 53, 95], [17, -8, 120]]) {
    const [sx, sy] = project(x, y)
    out += ellipse(sx, sy, r, r * .42, '#64515a', 'opacity=".17"') + ellipse(sx, sy + 8, r * .84, r * .32, 'none', 'stroke="#c09174" stroke-width="4" opacity=".25"')
  }
  return out
}
function floors() {
  let out = plate(-1.5, -1.6, 61, 44, -30, '#3f414e')
  out += box(-1, -1, 59, 42, 22, -22, ['#bda68e', '#7c6865', '#64616b'])
  out += plate(-.5, -.5, 58, 41, 0, '#ae9d8b')
  for (const region of regions) {
    const { x, y, id } = region
    const green = id.startsWith('greenhouse')
    const fill = green ? '#789a91' : id === 'preparation' ? '#b7c9c5' : id === 'analysis' ? '#99b5be' : ['cold', 'water'].includes(id) ? '#8baab1' : '#9aa8a7'
    out += box(x, y, 12, 10, 8, 0, [fill, '#768c92', '#5a747e'])
    out += plate(x + .2, y + .2, 11.6, 9.6, 8.4, 'none', 'stroke="#e3e9dc" stroke-width=".9" opacity=".48"')
    for (let j = 2; j < 12; j += 2) out += line(project(x + j, y, 8.5), project(x + j, y + 10, 8.5), '#486d7b', .7, 'opacity=".14"')
    for (let j = 2; j < 10; j += 2) out += line(project(x, y + j, 8.5), project(x + 12, y + j, 8.5), '#486d7b', .7, 'opacity=".14"')
    // Narrow service lip; the facing walls remain cut away.
    out += box(x, y + 9.82, 12, .18, 16, 8, ['#e1e6d9', '#98acae', '#718b97'])
    if (!green) {
      const [lx, ly] = project(x + 1.2, y + 8.9, 9)
      out += text(lx, ly, region.label, 14, '#466671', 'transform="rotate(27.15 ' + lx + ' ' + ly + ')" opacity=".72" letter-spacing="2"')
    }
  }
  // Corridor coordinates retain the 4x3 layout, including preparation—analysis.
  for (const region of regions) {
    out += plate(region.x + 4.7, region.y + 10, 2.6, 2, 3, '#b9c6bf')
    out += plate(region.x + 5.9, region.y + 10, .15, 2, 3.2, '#f0e8ca', 'opacity=".6"')
    if (region.x < 45) out += plate(region.x + 6, region.y + 11, 15, 2, 2, '#b1beb8')
    if (region.y < 30) out += plate(region.x + 5, region.y + 12, 2, 15, 1, '#a8b5af')
  }
  out += plate(21, 26.8, 15, .32, 3, '#d7e6df')
  out += plate(21, 28.5, 15, .12, 3, '#738b91')
  for (let i = 22; i < 36; i += 2) out += plate(i, 26.85, .9, .08, 4, '#73d1df', 'opacity=".8"')
  return out
}
function walls(region) {
  const { x, y, id } = region
  const green = id.startsWith('greenhouse')
  let out = ''
  const h = green ? 116 : region.y === 30 ? 45 : 78
  out += box(x, y, 12, .18, h, 8, ['#ecede0', '#b5c7c3', '#7a969e'])
  out += box(x, y, .18, 10, h, 8, ['#e3e9df', '#9cb5b4', '#6f8b95'])
  if (green) {
    // Glass roof strips and slim ribs leave the plants visible from above.
    out += frontPanel(x + .28, y + .21, 11.4, 88, 28, 'url(#glass)')
    for (let i = 1; i <= 4; i++) {
      const [a, b] = [project(x + i * 2.7, y + .23, 26), project(x + i * 2.7, y + .23, h)]
      out += line(a, b, '#d8e8d9', 2.3)
    }
    out += plate(x + .1, y + .1, 11.8, 2.2, 124, 'url(#glass)', 'stroke="#b6d2cd" stroke-width="1"')
  } else {
    for (let i = 1; i <= 5; i++) out += line(project(x + i * 2, y + .2, 16), project(x + i * 2, y + .2, h + 8), '#7e989f', .8, 'opacity=".45"')
    out += frontPanel(x + .8, y + .22, 6.8, 8, h - 12, '#f0f0da', 'opacity=".9"')
    out += frontPanel(x + 8.6, y + .22, 1.8, 36, 27, '#4a6673')
    for (let i = 0; i < 4; i++) out += line(project(x + 8.85, y + .23, 35 + i * 6), project(x + 10.1, y + .23, 35 + i * 6), '#abc5c5', .8)
    out += frontPanel(x + .8, y + .23, 1.25, 20, 22, '#b4c6c3')
    // Service pipes are structural, with no fictitious animated flow.
    out += line(project(x + .4, y + .26, 17), project(x + 11.7, y + .26, 17), '#43636f', 3)
    out += line(project(x + .4, y + .27, 22), project(x + 11.7, y + .27, 22), '#bcd2cc', 1.5)
  }
  return out
}
function plants(region, crops) {
  const { x, y } = region, chamberId = `incubator-${'ABCD'.indexOf(region.id.at(-1)) + 1}`
  const members = crops.filter(c => c.chamberId === chamberId)
  let out = ''
  for (let bed = 0; bed < 3; bed++) {
    const bx = x + 1 + bed * 3.5
    out += box(bx, y + 2, 2.5, 6.3, 16, 9, ['#586960', '#9aafa3', '#6e8984']) + plate(bx + .2, y + 2.2, 2.1, 5.9, 26, '#594e44')
    const plantsInBed = members.filter((_, i) => i % 3 === bed), rowCount = Math.max(1, Math.ceil(plantsInBed.length / 2))
    for (const [i, crop] of plantsInBed.entries()) {
      const [cx, cy] = project(bx + .6 + i % 2 * 1.1, y + 3 + Math.floor(i / 2) * 5 / rowCount, 30)
      out += `<g class="crop-plant" data-crop="${escapeSvg(crop.id)}" data-status="${escapeSvg(crop.status)}" data-removed="${Boolean(crop.removed)}"><title>${escapeSvg(crop.id)}</title>`
      out += line([cx, cy], [cx, cy - 20], '#57705b', 1.6)
      out += path(`M${cx} ${cy - 3}Q${cx - 19} ${cy - 24} ${cx - 5} ${cy - 28}Q${cx + 2} ${cy - 20} ${cx} ${cy - 3}`, '#628a6a', 'class="leaf"')
      out += path(`M${cx} ${cy - 7}Q${cx + 21} ${cy - 30} ${cx + 12} ${cy - 30}Q${cx - 2} ${cy - 25} ${cx} ${cy - 7}`, '#94b68a', 'class="leaf"')
      out += path(`M${cx} ${cy - 8}Q${cx - 13} ${cy - 33} ${cx - 3} ${cy - 36}Q${cx + 5} ${cy - 28} ${cx} ${cy - 8}`, '#7ba178', 'class="leaf"') + '</g>'
    }
    out += box(bx - .05, y + 2, .12, 6.4, 5, 107, ['#dde9da', '#d3ded1', '#91b9b4']) + plate(bx - .07, y + 2, .2, 6.4, 105, '#eef5df', 'opacity=".85"')
  }
  return out
}
function dispenser(d) {
  const { x, y } = d
  let out = shadow(x, y, 105, 39) + box(x - 1.4, y - 1.2, 2.8, 2.4, 40, 10)
  out += plate(x - 1.2, y - 1, 2.4, 2, 51, '#6c8e98')
  out += box(x - 1.28, y - 1.03, .19, .19, 101, 50) + box(x + 1.07, y - 1.03, .19, .19, 101, 50)
  out += box(x - 1.35, y - 1.1, 2.7, .35, 15, 146)
  out += line(project(x - 1.1, y - .89, 151), project(x + 1.05, y - .89, 151), '#536d7a', 4)
  out += '<g class="load-tray">' + box(x - 1.02, y - .5, 2.05, 1.64, 5, 53, ['#e8f0eb', '#9eb3b6', '#6b8d98'])
  for (let row = 0; row < 4; row++) for (let col = 0; col < 6; col++) {
    const [cx, cy] = project(x - .8 + col * .3, y - .3 + row * .35, 60)
    out += ellipse(cx, cy, 3.6, 1.9, (row + col) % 5 ? '#86b3be' : '#acd9dd')
  }
  out += '</g><g class="work-head">' + box(x - .85, y - 1.16, .62, .66, 43, 99, ['#e1eeea', '#8faeb7', '#547f91'])
  for (let i = 0; i < 4; i++) out += line(project(x - .74 + i * .13, y - .47, 100), project(x - .74 + i * .13, y - .47, 81), '#d7ecea', 2)
  out += '</g>' + tinyScreen(x - 1.03, y + 1.205, .9, 22, 18)
  const [lx, ly] = project(x + .65, y + 1.22, 33)
  out += circle(lx, ly, 3.5, '#73d1df') + vents(x + .8, y + 1.21, 3, 22)
  return out
}
function centrifuge(d) {
  const { x, y } = d, [cx, cy] = project(x, y, 78)
  let out = shadow(x, y, 86, 33) + box(x - 1.15, y - 1.05, 2.3, 2.1, 63, 10, ['#dde7e0', '#a3b9bc', '#6c8b99'])
  out += ellipse(cx, cy + 3, 65, 33, '#5d7c88') + ellipse(cx, cy, 62, 31, '#e5ece4')
  out += ellipse(cx, cy, 49, 24, '#283f4d') + ellipse(cx, cy, 42, 20, '#6b929e')
  out += `<g transform="translate(${cx} ${cy}) scale(1 .49)"><g class="rotor-spin">`
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3, ex = Math.cos(a) * 29, ey = Math.sin(a) * 29
    out += line([0, 0], [ex, ey], '#d0e2de', 5) + circle(ex, ey, 5, '#91dce3')
  }
  out += circle(0, 0, 8, '#244553') + '</g></g>'
  out += path(`M${cx - 36} ${cy - 17}Q${cx - 10} ${cy - 28} ${cx + 20} ${cy - 21}`, 'none', 'stroke="#d2eeee" stroke-width="2" opacity=".75"')
  out += tinyScreen(x - .9, y + 1.055, .9, 32, 22) + vents(x + .4, y + 1.06, 4, 27)
  const [lx, ly] = project(x + .31, y + 1.06, 46)
  out += circle(lx, ly, 3.6, d.phase === 'processing' ? '#73d1df' : '#6e8991')
  return out
}
function confirmer(d) {
  const { x, y } = d
  let out = shadow(x, y, 88, 32) + box(x - 1.05, y - .95, 2.1, 1.9, 161, 10, ['#e4ece4', '#a7bec0', '#698a9b'])
  out += frontPanel(x - .84, y + .955, .9, 103, 45, '#2d4b58')
  for (let i = 0; i < 3; i++) {
    out += line(project(x - .68 + i * .25, y + .966, 58), project(x - .68 + i * .25, y + .966, 132), '#9ac4c9', 4.5)
    out += line(project(x - .66 + i * .25, y + .97, 66), project(x - .66 + i * .25, y + .97, 125), '#e2ede4', 1.2)
  }
  out += frontPanel(x - .8, y + .98, .84, 8, 60, '#73d1df', 'class="detector-band"')
  out += tinyScreen(x + .3, y + .96, .52, 105, 39)
  out += box(x - .75, y + .97, 1.5, .35, 25, 18, ['#dfe9df', '#b9d0cf', '#7499a6'])
  out += frontPanel(x - .54, y + 1.33, 1.04, 10, 26, '#395d6c')
  out += sidePanel(x + 1.06, y - .62, 1.25, 87, 50, '#84a9b5')
  out += line(project(x + 1.07, y - .42, 63), project(x + 1.07, y - .42, 124), '#d5e6df', 2.3)
  out += vents(x - .75, y + .96, 7, 12)
  const [lx, ly] = project(x + .68, y + .96, 83)
  out += circle(lx, ly, 4, '#829ba2')
  return out
}
function screener(d) {
  const { x, y } = d
  let out = shadow(x, y, 95, 35) + box(x - 1.4, y - 1, 2.8, 2, 83, 10, ['#e5eae0', '#abc1c1', '#7596a4'])
  out += frontPanel(x - 1.13, y + 1.01, 2.23, 35, 40, '#365360')
  out += frontPanel(x - 1.05, y + 1.025, 2.08, 5, 55, '#73d1df', 'class="scan-band"')
  out += box(x - .85, y + 1, 1.7, .58, 8, 40, ['#d7e9e4', '#8bafb7', '#638b9c'])
  for (let row = 0; row < 2; row++) for (let col = 0; col < 5; col++) {
    const [cx, cy] = project(x - .62 + col * .3, y + 1.1 + row * .19, 50)
    out += ellipse(cx, cy, 3, 1.6, '#5f8b99')
  }
  out += tinyScreen(x - 1.1, y + 1.02, .6, 17, 16) + vents(x + .2, y + 1.02, 5, 20)
  const [lx, ly] = project(x + .95, y + 1.02, 23)
  out += circle(lx, ly, 3.2, '#bad8c4')
  return out
}
function imager(d) {
  const { x, y } = d
  let out = shadow(x, y, 79, 30) + box(x - 1.1, y - .9, 2.2, 1.8, 28, 10)
  out += plate(x - .83, y - .65, 1.65, 1.3, 39, '#375c69') + plate(x - .5, y - .4, 1, .8, 41, '#a8ccd1')
  out += box(x + .62, y - .8, .25, .25, 96, 38) + box(x - .86, y - .8, 1.75, .3, 12, 129)
  out += cylinder(x - .4, y - .55, .25, 30, 98, '#547c8d') + cylinder(x - .4, y - .55, .2, 8, 96, '#aac8c9')
  out += tinyScreen(x - .85, y + .91, .7, 18, 13)
  out += plate(x - .8, y - .6, 1.6, .08, 43, '#9dedf0', 'class="scan-band"')
  return out
}
function heater(d) {
  const { x, y } = d, [cx, cy] = project(x, y, 47)
  return shadow(x, y, 53, 20) + box(x - .7, y - .65, 1.4, 1.3, 32, 10) + ellipse(cx, cy, 31, 15, '#577887') + ellipse(cx, cy - 1, 25, 11, '#b8d0cc') + tinyScreen(x - .5, y + .66, .55, 18, 14)
}
function workstation(d) {
  const { x, y } = d
  let out = shadow(x, y, 84, 32) + box(x - 1.3, y - 1, 2.6, 1.9, 54, 9)
  out += box(x - .6, y - .5, .15, .2, 40, 63) + box(x - 1.1, y - .75, 1.45, .22, 54, 92, ['#c1d5d5', '#2d4c5c', '#6a8995'])
  out += frontPanel(x - .97, y - .51, 1.2, 36, 102, '#254553')
  out += line(project(x - .78, y - .5, 127), project(x + .01, y - .5, 127), '#a3cbd1', 2)
  out += line(project(x - .78, y - .5, 117), project(x - .25, y - .5, 117), '#6e9ba7', 2)
  out += plate(x - .85, y + .3, 1.3, .4, 65, '#8ba7ad') + box(x + .8, y - .6, .37, .37, 23, 64, ['#dedcc6', '#b5bea9', '#8caaa6'])
  return out
}
function robot(d) {
  const { x, y } = d, [cx, cy] = project(x, y, 21)
  let out = shadow(x, y, 60, 24)
  for (const [dx, dy] of [[-.65, -.6], [.65, -.6], [-.65, .6], [.65, .6]]) {
    const [wx, wy] = project(x + dx, y + dy, 17)
    out += ellipse(wx, wy, 12, 17, '#354c58') + ellipse(wx - 2, wy - 1, 5, 10, '#6a8891')
  }
  out += box(x - .8, y - .8, 1.6, 1.6, 24, 22, ['#e0e8dc', '#a0bbb9', '#7396a3'])
  out += box(x - .62, y - .45, 1.24, .9, 15, 47, ['#94b7bf', '#527b8e', '#456b7e'])
  out += box(x - .36, y - .25, .72, .5, 14, 64, ['#dce9e0', '#9dbbb8', '#769d9f'])
  out += line([cx + 16, cy - 35], [cx + 16, cy - 64], '#d8e5d9', 2.5) + circle(cx + 16, cy - 65, 4, '#73d1df')
  out += text(cx - 5, cy + 4, d.id === 'robot-1' ? 'R1' : d.id === 'robot-2' ? 'R2' : 'R3', 13, '#304e59', 'font-weight="700" text-anchor="middle"')
  return out
}
function facility(d) {
  const { id, x, y } = d
  if (id === 'reservoir') {
    const [cx, cy] = project(x, y, 8)
    return shadow(x, y, 85, 31) + cylinder(x, y, 1.5, 133, 8)
      + ellipse(cx, cy - 112, 63, 31, 'none', 'stroke="#547d88" stroke-width="5"')
      + ellipse(cx, cy - 29, 63, 31, 'none', 'stroke="#547d88" stroke-width="5"')
      + path(`M${cx - 18} ${cy - 112}V${cy - 24}H${cx - 5}V${cy - 112}Z`, '#416e81')
      + line(project(x + 1, y, 25), project(x + 4, y, 25), '#5c838f', 6)
  }
  if (id === 'filter') return shadow(x, y, 65, 25) + box(x - .7, y - .7, 2.5, 1.4, 20, 8) + cylinder(x, y, .4, 125, 8, '#5b8794') + cylinder(x + .9, y, .4, 125, 8, '#8daeb2') + line(project(x, y, 25), project(x + 3, y + 3, 25), '#739aa3', 5)
  if (id === 'pump') return shadow(x, y, 65, 25) + box(x - 1, y - .6, 2, 1.3, 38, 8) + cylinder(x, y, .45, 32, 46, '#8fb4ba')
  if (id.startsWith('cold-') || id === 'freezer') {
    const h = id === 'freezer' ? 73 : 119
    return shadow(x, y, 67, 25) + box(x - 1, y - .8, 2, 1.6, h, 8, ['#e0e9e0', '#a3c0bf', '#638c9e'])
      + frontPanel(x - .8, y + .81, 1.6, h - 16, 16, '#b8d4d2')
      + line(project(x + .52, y + .82, 48), project(x + .52, y + .82, 76), '#4d7988', 3) + tinyScreen(x - .65, y + .83, .55, h - 24, 12)
  }
  if (id === 'spares') return warehouse()
  if (id === 'solar-array') return solar()
  if (id === 'battery') return [0, 1, 2].map(i => box(x - 1 + i * .9, y - .6, .72, 1.3, 99, 8, ['#d7e4d9', '#95b2af', '#688e9b'])).join('')
  if (id === 'co2-tank') return cylinder(x, y, .6, 107, 8) + cylinder(x + 1.2, y, .6, 107, 8)
  if (id === 'quarantine-bay') return quarantine()
  return box(x - .7, y - .5, 1.4, 1, 61, 8) + tinyScreen(x - .5, y + .51, .8, 36, 24)
}
function warehouse() {
  let out = ''
  for (const [x, y, h] of [[18, 33, 36], [21, 33, 58], [24, 33, 36], [18, 37, 33], [22, 37, 33]]) {
    out += shadow(x, y, 53, 20) + box(x - .8, y - .65, 1.6, 1.3, h, 8, ['#c9c9ad', '#9caa99', '#7b9293'])
    out += frontPanel(x - .34, y + .66, .7, 12, h - 10, '#526d76')
    out += line(project(x - .4, y + .67, 17), project(x + .4, y + .67, 17), '#c5d8c8', 1)
  }
  return out
}
function solar() {
  let out = ''
  for (let row = 0; row < 2; row++) {
    out += box(46.3, 16.5 + row * 2.4, 4.2, 1.7, 32, 8, ['#526f80', '#6b858d', '#456573'])
    out += plate(46.4, 16.6 + row * 2.4, 4, 1.5, 40.8, '#3c6178')
    for (let i = 0; i < 6; i++) out += line(project(46.5 + i * .65, 16.6 + row * 2.4, 41), project(46.5 + i * .65, 18.1 + row * 2.4, 41), '#a3c5c3', .9, 'opacity=".55"')
    for (let i = 0; i < 3; i++) out += line(project(46.4, 16.7 + row * 2.4 + i * .55, 41), project(50.4, 16.7 + row * 2.4 + i * .55, 41), '#a3c5c3', .7, 'opacity=".4"')
  }
  return out
}
function quarantine() {
  let out = box(48, 32, 5, 3.8, 9, 8, ['#a9c6bf', '#6f9295', '#537a8c'])
  out += box(48, 32, .18, 3.8, 122, 17) + box(52.82, 32, .18, 3.8, 122, 17) + box(48, 32, 5, .18, 122, 17)
  out += box(48, 32, 5, 3.8, 10, 139, ['#d7e7db', '#90b8bb', '#6f9aa6'])
  out += frontPanel(48.2, 35.79, 4.6, 114, 19, 'url(#glass)')
  out += line(project(50.5, 35.8, 20), project(50.5, 35.8, 132), '#c1dcd2', 2)
  out += cylinder(50.4, 33.9, .6, 52, 17)
  return out
}
function deviceArt(d) {
  const render = d.id === 'liquid-handler' ? dispenser : d.id.startsWith('centrifuge') ? centrifuge : d.id === 'confirm' ? confirmer : d.id === 'screen' ? screener : d.id === 'imager' ? imager : d.id.startsWith('heater') ? heater : d.id.startsWith('robot') ? robot : d.id === 'analysis' ? workstation : facility
  const [cx, cy] = project(d.x, d.y)
  const work = ellipse(cx, cy, 105, 46, 'url(#worklight)', 'class="activity-light"')
  const glyph = text(cx, cy - d.height, '⚒', 22, '#dfeeea', 'class="maintenance-glyph" text-anchor="middle"')
  return `<g class="device" id="device-${d.id}" data-device="${d.id}" data-phase="${d.phase}" data-origin-x="${d.x}" data-origin-y="${d.y}" role="button" tabindex="-1" aria-label="${escapeSvg(d.name)}，${escapeSvg(d.state)}"><title>${escapeSvg(d.name)}：${escapeSvg(d.state)}</title>${work}${ellipse(cx, cy + 7, 90, 39, '#73d1df', 'class="selection-ring" fill-opacity=".12" stroke="#b5f4f2" stroke-width="2"')}<path class="dock-link" d="" stroke="#c8e4df" stroke-width="1.5" stroke-dasharray="3 3" fill="none"/>${render(d)}${glyph}<g class="health-indicator"><circle cx="${cx + 30}" cy="${cy - d.height + 12}" r="12" fill="#5d4147" stroke="#e99891"/><text x="${cx + 30}" y="${cy - d.height + 18}" text-anchor="middle" font-size="17" fill="#fff">!</text></g></g>`
}
export function makeWorld(viewBox = '-650 350 1750 1093.75', devices = deviceCatalog(), crops = []) {
  const objects = []
  for (const region of regions) {
    objects.push({ depth: region.x + region.y - 1, svg: walls(region) })
    if (region.id.startsWith('greenhouse')) objects.push({ depth: region.x + region.y + 10, svg: plants(region, crops) })
  }
  for (const d of devices) objects.push({ depth: d.x + d.y, svg: deviceArt(d) })
  // Charger markings and dock lights stay on the floor, underneath robots.
  let docks = ''
  for (const [x, y] of [[33, 34], [38, 34], [35, 38]]) {
    const [cx, cy] = project(x, y, 9)
    docks += ellipse(cx, cy, 54, 27, 'none', 'stroke="#d7e8dc" stroke-width="2" opacity=".7"')
    docks += box(x - .7, y - 1, 1.4, .32, 28, 8, ['#bcd4cb', '#7da0a9', '#537e92'])
  }
  const art = ground() + floors() + docks + objects.sort((a, b) => a.depth - b.depth).map(o => o.svg).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" class="world-art" viewBox="${viewBox}" role="group" aria-labelledby="world-title world-desc"><title id="world-title">火星实验室</title><desc id="world-desc">可拖动缩放的科研基地。器材工作状态来自所选运行记录。详细操作、样品和数据由悬浮页面查看。</desc>${definitions}${sceneStyle}${art}</svg>`
}
