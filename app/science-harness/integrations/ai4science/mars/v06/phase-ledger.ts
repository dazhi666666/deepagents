/** Published phases are irreversible even when a world/session checkpoint is restored. */
import { MarsAudit } from '../audit.ts'
import { phaseSealSchema, type PhaseSeal } from './stages.ts'
import { z } from 'zod'
import { contentHash } from './contracts.ts'
const entrySchema = z.object({ runId: z.string(), protocolHash: z.string(), seal: phaseSealSchema }).strict()
export class PhaseLedger {
  private readonly audit: MarsAudit
  constructor(private readonly path: string, private readonly runId: string, private readonly protocolHash: string, private readonly readOnly = false) {
    this.audit = new MarsAudit(path)
  }
  published(): PhaseSeal[] {
    const entries = new MarsAudit(this.path).read().map(row => {
      if (row.kind !== 'phase-seal') throw new Error('Unknown durable phase entry')
      const entry = entrySchema.parse(row.data)
      if (entry.runId !== this.runId || entry.protocolHash !== this.protocolHash) throw new Error('Published phases belong to a different run/protocol')
      const { hash, ...body } = entry.seal
      if (contentHash(body) !== hash) throw new Error('Published phase seal hash changed')
      return entry.seal
    })
    let previous: string | null = null
    for (const seal of entries) { if (seal.previousSealHash !== previous) throw new Error('Durable phase chain is inconsistent'); previous = seal.hash }
    return entries
  }
  /** Called while the stopped-run replacement lease is held, before any files are copied. */
  assertCheckpoint(tick: number, metadata: unknown) {
    const published = this.published()
    if (!published.length) return
    const state = z.object({ runId: z.string(), protocolHash: z.string(), phaseSeals: z.array(z.object({ tick: z.number(), hash: z.string() })) }).parse(metadata)
    if (state.runId !== this.runId || state.protocolHash !== this.protocolHash || published.some((seal, i) => tick < seal.tick || state.phaseSeals[i]?.hash !== seal.hash))
      throw new Error('Checkpoint would reopen or change a published phase seal')
  }
  /** Refuse an earlier checkpoint rather than republishing predictions after validation. */
  synchronize(worldTick: number, seals: PhaseSeal[]) {
    const published = this.published()
    if (published.some((seal, i) => worldTick < seal.tick || seals[i]?.hash !== seal.hash))
      throw new Error('Checkpoint would reopen or change a published phase seal')
    for (const seal of seals.slice(published.length)) {
      if (this.readOnly) throw new Error('Offline evaluation found an unpublished phase seal')
      this.audit.append('phase-seal', { runId: this.runId, protocolHash: this.protocolHash, seal })
    }
  }
}
