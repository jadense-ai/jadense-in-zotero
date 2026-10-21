/** 真实可靠客户端故障注入：重建实例、换令牌、未送达请求及磁盘错误不产生重复模型消费。 */
import { expect, it, vi } from 'vitest'
import { ReliableTemporaryChatClient } from './reliable-temporary-chat'
import { ReliableByokChatClient } from './reliable-byok-chat'
import { TemporaryRequestStore, type LocalTemporaryRequest } from './temporary-request-store'

function disk() {
  const files = new Map<string, string>()
  let failResults = false
  const io = {
    makeDirectory: async () => {},
    writeUTF8: async (path: string, text: string) => {
      if (failResults && JSON.parse(text).status === 'completed') throw new Error('synthetic disk unavailable')
      files.set(path, text)
    },
    readUTF8: async (path: string) => files.get(path)!,
    getChildren: async (path: string) => [...new Set([...files.keys()].filter(file => file.startsWith(path + '/')).map(file => path + '/' + file.slice(path.length + 1).split('/')[0]))],
  }
  const paths = { profileDir: '/fault-fixture', join: (...parts: string[]) => parts.join('/'), filename: (path: string) => path.split('/').at(-1)! }
  return { open: () => new TemporaryRequestStore(io, paths), fail: (value: boolean) => { failResults = value }, files }
}
const input = { clientRequestId: 'original-request', operationId: 'original-operation', conversationId: 'paper-task', durableExecution: true,
  clientFeature: 'analysis' as const, reuseCompletedOperation: true, messages: [{ id: 'message', role: 'user' as const, text: 'synthetic source' }] }
const headers = { 'x-jadense-temporary-protocol': '1', 'x-jadense-temporary-account': 'verified-owner-a',
  'x-jadense-temporary-durable': '1', 'x-jadense-temporary-recover-or-admit': '1' }
const complete = () => Response.json({ state: 'completed', complete: true, text: 'saved result' }, { headers })

it('restores a pending analysis after disconnect and token rotation with one model submission', async () => {
  const storage = disk()
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    if (init?.method === 'POST') throw new TypeError('response lost after dispatch')
    return complete()
  })
  const before = { baseUrl: 'https://resume.test', token: 'before', fetchImpl }
  await expect(new ReliableTemporaryChatClient(before, storage.open()).send(input)).rejects.toThrow('response lost')
  expect(await new ReliableTemporaryChatClient({ ...before, token: 'after' }, storage.open()).send(input)).toBe('saved result')
  expect(await new ReliableTemporaryChatClient({ ...before, token: 'after' }, storage.open()).send({ ...input, clientRequestId: 'ui-new' })).toBe('saved result')
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(new Headers(fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.headers).get('x-jadense-temporary-durable')).toBe('1')
})

it('keeps legacy window-owned requests on connection cancellation', async () => {
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'HEAD' ? new Response(null, { headers }) : complete())
  await new ReliableTemporaryChatClient({ baseUrl: 'https://window-owned.test', token: 'synthetic', fetchImpl }, disk().open()).send({ ...input, durableExecution: undefined })
  expect(new Headers(fetchImpl.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.headers).has('x-jadense-temporary-durable')).toBe(false)
})

it('does not return another account cached completion after switching tokens', async () => {
  const storage = disk(), outputs: string[] = []
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const other = new Headers(init?.headers).get('authorization') === 'Bearer other'
    if (init?.method === 'HEAD') return new Response(null, { headers: { ...headers, 'x-jadense-temporary-account': other ? 'verified-owner-b' : 'verified-owner-a' } })
    outputs.push(other ? 'account b' : 'account a')
    return Response.json({ state: 'completed', complete: true, text: outputs.at(-1) }, { headers })
  })
  const options = { baseUrl: 'https://owners.test', token: 'first', fetchImpl }
  expect(await new ReliableTemporaryChatClient(options, storage.open()).send(input)).toBe('account a')
  expect(await new ReliableTemporaryChatClient({ ...options, token: 'other' }, storage.open()).send(input)).toBe('account b')
  expect(outputs).toEqual(['account a', 'account b'])
})

it('keeps the original pending request through an expired-token recovery and renews only transport', async () => {
  const storage = disk()
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    if (init?.method === 'POST') throw new TypeError('connection interrupted after dispatch')
    return new Headers(init?.headers).get('authorization') === 'Bearer expired'
      ? Response.json({ error: 'Token expired' }, { status: 401 }) : complete()
  })
  const open = (token: string) => new ReliableTemporaryChatClient({ baseUrl: 'https://expired.test', token, fetchImpl }, storage.open())
  await expect(open('expired').send(input)).rejects.toThrow()
  await expect(open('expired').send(input)).rejects.toThrow()
  expect((await storage.open().list())[0].status).toBe('pending')
  expect(await open('renewed').send(input)).toBe('saved result')
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it('uses frozen identity for authoritative never-dispatched admission, ignoring unrelated additive fields', async () => {
  const storage = disk(), bodies: Record<string, unknown>[] = []
  let reached = false
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)))
      if (!String(url).endsWith('/temporary')) throw new TypeError('never reached server')
      reached = true; return complete()
    }
    return Response.json({ code: 'TEMPORARY_REQUEST_NOT_FOUND', admissionState: 'never_dispatched', futureMetadata: true }, { status: 404, headers })
  })
  const options = { baseUrl: 'https://admit.test', token: 'synthetic', fetchImpl }
  await expect(new ReliableTemporaryChatClient(options, storage.open()).send(input)).rejects.toThrow()
  expect(await new ReliableTemporaryChatClient(options, storage.open()).send({ ...input, clientRequestId: 'discard-ui-id' })).toBe('saved result')
  expect(reached).toBe(true)
  expect(bodies.map(body => body.clientRequestId)).toEqual(['original-request', 'original-request'])
  expect(bodies[1].messages).toEqual(bodies[0].messages)
})

it.each([false, true])('does not treat ordinary404 or another owner as safe to redispatch (wrongOwner=%s)', async wrongOwner => {
  const storage = disk()
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    if (init?.method === 'POST') throw new TypeError('offline')
    return Response.json(wrongOwner ? { code: 'TEMPORARY_REQUEST_NOT_FOUND', admissionState: 'never_dispatched' } : { error: 'route missing' },
      { status: 404, headers: { ...headers, ...(wrongOwner ? { 'x-jadense-temporary-account': 'another-owner' } : {}) } })
  })
  const options = { baseUrl: 'https://unsafe404.test', token: 'synthetic', fetchImpl }
  await expect(new ReliableTemporaryChatClient(options, storage.open()).send(input)).rejects.toThrow()
  await expect(new ReliableTemporaryChatClient(options, storage.open()).send(input)).rejects.toThrow()
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it.each(['jadense', 'byok'])('retains completed %s text when receipt saving fails and retries only storage', async route => {
  const storage = disk()
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'HEAD') return new Response(null, { headers })
    storage.fail(true)
    return route === 'byok'
      ? new Response('data: {"choices":[{"delta":{"content":"saved result"},"finish_reason":"stop"}]}\n\n')
      : complete()
  })
  const open = (key: string) => route === 'byok'
    ? new ReliableByokChatClient({ config: { protocol: 'openai-chat-completions', baseUrl: 'https://provider.test', apiKey: key, model: 'fixture', maxOutputTokens: 1000 }, fetchImpl }, storage.open())
    : new ReliableTemporaryChatClient({ baseUrl: 'https://write.test', token: key, fetchImpl }, storage.open())
  expect(await open('before').send(input)).toBe('saved result')
  expect(await open('after').send(input)).toBe('saved result')
  storage.fail(false)
  expect((await storage.open().list()).find(row => row.body.operationId === input.operationId)).toMatchObject({ status: 'completed', text: 'saved result' })
  expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it('serializes checkpoint writes so a slow streaming save cannot overwrite completed output', async () => {
  let release!: () => void
  let saved = ''
  const firstWrite = new Promise<void>(resolve => { release = resolve })
  const io = {
    makeDirectory: async () => {},
    writeUTF8: vi.fn(async (_path: string, text: string) => {
      if (JSON.parse(text).status === 'pending') await firstWrite
      saved = text
    }),
    readUTF8: async () => saved,
    getChildren: async () => [],
  }
  const paths = { profileDir: '/ordered-checkpoints', join: (...parts: string[]) => parts.join('/'), filename: (path: string) => path.split('/').at(-1)! }
  const row: LocalTemporaryRequest = { id: crypto.randomUUID(), account: 'a'.repeat(64), fingerprint: 'f', createdAt: '2026-10-21',
    body: { temporaryConversationId: 'paper', clientRequestId: 'request' }, status: 'pending', text: 'prefix' }
  const store = new TemporaryRequestStore(io, paths)
  const pending = store.save(row)
  row.status = 'completed'; row.text = 'complete output'
  const terminal = store.save(row)
  await vi.waitFor(() => expect(io.writeUTF8).toHaveBeenCalledOnce())
  release(); await Promise.all([pending, terminal])
  expect(JSON.parse(saved)).toMatchObject({ status: 'completed', text: 'complete output' })
  expect(JSON.parse(io.writeUTF8.mock.calls[0][1])).toMatchObject({ status: 'pending', text: 'prefix' })
})
