/* Shared formatting and vocabulary for the Mars views. */
export const SOL_TICKS = 96

export const n = (value, digits = 1) => typeof value === 'number' && Number.isFinite(value)
  ? new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value) : '–'
export const pct = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null
export const clamp = (value) => Math.max(0, Math.min(1, value))
export const sum = (values) => values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)
export const mean = (values) => values.length ? sum(values) / values.length : null

export const STATUS_LABEL = { starting: '启动中', running: '运行中', 'attention-required': '需要关注', 'agent-ended': 'Agent 已结束', completed: '已结算', stopped: '已停止' }
export const STATUS_TONE = { starting: 'idle', running: 'live', 'attention-required': 'warn', 'agent-ended': 'finished', completed: 'succeeded', stopped: 'failed' }

export const EVENT_LABEL = {
  announcement: '公告', 'inline-doc-alarm': '在线 DOC 报警', 'power-shed': '限电', 'battery-low': '电池低电量',
  'chamber-pressure-low': '舱压偏低', 'crop-status-changed': '作物状态变化', 'device-fault': '设备故障',
  'method-revised': '方法修订', 'incident-report': '异常报告',
}
export const EVENT_TONE = {
  announcement: 'info', 'inline-doc-alarm': 'bad', 'power-shed': 'warn', 'battery-low': 'bad',
  'chamber-pressure-low': 'warn', 'crop-status-changed': 'warn', 'device-fault': 'bad', 'method-revised': 'info', 'incident-report': 'info',
}

/** One-line public description of a world event, using only fields the runtime published. */
export function eventText(event, t) {
  const payload = event.payload ?? {}
  switch (event.kind) {
    case 'announcement': return payload.text ?? t('环境公告')
    case 'inline-doc-alarm': return t('{module} 在线 DOC {reading} mg/L，超过阈值 {threshold}', { module: payload.module ?? '', reading: n(payload.reading, 2), threshold: n(payload.threshold, 1) })
    case 'power-shed': return (payload.shed ?? []).length ? t('限电：{loads}', { loads: payload.shed.join('、') }) : t('限电解除')
    case 'battery-low': return t('电池 SOC 降至 {soc}', { soc: n(payload.soc, 1) })
    case 'chamber-pressure-low': return t('{chamber} 气压 {pressure} kPa', { chamber: payload.chamberId ?? '', pressure: n(payload.pressure, 2) })
    case 'crop-status-changed': return t('{crop} → {status}', { crop: payload.id ?? '', status: payload.removed ? t('已移除') : payload.status ?? '' })
    case 'device-fault': return t('{device} 故障', { device: payload.deviceId ?? '' })
    case 'method-revised': return t('方法 {method} 更新为 v{version}', { method: payload.id ?? '', version: payload.version ?? '' })
    case 'incident-report': return t('{category}：{entities}', { category: payload.category ?? '', entities: (payload.entities ?? []).join('、') })
    default: return event.kind
  }
}

export const empty = (text) => `<div class="mars-empty">${text}</div>`
export const bar = (ratio, tone = '') => `<div class="m-bar ${tone}"><i style="width:${Math.round(clamp(ratio) * 100)}%"></i></div>`
export const badge = (text, tone = 'idle') => `<span class="status ${tone}">${text}</span>`

/** Fetch several independent endpoints; a failed optional endpoint becomes null instead of blanking the page. */
export async function settle(promises) {
  const results = await Promise.allSettled(promises)
  return results.map((result) => result.status === 'fulfilled' ? result.value : null)
}
