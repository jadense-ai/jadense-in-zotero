/** 0.4.2 行为回归：完整来源覆盖、零 AI 常规引用、无副作用核验与恢复。 */
import { describe, it, expect, vi } from "vitest"
// 本文件验证文档调度；传输认领/磁盘/恢复在 reliable-temporary-chat.test.ts 独立使用真实客户端验证。
vi.mock('@/chat/reliable-temporary-chat', async () => ({ ReliableTemporaryChatClient: (await import('@/chat/temporary-chat')).TemporaryChatClient }))
vi.mock('@/chat/reliable-byok-chat', async () => ({ ReliableByokChatClient: (await import('@/chat/byok-chat')).ByokChatClient }))
import { extractReferences, applyReferenceSuggestion, metadataMatches, parseReferenceFields } from "@/chat/reference-list"
import { DocumentJobs, acceptTranslations, splitTranslationText } from "./document-jobs"
import { DocumentStore, type TaskIO, type TranslationPage } from "./document-store"
import { readTextDocument, textPage, orderColumnLines, validateDocument, navigateDocument, isLiveDocumentReader, type PdfTextDocument, type PdfLine } from "./pdf-document"
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
const configured = () => new Map<string, unknown>([["extensions.jadenseInZotero.token", "synthetic-only"], ['extensions.jadenseInZotero.referenceAIEnabled', true]])
function response(value: unknown) { return new Response(`data: ${JSON.stringify({ type: "text-delta", delta: JSON.stringify(value) })}\n\ndata: ${JSON.stringify({ type: "finish" })}\n\n`, { status: 200 }) }
function translateRequest(options: RequestInit) {
  const serialized = JSON.stringify(JSON.parse(String(options.body)))
  const ids = [...new Set(serialized.match(/p\d+-c\d+-\d+(?:[rs]\d+)*/gu))]
  return response({ translations: ids.map(id => ({ id, text: `译文 ${id}` })) })
}

describe("complete PDF and reference evidence", () => {
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
  it("copies a paper title only once even when copyright precedes it", async () => {
    const fixture = host([["Copyright notice", "Fixture", "A scientific paragraph."]], configured()), memory = memoryStore()
    const jobs = new DocumentJobs(fixture.zotero, vi.fn(async (_url, options) => translateRequest(options!)), memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle()
    const page = (await memory.store.page(task.id, 0))!
    const titlePiece = page.pieces.find(piece => piece.text === "Fixture")!
    page.translations[titlePiece.id] = "Translated duplicate title"
    await memory.store.savePage(task.id, page)
    const text = await jobs.copy(task.id)
    expect(text.startsWith("Fixture\n\n")).toBe(true)
    expect(text).not.toContain("Translated duplicate title")
    expect(text).toContain("译文"); jobs.dispose()
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
    expect(jobs.list()).toHaveLength(0)
    release(); await Promise.resolve(); await Promise.resolve()
    expect(jobs.list()).toHaveLength(0); jobs.dispose()
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
  it("requires matching bibliographic evidence rather than merely a resolving DOI", () => {
    const fields = parseReferenceFields(citation)
    expect(metadataMatches(fields, { ...fields, title: "Different paper" })).toBe(false)
    expect(metadataMatches(fields, { ...fields, authors: [] })).toBe(false)
    expect(metadataMatches(fields, { ...fields, title: fields.title.toUpperCase() })).toBe(true)
    expect(metadataMatches(fields, { ...fields, authors: ["Smith, K."] })).toBe(false)
    expect(metadataMatches({ ...fields, authors: ["Smith", "Jones"] }, { ...fields, authors: ["Smith", "Doe"] })).toBe(false)
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
  it("leaves unverified references without any controls, including raw URL text", () => {
    const tags: string[] = []
    const doc = { createElementNS: (_ns: string, tag: string) => { tags.push(tag); return { textContent: "", dataset: {}, append() {}, className: "" } } }
    const entry = extractReferences(document())[0]
    referenceRow(doc as never, entry, vi.fn(), vi.fn(), vi.fn(), vi.fn())
    expect(tags.every(tag => ["article", "p"].includes(tag))).toBe(true)
  })
  it("blocks direct imports of unverified entries before touching native constructors", async () => {
    const Item = vi.fn(); const entry = extractReferences(document())[0]
    await expect(importReference({ Item } as never, entry, 1)).rejects.toThrow()
    expect(Item).not.toHaveBeenCalled()
  })
  it("accepts one exact Crossref candidate only after native verification, without AI or writes", async () => {
    const entry = extractReferences(document([["References", citation.split(" https:")[0]]]))[0]
    const translate = vi.fn(async () => [{ title: entry.fields.title, DOI: "10.1234/found", date: "2020", creators: [{ lastName: "Smith" }] }])
    class Search { setIdentifier = vi.fn(); getTranslators = async () => [{}]; setTranslator = vi.fn(); translate = translate }
    const candidate = { title: [entry.fields.title], DOI: "10.1234/found", author: [{ family: "Smith" }], published: { "date-parts": [[2020]] } }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: { items: [candidate] } })))
    await new ReferenceVerifier({ Translate: { Search } }, fetchImpl).verify(entry)
    expect(entry.verification).toBe("verified"); expect(String(fetchImpl.mock.calls[0][0])).toContain("api.crossref.org")
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
  it("dispatches restored paragraphs without margin Article and retains the raw source on disk", async () => {
    const fixture = host([["unused"], ["unused"]], configured()), memory = memoryStore()
    for (let i = 0; i < 2; i++) Object.assign(fixture.view._pdfPages[i], {
      viewBox: [0, 0, 600, 800],
      chars: [["Article", 770], ["The complete scientific argument continues", 700], ["with all of its evidence and conclusion.", 686], [String(i + 1), 20]].flatMap(([line, y]) =>
        [...String(line)].map((c, j) => ({ c, rect: [30 + j * 5, Number(y), 35 + j * 5, Number(y) + 10], lineBreakAfter: j === String(line).length - 1, paragraphBreakAfter: j === String(line).length - 1 }))),
    })
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => translateRequest(options))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle()
    expect(task.total).toBe(2); expect(task.status).toBe("complete")
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[1].body)).not.toContain("Article")
      expect(String(call[1].body)).toContain("The complete scientific argument continues with all of its evidence and conclusion.")
    }
    const stored = await memory.reload().page(task.id, 0)
    expect(stored?.lines.map(line => line.text)).toContain("Article")
    expect(stored?.excludedLines).toHaveLength(2)
    expect(stored?.pieces).toHaveLength(1)
    jobs.dispose()
  })
  it("reduces context-error batches only between intact paragraphs and keeps every ID stable", async () => {
    const texts = ["First scientific paragraph. ".repeat(70).trim(), "Second scientific paragraph. ".repeat(70).trim()]
    const fixture = host([texts], configured()), memory = memoryStore()
    const prompts: Array<Array<{ id: string; text: string }>> = []
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => {
      const prompt = JSON.parse(String(options.body)).messages[0].parts[0].text
      const rows = JSON.parse(prompt.split("\n").at(-1)); prompts.push(rows)
      if (rows.length > 1) throw new Error("maximum context length exceeded")
      return response({ translations: rows.map((row: { id: string }) => ({ id: row.id, text: "完整译文" })) })
    })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle()
    expect(task.status).toBe("complete"); expect(task.total).toBe(2)
    expect(prompts.map(rows => rows.length)).toEqual([2, 1, 1])
    expect(prompts.flat().every(row => texts.includes(row.text))).toBe(true)
    expect((await memory.store.page(task.id, 0))?.pieces.map(piece => piece.id)).toEqual(prompts[0].map(row => row.id))
    jobs.dispose()
  })
  it("includes whole adjacent context and previous terminology without adding its IDs to the request", async () => {
    const fixture = host([["A complete preceding argument."], ["Methods"], ["It follows from that result."]], configured()), memory = memoryStore()
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => translateRequest(options))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle()
    const prompt = JSON.parse(String(fetchImpl.mock.calls[1][1].body)).messages[0].parts[0].text
    expect(prompt).toContain('"before":{"text":"A complete preceding argument.","translation":"译文 p0-c0-0"}')
    expect(JSON.parse(prompt.split("\n").at(-1))).toEqual([{ id: "p1-c0-0", text: "Methods" }, { id: "p2-c0-0", text: "It follows from that result." }])
    expect(task.status).toBe("complete"); jobs.dispose()
  })
  it("does not reuse legacy extraction while preserving its readable history", async () => {
    const fixture = host([["An intact paragraph."]], configured()), memory = memoryStore()
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => translateRequest(options))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const old = await jobs.start("translation", 11); await jobs.idle()
    delete old.extractionVersion; await memory.store.save(old)
    const current = await jobs.start("translation", 11); await jobs.idle()
    expect(current.id).not.toBe(old.id); expect(jobs.list("translation")).toHaveLength(2)
    expect(await jobs.copy(old.id)).toContain("译文")
    expect((await jobs.start("translation", 11)).id).toBe(current.id)
    expect(fetchImpl).toHaveBeenCalledTimes(2); jobs.dispose()
  })
  it("translates beyond 80 pages including the final page while marking a scanned page incomplete", async () => {
    const fixture = host(Array.from({ length: 83 }, (_, i) => i === 40 ? [] : [i === 82 ? "Last $x^2$" : `Page ${i}`]), configured()), memory = memoryStore()
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => translateRequest(options))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle()
    expect(task.totalPages).toBe(83); expect(task.completed).toBe(82); expect(task.status).toBe("partial")
    expect((await memory.store.page(task.id, 82))?.translations).toEqual({ "p82-c0-0": "译文 p82-c0-0" })
    expect(fetchImpl).toHaveBeenCalledTimes(2); jobs.dispose()
  })
  it("never splits a paragraph or retries an identical oversized paragraph on context errors", async () => {
    const text = "Very long scientific sentence. ".repeat(200), fixture = host([[text]], configured()), memory = memoryStore()
    const fetchImpl = vi.fn(async () => { throw new Error("maximum context length exceeded") })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle()
    expect(task.status).toBe("error"); expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((await memory.store.page(task.id, 0))?.pieces).toHaveLength(1)
    expect((await memory.store.page(task.id, 0))?.pieces.map(piece => piece.text).join("")).toBe(text.trim())
    jobs.dispose()
  })
  it("preserves valid IDs in a partial model reply and only re-requests omissions", async () => {
    const fixture = host([["First", "Second"]], configured()), memory = memoryStore()
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => translateRequest(options))
    fetchImpl.mockResolvedValueOnce(response({ translations: [{ id: "p0-c0-0", text: "第一段" }, { id: "unknown", text: "Fake" }] }))
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle(); expect(task.status).toBe("partial"); expect(task.completed).toBe(1)
    jobs.resume(task.id); await jobs.idle(); expect(task.status).toBe("complete")
    expect(String(fetchImpl.mock.calls[1][1].body)).not.toContain("p0-c0-0"); jobs.dispose()
  })
  it("runs deterministic references with zero model requests, even without AI configuration", async () => {
    const fixture = host(); const fetchImpl = vi.fn(); const { store } = memoryStore()
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl, store)
    const task = await jobs.start("references", 11); await jobs.idle()
    const refs = await store.references(task.id)
    expect(fetchImpl).not.toHaveBeenCalled(); expect(refs).toHaveLength(1); expect(refs[0].raw).toBe(citation); expect(refs[0].verification).toBe("unverified")
    jobs.dispose()
  })
  it("saves atomic pages, reloads a completed translation and never redispatches completed chunks", async () => {
    const prefs = new Map<string, unknown>([["extensions.jadenseInZotero.token", "synthetic-only"]])
    const fixture = host([["A scientific result."]], prefs), memory = memoryStore()
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => {
      const body = JSON.parse(String(options.body)); const serialized = JSON.stringify(body)
      const ids = [...serialized.matchAll(/p0-c0-0/gu)].map(() => "p0-c0-0")
      const result = JSON.stringify({ translations: [{ id: ids[0], text: "一个科学结果。" }], harmless: true })
      return new Response(`data: ${JSON.stringify({ type: "text-delta", delta: result })}\n\ndata: ${JSON.stringify({ type: "finish" })}\n\n`, { status: 200 })
    })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle()
    expect(task.status).toBe("complete"); expect(await jobs.copy(task.id)).toContain("一个科学结果")
    expect(memory.io.writeUTF8).toHaveBeenCalledWith(expect.stringMatching(/page-0.json$/u), expect.any(String), expect.objectContaining({ tmpPath: expect.stringMatching(/\.tmp$/u) }))
    jobs.dispose(); const reloaded = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.reload()); await reloaded.ready
    reloaded.resume(task.id); await reloaded.idle(); expect(fetchImpl).toHaveBeenCalledTimes(1)
    reloaded.dispose()
  })
  it("preserves unknown fields but ignores conflicting IDs and never loses split source characters", () => {
    const source = "Hello 世界. ".repeat(150)
    expect(splitTranslationText(source, 80)).toEqual([source])
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
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const sent = String(fetchImpl.mock.calls[0][1].body)
    expect(sent).toContain("Uncertain source"); expect(sent).not.toContain("Sensitive body"); expect(sent).not.toContain("Reliable scientific evidence")
    const entries = await memory.store.references(task.id)
    expect(entries).toHaveLength(2); expect(entries[1].raw).toContain("continued"); expect(entries[1].fields.doi).toBeUndefined()
    jobs.resume(task.id); await jobs.idle(); expect(fetchImpl).toHaveBeenCalledTimes(1); jobs.dispose()
  })
  it("cancels only AI identification while preserving raw fragments and continuing deterministic verification", async () => {
    const fixture = host([["References", citation, "[2] Uncertain source"]], configured()), memory = memoryStore()
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => { jobs.skipReferenceAI(jobs.list("references")[0].id); if (options.signal?.aborted) throw new DOMException("cancelled", "AbortError"); return response({}) })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("references", 11); await jobs.idle(); await jobs.idle()
    expect(task.completed).toBe(2); expect((await memory.store.references(task.id)).map(row => row.raw)).toEqual([citation, "[2] Uncertain source"])
    expect(fetchImpl).toHaveBeenCalledTimes(1); jobs.dispose()
  })
  it("retains prior chunks after a network error, resumes only missing work and blocks a replaced file", async () => {
    const fixture = host([["Introduction"], ["Methods"]], configured()), memory = memoryStore()
    let fail = true
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => { if (String(options.body).includes("p1-c0") && fail) throw new Error("offline"); return translateRequest(options) })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle()
    expect(task.status).toBe("error"); expect(task.completed).toBe(1)
    fail = false; jobs.resume(task.id); await jobs.idle(); expect(task.status).toBe("complete"); expect(fetchImpl).toHaveBeenCalledTimes(3)
    fixture.item.attachmentModificationTime = 43
    await expect(validateDocument(fixture.zotero as never, task.source)).rejects.toThrow()
    jobs.resume(task.id); await jobs.idle(); expect(task.status).toBe("error"); expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(await jobs.copy(task.id)).toContain("译文"); jobs.dispose()
  })
  it("keeps copyable session results after storage failure and isolates corrupt records", async () => {
    const fixture = host([["Result"]], configured()), memory = memoryStore()
    memory.io.writeUTF8 = vi.fn(async () => { throw new Error("disk full") })
    const jobs = new DocumentJobs(fixture.zotero, vi.fn(async (_url, options) => translateRequest(options)) as never, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle()
    expect(task.storageWarning).toBe(true); expect(await jobs.copy(task.id)).toContain("译文")
    const badID = crypto.randomUUID(); memory.files.set(`/fixture/jadense-document-tasks/${badID}/task.json`, "{broken")
    expect(await memory.store.list()).toHaveLength(1); jobs.dispose()
    memory.files.set(`/fixture/jadense-document-tasks/${badID}/task.json`, JSON.stringify({ ...task, id: badID, createdAt: undefined, completed: undefined, future: true }))
    const restored = await memory.reload().list()
    expect(restored[0]).toMatchObject({ createdAt: "1970-01-01T00:00:00.000Z", completed: 0 })
  })
  it("pauses through preference observers and restores interrupted tasks without automatic requests", async () => {
    const fixture = host([["Result"]], configured()), memory = memoryStore(), observers: Array<() => void> = []
    Object.assign(fixture.zotero.Prefs!, { registerObserver: (_key: string, callback: () => void) => { if (_key !== 'extensions.jadenseInZotero.referenceAIEnabled') observers.push(callback); return observers.length }, unregisterObserver: vi.fn() })
    const fetchImpl = vi.fn(async (_url: unknown, options: RequestInit) => { observers[0](); if (options.signal?.aborted) throw new DOMException("paused", "AbortError"); return translateRequest(options) })
    const jobs = new DocumentJobs(fixture.zotero, fetchImpl as never, memory.store)
    const task = await jobs.start("translation", 11); await jobs.idle(); expect(task.status).toBe("paused"); jobs.dispose()
    const nextFetch = vi.fn(); const reloaded = new DocumentJobs(fixture.zotero, nextFetch, memory.reload()); await reloaded.ready
    expect(reloaded.get(task.id)?.status).toBe("paused"); expect(nextFetch).not.toHaveBeenCalled(); reloaded.dispose()
  })
})
