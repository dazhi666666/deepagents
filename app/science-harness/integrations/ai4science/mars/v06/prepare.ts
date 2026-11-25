/** Mechanical preparation through a dsh profile; no agent, adapter or execution provider starts. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { loadTruth } from '../truth.ts'
import { contentHash, stageProfileSchema } from './contracts.ts'
import { scienceProfileSchema } from './profile.ts'
import { scienceInstance } from './science.ts'
import { compileScenario } from './scenario.ts'
import { sourceManifest } from './source-manifest.ts'

export const name = 'science-mars-prepare'
export const inject: string[] = []
const inputSchema = z.object({ directory: z.string(), truthFile: z.string(), stageProfile: stageProfileSchema,
  scienceProfile: scienceProfileSchema, instanceFile: z.string().optional() }).strict()
/** Persist owned preparation outputs; existing different files are refused, matching files are retained. */
export function prepareScienceRun(input: unknown) {
  const config = inputSchema.parse(input), directory = resolve(config.directory), source = loadTruth(config.truthFile)
  const instance = scienceInstance(directory, contentHash(source), contentHash(config.scienceProfile), config.stageProfile, config.instanceFile)
  const compiled = compileScenario(source, config.stageProfile, config.scienceProfile, instance.salt)
  const effectiveTruthFile = `${directory}.evaluator/v06-effective-truth.json`
  const writeOnce = (file: string, value: unknown) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    if (existsSync(file)) {
      if (contentHash(JSON.parse(readFileSync(file, 'utf8'))) !== contentHash(value)) throw new Error('Existing scientific preparation differs')
    } else writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  }
  writeOnce(effectiveTruthFile, compiled.truth)
  writeOnce(join(directory, 'public/science.json'), compiled.public)
  const prepared = { effectiveTruthFile, instanceFile: config.instanceFile ? resolve(config.instanceFile) : `${directory}.evaluator/v06-instance.json`,
    instanceHash: contentHash(instance), sourceTruthHash: contentHash(source), scenarioHash: contentHash(compiled.scenario), sourceHash: sourceManifest().hash }
  writeOnce(`${directory}.evaluator/v06-preparation.json`, prepared)
  return prepared
}
/** Standard one-shot profile entry with no credential or model services. */
export function apply(_ctx: object, input: unknown) { console.log(JSON.stringify(prepareScienceRun(input))) }
