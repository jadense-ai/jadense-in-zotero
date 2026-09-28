/** 三种 BYOK wire、明确拒绝回退与不确定执行边界，不调用真实付费服务。 */
import { describe, expect, it, vi } from 'vitest'
import { ByokChatClient, type ByokProtocol } from './byok-chat'
import type { ChatResponseFormat } from './response-format'

const format: ChatResponseFormat = { type: 'json_schema', name: 'test_review', fallback: 'text', schema: { type: 'object', properties: { overview: { type: 'string' } }, required: ['overview'], additionalProperties: false } }
const input = { clientRequestId: 'fixture', conversationId: 'fixture', messages: [{ id: 'm', role: 'user' as const, text: 'paper' }], responseFormat: format }
function success(protocol: ByokProtocol, text = '{"overview":"结果"}') {
  const events = protocol === 'openai-chat-completions' ? [{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]
    : protocol === 'openai-responses' ? [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed' }]
      : [{ type: 'content_block_delta', delta: { text } }, { type: 'message_stop' }]
  return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
const rejected = (message: string, status = 400, extra = {}) => Response.json({ error: { message }, ...extra }, { status })
function client(protocol: ByokProtocol, fetchImpl: typeof fetch) {
  return new ByokChatClient({ config: { protocol, baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic', model: 'fixture', maxOutputTokens: 8000 }, fetchImpl })
}
describe('optional native response format', () => {
  it.each(['openai-chat-completions', 'openai-responses', 'anthropic-messages'] as const)('sends %s schema and retains the text stream', async protocol => {
    const fetcher = vi.fn(async () => success(protocol))
    expect(await client(protocol, fetcher).send(input)).toContain('结果')
    const body = JSON.parse(String((fetcher.mock.calls as unknown as [unknown, RequestInit][])[0][1].body))
    const sent = protocol === 'openai-chat-completions' ? body.response_format.json_schema : protocol === 'openai-responses' ? body.text.format : body.output_config.format
    expect(sent.schema).toEqual(format.schema)
    expect(JSON.stringify(body)).toContain('Return one JSON object')
    expect(input.messages[0].text).toBe('paper')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each(['openai-chat-completions', 'openai-responses'] as const)('tries %s schema, JSON and text only after format parameter rejections', async protocol => {
    const fetcher = vi.fn().mockResolvedValueOnce(rejected('response_format json_schema is unsupported'))
      .mockResolvedValueOnce(rejected('json_object is not supported')).mockResolvedValueOnce(success(protocol, '**正文**'))
    expect(await client(protocol, fetcher).send(input)).toBe('**正文**')
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(protocol === 'openai-chat-completions' ? bodies[1].response_format : bodies[1].text.format).toEqual({ type: 'json_object' })
    expect(protocol === 'openai-chat-completions' ? bodies[2].response_format : bodies[2].text).toBeUndefined()
  })
  it('does not invent a JSON-object mode for Anthropic', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(rejected('output_config.format: unsupported parameter')).mockResolvedValueOnce(success('anthropic-messages'))
    await client('anthropic-messages', fetcher).send(input)
    expect(JSON.parse(fetcher.mock.calls[1][1].body).output_config).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([401, 403, 429, 500])('does not treat HTTP %s as format rejection', async status => {
    const fetcher = vi.fn(async () => rejected('response_format unsupported', status))
    await expect(client('openai-chat-completions', fetcher).send(input)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not retry billable, ambiguous, successful malformed, or interrupted outputs', async () => {
    for (const result of [rejected('model is unsupported'), rejected('response_format unsupported', 400, { usage: { total_tokens: 12 } }), rejected('response_format unsupported', 400, { error: { message: 'response_format unsupported', usage: { total_tokens: 12 } } }), success('openai-chat-completions', 'broken JSON')]) {
      const fetcher = vi.fn(async () => result)
      await client('openai-chat-completions', fetcher).send(input).catch(() => undefined)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
    const fetcher = vi.fn(async () => { throw new Error('network lost') })
    await expect(client('openai-responses', fetcher).send(input)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    const stream = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"response_format unsupported"}}\n\n'))
    await expect(client('openai-chat-completions', stream).send(input)).rejects.toThrow()
    expect(stream).toHaveBeenCalledTimes(1)
  })
  it('does not downgrade a contract that did not allow plain text', async () => {
    const fetcher = vi.fn(async () => rejected('output_config unsupported'))
    await expect(client('anthropic-messages', fetcher).send({ ...input, responseFormat: { ...format, fallback: undefined } })).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
