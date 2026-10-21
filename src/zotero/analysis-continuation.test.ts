/** 真实运行时/runner/磁盘格式的故障注入；模型、PDF 和 Zotero 原生写入使用合成边界。 */
import { afterEach, expect, it, vi } from 'vitest'
import { AnalysisRuntime } from './analysis-runtime'
import { AnalysisTaskStore, newAnalysisTask, type AnalysisTask } from './analysis-task-store'
import { runIndependentPaperAnalysis } from './paper-analysis-runner'
import { AUTO_FOLLOW_CHAT_MODEL_PREF_KEY } from './ai-settings'
import { RequestExecutionError } from '@/chat/request-feedback'
import { ReliableTemporaryChatClient } from '@/chat/reliable-temporary-chat'
import { TemporaryRequestStore } from '@/chat/temporary-request-store'
import type { TemporaryChatSendInput } from '@/chat/temporary-chat'
import type { PdfAnalysisSnapshot, SavedAnalysisAnnotations } from './reader-tools'

vi.mock('./research-context', () => ({ collectSourceForItem: async (_host: unknown, itemID: number) => ({ kind: 'file', itemID, libraryID: 1, itemKey: `PDF${itemID}`, title: 'Fixture' }) }))
vi.mock('./document-jobs', () => ({ documentJobs: () => ({ start: async () => { throw new Error('Optional fixture unavailable') }, pause: vi.fn() }) }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const pdf: PdfAnalysisSnapshot = { itemID: 42, libraryID: 1, itemKey: 'PDF42', title: 'Fixture', metadata: { title: 'Fixture', authors: [] },
  passages: [
    { id: 'p0', text: 'First evidence', pageIndex: 0, pageLabel: '1', position: { pageIndex: 0, rects: [[1, 2, 3, 4]] }, sortIndex: '00000|00000|00000' },
    { id: 'p1', text: 'Second evidence', pageIndex: 0, pageLabel: '1', position: { pageIndex: 0, rects: [[2, 3, 4, 5]] }, sortIndex: '00000|00001|00000' }],
  coverage: { pagesRead: 1, totalPages: 1, limited: false, pageNumbers: [1], warnings: [] } }
const complete = JSON.stringify({ summary: 'Retained synthetic summary', sections: [{ category: 'claim', summary: 'Retained claim' }], annotations: [{ passageId: 'p0', category: 'claim', comment: 'Retained note' }] })
const written = (): SavedAnalysisAnnotations => ({ created: 1, skipped: 0, failed: 0, unprocessed: 0, warnings: [] })
function fixture() {
  const prefs = new Map<string, unknown>([[AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, false], ['extensions.jadenseInZotero.token', 'synthetic'],
    ['extensions.jadenseInZotero.paperAnalysisModel', JSON.stringify({ route: 'jadense', selection: { kind: 'model', modelId: 'fixture' } })]])
  const host = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => { prefs.set(key, value) } } }
  const files = new Map<string, string>()
  let fail = (_task: AnalysisTask) => false
  const io = { makeDirectory: async () => {}, getChildren: async () => [...files.keys()], readUTF8: async (path: string) => files.get(path)!,
    writeUTF8: async (path: string, text: string) => { if (fail(JSON.parse(text))) throw new Error('Synthetic full disk'); files.set(path, text) } }
  const paths = { profileDir: '/synthetic', join: (...parts: string[]) => parts.join('/'), filename: (path: string) => path.split('/').at(-1)! }
  const store = () => new AnalysisTaskStore(io, paths)
  const context = vi.fn(async () => ({ account: 'synthetic-owner', configuration: 'synthetic-model', route: 'jadense' as const }))
  return { host, files, store, context, fail: (value: typeof fail) => { fail = value } }
}
function services() {
  return { readPdf: vi.fn(async () => structuredClone(pdf)), validateSource: vi.fn(async () => ({}) as never), send: vi.fn<(input: TemporaryChatSendInput) => Promise<string>>(async () => complete),
    saveAnnotations: vi.fn(async () => written()) }
}

it('resumes only annotation work after failure, including a new runtime using the same disk', async () => {
  const f = fixture(), svc = services()
  svc.saveAnnotations.mockRejectedValueOnce(new Error('Synthetic native failure'))
  const runner: typeof runIndependentPaperAnalysis = input => runIndependentPaperAnalysis({ ...input, services: svc })
  const first = new AnalysisRuntime(f.host, runner, { store: f.store(), context: f.context, retryDelay: 25 })
  await first.start(42)
  expect(first.get(42)).toMatchObject({ resumable: true, retrying: true })
  await first.dispose()
  const next = new AnalysisRuntime(f.host, runner, { store: f.store(), context: f.context })
  await next.restore()
  await vi.waitFor(() => expect(next.get(42)).toMatchObject({ busy: false, resumable: false }))
  expect(svc.send).toHaveBeenCalledOnce()
  expect(svc.readPdf).toHaveBeenCalledOnce()
  expect(svc.saveAnnotations).toHaveBeenCalledTimes(2)
  expect(f.context).toHaveBeenCalledOnce() // 纯本地补写不依赖账号网络。
  expect(next.records()).toHaveLength(1)
  next.dispose()
})

it('retains a complete generation in memory through checkpoint failure and only retries saving', async () => {
  const f = fixture(), svc = services()
  f.fail(task => task.generation === 'complete')
  const runtime = new AnalysisRuntime(f.host, input => runIndependentPaperAnalysis({ ...input, services: svc }), { store: f.store(), context: f.context, retryDelay: 60_000 })
  await runtime.start(42)
  expect(svc.send).toHaveBeenCalledOnce()
  expect(svc.saveAnnotations).not.toHaveBeenCalled()
  f.fail(() => false)
  await runtime.start(42)
  expect(svc.send).toHaveBeenCalledOnce()
  expect(svc.saveAnnotations).toHaveBeenCalledOnce()
  expect(runtime.records()[0]?.summary).toBe('Retained synthetic summary')
  runtime.dispose()
})

it('does not dispatch a model while initial task identity cannot be saved', async () => {
  const f = fixture(), svc = services()
  f.fail(() => true)
  const runtime = new AnalysisRuntime(f.host, input => runIndependentPaperAnalysis({ ...input, services: svc }), { store: f.store(), context: f.context, retryDelay: 60_000 })
  await runtime.start(42)
  expect(svc.send).not.toHaveBeenCalled()
  expect(runtime.get(42)).toMatchObject({ retrying: true, resumable: true })
  runtime.dispose()
})

it('writes a streaming checkpoint and preserves an explicit user pause across restart', async () => {
  const f = fixture(), svc = services(), cancel = vi.spyOn(ReliableTemporaryChatClient.prototype, 'cancelOperation').mockResolvedValue()
  let began = false
  svc.send.mockImplementation(async input => {
    input.onTextDelta?.(complete, complete); began = true
    return await new Promise((_resolve, reject) => input.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
  })
  const first = new AnalysisRuntime(f.host, input => runIndependentPaperAnalysis({ ...input, services: svc }), { store: f.store(), context: f.context })
  const running = first.start(42)
  await vi.waitFor(() => expect(began).toBe(true))
  await vi.waitFor(() => expect([...f.files.values()].map(text => JSON.parse(text)).some(task => task.response === complete)).toBe(true))
  first.stop(42); await running
  expect(cancel).toHaveBeenCalledOnce()
  first.dispose()
  const next = new AnalysisRuntime(f.host, input => runIndependentPaperAnalysis({ ...input, services: svc }), { store: f.store(), context: f.context })
  await next.restore()
  expect(next.get(42)).toMatchObject({ busy: false, resumable: true })
  expect(svc.send).toHaveBeenCalledOnce()
  expect(next.records()[0]?.summary).toBe('Retained synthetic summary')
  next.dispose()
})

it('continues an acknowledged cancellation only after the user resumes, retaining completed fields', async () => {
  const f = fixture(), svc = services(), cancel = vi.spyOn(ReliableTemporaryChatClient.prototype, 'cancelOperation').mockResolvedValue()
  const inputs: TemporaryChatSendInput[] = []
  svc.send.mockImplementation(async input => {
    inputs.push(input)
    if (inputs.length === 1) {
      input.onTextDelta?.(complete, complete)
      return await new Promise((_resolve, reject) => input.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
    }
    if (inputs.length === 2) throw new RequestExecutionError('Cancelled by user', 'cancelled', complete, { code: 'CANCELLED', stage: 'recovery' })
    return JSON.stringify({ summary: '', sections: [{ category: 'method', summary: 'Continued method' }], annotations: [{ passageId: 'p1', category: 'claim', comment: 'Continued note' }] })
  })
  const runner: typeof runIndependentPaperAnalysis = input => runIndependentPaperAnalysis({ ...input, services: svc })
  const first = new AnalysisRuntime(f.host, runner, { store: f.store(), context: f.context, retryDelay: 60_000 })
  const running = first.start(42)
  await vi.waitFor(() => expect(inputs).toHaveLength(1))
  first.stop(42); await running; await first.dispose()
  expect(cancel).toHaveBeenCalledOnce()
  expect(inputs[0].durableExecution).toBe(true)
  const next = new AnalysisRuntime(f.host, runner, { store: f.store(), context: f.context, retryDelay: 60_000 })
  await next.restore()
  expect(inputs).toHaveLength(1)
  await next.start(42) // 显式继续先确认原执行 cancelled，不能把整个原任务当作新请求。
  expect(inputs[1].clientRequestId).toBe(inputs[0].clientRequestId)
  expect(next.get(42)).toMatchObject({ resumable: true, retrying: true })
  expect(svc.saveAnnotations).not.toHaveBeenCalled()
  await next.start(42)
  expect(inputs).toHaveLength(3)
  expect(inputs[2].clientRequestId).not.toBe(inputs[0].clientRequestId)
  expect(inputs[2].previousRequestId).toBe(inputs[0].clientRequestId)
  expect(inputs[2].operationId).toBe(`${inputs[0].conversationId}:repair:1`)
  expect(inputs[2].messages[0].text).toContain('Second evidence')
  expect(inputs[2].messages[0].text).not.toContain('First evidence')
  expect(next.records()[0].summary).toBe('Retained synthetic summary')
  expect(next.records()[0].notes).toContain('Continued note')
  expect(svc.readPdf).toHaveBeenCalledOnce()
  expect(svc.saveAnnotations).toHaveBeenCalledOnce()
  expect(next.get(42)).toMatchObject({ resumable: false })
  await next.dispose()
})

it('keeps the original operation identity on a pending restart and refuses a different account', async () => {
  const f = fixture(), task = newAnalysisTask(42), svc = services()
  Object.assign(task, { account: 'synthetic-owner', configuration: 'synthetic-model', route: 'jadense', generation: 'pending', snapshot: pdf })
  await f.store().save(task)
  const runtime = new AnalysisRuntime(f.host, input => runIndependentPaperAnalysis({ ...input, services: svc }), { store: f.store(), context: f.context })
  await runtime.start(42)
  expect(svc.send.mock.calls[0][0]).toMatchObject({ clientRequestId: task.requestID, operationId: task.id, conversationId: task.id })
  runtime.dispose()
  const other = newAnalysisTask(42)
  Object.assign(other, { ...task, id: other.id, requestID: other.requestID, createdAt: '2099-01-01T00:00:00.000Z' })
  await f.store().save(other)
  const blocked = new AnalysisRuntime(f.host, input => runIndependentPaperAnalysis({ ...input, services: svc }), { store: f.store(), context: async () => ({ account: 'different-owner', configuration: 'synthetic-model', route: 'jadense' }) })
  await blocked.start(42)
  expect(svc.send).toHaveBeenCalledOnce()
  expect(blocked.get(42)).toMatchObject({ error: true, resumable: true })
  blocked.dispose()
})

it('repairs only missing fields after authoritative partial output and keeps prior results', async () => {
  const f = fixture(), svc = services(), task = newAnalysisTask(42), store = f.store()
  svc.send.mockRejectedValueOnce(new RequestExecutionError('Synthetic partial', 'partial', complete, { code: 'OUTPUT_PARTIAL' }))
    .mockResolvedValueOnce(JSON.stringify({ summary: '', sections: [{ category: 'method', summary: 'New method' }], annotations: [{ passageId: 'p1', category: 'claim', comment: 'New note' }] }))
  const run = () => runIndependentPaperAnalysis({ zotero: f.host, itemID: 42, signal: new AbortController().signal, fetchImpl: vi.fn(), task, checkpoint: value => store.save(value), services: svc })
  const first = await run()
  expect(first.record.summary).toBe('Retained synthetic summary')
  expect(first.continuation).toBe('waiting')
  expect(svc.saveAnnotations).not.toHaveBeenCalled()
  const originalRequest = svc.send.mock.calls[0][0].clientRequestId
  const second = await run()
  expect(second.record.summary).toBe('Retained synthetic summary')
  expect(second.record.notes).toContain('Retained note')
  expect(second.record.notes).toContain('New note')
  const repair = svc.send.mock.calls[1][0]
  expect(repair.previousRequestId).toBe(originalRequest)
  expect(repair.operationId).toBe(`${task.id}:repair:1`)
  expect(repair.messages[0].text).toContain('Second evidence')
  expect(repair.messages[0].text).not.toContain('First evidence')
  expect(svc.saveAnnotations).toHaveBeenCalledOnce()
})

it('limits automatic paid repairs while retaining terminal partial output', async () => {
  const f = fixture(), svc = services(), task = newAnalysisTask(42), store = f.store()
  svc.send.mockRejectedValue(new RequestExecutionError('Synthetic partial', 'partial', complete, { code: 'OUTPUT_PARTIAL' }))
  const run = () => runIndependentPaperAnalysis({ zotero: f.host, itemID: 42, signal: new AbortController().signal, fetchImpl: vi.fn(), task, checkpoint: value => store.save(value), services: svc })
  expect((await run()).continuation).toBe('waiting')
  expect((await run()).continuation).toBe('waiting')
  expect((await run()).continuation).toBe('needs_action')
  expect(task.repair?.attempt).toBe(2)
  expect(svc.saveAnnotations).not.toHaveBeenCalled()
})

it('keeps unknown execution pending and never manufactures a paid repair operation', async () => {
  const f = fixture(), svc = services(), task = newAnalysisTask(42)
  svc.send.mockImplementation(async input => { input.onTextDelta?.(complete, complete); throw new RequestExecutionError('Unknown', 'unknown', complete, { code: 'TEMPORARY_RESULT_UNCONFIRMED' }) })
  const result = await runIndependentPaperAnalysis({ zotero: f.host, itemID: 42, signal: new AbortController().signal, fetchImpl: vi.fn(), task, checkpoint: value => f.store().save(value), services: svc })
  expect(result.continuation).toBe('waiting')
  expect(task.generation).toBe('pending')
  expect(task.repair).toBeUndefined()
  expect(svc.send).toHaveBeenCalledOnce()
  expect(svc.saveAnnotations).not.toHaveBeenCalled()
})

it.each([
  { state: 'cancelled' as const, status: undefined },
  { state: 'failed' as const, status: 402 },
])('requires explicit continuation for authoritative $state / $status before allocating a repair', async ({ state, status }) => {
  const f = fixture(), svc = services(), task = newAnalysisTask(42), store = f.store()
  svc.send.mockRejectedValue(new RequestExecutionError('Synthetic terminal receipt', state, complete, { code: 'EXECUTION_ENDED', ...(status ? { status } : {}) }))
  const run = () => runIndependentPaperAnalysis({ zotero: f.host, itemID: 42, signal: new AbortController().signal, fetchImpl: vi.fn(), task, checkpoint: value => store.save(value), services: svc })
  const originalRequest = task.requestID
  expect((await run()).continuation).toBe('needs_action')
  expect(task.repair).toBeUndefined()
  expect(task.requestID).toBe(originalRequest)
  task.resumeRequested = true
  expect((await run()).continuation).toBe('waiting')
  expect(task.repair?.attempt).toBe(1)
  expect(task.previousRequestID).toBe(originalRequest)
  expect(task.resumeRequested).toBe(false)
  expect(svc.saveAnnotations).not.toHaveBeenCalled()
})

it('repairs a missing summary and does not authorize native writes from malformed repair output', async () => {
  const f = fixture(), svc = services(), task = newAnalysisTask(42), store = f.store()
  svc.send.mockResolvedValueOnce(JSON.stringify({ sections: [{ category: 'claim', summary: 'Retained claim' }], annotations: [] }))
    .mockResolvedValueOnce('Synthetic malformed repair')
    .mockResolvedValueOnce('{"summary":"Recovered missing summary","sections":[],"annotations":[]}')
  const run = () => runIndependentPaperAnalysis({ zotero: f.host, itemID: 42, signal: new AbortController().signal, fetchImpl: vi.fn(), task, checkpoint: value => store.save(value), services: svc })
  expect((await run()).continuation).toBe('waiting')
  expect((await run()).continuation).toBe('waiting')
  const final = await run()
  expect(final.continuation).toBeUndefined()
  expect(final.record.summary).toBe('Recovered missing summary')
  expect(final.record.notes).toContain('Retained claim')
  expect(svc.saveAnnotations).not.toHaveBeenCalled()
})

it('reuses a linked throttling completion after two cold checkpoint failures without a third model request', async () => {
  const f = fixture(), svc = services(), initial = newAnalysisTask(42), requestFiles = new Map<string, string>()
  const paths = { profileDir: '/linked-receipts', join: (...parts: string[]) => parts.join('/'), filename: (path: string) => path.split('/').at(-1)! }
  const requestStore = () => new TemporaryRequestStore({
    makeDirectory: async () => {}, writeUTF8: async (path, text) => { requestFiles.set(path, text) }, readUTF8: async path => requestFiles.get(path)!,
    getChildren: async path => [...new Set([...requestFiles.keys()].filter(file => file.startsWith(path + '/')).map(file => path + '/' + file.slice(path.length + 1).split('/')[0]))],
  }, paths)
  const headers = { 'x-jadense-temporary-protocol': '1', 'x-jadense-temporary-account': 'synthetic-linked-owner',
    'x-jadense-temporary-durable': '1', 'x-jadense-response-format': '1' }
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method === 'HEAD') return new Response(null, { headers })
    if (options?.method === 'POST') {
      bodies.push(JSON.parse(String(options.body)))
      if (bodies.length === 1) return Response.json({ error: 'Synthetic limit', code: 'RATE_LIMIT' }, { status: 429, headers })
    }
    return Response.json({ state: 'completed', complete: true, text: complete }, { headers })
  })
  svc.send.mockImplementation(input => new ReliableTemporaryChatClient({ baseUrl: 'https://linked-analysis.test', token: 'synthetic',
    selection: { kind: 'model', modelId: 'fixture' }, fetchImpl }, requestStore()).send(input))
  const run = (task: AnalysisTask) => {
    const store = f.store()
    return runIndependentPaperAnalysis({ zotero: f.host, itemID: 42, signal: new AbortController().signal, fetchImpl, task, checkpoint: value => store.save(value), services: svc })
  }
  // A 被明确限流；文档更新请求身份前磁盘失败，冷启动只能看见原身份 A。
  const originalID = initial.requestID
  f.fail(task => task.requestID !== originalID)
  await expect(run(initial)).rejects.toMatchObject({ code: 'ANALYSIS_STORAGE' })
  const afterLimit = (await f.store().list())[0]
  expect(afterLimit.requestID).toBe(originalID)
  // 可靠客户端将 A 关联到 B；B 已完成且回执落盘，但文档完成检查点再次失败。
  f.fail(task => task.generation === 'complete')
  await expect(run(afterLimit)).rejects.toMatchObject({ code: 'ANALYSIS_STORAGE' })
  const afterCompletion = (await f.store().list())[0]
  expect(afterCompletion).toMatchObject({ requestID: originalID, generation: 'pending' })
  expect(bodies).toHaveLength(2)
  expect(bodies[1].previousRequestId).toBe(originalID)
  expect(bodies[1].clientRequestId).not.toBe(originalID)
  f.fail(() => false)
  const result = await run(afterCompletion)
  expect(result.record.summary).toBe('Retained synthetic summary')
  expect(bodies).toHaveLength(2)
  expect(svc.readPdf).toHaveBeenCalledOnce()
  expect(svc.saveAnnotations).toHaveBeenCalledOnce()
})
