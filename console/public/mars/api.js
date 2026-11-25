/* Mars panel API: all reads go through the Mission Control server proxy, never the Viewer bearer. */
export function createMarsApi(api) {
  const get = (path) => api('/mc/mars' + path)
  let cached = { at: 0, value: null, pending: null }
  return {
    /** One shared snapshot per second; `force` bypasses both the value and any in-flight read. */
    async snapshot(force = false) {
      const now = Date.now()
      if (!force && cached.value && now - cached.at < 1000) return cached.value
      if (!force && cached.pending) return cached.pending
      const pending = get('/snapshot').then((value) => {
        cached = { at: Date.now(), value, pending: null }
        return value
      }, (error) => { cached.pending = null; throw error })
      cached.pending = pending
      return pending
    },
    score: () => get('/score'),
    sensors: () => get('/sensors'),
    telemetryChannels: () => get('/telemetry/channels'),
    telemetry: (channels, from, to, limit = 600) =>
      get(`/telemetry?channels=${encodeURIComponent(channels.join(','))}&from=${from}&to=${to}&limit=${limit}`),
    deliverables: () => get('/deliverables'),
    incidentReports: () => get('/incident-reports'),
    analysisRuns: () => get('/analysis-runs'),
    analysisRun: (id) => get('/analysis-runs/' + encodeURIComponent(id)),
    measurement: (id) => get('/measurements?resultId=' + encodeURIComponent(id)),
    raw: (key) => get('/raw/' + encodeURIComponent(key)),
    announcements: () => get('/announcements'),
    modelActivity: () => get('/model-activity'),
    evaluation: () => get('/evaluation'),
    comparison: () => get('/comparison'),
  }
}
