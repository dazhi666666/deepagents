/** Typecheck every source-bearing integration config discovered from Git's non-ignored files. */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

/**
 * Discover source-bearing configs, retaining invalid configs so the compiler rejects them.
 * @param {string} repo - Git checkout containing the integrations directory.
 * @returns {string[]} Sorted repository-relative configs; source-free solutions are omitted.
 */
export function discoverIntegrationConfigs(repo) {
  const inventory = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'integrations'], {
    cwd: repo,
    encoding: 'utf8',
  })
  if (inventory.error) throw inventory.error
  if (inventory.status !== 0) throw new Error(`Cannot discover integration configs: ${inventory.stderr.trim()}`)
  const configs = [...new Set(inventory.stdout.split('\0'))]
    .filter(path => /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/.test(path))
    .sort()
  const leaves = configs.filter(path => {
    const configPath = resolve(repo, path).replaceAll('\\', '/')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error) return true // Let the compiler report malformed configs.
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), {}, configPath)
    return parsed.errors.length > 0 || parsed.fileNames.length > 0 || !parsed.projectReferences?.length
  })
  if (leaves.length === 0) throw new Error('No integration TypeScript leaf configs found')
  return leaves
}

/**
 * Run every discovered compiler leaf and report failure after collecting all results.
 * @param {string} [repo] - Git checkout to check; omission selects this script's checkout.
 * @returns {number} Zero when every leaf passes, otherwise one.
 */
export function runIntegrationTypecheck(repo = fileURLToPath(new URL('../../../', import.meta.url))) {
  const leaves = discoverIntegrationConfigs(repo)
  const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'))
  let failures = 0
  for (const config of leaves) {
    console.log(`Typechecking ${config}`)
    const result = spawnSync(process.execPath, [compiler, '-p', config, '--noEmit', '--pretty', 'false'], {
      cwd: repo,
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    if (result.status !== 0) failures += 1
  }
  console.log(`Integration typecheck: ${leaves.length} configs, ${failures} failed`)
  return failures === 0 ? 0 : 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runIntegrationTypecheck()
}
