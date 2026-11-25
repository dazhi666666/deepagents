/**
 * Ordered account pool for model providers.
 *
 * Tiers are tried left to right. Inside a tier the ready providers rotate so
 * concurrent agents spread over every account. A provider that reports a
 * rate-limit, quota or auth failure is cooled down and skipped until the
 * cooldown expires; when every provider is cooling, the one that recovers
 * first is used so requests still make progress.
 */

/** Default cooldown per provider-neutral failure code, in milliseconds. */
export const DEFAULT_COOLDOWNS: Readonly<Record<string, number>> = {
  RATE_LIMIT: 60_000,
  QUOTA: 15 * 60_000,
  ACCOUNT_QUOTA: 15 * 60_000,
  AUTH: 60 * 60_000,
}

/** Failure codes that take an account out of rotation. */
export const COOLING_CODES: ReadonlySet<string> = new Set(Object.keys(DEFAULT_COOLDOWNS))

export interface ProviderPoolOptions {
  /** Ordered groups; providers in earlier tiers are preferred. */
  tiers: string[][]
  /** Cooldown for codes without a specific entry. */
  cooldownMs?: number
  /** Per-code overrides merged over {@link DEFAULT_COOLDOWNS}. */
  cooldowns?: Record<string, number>
  /** Injectable clock for tests. */
  now?: () => number
}

export interface ProviderCooldown {
  provider: string
  code: string
  until: number
  remainingMs: number
}

export class ProviderPool {
  readonly tiers: string[][]
  readonly providers: string[]
  private readonly cooldowns: Record<string, number>
  private readonly fallbackCooldown: number
  private readonly now: () => number
  private readonly cursor: number[]
  private readonly cooling = new Map<string, { code: string; until: number }>()

  constructor(options: ProviderPoolOptions) {
    if (!options.tiers.length) throw new Error('Provider pool needs at least one tier')
    const seen = new Set<string>()
    for (const tier of options.tiers) {
      if (!tier.length) throw new Error('Provider pool tiers cannot be empty')
      for (const provider of tier) {
        if (!provider) throw new Error('Provider pool entries cannot be empty')
        if (seen.has(provider)) throw new Error(`Provider ${provider} appears in more than one tier`)
        seen.add(provider)
      }
    }
    this.tiers = options.tiers.map(tier => [...tier])
    this.providers = this.tiers.flat()
    this.cooldowns = { ...DEFAULT_COOLDOWNS, ...options.cooldowns }
    this.fallbackCooldown = options.cooldownMs ?? 60_000
    this.now = options.now ?? (() => Date.now())
    this.cursor = this.tiers.map(() => 0)
  }

  /** Select the next provider: earliest ready tier, rotating inside it. */
  select(): string {
    const now = this.now()
    for (let index = 0; index < this.tiers.length; index++) {
      const tier = this.tiers[index]!
      const ready = tier.filter(provider => !this.isCooling(provider, now))
      if (ready.length) {
        const position = this.cursor[index] ?? 0
        this.cursor[index] = position + 1
        return ready[position % ready.length]!
      }
    }
    // Every account is cooling: use the one whose cooldown ends first.
    let best = this.providers[0]!
    for (const provider of this.providers) {
      const until = this.cooling.get(provider)?.until ?? 0
      if (until < (this.cooling.get(best)?.until ?? 0)) best = provider
    }
    return best
  }

  /** Take a provider out of rotation; returns the applied cooldown. */
  cool(provider: string, code: string): ProviderCooldown {
    if (!this.providers.includes(provider)) throw new Error(`Provider ${provider} is not in the pool`)
    const duration = this.cooldowns[code] ?? this.fallbackCooldown
    const until = this.now() + duration
    const previous = this.cooling.get(provider)
    if (!previous || until > previous.until) this.cooling.set(provider, { code, until })
    return this.cooldown(provider)!
  }

  /** Current cooldown for one provider, or null when it is ready. */
  cooldown(provider: string): ProviderCooldown | null {
    const entry = this.cooling.get(provider)
    if (!entry) return null
    return { provider, code: entry.code, until: entry.until, remainingMs: Math.max(0, entry.until - this.now()) }
  }

  /** Non-expired cooldowns, for diagnostics and tests. */
  snapshot(): ProviderCooldown[] {
    return this.providers.map(provider => this.cooldown(provider)).filter((entry): entry is ProviderCooldown => entry !== null)
  }

  private isCooling(provider: string, now: number): boolean {
    return (this.cooling.get(provider)?.until ?? 0) > now
  }
}
