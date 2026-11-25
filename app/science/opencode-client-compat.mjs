/** Normalize the two SDK session-get argument conventions on this injected client instance. */
export function adaptSessionGet(client) {
  const session = client?.session, original = session?.get
  if (typeof original !== 'function') return () => {}
  const descriptor = Object.getOwnPropertyDescriptor(session, 'get')
  function compatibleGet(options = {}, ...rest) {
    const ids = [options.sessionID, options.id, options.path?.id, options.path?.sessionID].filter(value => typeof value === 'string' && value.length)
    if (new Set(ids).size > 1) throw new Error('Conflicting session identifiers in SDK request')
    if (!ids.length) return original.call(this, options, ...rest)
    const id = ids[0]
    return original.call(this, { ...options, sessionID: id, path: { ...options.path, id, sessionID: id } }, ...rest)
  }
  Object.defineProperty(session, 'get', { value: compatibleGet, writable: true, configurable: true })
  return () => {
    if (session.get !== compatibleGet) return
    if (descriptor) Object.defineProperty(session, 'get', descriptor)
    else delete session.get
  }
}
