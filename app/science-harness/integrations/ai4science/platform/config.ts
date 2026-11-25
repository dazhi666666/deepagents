/** File-based deployment configuration and independent provider module loading. No scientific roles are built in. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { validateProvider, type Json, type ExecutionProvider } from './sdk.ts'
import { ExecutionEngine } from './execution.ts'

import { HOST_API_VERSION } from './version.ts'
export { HARNESS_BASELINE, HOST_API_VERSION } from './version.ts'
export const PLATFORM_VERSION = '0.2.0'
const schema = z
  .object({
    apiVersion: z.literal(1),
    enabled: z.literal(true),
    hostApi: z.literal(HOST_API_VERSION).optional(),
    baseline: z
      .string()
      .regex(/^[a-f0-9]{40}$/, 'Expected a full lowercase 40-character commit SHA')
      .optional(),
    directory: z.string().min(1),
    providerCallTimeoutMs: z.number().int().min(1).max(300000),
    pollIntervalMs: z.number().int().min(1).max(60000),
    controllerLockTimeoutMs: z.number().int().min(1).max(300000).optional(),
    retentionDays: z.number().int().min(0).max(36500).optional(),
    /** Maximum verified file identities per dashboard; omitted uses 1024, 0 disables reuse. */
    artifactVerificationCacheEntries: z.number().int().min(0).max(100000).optional(),
    management: z
      .object({
        actorId: z.string().min(1),
        projects: z.array(z.string().min(1)).min(1),
        allowedProviders: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    providers: z
      .array(z.object({ module: z.string().min(1), config: z.record(z.string(), z.json()) }).strict())
      .min(1),
    organization: z.unknown().optional(),
  })
  .strict()
  .refine((config) => config.hostApi !== undefined || config.baseline !== undefined, {
    message: `Declare hostApi: "${HOST_API_VERSION}" or a legacy baseline commit`,
    path: ['hostApi'],
  })

/** Deployment fields; baseline-only files remain accepted during migration. */
export type PlatformConfig = z.infer<typeof schema>

/** Parsed deployment with explicit hostApi; optional baseline is deployment metadata only. */
export type ResolvedPlatformConfig = PlatformConfig & { hostApi: typeof HOST_API_VERSION }

/**
 * Parse a deployment file and resolve paths relative to it. Invalid configuration throws before loading providers.
 * Legacy baseline-only files resolve to the supported host API and emit one stderr migration notice per read.
 * Explicit hostApi files are silent; their optional baseline never controls compatibility or identifies the running host.
 * Provider modules/configuration are trusted executable installation inputs.
 * @param path Deployment JSON file.
 * @returns Validated configuration with an explicit hostApi and optional deployment commit metadata.
 */
export function readPlatformConfig(path: string): ResolvedPlatformConfig {
  const config = schema.parse(JSON.parse(readFileSync(path, 'utf8')))
  config.directory = resolve(dirname(path), config.directory)
  for (const provider of config.providers) {
    provider.module = resolve(dirname(path), provider.module)
    if (typeof provider.config.directory === 'string')
      provider.config.directory = resolve(dirname(path), provider.config.directory)
  }
  if (config.hostApi === undefined)
    process.stderr.write(
      `AI4Science deployment ${path}: legacy baseline-only configuration; add "hostApi": "${HOST_API_VERSION}". The optional "baseline" now records deployment commit metadata only.\n`,
    )
  return { ...config, hostApi: config.hostApi ?? HOST_API_VERSION }
}

/** Register independently authored factories through the public API; fail on incompatible configuration.
 * @param path Deployment JSON file.
 * @param mode Controller by default; observer reads only, driver owns the polling loop.
 * @param options Optional recovery policy; omission preserves controller startup observations, recover:false skips them.
 * @returns An opened engine and resolved deployment; the caller owns engine closure.
 */
export async function openConfiguredEngine(
  path: string,
  mode: 'controller' | 'observer' | 'driver' = 'controller',
  options: { recover?: boolean } = {},
): Promise<{ engine: ExecutionEngine; config: ResolvedPlatformConfig }> {
  const config = readPlatformConfig(resolve(path))
  const providers: ExecutionProvider[] = []
  for (const entry of config.providers) {
    const module = (await import(pathToFileURL(entry.module).href)) as {
      createProvider?: (config: Json) => ExecutionProvider | Promise<ExecutionProvider>
    }
    if (typeof module.createProvider !== 'function')
      throw new Error(`Provider module must export createProvider: ${entry.module}`)
    providers.push(validateProvider(await module.createProvider(entry.config as Json)))
  }
  const ids = providers.map((p) => p.describe().id)
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate provider ID')
  if (config.management.allowedProviders.some((id) => !ids.includes(id)))
    throw new Error('Management permission references an unregistered provider')
  const engine = new ExecutionEngine({
    directory: config.directory,
    providers,
    pollIntervalMs: config.pollIntervalMs,
    providerCallTimeoutMs: config.providerCallTimeoutMs,
    ...(config.controllerLockTimeoutMs === undefined ? {} : { controllerLockTimeoutMs: config.controllerLockTimeoutMs }),
    ...(config.retentionDays === undefined ? {} : { retentionDays: config.retentionDays }),
  })
  await engine.open({ mode, ...options })
  return { engine, config }
}
