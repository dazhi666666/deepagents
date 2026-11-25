/** Optional role recommendations owned by one native preset's isolated service realm. */
import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'

/** Route fields are optional so a template can inherit the native host model selection. */
export const roleModelSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
}).strict()

/** Defaults supply only role instructions, tools and route fields; organization policy stays explicit. */
export const presetDefaultsSchema = z.object({
  instructions: z.string().optional(),
  tools: z.array(z.string().min(1)).optional(),
  model: roleModelSchema.optional(),
}).strict()
/** Validated recommendations published by the isolated preset service. */
export type PresetDefaults = z.infer<typeof presetDefaultsSchema>

declare module '@deepseek-ai/cordis' {
  interface Context {
    ai4scienceRoleDefaults: RoleDefaults
  }
}

/** Mount inside a cordis:group isolating ai4scienceRoleDefaults; read through agentPresets.serviceFor(). */
export default class RoleDefaults extends Service {
  readonly defaults: PresetDefaults
  constructor(ctx: Context, config: PresetDefaults) {
    super(ctx, 'ai4scienceRoleDefaults')
    this.defaults = presetDefaultsSchema.parse(config)
  }
}
