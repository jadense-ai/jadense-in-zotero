/** 任务身份与真实状态流回归；仅替换宿主 I/O 和排版进程。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { PDFTranslationJobs } from './pdf-translation-jobs'
import { preparePDFEngine, runPDFWorker } from './pdf-translation-runtime'
import type { ZoteroLike } from './runtime'
import { translateMachineText } from '@/chat/machine-translation'
import { requestHash } from '@/chat/temporary-request-store'
import { PDF_ENGINE, PDF_ADAPTER, pdfTaskDirectory } from './pdf-translation-runtime'
import { readPDFTranslationMode, savePDFTranslationMode } from './pdf-translation-policy'
import { ReliableTemporaryChatClient, TemporaryPartialOutputError } from '@/chat/reliable-temporary-chat'

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
vi.mock('./ai-settings', () => ({ featureModelState: () => ({ ready: true, selection: {}, route: 'jadense' }) }))
vi.mock('./pdf-translation-runtime', async original => ({ ...await original<typeof import('./pdf-translation-runtime')>(), preparePDFEngine: vi.fn(async () => {}), runPDFWorker: vi.fn() }))
const files = new Map<string, string>()
let bytes = new Uint8Array([37, 80, 68, 70, 1])
let service = 'google'
let kind = 'machine'
const preferences = new Map<string, unknown>()
const host = {
  Items: { get: (id: number) => ({ id, libraryID: 1, key: `PDF${id}`, isPDFAttachment: () => true, getField: () => 'Paper', getFilePathAsync: async () => '/source.pdf' }) },
  Prefs: { get: (key: string) => key.endsWith('fullTranslationInterface') ? JSON.stringify({ kind, service }) : preferences.get(key) },
  getMainWindow: () => ({ fetch: vi.fn() }),
} as unknown as ZoteroLike

beforeEach(() => {
  files.clear(); preferences.clear(); kind = 'machine'; bytes = new Uint8Array([37, 80, 68, 70, 1]); service = 'google'; vi.clearAllMocks()
  vi.stubGlobal('PathUtils', { profileDir: '/profile', join: path.posix.join, filename: path.posix.basename })
  vi.stubGlobal('IOUtils', { read: async () => bytes, readUTF8: async (file: string) => { if (!files.has(file)) throw new Error('missing'); return files.get(file)! },
    getChildren: async () => [...new Set([...files.keys()].map(file => path.posix.dirname(file)))], makeDirectory: async () => {}, writeUTF8: async (file: string, value: string) => { files.set(file, value) }, exists: async () => true })
  vi.mocked(runPDFWorker).mockImplementation(async (_host, config, _signal, message) => {
    files.set(path.posix.join(String(config.directory), 'artifact.json'), JSON.stringify({ fingerprint: config.fingerprint, configuration: config.configuration, revision: 'a'.repeat(32), pages: 2, skipped: [1], coverage: { total: 2, translated: 2, failed: 0, preserved: 1, failedPages: [] } }))
    await message({ type: 'complete', pages: 2, skipped: [1], extra: true })
  })
})

describe('PDF jobs', () => {
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
    expect(task.error).toMatch(/changed/)
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

it('hands authoritative partial output to the local parser and keeps dispatching other batches', async () => {
  kind = 'ai'
  const partial = '[{"id":"p1","output":"translated"},'
  const send = vi.spyOn(ReliableTemporaryChatClient.prototype, 'send').mockRejectedValueOnce(new TemporaryPartialOutputError('partial', partial)).mockResolvedValue('next translated')
  try {
    vi.mocked(runPDFWorker).mockImplementation(async (_host, config, _signal, message) => {
      expect(await message({ type: 'translate', id: 'first', text: 'input', llm: true })).toEqual({ id: 'first', text: partial })
      expect(await message({ type: 'translate', id: 'next', text: 'input', llm: true })).toEqual({ id: 'next', text: 'next translated' })
      files.set(path.posix.join(String(config.directory), 'artifact.json'), JSON.stringify({ fingerprint: config.fingerprint, configuration: config.configuration, revision: 'a'.repeat(32), pages: 2, skipped: [], coverage: { total: 2, translated: 2, failed: 0, preserved: 0, failedPages: [] } }))
      await message({ type: 'complete' })
    })
    const jobs = new PDFTranslationJobs(host), task = await jobs.start(1)
    await vi.waitFor(() => expect(task.status).toBe('complete'))
    expect(send).toHaveBeenCalledTimes(2); expect(task.error).toBeUndefined()
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
