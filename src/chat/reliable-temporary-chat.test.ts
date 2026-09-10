/** 使用真实新版客户端与内存磁盘验证跨实例恢复、协议协商及拒绝不重发。 */
import { it, expect, vi } from 'vitest'
import { ReliableTemporaryChatClient } from './reliable-temporary-chat'
import { TemporaryRequestStore } from './temporary-request-store'
import { ReliableByokChatClient } from './reliable-byok-chat'
function store() {
  const files = new Map<string, string>()
  return new TemporaryRequestStore({ makeDirectory: async () => {}, writeUTF8: async (path, text) => { files.set(path, text) }, readUTF8: async path => files.get(path)!, getChildren: async path => [...new Set([...files.keys()].filter(file => file.startsWith(path + '/')).map(file => path + '/' + file.slice(path.length + 1).split('/')[0]))] },
    { profileDir: '/fixture', join: (...parts) => parts.join('/'), filename: path => path.split('/').at(-1)! })
}
const input = { clientRequestId: 'request-1', operationId: 'operation-1', conversationId: 'conversation', messages: [{ id: 'message', role: 'user' as const, text: 'example' }] }
const headers = { 'x-jadense-temporary-protocol': '1' }
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
