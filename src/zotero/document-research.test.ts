/** 0.4.2 行为回归：完整来源覆盖、零 AI 常规引用、无副作用核验与恢复。 */
import { describe, it, expect, vi } from "vitest"
// 旧文字层/JSON 协议的历史回归使用 v4 适配器；v5 OCR 主路径在 ocr-translation.test.ts 覆盖。
vi.mock('./local-ocr', async () => ({ readOCRDocument: async (host: unknown, id: number, signal: AbortSignal) => (await import('./pdf-document')).readTextDocument(host as never, id, signal), stopLocalOCR: () => {} }))
vi.mock('./translation-chunks', async importOriginal => ({ ...await importOriginal<typeof import('./translation-chunks')>(), OCR_EXTRACTION_VERSION: 4 }))
vi.mock('@/chat/translation-queue', async importOriginal => ({ ...await importOriginal<typeof import('@/chat/translation-queue')>(), queueTranslation: async (_host: unknown, _key: string, _signal: unknown, run: () => Promise<unknown>) => run() }))
// 本文件验证文档调度；全文翻译经过普通 temporary chat 客户端，参考文献 AI 的可靠传输单独测试。
vi.mock('@/chat/reliable-temporary-chat', async () => ({ ReliableTemporaryChatClient: (await import('@/chat/temporary-chat')).TemporaryChatClient }))
vi.mock('@/chat/reliable-byok-chat', async () => ({ ReliableByokChatClient: (await import('@/chat/byok-chat')).ByokChatClient }))
import { extractReferences, applyReferenceSuggestion, metadataMatches, parseReferenceFields } from "@/chat/reference-list"
import { DocumentJobs, acceptTranslations, splitTranslationText, estimateTokens } from "./document-jobs"
import { DocumentStore, type TaskIO, type TranslationPage } from "./document-store"
import { readTextDocument, textPage, orderColumnLines, navigateDocument, isLiveDocumentReader, type PdfTextDocument, type PdfLine } from "./pdf-document"
import { importReference, ReferenceVerifier } from "./reference-verification"
import { referenceRow } from "./document-ui"
import { FONT_SIZE_PREF, readFontSize, saveFontSize, readTranslationStyle, saveTranslationStyle } from "./ui-preferences"
import type { ZoteroLike } from "./runtime"

function chars(lines: string[]) { return lines.flatMap(line => [...line].map((c, i) => ({ c, lineBreakAfter: i === line.length - 1, paragraphBreakAfter: i === line.length - 1, rect: [i, 10, i + 1, 20] }))) }
const citation = "[1] Smith, J. (2020). Reliable scientific evidence. Research Journal. https://doi.org/10.1234/evidence"
function document(lines: string[][] = [["References", citation]]) {
  return { source: { itemID: 11, itemKey: "PDF00001", libraryID: 1, title: "Fixture", modificationTime: 42 }, pages: lines.map((lines, index) => textPage(chars(lines), index, String(index + 1))) } satisfies PdfTextDocument
}
function host(lines: string[][] = [["References", citation]], prefs = new Map<string, unknown>()) {
  const item = { id: 11, key: "PDF00001", libraryID: 1, isPDFAttachment: () => true, getField: () => "Fixture", attachmentModificationTime: 42 }
  const view = { _ensureBasicPageData: vi.fn(async () => {}), _pdfPages: Object.fromEntries(lines.map((lines, i) => [i, { chars: chars(lines) }])), _iframeWindow: { PDFViewerApplication: { pdfDocument: { numPages: lines.length } } } }
  const reader = { itemID: 11, _internalReader: { _primaryView: view } }
  return { item, view, zotero: { Items: { get: () => item }, Reader: { _readers: [reader] }, Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) } } as unknown as ZoteroLike }
}
function memoryStore() {
  const files = new Map<string, string>()
  const io: TaskIO = { makeDirectory: vi.fn(async () => {}), writeUTF8: vi.fn(async (path, text) => { files.set(path, text) }), readUTF8: vi.fn(async path => { if (!files.has(path)) throw new Error("missing"); return files.get(path)! }), getChildren: vi.fn(async path => [...new Set([...files.keys()].filter(key => key.startsWith(`${path}/`)).map(key => path + "/" + key.slice(path.length + 1).split("/")[0]))]), remove: vi.fn(async path => { files.delete(path) }) }
  const paths = { profileDir: "/fixture", join: (...parts: string[]) => parts.join("/"), filename: (path: string) => path.split("/").at(-1)! }
  return { store: new DocumentStore(io, paths), reload: () => new DocumentStore(io, paths), files, io }
}
const configured = () => new Map<string, unknown>([["extensions.jadenseInZotero.token", "synthetic-only"], ['extensions.jadenseInZotero.referenceAIEnabled', true], ['extensions.jadenseInZotero.autoFollowChatModel', false]])
function response(value: unknown) { return new Response(`data: ${JSON.stringify({ type: "text-delta", delta: JSON.stringify(value) })}\n\ndata: ${JSON.stringify({ type: "finish" })}\n\n`, { status: 200 }) }



describe("complete PDF and reference evidence", () => {
  it("imports a matched reference by cancelling optional AI instead of waiting for its result", async () => {
    const fixture = host([['References', citation, '[2] Unknown fragment']], configured()), memory = memoryStore()
    const save = vi.fn(async () => {})
    Object.assign(fixture.zotero, {
      Translate: { Search: class { setIdentifier() {} async getTranslators() { return [{}] } setTranslator() {} async translate() { return [{ title: 'Reliable scientific evidence', DOI: '10.1234/evidence' }] } } },
      Libraries: { get: () => ({ editable: true }) }, Search: class { libraryID = 1; addCondition() {} async search() { return [] } },
      Item: class { id = 50; key = 'IMPORTED'; libraryID = 1; setField() {} setCreators() {} saveTx = save },
    })
    let aiSignal: AbortSignal | undefined
    const fetchImpl = vi.fn((_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      aiSignal = options?.signal ?? undefined
      aiSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as typeof fetch, memory.store)
    const task = await jobs.start('references', 11)
    await vi.waitFor(() => expect(aiSignal).toBeDefined())
    const entries = await memory.store.references(task.id)
    expect(entries[0].verification).toBe('verified')
    expect(await jobs.import(task.id, [entries[0].id], 1)).toEqual({ imported: 1, failed: 0, uncertain: 0 })
    expect(aiSignal!.aborted).toBe(true); expect(save).toHaveBeenCalledOnce()
    expect((await memory.store.references(task.id))[0].imported?.itemID).toBe(50)
    jobs.dispose()
  })
  it("does not pause local lookup when AI connection preferences change", async () => {
    const fixture = host(), memory = memoryStore(), observers = new Map<string, () => void>()
    Object.assign(fixture.zotero.Prefs!, { registerObserver: (key: string, cb: () => void) => { observers.set(key, cb); return key }, unregisterObserver() {} })
    const fetchImpl = vi.fn(async (_url: string, options?: RequestInit) => {
      observers.get('extensions.jadenseInZotero.token')!()
      expect(options?.signal?.aborted).toBe(false)
      return new Response(JSON.stringify({ message: { title: ['Reliable scientific evidence'], DOI: '10.1234/evidence' } }))
    })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as typeof fetch, memory.store)
    const task = await jobs.start('references', 11); await jobs.idle()
    expect(task.status).toBe('complete'); expect((await memory.store.references(task.id))[0].verification).toBe('verified')
    expect(task.models).toEqual([]); jobs.dispose()
  })
  it("extracts IEEE, GB/T and year-first citations with wrapped titles without AI", () => {
    const refs = extractReferences(document([["References",
      '[1] J. Smith et al., “Reliable scientific', 'evidence,” Research Journal, 2020.',
      '[2] 张三, 李四, 等. 深度学习的证据组合[J]. 科学通报, 2021, 10: 1-4.',
      '(3) Smith, J. 2020. Reliable scientific evidence. Research Journal.',
      '[4] Smith, J. (2020). Reliable scien-', 'tific evidence. Research Journal.',
      '[5] J. Smith et al. Reliable scientific evidence. Research Journal. 2020.',
    ]]))
    expect(refs).toHaveLength(5)
    expect(refs.map(row => row.fields.title)).toEqual(['Reliable scientific evidence', '深度学习的证据组合', 'Reliable scientific evidence', 'Reliable scientific evidence', 'Reliable scientific evidence'])
    expect(refs[1].fields.authors).toEqual(['张三', '李四'])
    expect(refs.map(row => row.label)).toEqual(['1', '2', '3', '4', '5'])
    expect(refs[0].raw).toBe('J. Smith et al., “Reliable scientific evidence,” Research Journal, 2020.')
    expect(refs[3].raw).toBe('Smith, J. (2020). Reliable scientific evidence. Research Journal.')
    expect(refs[0].lines).toHaveLength(2); expect(refs[3].lines).toHaveLength(2)
  })
  it("does not split numbered citations on author-year continuation lines", () => {
    const refs = extractReferences(document([['References', '[1] First author,', 'Smith, J. (2020). Reliable scientific evidence.', '[2] Next author,', 'Jones, K. (2021). Another study.']]))
    expect(refs).toHaveLength(2); expect(refs[0].lines).toHaveLength(2)
  })
  it("finishes direct title lookup before AI and excludes matched incomplete author/year entries from fallback", async () => {
    const prefs = configured(), fixture = host([['References', '[1] J. Smith, “Reliable scientific evidence,” Journal.', '[2] Unknown fragment']], prefs), memory = memoryStore()
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, options?: RequestInit) => {
      calls.push(url)
      if (url.startsWith('https://api.crossref.org/works?')) {
        expect(options?.credentials).toBe('omit'); expect(options?.headers).toBeUndefined()
        return new Response(JSON.stringify({ message: { items: [{ title: ['Reliable scientific evidence'], DOI: '10.1234/matched', author: [], published: { 'date-parts': [[1999]] } }] } }))
      }
      const saved = await memory.store.references(jobs.list('references')[0].id)
      expect(saved[0].verification).toBe('verified')
      expect(String(options?.body)).not.toContain('Reliable scientific evidence')
      return response({ items: [] })
    })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as typeof fetch, memory.store)
    const task = await jobs.start('references', 11); await jobs.idle()
    expect(calls).toHaveLength(2); expect(calls[0]).toContain('query.title=')
    expect((await memory.store.references(task.id))[0].verified?.doi).toBe('10.1234/matched')
    expect(task.completed).toBe(2); jobs.dispose()
  })
  it('continues later batches after malformed JSON without repair requests', async () => {
    const fixture = host([['References', ...Array.from({ length: 17 }, (_, i) => `[${i + 1}] Unknown ${i}`)]], configured()), memory = memoryStore()
    const fetchImpl = vi.fn(async () => response({ items: [] }))
    fetchImpl.mockResolvedValueOnce(new Response('data: {"type":"text-delta","delta":"not JSON"}\n\ndata: {"type":"finish"}\n\n'))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, memory.store)
    const task = await jobs.start('references', 11); await jobs.idle()
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(task.completed).toBe(17)
    expect(task.referenceAI?.batches.map(batch => batch.status)).toEqual(['failed', 'complete']); jobs.dispose()
  })
  it('disabling the shared preference cancels AI and still verifies all entries', async () => {
    const prefs = configured(), fixture = host([['References', ...Array.from({ length: 17 }, (_, i) => `[${i + 1}] Unknown ${i}`)]], prefs), memory = memoryStore()
    let changed = () => {}
    Object.assign(fixture.zotero.Prefs!, { registerObserver: (key: string, cb: () => void) => { if (key.endsWith('referenceAIEnabled')) changed = cb; return key }, unregisterObserver: vi.fn() })
    const fetchImpl = vi.fn(async () => { prefs.set('extensions.jadenseInZotero.referenceAIEnabled', false); changed(); throw new DOMException('cancelled', 'AbortError') })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, memory.store)
    const task = await jobs.start('references', 11); await jobs.idle(); await jobs.idle()
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(task.completed).toBe(17); jobs.dispose()
  })
  it('does not send AI when identity cannot be persisted, while retaining verification', async () => {
    const fixture = host([['References', '[1] Unknown']], configured()), memory = memoryStore(), fetchImpl = vi.fn()
    memory.io.writeUTF8 = vi.fn(async () => { throw new Error('disk full') })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, memory.store)
    const task = await jobs.start('references', 11); await jobs.idle()
    expect(fetchImpl).not.toHaveBeenCalled(); expect(task.completed).toBe(1); expect(task.referenceAI?.pausedReason).toBeTruthy(); jobs.dispose()
  })
  it('defaults AI off even with an existing token and completes non-AI verification', async () => {
    const fixture = host([['References', '[1] Unknown alpha', '[2] Unknown beta']], new Map([['extensions.jadenseInZotero.token', 'synthetic-only']]))
    const memory = memoryStore(), fetchImpl = vi.fn()
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, memory.store)
    const task = await jobs.start('references', 11); await jobs.idle()
    expect(fetchImpl).not.toHaveBeenCalled(); expect(task.completed).toBe(2); jobs.dispose()
  })
  it('persists batches and stops all later AI after 402 while verifying every original reference', async () => {
    const fixture = host([['References', ...Array.from({ length: 33 }, (_, i) => `[${i + 1}] Unknown source ${i}`)]], configured())
    const memory = memoryStore()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 'POINTS_INSUFFICIENT', error: '积分不足' }), { status: 402 }))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, memory.store)
    const task = await jobs.start('references', 11); await jobs.idle()
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(task.completed).toBe(33)
    expect(task.referenceAI?.pausedReason).toBe('积分不足')
    expect(task.referenceAI?.batches.map(batch => batch.entryIds.length)).toEqual([16, 16, 1])
    expect(task.referenceAI?.batches.every(batch => batch.status === 'failed')).toBe(true)
    jobs.dispose()
    const reloaded = new DocumentJobs(fixture.zotero, fetchImpl, memory.reload()); await reloaded.ready; await reloaded.idle()
    expect(fetchImpl).toHaveBeenCalledTimes(1); reloaded.dispose()
  })
  it("deduplicates repeated starts while the native reference read is still pending", async () => {
    const fixture = host(), memory = memoryStore()
    let release!: () => void
    fixture.view._ensureBasicPageData.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const jobs = new DocumentJobs(fixture.zotero, vi.fn(), memory.store)
    const first = jobs.start("references", 11)
    await vi.waitFor(() => expect(fixture.view._ensureBasicPageData).toHaveBeenCalledTimes(1))
    const second = jobs.start("references", 11)
    release()
    expect((await first).id).toBe((await second).id)
    await jobs.idle(); expect(jobs.list("references")).toHaveLength(1)
    expect(fixture.view._ensureBasicPageData).toHaveBeenCalledTimes(1); jobs.dispose()
  })

  it("pauses a queued reference task before it can identify or verify another PDF", async () => {
    const fixture = host([["References", "[1] Uncertain source"]], configured()), memory = memoryStore()
    const secondItem = { ...fixture.item, id: 12, key: "PDF00002" }
    const readers = [{ itemID: 11, _internalReader: { _primaryView: fixture.view } }, { itemID: 12, _internalReader: { _primaryView: fixture.view } }]
    Object.assign(fixture.zotero, { Items: { get: (id: number) => id === 12 ? secondItem : fixture.item }, Reader: { _readers: readers } })
    let release!: () => void
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { release = () => resolve(response({ references: [] })) }))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, memory.store)
    await jobs.start("references", 11)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const queued = await jobs.start("references", 12)
    expect(jobs.referencePhase(queued.id)).toBe("queued")
    jobs.pause(queued.id); release(); await jobs.idle()
    expect(queued.status).toBe("paused"); expect(queued.completed).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(await memory.store.references(queued.id)).toHaveLength(1); jobs.dispose()
  })

  it("reports partial import failure while preserving successful entries and retryable source rows", async () => {
    const fixture = host([["References", citation, citation.replace("[1]", "[2]")]]), memory = memoryStore()
    const jobs = new DocumentJobs(fixture.zotero, vi.fn(), memory.store)
    const task = await jobs.start("references", 11); await jobs.idle()
    const entries = await memory.store.references(task.id)
    entries.forEach(entry => { entry.verification = "verified"; entry.verified = entry.fields })
    await memory.store.saveReferences(task.id, entries)
    const search = vi.fn().mockRejectedValueOnce(new Error("lookup offline")).mockResolvedValue([])
    const save = vi.fn(async () => {})
    Object.assign(fixture.zotero, { Libraries: { get: () => ({ editable: true }) }, Search: class { libraryID = 1; addCondition() {} search = search }, Item: class { id = 50; key = "IMPORTED"; libraryID = 1; setField() {} setCreators() {} saveTx = save } })
    expect(await jobs.import(task.id, entries.map(entry => entry.id), 1)).toEqual({ imported: 1, failed: 1, uncertain: 0 })
    const after = await memory.store.references(task.id)
    expect(after.map(entry => entry.raw)).toEqual(entries.map(entry => entry.raw))
    expect(after[0].imported).toBeUndefined(); expect(after[0].importUncertain).toBeFalsy()
    expect(after[1].imported?.itemID).toBe(50); expect(save).toHaveBeenCalledTimes(1); jobs.dispose()
  })

  it("cancels reference preparation immediately and discards a late native page read", async () => {
    const fixture = host(), memory = memoryStore(), controller = new AbortController()
    let release!: () => void
    fixture.view._ensureBasicPageData.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const jobs = new DocumentJobs(fixture.zotero, vi.fn(), memory.store)
    const pending = jobs.start("references", 11, false, { signal: controller.signal })
    await vi.waitFor(() => expect(fixture.view._ensureBasicPageData).toHaveBeenCalled())
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(jobs.list()).toHaveLength(1); expect(jobs.list()[0].status).toBe("paused")
    release(); await Promise.resolve(); await Promise.resolve()
    expect(jobs.list()).toHaveLength(1); expect(jobs.list()[0].status).toBe("paused"); jobs.dispose()
  })

  it("does not read pages when cancelled before document storage becomes ready", async () => {
    const fixture = host(), memory = memoryStore(), controller = new AbortController()
    controller.abort()
    const jobs = new DocumentJobs(fixture.zotero, vi.fn(), memory.store)
    await expect(jobs.start("references", 11, false, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(fixture.view._ensureBasicPageData).not.toHaveBeenCalled(); jobs.dispose()
  })

  it("serializes an import with re-verification so later task saves retain native import results", async () => {
    const fixture = host(), memory = memoryStore(), jobs = new DocumentJobs(fixture.zotero, vi.fn(), memory.store)
    const task = await jobs.start("references", 11); await jobs.idle()
    const rows = await memory.store.references(task.id)
    rows[0].verification = "verified"; rows[0].verified = rows[0].fields
    await memory.store.saveReferences(task.id, rows)
    let release!: () => void
    const searched = vi.fn(() => new Promise<number[]>(resolve => { release = () => resolve([]) }))
    const save = vi.fn(async () => {})
    Object.assign(fixture.zotero, {
      Libraries: { get: () => ({ editable: true }) },
      Search: class { libraryID = 1; addCondition() {} search = searched },
      Item: class { id = 50; key = "IMPORTED"; libraryID = 1; setField() {} setCreators() {} saveTx = save },
    })
    const importing = jobs.import(task.id, [rows[0].id], 1)
    await vi.waitFor(() => expect(searched).toHaveBeenCalled())
    jobs.resume(task.id)
    release()
    expect(await importing).toEqual({ imported: 1, failed: 0, uncertain: 0 })
    await jobs.idle()
    expect((await memory.store.references(task.id))[0].imported?.itemID).toBe(50)
    expect(save).toHaveBeenCalledTimes(1); jobs.dispose()
  })
  it("reads every page beyond 80, keeps short headings and text without coordinates", async () => {
    const fixture = host(Array.from({ length: 83 }, (_, i) => [i === 82 ? "FINAL PAGE" : "Title"]))
    const result = await readTextDocument(fixture.zotero as never, 11)
    expect(result.pages).toHaveLength(83); expect(result.pages[82].paragraphs[0].text).toBe("FINAL PAGE")
    expect(textPage([{ c: "x" }], 0, "i").paragraphs[0]).toMatchObject({ text: "x", rects: [] })
    expect(fixture.view._ensureBasicPageData).toHaveBeenLastCalledWith(82)
  })
  it("retains duplicate DOI occurrences, missing identifiers and cross-page continuation in source order", () => {
    const refs = extractReferences(document([["References", citation, "[2] Jones, K. (2021). A book without DOI."], ["Publisher and continuation.", citation.replace("[1]", "[3]")]]))
    expect(refs).toHaveLength(3); expect(refs.map(row => row.label)).toEqual(["1", "2", "3"])
    expect(refs[1].raw).toContain("Publisher and continuation.")
    expect(refs[0].fields.doi).toBe(refs[2].fields.doi)
    expect(refs[0].uncertain).toBe(false); expect(refs[1].fields.doi).toBeUndefined()
  })
  it("handles author-year lists, split DOI and stopping at an explicit appendix", () => {
    const refs = extractReferences(document([["Bibliography", citation.replace("[1] ", ""), "Jones, K. (2021). Another study. Journal. doi:10.1234/", "second", "Appendix A", "Unrelated appendix text"]]))
    expect(refs).toHaveLength(2); expect(refs[1].fields.doi).toBe("10.1234/second")
    expect(refs[1].raw).not.toContain("Appendix")
  })
  it("rejects AI omissions, overlapping lines and invented fields without losing the source", () => {
    const original = extractReferences(document([["References", "[1] Uncertain text", "continued unknown citation"]]))[0]
    expect(applyReferenceSuggestion(original, { references: [{ startLine: 0, endLine: 0 }] })).toEqual([original])
    expect(applyReferenceSuggestion(original, { references: [{ startLine: 0, endLine: 1, title: "Invented publication", DOI: "10.1234/fake" }], future: true })[0].fields).toMatchObject({ title: "" })
    expect(applyReferenceSuggestion(original, { references: [{ startLine: 0, endLine: 1 }] })[0].raw).toBe(original.raw)
  })
  it("accepts DOI or title without author or year gates", () => {
    const fields = parseReferenceFields(citation)
    expect(metadataMatches(fields, { ...fields, title: "Different paper" })).toBe(true)
    expect(metadataMatches(fields, { ...fields, title: "Different paper", doi: "10.1234/other" })).toBe(false)
    expect(metadataMatches(fields, { ...fields, authors: [] })).toBe(true)
    expect(metadataMatches(fields, { ...fields, title: fields.title.toUpperCase() })).toBe(true)
    expect(metadataMatches({ ...fields, doi: undefined }, { ...fields, authors: ["Smith, K."], year: "2025" })).toBe(true)
    expect(metadataMatches({ ...fields, doi: undefined, authors: ["Smith", "et al."] }, { ...fields, authors: ["Smith", "Doe"] })).toBe(true)
  })
  it("orders interleaved two-column lines, retaining hanging continuation and all source ranges", () => {
    const line = (id: string, x: number, y: number, text: string): PdfLine => ({ id, text, pageIndex: 0, pageLabel: "1", rects: [[x, y - 10, x + 180, y]] })
    const lines = [line("l1", 20, 700, citation), line("r1", 320, 700, citation.replace("[1]", "[3]")), line("l2", 20, 660, citation.replace("[1]", "[2]")), line("r2", 320, 660, "continuation")]
    expect(orderColumnLines(lines).map(row => row.id)).toEqual(["l1", "l2", "r1", "r2"])
    const fixture = document(); fixture.pages[0].lines = [{ ...lines[0], id: "heading", text: "References" }, ...orderColumnLines(lines)]
    const entries = extractReferences(fixture)
    expect(entries).toHaveLength(3); expect(entries.flatMap(row => row.lines).map(row => row.id)).toEqual(["l1", "l2", "r1", "r2"])
  })
  it("marks scanned and failed pages but reads the final page", async () => {
    const fixture = host([["First"], [], ["Failed"], ["Last"]])
    fixture.view._ensureBasicPageData.mockImplementation(async (index?: number) => { if (index === 2) throw new Error("page") })
    const result = await readTextDocument(fixture.zotero as never, 11)
    expect(result.pages[1].warning).toBeTruthy(); expect(result.pages[2].warning).toBeTruthy(); expect(result.pages[3].paragraphs[0].text).toBe("Last")
  })
  it("clones local navigation coordinates into the Reader compartment and falls back to the physical page", async () => {
    const parse = vi.fn(JSON.parse)
    const fixture = host(), navigate = vi.fn(), reader = { _iframeWindow: { wrappedJSObject: { JSON: { parse } } }, _internalReader: { navigate } }
    const open = vi.fn(async () => reader); Object.assign(fixture.zotero.Reader!, { open })
      await navigateDocument(fixture.zotero as never, document().source, { pageIndex: 1, rects: [[1, 2, 3, 4]] })
      expect(open).toHaveBeenCalledWith(11, { pageIndex: 1 }); expect(navigate).toHaveBeenCalledWith({ position: { pageIndex: 1, rects: [[1, 2, 3, 4]] } }, { behavior: "instant" })
      await navigateDocument(fixture.zotero as never, document().source, { pageIndex: 1 })
      expect(navigate).toHaveBeenLastCalledWith({ pageIndex: 1 }, { behavior: "instant" })
      expect(parse).toHaveBeenCalledTimes(4)
  })
  it("locates in the originating Reader when the same attachment is open in two windows", async () => {
    const fixture = host(), readerDocument = {} as Document, open = vi.fn(), navigate = vi.fn()
    Object.assign(fixture.zotero.Reader!, { open, _readers: [
      { itemID: 11, _iframeWindow: { document: {} }, navigate: vi.fn() },
      { itemID: 11, _iframeWindow: { document: readerDocument }, navigate },
    ] })
    await navigateDocument(fixture.zotero as never, document().source, { pageIndex: 1 }, readerDocument)
    expect(open).not.toHaveBeenCalled(); expect(navigate).toHaveBeenCalledWith({ pageIndex: 1 })
  })
  it("contains dead Reader windows while other PDFs remain usable", () => {
    expect(isLiveDocumentReader({ get _iframeWindow(): Window { throw new Error("can't access dead object") } })).toBe(false)
    expect(isLiveDocumentReader({ _iframeWindow: { closed: true } })).toBe(false)
    expect(isLiveDocumentReader({ _iframeWindow: { closed: false } })).toBe(true)
  })
})

describe("non-AI verification and static rows", () => {
  it("queries title without DOI, authors, year or Zotero translators and imports a DOI-less result", async () => {
    const entry = extractReferences(document())[0]
    entry.fields = { title: 'A book without DOI', authors: [], year: '' }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: { items: [null, { title: ['A book without DOI'], type: 'book', author: [{ family: 'Jones', given: 'K' }], issued: { 'date-parts': [[2021]] }, URL: 'https://publisher.example/book', future: true }] } })))
    await new ReferenceVerifier({}, fetchImpl).verify(entry)
    expect(entry.verification).toBe('verified')
    expect(entry.verified).toMatchObject({ title: 'A book without DOI', url: 'https://publisher.example/book', itemType: 'book', year: '2021' })
    expect(entry.verified?.doi).toBeUndefined()
    const saved = new Map<string, string>(), save = vi.fn(async () => {}), condition = vi.fn()
    const native = { Libraries: { get: () => ({ editable: true }) }, Search: class { libraryID = 1; addCondition = condition; async search() { return [] } }, Item: class { id = 8; key = 'BOOK0008'; libraryID = 1; setField(key: string, value: string) { saved.set(key, value) } setCreators() {} saveTx = save } }
    await importReference(native, entry, 1)
    expect(save).toHaveBeenCalledOnce(); expect(saved.get('url')).toBe('https://publisher.example/book'); expect(saved.has('DOI')).toBe(false)
    expect(condition).toHaveBeenCalledWith('title', 'contains', 'A book without DOI')
    const Item = vi.fn()
    const existing = { id: 9, key: 'EXISTING', libraryID: 1, getField: (key: string) => key === 'title' ? 'A BOOK WITHOUT DOI' : '' }
    const duplicateHost = { ...native, Item, Items: { get: () => existing }, Search: class { libraryID = 1; addCondition() {} async search() { return [9] } } }
    expect(await importReference(duplicateHost as never, entry, 1)).toEqual({ libraryID: 1, itemID: 9, itemKey: 'EXISTING' })
    expect(Item).not.toHaveBeenCalled()
  })
  it("falls back to direct DOI lookup when Zotero translators are absent, without sending credentials", async () => {
    const entry = extractReferences(document())[0]
    const fetchImpl = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ message: { title: ['Publisher title variant'], DOI: entry.fields.doi, author: [], published: { 'date-parts': [[2024]] } } })))
    const verifier = new ReferenceVerifier({}, fetchImpl as typeof fetch)
    await verifier.verify(entry)
    await verifier.verify(extractReferences(document())[0])
    expect(entry.verification).toBe('verified')
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(fetchImpl.mock.calls[0][0]).toBe('https://api.crossref.org/works/10.1234%2Fevidence')
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect(fetchImpl.mock.calls[0][1]?.headers).toBeUndefined()
  })
  it("contains lookup outages and cancellation without losing source or calling another server", async () => {
    const entry = extractReferences(document())[0], raw = entry.raw
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }))
    const verifier = new ReferenceVerifier({}, fetchImpl)
    await verifier.verify(entry)
    expect(entry.verification).toBe('unverified'); expect(entry.raw).toBe(raw)
    expect(fetchImpl.mock.calls.every(call => String(call[0]).startsWith('https://api.crossref.org/works'))).toBe(true)
    const controller = new AbortController(); controller.abort(); fetchImpl.mockClear()
    await expect(verifier.verify(entry, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it("looks up DOI without saving items or attachments and retains failed records", async () => {
    const entries = extractReferences(document())
    const translate = vi.fn(async () => [{ title: "Reliable scientific evidence", DOI: "10.1234/evidence", creators: [{ lastName: "Smith", creatorType: "author" }], date: "2020", future: true }])
    class Search { setIdentifier = vi.fn(); getTranslators = async () => [{}]; setTranslator = vi.fn(); translate = translate }
    const fetchImpl = vi.fn()
    await new ReferenceVerifier({ Translate: { Search } }, fetchImpl).verify(entries[0])
    expect(entries[0].verification).toBe("verified"); expect(translate).toHaveBeenCalledWith({ libraryID: false, saveAttachments: false }); expect(fetchImpl).not.toHaveBeenCalled()
    const original = entries[0].raw; entries[0].verification = "pending"
    await new ReferenceVerifier({}, fetchImpl).verify(entries[0])
    expect(entries).toHaveLength(1); expect(entries[0].raw).toBe(original); expect(entries[0].verification).toBe("unverified")
  })
  it("keeps unverified source navigation and search interactive without import", () => {
    const tags: string[] = []
    const buttons: Array<{ textContent: string; click?: () => void }> = []
    const doc = { createElementNS: (_ns: string, tag: string) => { tags.push(tag); const node = { textContent: "", dataset: {}, append() {}, className: "", click: undefined as (() => void) | undefined, addEventListener(_event: string, handler: () => void) { this.click = handler } }; if (tag === "button") buttons.push(node); return node } }
    const entry = extractReferences(document())[0]
    const locate = vi.fn(), open = vi.fn(), save = vi.fn()
    referenceRow(doc as never, entry, save, locate, open, vi.fn())
    buttons[0].click!(); buttons[1].click!()
    expect(locate).toHaveBeenCalledOnce(); expect(open.mock.calls[0][0]).toContain("https://search.crossref.org/")
    expect(tags).not.toContain("input"); expect(save).not.toHaveBeenCalled()
  })
  it("blocks direct imports of unverified entries before touching native constructors", async () => {
    const Item = vi.fn(); const entry = extractReferences(document())[0]
    await expect(importReference({ Item } as never, entry, 1)).rejects.toThrow()
    expect(Item).not.toHaveBeenCalled()
  })
  it("accepts one title candidate directly without requiring native verification, AI or writes", async () => {
    const entry = extractReferences(document([["References", citation.split(" https:")[0]]]))[0]
    const translate = vi.fn(async () => [{ title: entry.fields.title, DOI: "10.1234/found", date: "2020", creators: [{ lastName: "Smith" }] }])
    class Search { setIdentifier = vi.fn(); getTranslators = async () => [{}]; setTranslator = vi.fn(); translate = translate }
    const candidate = { title: [entry.fields.title], DOI: "10.1234/found", author: [{ family: "Smith" }], published: { "date-parts": [[2020]] } }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: { items: [candidate] } })))
    await new ReferenceVerifier({ Translate: { Search } }, fetchImpl).verify(entry)
    expect(entry.verification).toBe("verified"); expect(String(fetchImpl.mock.calls[0][0])).toContain("api.crossref.org"); expect(translate).not.toHaveBeenCalled()
    entry.verification = "pending"; translate.mockClear()
    fetchImpl.mockImplementation(async () => new Response(JSON.stringify({ message: { items: [candidate, { ...candidate, DOI: "10.1234/another" }] } })))
    await new ReferenceVerifier({ Translate: { Search } }, fetchImpl).verify(entry)
    expect(entry.verification).toBe("unverified"); expect(translate).not.toHaveBeenCalled()
  })
  it("never retries an uncertain native write and rejects read-only or foreign collection targets", async () => {
    const entry = extractReferences(document())[0]; entry.verification = "verified"; entry.verified = entry.fields; entry.importUncertain = true
    const Item = vi.fn()
    class Search { libraryID = 0; addCondition() {}; async search() { return [] } }
    const host = { Item, Search, Libraries: { get: () => ({ editable: true }) }, Collections: { get: () => ({ libraryID: 2 }) } }
    await expect(importReference(host as never, entry, 1)).rejects.toThrow(/uncertain|未确认/u)
    await expect(importReference(host as never, entry, 1, 9)).rejects.toThrow(/collection|分类/u)
    await expect(importReference({ ...host, Libraries: { get: () => ({ editable: false }) } } as never, entry, 1)).rejects.toThrow(/read-only|不可写/u)
    expect(Item).not.toHaveBeenCalled()
  })
})

describe("document jobs, durability and appearance", () => {
  it("splits oversized sentences losslessly at word and Unicode boundaries within budget", () => {
    for (const source of ["Whole sentence. Next sentence. ".repeat(100), "long words without punctuation ".repeat(100), "科学🧪".repeat(200)]) {
      const parts = splitTranslationText(source, 80)
      expect(parts.join("")).toBe(source)
      expect(parts.every(part => estimateTokens(part) <= 80)).toBe(true)
      expect(parts.every(part => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part))).toBe(true)
    }
  })
  it("runs deterministic references with zero model requests, even without AI configuration", async () => {
    const fixture = host(); const fetchImpl = vi.fn(); const { store } = memoryStore()
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, store)
    const task = await jobs.start("references", 11); await jobs.idle()
    const refs = await store.references(task.id)
    expect(fetchImpl.mock.calls.every(call => String(call[0]).startsWith("https://api.crossref.org/works"))).toBe(true)
    expect(refs).toHaveLength(1); expect(refs[0].raw).toBe(citation.replace("[1] ", "")); expect(refs[0].verification).toBe("unverified")
    jobs.dispose()
  })
  it("normalizes legacy stored reference labels without changing source lines", async () => {
    const { store } = memoryStore(), entry = extractReferences(document())[0]
    entry.raw = citation
    await store.saveReferences("00000000-0000-4000-8000-000000000001", [entry])
    const loaded = await store.references("00000000-0000-4000-8000-000000000001")
    expect(loaded[0].raw).toBe(citation.replace("[1] ", "")); expect(loaded[0].lines).toEqual(entry.lines)
  })
  it("edits and deletes one reference without changing its source locator", async () => {
    const fixture = host([["References", citation, "[2] Jones, K. (2021). Another study. Journal."]]), fetchImpl = vi.fn(), { store } = memoryStore()
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, store), task = await jobs.start("references", 11); await jobs.idle()
    const before = await store.references(task.id), sourceLines = before[0].lines, secondID = before[1].id
    expect(await jobs.updateReference(task.id, before[0].id, "Edited, J. (2024). Edited scientific evidence. Journal.")).toBe(true)
    const edited = (await store.references(task.id))[0]
    expect(edited).toMatchObject({ raw: "Edited, J. (2024). Edited scientific evidence. Journal.", verification: "unverified", edited: true })
    expect(edited.fields).toMatchObject({ title: "Edited scientific evidence", year: "2024" }); expect(edited.lines).toEqual(sourceLines)
    expect(await jobs.deleteReference(task.id, secondID)).toBe(true)
    expect(await store.references(task.id)).toHaveLength(1); expect(task.total).toBe(1); jobs.dispose()
  })
  it("preserves unknown fields but ignores conflicting IDs and never loses split source characters", () => {
    const source = "Hello 世界. ".repeat(150)
    expect(splitTranslationText(source, 80).join("")).toBe(source)
    expect(splitTranslationText(source, 80).length).toBeGreaterThan(1)
    const page = { translations: {} } as TranslationPage
    acceptTranslations(page, ["a", "b"], { translations: [{ id: "a", text: "one" }, { id: "a", text: "conflict" }, { id: "b", text: "two", future: true }, { id: "fake", text: "injected" }] })
    expect(page.translations).toEqual({ b: "two" })
  })
  it("normalizes font size and window style without touching unrelated settings", () => {
    const values = new Map<string, unknown>(); const host = { Prefs: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) } }
    expect(readFontSize(host)).toBe(13); saveFontSize(host, 99); expect(readFontSize(host)).toBe(24)
    values.set(FONT_SIZE_PREF, "broken"); expect(readFontSize(host)).toBe(13)
    saveTranslationStyle(host, "glass"); expect(readTranslationStyle(host)).toBe("glass")
    saveTranslationStyle(host, "future"); expect(readTranslationStyle(host)).toBe("default")
  })
  it("sends only the uncertain citation to AI and never calls AI during re-verification", async () => {
    const fixture = host([["Sensitive body must stay local.", "References", citation, "[2] Uncertain source", "continued"]], configured()), memory = memoryStore()
    const fetchImpl = vi.fn(async () => response({ references: [{ startLine: 0, endLine: 0, title: "Fabricated", DOI: "10.1234/fake" }] }))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("references", 11); await jobs.idle()
    const isCrossref = (call: typeof fetchImpl.mock.calls[number]) => String(call[0]).startsWith("https://api.crossref.org/works")
    const aiCalls = () => fetchImpl.mock.calls.filter(call => !isCrossref(call))
    expect(aiCalls()).toHaveLength(1)
    const sent = String(aiCalls()[0][1]?.body)
    expect(sent).toContain("Uncertain source"); expect(sent).not.toContain("Sensitive body"); expect(sent).not.toContain("Reliable scientific evidence")
    const entries = await memory.store.references(task.id)
    expect(entries).toHaveLength(2); expect(entries[1].raw).toContain("continued"); expect(entries[1].fields.doi).toBeUndefined()
    jobs.resume(task.id); await jobs.idle(); expect(aiCalls()).toHaveLength(1); jobs.dispose()
  })
  it("cancels only AI identification while preserving raw fragments and continuing deterministic verification", async () => {
    const fixture = host([["References", citation, "[2] Uncertain source"]], configured()), memory = memoryStore()
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => { jobs.skipReferenceAI(jobs.list("references")[0].id); if (options.signal?.aborted) throw new DOMException("cancelled", "AbortError"); return response({}) })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("references", 11); await jobs.idle(); await jobs.idle()
    expect(task.completed).toBe(2); expect((await memory.store.references(task.id)).map(row => row.raw)).toEqual([citation.replace("[1] ", ""), "Uncertain source"])
    const aiCalls = fetchImpl.mock.calls.filter(call => !String(call[0]).startsWith("https://api.crossref.org/works"))
    expect(aiCalls).toHaveLength(1); jobs.dispose()
  })

})
