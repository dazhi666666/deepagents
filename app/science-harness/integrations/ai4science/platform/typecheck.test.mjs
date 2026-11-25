/** Exercise integration config discovery and compiler outcomes in disposable Git checkouts. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { discoverIntegrationConfigs } from './typecheck.mjs'

const gate = new URL('./typecheck.mjs', import.meta.url).href

function fixture(context) {
  const repo = mkdtempSync(join(tmpdir(), 'ai4science-typecheck-'))
  context.after(() => rmSync(repo, { recursive: true, force: true }))
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: repo, encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  const write = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  write('.gitignore', 'node_modules/\n')
  const config = (directory, source = 'export const value = 1\n') => {
    write(`${directory}/source.ts`, source)
    write(`${directory}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2024', types: [], skipLibCheck: true }, files: ['source.ts'] }))
    return `${directory}/tsconfig.json`
  }
  return { repo, write, config }
}

function run(repo) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval',
    `import { runIntegrationTypecheck } from ${JSON.stringify(gate)}; process.exitCode = runIntegrationTypecheck(process.argv[1]);`, repo], {
    encoding: 'utf8',
    timeout: 30000,
  })
}

test('discovers every integration leaf, including nested router and mission-control configs, without dependency configs or solutions', (context) => {
  const f = fixture(context)
  const expected = ['integrations/agent-router/harness', 'integrations/ai4science/platform', 'integrations/mission-control'].map(path => f.config(path))
  f.config('integrations/mission-control/node_modules/dependency')
  f.config('unrelated')
  f.write('integrations/tsconfig.json', JSON.stringify({ files: [], references: [{ path: './ai4science/platform' }] }))
  assert.deepEqual(discoverIntegrationConfigs(f.repo), expected)
  const result = run(f.repo)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  for (const path of expected) assert.ok(result.stdout.includes(`Typechecking ${path}`))
  assert.match(result.stdout, /Integration typecheck: 3 configs, 0 failed/)
  assert.equal(existsSync(join(f.repo, 'integrations/mission-control/source.js')), false)
})

test('a compiler error fails the gate while later leaves still run', (context) => {
  const f = fixture(context)
  f.config('integrations/a-broken', 'export const value: string = 1\n')
  const later = f.config('integrations/z-valid')
  const result = run(f.repo)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /TS2322/)
  assert.ok(result.stdout.includes(`Typechecking ${later}`))
  assert.match(result.stdout, /Integration typecheck: 2 configs, 1 failed/)
})

test('malformed configs and missing named inputs fail instead of narrowing discovery', (context) => {
  const f = fixture(context)
  f.write('integrations/malformed/tsconfig.json', '{')
  f.write('integrations/missing/tsconfig.host.json', JSON.stringify({ files: ['missing.ts'] }))
  assert.deepEqual(discoverIntegrationConfigs(f.repo), ['integrations/malformed/tsconfig.json', 'integrations/missing/tsconfig.host.json'])
  const result = run(f.repo)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /missing\.ts/)
  assert.match(result.stdout, /Integration typecheck: 2 configs, 2 failed/)
})

test('an empty or solution-only integration inventory fails', (context) => {
  const f = fixture(context)
  assert.throws(() => discoverIntegrationConfigs(f.repo), /No integration TypeScript leaf configs found/)
  f.write('integrations/tsconfig.json', JSON.stringify({ files: [], references: [{ path: './missing-leaf' }] }))
  assert.throws(() => discoverIntegrationConfigs(f.repo), /No integration TypeScript leaf configs found/)
})
