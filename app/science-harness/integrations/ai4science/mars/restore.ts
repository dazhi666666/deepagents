/** One-shot restoration is launched as a standard dsh recovery profile. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PhaseLedger } from './v06/phase-ledger.ts'
import { z } from 'zod'
import { Checkpoints } from './checkpoints.ts'

export const name = 'science-mars-checkpoint-restore'
export const inject: string[] = []

/** Verify and restore only after the old host has released all runtime leases.
 * @param _ctx Profile context, with no model or device service loaded.
 * @param input Trusted profile paths pointing to an explicit recovery request.
 */
export async function apply(_ctx: object, input: { directory: string; requestFile: string }) {
  const config = z.object({ directory: z.string(), requestFile: z.string() }).strict().parse(input)
  const request = z.object({ checkpointId: z.string().uuid() }).parse(JSON.parse(readFileSync(config.requestFile, 'utf8')))
  const publicFile = join(config.directory, 'manifest.public.json'), phaseFile = `${config.directory}.phase-seals.jsonl`
  const manifest = existsSync(publicFile) ? z.object({ benchmarkVersion: z.enum(['v0.4', 'v0.5', 'v0.6']), implementation: z.string().optional(), protocolHash: z.string().optional() })
    .parse(JSON.parse(readFileSync(publicFile, 'utf8'))) : null
  if (existsSync(phaseFile) && (manifest?.benchmarkVersion !== 'v0.6' || manifest.implementation !== 'scientific_candidate')) throw new Error('Published phases require their original scientific run manifest')
  const identity = manifest?.implementation === 'scientific_candidate' ? z.object({ runId: z.string().uuid() }).parse(JSON.parse(readFileSync(join(config.directory, 'run.json'), 'utf8'))) : null
  const phases = identity ? new PhaseLedger(phaseFile, identity.runId, z.string().length(64).parse(manifest!.protocolHash), true) : null
  const result = await new Checkpoints(config.directory, `${config.directory}.checkpoints`, phases ? {
    restoreGuard: checkpoint => phases.assertCheckpoint(checkpoint.tick, checkpoint.metadata),
  } : {}).restoreStopped(request.checkpointId)
  console.log(JSON.stringify({ restored: request.checkpointId, archive: result.archive, tick: result.manifest.tick, cursor: result.manifest.cursor }))
}
