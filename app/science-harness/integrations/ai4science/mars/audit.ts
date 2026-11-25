/** Infrastructure request accounting remains outside rollback state. */
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync } from 'node:fs'
import { z } from 'zod'
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'

/** Append complete private audit records durably without retaining an open descriptor. */
export class MarsAudit {
  private records: { kind: string; data: Json }[] | undefined
  constructor(readonly path: string) {}
  /** Record one external request, usage, error or recovery fact.
   * @param kind Stable event category.
   * @param data Observed metadata and usage, excluding credentials.
   */
  append(kind: string, data: Json) {
    const line = JSON.stringify({ kind, data }) + '\n', bytes = Buffer.from(line)
    const fd = openSync(this.path, 'a', 0o600)
    try {
      let offset = 0
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset)
        if (!written) throw new Error('Audit append made no progress')
        offset += written
      }
      fsyncSync(fd)
    } finally { closeSync(fd) }
    this.records?.push(z.object({ kind: z.string(), data: z.json() }).parse(JSON.parse(line)))
  }
  /** Read complete audit records; a damaged record is surfaced for investigation. */
  read() {
    this.records ??= existsSync(this.path) ? readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map(line =>
      z.object({ kind: z.string(), data: z.json() }).parse(JSON.parse(line))) : []
    return this.records
  }
  /** Sum the last authoritative usage report per request, including discarded branches. */
  usage() {
    const requests = new Map<string, string>(), usage = new Map<string, { provider: string; input: number; output: number }>()
    for (const record of this.read()) {
      if (record.kind === 'model-request') {
        const request = z.object({ requestId: z.string(), provider: z.string() }).parse(record.data)
        requests.set(request.requestId, request.provider)
      }
      if (record.kind === 'model-usage') {
        const report = z.object({ requestId: z.string(), provider: z.string(), usage: z.object({ inputTokens: z.number(), outputTokens: z.number(),
          cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional() }) }).parse(record.data)
        usage.set(report.requestId, { provider: report.provider,
          input: report.usage.inputTokens + (report.usage.cacheReadTokens ?? 0) + (report.usage.cacheWriteTokens ?? 0), output: report.usage.outputTokens })
      }
    }
    const byProvider: Record<string, { requests: number; inputTokens: number; outputTokens: number }> = {}
    for (const provider of requests.values()) {
      const total = byProvider[provider] ??= { requests: 0, inputTokens: 0, outputTokens: 0 }
      total.requests++
    }
    for (const report of usage.values()) {
      const total = byProvider[report.provider] ??= { requests: 0, inputTokens: 0, outputTokens: 0 }
      total.inputTokens += report.input; total.outputTokens += report.output
    }
    return { requests: requests.size, inputTokens: [...usage.values()].reduce((sum, value) => sum + value.input, 0),
      outputTokens: [...usage.values()].reduce((sum, value) => sum + value.output, 0),
      unreportedUsageRequests: [...requests.keys()].filter(requestId => !usage.has(requestId)).length, byProvider }
  }
  /** Attribute native conversation attempts and reported conversation/summary tokens to actual Sessions. */
  agentUsage() {
    const totals: Record<string, { requests: number; inputTokens: number; outputTokens: number; reportedUsage: boolean }> = {}
    for (const record of this.read()) {
      if (!['agent-request', 'agent-usage'].includes(record.kind)) continue
      const data = z.object({ actorId: z.string(), usage: z.object({ inputTokens: z.number(), outputTokens: z.number(),
        cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional() }).optional() }).parse(record.data)
      const total = totals[data.actorId] ??= { requests: 0, inputTokens: 0, outputTokens: 0, reportedUsage: false }
      if (record.kind === 'agent-request') total.requests++
      if (data.usage) {
        total.inputTokens += data.usage.inputTokens + (data.usage.cacheReadTokens ?? 0) + (data.usage.cacheWriteTokens ?? 0)
        total.outputTokens += data.usage.outputTokens; total.reportedUsage = true
      }
    }
    return totals
  }
}
