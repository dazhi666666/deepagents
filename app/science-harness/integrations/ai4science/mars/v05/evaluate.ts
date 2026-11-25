/** Offline CLI: tsx v05/evaluate.ts private-manifest.json collected-input.json report.json */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateV05, type EvaluationInput, type EvaluationManifest } from './evaluator.ts'

export function evaluateFiles(manifestFile: string, inputFile: string, outputFile: string) {
  const output = resolve(outputFile)
  if (output === resolve(manifestFile) || output === resolve(inputFile)) throw new Error('Output must not overwrite evaluation inputs')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as EvaluationManifest
  const input = JSON.parse(readFileSync(inputFile, 'utf8')) as EvaluationInput
  const result = evaluateV05(manifest, input)
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return { output, score: result.score, maximum: result.maximum, mode: result.mode }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, input, output] = process.argv.slice(2)
  if (!manifest || !input || !output) throw new Error('Usage: evaluate.ts private-manifest.json collected-input.json report.json')
  console.log(JSON.stringify(evaluateFiles(manifest, input, output)))
}
