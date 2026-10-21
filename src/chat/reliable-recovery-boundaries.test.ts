/** 恢复边界的独立回归：使用真实客户端、真实请求日志和合成网络，覆盖重建实例后的付费围栏。 */
import { afterEach, expect, it, vi } from 'vitest'
import { ReliableTemporaryChatClient } from './reliable-temporary-chat'
import { ReliableByokChatClient } from './reliable-byok-chat'
import { TemporaryRequestStore } from './temporary-request-store'

afterEach(() => vi.useRealTimers())

/** 每次 open 创建全新 IO 身份，验证磁盘结果而非模块级内存缓冲。 */
function disk() {
  const files = new Map<string, string>()
  const paths = { profileDir: '/recovery-boundaries', join: (...parts: string[]) => parts.join('/'), filename: (path: string) => path.split('/').at(-1)! }
  return {
    open: () => new TemporaryRequestStore({
      makeDirectory: async () => {},
      writeUTF8: async (path, value) => { files.set(path, value) },
      readUTF8: async path => files.get(path)!,
      getChildren: async path => [...new Set([...files.keys()].filter(file => file.startsWith(path + '/')).map(file => path + '/' + file.slice(path.length + 1).split('/')[0]))],
    }, paths),
  }
}
const input = {
  clientRequestId: 'original-request', operationId: 'original-operation', conversationId: 'pdf-fixture',
  durableExecution: true, reuseCompletedOperation: true,
  messages: [{ id: 'original-message', role: 'user' as const, text: 'Translate this synthetic passage.' }],
}
const headers = {
  'x-jadense-temporary-protocol': '1', 'x-jadense-temporary-account': 'synthetic-stable-owner',
  'x-jadense-temporary-durable': '1', 'x-jadense-temporary-recover-or-admit': '1',
}
const byokConfig = { protocol: 'openai-chat-completions' as const, baseUrl: 'https://provider.test', apiKey: 'synthetic', model: 'fixture', maxOutputTokens: 1000 }

it('preserves an expired operation tombstone when the PDF UI supplies a new request UUID', async () => {
  const storage = disk()
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    if (init?.method === 'POST') throw new TypeError('response lost after model dispatch')
    return Response.json({ code: 'TEMPORARY_RESULT_EXPIRED', error: 'Saved result expired.' }, { status: 410, headers })
  })
  const open = () => new ReliableTemporaryChatClient({ baseUrl: 'https://expiry.test', token: 'synthetic', fetchImpl }, storage.open())
  await expect(open().send(input)).rejects.toThrow('response lost')
  await expect(open().send({ ...input, clientRequestId: 'first-ui-rebuild' })).rejects.toMatchObject({ status: 410 })
  await expect(open().send({ ...input, clientRequestId: 'second-ui-rebuild' })).rejects.toMatchObject({ status: 410, executionState: 'unknown' })
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  const rows = await storage.open().list()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ status: 'failed', issue: { status: 410 }, body: { clientRequestId: input.clientRequestId } })
})

it('attempts every pending cancellation when one DELETE fails and does not convert pending to retryable', async () => {
  const storage = disk()
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    if (init?.method === 'POST') throw new TypeError('response lost')
    if (init?.method === 'DELETE') {
      if (String(url).includes('requestId=original-request')) throw new TypeError('first cancellation connection lost')
      return Response.json({ cancelRequested: true, state: 'running' }, { status: 202, headers })
    }
    throw new Error('Unexpected request')
  })
  const open = () => new ReliableTemporaryChatClient({ baseUrl: 'https://cancel.test', token: 'synthetic', fetchImpl }, storage.open())
  await expect(open().send(input)).rejects.toThrow()
  await expect(open().send({ ...input, clientRequestId: 'second-request', operationId: 'second-operation' })).rejects.toThrow()
  await expect(open().cancelOperation(input.conversationId)).rejects.toThrow('cancellation connection lost')
  const cancellations = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE')
  expect(cancellations).toHaveLength(2)
  expect(cancellations.map(([url]) => new URL(String(url)).searchParams.get('requestId')).sort()).toEqual(['original-request', 'second-request'])
  expect((await storage.open().list()).map(row => row.status)).toEqual(['pending', 'pending'])
})

it.each(['jadense', 'byok'])('reuses %s confirmed partial output after a new store and UI UUID without another model call', async route => {
  const storage = disk(), text = '{"id":"passage-1","translation":"retained"}'
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    return route === 'byok'
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'length' }] })}\n\n`)
      : Response.json({ state: 'partial', complete: false, text }, { headers })
  })
  const open = () => route === 'byok'
    ? new ReliableByokChatClient({ config: byokConfig, fetchImpl }, storage.open())
    : new ReliableTemporaryChatClient({ baseUrl: 'https://partial.test', token: 'synthetic', fetchImpl }, storage.open())
  await expect(open().send(input)).rejects.toMatchObject({ executionState: 'partial', partialText: text })
  await expect(open().send({ ...input, clientRequestId: 'rebuilt-ui-request' })).rejects.toMatchObject({ executionState: 'partial', partialText: text })
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect((await storage.open().list())[0]).toMatchObject({ status: 'failed', resultState: 'partial', text })
})

it.each(['jadense', 'byok'])('reuses a confirmed %s failure after restart and leaves missing-passage repairs to a new operation', async route => {
  const storage = disk()
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    return route === 'byok'
      ? new Response('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n')
      : Response.json({ state: 'failed', complete: false, text: '', code: 'OUTPUT_FAILED' }, { headers })
  })
  const open = () => route === 'byok'
    ? new ReliableByokChatClient({ config: byokConfig, fetchImpl }, storage.open())
    : new ReliableTemporaryChatClient({ baseUrl: 'https://failed.test', token: 'synthetic', fetchImpl }, storage.open())
  await expect(open().send(input)).rejects.toMatchObject({ executionState: 'failed' })
  await expect(open().send({ ...input, clientRequestId: 'rebuilt-ui-request' })).rejects.toMatchObject({ executionState: 'failed' })
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect((await storage.open().list())[0]).toMatchObject({ status: 'failed', resultState: 'failed', text: '' })
})

it('recovers a confirmed cancellation without silently starting a new paid batch', async () => {
  const storage = disk()
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'HEAD'
    ? new Response(null, { headers })
    : Response.json({ state: 'cancelled', complete: false, text: 'received before Stop' }, { headers }))
  const open = () => new ReliableTemporaryChatClient({ baseUrl: 'https://cancelled.test', token: 'synthetic', fetchImpl }, storage.open())
  await expect(open().send(input)).rejects.toMatchObject({ executionState: 'cancelled', partialText: 'received before Stop' })
  await expect(open().send({ ...input, clientRequestId: 'continue-ui-request' })).rejects.toMatchObject({ executionState: 'cancelled', partialText: 'received before Stop' })
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it.each(['jadense', 'byok'])('permits a linked %s attempt after a confirmed 429 refusal while reusing completed operation output', async route => {
  const storage = disk()
  let submissions = 0
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    submissions++
    if (submissions === 1) return Response.json({ state: 'failed', code: 'RATE_LIMITED', error: 'Synthetic refusal' }, { status: 429, headers })
    return route === 'byok'
      ? new Response('data: {"choices":[{"delta":{"content":"completed after cooldown"},"finish_reason":"stop"}]}\n\n')
      : Response.json({ state: 'completed', complete: true, text: 'completed after cooldown' }, { headers })
  })
  const open = () => route === 'byok'
    ? new ReliableByokChatClient({ config: byokConfig, fetchImpl }, storage.open())
    : new ReliableTemporaryChatClient({ baseUrl: 'https://cooldown.test', token: 'synthetic', fetchImpl }, storage.open())
  await expect(open().send(input)).rejects.toMatchObject({ status: 429 })
  expect(await open().send({ ...input, clientRequestId: 'after-cooldown-ui-request' })).toBe('completed after cooldown')
  expect(await open().send({ ...input, clientRequestId: 'rebuilt-ui-request' })).toBe('completed after cooldown')
  expect(submissions).toBe(2)
  const completed = (await storage.open().list()).find(row => row.status === 'completed')
  expect(completed?.body.previousRequestId).toBe(input.clientRequestId)
})

it('retains BYOK streamed output after a network failure and never retries an unknown execution automatically', async () => {
  const storage = disk(), encoder = new TextEncoder()
  let fail!: () => void
  const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"already received"}}]}\n\n'))
      fail = () => controller.error(new TypeError('network failed after text'))
    },
  })))
  const open = () => new ReliableByokChatClient({ config: byokConfig, fetchImpl }, storage.open())
  const result = open().send({ ...input, clientFeature: 'translation', onTextDelta: () => { queueMicrotask(fail) } })
  await expect(result).rejects.toMatchObject({ code: 'BYOK_EXECUTION_UNCONFIRMED', executionState: 'unknown', partialText: 'already received' })
  await expect(open().send({ ...input, clientRequestId: 'rebuilt-ui-request' })).rejects.toMatchObject({ executionState: 'unknown', partialText: 'already received' })
  expect(fetchImpl).toHaveBeenCalledOnce()
  expect((await storage.open().list())[0]).toMatchObject({ status: 'pending', text: 'already received' })
})

it('persists running and unknown server checkpoints without granting a new generation', async () => {
  const storage = disk(), onTextDelta = vi.fn()
  let recoveryReads = 0
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    if (init?.method === 'POST') throw new TypeError('response lost')
    recoveryReads++
    return recoveryReads === 1
      ? Response.json({ state: 'running', text: 'saved', complete: false }, { status: 202, headers: { ...headers, 'retry-after': '1' } })
      : Response.json({ state: 'unknown', text: 'saved while disconnected', complete: false, code: 'TEMPORARY_EXECUTION_UNCERTAIN' }, { status: 409, headers })
  })
  const open = () => new ReliableTemporaryChatClient({ baseUrl: 'https://checkpoint.test', token: 'synthetic', fetchImpl }, storage.open())
  await expect(open().send(input)).rejects.toThrow()
  await expect(open().send({ ...input, clientRequestId: 'rebuilt-ui-request', onTextDelta })).rejects.toMatchObject({ executionState: 'unknown', partialText: 'saved while disconnected' })
  expect(onTextDelta).toHaveBeenCalledWith('saved', 'saved')
  expect(onTextDelta).toHaveBeenCalledWith(' while disconnected', 'saved while disconnected')
  expect((await storage.open().list())[0]).toMatchObject({ status: 'pending', text: 'saved while disconnected', body: { clientRequestId: 'original-request' } })
  await expect(open().send({ ...input, clientRequestId: 'another-ui-request' })).rejects.toMatchObject({ executionState: 'unknown' })
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})
