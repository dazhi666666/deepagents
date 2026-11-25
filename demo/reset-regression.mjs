#!/usr/bin/env node
/** Reset failure cases use dummy fixture files; runtime credentials are never opened. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetRuntime } from './reset-all.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checks = join(root, 'demo', '.checks')
mkdirSync(checks, { recursive: true })
const fixture = mkdtempSync(join(checks, 'reset-'))
const data = join(fixture, 'data')
mkdirSync(data)
writeFileSync(join(data, 'old-result.txt'), 'keep-old-result')
assert.throws(() => resetRuntime(data), /truth is missing/)
assert.ok(existsSync(join(data, 'old-result.txt')))
assert.deepEqual(readdirSync(fixture), ['data'])
mkdirSync(join(data, 'mars'))
writeFileSync(join(data, 'mars', 'truth.json'), '{"fixture":true}')
writeFileSync(join(data, 'secrets.json'), '{"dummy":true}')
mkdirSync(join(data, 'mars-multi'))
const pid = join(data, 'mars-multi', 'mars-server.pid')
writeFileSync(pid, String(process.pid))
assert.throws(() => resetRuntime(data), /still running/)
assert.ok(existsSync(join(data, 'old-result.txt')))
unlinkSync(pid)
const result = resetRuntime(data)
assert.equal(result.reset, true)
assert.ok(existsSync(join(result.backup, 'old-result.txt')))
assert.equal(readFileSync(join(data, 'mars', 'truth.json'), 'utf8'), '{"fixture":true}')
assert.equal(readFileSync(join(data, 'secrets.json'), 'utf8'), '{"dummy":true}')
assert.deepEqual(readdirSync(data).sort(), ['mars', 'secrets.json'])
console.log('PASS missing truth/live PID refuse before moving data; successful reset retains old output and copies only fixture truth/key')
