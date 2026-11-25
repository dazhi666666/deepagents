/** Pause native admissions until every writer reaches a recoverable boundary. */
export class AdmissionBarrier {
  held = false
  models = 0
  writes = 0
  private readonly parked = new Map<string, number>()
  private released = Promise.withResolvers<void>()

  /** Park one native request or tool without consuming simulated time. */
  async enter(actorId: string, signal: AbortSignal): Promise<void> {
    while (this.held) {
      this.parked.set(actorId, (this.parked.get(actorId) ?? 0) + 1)
      const aborted = Promise.withResolvers<never>()
      const onAbort = () => aborted.reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        signal.throwIfAborted()
        await Promise.race([this.released.promise, aborted.promise])
      } finally {
        signal.removeEventListener('abort', onAbort)
        const count = this.parked.get(actorId)! - 1
        if (count) this.parked.set(actorId, count); else this.parked.delete(actorId)
      }
    }
  }
  /** Whether a member is blocked before starting another model or tool call. */
  isParked(actorId: string) { return this.parked.has(actorId) }
  /** Hold admissions until the returned release callback is invoked. */
  hold() {
    if (this.held) throw new Error('Checkpoint admission barrier already held')
    this.held = true
    return () => {
      this.held = false
      this.released.resolve()
      this.released = Promise.withResolvers<void>()
    }
  }
}
