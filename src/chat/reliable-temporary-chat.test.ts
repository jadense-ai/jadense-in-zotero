/** 使用真实新版客户端与内存磁盘验证跨实例恢复、协议协商及拒绝不重发。 */
import { it, expect, vi } from 'vitest'
import { ReliableTemporaryChatClient, TemporaryPartialOutputError } from './reliable-temporary-chat'
import { TemporaryRequestStore } from './temporary-request-store'
import { ReliableByokChatClient } from './reliable-byok-chat'
import { retryPDFTranslation } from '@/zotero/pdf-translation-retry'
function store() {
  const files = new Map<string, string>()
  return new TemporaryRequestStore({ makeDirectory: async () => {}, writeUTF8: async (path, text) => { files.set(path, text) }, readUTF8: async path => files.get(path)!, getChildren: async path => [...new Set([...files.keys()].filter(file => file.startsWith(path + '/')).map(file => path + '/' + file.slice(path.length + 1).split('/')[0]))] },
    { profileDir: '/fixture', join: (...parts) => parts.join('/'), filename: path => path.split('/').at(-1)! })
}
const input = { clientRequestId: 'request-1', operationId: 'operation-1', conversationId: 'conversation', messages: [{ id: 'message', role: 'user' as const, text: 'example' }] }
const headers = { 'x-jadense-temporary-protocol': '1' }
it('exposes authoritative partial text for local PDF repair without marking execution completed', async () => {
  const disk = store(), partialText = '[{"id":"p1","output":"translated"},'
  const fetchImpl = vi.fn(async () => Response.json({ state: 'partial', complete: false, text: partialText, finishReason: 'length', executionId: 'fixture' }, { headers }))
  const client = new ReliableTemporaryChatClient({ baseUrl: 'https://partial.test', token: 'synthetic', fetchImpl }, disk)
  const row = { id: crypto.randomUUID(), account: 'a'.repeat(64), fingerprint: 'f', createdAt: '', status: 'pending' as const, body: { origin: 'https://partial.test', temporaryConversationId: 'pdf-fixture', clientRequestId: 'r' } }
  await expect(client.recover(row)).rejects.toMatchObject({ code: 'OUTPUT_PARTIAL', partialText, executionState: 'partial' })
  expect((await disk.list())[0]).toMatchObject({ status: 'failed', text: partialText })
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})
it('recovers a stream error as partial text with no second model POST', async () => {
  vi.useFakeTimers()
  try {
    const text = '[{"id":"a","output":"kept"},'
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { headers })
      if (init?.method === 'POST') return new Response('data: {"type":"error","errorText":"incomplete"}\n\n', { headers: { ...headers, 'content-type': 'text/event-stream' } })
      return Response.json({ state: 'partial', complete: false, text }, { headers })
    })
    const client = new ReliableTemporaryChatClient({ baseUrl: 'https://partial-stream.test', token: 'synthetic', fetchImpl }, store())
    const result = retryPDFTranslation({ route: 'jadense', signal: new AbortController().signal, run: () => client.send(input), recover: async () => client.recover((await client.pending())[0]), progress: vi.fn() })
    const assertion = expect(result).rejects.toBeInstanceOf(TemporaryPartialOutputError)
    await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    await vi.runAllTimersAsync(); await assertion
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  } finally { vi.useRealTimers() }
})
it('reuses persisted authoritative partial output across clients without resubmission', async () => {
  const disk = store(), text = '[{"id":"a","output":"retained"},'
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'HEAD' ? new Response(null, { headers }) : Response.json({ state: 'partial', complete: false, text }, { headers }))
  const options = { baseUrl: 'https://partial-cache.test', token: 'synthetic', fetchImpl }
  const pdf = { ...input, clientFeature: 'translation' as const, reuseCompletedOperation: true }
  await expect(new ReliableTemporaryChatClient(options, disk).send(pdf)).rejects.toMatchObject({ code: 'OUTPUT_PARTIAL', partialText: text })
  await expect(new ReliableTemporaryChatClient(options, disk).send({ ...pdf, clientRequestId: 'new-ui-id' })).rejects.toMatchObject({ code: 'OUTPUT_PARTIAL', partialText: text })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect((await disk.list())[0]).toMatchObject({ status: 'failed', resultState: 'partial' })
})
it('automatically retrieves the original PDF request after a lost response with exactly one POST', async () => {
  vi.useFakeTimers()
  try {
    const disk = store()
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { headers })
      if (init?.method === 'POST') throw new TypeError('connection lost after submission')
      return Response.json({ complete: true, state: 'completed', text: 'recovered translation' }, { headers })
    })
    const client = new ReliableTemporaryChatClient({ baseUrl: 'https://pdf-auto-recovery.test', token: 'synthetic', fetchImpl }, disk)
    const result = retryPDFTranslation({ route: 'jadense', signal: new AbortController().signal,
      run: () => client.send({ ...input, clientFeature: 'translation' }),
      recover: async () => client.recover((await client.pending())[0]), progress: vi.fn() })
    await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    await vi.runAllTimersAsync()
    expect(await result).toBe('recovered translation')
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect((await disk.list())[0].status).toBe('completed')
  } finally { vi.useRealTimers() }
})
it('caches only successful translation capability probes and reuses a durable completed PDF operation', async () => {
  const disk = store(), fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'HEAD' ? new Response(null, { headers }) : Response.json({ complete: true, state: 'completed', text: 'done' }, { headers }))
  const client = new ReliableTemporaryChatClient({ baseUrl: 'https://pdf-capability.test', token: 'synthetic-pdf', fetchImpl }, disk)
  const pdf = { ...input, clientFeature: 'translation' as const, reuseCompletedOperation: true }
  expect(await client.send(pdf)).toBe('done')
  expect(await client.send({ ...pdf, clientRequestId: 'new-ui-id' })).toBe('done')
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(await client.send({ ...pdf, clientRequestId: 'batch-2-request', operationId: 'batch-2' })).toBe('done')
  expect(fetchImpl).toHaveBeenCalledTimes(3)
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'HEAD')).toHaveLength(1)
})

it('does not spend the recovery deadline while waiting for translation quota', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  try {
    const { translationScheduler, saveTranslationSpeed } = await import('./translation-queue')
    let preference = '{}'
    const host = { Prefs: { get: () => preference, set: (_key: string, value: unknown) => { preference = String(value) } } }
    const baseUrl = 'https://slow-recovery.test'
    saveTranslationSpeed(host, baseUrl, { rpm: 1, concurrency: 2, batchTokens: 1600 })
    const scheduler = translationScheduler(host)
    await scheduler.run({ address: baseUrl, task: 'other', fetchImpl: async () => new Response('ok') }, network => network(baseUrl))
    const fetchImpl = vi.fn(async () => Response.json({ complete: true, state: 'completed', text: 'recovered' }, { headers }))
    const result = scheduler.run({ address: baseUrl, task: 'pdf', fetchImpl }, (network, signal) => new ReliableTemporaryChatClient({ baseUrl, token: 'synthetic', fetchImpl: network }, store()).recover({ id: crypto.randomUUID(), account: '0'.repeat(64), fingerprint: 'unused', createdAt: '', status: 'pending', body: { origin: baseUrl, temporaryConversationId: 'c', clientRequestId: 'r' } }, { signal }))
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await result).toBe('recovered'); expect(fetchImpl).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})
it('requires capability confirmation before dispatching to an old server', async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }))
  await expect(new ReliableTemporaryChatClient({ baseUrl: 'https://example.test', token: 'synthetic', fetchImpl }, store()).send(input)).rejects.toThrow()
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(fetchImpl.mock.calls[0][1]?.method).toBe('HEAD')
})
it('reuses the exact request identity after client recreation and receives its replay', async () => {
  const disk = store(); let posts = 0
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    if (init?.method === 'POST') { posts++; expect(JSON.parse(String(init.body)).clientRequestId).toBe('request-1'); if (posts === 1) throw new TypeError('connection lost') }
    return Response.json({ text: 'recovered', complete: true, state: 'completed' }, { headers })
  })
  const options = { baseUrl: 'https://example.test', token: 'synthetic', fetchImpl }
  await expect(new ReliableTemporaryChatClient(options, disk).send(input)).rejects.toThrow('connection lost')
  expect((await disk.list())[0].body.clientRequestId).toBe('request-1')
  await expect(new ReliableTemporaryChatClient(options, disk).send({ ...input, clientRequestId: 'new-ui-id' })).resolves.toBe('recovered')
  expect(posts).toBe(2)
})
it('persists a definitive rejection and does not automatically retry it', async () => {
  const disk = store()
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => init?.method === 'HEAD' ? new Response(null, { headers }) : Response.json({ code: 'POINTS_INSUFFICIENT', error: '积分不足' }, { status: 402, headers }))
  await expect(new ReliableTemporaryChatClient({ baseUrl: 'https://example.test', token: 'synthetic', fetchImpl }, disk).send(input)).rejects.toMatchObject({ code: 'POINTS_INSUFFICIENT' })
  expect(fetchImpl).toHaveBeenCalledTimes(2); expect((await disk.list())[0].status).toBe('failed')
})
it('never merges identical inputs belonging to different logical operations', async () => {
  const disk = store(), ids: string[] = []
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    ids.push(JSON.parse(String(init?.body)).clientRequestId); throw new Error('offline')
  })
  const client = new ReliableTemporaryChatClient({ baseUrl: 'https://example.test', token: 'synthetic', fetchImpl }, disk)
  await expect(client.send(input)).rejects.toThrow()
  await expect(client.send({ ...input, clientRequestId: 'request-2', operationId: 'operation-2' })).rejects.toThrow()
  expect(ids).toEqual(['request-1', 'request-2'])
})
it('never treats recovered partial output as successful', async () => {
  const disk = store()
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => init?.method === 'HEAD' ? new Response(null, { headers }) : Response.json({ state: 'partial', complete: false, text: 'partial' }, { headers }))
  await expect(new ReliableTemporaryChatClient({ baseUrl: 'https://example.test', token: 'synthetic', fetchImpl }, disk).send(input)).rejects.toThrow()
  expect((await disk.list())[0].text).toBe('partial')
})
it('retains a definitive server failure and links an explicit new execution', async () => {
  const disk = store(), sent: Record<string, unknown>[] = []
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ state: 'failed', error: 'Provider failed', complete: false }, { status: 500, headers })
  })
  const client = new ReliableTemporaryChatClient({ baseUrl: 'https://example.test', token: 'synthetic', fetchImpl }, disk)
  await expect(client.send(input)).rejects.toThrow('Provider failed')
  expect((await disk.list())[0].status).toBe('failed')
  await expect(client.send({ ...input, clientRequestId: 'explicit-next' })).rejects.toThrow()
  expect(sent[1]).toMatchObject({ clientRequestId: 'explicit-next', previousRequestId: 'request-1' })
})
it('BYOK reuses a completed response and never resends an uncertain request after restart', async () => {
  const disk = store()
  const config = { protocol: 'openai-chat-completions' as const, baseUrl: 'https://example.test', apiKey: 'synthetic', model: 'fixture', maxOutputTokens: 2048 }
  const fetchImpl = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
  const options = { config, fetchImpl }
  expect(await new ReliableByokChatClient(options, disk).send(input)).toBe('done')
  expect(await new ReliableByokChatClient(options, disk).send(input)).toBe('done')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  fetchImpl.mockRejectedValue(new Error('offline'))
  const next = { ...input, clientRequestId: 'next', messages: [{ ...input.messages[0], text: 'next source' }] }
  await expect(new ReliableByokChatClient(options, disk).send(next)).rejects.toThrow('offline')
  await expect(new ReliableByokChatClient(options, disk).send({ ...next, clientRequestId: 'new-ui-id' })).rejects.toThrow()
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  await expect(new ReliableByokChatClient({ ...options, config: { ...config, apiKey: 'rotated-synthetic' } }, disk).send(next)).rejects.toThrow('different input')
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})
it('bounds a hanging recovery request at 60 seconds without redispatching', async () => {
  vi.useFakeTimers()
  try {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const client = new ReliableTemporaryChatClient({ baseUrl: 'https://example.test', token: 'synthetic', fetchImpl }, store())
    const result = expect(client.recover({ id: 'unused', account: 'unused', fingerprint: 'unused', createdAt: '', status: 'pending', body: { origin: 'https://example.test', temporaryConversationId: 'c', clientRequestId: 'r' } })).rejects.toThrow(/60/)
    await vi.advanceTimersByTimeAsync(60_000); await result
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][1]?.method).not.toBe('POST')
  } finally { vi.useRealTimers() }
})
it('BYOK persists explicit denial and permits only an explicit new request identity', async () => {
  const disk = store()
  const options = { config: { protocol: 'openai-chat-completions' as const, baseUrl: 'https://example.test', apiKey: 'synthetic', model: 'fixture', maxOutputTokens: 2048 }, fetchImpl: vi.fn(async () => Response.json({ error: { message: 'Insufficient funds' } }, { status: 402 })) }
  const client = new ReliableByokChatClient(options, disk)
  await expect(client.send(input)).rejects.toMatchObject({ status: 402 })
  expect((await disk.list())[0].status).toBe('failed')
  await expect(client.send(input)).rejects.toThrow(); expect(options.fetchImpl).toHaveBeenCalledTimes(1)
  await expect(client.send({ ...input, clientRequestId: 'explicit-next' })).rejects.toMatchObject({ status: 402 })
  expect(options.fetchImpl).toHaveBeenCalledTimes(2)
  expect((await disk.list()).find(row => row.body.clientRequestId === 'explicit-next')?.body.previousRequestId).toBe('request-1')
})
