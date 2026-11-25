/** Viewer v1 routes: authentication, new Mars data endpoints, 404/403 behavior and removed interventions. */
import { afterEach, expect, it } from 'vitest'
import { get as httpGet } from 'node:http'
import { startViewer } from './viewer.ts'
import type { ViewerSnapshot } from './protocol.ts'

const started: Awaited<ReturnType<typeof startViewer>>[] = []
afterEach(async () => { for (const viewer of started.splice(0)) await viewer.close() })

const snapshot = { runId: 'run-1', cursor: 10, mode: 'multi-agent', branchId: 'main', stage: 'foundation', status: 'running',
  tasks: [], mission: { tasks: [] }, notes: [] } as unknown as ViewerSnapshot

async function open() {
  const viewer = await startViewer({
    runId: () => 'run-1', snapshot: () => snapshot, events: () => [],
    score: () => ({ provisional: true, O: { total: 1 } }),
    sensors: () => ({ tick: 3, crops: [] }),
    telemetryChannels: () => ['energy.soc', 'energy.demand'],
    telemetry: (channels, from, to, limit) => ({ channels, from, to, limit }),
    deliverables: () => [{ kind: 'mars-deliverable-accepted' }],
    incidentReports: () => [{ tick: 3 }],
    analysisRuns: () => [{ id: 'analysis-1' }],
    analysisRun: id => id === 'analysis-1' ? { id, code: 'return 1' } : null,
    measurement: id => id === 'result-1' ? { value: 3 } : null,
    raw: key => key === 'result-1' ? { points: [] } : null,
    announcements: () => ({ total: 0, events: [] }),
    evaluation: () => ({ forbidden: 'Evaluation is available only after the mission completes' }),
    modelActivity: () => ({ active: [], recent: [] }),
  }, 0)
  started.push(viewer)
  return viewer
}

/** The transport fixture accepts every valid ephemeral loopback port. */
const get = (viewer: Awaited<ReturnType<typeof open>>, path: string, authenticated = true) => new Promise<Response>((resolve, reject) => {
  const request = httpGet(`${viewer.origin}/viewer/api/v1/runs/run-1${path}`, { headers: authenticated ? { Authorization: `Bearer ${viewer.token}` } : {} }, response => {
    const chunks: Buffer[] = []
    response.on('data', chunk => chunks.push(Buffer.from(chunk)))
    response.once('error', reject)
    response.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500 })))
  })
  request.once('error', reject)
})

it('serves every read-only Mars endpoint over the authenticated loopback API', async () => {
  const viewer = await open()
  for (const [path, expected] of [['/score', 200], ['/sensors', 200], ['/telemetry/channels', 200], ['/deliverables', 200],
    ['/incident-reports', 200], ['/analysis-runs', 200], ['/analysis-runs/analysis-1', 200], ['/measurements?resultId=result-1', 200],
    ['/raw/result-1', 200], ['/announcements', 200], ['/model-activity', 200], ['/snapshot', 200]] as const) {
    const response = await get(viewer, path)
    expect(response.status, path).toBe(expected)
  }
  const telemetry = await get(viewer, '/telemetry?channels=energy.soc,energy.demand&from=0&to=10&limit=5')
  expect(telemetry.status).toBe(200)
  expect(await telemetry.json()).toEqual({ channels: ['energy.soc', 'energy.demand'], from: 0, to: 10, limit: 5 })
  expect((await get(viewer, '/sensors')).status).toBe(200)
})

it('rejects malformed telemetry queries and hides unknown records', async () => {
  const viewer = await open()
  expect((await get(viewer, '/telemetry')).status).toBe(400)
  expect((await get(viewer, '/telemetry?channels=energy.soc&from=10&to=1')).status).toBe(400)
  expect((await get(viewer, '/telemetry?channels=a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y')).status).toBe(400)
  expect((await get(viewer, '/analysis-runs/missing')).status).toBe(404)
  expect((await get(viewer, '/measurements?resultId=missing')).status).toBe(404)
  expect((await get(viewer, '/raw/scan%3Aoperation-1')).status).toBe(404)
})

it('returns 403 for pre-completion evaluation and no longer exposes interventions', async () => {
  const viewer = await open()
  const evaluation = await get(viewer, '/evaluation')
  expect(evaluation.status).toBe(403)
  expect(await evaluation.json()).toMatchObject({ error: expect.stringContaining('after the mission completes') })
  expect((await get(viewer, '/interventions')).status).toBe(404)
  const anonymous = await get(viewer, '/score', false)
  expect(anonymous.status).toBe(401)
})
