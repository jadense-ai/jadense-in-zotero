/** 通过真实 HTTP/SSE 消费器验证故障关联；诊断禁止保存正文、思考和原始错误体。 */
import { describe, expect, it, vi } from 'vitest'
import { TemporaryChatClient, consumeTemporaryChatStream } from './temporary-chat'
import { ByokChatClient, consumeByokStream } from './byok-chat'
import { readJadenseApiError } from '@/jadense/api'
import { Diagnostics } from '@/zotero/diagnostics'
import { requestIssue, requestIssueSummary, type RequestProgress } from './request-feedback'

const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'x-execution-id': 'execution-one', 'content-type': 'text/event-stream' } })

describe('translation request feedback', () => {
  it('keeps HTTP and stream error identities, status, code and cause without persisting private payloads', async () => {
    const fields = { code: 'UPSTREAM_PARAMETER_REJECTED', status: 422, requestId: 'request-one', executionId: 'execution-one', diagnosticId: 'diagnostic-one', stage: 'provider_stream', cause: { code: 'INVALID_EFFORT' } }
    const store = new Diagnostics({}), trace = store.start({ feature: 'translation' })
    const failure = await consumeTemporaryChatStream(sse([{ type: 'error', ...fields, errorText: 'Synthetic provider refusal', body: 'PRIVATE_BODY_CANARY' }]), undefined, true, trace).catch(error => error)
    expect(requestIssue(failure)).toMatchObject({ code: fields.code, status: 422, requestId: 'request-one', executionId: 'execution-one', diagnosticId: 'diagnostic-one', causeCode: 'INVALID_EFFORT' })
    trace.end()
    const exported = store.export()
    expect(exported).toContain('UPSTREAM_PARAMETER_REJECTED'); expect(exported).toContain('diagnostic-one')
    expect(exported).not.toContain('PRIVATE_BODY_CANARY'); expect(exported).not.toContain('Synthetic provider refusal')
    const http = await readJadenseApiError(Response.json({ ...fields, error: 'refused' }, { status: 422 }))
    expect(requestIssue(http)).toMatchObject({ code: fields.code, diagnosticId: fields.diagnosticId, status: 422 })
    expect(requestIssueSummary(requestIssue(http))).toContain('UPSTREAM_PARAMETER_REJECTED')
    store.dispose()
  })
  it.each([
    [[{ type: 'finish', finishReason: 'stop' }], 'EMPTY_OUTPUT'],
    [[{ type: 'reasoning-delta', delta: 'PRIVATE_REASONING' }, { type: 'finish', finishReason: 'stop' }], 'REASONING_ONLY'],
    [[{ type: 'text-delta', delta: 'partial' }, { type: 'finish', finishReason: 'length' }], 'STREAM_INCOMPLETE'],
    [[{ type: 'text-delta', delta: 'partial' }], 'STREAM_EARLY_EOF'],
  ] as const)('classifies %s as %s', async (events, code) => {
    await expect(consumeTemporaryChatStream(sse([...events]), undefined, true)).rejects.toMatchObject({ code })
  })
  it('reports long reasoning and verified metadata without a total-time cancellation or exposing reasoning text', async () => {
    vi.useFakeTimers()
    try {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const progress: RequestProgress[] = []
      const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
      const send = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
      const result = consumeTemporaryChatStream(new Response(stream), undefined, true, undefined, value => progress.push(value))
      send({ type: 'reasoning-delta', delta: 'PRIVATE_REASONING' })
      await vi.advanceTimersByTimeAsync(600_000)
      send({ type: 'text-delta', delta: '译文' })
      send({ type: 'finish', finishReason: 'stop', messageMetadata: { thinking: { version: 1, requestedThinkingEffort: 'low', effectiveThinkingEffort: 'low', thinkingSource: 'provider_attempt' } } })
      controller.close()
      await expect(result).resolves.toBe('译文')
      expect(progress.map(value => value.stage)).toContain('reasoning')
      expect(progress.at(-1)).toMatchObject({ stage: 'receiving', thinking: { effectiveThinkingEffort: 'low' } })
      expect(JSON.stringify(progress)).not.toContain('PRIVATE_REASONING')
    } finally { vi.useRealTimers() }
  })
  it('does not let an optional progress observer break translation, and keeps BYOK stream errors', async () => {
    await expect(consumeTemporaryChatStream(sse([{ type: 'text-delta', delta: 'ok' }, { type: 'finish' }]), undefined, true, undefined, () => { throw new Error('closed window') })).resolves.toBe('ok')
    await expect(consumeByokStream(sse([{ error: { code: 'invalid_effort', message: 'synthetic-key is rejected' } }]), 'openai-chat-completions', 'synthetic-key', undefined, true)).rejects.toMatchObject({ code: 'invalid_effort', stage: 'provider_stream' })
  })
})

it('wires actual BYOK client progress and preserves dispatch failures', async () => {
  const config = { protocol: 'openai-chat-completions' as const, baseUrl: 'https://fixture.invalid', apiKey: 'synthetic', model: 'fixture', maxOutputTokens: 2048 }
  const phases: string[] = [], input = { clientRequestId: 'r', conversationId: 'c', messages: [{ id: 'm', role: 'user' as const, text: 'Synthetic passage' }], requireComplete: true, onProgress: (event: RequestProgress) => phases.push(event.stage) }
  const client = new ByokChatClient({ config, fetchImpl: async () => new Response('data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\ndata: {"choices":[{"delta":{"content":"translation"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })
  expect(await client.send(input)).toBe('translation')
  expect(phases).toEqual(expect.arrayContaining(['sent', 'reasoning', 'receiving']))
  const offline: typeof fetch = async () => { throw Object.assign(new TypeError('offline'), { cause: { code: 'ECONNRESET' } }) }
  await expect(new ByokChatClient({ config, fetchImpl: offline }).send(input)).rejects.toMatchObject({ code: 'NETWORK_ERROR', stage: 'dispatch', causeCode: 'ECONNRESET' })
  await expect(new TemporaryChatClient({ baseUrl: config.baseUrl, token: 'synthetic', fetchImpl: offline }).send(input)).rejects.toMatchObject({ code: 'NETWORK_ERROR', stage: 'dispatch', causeCode: 'ECONNRESET' })
})
it('keeps stream response header identities when an error event omits them', async () => {
  const response = new Response('data: {"type":"error","code":"SYNTHETIC_FAILURE"}\n\n', { headers: { 'x-request-id': 'request-header', 'x-execution-id': 'execution-header', 'x-diagnostic-id': 'diagnostic-header' } })
  await expect(consumeTemporaryChatStream(response, undefined, true)).rejects.toMatchObject({ code: 'SYNTHETIC_FAILURE', requestId: 'request-header', executionId: 'execution-header', diagnosticId: 'diagnostic-header' })
})
