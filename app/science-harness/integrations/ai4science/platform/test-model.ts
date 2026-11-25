/** Lightweight scripted LLM responses shared by AI4Science tests and the keyless CLI fixture. */
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

// Response helpers adapted from DeepSeek Harness packages/core/agent-loop/tests/mock-adapter.ts.
// Copyright (c) 2026 DeepSeek; MIT license at the repository root.
/** Stream a complete text response.
 * @param text Response content.
 * @returns Text blocks, usage and the terminal stop chunk.
 */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Stream one tool call, optionally preceded by text.
 * @param rawCallId Tool-call identifier.
 * @param name Tool name.
 * @param args JSON-serializable tool arguments.
 * @param text Optional preceding text; absent or empty emits no text block.
 * @returns Tool-call blocks, usage and the terminal tool-calls chunk.
 */
export function toolCallResponse(rawCallId: string, name: string, args: object, text?: string): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  const chunks: StreamChunk[] = []
  let index = 0
  if (text) {
    chunks.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    )
    index += 1
  }
  chunks.push(
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/** End a text response at the output-token limit.
 * @param value Partial response content.
 * @returns Text response chunks with a max-tokens finish.
 */
export function maxTokensResponse(value: string): StreamChunk[] {
  return textResponse(value).map<StreamChunk>(chunk => chunk.type === 'finish'
    ? { ...chunk, reason: { kind: 'max-tokens' } }
    : chunk)
}

/** Wrap a prompt or message in one text block.
 * @param value Message content.
 * @returns One text block.
 */
export const text = (value: string) => [{ type: 'text' as const, text: value }]

/** Bound fixture operations to fifteen seconds.
 * @returns A fresh timeout signal.
 */
export const signal = () => AbortSignal.timeout(15000)

/** One model response, computed response, or response suspended until cancellation. */
export type ScriptStep =
  | StreamChunk[]
  | ((options: GenerateOptions) => StreamChunk[] | Promise<StreamChunk[]>)
  | 'hang'

/** Gate scripted responses while propagating cancellation and removing the abort listener. */
export class Gate {
  private readonly deferred = Promise.withResolvers<void>()
  release(): void { this.deferred.resolve() }
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const aborted = Promise.withResolvers<never>()
    const onAbort = () => { aborted.reject(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try { await Promise.race([this.deferred.promise, aborted.promise]) }
    finally { signal?.removeEventListener('abort', onAbort) }
  }
  step(reply = 'ready'): ScriptStep {
    return async options => { await this.wait(options.signal); return textResponse(reply) }
  }
}

/** Role-keyed responses for independent real Agents; line markers may carry assignment text. */
export class ScriptedModel extends LlmAdapter {
  private readonly scripts = new Map<string, ScriptStep[]>()
  readonly requests: { actor: string; options: GenerateOptions }[] = []
  constructor(private readonly actorMarker: 'exact' | 'line' = 'exact') { super() }
  queue(actor: string, ...steps: ScriptStep[]): void {
    this.scripts.set(actor, [...(this.scripts.get(actor) ?? []), ...steps])
  }
  remaining(actor: string): number { return this.scripts.get(actor)?.length ?? 0 }
  protected nextStep(actor: string): ScriptStep | undefined { return this.scripts.get(actor)?.shift() }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pattern = this.actorMarker === 'line' ? /^ACTOR [\w-]+(?:\n|$)/ : /^ACTOR [\w-]+$/
    const marker = options.messages.flatMap(message => message.content)
      .find(block => block.type === 'text' && pattern.test(block.text))
    const actor = marker?.type === 'text'
      ? (this.actorMarker === 'line' ? marker.text.split('\n')[0]! : marker.text).slice(6)
      : 'lead'
    this.requests.push({ actor, options })
    const step = this.nextStep(actor)
    if (step === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Gate().wait(options.signal)
      return
    }
    // Parent settlement notices require no science action. Unscripted calls only acknowledge.
    const chunks = step === undefined ? textResponse(`${actor}: acknowledged`)
      : typeof step === 'function' ? await step(options) : step
    for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk }
  }
}

/** Ordered responses for the root probe, whose parent and worker share one script. */
export class SequentialModel extends ScriptedModel {
  constructor(private readonly script: ScriptStep[]) { super() }
  protected override nextStep(): ScriptStep {
    const step = this.script.shift()
    if (step === undefined) throw new Error('SequentialModel: script exhausted')
    return step
  }
}
