/** 任务身份与真实状态流回归；仅替换宿主 I/O 和排版进程。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { PDFTranslationJobs } from './pdf-translation-jobs'
import { preparePDFEngine, runPDFWorker } from './pdf-translation-runtime'
import type { ZoteroLike } from './runtime'
import { translateMachineText } from '@/chat/machine-translation'
import { requestHash } from '@/chat/temporary-request-store'
import { PDF_ENGINE, PDF_ADAPTER, pdfTaskDirectory } from './pdf-translation-runtime'
import { readPDFTranslationMode, savePDFTranslationMode } from './pdf-translation-policy'
import { ReliableTemporaryChatClient, TemporaryPartialOutputError } from '@/chat/reliable-temporary-chat'
import { resolveTemporaryAccount } from '@/chat/temporary-account'

it('persists the default mode in the Zotero global preference branch', () => {
  const prefs = new Map<string, unknown>()
  const host = { Prefs: {
    get: (key: string, global?: boolean) => prefs.get(global ? key : `extensions.zotero.${key}`),
    set: (key: string, value: unknown, global?: boolean) => { prefs.set(global ? key : `extensions.zotero.${key}`, value) },
  } } as ZoteroLike
  savePDFTranslationMode(host, 'full')
  expect(prefs.get('extensions.jadenseInZotero.pdfTranslationMode')).toBe('full')
  expect(readPDFTranslationMode(host)).toBe('full')
})

vi.mock('@/chat/machine-translation', () => ({ translateMachineText: vi.fn(async () => 'translated') }))
vi.mock('@/chat/temporary-account', () => ({ resolveTemporaryAccount: vi.fn(async () => ({ account: 'synthetic-owner-source', verified: true })) }))
vi.mock('./ai-settings', () => ({ featureModelState: () => ({ ready: true, selection: {}, route: 'jadense' }) }))
vi.mock('./pdf-translation-runtime', async original => ({ ...await original<typeof import('./pdf-translation-runtime')>(), preparePDFEngine: vi.fn(async () => {}), runPDFWorker: vi.fn() }))
const files = new Map<string, string>()
let bytes = new Uint8Array([37, 80, 68, 70, 1])
let service = 'google'
let kind = 'machine'
const preferences = new Map<string, unknown>()
const credentialObservers = new Map<string, () => void>()
const host = {
  Items: { get: (id: number) => ({ id, libraryID: 1, key: `PDF${id}`, isPDFAttachment: () => true, getField: () => 'Paper', getFilePathAsync: async () => '/source.pdf' }) },
  Prefs: {
    get: (key: string) => key.endsWith('fullTranslationInterface') ? JSON.stringify({ kind, service }) : preferences.get(key),
    registerObserver: (key: string, callback: () => void) => { credentialObservers.set(key, callback); return key },
    unregisterObserver: (key: string) => credentialObservers.delete(key),
  },
  getMainWindow: () => ({ fetch: vi.fn() }),
} as unknown as ZoteroLike

beforeEach(() => {
  files.clear(); preferences.clear(); credentialObservers.clear(); kind = 'machine'; bytes = new Uint8Array([37, 80, 68, 70, 1]); service = 'google'; vi.clearAllMocks()
  vi.mocked(translateMachineText).mockReset().mockResolvedValue('translated')
  vi.mocked(resolveTemporaryAccount).mockResolvedValue({ account: 'synthetic-owner-source', verified: true })
  vi.stubGlobal('PathUtils', { profileDir: '/profile', join: path.posix.join, filename: path.posix.basename })
  vi.stubGlobal('IOUtils', { read: async () => bytes, readUTF8: async (file: string) => { if (!files.has(file)) throw new Error('missing'); return files.get(file)! },
    getChildren: async () => [...new Set([...files.keys()].map(file => path.posix.dirname(file)))], makeDirectory: async () => {}, writeUTF8: async (file: string, value: string) => { files.set(file, value) }, exists: async () => true })
  vi.mocked(runPDFWorker).mockImplementation(async (_host, config, _signal, message) => {
    files.set(path.posix.join(String(config.directory), 'artifact.json'), JSON.stringify({ fingerprint: config.fingerprint, configuration: config.configuration, revision: 'a'.repeat(32), pages: 2, skipped: [1], coverage: { total: 2, translated: 2, failed: 0, preserved: 1, failedPages: [] } }))
    await message({ type: 'complete', pages: 2, skipped: [1], extra: true })
  })
})
afterEach(() => vi.useRealTimers())

it.each([401, 403])('automatically resumes credential-blocked HTTP %i only after a verified same-account token change', async status => {
  kind = 'ai'
  vi.mocked(resolveTemporaryAccount)
    .mockResolvedValueOnce({ account: 'synthetic-owner-source', verified: true })
    .mockRejectedValueOnce(Object.assign(new Error('expired token'), { status }))
  const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
  await vi.waitFor(() => expect(task.status).toBe('error'))
  expect(task.blockedReason).toBe('credentials')
  expect(runPDFWorker).not.toHaveBeenCalled()
  const changed = credentialObservers.get('extensions.jadenseInZotero.token')!
  vi.mocked(resolveTemporaryAccount).mockResolvedValue({ account: 'other-account', verified: true })
  changed()
  await vi.waitFor(() => expect(resolveTemporaryAccount).toHaveBeenCalledTimes(3))
  expect(runPDFWorker).not.toHaveBeenCalled()
  expect(task.status).toBe('error')
  vi.mocked(resolveTemporaryAccount).mockResolvedValue({ account: 'synthetic-owner-source', verified: false })
  changed()
  await vi.waitFor(() => expect(resolveTemporaryAccount).toHaveBeenCalledTimes(4))
  expect(runPDFWorker).not.toHaveBeenCalled()
  vi.mocked(resolveTemporaryAccount).mockResolvedValue({ account: 'synthetic-owner-source', verified: true })
  preferences.set('extensions.jadenseInZotero.token', 'synthetic-rotated')
  changed()
  await vi.waitFor(() => expect(task.status).toBe('complete'))
  expect(vi.mocked(runPDFWorker).mock.calls[0][1].directory).toBe(pdfTaskDirectory(task.id))
  await jobs.stop()
  expect(credentialObservers.size).toBe(0)
})

it('does not wake a user-paused task when credentials change', async () => {
  kind = 'ai'
  const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
  await vi.waitFor(() => expect(task.status).toBe('complete'))
  task.status = 'error'; task.blockedReason = 'credentials'; task.desiredState = 'paused'
  vi.mocked(resolveTemporaryAccount).mockClear(); vi.mocked(runPDFWorker).mockClear()
  credentialObservers.get('extensions.jadenseInZotero.token')!()
  await Promise.resolve(); await Promise.resolve()
  expect(resolveTemporaryAccount).not.toHaveBeenCalled()
  expect(runPDFWorker).not.toHaveBeenCalled()
  await jobs.stop()
})

it('waits for explicit remote cancellation before continuing with the original task and operation', async () => {
  kind = 'ai'
  let finishCancel!: () => void
  let cancelled = false
  const cancel = vi.spyOn(ReliableTemporaryChatClient.prototype, 'cancelOperation').mockImplementation(() => new Promise(resolve => {
    finishCancel = () => { cancelled = true; resolve() }
  }))
  const send = vi.spyOn(ReliableTemporaryChatClient.prototype, 'send').mockImplementation(async input => {
    expect(cancelled).toBe(true)
    expect(input).toMatchObject({ operationId: 'original-operation', durableExecution: true })
    return 'translated'
  })
  try {
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    const finish = vi.mocked(runPDFWorker).getMockImplementation()!
    vi.mocked(runPDFWorker).mockClear().mockImplementation(async (...args) => {
      await args[3]({ type: 'translate', id: 'original-operation', text: 'input' })
      await finish(...args)
    })
    jobs.cancel(task.id)
    jobs.retry(task.id)
    await Promise.resolve(); await Promise.resolve()
    expect(runPDFWorker).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
    finishCancel()
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    expect(cancel).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledWith(`pdf-${task.id}`)
    expect(send).toHaveBeenCalledTimes(1)
    await jobs.stop()
  } finally { cancel.mockRestore(); send.mockRestore() }
})

it('waits for an outstanding user cancellation on shutdown without issuing another DELETE', async () => {
  kind = 'ai'
  let finishCancel!: () => void
  const cancel = vi.spyOn(ReliableTemporaryChatClient.prototype, 'cancelOperation').mockImplementation(() => new Promise(resolve => { finishCancel = resolve }))
  try {
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    jobs.cancel(task.id)
    let stopped = false
    const stop = jobs.stop().then(() => { stopped = true })
    await Promise.resolve(); await Promise.resolve()
    expect(stopped).toBe(false)
    finishCancel()
    await stop
    expect(stopped).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledWith(`pdf-${task.id}`)
  } finally { cancel.mockRestore() }
})

it('resumes under a rotated credential for the verified same account and retains the task cache directory', async () => {
  kind = 'ai'
  preferences.set('extensions.jadenseInZotero.token', 'synthetic-before')
  const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
  await vi.waitFor(() => expect(task.status).toBe('complete'))
  const directory = vi.mocked(runPDFWorker).mock.calls[0][1].directory
  task.status = 'partial'
  preferences.set('extensions.jadenseInZotero.token', 'synthetic-after')
  jobs.retry(task.id)
  await vi.waitFor(() => expect(task.status).toBe('complete'))
  expect(vi.mocked(runPDFWorker).mock.calls[1][1].directory).toBe(directory)
  expect((await new PDFTranslationJobs(host).start(1)).id).toBe(task.id)
  vi.mocked(resolveTemporaryAccount).mockResolvedValue({ account: 'another-owner-source', verified: true })
  vi.mocked(runPDFWorker).mockClear()
  jobs.retry(task.id)
  await vi.waitFor(() => expect(task.status).toBe('error'))
  expect(task.error).toMatch(/账户|account/)
  expect(runPDFWorker).not.toHaveBeenCalled()
})

it('persists a batch timeout and automatically completes remaining batches after a cold restart', async () => {
  vi.useFakeTimers()
  const translated = new Set<string>(), requested: string[] = []
  vi.mocked(translateMachineText).mockImplementation(async input => {
    requested.push(input.text)
    if (input.text === 'second' && requested.filter(text => text === 'second').length === 1) throw Object.assign(new Error('deadline'), { code: 'TRANSLATION_TIMEOUT' })
    return 'translated'
  })
  vi.mocked(runPDFWorker).mockImplementation(async (_host, config, _signal, message) => {
    for (const text of ['first', 'second', 'third']) {
      if (translated.has(text)) continue
      const reply = await message({ type: 'translate', id: text, text }) as { text?: string }
      if (reply.text) translated.add(text)
    }
    files.set(path.posix.join(String(config.directory), 'artifact.json'), JSON.stringify({ fingerprint: config.fingerprint, configuration: config.configuration, revision: 'a'.repeat(32), pages: 2, skipped: [], coverage: { total: 3, translated: translated.size, failed: 3 - translated.size, preserved: 0, failedPages: [] } }))
    await message({ type: 'complete' })
  })
  const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
  await vi.waitFor(() => expect(task.status).toBe('waiting'))
  expect(requested).toEqual(['first', 'second', 'third'])
  expect(JSON.parse(files.get(path.posix.join(pdfTaskDirectory(task.id), 'task.json'))!)).toMatchObject({ status: 'waiting', desiredState: 'running', recovery: { reason: 'TRANSLATION_TIMEOUT' } })
  jobs.stop()
  const restarted = new PDFTranslationJobs(host)
  await restarted.initialize()
  expect(requested).toEqual(['first', 'second', 'third'])
  await vi.advanceTimersByTimeAsync(15_000)
  await vi.waitFor(() => expect(restarted.get(task.id)?.status).toBe('complete'))
  expect(requested).toEqual(['first', 'second', 'third', 'second'])
  expect(restarted.get(task.id)?.recovery).toBeUndefined()
  restarted.stop()
})

it('keeps user cancellation paused across restart while host exit preserves running intent', async () => {
  vi.useFakeTimers()
  vi.mocked(runPDFWorker).mockImplementation(async (_host, _config, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('exit', 'AbortError')), { once: true })
  }))
  const jobs = new PDFTranslationJobs(host), active = await jobs.start(1), paused = await jobs.start(2)
  await vi.waitFor(() => expect(runPDFWorker).toHaveBeenCalledTimes(1))
  jobs.cancel(paused.id); jobs.stop()
  await vi.waitFor(() => expect(jobs.isActive(paused.id)).toBe(false))
  expect(active.desiredState).toBe('running'); expect(paused.desiredState).toBe('paused')
  expect(JSON.parse(files.get(path.posix.join(pdfTaskDirectory(paused.id), 'task.json'))!).desiredState).toBe('paused')
  vi.mocked(runPDFWorker).mockClear()
  const restarted = new PDFTranslationJobs(host)
  await restarted.initialize()
  await vi.advanceTimersByTimeAsync(1)
  await vi.waitFor(() => expect(runPDFWorker).toHaveBeenCalledTimes(1))
  expect(vi.mocked(runPDFWorker).mock.calls[0][1].directory).toBe(pdfTaskDirectory(active.id))
  expect(restarted.get(paused.id)?.desiredState).toBe('paused')
  restarted.stop()
  await vi.waitFor(() => expect(restarted.isActive(active.id)).toBe(false))
})

it('retries PDF rendering locally after failure without allowing another translation request', async () => {
  vi.useFakeTimers()
  vi.mocked(translateMachineText).mockResolvedValue('translated')
  const finish = vi.mocked(runPDFWorker).getMockImplementation()!
  vi.mocked(runPDFWorker).mockImplementationOnce(async (_host, _config, _signal, message) => {
    expect(await message({ type: 'translate', id: 'paid-once', text: 'source' })).toMatchObject({ text: 'translated' })
    await message({ type: 'translation_summary', pending: 0, total: 1, completed: 1 })
    throw Object.assign(new Error('synthetic render failure'), { code: 'PDF_RENDER_FAILED' })
  }).mockImplementationOnce(async (...args) => {
    expect(args[1].renderOnly).toBe(true)
    expect(await args[3]({ type: 'translate', id: 'must-not-send', text: 'source' })).toMatchObject({ error: { code: 'PDF_RENDER_ONLY', stop: true } })
    await finish(...args)
  })
  const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
  await vi.waitFor(() => expect(task.status).toBe('waiting'))
  kind = 'ai'
  vi.mocked(resolveTemporaryAccount).mockClear().mockRejectedValue(new TypeError('offline'))
  await vi.advanceTimersByTimeAsync(15_000)
  await vi.waitFor(() => expect(task.status).toBe('complete'))
  expect(translateMachineText).toHaveBeenCalledTimes(1)
  expect(resolveTemporaryAccount).not.toHaveBeenCalled()
  jobs.stop()
})

it('automatically retries an atomic task-save failure before any worker or paid request is dispatched', async () => {
  vi.useFakeTimers()
  const io = globalThis.IOUtils as unknown as { writeUTF8: (path: string, value: string) => Promise<void> }
  const original = io.writeUTF8
  let fail = true
  io.writeUTF8 = async (file, value) => {
    if (fail && JSON.parse(value).status === 'running') { fail = false; throw new Error('synthetic disk unavailable') }
    await original(file, value)
  }
  const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
  await vi.waitFor(() => expect(task.status).toBe('waiting'))
  expect(runPDFWorker).not.toHaveBeenCalled(); expect(translateMachineText).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(15_000)
  await vi.waitFor(() => expect(task.status).toBe('complete'))
  expect(runPDFWorker).toHaveBeenCalledTimes(1)
  jobs.stop()
})

it('retries only the local completion commit if task metadata cannot be saved after a paid response', async () => {
  vi.useFakeTimers()
  const io = globalThis.IOUtils as unknown as { writeUTF8: (path: string, value: string) => Promise<void> }
  const original = io.writeUTF8
  let fail = true
  io.writeUTF8 = async (file, value) => {
    if (fail && JSON.parse(value).status === 'complete') { fail = false; throw new Error('synthetic final write failure') }
    await original(file, value)
  }
  const finish = vi.mocked(runPDFWorker).getMockImplementation()!
  vi.mocked(runPDFWorker).mockImplementation(async (...args) => {
    await args[3]({ type: 'translate', id: 'paid-once', text: 'source' })
    await finish(...args)
  })
  const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
  await vi.waitFor(() => expect(task.status).toBe('waiting'))
  expect(task.completion).toBe('complete')
  await vi.advanceTimersByTimeAsync(15_000)
  await vi.waitFor(() => expect(task.status).toBe('complete'))
  expect(runPDFWorker).toHaveBeenCalledTimes(1)
  expect(translateMachineText).toHaveBeenCalledTimes(1)
  jobs.stop()
})

describe('PDF jobs', () => {
  it('keeps task identity and historical bytes in a configured engine folder', async () => {
    const root = '/external/jadense-pdf-translation', marker = 'test-marker'
    preferences.set('extensions.jadenseInZotero.pdfEngineStorage', JSON.stringify({ version: 1, parent: '/external', marker }))
    files.set(path.posix.join(root, '.jadense-storage-id'), marker)
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    expect(files.has(path.posix.join(root, 'tasks', task.id, 'task.json'))).toBe(true)
    expect(files.has(path.posix.join('/profile/jadense-pdf-translation', 'tasks', task.id, 'task.json'))).toBe(false)
    const restored = new PDFTranslationJobs(host)
    await restored.loadHistory()
    expect(restored.get(task.id)?.id).toBe(task.id)
    await expect(restored.bytes(task.id)).resolves.toEqual(bytes)
  })
  it('freezes the formula policy per task and keeps legacy retry inputs unchanged', async () => {
    const first = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(first.status).toBe('complete'))
    expect(first.formulaPolicy).toBe('math-fonts-v1')
    expect(vi.mocked(runPDFWorker).mock.calls[0][1].formulaPolicy).toBe('math-fonts-v1')
    const manifest = path.posix.join(pdfTaskDirectory(first.id), 'task.json')
    const saved = JSON.parse(files.get(manifest)!)
    delete saved.formulaPolicy
    saved.status = 'partial'
    files.set(manifest, JSON.stringify(saved))
    const jobs = new PDFTranslationJobs(host)
    await jobs.loadHistory()
    expect(jobs.get(first.id)?.formulaPolicy).toBeUndefined()
    vi.mocked(runPDFWorker).mockClear()
    jobs.retry(first.id)
    await vi.waitFor(() => expect(vi.mocked(runPDFWorker)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(runPDFWorker).mock.calls[0][1].formulaPolicy).toBeUndefined()
    await vi.waitFor(() => expect(jobs.get(first.id)?.status).toBe('complete'))
  })
  it('persists recovery categories without confusing repeated attempts with final coverage', async () => {
    const finish = vi.mocked(runPDFWorker).getMockImplementation()!
    vi.mocked(runPDFWorker).mockImplementationOnce(async (...args) => {
      await args[3]({ type: 'passage_failure', category: 'OUTPUT_FAILED', missing: 34, extra: true })
      await args[3]({ type: 'passage_failure', category: 'placeholder_mismatch', missing: 6 })
      await args[3]({ type: 'passage_failure', category: 'placeholder_mismatch', missing: 2 })
      await args[3]({ type: 'passage_failure', category: 'invalid_output', missing: 'broken' })
      await finish(...args)
    })
    const task = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    expect(task.failureCounts).toEqual({ OUTPUT_FAILED: 34, PLACEHOLDER_MISMATCH: 8 })
    expect(task.coverage?.failed).toBe(0)
    const restored = await new PDFTranslationJobs(host).start(1)
    expect(restored.failureCounts).toEqual(task.failureCounts)
  })
  it('opens saved output after configuration changes without consulting the provider or starting work', async () => {
    const first = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(first.status).toBe('complete'))
    service = 'bing'; vi.clearAllMocks()
    const restored = new PDFTranslationJobs(host)
    expect((await restored.openOrStart(1)).id).toBe(first.id)
    expect(runPDFWorker).not.toHaveBeenCalled()
    expect(preparePDFEngine).not.toHaveBeenCalled()
    const fresh = await restored.start(1, 'concise', true)
    expect(fresh.id).not.toBe(first.id)
    await vi.waitFor(() => expect(fresh.status).toBe('complete'))
    expect(restored.get(first.id)?.status).toBe('complete')
  })
  it('preserves both versions when explicitly retranslating with identical settings', async () => {
    const jobs = new PDFTranslationJobs(host), first = await jobs.start(1)
    await vi.waitFor(() => expect(first.status).toBe('complete'))
    const second = await jobs.start(1, first.mode, true)
    await vi.waitFor(() => expect(second.status).toBe('complete'))
    expect(second.id).not.toBe(first.id)
    expect((await new PDFTranslationJobs(host).openOrStart(1)).id).toBe(second.id)
    expect(files.has(path.posix.join(pdfTaskDirectory(first.id), 'task.json'))).toBe(true)
  })
  it('does not reuse another attachment or an altered source PDF', async () => {
    const jobs = new PDFTranslationJobs(host), first = await jobs.start(1)
    await vi.waitFor(() => expect(first.status).toBe('complete'))
    const other = await jobs.openOrStart(2)
    expect(other.id).not.toBe(first.id)
    await vi.waitFor(() => expect(other.status).toBe('complete'))
    bytes = new Uint8Array([37, 80, 68, 70, 2])
    const changed = await jobs.openOrStart(1)
    expect(changed.id).not.toBe(first.id)
    await vi.waitFor(() => expect(changed.status).toBe('complete'))
  })
  it('publishes a readable intermediate artifact before completion and keeps it after engine failure', async () => {
    let release!: () => void
    vi.mocked(runPDFWorker).mockImplementation(async (_host, config, _signal, message) => {
      files.set(path.posix.join(String(config.directory), 'artifact.json'), JSON.stringify({ fingerprint: config.fingerprint, configuration: config.configuration, revision: 'b'.repeat(32), pages: 2, skipped: [], coverage: { total: 2, translated: 1, failed: 1, preserved: 0, failedPages: [1] } }))
      await message({ type: 'artifact' })
      await new Promise<void>(resolve => { release = resolve })
      throw new Error('engine interrupted')
    })
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(task.status).toBe('running')
    expect(jobs.hasOutput(task)).toBe(true)
    await expect(jobs.bytes(task.id)).resolves.toEqual(bytes)
    release()
    await vi.waitFor(() => expect(task.status).toBe('error'))
    expect(task.artifact?.coverage?.translated).toBe(1)
  })

  it('keeps v3 artifacts readable but prevents retry with a different batch identity', async () => {
    kind = 'ai'
    const task = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    expect(task.strategy).toBe(PDF_ADAPTER)
    const oldID = 'd'.repeat(64), oldDirectory = pdfTaskDirectory(oldID)
    files.set(path.posix.join(oldDirectory, 'task.json'), JSON.stringify({ ...task, id: oldID, strategy: 'readable-v3', status: 'partial' }))
    files.set(path.posix.join(oldDirectory, 'artifact.json'), files.get(path.posix.join(pdfTaskDirectory(task.id), 'artifact.json'))!)
    const jobs = new PDFTranslationJobs(host)
    await jobs.loadHistory()
    await expect(jobs.bytes(oldID)).resolves.toEqual(bytes)
    vi.clearAllMocks()
    jobs.retry(oldID)
    await vi.waitFor(() => expect(jobs.get(oldID)?.status).toBe('error'))
    expect(jobs.get(oldID)?.error).toMatch(/策略已更新|strategy changed/)
    expect(runPDFWorker).not.toHaveBeenCalled()
    expect(preparePDFEngine).not.toHaveBeenCalled()
    await expect(jobs.bytes(oldID)).resolves.toEqual(bytes)
  })

  it('persists numeric batch summaries and tolerates absent or malformed optional metrics', async () => {
    const finish = vi.mocked(runPDFWorker).getMockImplementation()!
    vi.mocked(runPDFWorker).mockImplementation(async (...args) => {
      const message = args[3]
      await message({ type: 'translation_summary', batchRows: null, batchEndReasons: 'unknown' })
      await message({ type: 'translation_summary', batchRows: [12, 2, 'private', -1], batchTokens: [1500, 200], batchEndReasons: { source: 1, end: 1, output: 'private', future: 'private' } })
      return finish(...args)
    })
    const task = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    expect(task.summary).toMatchObject({ batchRows: [12, 2], batchEndReasons: { source: 1, output: 0, context: 0, end: 1 } })
    expect(JSON.stringify(task.summary)).not.toContain('private')
  })
  it('loads all historical versions without current configuration or generation and contains corrupt records', async () => {
    const task = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    const otherID = 'b'.repeat(64), brokenID = 'c'.repeat(64)
    files.set(path.posix.join(pdfTaskDirectory(otherID), 'task.json'), JSON.stringify({ ...task, id: otherID, createdAt: undefined, status: 'running', future: true }))
    files.set(path.posix.join(pdfTaskDirectory(brokenID), 'task.json'), '{broken')
    service = 'bing'; vi.clearAllMocks()
    const restored = new PDFTranslationJobs(host)
    await restored.loadHistory()
    expect(restored.list()).toHaveLength(2)
    expect(restored.get(task.id)).toMatchObject({ status: 'complete', createdAt: task.createdAt })
    expect(restored.get(otherID)).toMatchObject({ status: 'interrupted', future: true })
    expect(restored.get(otherID)?.createdAt).toBeUndefined()
    await expect(restored.bytes(task.id)).resolves.toEqual(bytes)
    expect(preparePDFEngine).not.toHaveBeenCalled(); expect(runPDFWorker).not.toHaveBeenCalled()
    Object.assign(globalThis.IOUtils, { exists: async (file: string) => !file.endsWith('dual.pdf') })
    const missing = new PDFTranslationJobs(host); await missing.loadHistory()
    expect(missing.get(task.id)?.status).toBe('interrupted')
    await expect(missing.bytes(task.id)).rejects.toThrow('not complete')
  })

  it('keeps AI artifacts across folder sync and speed changes, but versions batch capacity', async () => {
    kind = 'ai'
    preferences.set('extensions.jadenseInZotero.baseUrl', 'http://127.0.0.1:1234')
    const first = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(first.status).toBe('complete'))
    preferences.set('extensions.jadenseInZotero.defaultFolderId', 'another-folder')
    preferences.set('extensions.jadenseInZotero.translationSpeed', JSON.stringify({ 'http://127.0.0.1:1234': { concurrency: 1, rpm: 5, batchTokens: 1600 } }))
    service = 'bing'
    const reused = await new PDFTranslationJobs(host).start(1)
    expect(reused.id).toBe(first.id); expect(reused.status).toBe('complete')
    preferences.set('extensions.jadenseInZotero.translationSpeed', JSON.stringify({ 'http://127.0.0.1:1234': { batchTokens: 800 } }))
    expect((await new PDFTranslationJobs(host).start(1)).id).toBe(first.id)
    expect(first.budget).toMatchObject({ contextWindow: 131072, batchTokens: 32512, policy: 'context-v1' })
    preferences.set('extensions.jadenseInZotero.readingTranslationBudgets', JSON.stringify({ pdf: 65536, simple: 262144 }))
    const changed = await new PDFTranslationJobs(host).start(1)
    expect(changed.id).not.toBe(first.id)
    await vi.waitFor(() => expect(changed.status).toBe('complete'))
  })
  it('reads old completed artifacts and offers an explicit restart for old unfinished work', async () => {
    const task = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    const oldID = await requestHash(JSON.stringify([1, 'PDF1', task.fingerprint, task.configuration, task.languages, PDF_ENGINE]))
    files.clear()
    const file = path.posix.join(pdfTaskDirectory(oldID), 'task.json')
    files.set(file, JSON.stringify({ ...task, id: oldID, strategy: undefined, artifact: undefined }))
    vi.clearAllMocks()
    const history = new PDFTranslationJobs(host)
    await history.loadHistory()
    expect(history.get(oldID)?.status).toBe('complete')
    await expect(history.bytes(oldID)).resolves.toEqual(bytes)
    expect(runPDFWorker).not.toHaveBeenCalled()
    const next = await history.start(1)
    expect(next.id).not.toBe(oldID)
    await vi.waitFor(() => expect(next.status).toBe('complete'))
  })
  it('deduplicates simultaneous requests and reuses both mode results', async () => {
    const jobs = new PDFTranslationJobs(host)
    const [a, b] = await Promise.all([jobs.start(1), jobs.start(1)])
    expect(a).toBe(b)
    await vi.waitFor(() => expect(a.status).toBe('complete'))
    expect(await jobs.start(1)).toBe(a)
    expect(runPDFWorker).toHaveBeenCalledTimes(1)
    expect(a.skipped).toEqual([1])
    expect(a.strategy).toBe('readable-v3') // 传统翻译仍复用原任务身份。
  })
  it('restores completed results without preparing or dispatching', async () => {
    const task = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    vi.clearAllMocks()
    const restored = await new PDFTranslationJobs(host).start(1)
    expect(restored.status).toBe('complete')
    expect(preparePDFEngine).not.toHaveBeenCalled()
    expect(runPDFWorker).not.toHaveBeenCalled()
  })
  it('creates a new identity for changed files or configuration', async () => {
    const jobs = new PDFTranslationJobs(host), a = await jobs.start(1)
    await vi.waitFor(() => expect(a.status).toBe('complete'))
    bytes = new Uint8Array([37, 80, 68, 70, 2])
    const b = await jobs.start(1)
    expect(b.id).not.toBe(a.id)
    await expect(jobs.bytes(a.id)).rejects.toThrow('changed')
    await vi.waitFor(() => expect(b.status).toBe('complete'))
    service = 'bing'
    expect((await jobs.start(1)).id).not.toBe(b.id)
  })
  it('keeps mismatched source results out of the complete state', async () => {
    vi.mocked(runPDFWorker).mockImplementation(async () => { bytes = new Uint8Array([8]) })
    const task = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(task.status).toBe('error'))
    expect(task.blockedReason).toBe('source')
    expect(task.error).toMatch(/文件已变化|source PDF has changed/u)
  })
  it('persists failure and requires explicit retry', async () => {
    vi.mocked(runPDFWorker).mockRejectedValueOnce(new Error('process exited'))
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(task.status).toBe('error'))
    await jobs.start(1)
    expect(runPDFWorker).toHaveBeenCalledTimes(1)
    jobs.retry(task.id)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    expect(runPDFWorker).toHaveBeenCalledTimes(2)
  })
  it('restores unfinished manifests as interrupted and preserves additive fields', async () => {
    const task = await new PDFTranslationJobs(host).start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    for (const [key, value] of files) files.set(key, JSON.stringify({ ...JSON.parse(value), status: 'running', future: true }))
    vi.clearAllMocks()
    const restored = await new PDFTranslationJobs(host).start(1)
    expect(restored.status).toBe('interrupted')
    expect(runPDFWorker).not.toHaveBeenCalled()
  })
  it('exports the selected artifact and refuses to overwrite the source PDF', async () => {
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    let destination = '/export.pdf'
    let result = 0
    const copy = vi.fn(async () => {})
    Object.assign(globalThis.IOUtils ?? {}, { copy })
    const init = vi.fn()
    class FilePicker {
      modeSave = 1; returnCancel = 1; init = init; appendFilter() {} async show() { return result }
      get file() { return destination }
    }
    vi.stubGlobal('ChromeUtils', { importESModule: () => ({ FilePicker }) })
    await jobs.export(task.id, 'dual', {} as Window)
    expect(copy).toHaveBeenCalledWith(expect.stringMatching(/dual\.pdf$/u), '/export.pdf')
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ fetch: expect.any(Function) }), expect.any(String), 1)
    destination = '/source.pdf'
    await expect(jobs.export(task.id, 'mono', {} as Window)).rejects.toThrow(/original PDF|原 PDF/u)
    expect(copy).toHaveBeenCalledTimes(1)
    destination = '/mono-export.pdf'
    await jobs.export(task.id, 'mono', {} as Window)
    expect(copy).toHaveBeenLastCalledWith(expect.stringMatching(/mono\.pdf$/u), destination)
    result = 1
    await jobs.export(task.id, 'mono', {} as Window)
    expect(copy).toHaveBeenCalledTimes(2)
  })
  it('stops requests on cancel and keeps retry disabled until the last artifact is saved', async () => {
    const finish = vi.mocked(runPDFWorker).getMockImplementation()!
    let release!: () => void
    vi.mocked(runPDFWorker).mockImplementation(async (...args) => {
      await new Promise<void>(resolve => {
        args[4]!.addEventListener('abort', () => { release = resolve }, { once: true })
      })
      expect(args[2].aborted).toBe(false)
      await finish(...args)
    })
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(runPDFWorker).toHaveBeenCalledTimes(1))
    jobs.cancel(task.id)
    expect(task.stage).toBe('finishing')
    expect(jobs.isActive(task.id)).toBe(true)
    jobs.retry(task.id)
    expect(runPDFWorker).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(jobs.isActive(task.id)).toBe(false))
    expect(task.status).toBe('cancelled')
    expect(jobs.hasOutput(task)).toBe(true)
  })
  it('persists queued work before dispatch and restores it without automatic requests', async () => {
    vi.mocked(runPDFWorker).mockImplementation(async (_host, _config, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    }))
    const jobs = new PDFTranslationJobs(host)
    await jobs.start(1)
    await vi.waitFor(() => expect(runPDFWorker).toHaveBeenCalledTimes(1))
    const queued = await jobs.start(2)
    expect(queued.status).toBe('queued')
    expect((await new PDFTranslationJobs(host).start(2)).status).toBe('interrupted')
    expect(runPDFWorker).toHaveBeenCalledTimes(1)
    jobs.stop()
    await vi.waitFor(() => expect(jobs.isActive(queued.id)).toBe(false))
  })
})

it('keeps partial artifacts readable during retry and after retry failure, including cold restart', async () => {
  const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
  await vi.waitFor(() => expect(task.status).toBe('complete'))
  const file = path.posix.join(pdfTaskDirectory(task.id), 'artifact.json')
  const manifest = JSON.parse(files.get(file)!)
  manifest.coverage = { total: 3, translated: 1, failed: 2, preserved: 5, failedPages: [0, 1] }
  files.set(file, JSON.stringify(manifest))
  const restored = new PDFTranslationJobs(host); await restored.loadHistory()
  const partial = restored.get(task.id)!
  expect(partial.status).toBe('partial'); expect(restored.hasOutput(partial)).toBe(true)
  vi.mocked(runPDFWorker).mockRejectedValue(new Error('disk full'))
  restored.retry(partial.id)
  await expect(restored.bytes(partial.id)).resolves.toEqual(bytes)
  await vi.waitFor(() => expect(partial.status).toBe('error'))
  expect(partial.artifact?.revision).toBe(manifest.revision)
  const restarted = new PDFTranslationJobs(host); await restarted.loadHistory()
  await expect(restarted.bytes(partial.id)).resolves.toEqual(bytes)
})
it('isolates modes and ignores optional malformed coverage without trusting artifact paths', async () => {
  const jobs = new PDFTranslationJobs(host), concise = await jobs.start(1), full = await jobs.start(1, 'full')
  await vi.waitFor(() => expect(full.status).toBe('complete'))
  expect(concise.mode).toBe('concise'); expect(full.id).not.toBe(concise.id)
  const file = path.posix.join(pdfTaskDirectory(full.id), 'artifact.json'), manifest = JSON.parse(files.get(file)!)
  files.set(file, JSON.stringify({ ...manifest, coverage: { bad: true }, extra: true }))
  const readable = new PDFTranslationJobs(host); await readable.loadHistory()
  await expect(readable.bytes(full.id)).resolves.toEqual(bytes)
  files.set(file, JSON.stringify({ ...manifest, revision: '../unsafe' }))
  const unsafe = new PDFTranslationJobs(host); await unsafe.loadHistory()
  expect(unsafe.hasOutput(unsafe.get(full.id)!)).toBe(false)
})

it.each([401, 402, 403])('contains HTTP %i without killing layout and stops further requests', async status => {
  vi.mocked(translateMachineText).mockRejectedValueOnce(Object.assign(new Error('provider private body'), { status }))
  vi.mocked(runPDFWorker).mockImplementation(async (_host, config, _signal, message) => {
    const first = await message({ type: 'translate', id: 'first', text: 'input' })
    expect(first).toMatchObject({ id: 'first', error: { status, stop: true } })
    expect(await message({ type: 'translate', id: 'next', text: 'input' })).toMatchObject({ error: { code: 'DISPATCH_STOPPED' } })
    files.set(path.posix.join(String(config.directory), 'artifact.json'), JSON.stringify({ fingerprint: config.fingerprint, configuration: config.configuration, revision: 'f'.repeat(32), pages: 2, skipped: [], coverage: { total: 2, translated: 0, failed: 2, preserved: 0, failedPages: [0, 1] } }))
    await message({ type: 'complete' })
  })
  const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
  await vi.waitFor(() => expect(task.status).toBe('partial'))
  expect(translateMachineText).toHaveBeenCalledTimes(1)
  expect(task.error).not.toContain('private body')
  await expect(jobs.bytes(task.id)).resolves.toEqual(bytes)
})

it.each(['partial', 'failed'])('hands authoritative %s output to the local parser and keeps dispatching other batches', async state => {
  kind = 'ai'
  const partial = '[{"id":"p1","output":"translated"},'
  const failure = state === 'partial' ? new TemporaryPartialOutputError('partial', partial)
    : Object.assign(new Error('failed'), { code: 'REASONING_ONLY', stage: 'stream', executionState: 'failed', partialText: '' })
  const send = vi.spyOn(ReliableTemporaryChatClient.prototype, 'send').mockRejectedValueOnce(failure).mockResolvedValue('next translated')
  try {
    vi.mocked(runPDFWorker).mockImplementation(async (_host, config, _signal, message) => {
      expect(await message({ type: 'translate', id: 'first', text: 'input', llm: true })).toEqual(state === 'partial' ? { id: 'first', text: partial } : { id: 'first', error: { code: 'OUTPUT_FAILED', stop: false } })
      expect(await message({ type: 'translate', id: 'next', text: 'input', llm: true })).toEqual({ id: 'next', text: 'next translated' })
      files.set(path.posix.join(String(config.directory), 'artifact.json'), JSON.stringify({ fingerprint: config.fingerprint, configuration: config.configuration, revision: 'a'.repeat(32), pages: 2, skipped: [], coverage: { total: 2, translated: 2, failed: 0, preserved: 0, failedPages: [] } }))
      await message({ type: 'complete' })
    })
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    expect(send).toHaveBeenCalledTimes(2); expect(task.error).toBeUndefined()
  } finally { send.mockRestore() }
})

it('pauses automatic recovery on authoritative remote cancellation and only repairs after explicit Continue', async () => {
  kind = 'ai'
  const partial = '[{"id":"saved","output":"retained"}]'
  const send = vi.spyOn(ReliableTemporaryChatClient.prototype, 'send').mockRejectedValue(Object.assign(new Error('stopped'), {
    code: 'OUTPUT_CANCELLED', executionState: 'cancelled', partialText: partial,
  }))
  try {
    const finish = vi.mocked(runPDFWorker).getMockImplementation()!
    let continuing = false
    vi.mocked(runPDFWorker).mockImplementation(async (...args) => {
      const reply = await args[3]({ type: 'translate', id: 'original-operation', text: 'input' })
      expect(reply).toEqual(continuing ? { id: 'original-operation', text: partial } : { id: 'original-operation', error: { code: 'CANCELLED', stop: true } })
      if (!continuing) {
        expect(await args[3]({ type: 'translate', id: 'must-not-dispatch', text: 'other' })).toMatchObject({ error: { code: 'CANCELLED', stop: true } })
      }
      await finish(...args)
    })
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(task.status).toBe('cancelled'))
    expect(task.desiredState).toBe('paused')
    expect(send).toHaveBeenCalledTimes(1)
    continuing = true
    jobs.retry(task.id)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.every(([input]) => input.operationId === 'original-operation')).toBe(true)
    await jobs.stop()
  } finally { send.mockRestore() }
})

it.each([429, 503])('automatically resumes HTTP %i and continues the next passage', async status => {
  vi.useFakeTimers()
  try {
    vi.mocked(translateMachineText).mockRejectedValueOnce(Object.assign(new Error('busy'), { status, retryAfter: '0' }))
    vi.mocked(runPDFWorker).mockImplementation(async (_host, config, _signal, message) => {
      expect(await message({ type: 'translate', id: 'first', text: 'input' })).toEqual({ id: 'first', text: 'translated' })
      expect(await message({ type: 'translate', id: 'next', text: 'input' })).toEqual({ id: 'next', text: 'translated' })
      files.set(path.posix.join(String(config.directory), 'artifact.json'), JSON.stringify({ fingerprint: config.fingerprint, configuration: config.configuration, revision: 'f'.repeat(32), pages: 2, skipped: [], coverage: { total: 2, translated: 2, failed: 0, preserved: 0, failedPages: [] } }))
      await message({ type: 'complete' })
    })
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(Object.keys(task.retrying ?? {})).toEqual(['first']))
    await vi.waitFor(() => expect(task.status).toBe('complete'), { timeout: 5000 })
    expect(task.retrying).toEqual({}); expect(task.error).toBeUndefined()
    expect(translateMachineText).toHaveBeenCalledTimes(3)
  } finally { vi.useRealTimers() }
})
