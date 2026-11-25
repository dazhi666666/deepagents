/** A response acknowledges only the cancellation intent known when its provider call began. */
import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionEngine } from './execution.ts'
import type { ExecutionProvider } from './sdk.ts'

it.each(['query', 'cancel'] as const)('forwards a newer cancellation after a busy provider %s', async (busy) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai4s-cancel-intent-'))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let holdQuery = false, cancellations = 0
  const provider: ExecutionProvider = {
    describe: () => ({ apiVersion: 1, id: 'work', version: '1', configuration: {},
      inputSchema: {}, outputSchema: {}, units: { budget: 'run' }, constraints: [],
      completion: 'An explicit observation confirms completion.', cancellation: 'An earlier refusal may be retried.' }),
    prepare: input => ({ input, resources: ['device'], budget: 1 }),
    submit: async () => ({ state: 'running' }),
    query: async () => {
      if (holdQuery) { entered.resolve(); await release.promise }
      return { state: 'running' }
    },
    cancel: async () => {
      cancellations += 1
      if (cancellations === 1) {
        if (busy === 'cancel') { entered.resolve(); await release.promise }
        return { disposition: 'rejected', detail: 'Not yet interruptible' }
      }
      return { disposition: 'requested', observation: { state: 'cancelled' } }
    },
  }
  const make = () => new ExecutionEngine({ directory, providers: [provider], pollIntervalMs: 5, providerCallTimeoutMs: 5000 })
  const first = make(), second = make()
  try {
    await first.open()
    first.createProject('p', 10)
    const a = first.issueContext('p', 'a', ['work'])
    const operation = await first.submit(a, { providerId: 'work', requestKey: 'one', input: null })
    await second.open({ recover: false })
    const b = second.issueContext('p', 'b', ['work'])
    let active: Promise<unknown>
    if (busy === 'query') {
      await first.cancel(a, operation.id)
      holdQuery = true
      active = first.query(a, operation.id)
    } else active = first.cancel(a, operation.id)
    await entered.promise
    const pending = await second.cancel(b, operation.id)
    expect(pending.cancelRequested).toBe(true)
    expect(pending.state).toBe('running')
    holdQuery = false
    release.resolve()
    await active
    const cancelled = await second.query(b, operation.id)
    expect(cancelled.state).toBe('cancelled')
    expect(cancellations).toBe(2)
    expect(cancelled.budget).toBe(1)
    const events = second.events(b) as { type: string }[]
    expect(events.filter(event => event.type === 'cancel-requested')).toHaveLength(2)
    expect(events.filter(event => event.type === 'registered')).toHaveLength(1)
  } finally {
    release.resolve()
    await second.close()
    await first.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
