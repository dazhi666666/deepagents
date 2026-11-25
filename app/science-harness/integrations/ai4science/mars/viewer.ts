/** Authenticated local API for the independently developed viewer. */
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { ViewerEvent, ViewerSnapshot } from './protocol.ts'

/** Serve current committed state and cursor-based event reads.
 * @param source Runtime query functions; no frontend ownership of simulation.
 * @param port Requested loopback port, zero for allocation.
 * @returns Listener origin, private launch token and quiescent close function.
 */
export async function startViewer(source: { runId?(): string; snapshot(): ViewerSnapshot; events(after: number): ViewerEvent[];
  score?(): unknown;
  sensors?(): unknown;
  telemetryChannels?(): string[];
  telemetry?(channels: string[], from: number, to: number, limit: number): unknown;
  deliverables?(): unknown;
  incidentReports?(): unknown;
  analysisRuns?(): unknown;
  analysisRun?(id: string): unknown;
  measurement?(resultId: string): unknown;
  raw?(key: string): unknown;
  announcements?(): unknown;
  evaluation?(): unknown;
  modelActivity?(): unknown;
  checkpoints?(): Promise<{ id: string; tick: number; cursor: number }[]>;
  saveCheckpoint?(): Promise<{ id: string; tick: number; cursor: number }>;
  infrastructure?(): unknown;
  requestRecovery?(input: unknown): Promise<unknown>;
  historyQuery?(input: unknown): unknown;
  historySearch?(query: string, offset: number, limit: number): unknown;
  artifact?(id: string): unknown;
  frames?(): Promise<unknown>;
  frame?(id: string): Promise<unknown> }, port: number) {
  const token = randomBytes(32).toString('hex'), secret = randomBytes(32).toString('hex')
  const streams = new Set<ServerResponse>()
  let actualPort = port
  const equal = (a: string, b: string) => {
    const left = Buffer.from(a), right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
  }
  const send = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  const checkpointRequests = new Map<string, Promise<{ id: string; tick: number; cursor: number }>>()
  const body = async (request: IncomingMessage) => {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Use application/json')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk)
      length += bytes.length
      if (length > 65536) throw new Error('Request exceeds 64 KiB')
      chunks.push(bytes)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? ''
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(host)) return send(response, 403, { error: 'Local host required' })
      if (request.headers.origin && request.headers.origin !== `http://${host}`) return send(response, 403, { error: 'Same origin required' })
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Referrer-Policy', 'no-referrer')
      const path = new URL(request.url ?? '/', `http://${host}`)
      const bearer = equal(request.headers.authorization ?? '', `Bearer ${token}`)
      const cookieName = `mars_viewer_${actualPort}`
      if (path.pathname === '/session' && request.method === 'POST') {
        if (!bearer) return send(response, 401, { error: 'Launch token required' })
        response.setHeader('Set-Cookie', `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/`)
        return send(response, 200, { ok: true })
      }
      const cookie = (request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? ''
      if (!bearer && !equal(cookie, secret)) return send(response, 401, { error: 'Authenticated session required' })
      const runId = source.runId?.() ?? source.snapshot().runId
      const prefix = `/viewer/api/v1/runs/${runId}`
      if (path.pathname === `${prefix}/frames` && request.method === 'GET' && source.frames)
        return send(response, 200, await source.frames())
      if (path.pathname.startsWith(`${prefix}/frames/`) && request.method === 'GET' && source.frame)
        return send(response, 200, await source.frame(decodeURIComponent(path.pathname.slice(`${prefix}/frames/`.length))))
      if (path.pathname.startsWith(`${prefix}/artifacts/`) && request.method === 'GET' && source.artifact)
        return send(response, 200, source.artifact(decodeURIComponent(path.pathname.slice(`${prefix}/artifacts/`.length))))
      if (path.pathname === `${prefix}/archive/records` && request.method === 'GET' && source.historyQuery) {
        const params = path.searchParams
        return send(response, 200, source.historyQuery({ kind: params.get('kind') ?? 'documents',
          ...(params.has('entityId') ? { entityId: params.get('entityId') } : {}), ...(params.has('id') ? { id: params.get('id') } : {}),
          ...(params.has('fromTick') ? { fromTick: Number(params.get('fromTick')) } : {}), ...(params.has('toTick') ? { toTick: Number(params.get('toTick')) } : {}),
          offset: Number(params.get('offset') ?? 0), limit: Number(params.get('limit') ?? 50) }))
      }
      if (path.pathname === `${prefix}/archive/search` && request.method === 'GET' && source.historySearch)
        return send(response, 200, source.historySearch(path.searchParams.get('q') ?? '', Number(path.searchParams.get('offset') ?? 0), Number(path.searchParams.get('limit') ?? 20)))
      if (path.pathname === `${prefix}/score` && request.method === 'GET' && source.score)
        return send(response, 200, source.score())
      if (path.pathname === `${prefix}/sensors` && request.method === 'GET' && source.sensors)
        return send(response, 200, source.sensors())
      if (path.pathname === `${prefix}/telemetry/channels` && request.method === 'GET' && source.telemetryChannels)
        return send(response, 200, source.telemetryChannels())
      if (path.pathname === `${prefix}/telemetry` && request.method === 'GET' && source.telemetry) {
        const channels = [...new Set(z.string().min(1).parse(path.searchParams.get('channels')).split(',').map(value => value.trim()).filter(Boolean))]
        if (!channels.length || channels.length > 24) return send(response, 400, { error: 'Request between 1 and 24 telemetry channels' })
        const from = z.coerce.number().int().nonnegative().parse(path.searchParams.get('from') ?? '0')
        const to = z.coerce.number().int().nonnegative().parse(path.searchParams.get('to') ?? String(Number.MAX_SAFE_INTEGER))
        const limit = z.coerce.number().int().min(1).max(5000).parse(path.searchParams.get('limit') ?? '600')
        if (to < from) return send(response, 400, { error: 'to must not precede from' })
        return send(response, 200, source.telemetry(channels, from, to, limit))
      }
      if (path.pathname === `${prefix}/deliverables` && request.method === 'GET' && source.deliverables)
        return send(response, 200, source.deliverables())
      if (path.pathname === `${prefix}/incident-reports` && request.method === 'GET' && source.incidentReports)
        return send(response, 200, source.incidentReports())
      if (path.pathname === `${prefix}/analysis-runs` && request.method === 'GET' && source.analysisRuns)
        return send(response, 200, source.analysisRuns())
      if (path.pathname.startsWith(`${prefix}/analysis-runs/`) && request.method === 'GET' && source.analysisRun) {
        const value = source.analysisRun(decodeURIComponent(path.pathname.slice(`${prefix}/analysis-runs/`.length)))
        return value === null || value === undefined ? send(response, 404, { error: 'Unknown analysis run' }) : send(response, 200, value)
      }
      if (path.pathname === `${prefix}/measurements` && request.method === 'GET' && source.measurement) {
        const resultId = z.string().min(1).parse(path.searchParams.get('resultId'))
        const value = source.measurement(resultId)
        return value === null || value === undefined ? send(response, 404, { error: 'Unknown measurement' }) : send(response, 200, value)
      }
      if (path.pathname.startsWith(`${prefix}/raw/`) && request.method === 'GET' && source.raw) {
        const value = source.raw(decodeURIComponent(path.pathname.slice(`${prefix}/raw/`.length)))
        return value === null || value === undefined ? send(response, 404, { error: 'Unknown raw data key' }) : send(response, 200, value)
      }
      if (path.pathname === `${prefix}/announcements` && request.method === 'GET' && source.announcements)
        return send(response, 200, source.announcements())
      if (path.pathname === `${prefix}/evaluation` && request.method === 'GET' && source.evaluation) {
        const value = source.evaluation()
        if (value !== null && typeof value === 'object' && 'forbidden' in value)
          return send(response, 403, { error: String((value as { forbidden: unknown }).forbidden) })
        return send(response, 200, value)
      }
      if (path.pathname === `${prefix}/model-activity` && request.method === 'GET' && source.modelActivity)
        return send(response, 200, source.modelActivity())
      if (path.pathname === `${prefix}/infrastructure` && request.method === 'GET' && source.infrastructure)
        return send(response, 200, source.infrastructure())
      if (path.pathname === `${prefix}/controls` && request.method === 'POST' && source.saveCheckpoint) {
        const input = z.discriminatedUnion('action', [
          z.object({ action: z.literal('checkpoint'), requestKey: z.string().min(1).max(128) }).strict(),
          z.object({ action: z.literal('restore'), requestKey: z.string().min(1).max(128), checkpointId: z.string().uuid(), failureRequestId: z.string().optional() }).strict(),
        ]).parse(await body(request))
        if (input.action === 'restore') {
          if (!source.requestRecovery) return send(response, 409, { error: 'Launch through the recovery supervisor to restore checkpoints' })
          const { action: _action, ...request } = input
          return send(response, 202, await source.requestRecovery(request))
        }
        let pending = checkpointRequests.get(input.requestKey)
        if (!pending) {
          pending = source.saveCheckpoint().then(value => ({ id: value.id, tick: value.tick, cursor: value.cursor }))
          checkpointRequests.set(input.requestKey, pending)
        }
        return send(response, 200, await pending)
      }
      if (request.method !== 'GET') return send(response, 405, { error: 'Operation unavailable' })
      if (path.pathname === `${prefix}/checkpoints` && source.checkpoints) return send(response, 200, await source.checkpoints())
      if (path.pathname === `/viewer/api/v1/runs`) {
        const value = source.snapshot()
        return send(response, 200, [{ runId: value.runId, mode: value.mode, branchId: value.branchId, stage: value.stage }])
      }
      if (path.pathname === prefix || path.pathname === `${prefix}/snapshot`) return send(response, 200, source.snapshot())
      if (path.pathname === `${prefix}/tasks`) return send(response, 200, source.snapshot().tasks)
      if (path.pathname === `${prefix}/objectives`) return send(response, 200, source.snapshot().mission.tasks)
      if (path.pathname === `${prefix}/records`) return send(response, 200, source.snapshot().notes)
      if (path.pathname === `${prefix}/events` || path.pathname === `${prefix}/stream`) {
        const value = source.snapshot()
        const after = Number(path.searchParams.get('after') ?? request.headers['last-event-id'] ?? '0')
        if (!Number.isSafeInteger(after) || after < 0 || after > value.cursor) return send(response, 409, { error: 'Cursor unavailable; reload snapshot', cursor: value.cursor })
        if (path.pathname.endsWith('/events')) return send(response, 200, { events: source.events(after), cursor: value.cursor })
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
        let cursor = after
        const flush = () => {
          try {
            for (const event of source.events(cursor)) {
              response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
              cursor = event.seq
            }
          } catch (error) { response.destroy(error instanceof Error ? error : new Error(String(error))) }
        }
        streams.add(response)
        const interval = setInterval(flush, 250)
        response.on('close', () => { clearInterval(interval); streams.delete(response) })
        response.write(': connected\n\n'); flush()
        return
      }
      return send(response, 404, { error: 'Unknown viewer endpoint' })
    } catch (error) {
      if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)))
      else send(response, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Viewer listener unavailable')
  actualPort = address.port
  return { origin: `http://127.0.0.1:${actualPort}`, token,
    async close() {
      for (const response of streams) response.end()
      server.closeIdleConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    } }
}
