/** Native preset selection, isolated recommendations and durable role tool ceilings. */
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { presetDefaultsSchema, roleModelSchema, type PresetDefaults } from './preset-defaults.ts'
import type { OrganizationFacts } from './organization-membership.ts'

/** Preset-free roles retain the original required instructions, complete route and tools. */
export const roleSchema = z.object({
  preset: z.string().min(1).refine(id => id.trim().length > 0, 'Preset id must not be blank').optional(),
  instructions: z.string().optional(),
  model: roleModelSchema.optional(),
  tools: z.array(z.string().min(1)).optional(),
  creates: z.record(z.string(), z.number().int().positive()),
  maxInstances: z.number().int().positive(),
}).strict().superRefine((role, ctx) => {
  if (role.preset !== undefined) return
  for (const key of ['instructions', 'tools'] as const) {
    if (role[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: `Role without preset requires ${key}` })
  }
  if (!role.model?.provider || !role.model.model)
    ctx.addIssue({ code: 'custom', path: ['model'], message: 'Role without preset requires provider and model' })
})
/** Parsed role policy before optional native recommendations are resolved. */
export type RoleConfig = z.infer<typeof roleSchema>

/** Resolved role recommendation; an absent model leaves the native route untouched. */
export interface ResolvedRole {
  preset?: string
  instructions: string
  tools: string[]
  model: AgentOptions
}

function registry(ctx: Context) {
  const presets = ctx.get('agentPresets')
  if (!presets) throw new Error('Role presets require the explicitly mounted agentPresets service')
  return presets
}

/** Resolve all opt-in roles after Host activation, using temporary bindings in the native registry.
 * @param ctx Existing Host with any explicitly mounted preset registry and declarations.
 * @param roles Parsed role policy; no preset bypasses the registry entirely.
 * @returns Effective instructions, tools and route fields; missing defaults and broken presets reject enrollment.
 */
export async function resolveRoles(ctx: Context, roles: Record<string, RoleConfig>): Promise<Map<string, ResolvedRole>> {
  if (Object.values(roles).some(role => role.preset !== undefined)) {
    registry(ctx)
    // Native preset diagnostics may await the Host; enrollment inside a loading Host row would wait on itself.
    if ([...ctx.loader.entries()].some(entry => entry.fiber?.state === FiberState.LOADING))
      throw new Error('Role preset enrollment requires settled Host activation; enroll the root after Loader startup')
  }
  const resolved = new Map<string, ResolvedRole>()
  for (const [name, role] of Object.entries(roles)) {
    let defaults: PresetDefaults = {}
    if (role.preset !== undefined) {
      const presets = registry(ctx)
      const metadata = await presets.resolve(role.preset)
      if (metadata.broken !== undefined) throw new Error(`Role ${name} preset ${role.preset}: ${metadata.broken}`)
      const scope = createScope(ctx, {})
      try {
        await presets.mount(scope.ctx, role.preset)
        const supplied = presets.serviceFor({ ctx: scope.ctx }, 'ai4scienceRoleDefaults')
        if (supplied !== undefined) defaults = presetDefaultsSchema.parse(supplied.defaults)
      } finally { await scope.dispose() }
    }
    const instructions = role.instructions ?? defaults.instructions
    const tools = role.tools ?? defaults.tools
    if (instructions === undefined || tools === undefined)
      throw new Error(`Role ${name} requires explicit instructions/tools or ai4scienceRoleDefaults from preset ${role.preset}`)
    if (role.tools !== undefined && defaults.tools !== undefined &&
      (role.tools.length !== defaults.tools.length || role.tools.some(tool => !defaults.tools!.includes(tool))))
      ctx.logger.info(`AI4Science role ${name}: explicit tools override preset ${role.preset} recommendations`)
    const model = { ...defaults.model, ...role.model }
    resolved.set(name, { ...(role.preset === undefined ? {} : { preset: role.preset }), instructions,
      tools: [...tools], model: {
        ...(model.provider === undefined ? {} : { provider: model.provider }),
        ...(model.model === undefined ? {} : { model: model.model }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      } })
  }
  return resolved
}

/** Select a blank root or restore its already recorded identity; children must arrive natively composed.
 * @param ctx Host owning the native registry.
 * @param agent Exact live participant awaiting enrollment.
 * @param role Resolved role, with no preset preserving native preset-free/inherited behavior.
 * @param root Whether blank-session selection is permitted for this root.
 * @returns Resolves when the session and its mounted composition agree with the role.
 */
export async function bindRolePreset(ctx: Context, agent: Agent, role: ResolvedRole, root: boolean): Promise<void> {
  if (role.preset === undefined) return
  const presets = registry(ctx)
  const saved = presets.presetForSession(agent.session)
  const mounted = presets.composedPreset(agent.ctx)
  if (saved === role.preset && mounted === role.preset) return
  if (root && saved === role.preset && mounted === undefined) {
    await presets.mount(agent.ctx, role.preset)
    return
  }
  const turns = ctx.agents.turnBoundaryOf(agent.session)
  if (root && turns.openTurnStartSeq === null && turns.lastTurn === 0) {
    await presets.select(agent, role.preset)
    return
  }
  throw new Error(`Role preset ${role.preset} conflicts with ${root ? 'locked root' : 'native participant'} preset ${saved ?? '(none)'}`)
}

const bindingSchema = z.object({
  id: z.string().min(1).transform(SessionId),
  project: z.string().min(1),
  role: z.string().min(1),
  preset: z.string().min(1),
  tools: z.array(z.string().min(1)),
}).strict()
/** Durable preset identity and maximum role tool whitelist for one admitted member. */
export type RoleBinding = z.infer<typeof bindingSchema>

/** Read preset role grants separately from membership facts, retaining the latest narrowed tool ceiling.
 * @param facts Durable organization facts.
 * @param project Organization project.
 * @returns Per-member preset identity and admitted tools; changes may only narrow previously recorded grants.
 */
export function readRoleBindings(facts: ReturnType<OrganizationFacts['readFacts']>, project: string): Map<SessionId, RoleBinding> {
  const bindings = new Map<SessionId, RoleBinding>()
  for (const fact of facts) {
    if (fact.kind !== 'participant-preset') continue
    const binding = bindingSchema.parse(fact.data)
    if (binding.project !== project) continue
    const previous = bindings.get(binding.id)
    if (previous) assertRoleBinding(previous, binding.role, binding)
    bindings.set(binding.id, binding)
  }
  return bindings
}

/** Refuse preset replacement/removal and authority expansion when recovering a recorded participant.
 * @param saved Previously admitted preset grant; absence permits initial opt-in.
 * @param roleName Current membership role.
 * @param role Current effective preset and whitelist.
 * @returns Normally when identity is unchanged and authority is equal or narrower.
 */
export function assertRoleBinding(saved: RoleBinding | undefined, roleName: string, role: Pick<ResolvedRole, 'preset' | 'tools'>): void {
  if (saved === undefined) return
  if (saved.role !== roleName || saved.preset !== role.preset)
    throw new Error('Recorded participant preset conflicts with organization policy')
  if (role.tools.some(tool => !saved.tools.includes(tool)))
    throw new Error('Recovery cannot widen the recorded role tool whitelist')
}
