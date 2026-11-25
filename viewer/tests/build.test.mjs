import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { buildViewer } from '../scripts/build.mjs'
import { demoBundle } from '../fixtures/demo.mjs'

test('standalone page embeds data safely and has no runtime network/module dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-viewer-build-'))
  try {
    const bundle = demoBundle()
    bundle.runs[0].facts.find(f => f.kind === 'mars-mail').data.message.text = '</script><script>alert("bad")</script><img src=x onerror=alert(1)>'
    const dataFile = join(root, 'records.json'), output = join(root, 'viewer.html')
    writeFileSync(dataFile, JSON.stringify(bundle)); const result = buildViewer({ dataFile, output })
    assert.equal(result.runs, 2)
    const html = readFileSync(output, 'utf8'), script = html.match(/<script type="module">([\s\S]*)<\/script>/)[1]
    assert.equal((html.match(/<script\b/g) ?? []).length, 1)
    assert(!/<script[^>]+src=|<link[^>]+href=/.test(html))
    assert(!/^import\s/m.test(script)); assert(!/^export\s/m.test(script))
    assert(!html.includes('</script><script>alert'))
    assert(html.includes("connect-src 'none'")); assert(html.includes('集成样例'))
    new Script(script)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('explicit demo build remains separate from the selected experiment data', () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-viewer-demo-'))
  try { assert.equal(buildViewer({ demo: true, output: join(root, 'demo.html') }).source, 'fixture') }
  finally { rmSync(root, { recursive: true, force: true }) }
})
