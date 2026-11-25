/** Escaped presentation helpers shared by all offline pages. */
export function esc(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }
export function num(value, digits = 2) { return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '未记录' }
export function empty(message = '这份运行记录中没有此项内容。') { return `<p class="sheet-empty">${esc(message)}</p>` }
export function jsonView(value, title = '查看原始记录') { return `<details class="json-view"><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(value ?? null, null, 2))}</pre></details>` }
export function table(headers, rows, caption = '') { return rows.length ? `<div class="table-scroll"><table>${caption ? `<caption>${esc(caption)}</caption>` : ''}<thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty() }
export function kv(entries) { return `<dl class="values-list">${entries.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value ?? '未记录')}</dd>`).join('')}</dl>` }
export function actionButton(action, value, text) { return `<button class="inline-button" data-action="${esc(action)}" data-value="${esc(value)}">${esc(text)}</button>` }
export function recordRow(title, subtitle, action = '') { return `<article class="record"><div class="record-main"><h4>${esc(title)}</h4><p>${esc(subtitle)}</p></div>${action}</article>` }
export function downloadJson(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }), url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000)
}
