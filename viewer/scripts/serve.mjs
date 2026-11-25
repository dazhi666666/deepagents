#!/usr/bin/env node
/** Optional loopback-only static host. Serves the built viewer, never source experiment directories. */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildViewer } from './build.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function createViewerServer(htmlFile = join(root, 'dist', 'index.html')) {
  const body = readFileSync(htmlFile)
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return }
    if (!['/', '/index.html'].includes(path)) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found'); return }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    response.end(request.method === 'HEAD' ? undefined : body)
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--port')) throw new Error('用法：node viewer/scripts/serve.mjs [--port 4178]')
    const port = args.length ? Number(args[1]) : 4178
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口应在 1024–65535 之间')
    if (!existsSync(join(root, 'dist', 'index.html'))) buildViewer()
    const server = createViewerServer()
    server.on('error', error => { console.error(error.message); process.exitCode = 1 })
    server.listen(port, '127.0.0.1', () => console.log(`火星实验室：http://127.0.0.1:${port}`))
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close())
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
