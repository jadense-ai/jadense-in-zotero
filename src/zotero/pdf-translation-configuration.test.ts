/** 使用真实模型偏好和任务存取复现旧成果恢复；仅替换宿主 I/O、账户探针和排版进程。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import path from 'node:path'
import { PDFTranslationJobs } from './pdf-translation-jobs'
import { preparePDFEngine, runPDFWorker } from './pdf-translation-runtime'
import { AI_MODEL_SETTINGS_PREF_KEY } from './ai-settings'
import { rememberModelCatalog } from './model-catalog'
import type { ZoteroLike } from './runtime'

vi.mock('@/chat/temporary-account', () => ({ resolveTemporaryAccount: vi.fn(async () => ({ account: 'synthetic-owner', verified: true })) }))
vi.mock('./pdf-translation-runtime', async original => ({ ...await original<typeof import('./pdf-translation-runtime')>(), preparePDFEngine: vi.fn(async () => {}), runPDFWorker: vi.fn() }))

const files = new Map<string, string>(), prefs = new Map<string, unknown>()
const jobsToStop: PDFTranslationJobs[] = []
let bytes: Uint8Array
const pref = (key: string, value: unknown, global = false) => prefs.set(global ? key : `extensions.zotero.${key}`, value)
const network = vi.fn(async () => { throw new Error('No provider requests expected') })
const window = { fetch: network }
const host = {
  Items: { get: (id: number) => ({ id, libraryID: 1, key: `PDF${id}`, isPDFAttachment: () => true, getField: () => 'Synthetic paper', getFilePathAsync: async () => '/source.pdf' }) },
  Prefs: {
    get: (key: string, global = false) => prefs.get(global ? key : `extensions.zotero.${key}`),
    set: pref,
  },
  getMainWindow: () => window,
} as unknown as ZoteroLike
const jobs = () => { const value = new PDFTranslationJobs(host); jobsToStop.push(value); return value }
const service = (value: string) => pref('extensions.jadenseInZotero.fullTranslationInterface', JSON.stringify({ kind: 'machine', service: value }), true)
const model = (value: string) => pref(AI_MODEL_SETTINGS_PREF_KEY, JSON.stringify({ version: 1, followChatModel: false, models: Object.fromEntries(['chat', 'translation', 'analysis', 'figure'].map(key => [key, { route: 'jadense', selection: { kind: 'model', modelId: value } }])) }), true)

beforeEach(() => {
  files.clear(); prefs.clear(); vi.clearAllMocks()
  bytes = new Uint8Array([37, 80, 68, 70, 1])
  service('google')
  vi.stubGlobal('PathUtils', { profileDir: '/profile', join: path.posix.join, filename: path.posix.basename })
  vi.stubGlobal('IOUtils', {
    read: async () => bytes,
    readUTF8: async (file: string) => { if (!files.has(file)) throw new Error('missing'); return files.get(file)! },
    getChildren: async () => [...new Set([...files.keys()].map(file => path.posix.dirname(file)))],
    makeDirectory: async () => {}, writeUTF8: async (file: string, value: string) => { files.set(file, value) }, exists: async () => true,
  })
  vi.mocked(preparePDFEngine).mockReset().mockResolvedValue(undefined)
  vi.mocked(runPDFWorker).mockReset().mockImplementation(async (_host, config, _signal, message) => {
    files.set(path.posix.join(String(config.directory), 'artifact.json'), JSON.stringify({ fingerprint: config.fingerprint, configuration: config.configuration, revision: 'a'.repeat(32), pages: 9, skipped: [], coverage: { total: 151, translated: 0, failed: 151, preserved: 1, failedPages: [0, 1, 2, 3, 4, 5, 6, 7, 8] } }))
    await message({ type: 'complete' })
  })
})
afterEach(async () => { await Promise.all(jobsToStop.splice(0).map(value => value.stop())); vi.unstubAllGlobals() })

it('keeps zero-translation history readable and identifies a changed configuration before explicit fresh translation', async () => {
  const firstJobs = jobs(), first = await firstJobs.start(1)
  await vi.waitFor(() => expect(first.status).toBe('partial'))
  await firstJobs.stop()
  service('bing')
  vi.clearAllMocks()
  const restoredJobs = jobs(), restored = await restoredJobs.openOrStart(1)
  expect(restored.id).toBe(first.id)
  expect(runPDFWorker).not.toHaveBeenCalled()
  restoredJobs.retry(restored.id)
  await vi.waitFor(() => expect(restored.status).toBe('error'))
  expect(restored.blockedReason).toBe('configuration')
  expect(restored.error).toMatch(/按当前设置重新翻译|Translate again with current settings/u)
  expect(restored.error).not.toMatch(/原 PDF|The PDF/u)
  expect(runPDFWorker).not.toHaveBeenCalled()
  expect(restored.coverage).toMatchObject({ translated: 0, failed: 151, preserved: 1 })
  const fresh = await restoredJobs.start(1, restored.mode, true)
  expect(fresh.id).not.toBe(restored.id)
  await vi.waitFor(() => expect(fresh.status).toBe('partial'))
  expect(runPDFWorker).toHaveBeenCalledTimes(1)
  expect(restoredJobs.get(restored.id)?.artifact).toBeDefined()
})

it('distinguishes changed PDF bytes from unchanged translation settings', async () => {
  vi.mocked(preparePDFEngine).mockImplementationOnce(async () => { bytes = new Uint8Array([37, 80, 68, 70, 2]) })
  const task = await jobs().start(1)
  await vi.waitFor(() => expect(task.status).toBe('error'))
  expect(task.blockedReason).toBe('source')
  expect(task.error).toMatch(/原 PDF 文件已变化|The source PDF has changed/u)
  expect(task.error).not.toMatch(/账户|account/u)
  expect(runPDFWorker).not.toHaveBeenCalled()
})

it('keeps real AI settings stable across optional metadata, folder, hidden service and same-account token changes', async () => {
  model('synthetic-model')
  pref('extensions.jadenseInZotero.token', 'synthetic-token')
  pref('extensions.jadenseInZotero.fullTranslationInterface', JSON.stringify({ kind: 'ai', service: 'google' }), true)
  vi.mocked(preparePDFEngine).mockImplementationOnce(async () => {
    rememberModelCatalog(host, { options: [], defaultSelection: { kind: 'model', modelId: 'synthetic-model' } })
    pref('extensions.jadenseInZotero.defaultFolderId', 'synthetic-folder')
    pref('extensions.jadenseInZotero.token', 'synthetic-rotated-token')
    pref('extensions.jadenseInZotero.fullTranslationInterface', JSON.stringify({ kind: 'ai', service: 'bing', extra: true }), true)
  })
  const task = await jobs().start(1)
  await vi.waitFor(() => expect(task.status).toBe('partial'))
  expect(task.blockedReason).toBeUndefined()
  expect(runPDFWorker).toHaveBeenCalledTimes(1)
})

it('still stops a real model change before engine dispatch', async () => {
  model('synthetic-model')
  pref('extensions.jadenseInZotero.token', 'synthetic-token')
  pref('extensions.jadenseInZotero.fullTranslationInterface', JSON.stringify({ kind: 'ai' }), true)
  vi.mocked(preparePDFEngine).mockImplementationOnce(async () => { model('different-model') })
  const task = await jobs().start(1)
  await vi.waitFor(() => expect(task.status).toBe('error'))
  expect(task.blockedReason).toBe('configuration')
  expect(runPDFWorker).not.toHaveBeenCalled()
})
