/** Per-world busy acknowledgements and durable-notice transport. Timers only retry existing notices. */
const same = (a, b) => a !== null && a.length === b.length && a.every((id, i) => id === b[i])

/** Coalesce only this world's snapshots; a failed acknowledgement never becomes accepted state. */
export function createBusySender(rpc, { timeoutMs = 30000, onAccepted = () => {} } = {}) {
  let accepted = null, desired = [], work = null
  async function flush() {
    if (work) { await work; if (!same(accepted, desired)) return flush(); return }
    const task = (async () => {
      while (!same(accepted, desired)) {
        const snapshot = [...desired]
        await rpc.call('busy.set', { sessions: snapshot }, timeoutMs, { lane: 'control' })
        accepted = snapshot
        onAccepted([...snapshot])
      }
    })()
    work = task
    try { await task } finally { if (work === task) work = null }
    if (!same(accepted, desired)) return flush()
  }
  return {
    update(sessions) { desired = [...new Set(sessions)].sort(); return flush() },
    accepted: () => accepted === null ? null : [...accepted],
  }
}

/** One independently drained notification stream per world; no idle status polling. */
export class MarsNoticePump {
  constructor(rpc, { getClient, onState, prepareNotice = async () => {}, log = () => {}, retryDelayMs = 250, maxRetryDelayMs = Math.max(5000, retryDelayMs), agent = 'mars' }) {
    this.rpc = rpc; this.getClient = getClient; this.onState = onState; this.prepareNotice = prepareNotice; this.log = log; this.agent = agent
    this.retryDelayMs = retryDelayMs; this.maxRetryDelayMs = maxRetryDelayMs; this.failures = 0; this.snapshot = null; this.active = false; this.disposed = false
    this.work = null; this.retryTimer = null; this.sent = new Set(); this.acknowledged = new Set()
    this.unsubscribe = rpc.onEvent(message => { if (message.event === 'mars.control') this.accept(message.result) })
  }
  accept(snapshot) {
    if (this.disposed || !snapshot || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.notices)) return
    if (this.snapshot && snapshot.revision < this.snapshot.revision) return
    this.snapshot = snapshot
    const current = new Set(snapshot.notices.map(n => n.id))
    for (const id of this.sent) if (!current.has(id)) this.sent.delete(id)
    for (const id of this.acknowledged) if (!current.has(id)) this.acknowledged.delete(id)
    this.onState(snapshot.round)
    if (this.active) void this.deliverPending()
  }
  async initialize() { this.accept(await this.rpc.call('control.snapshot', {}, 30000, { lane: 'control' })) }
  start() { this.active = true; return this.deliverPending() }
  has(id) { return this.snapshot?.notices.some(n => n.id === id) === true && !this.acknowledged.has(id) }
  retry() {
    if (this.disposed || this.retryTimer || !this.snapshot?.notices.some(n => !this.acknowledged.has(n.id))) return
    const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** Math.min(this.failures++, 10))
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.deliverPending() }, delay)
    this.retryTimer.unref?.()
  }
  async deliver(notice, client) {
    if (notice.kind === 'closed') {
      const result = await client.session.abort({ path: { id: notice.sessionId } })
      if (result?.error) throw new Error(JSON.stringify(result.error))
      if (this.disposed) return
      await this.rpc.call('notices.ack', { id: notice.id }, 30000, { lane: 'control' })
      this.acknowledged.add(notice.id); this.failures = 0
      return
    }
    const prefix = `[Mars 宿主通知 ${notice.id}]\n`
    const lookup = async () => {
      const result = await client.session.messages({ path: { id: notice.sessionId } })
      if (result?.error) throw new Error(JSON.stringify(result.error))
      const rows = result?.data ?? result
      if (!Array.isArray(rows)) throw new Error('Engine notice history is unavailable')
      return rows.find(row => row.parts?.some(part => part.type === 'text'
        && (part.metadata?.marsNotice === notice.id || part.text?.startsWith(prefix))))
    }
    let stored = await lookup()
    if (!stored && !this.sent.has(notice.id)) {
      if (!this.has(notice.id) || this.disposed) return
      await this.prepareNotice(notice)
      if (!this.has(notice.id) || this.disposed) return
      this.sent.add(notice.id)
      const result = await client.session.promptAsync({ path: { id: notice.sessionId }, body: {
        agent: this.agent, noReply: notice.kind === 'report',
        parts: [{ type: 'text', text: prefix + notice.text, metadata: { marsNotice: notice.id, kind: notice.kind } }],
      } })
      if (result?.error) { this.sent.delete(notice.id); throw new Error(JSON.stringify(result.error)) }
      if (this.disposed) return
      stored = await lookup()
    }
    if (!stored) throw new Error(`Host notice persistence pending: ${notice.id}`)
    if (this.disposed || !this.has(notice.id)) return
    await this.rpc.call('notices.ack', { id: notice.id, messageId: stored.info.id }, 30000, { lane: 'control' })
    this.acknowledged.add(notice.id); this.failures = 0
  }
  deliverPending() {
    if (this.disposed || !this.active || !this.getClient()) return Promise.resolve()
    if (this.work) return this.work
    const task = (async () => {
      try {
        while (!this.disposed) {
          const notices = this.snapshot?.notices.filter(n => !this.acknowledged.has(n.id)) ?? []
          if (!notices.length) return
          for (const notice of notices) if (this.has(notice.id) && !this.disposed) await this.deliver(notice, this.getClient())
        }
      } catch (error) {
        if (!this.disposed) { this.log(error); this.retry() }
      }
    })()
    this.work = task
    task.finally(() => {
      if (this.work === task) this.work = null
      if (!this.disposed && this.active && !this.retryTimer && this.snapshot?.notices.some(n => !this.acknowledged.has(n.id))) void this.deliverPending()
    }).catch(() => {})
    return task
  }
  dispose() {
    this.disposed = true; this.active = false
    clearTimeout(this.retryTimer); this.retryTimer = null; this.unsubscribe()
    this.sent.clear(); this.acknowledged.clear()
  }
}
