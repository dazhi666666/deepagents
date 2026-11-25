/** Native profile entry for the keyless public shared-world feasibility strategy. */
import type { Context } from '@deepseek-ai/cordis'
import { inject, type Config } from '../runtime.ts'
import { runReferenceFeasibility } from './feasibility.ts'
export { inject }
export const name = 'science-mars-public-reference'
/** Uses only the environment configuration; any model mode is rejected before mounting. */
export async function apply(ctx: Context, config: Config) { await runReferenceFeasibility(ctx, config) }
