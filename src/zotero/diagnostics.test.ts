/** 诊断验证真实流异常顺序、取消归因、脱敏以及异步落盘/清空竞争。 */
import { afterEach, expect, it, vi } from 'vitest'
import { Diagnostics, diagnostics, markDiagnosticAbort, stopDiagnostics } from './diagnostics'
import { TemporaryChatClient } from '@/chat/temporary-chat'
import { ByokChatClient } from '@/chat/byok-chat'
import { diagnosticGesture, saveDiagnosticExport } from './diagnostics-panel'

const host = {}
it('retains bounded operation metrics and build identity through persistence without raw data', async () => {
  const disk = memoryDisk(), store = new Diagnostics(disk.platform); await store.ready
  store.environment = { build: '0.4.11-test-build' }
  const trace = store.start({ feature: 'ocr', operationId: 'operation-test' })
  trace.event('service_start', { elapsedMs: 60000, exitCode: 2, width: 320, height: 600, visible: true, page: 'source', secret: 'PRIVATE' } as never)
  trace.end(); await store.flush()
  const restored = new Diagnostics(disk.platform); await restored.ready
  expect(restored.list()[0].environment?.build).toBe('0.4.11-test-build')
  expect(restored.list()[0].events[1]).toMatchObject({ elapsedMs: 60000, exitCode: 2, width: 320, height: 600, visible: true, page: 'source' })
  expect(restored.export()).not.toContain('PRIVATE')
  store.dispose(); restored.dispose()
})
afterEach(() => { stopDiagnostics(host); vi.useRealTimers() })
const input = { clientRequestId: 'request-1', conversationId: 'conversation-1', messages: [{ id: 'message-1', role: 'user' as const, text: 'PRIVATE-PROMPT' }], requireComplete: true }
function memoryDisk() {
  let disk = ''
  const io = { makeDirectory: vi.fn(async () => undefined), readUTF8: vi.fn(async () => disk), writeUTF8: vi.fn(async (_path: string, data: string) => { disk = data }) }
  const paths = { profileDir: 'profile', join: (...parts: string[]) => parts.join('/') }
  return { io, platform: { IOUtils: io, PathUtils: paths }, read: () => disk }
}
it('preserves ReferenceError without inventing errors on normal events across persistence', async () => {
  const disk = memoryDisk(), store = new Diagnostics(disk.platform); await store.ready
  const success = store.start({ feature: 'account' })
  success.event('headers', { status: 200 }); success.end()
  store.record('ocr', 'service_start', new ReferenceError('PRIVATE runtime details'))
  await store.flush()
  const restored = new Diagnostics(disk.platform); await restored.ready
  for (const records of [store.list(), restored.list(), JSON.parse(store.export()).records]) {
    expect(records.find((row: { category: string }) => row.category === 'error').firstError.name).toBe('ReferenceError')
    expect(records.find((row: { category: string }) => row.category === 'success').events.every((event: { name?: string }) => event.name === undefined)).toBe(true)
  }
  expect(disk.read()).not.toContain('PRIVATE')
  store.dispose(); restored.dispose()
})
it('preserves callback failure before stream cleanup, without collecting content or credentials', async () => {
  const store = diagnostics(host)!
  const cancelled = vi.fn()
  const client = new TemporaryChatClient({ baseUrl: 'https://example.test', token: 'PRIVATE-TOKEN', fetchImpl: vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"PRIVATE-RESPONSE"}\n\n')) }, cancel: cancelled }))) })
  const error = Object.assign(new Error('PRIVATE-PROMPT sk-SECRET C:\\private.pdf'), { body: 'PRIVATE-RESPONSE' })
  await expect(client.send({ ...input, onTextDelta: () => { throw error } })).rejects.toBe(error)
  const [row] = store.list()
  expect(row.firstError?.stage).toBe('callback_error')
  expect(row.events.map(e => e.stage)).toContain('cleanup_cancel')
  expect(row.category).toBe('error'); expect(row.bytes).toBeGreaterThan(0); expect(cancelled).toHaveBeenCalledTimes(1)
  expect(store.export()).not.toMatch(/PRIVATE|SECRET|private.pdf/)
})
it.each(['user_stop','window_unload','preference:analysis','plugin_shutdown','recovery_timeout'])('records explicit %s without another dispatch', async source => {
  const store = diagnostics(host)!, controller = new AbortController()
  const request = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve,reject) => { init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted','AbortError'))) }))
  const client = new TemporaryChatClient({ baseUrl: 'https://example.test', token: 'secret', fetchImpl: request })
  const pending = client.send({ ...input, signal: controller.signal })
  markDiagnosticAbort(controller.signal,source); controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(request).toHaveBeenCalledTimes(1)
  expect(store.list()[0]).toMatchObject({ category: 'cancelled', events: expect.arrayContaining([expect.objectContaining({ stage: 'abort', source })]) })
})
it.each([
  ['data: {"type":"text-delta","delta":"hello"}\n\n', 'error', false],
  ['data: {"type":"text-delta","delta":"hello"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n','success',true],
  ['data: {"type":"error","errorText":"PRIVATE-ERROR"}\n\n','error',false],
])('tracks completion independently of body content', async (body,category,success) => {
  const store = diagnostics(host)!
  const client = new TemporaryChatClient({ baseUrl: 'https://example.test', token: 'secret', fetchImpl: vi.fn(async () => new Response(body)) })
  if (success) await expect(client.send(input)).resolves.toBe('hello')
  else await expect(client.send(input)).rejects.toThrow()
  expect(store.list()[0].category).toBe(category)
  expect(store.export()).not.toContain('PRIVATE-ERROR')
})
it('collects known business rejection separately and preserves output when storage is unavailable', async () => {
  const store = diagnostics(host)!
  const client = new TemporaryChatClient({ baseUrl: 'https://example.test', token: 'secret', fetchImpl: vi.fn(async () => new Response(JSON.stringify({ code: 'POINTS_INSUFFICIENT', error: 'private balance' }),{ status: 402 })) })
  await expect(client.send(input)).rejects.toThrow()
  expect(store.list()[0].category).toBe('business')
  await store.flush(); expect(store.storageAvailable).toBe(false)
  expect(store.export()).not.toContain('private balance')
})
it('does not hide BYOK authentication failures as expected business rejection', async () => {
  const store = diagnostics(host)!
  const client = new ByokChatClient({ config: { protocol: 'openai-chat-completions', baseUrl: 'https://example.test', apiKey: 'synthetic-key', model: 'synthetic', maxOutputTokens: 1000 }, fetchImpl: vi.fn(async () => new Response('{"error":{"message":"private provider text"}}',{ status: 403 })) })
  await expect(client.send(input)).rejects.toThrow()
  expect(store.list()[0].category).toBe('error')
  expect(store.export()).not.toContain('private provider text')
})
it('clears queued and in-flight writes without resurrecting old records', async () => {
  const disk = memoryDisk(), store = new Diagnostics(disk.platform); await store.ready
  store.record('analysis','old',new Error('private'))
  const cleared = store.clear()
  await cleared
  expect(JSON.parse(disk.read()).records).toEqual([])
  store.record('chat','new',new Error('private')); await store.flush()
  const restored = new Diagnostics(disk.platform); await restored.ready
  expect(restored.list()).toHaveLength(1); expect(restored.list()[0].firstError?.stage).toBe('new')
  store.dispose(); restored.dispose()
})
it('waits for an older in-flight disk write before persisting clear', async () => {
  const disk = memoryDisk(), store = new Diagnostics(disk.platform); await store.ready
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const write = disk.io.writeUTF8.getMockImplementation()!
  disk.io.writeUTF8.mockImplementationOnce(async (path,data) => { await gate; await write(path,data) })
  store.record('analysis','old',new Error())
  await vi.waitFor(() => expect(disk.io.writeUTF8).toHaveBeenCalledTimes(1))
  const cleared = store.clear()
  release(); await cleared
  expect(JSON.parse(disk.read()).records).toEqual([])
  store.dispose()
})
it('retains at most 500 records and limits the serialized disk payload', async () => {
  vi.useFakeTimers()
  const disk = memoryDisk(), store = new Diagnostics(disk.platform); await store.ready
  for (let i=0;i<510;i++) store.start({ feature: 'analysis', clientRequestId: 'request-'+i })
  expect(store.list()).toHaveLength(500)
  for (let i=0;i<300;i++) {
    const trace = store.start({ feature: 'analysis', model: 'm'.repeat(160), operationId: 'o'.repeat(160) })
    for (let j=0;j<32;j++) trace.event('stage_'+j,{ source: 's'.repeat(160) })
  }
  await store.flush()
  expect(new TextEncoder().encode(disk.read()).length).toBeLessThanOrEqual(2*1024*1024)
  store.dispose()
})
it('bounds retention and events, tolerates corrupt storage, and shares one host instance', async () => {
  const disk = memoryDisk(); await disk.io.writeUTF8('', 'broken')
  const store = new Diagnostics(disk.platform); await store.ready
  expect(store.list()).toEqual([])
  vi.useFakeTimers()
  const trace = store.start({ feature: 'analysis', token: 'PRIVATE', model: 'https://private?secret=PRIVATE' })
  for (let i=0;i<80;i++) trace.event('headers')
  trace.fail(new Error('PRIVATE'),'first'); trace.end()
  expect(store.list()[0].events.length).toBeLessThanOrEqual(32)
  expect(store.export()).not.toContain('PRIVATE')
  vi.advanceTimersByTime(8*86400000)
  expect(store.list()).toEqual([])
  expect(diagnostics(host)).toBe(diagnostics(host))
  store.dispose()
})
it('never reclassifies an earlier failure as cancellation during cleanup', () => {
  const store = diagnostics(host)!, controller = new AbortController(), trace = store.start({},controller.signal)
  trace.fail(new TypeError('private'),'read_failure')
  markDiagnosticAbort(controller.signal,'stream_cleanup'); controller.abort(); trace.fail(new DOMException('Aborted','AbortError')); trace.end()
  expect(store.list()[0]).toMatchObject({ category: 'error', firstError: { stage: 'read_failure' } })
})
it('requires five activations within five seconds and can unlock again', () => {
  let clock = 0; const open = vi.fn(), click = diagnosticGesture(open,() => clock)
  for (let i=0;i<4;i++) click()
  expect(open).not.toHaveBeenCalled(); clock = 5001; click(); expect(open).not.toHaveBeenCalled()
  for (let i=0;i<4;i++) click()
  expect(open).toHaveBeenCalledTimes(1)
})
it('exports through the native picker and does not write when cancelled', async () => {
  const write = vi.fn(), show = vi.fn(async () => 1)
  class FilePicker { modeSave=1; returnCancel=1; defaultString=''; defaultExtension=''; file='chosen.json'; init() {} appendFilter() {} show=show }
  const platform = { ChromeUtils: { importESModule: () => ({ FilePicker }) }, IOUtils: { writeUTF8: write } }
  await expect(saveDiagnosticExport({} as Window,'safe',platform)).resolves.toBe(false); expect(write).not.toHaveBeenCalled()
  show.mockResolvedValue(0)
  await expect(saveDiagnosticExport({} as Window,'safe',platform)).resolves.toBe(true); expect(write).toHaveBeenCalledWith('chosen.json','safe',{ tmpPath: 'chosen.json.tmp' })
})
