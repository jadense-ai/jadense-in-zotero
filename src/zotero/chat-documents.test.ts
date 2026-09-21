/** 全文缓存回归：真实逐页适配、profile 重载、取消补齐、版本和清理边界。 */
import { describe, expect, it, vi } from 'vitest'
import { ChatDocuments } from './chat-documents'
import { DocumentStore, type TaskIO } from './document-store'
import type { ZoteroLike } from './runtime'
import type { ChatSource } from '@/chat/research-context'
import { createLocalChatSession, addLocalChatSources, readLocalChatState } from '@/chat/local-chat-store'

export function documentFixture(count = 26, options: { noVersion?: boolean; failPage?: number } = {}) {
  const files = new Map<string, string>()
  const paths = { profileDir: '/synthetic', join: (...parts: string[]) => parts.join('/'), filename: (path: string) => path.split('/').at(-1)! }
  const io: TaskIO = { makeDirectory: async () => {}, writeUTF8: vi.fn(async (path, text) => { files.set(path, text) }),
    readUTF8: async path => { if (!files.has(path)) throw new Error('missing'); return files.get(path)! },
    getChildren: async path => [...new Set([...files.keys()].filter(key => key.startsWith(path + '/')).map(key => path + '/' + key.slice(path.length + 1).split('/')[0]))],
    remove: async path => { files.delete(path) } }
  const item = { id: 2, key: 'PDF2', libraryID: 7, isPDFAttachment: () => true, attachmentModificationTime: options.noVersion ? undefined : 1, getField: () => 'Synthetic document' }
  const source: ChatSource = { id: 'zotero:7/PDF2:file', itemID: 2, libraryID: 7, itemKey: 'PDF2', kind: 'file', title: 'Synthetic document', citation: '', text: '', contentType: 'application/pdf' }
  const data: Record<number, { chars: Array<{ c: string; paragraphBreakAfter: boolean }> }> = {}
  const read = vi.fn(async (page: number) => {
    if (page === options.failPage) throw new Error('bad page')
    data[page] = { chars: [{ c: page === count - 1 ? 'TAIL_UNIQUE_FACT = 7391; appendix conclusion.' : `Page ${page + 1}. ` + 'ordinary evidence '.repeat(150), paragraphBreakAfter: true }] }
  })
  const reader = { itemID: 2, _internalReader: { _primaryView: { _ensureBasicPageData: read, _pdfPages: data,
    _iframeWindow: { PDFViewerApplication: { pdfDocument: { numPages: count, getPageLabels: async () => Array.from({ length: count }, (_, i) => String(i + 1)) } } } } } }
  const host = { Items: { get: () => item }, Reader: { _readers: [reader] } } as unknown as ZoteroLike
  const store = () => new DocumentStore(io, paths, 'jadense-chat-documents')
  const documents = new DocumentStore(io, paths)
  return { host, source, item, read, io, files, documents, cache: new ChatDocuments(store(), documents), restart: () => new ChatDocuments(store(), documents) }
}

describe('complete PDF cache', () => {
  it.each([26, 81, 300])('preserves all %i pages including the final fact after restart', async count => {
    const f = documentFixture(count)
    const result = await f.cache.ensure(f.host, f.source)
    expect(result.pages).toHaveLength(count)
    expect(result.pages.at(-1)?.paragraphs[0].text).toContain('7391')
    expect(result.source.text).toBe('')
    expect(result.source.document).toMatchObject({ totalPages: count, readablePages: count, complete: true })
    const restored = await f.restart().ensure(f.host, result.source)
    expect(restored.pages.at(-1)?.paragraphs[0].text).toContain('7391')
    expect(f.read).toHaveBeenCalledTimes(count)
    const prefs = new Map<string, unknown>(), preferences = { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => { prefs.set(key, value) }, clear: (key: string) => { prefs.delete(key) } }
    const session = createLocalChatSession(preferences)
    addLocalChatSources(preferences, session.id, [result.source, { ...result.source, id: '', itemID: 3, itemKey: 'PDF3' }])
    expect(readLocalChatState(preferences).sessions[0].sources.every(source => source.document?.totalPages === count)).toBe(true)
    expect(JSON.stringify([...prefs.values()]).length).toBeLessThan(4000)
  })

  it('resumes after cancellation without reading completed pages again', async () => {
    const f = documentFixture(81), controller = new AbortController()
    await expect(f.cache.ensure(f.host, f.source, controller.signal, text => { if (text.includes('10/81')) controller.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    const result = await f.restart().ensure(f.host, f.source)
    expect(result.pages).toHaveLength(81)
    expect(f.read).toHaveBeenCalledTimes(81)
  })

  it('retains successful pages and repairs only failed pages when explicitly retried', async () => {
    const f = documentFixture(26, { failPage: 12 })
    const first = await f.cache.ensure(f.host, f.source)
    expect(first.source.document?.readablePages).toBe(25)
    expect(first.pages.at(-1)?.paragraphs[0].text).toContain('7391')
    const before = f.read.mock.calls.length
    await f.cache.ensure(f.host, first.source, undefined, undefined, true)
    expect(f.read.mock.calls.slice(before).map(row => row[0])).toEqual([12])
  })

  it('does not reuse changed or unknown file versions', async () => {
    const f = documentFixture(26)
    const first = await f.cache.ensure(f.host, f.source)
    f.item.attachmentModificationTime = 2
    const changed = await f.cache.ensure(f.host, first.source)
    expect(changed.state.id).not.toBe(first.state.id)
    expect(f.read).toHaveBeenCalledTimes(52)
    const unknown = documentFixture(26, { noVersion: true })
    const one = await unknown.cache.ensure(unknown.host, unknown.source)
    await unknown.cache.ensure(unknown.host, one.source)
    expect(unknown.read).toHaveBeenCalledTimes(52)
  })

  it('continues writing later pages after an earlier disk failure and preserves in-memory text', async () => {
    const f = documentFixture(26)
    vi.mocked(f.io.writeUTF8).mockRejectedValueOnce(new Error('disk full'))
    const result = await f.cache.ensure(f.host, f.source)
    expect(result.state.storageWarning).toBe(true)
    expect(result.pages.at(-1)?.paragraphs[0].text).toContain('7391')
    expect([...f.files.keys()].some(path => path.endsWith('/page-25.json'))).toBe(true)
  })

  it('only deletes unreferenced chat caches, preserving independent document tasks', async () => {
    const f = documentFixture(26), result = await f.cache.ensure(f.host, f.source)
    const taskId = crypto.randomUUID()
    await f.documents.saveExtraction(taskId, { version: 1, markdown: 'manual OCR', pages: [], assets: [] })
    await f.cache.prune([result.source])
    expect(await f.cache.store.chat(result.state.id)).not.toBeNull()
    await f.cache.prune([])
    expect(await f.cache.store.chat(result.state.id)).toBeNull()
    expect((await f.documents.extraction(taskId))?.markdown).toBe('manual OCR')
  })
  it('reuses existing same-version OCR without invoking a reader or OCR installation', async () => {
    const f = documentFixture(26), id = crypto.randomUUID()
    const source = { itemID: 2, libraryID: 7, itemKey: 'PDF2', title: 'OCR', modificationTime: 1 }
    const pages = Array.from({ length: 26 }, (_, pageIndex) => ({ pageIndex, pageLabel: String(pageIndex + 1), lines: [], paragraphs: [{ id: `p${pageIndex}`, pageIndex, pageLabel: String(pageIndex + 1), text: `OCR evidence ${pageIndex}`, rects: [], lineIDs: [] }] }))
    await f.documents.save({ id, version: 1, kind: 'extraction', source, createdAt: new Date().toISOString(), status: 'partial', totalPages: 26, completed: 26, total: 26, models: [], warnings: ['layout uncertain'], extractionVersion: 5 })
    await f.documents.saveExtraction(id, { version: 1, markdown: 'OCR document', pages, assets: [] })
    const result = await f.cache.ensure(f.host, f.source)
    expect(result.pages.at(-1)?.paragraphs[0].text).toBe('OCR evidence 25')
    expect(f.read).not.toHaveBeenCalled()
  })
})
