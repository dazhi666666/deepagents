/** Multiplexed NDJSON calls and unsolicited sidecar events, with owned failure and teardown. */
import { createInterface } from 'node:readline'

export function connectSidecar(child, { label, log = () => {} }) {
  const waiting = new Map(), listeners = new Set()
  let failure = null, sequence = 0, closeWork = null
  const fail = error => {
    failure ??= error
    for (const pending of waiting.values()) pending.reject(failure)
    waiting.clear()
  }
  child.stderr.on('data', log)
  child.on('error', error => { log(`${label}: ${error.message}\n`); fail(error) })
  child.on('exit', (code, signal) => { log(`${label} exited: ${code ?? signal}\n`); fail(new Error(`${label} exited: ${code ?? signal}`)) })
  child.stdin.on('error', fail)
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (typeof message.event === 'string') {
      for (const listener of listeners) {
        try { Promise.resolve(listener(message)).catch(error => log(`${label} event observer: ${error.message}\n`)) }
        catch (error) { log(`${label} event observer: ${error.message}\n`) }
      }
      return
    }
    const pending = waiting.get(message.id)
    if (!pending) return
    waiting.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error || `${label} error`))
  })
  // lane is a diagnostic hint, not a client FIFO: one held call must never block cancellation/control.
  function call(method, params = {}, timeoutMs = 120000, { lane = 'serial' } = {}) {
    if (failure) return Promise.reject(failure)
    if (child.stdin.destroyed || child.stdin.writableEnded) return Promise.reject(new Error(`${label} is closed`))
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = timeoutMs === 0 ? null : setTimeout(() => {
        waiting.delete(id)
        reject(new Error(`${label} timeout: ${method} (inflight=${waiting.size})`))
      }, timeoutMs)
      const pending = { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } }
      waiting.set(id, pending)
      try { child.stdin.write(`${JSON.stringify({ id, method, params, lane })}\n`, error => { if (error) fail(error) }) }
      catch (error) { waiting.delete(id); pending.reject(error) }
    })
  }
  function onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) }
  function close() {
    if (closeWork) return closeWork
    closeWork = (async () => {
      fail(new Error(`${label} is closing`))
      try {
        if (child.exitCode !== null || child.signalCode !== null) return
        await new Promise((resolve, reject) => {
          let timer
          const cleanup = () => { clearTimeout(timer); child.off('exit', exited); child.off('error', errored) }
          const exited = () => { cleanup(); resolve() }
          const errored = error => { cleanup(); reject(error) }
          child.once('exit', exited); child.once('error', errored)
          timer = setTimeout(() => {
            if (!child.kill() && child.exitCode === null && child.signalCode === null) errored(new Error(`${label} could not terminate`))
          }, 5000)
          child.stdin.end()
        })
      } finally { lines.close(); listeners.clear() }
    })()
    return closeWork
  }
  return { call, close, child, onEvent }
}
