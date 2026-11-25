/** Durable organization facts; native catalogs supply lineage, never role authority. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { Participant } from './organization.ts'
import { jsonValue } from './tool.ts'

/** Ordered facts from one durable store; writes must settle only after persistence. */
export interface OrganizationFacts {
  readFacts(): readonly { kind: string; data: unknown }[]
  record(kind: string, data: Participant | Record<string, unknown>): void | Promise<void>
}

const membershipSchema = z.object({
  id: z.string().min(1).transform(SessionId),
  project: z.string().min(1),
  role: z.string().min(1),
  parentId: z.string().min(1).transform(SessionId).optional(),
  depth: z.number().int().nonnegative(),
  task: z.string(),
})

/** Latest durable membership outcome, including unresolved reservations. */
export interface Membership {
  participant: Participant
  failed: boolean
}

/** Fold persisted participant facts, rejecting contradictory identity assignments.
 * @param facts Ordered facts in the organization's authoritative store.
 * @param project Project whose membership is requested.
 * @returns Recorded members; the caller scopes them to its freshly enrolled native root.
 */
export function readMembership(facts: ReturnType<OrganizationFacts['readFacts']>, project: string): Map<SessionId, Membership> {
  const members = new Map<SessionId, Membership>()
  for (const fact of facts) {
    if (!['participant-reserved', 'participant-created', 'participant-create-failed', 'participant-resumed'].includes(fact.kind)) continue
    const { parentId, ...parsed } = membershipSchema.parse(fact.data)
    const participant: Participant = { ...parsed, ...(parentId === undefined ? {} : { parentId }) }
    if (participant.project !== project) continue
    const previous = members.get(participant.id)?.participant
    if (previous && (previous.role !== participant.role || previous.parentId !== participant.parentId ||
      previous.depth !== participant.depth)) throw new Error('Conflicting durable participant identity')
    members.set(participant.id, { participant, failed: fact.kind === 'participant-create-failed' })
  }
  return members
}

/** Open the standalone plugin's sole fact store on the configured host storage backend.
 * @param ctx Host with an explicitly mounted storage-domain provider.
 * @param project Organization project used to name the durable domain.
 * @returns Ordered fact access and its caller-owned close; drain organization work before closing it.
 */
export async function openOrganizationFacts(ctx: Context, project: string): Promise<OrganizationFacts & { close(): Promise<void> }> {
  const storage = ctx.get('storageDomain')
  if (!storage) throw new Error('Organization requires durable fact hooks or the storage-domain service')
  const domain = await storage.open(defineDomain({
    name: `ai4science_organization_${createHash('sha256').update(project).digest('hex').slice(0, 32)}`,
    version: 1,
    tables: { facts: domainTable(z.object({ sequence: z.number().int().positive(), kind: z.string().min(1), data: z.json() })) },
  }))
  const facts = domain.table('facts')
  let sequence = [...facts.entries()].reduce((last, [, value]) => Math.max(last, value.sequence), 0)
  return {
    close: () => domain.close(),
    readFacts: () => [...facts.entries()].map(([, value]) => value).sort((a, b) => a.sequence - b.sequence),
    record: (kind, data) => {
      const next = ++sequence
      return facts.put(String(next), { sequence: next, kind, data: jsonValue(data) })
    },
  }
}
