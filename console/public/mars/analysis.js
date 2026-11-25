/* 分析运行：列表、代码、输出与日志、被哪些提交引用。 */
import { badge, empty, n } from './common.js'

export function createAnalysis(ctx) {
  const { api, t, esc, state, mars } = ctx
  const rootId = 'mars-analysis-root'
  let busy = false
  let data = { snapshot: null, runs: [], selected: null, record: null }

  async function load(force) {
    if (busy) return
    busy = true
    try {
      const snapshot = await api.snapshot(force)
      const runs = await api.analysisRuns().catch(() => [])
      const selected = mars.analysisId && runs.some((run) => run.id === mars.analysisId) ? mars.analysisId : runs.at(-1)?.id ?? null
      const record = selected ? await api.analysisRun(selected).catch(() => null) : null
      data = { snapshot, runs, selected, record }
    } catch (error) {
      if (document.getElementById(rootId)) document.getElementById(rootId).innerHTML = empty(esc(error.message))
    } finally { busy = false }
  }

  function paint() {
    if (!data.snapshot || !document.getElementById('m-analysis-list') || state.view !== 'mars-analysis') return
    const { runs, selected, record } = data
    document.getElementById('m-analysis-list').innerHTML = runs.length
      ? `<table class="m-table"><thead><tr><th>${t('运行')}</th><th>${t('执行者')}</th><th>${t('记录步')}</th><th>${t('状态')}</th><th>${t('代码哈希')}</th><th>${t('引用')}</th></tr></thead><tbody>
        ${runs.slice().reverse().map((run) => `<tr data-run="${esc(run.id)}" class="${run.id === selected ? 'active' : ''}">
          <td class="mono">${esc(run.id.slice(-12))}</td><td class="mono">${esc(String(run.actorId).slice(-10))}</td><td>${run.asOfTick}</td>
          <td>${badge(run.status === 'done' ? t('成功') : t('失败'), run.status === 'done' ? 'succeeded' : 'failed')}</td>
          <td class="mono">${esc(run.codeSha256.slice(0, 10))}…</td><td>${(run.references ?? []).length}</td></tr>`).join('')}</tbody></table>`
      : empty(t('还没有分析运行。'))
    document.getElementById('m-analysis-detail').innerHTML = record ? `<section class="card">
        <div class="card-head"><span class="card-title">${t('分析运行')} <span class="mono">${esc(record.id)}</span></span><span class="spacer"></span>
          ${badge(record.status === 'done' ? t('成功') : t('失败'), record.status === 'done' ? 'succeeded' : 'failed')}</div>
        <div class="m-kv"><span>${t('执行者')}</span><b class="mono">${esc(record.actorId)}</b><span>${t('记录步')}</span><b>${record.asOfTick}</b>
          <span>${t('代码字节')}</span><b>${n(new TextEncoder().encode(record.code).length, 0)}</b><span>${t('代码哈希')}</span><b class="mono">${esc(record.codeSha256.slice(0, 16))}…</b></div>
        ${record.error ? `<div class="m-notice bad">${esc(record.error)}</div>` : ''}
        <div class="block-title">${t('代码')}</div>
        <div class="m-code"><table><tbody>${String(record.code).split('\n').map((line, index) => `<tr><td class="m-line">${index + 1}</td><td><code>${esc(line) || ' '}</code></td></tr>`).join('')}</tbody></table></div>
        <details><summary>${t('输出 JSON')}</summary><pre>${esc(JSON.stringify(record.output, null, 2))}</pre></details>
        <details><summary>${t('日志（{n} 行）', { n: (record.logs ?? []).length })}</summary><pre>${esc((record.logs ?? []).join('\n'))}</pre></details>
      </section>` : (selected ? `<div class="m-note">${t('加载分析运行…')}</div>` : '')
    document.querySelectorAll('[data-run]').forEach((row) => (row.onclick = () => {
      mars.analysisId = row.dataset.run
      load(true).then(paint)
    }))
  }

  return {
    section: '火星基地',
    title: '分析运行',
    mount(stage) {
      stage.innerHTML = `<div id="${rootId}" class="mars">
        <div class="card-head m-page-head"><span class="card-title">${t('分析运行')}</span><span class="spacer"></span><span class="m-sub">${t('模型写的程序 · 隔离进程 · 可重跑')}</span></div>
        <section class="card"><div id="m-analysis-list"></div></section>
        <div id="m-analysis-detail"></div>
      </div>`
      load(false).then(paint)
    },
    update(kind) {
      if (document.hidden || state.view !== 'mars-analysis') return
      load(kind === 'refresh' || kind === 'all').then(paint)
    },
  }
}
