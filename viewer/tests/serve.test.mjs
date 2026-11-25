import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createViewerServer } from '../scripts/serve.mjs'

test('optional host serves only the built page and rejects controls and filesystem paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mars-viewer-host-')), html = join(root, 'viewer.html')
  writeFileSync(html, '<!doctype html><title>Mars</title>')
  const server = createViewerServer(html)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const response = await fetch(url); assert.equal(response.status, 200); assert((await response.text()).includes('Mars'))
    assert.equal((await fetch(url + '/data/secrets.json')).status, 404)
    assert.equal((await fetch(url + '/%2e%2e/README.md')).status, 404)
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 405)
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 200)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }) }
})
