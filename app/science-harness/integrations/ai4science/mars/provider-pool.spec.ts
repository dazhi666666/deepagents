/** Account-pool routing: tier preference, rotation, cooldown and all-cooling fallback. */
import { expect, it } from 'vitest'
import { ProviderPool } from './provider-pool.ts'

function clock(start = 0) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

it('rotates inside the first tier and never uses a later tier while it is ready', () => {
  const pool = new ProviderPool({ tiers: [['chat-1', 'chat-2'], ['disc-1']], now: clock().now })
  expect([pool.select(), pool.select(), pool.select(), pool.select()]).toEqual(['chat-1', 'chat-2', 'chat-1', 'chat-2'])
})

it('cools a failing account and keeps rotating the remaining ones', () => {
  const time = clock()
  const pool = new ProviderPool({ tiers: [['chat-1', 'chat-2'], ['disc-1']], now: time.now })
  pool.cool('chat-1', 'RATE_LIMIT')
  expect(pool.select()).toBe('chat-2')
  expect(pool.select()).toBe('chat-2')
  expect(pool.cooldown('chat-1')?.remainingMs).toBe(60_000)
})

it('falls through to the next tier only when the earlier tier is fully cooling', () => {
  const time = clock()
  const pool = new ProviderPool({ tiers: [['chat-1', 'chat-2'], ['disc-1']], now: time.now })
  pool.cool('chat-1', 'RATE_LIMIT')
  pool.cool('chat-2', 'RATE_LIMIT')
  expect(pool.select()).toBe('disc-1')
  time.advance(60_001)
  expect(['chat-1', 'chat-2']).toContain(pool.select())
})

it('uses the account that recovers first when every tier is cooling', () => {
  const time = clock()
  const pool = new ProviderPool({ tiers: [['chat-1', 'chat-2'], ['disc-1']], now: time.now })
  pool.cool('chat-1', 'RATE_LIMIT')
  time.advance(10_000)
  pool.cool('chat-2', 'RATE_LIMIT')
  time.advance(5_000)
  pool.cool('disc-1', 'RATE_LIMIT')
  expect(pool.select()).toBe('chat-1')
})

it('keeps the longer cooldown when a provider is cooled twice', () => {
  const time = clock()
  const pool = new ProviderPool({ tiers: [['chat-1'], ['disc-1']], now: time.now })
  pool.cool('chat-1', 'RATE_LIMIT')
  const until = pool.cooldown('chat-1')!.until
  time.advance(30_000)
  pool.cool('chat-1', 'RATE_LIMIT')
  expect(pool.cooldown('chat-1')!.until).toBeGreaterThan(until)
})

it('rejects duplicate or empty tiers', () => {
  expect(() => new ProviderPool({ tiers: [] })).toThrow()
  expect(() => new ProviderPool({ tiers: [[], ['a']] })).toThrow()
  expect(() => new ProviderPool({ tiers: [['a'], ['a']] })).toThrow()
})
