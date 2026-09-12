import { openChatSidebar } from './reader-sidebar'
vi.mock('./reader-sidebar', () => ({ openChatSidebar: vi.fn(async () => {}), removeReaderDock: vi.fn() }))
// 合成 Zotero 9 阅读器契约测试，不读取真实文库；验证坐标绑定、写入隔离和原生工具条生命周期。
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { initializeUiLocale, saveTheme, THEME_PREF, DISPLAY_LANGUAGE_PREF } from "./ui-preferences"
beforeEach(() => { initializeUiLocale({ locale: "zh-CN" }); vi.mocked(openChatSidebar).mockReset().mockResolvedValue(undefined) })
import { readArticleTranslationLanguages, writeArticleTranslationLanguages } from "./translation-settings"
import {
  readPdfForAnalysis,
  registerReaderTools,
  saveAnalysisAnnotations,
  type PdfAnalysisSnapshot,
  type ZoteroReaderHost,
} from "./reader-tools"

function page(text: string) {
  const chars: Array<{
    c: string; rect: number[]; inlineRect: number[]; spaceAfter?: boolean;
    lineBreakAfter?: boolean; paragraphBreakAfter?: boolean; ignorable?: boolean;
  }> = []
  let x = 20
  let y = 180
  for (const c of text) {
    if (c === " " && chars.length) { chars.at(-1)!.spaceAfter = true; x += 5; continue }
    if (c === "\n" && chars.length) { chars.at(-1)!.lineBreakAfter = true; x = 20; y -= 20; continue }
    chars.push({ c, rect: [x, y, x + 5, y + 10], inlineRect: [x, y, x + 5, y + 10] })
    x += 5
  }
  if (chars.length) chars.at(-1)!.paragraphBreakAfter = true
  return { chars, viewBox: [0, 0, 600, 800] }
}

function host(pages = [page("Our method reduces error. This result requires controlled conditions.")]) {
  const annotationItems: Array<{
    annotationText: string; annotationPosition: string; getTags: () => Array<{ tag: string }>;
  }> = []
  const keys = new Map<string, unknown>()
  const item = {
    id: 11, key: "PDFKEY11", libraryID: 2, deleted: false,
    parentItem: undefined as {
      getField?: (field: string) => unknown
      getCreators?: () => unknown
    } | undefined,
    attachmentModificationTime: 100,
    getField: () => "Synthetic paper",
    isPDFAttachment: () => true,
    isEditable: vi.fn(() => true),
    getAnnotations: () => annotationItems,
  }
  const pdf = {
    numPages: pages.length,
    getPageData: vi.fn(async ({ pageIndex }: { pageIndex: number }) => pages[pageIndex]),
    getPageLabels: vi.fn(async () => pages.map((_, index) => `S${index + 1}`)),
  }
  const pdfPages: Record<number, ReturnType<typeof page>> = {}
  const reader = {
    itemID: item.id,
    _initPromise: Promise.resolve(),
    _internalReader: {
      _lastViewPrimary: true,
      _state: {} as {
        primaryViewSelectionPopup?: { annotation: { text: string; pageLabel: string; position: { pageIndex: number } } } | null;
        secondaryViewSelectionPopup?: { annotation: { text: string; pageLabel: string; position: { pageIndex: number } } } | null;
      },
      _primaryView: {
        initializedPromise: Promise.resolve(),
        _pdfPages: pdfPages,
        _ensureBasicPageData: vi.fn(async (pageIndex: number) => {
          if (!pdfPages[pageIndex]) pdfPages[pageIndex] = await pdf.getPageData({ pageIndex })
        }),
        _iframeWindow: { PDFViewerApplication: { pdfDocument: pdf } },
      },
    },
  }
  let nextKey = 0
  const saveFromJSON = vi.fn(async (_item: unknown, json: Record<string, unknown>) => {
    const saved = {
      annotationText: json.text as string,
      annotationPosition: JSON.stringify(json.position),
      getTags: () => (json.tags as Array<{ name: string }>).map(({ name }) => ({ tag: name })),
    }
    annotationItems.push(saved)
    keys.set(json.key as string, saved)
    return saved
  })
  const zotero: ZoteroReaderHost = {
    locale: "zh-CN",
    Items: { get: vi.fn(() => item), getByLibraryAndKey: vi.fn((_library, key) => keys.get(key)) },
    Reader: { _readers: [reader] },
    Annotations: { saveFromJSON },
    DataObjectUtilities: { generateKey: () => `A${String(++nextKey).padStart(7, "0")}` },
  }
  return { zotero, item, pdf, reader, annotationItems, keys, saveFromJSON }
}

function suggestion(snapshot: PdfAnalysisSnapshot) {
  return { passageId: snapshot.passages[0].id, category: "claim" as const, comment: "论点由对照实验支持。" }
}

describe("Zotero PDF analysis snapshot", () => {
  it("uses native page cache and keeps exact multibyte text, page labels and line rectangles", async () => {
    const source = page("A novel ﬁnding supports\nthe measured effect. 后续研究仍需验证此结论。")
    const fixture = host([source])
    const progress = vi.fn()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11, { onProgress: progress })

    expect(fixture.pdf.getPageData).toHaveBeenCalledWith({ pageIndex: 0 })
    expect(fixture.reader._internalReader._primaryView._ensureBasicPageData).toHaveBeenCalledWith(0)
    expect(snapshot.passages.map((passage) => passage.text)).toEqual([
      "A novel ﬁnding supports the measured effect.", "后续研究仍需验证此结论。",
    ])
    expect(snapshot.passages[0]).toMatchObject({ id: "p1-c0", pageIndex: 0, pageLabel: "S1" })
    expect(snapshot.passages[0].position.rects).toHaveLength(2)
    expect(snapshot.passages[0].position.rects[0]).toEqual([20, 180, 135, 190])
    expect(snapshot.passages[0].sortIndex).toBe("00000|000000|00610")
    expect(snapshot).toMatchObject({ itemID: 11, itemKey: "PDFKEY11", libraryID: 2, attachmentModificationTime: 100 })
    expect(progress).toHaveBeenLastCalledWith({ pagesRead: 1, totalPages: 1 })
    expect(fixture.saveFromJSON).not.toHaveBeenCalled()
  })

  it("reads structured metadata from the bibliographic parent while retaining attachment identity", async () => {
    const fixture = host()
    fixture.item.parentItem = {
      getField: (field) => ({
        title: "Parent study",
        date: "2025-11-03",
        publicationTitle: "Journal of Local Evidence",
        DOI: "10.1000/example",
      })[field] ?? "",
      getCreators: () => [
        { firstName: "Ada", lastName: "Lovelace" },
        { name: "Research Collective" },
      ],
    }

    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)

    expect(snapshot).toMatchObject({ itemID: 11, libraryID: 2, itemKey: "PDFKEY11", title: "Parent study" })
    expect(snapshot.metadata).toEqual({
      title: "Parent study",
      authors: ["Ada Lovelace", "Research Collective"],
      date: "2025-11-03",
      year: "2025",
      publicationTitle: "Journal of Local Evidence",
      doi: "10.1000/example",
    })
  })

  it("keeps analysis available when optional parent metadata cannot be read", async () => {
    const fixture = host()
    fixture.item.parentItem = {
      getField: () => { throw new Error("metadata unavailable") },
      getCreators: () => { throw new Error("creators unavailable") },
    }

    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)

    expect(snapshot.metadata).toEqual({ title: "Synthetic paper", authors: [] })
    expect(snapshot.passages).not.toHaveLength(0)
  })

  it("uses primitive page indexes across Gecko compartments instead of passing plugin objects to the PDF worker", async () => {
    const source = page("A native reader frame owns its worker request.")
    const fixture = host([source])
    const view = fixture.reader._internalReader._primaryView
    fixture.pdf.getPageData.mockRejectedValue(new Error("DataCloneError: plugin objects cannot be cloned"))
    view._ensureBasicPageData.mockImplementation(async (pageIndex) => { view._pdfPages[pageIndex] = source })
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    expect(snapshot.passages[0].text).toBe("A native reader frame owns its worker request.")
    expect(view._ensureBasicPageData).toHaveBeenCalledWith(0)
    expect(fixture.pdf.getPageData).not.toHaveBeenCalled()
  })

  it("does not invent highlights for scanned or coordinate-free PDFs", async () => {
    const scanned = host([page("")])
    await expect(readPdfForAnalysis(scanned.zotero, 11)).rejects.toThrow(/OCR/)
    const noCoordinates = page("The PDF has text without valid geometry.")
    noCoordinates.chars[4].rect = [0, 0, 0, 0]
    noCoordinates.chars[4].inlineRect = [0, 0, 0, 0]
    await expect(readPdfForAnalysis(host([noCoordinates]).zotero, 11)).rejects.toThrow(/原句/)
    expect(scanned.saveFromJSON).not.toHaveBeenCalled()
  })

  it("continues after a failed page or progress callback, and explicitly reports incomplete text coverage", async () => {
    const fixture = host([page("An initial finding is supported."), page(""), page("A later conclusion needs replication.")])
    fixture.pdf.getPageData.mockRejectedValueOnce(new Error("page unavailable"))
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11, { onProgress: () => { throw new Error("optional UI") } })
    expect(snapshot.passages.map((passage) => passage.pageIndex)).toEqual([2])
    expect(snapshot.coverage).toMatchObject({ pagesRead: 2, totalPages: 3, limited: true, pageNumbers: [2, 3] })
    expect(snapshot.coverage.warnings.join(" ")).toContain("第 1 页")
    expect(snapshot.coverage.warnings.join(" ")).toContain("第 2 页")
  })

  it("bounds long documents without silently dropping the final conclusions", async () => {
    const fixture = host(Array.from({ length: 96 }, (_, index) => page(`This is a supported sentence from physical page ${index + 1}.`)))
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    expect(fixture.pdf.getPageData).toHaveBeenCalledTimes(80)
    expect(snapshot.passages[0].pageIndex).toBe(0)
    expect(snapshot.passages.at(-1)!.pageIndex).toBe(95)
    expect(snapshot.coverage).toMatchObject({ pagesRead: 80, totalPages: 96, limited: true })
    expect(snapshot.coverage.warnings.join(" ")).toContain("未读取全部正文")
  })

  it("stops promptly while native extraction is pending", async () => {
    const fixture = host()
    const controller = new AbortController()
    fixture.pdf.getPageData.mockImplementation(() => new Promise(() => undefined))
    const pending = readPdfForAnalysis(fixture.zotero, 11, { signal: controller.signal })
    await vi.waitFor(() => expect(fixture.pdf.getPageData).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("does not stamp coordinates from a PDF changed during extraction as a new snapshot", async () => {
    const fixture = host()
    fixture.pdf.getPageData.mockImplementationOnce(async () => {
      fixture.item.attachmentModificationTime = 101
      return page("A replacement file has different coordinates.")
    })
    await expect(readPdfForAnalysis(fixture.zotero, 11)).rejects.toThrow(/读取期间已更改/)
  })
})

describe("append-only native analysis annotations", () => {
  it("writes only snapshot geometry and escapes model markup at the rich-text seam", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    const untrusted = {
      ...suggestion(snapshot), comment: '<img src=x onerror="attack()"> & evidence',
      itemID: 999, libraryID: 999, key: "OLDKEY01", position: { pageIndex: 999, rects: [[0, 0, 99, 99]] },
      text: "fabricated quote", extraFutureField: true,
    }
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, [untrusted])
    expect(result).toMatchObject({ created: 1, skipped: 0, warnings: [] })
    expect(fixture.saveFromJSON).toHaveBeenCalledWith(fixture.item, expect.objectContaining({
      type: "highlight", text: snapshot.passages[0].text, position: snapshot.passages[0].position,
      comment: '【核心论点】\n&lt;img src=x onerror="attack()"&gt; &amp; evidence',
      tags: [{ name: "Jadense AI" }, { name: "Jadense AI/claim" }, { name: "核心论点" }],
    }))
    expect(fixture.saveFromJSON.mock.calls[0][1]).not.toHaveProperty("itemID")
    expect(fixture.saveFromJSON.mock.calls[0][1].key).not.toBe("OLDKEY01")
  })

  it("serializes concurrent saves, skips duplicates on rerun and never touches manual annotations", async () => {
    const fixture = host()
    const manual = { annotationText: "User highlight", annotationPosition: "{}", getTags: () => [] }
    fixture.annotationItems.push(manual)
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    const annotations = [suggestion(snapshot), suggestion(snapshot)]
    const [first, second] = await Promise.all([
      saveAnalysisAnnotations(fixture.zotero, snapshot, annotations),
      saveAnalysisAnnotations(fixture.zotero, snapshot, annotations),
    ])
    expect(first).toMatchObject({ created: 1, skipped: 1 })
    expect(second).toMatchObject({ created: 0, skipped: 2 })
    expect(fixture.saveFromJSON).toHaveBeenCalledOnce()
    expect(fixture.annotationItems[0]).toBe(manual)
  })

  it("revalidates attachment ownership, editability and file version before writing", async () => {
    for (const change of ["key", "libraryID", "editable", "file"] as const) {
      const fixture = host()
      const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
      if (change === "key") fixture.item.key = "OTHERPDF"
      if (change === "libraryID") fixture.item.libraryID = 9
      if (change === "editable") fixture.item.isEditable.mockReturnValue(false)
      if (change === "file") fixture.item.attachmentModificationTime = 101
      await expect(saveAnalysisAnnotations(fixture.zotero, snapshot, [suggestion(snapshot)])).rejects.toThrow(/已|不可/)
      expect(fixture.saveFromJSON).not.toHaveBeenCalled()
    }
  })

  it("skips a generated key collision rather than letting saveFromJSON overwrite an existing item", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    fixture.keys.set("A0000001", { isRegularItem: true })
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, [suggestion(snapshot)])
    expect(result).toMatchObject({ created: 0, skipped: 1 })
    expect(result.warnings.join(" ")).toContain("冲突")
    expect(fixture.saveFromJSON).not.toHaveBeenCalled()
  })

  it("contains unknown passage suggestions and partial save failures to individual annotations", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    fixture.saveFromJSON.mockRejectedValueOnce(new Error("native save failed"))
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, [
      { ...suggestion(snapshot), passageId: "not-from-this-document" },
      suggestion(snapshot),
      { ...suggestion(snapshot), passageId: snapshot.passages[1].id },
    ])
    expect(result).toMatchObject({ created: 1, skipped: 1, failed: 1, unprocessed: 0 })
    expect(result.warnings.join(" ")).toContain("未确认保存")
    expect(fixture.saveFromJSON).toHaveBeenCalledTimes(2)
  })

  it("keeps valid suggestions before and after malformed individual rows", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    const malformed = [null, { ...suggestion(snapshot), comment: 42 }]
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, [
      suggestion(snapshot),
      ...malformed as unknown as ReturnType<typeof suggestion>[],
      { ...suggestion(snapshot), passageId: snapshot.passages[1].id },
    ])
    expect(result).toMatchObject({ created: 2, skipped: 2, failed: 0, unprocessed: 0 })
    expect(fixture.annotationItems).toHaveLength(2)
  })

  it("isolates missing local geometry without accepting model-supplied coordinates", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    Object.assign(snapshot.passages[0], { position: null })
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, [
      { ...suggestion(snapshot), position: { pageIndex: 0, rects: [[0, 0, 10, 10]] } },
      { ...suggestion(snapshot), passageId: snapshot.passages[1].id },
    ] as ReturnType<typeof suggestion>[])
    expect(result).toMatchObject({ created: 1, skipped: 1, failed: 0, unprocessed: 0 })
    expect(fixture.saveFromJSON.mock.calls[0][1].text).toBe(snapshot.passages[1].text)
  })

  it.each(["key", "lookup"])("preserves successful counts and continues after a %s preparation failure", async (failure) => {
    const fixture = host([page("Our method reduces error. This result requires controlled conditions. Further study should expand the sample.")])
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    if (failure === "key") {
      fixture.zotero.DataObjectUtilities!.generateKey = vi.fn()
        .mockReturnValueOnce("A0000001").mockImplementationOnce(() => { throw new Error("key unavailable") })
        .mockReturnValueOnce("A0000003")
    } else {
      fixture.zotero.Items!.getByLibraryAndKey = vi.fn()
        .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("lookup unavailable"))
        .mockResolvedValueOnce(undefined)
    }
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, snapshot.passages.map((passage) => ({
      ...suggestion(snapshot), passageId: passage.id,
    })))
    expect(result).toMatchObject({ created: 2, skipped: 0, failed: 1, unprocessed: 0 })
    expect(result.warnings.join(" ")).toContain("未开始写入")
    expect(fixture.saveFromJSON).toHaveBeenCalledTimes(2)
  })

  it("ignores damaged historical tags while retaining healthy duplicate detection", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    await saveAnalysisAnnotations(fixture.zotero, snapshot, [suggestion(snapshot)])
    fixture.annotationItems.unshift({
      annotationText: "Damaged unrelated annotation", annotationPosition: "{}",
      getTags: () => { throw new Error("unreadable annotation") },
    })
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, snapshot.passages.map((passage) => ({
      ...suggestion(snapshot), passageId: passage.id,
    })))
    expect(result).toMatchObject({ created: 1, skipped: 1, failed: 0, unprocessed: 0 })
    expect(fixture.annotationItems).toHaveLength(3)
  })

  it("does not retry a duplicate suggestion when native persistence succeeds but its acknowledgment fails", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    const save = fixture.saveFromJSON.getMockImplementation()!
    fixture.saveFromJSON.mockImplementationOnce(async (item, json) => {
      await save(item, json)
      throw new Error("native acknowledgment failed")
    })
    const annotations = [suggestion(snapshot), suggestion(snapshot), {
      ...suggestion(snapshot), passageId: snapshot.passages[1].id,
    }]
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, annotations)
    expect(result).toMatchObject({ created: 1, skipped: 1, failed: 1, unprocessed: 0 })
    expect(fixture.saveFromJSON).toHaveBeenCalledTimes(2)
    expect(fixture.annotationItems).toHaveLength(2)
    const rerun = await saveAnalysisAnnotations(fixture.zotero, snapshot, annotations)
    expect(rerun).toMatchObject({ created: 0, skipped: 3, failed: 0, unprocessed: 0 })
    expect(fixture.saveFromJSON).toHaveBeenCalledTimes(2)
  })

  it("revalidates the file after the asynchronous key collision check", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    fixture.zotero.Items!.getByLibraryAndKey = vi.fn(async () => {
      fixture.item.attachmentModificationTime = 101
      return undefined
    })
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, [suggestion(snapshot)])
    expect(result).toMatchObject({ created: 0, skipped: 0, failed: 0, unprocessed: 1 })
    expect(fixture.saveFromJSON).not.toHaveBeenCalled()
    expect(result.warnings.join(" ")).toContain("文件在解析期间已更改")
  })

  it("preserves prior saves on cancellation and stops before the next write", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    const controller = new AbortController()
    fixture.saveFromJSON.mockImplementationOnce(async () => { controller.abort(); return {} })
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, snapshot.passages.map((passage) => ({
      ...suggestion(snapshot), passageId: passage.id,
    })), { signal: controller.signal })
    expect(result.created).toBe(1)
    expect(result.unprocessed).toBe(1)
    expect(result.warnings.join(" ")).toContain("已停止")
    expect(fixture.saveFromJSON).toHaveBeenCalledOnce()
    await expect(saveAnalysisAnnotations(fixture.zotero, snapshot, [suggestion(snapshot)], { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" })
  })

  it("reports unprocessed suggestions after permissions change between saves", async () => {
    const fixture = host()
    const snapshot = await readPdfForAnalysis(fixture.zotero, 11)
    fixture.saveFromJSON.mockImplementationOnce(async () => { fixture.item.isEditable.mockReturnValue(false); return {} })
    const result = await saveAnalysisAnnotations(fixture.zotero, snapshot, snapshot.passages.map((passage) => ({
      ...suggestion(snapshot), passageId: passage.id,
    })))
    expect(result).toMatchObject({ created: 1, failed: 0, skipped: 0, unprocessed: 1 })
    expect(result.warnings.join(" ")).toContain("不可编辑")
    expect(result.warnings.join(" ")).toContain("1 条建议尚未处理")
    expect(fixture.saveFromJSON).toHaveBeenCalledOnce()
  })
})

class ElementStub {
  children: ElementStub[] = []
  attributes = new Map<string, string>()
  handlers = new Map<string, (event?: { key?: string; preventDefault?: () => void }) => void>()
  style = { cssText: "", left: "", top: "", right: "", width: "", height: "", colorScheme: "" }
  dataset: Record<string, string> = {}
  className = ""
  title = ""
  textContent = ""
  hidden = false
  value = ""
  disabled = false
  isConnected = true
  parent?: ElementStub
  constructor(readonly ownerDocument: DocumentStub, readonly tagName: string) {}
  remove = vi.fn(() => {
    this.isConnected = false
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this)
  })
  setAttribute(key: string, value: string) { this.attributes.set(key, value) }
  getAttribute(key: string) { return this.attributes.get(key) ?? null }
  removeAttribute(key: string) { this.attributes.delete(key) }
  contains(node: ElementStub): boolean { return node === this || this.children.some(child => child.contains(node)) }
  addEventListener(event: string, handler: () => void) { this.handlers.set(event, handler) }
  removeEventListener(name: string) { this.handlers.delete(name) }
  focus() { this.ownerDocument.activeElement = this }
  closest() { return null }
  querySelectorAll(selector: string) { return descendants(this).filter(node => selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1)) : node.tagName === selector) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] }
  getBoundingClientRect() { return { left: 700, top: 5, bottom: 33, width: 170, height: 28, right: 870 } }
  append(...children: ElementStub[]) {
    for (const child of children) {
      if (child.parent) child.parent.children = child.parent.children.filter((node) => node !== child)
      child.parent = this; this.children.push(child)
    }
  }
}

class DocumentStub {
  activeElement: ElementStub | null = null
  head = new ElementStub(this, "head")
  body = new ElementStub(this, "body")
  handlers = new Map<string, (event: { key: string }) => void>()
  windowHandlers = new Map<string, () => void>()
  clipboardWrite = vi.fn()
  defaultView = {
    innerWidth: 800, innerHeight: 600,
    navigator: { clipboard: { writeText: this.clipboardWrite } },
    addEventListener: (name: string, listener: () => void) => this.windowHandlers.set(name, listener),
    removeEventListener: (name: string) => this.windowHandlers.delete(name),
  }
  getElementById(id: string) { return [...descendants(this.head), ...descendants(this.body)].find(node => (node as ElementStub & { id?: string }).id === id) }
  createElement(tagName: string) { return new ElementStub(this, tagName) }
  createElementNS(_namespace: string, tagName: string) { return this.createElement(tagName) }
  addEventListener(name: string, handler: (event: { key: string }) => void) { this.handlers.set(name, handler) }
  removeEventListener(name: string) { this.handlers.delete(name) }
}

function actionButtons(group: ElementStub): ElementStub[] {
  return descendants(group).filter((child) => child.attributes.has("data-jadense-action"))
}

function descendants(element: ElementStub): ElementStub[] {
  return element.children.flatMap((child) => [child, ...descendants(child)])
}

describe("native reader toolbars", () => {
  it("uses the selected UI language and updates only plugin surfaces when theme preferences change", async () => {
    const fixture = host()
    const values = new Map<string, unknown>([[DISPLAY_LANGUAGE_PREF, "en-US"], [THEME_PREF, "dark"]])
    const observers = new Map<number, { key: string; update: () => void }>()
    let observerID = 0
    fixture.zotero.Prefs = {
      get: key => values.get(key),
      set: (key, value) => {
        values.set(key, value)
        for (const entry of observers.values()) if (entry.key === key) entry.update()
      },
      registerObserver: (key, update) => { observers.set(++observerID, { key, update }); return observerID },
      unregisterObserver: id => { observers.delete(id as number) },
    }
    const register = vi.fn()
    fixture.zotero.Reader!.registerEventListener = register
    const onAction = vi.fn(async () => ({ translation: "原样保留的 AI 译文" }))
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
    const doc = new DocumentStub()
    const append = vi.fn((node: ElementStub) => doc.body.append(node))
    register.mock.calls[0][1]({ reader: fixture.reader, doc, append })
    const toolbar = append.mock.calls[0][0]
    const panel = doc.body.children.find(node => node.attributes.has("data-jadense-translation-panel"))!
    const notice = doc.body.children.find(node => node.attributes.has("data-jadense-reader-notice"))!
    const source = descendants(panel).find(node => node.attributes.get("aria-label") === "Selection source language")!
    expect(actionButtons(toolbar).map(node => node.attributes.get("aria-label"))).toEqual([
      "Start a new AI chat about this document", "Analyze document", "Quote selection", "Full translation",
    ])
    expect(source.children.find(node => node.value === "en")?.textContent).toBe("English")
    expect(panel.attributes.get("aria-label")).toBe("AI translation result")
    actionButtons(toolbar)[2].handlers.get("click")!()
    expect(notice.textContent).toContain("Select text in the document")
    expect([toolbar, panel, notice].map(node => node.dataset.theme)).toEqual(["dark", "dark", "dark"])
    fixture.zotero.Prefs.set!("browser.theme.toolbar-theme", 1)
    expect(toolbar.dataset.theme).toBe("dark")
    saveTheme(fixture.zotero, "system")
    expect([toolbar, panel, notice].every(node => node.dataset.theme === "light")).toBe(true)
    fixture.zotero.Prefs.set!("browser.theme.toolbar-theme", 0)
    expect([toolbar, panel, notice].every(node => node.dataset.theme === "dark")).toBe(true)
    saveTheme(fixture.zotero, "light")
    expect(toolbar.dataset.theme).toBe("light")
    expect(doc.body.dataset.theme).toBeUndefined()
    expect(doc.head.dataset.theme).toBeUndefined()
    register.mock.calls[1][1]({
      reader: fixture.reader, doc, append,
      params: { annotation: { text: "未经改写的中文原文", position: { pageIndex: 0 }, pageLabel: "1" } },
    })
    actionButtons(append.mock.calls[1][0])[0].handlers.get("click")!()
    await vi.waitFor(() => expect(panel.children[1].children[3].textContent).toBe("原样保留的 AI 译文"))
    expect(panel.children[1].children[1].textContent).toBe("未经改写的中文原文")
    cleanup()
    expect(observers.size).toBe(0)
  })

  it("collapses all actions into one accessible menu and dismisses without changing selection actions", async () => {
    const fixture = host(), register = vi.fn(), onAction = vi.fn(), doc = new DocumentStub()
    fixture.zotero.Reader!.registerEventListener = register
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
    const append = vi.fn((node: ElementStub) => doc.body.append(node))
    register.mock.calls[0][1]({ reader: fixture.reader, doc, append })
    const toolbar = append.mock.calls[0][0]
    const toggle = descendants(toolbar).find(node => node.className === "jadense-reader-actions-toggle")!
    expect(toolbar.attributes.get("data-compact")).toBe("true")
    expect(toggle.attributes.get("aria-haspopup")).toBe("menu")
    expect(descendants(toolbar).some(node => node.attributes.has("data-jadense-article-languages"))).toBe(false)
    const preserveSelection = vi.fn()
    toggle.handlers.get("mousedown")!({ preventDefault: preserveSelection })
    expect(preserveSelection).toHaveBeenCalledOnce()
    toggle.handlers.get("click")!({ detail: 1 })
    expect(toggle.attributes.get("aria-expanded")).toBe("true")
    expect(doc.activeElement).toBeNull()
    toggle.handlers.get("click")!({ detail: 1 })
    toggle.handlers.get("click")!()
    const menu = doc.body.children.find(node => node.attributes.has("data-jadense-action-menu"))!
    expect(menu.attributes.get("role")).toBe("menu")
    expect(actionButtons(menu).map(node => node.attributes.get("data-jadense-action"))).toEqual(["attach", "analyze", "quote", "fullTranslate"])
    expect(doc.activeElement).toBe(actionButtons(menu)[0])
    menu.handlers.get("keydown")!({ key: "End", preventDefault: vi.fn() })
    expect(doc.activeElement).toBe(actionButtons(menu).at(-1))
    doc.handlers.get("keydown")!({ key: "Escape" })
    expect(toggle.attributes.get("aria-expanded")).toBe("false")
    expect(doc.activeElement).toBe(toggle)
    expect(menu.parent).toBe(toolbar)
    toggle.handlers.get("click")!()
    actionButtons(menu)[0].handlers.get("click")!()
    await Promise.resolve()
    expect(openChatSidebar).toHaveBeenCalledWith(fixture.zotero, doc, 11, fixture.reader)
    expect(toggle.attributes.get("aria-expanded")).toBe("false")
    let expandedWidth = 1800
    const nativeToolbar = {
      clientWidth: 1600,
      get scrollWidth() { return toolbar.attributes.get("data-compact") === "true" ? 1550 : expandedWidth },
    }
    toolbar.closest = () => nativeToolbar
    doc.defaultView.innerWidth = 1600
    doc.windowHandlers.get("resize")!()
    expect(toolbar.attributes.get("data-compact")).toBe("true")
    doc.windowHandlers.get("resize")!()
    expect(toolbar.attributes.get("data-compact")).toBe("true")
    toggle.handlers.get("click")!()
    const focused = actionButtons(menu)[2]
    focused.focus()
    expandedWidth = 1580
    doc.windowHandlers.get("resize")!()
    expect(toolbar.attributes.get("data-compact")).toBe("false")
    expect(doc.activeElement).toBe(focused)
    doc.defaultView.innerWidth = 1200
    doc.windowHandlers.get("resize")!()
    expect(doc.activeElement).toBe(toggle)
    cleanup()
    expect(doc.handlers.size).toBe(0)
    expect(doc.windowHandlers.size).toBe(0)
  })

  it("retains saved article languages while sentence overrides retain the source snapshot and fence stale results", async () => {
    const fixture = host()
    const values = new Map<string, unknown>()
    fixture.zotero.Prefs = { get: (key) => values.get(key), set: (key, value) => { values.set(key, value) } }
    const register = vi.fn()
    fixture.zotero.Reader!.registerEventListener = register
    const pending: Array<{ finish: (result: { translation: string }) => void; delta?: (text: string) => void }> = []
    const onAction = vi.fn((_action: unknown, hooks?: { onTranslationText?: (text: string) => void }) =>
      new Promise<{ translation: string }>((finish) => pending.push({ finish, delta: hooks?.onTranslationText })))
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
    const doc = new DocumentStub()
    const append = vi.fn((node: ElementStub) => doc.body.append(node))
    const toolbarEvent = { reader: fixture.reader, doc, append }
    try {
      register.mock.calls[0][1](toolbarEvent)
      await writeArticleTranslationLanguages(fixture.zotero, 11, { sourceLanguage: "fr", targetLanguage: "de" })
      expect(await readArticleTranslationLanguages(fixture.zotero, 11)).toEqual({ sourceLanguage: "fr", targetLanguage: "de" })

      fixture.reader._internalReader._state.primaryViewSelectionPopup = {
        annotation: { text: "Original sentence", pageLabel: "S2", position: { pageIndex: 1 } },
      }
      register.mock.calls[1][1](toolbarEvent)
      actionButtons(append.mock.calls[1][0])[0].handlers.get("click")!()
      await vi.waitFor(() => expect(pending).toHaveLength(1))
      expect(onAction.mock.calls[0][0]).toMatchObject({ languages: { sourceLanguage: "fr", targetLanguage: "de" } })
      const panel = doc.body.children.find((node) => node.attributes.has("data-jadense-translation-panel"))!
      const source = descendants(panel).find((node) => node.attributes.get("aria-label") === "本句源语言")!
      const target = descendants(panel).find((node) => node.attributes.get("aria-label") === "本句目标语言")!
      const retry = descendants(panel).find((node) => node.textContent === "重新翻译")!
      const result = panel.children[1].children[3]
      expect(retry.disabled).toBe(true)
      target.value = "ja"
      source.value = "auto"
      target.handlers.get("change")!()
      pending[0].delta?.("Old stream")
      expect(result.textContent).toContain("语言已修改")
      expect(pending).toHaveLength(1)
      fixture.reader._internalReader._state.primaryViewSelectionPopup = null
      retry.handlers.get("click")!()
      retry.handlers.get("click")!()
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      expect(onAction.mock.calls[1][0]).toMatchObject({
        text: "Original sentence", pageIndex: 1, pageLabel: "S2", languages: { sourceLanguage: "auto", targetLanguage: "ja" },
      })
      pending[1].finish({ translation: "日本語の訳文" })
      await vi.waitFor(() => expect(result.textContent).toBe("日本語の訳文"))
      pending[0].finish({ translation: "Late old translation" })
      await Promise.resolve()
      await Promise.resolve()
      expect(result.textContent).toBe("日本語の訳文")
      expect(await readArticleTranslationLanguages(fixture.zotero, 11)).toEqual({ sourceLanguage: "fr", targetLanguage: "de" })

      fixture.reader._internalReader._state.primaryViewSelectionPopup = {
        annotation: { text: "Next sentence", pageLabel: "S3", position: { pageIndex: 2 } },
      }
      actionButtons(append.mock.calls[1][0])[0].handlers.get("click")!()
      await vi.waitFor(() => expect(pending).toHaveLength(3))
      expect(onAction.mock.calls[2][0]).toMatchObject({ text: "Next sentence", languages: { sourceLanguage: "fr", targetLanguage: "de" } })
      pending[2].finish({ translation: "" })
      await vi.waitFor(() => expect(result.textContent).toContain("没有返回"))
      expect(retry.disabled).toBe(false)
    } finally { cleanup() }
  })

  it("contains unavailable article storage and allows retrying a failed sentence with different languages", async () => {
    const fixture = host()
    fixture.zotero.Prefs = { get: () => { throw new Error("unavailable") }, set: () => { throw new Error("unavailable") } }
    const register = vi.fn()
    fixture.zotero.Reader!.registerEventListener = register
    const onAction = vi.fn().mockRejectedValueOnce(new Error("Provider failed")).mockResolvedValue({ translation: "Recovered" })
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
    const doc = new DocumentStub()
    const append = vi.fn((node: ElementStub) => doc.body.append(node))
    try {
      register.mock.calls[0][1]({ reader: fixture.reader, doc, append })
      fixture.reader._internalReader._state.primaryViewSelectionPopup = {
        annotation: { text: "Sentence", pageLabel: "1", position: { pageIndex: 0 } },
      }
      register.mock.calls[1][1]({ reader: fixture.reader, doc, append })
      actionButtons(append.mock.calls[1][0])[0].handlers.get("click")!()
      const panel = doc.body.children.find((node) => node.attributes.has("data-jadense-translation-panel"))!
      const result = panel.children[1].children[3]
      await vi.waitFor(() => expect(result.textContent).toBe("Provider failed"))
      const target = descendants(panel).find((node) => node.attributes.get("aria-label") === "本句目标语言")!
      target.value = "ja"
      target.handlers.get("change")!()
      descendants(panel).find((node) => node.textContent === "重新翻译")!.handlers.get("click")!()
      await vi.waitFor(() => expect(result.textContent).toBe("Recovered"))
      expect(onAction.mock.calls[1][0]).toMatchObject({ languages: { sourceLanguage: "en", targetLanguage: "ja" } })
    } finally { cleanup() }
  })

  it("keeps the native toolbar and translation available when an optional cross-window observer fails", async () => {
    const fixture = host()
    const register = vi.fn()
    fixture.zotero.Reader!.registerEventListener = register
    const doc = new DocumentStub()
    const disconnect = vi.fn()
    Object.assign(doc.defaultView, {
      Object,
      MutationObserver: class {
        observe() { throw new TypeError("MutationObserver options unavailable across windows") }
        disconnect = disconnect
      },
    })
    const onAction = vi.fn()
    const append = vi.fn((node: ElementStub) => doc.body.append(node))
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
    try {
      expect(() => register.mock.calls[0][1]({ reader: fixture.reader, doc, append })).not.toThrow()
      expect(append).toHaveBeenCalledOnce()
      expect(actionButtons(append.mock.calls[0][0])).toHaveLength(4)
      expect(doc.windowHandlers.has("keydown")).toBe(true)
      expect(disconnect).toHaveBeenCalledOnce()
    } finally { cleanup() }
  })

  it("translates the focused PDF split selection with live shortcuts and removes iframe listeners", async () => {
    const fixture = host()
    const register = vi.fn()
    fixture.zotero.Reader!.registerEventListener = register
    let savedShortcut: unknown
    fixture.zotero.Prefs = { get: () => savedShortcut }
    const onAction = vi.fn(async () => ({ translation: "快捷键译文" }))
    const doc = new DocumentStub()
    const primaryDoc = new DocumentStub()
    const secondaryDoc = new DocumentStub()
    const internal = fixture.reader._internalReader
    Object.assign(internal._primaryView._iframeWindow, primaryDoc.defaultView, { document: primaryDoc })
    Object.assign(internal, { _secondaryView: { _iframeWindow: { ...secondaryDoc.defaultView, document: secondaryDoc } } })
    internal._state.primaryViewSelectionPopup = { annotation: { text: "Primary source", pageLabel: "1", position: { pageIndex: 0 } } }
    internal._state.secondaryViewSelectionPopup = { annotation: { text: "Split source", pageLabel: "2", position: { pageIndex: 1 } } }
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
    const event = { reader: fixture.reader, doc, append: vi.fn((node: ElementStub) => doc.body.append(node)) }
    register.mock.calls[0][1](event)
    register.mock.calls[0][1](event)
    await vi.waitFor(() => expect(secondaryDoc.windowHandlers.has("keydown")).toBe(true))
    const press = (target: DocumentStub, key = "t", changes: Record<string, unknown> = {}) => {
      const keyboard = {
        key, code: `Key${key.toUpperCase()}`, ctrlKey: true, altKey: true, metaKey: false, shiftKey: false,
        repeat: false, isComposing: false, defaultPrevented: false,
        target: target.body, view: target.defaultView,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(), ...changes,
      }
      const handler = target.windowHandlers.get("keydown") as unknown as (event: unknown) => void
      handler(keyboard)
      return keyboard
    }
    const key = press(secondaryDoc)
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledOnce())
    expect(key.preventDefault).toHaveBeenCalledOnce()
    expect(onAction).toHaveBeenLastCalledWith(
      { kind: "translate", itemID: 11, text: "Split source", pageIndex: 1, pageLabel: "2", languages: { sourceLanguage: "en", targetLanguage: "zh-CN" } },
      { onTranslationText: expect.any(Function) },
    )
    const panel = doc.body.children.find((node) => node.attributes.has("data-jadense-translation-panel"))!
    await vi.waitFor(() => expect(panel.children[1].children[3].textContent).toBe("快捷键译文"))
    expect(press(secondaryDoc, "Escape", { ctrlKey: false, altKey: false }).preventDefault).toHaveBeenCalledOnce()
    expect(panel.hidden).toBe(true)
    expect(press(secondaryDoc, "Escape", { ctrlKey: false, altKey: false }).preventDefault).not.toHaveBeenCalled()
    savedShortcut = "Ctrl+Shift+Y"
    expect(press(primaryDoc).preventDefault).not.toHaveBeenCalled()
    press(primaryDoc, "y", { altKey: false, shiftKey: true })
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(2))
    expect(onAction.mock.calls[1][0]).toMatchObject({ text: "Primary source", pageIndex: 0 })
    savedShortcut = ""
    press(primaryDoc, "y", { altKey: false, shiftKey: true })
    await Promise.resolve()
    expect(onAction).toHaveBeenCalledTimes(2)
    cleanup()
    expect(primaryDoc.windowHandlers.size).toBe(0)
    expect(secondaryDoc.windowHandlers.size).toBe(0)
    expect(doc.windowHandlers.size).toBe(0)
    expect(doc.handlers.size).toBe(0)
  })

  it("keeps an empty shortcut selection local and ignores initialization finishing after reader closure", async () => {
    const fixture = host()
    const register = vi.fn()
    fixture.zotero.Reader!.registerEventListener = register
    const onAction = vi.fn()
    const doc = new DocumentStub()
    const pdfDoc = new DocumentStub()
    let finish!: () => void
    fixture.reader._initPromise = new Promise<void>((resolve) => { finish = resolve })
    Object.assign(fixture.reader._internalReader._primaryView._iframeWindow, pdfDoc.defaultView, { document: pdfDoc })
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
    register.mock.calls[0][1]({ reader: fixture.reader, doc, append: vi.fn() })
    const handler = doc.windowHandlers.get("keydown") as unknown as (event: unknown) => void
    handler({ key: "t", code: "KeyT", ctrlKey: true, altKey: true, metaKey: false, shiftKey: false,
      target: doc.body, view: doc.defaultView, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() })
    expect(onAction).not.toHaveBeenCalled()
    const notice = doc.body.children.find((node) => node.attributes.has("data-jadense-reader-notice"))!
    expect(notice.textContent).toContain("请先选中")
    doc.windowHandlers.get("pagehide")!()
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(pdfDoc.windowHandlers.size).toBe(0)
    cleanup()
  })

  it("restores geometric super/subscripts before sending a translation action", async () => {
    const source = page("Beat signals S1, x2 and AS2 remain synchronized.")
    for (const [index, char] of source.chars.entries()) {
      if (char.c !== "1" && char.c !== "2") continue
      const [x1, , x2] = char.rect
      char.rect = source.chars[index - 1]?.c === "x"
        ? [x1, 188, x2, 194]
        : [x1, 176, x2, 182]
      char.inlineRect = [...char.rect]
    }
    const fixture = host([source])
    const view = fixture.reader._internalReader._primaryView
    view._pdfPages[0] = source
    Object.assign(view, {
      _selectionRanges: [{
        anchorOffset: 0,
        headOffset: source.chars.length,
        text: "Beat signals S1, x2 and AS2 remain synchronized.",
        position: { pageIndex: 0 },
      }],
    })
    const register = vi.fn()
    fixture.zotero.Reader!.registerEventListener = register
    const onAction = vi.fn()
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
    const doc = new DocumentStub()
    const append = vi.fn((node: ElementStub) => doc.body.append(node))
    register.mock.calls[1][1]({
      reader: fixture.reader,
      doc,
      append,
      params: {
        annotation: {
          text: "Beat signals S1, x2 and AS2 remain synchronized.",
          position: { pageIndex: 0 },
          pageLabel: "1",
        },
      },
    })

    actionButtons(append.mock.calls[0][0])[0].handlers.get("click")!()
    await Promise.resolve()

    await vi.waitFor(() => expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "translate", text: "Beat signals S₁, x² and AS₂ remain synchronized." }),
      expect.any(Object),
    ))

    register.mock.calls[1][1]({
      reader: fixture.reader,
      doc,
      append,
      params: { annotation: { text: "A newer S1 selection.", position: { pageIndex: 0 }, pageLabel: "1" } },
    })
    actionButtons(append.mock.calls[1][0])[0].handlers.get("click")!()
    await Promise.resolve()
    await vi.waitFor(() => expect(onAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "translate", text: "A newer S1 selection." }),
      expect.any(Object),
    ))
    cleanup()
  })

  it("adds accessible toolbar and selection actions, reads the current pane and cleans up", async () => {
    const fixture = host()
    const registerEventListener = vi.fn()
    const unregisterEventListener = vi.fn()
    fixture.zotero.Reader!.registerEventListener = registerEventListener
    fixture.zotero.Reader!.unregisterEventListener = unregisterEventListener
    const onAction = vi.fn()
    const onOpenManager = vi.fn()
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction, onOpenManager)
    expect(registerEventListener.mock.calls.map(([type]) => type)).toEqual(["renderToolbar", "renderTextSelectionPopup"])
    expect(registerEventListener.mock.calls.every(([, , pluginID]) => pluginID === "test@jadense")).toBe(true)
    const doc = new DocumentStub()
    const append = vi.fn((node: ElementStub) => doc.body.append(node))
    registerEventListener.mock.calls[0][1]({ reader: fixture.reader, doc, append })
    const toolbar = append.mock.calls[0][0] as ElementStub
    const logoButton = toolbar.children[0]
    expect(logoButton.tagName).toBe("button")
    expect(logoButton.attributes.get("aria-label")).toBe("打开攻玉工作台")
    expect(logoButton.attributes.has("aria-hidden")).toBe(false)
    logoButton.handlers.get("click")!()
    expect(onOpenManager).toHaveBeenCalledOnce()
    expect(onOpenManager).toHaveBeenCalledWith()
    expect(onAction).not.toHaveBeenCalled()
    const buttons = actionButtons(toolbar)
    expect(buttons.map((button) => button.attributes.get("aria-label"))).toEqual(["发起新对话，向 AI 提问（当前文献）", "解析文献", "引用选文", "全文翻译"])
    expect(buttons.map((button) => button.children[1].textContent)).toEqual(["提问", "解析", "引用", "全文翻译"])
    expect(descendants(toolbar).some(node => node.attributes.has("data-jadense-article-languages"))).toBe(false)
    expect(buttons[0].title).toBe("Jadense · 发起新对话，向 AI 提问（当前文献）")
    buttons[0].handlers.get("click")!()
    await Promise.resolve()
    expect(openChatSidebar).toHaveBeenLastCalledWith(fixture.zotero, doc, 11, fixture.reader)
    expect(buttons.every((button) => button.children[0].tagName === "svg" && button.children[0].attributes.get("aria-hidden") === "true")).toBe(true)
    expect(toolbar.children[0].className).toBe("jadense-reader-brand")
    expect(toolbar.attributes.get("aria-label")).toBe("Jadense 阅读工具")
    expect(toolbar.children[0].textContent).toBe("")
    const brand = toolbar.children[0].children[0]
    expect(brand.tagName).toBe("svg")
    expect(brand.attributes.get("aria-hidden")).toBe("true")
    expect(brand.attributes.get("viewBox")).toBe("0 0 575 552")
    const sourceLogo = readFileSync(new URL("../../icons/jadense-20.svg", import.meta.url), "utf8")
    expect(brand.children.filter((child) => child.tagName === "path").map((path) => path.attributes.get("d")))
      .toEqual([...sourceLogo.matchAll(/<path d="([^"]+)"/g)].map(([, path]) => path))
    expect(brand.children[0].children.flatMap((gradient) => gradient.children.map((stop) => stop.attributes.get("stop-color"))))
      .toEqual([...sourceLogo.matchAll(/stop-color="([^"]+)"/g)].map(([, color]) => color))
    fixture.reader._internalReader._state.secondaryViewSelectionPopup = {
      annotation: { text: "Current selection only", pageLabel: "iv", position: { pageIndex: 3 } },
    }
    fixture.reader._internalReader._lastViewPrimary = false
    buttons[2].handlers.get("click")!()
    fixture.reader._internalReader._state.secondaryViewSelectionPopup = null
    await Promise.resolve()
    expect(onAction).toHaveBeenLastCalledWith({ kind: "quote", itemID: 11, text: "Current selection only", pageIndex: 3, pageLabel: "iv" })
    registerEventListener.mock.calls[1][1]({
      reader: fixture.reader, doc, append,
      params: { annotation: { text: "Popup source text", position: { pageIndex: 1 }, pageLabel: "2" } },
    })
    const popup = append.mock.calls[1][0] as ElementStub
    const popupButtons = actionButtons(popup)
    expect(popup.children).toHaveLength(2)
    expect(popupButtons.map((button) => button.children[1].textContent)).toEqual(["智能翻译", "引用选文"])
    expect(doc.head.children).toHaveLength(2)
    popupButtons[0].handlers.get("click")!()
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(2))
    expect(onAction).toHaveBeenLastCalledWith(
      { kind: "translate", itemID: 11, text: "Popup source text", pageIndex: 1, pageLabel: "2", languages: { sourceLanguage: "en", targetLanguage: "zh-CN" } },
      { onTranslationText: expect.any(Function) },
    )
    cleanup()
    expect(unregisterEventListener).toHaveBeenCalledTimes(2)
    expect(toolbar.remove).toHaveBeenCalledOnce()
    expect(popup.remove).toHaveBeenCalledOnce()
    expect(doc.head.children).toHaveLength(0)
    expect(doc.body.children).toHaveLength(0)
    expect(doc.handlers.size).toBe(0)
    expect(doc.windowHandlers.size).toBe(0)
    const callCount = onAction.mock.calls.length
    logoButton.handlers.get("click")!()
    expect(onOpenManager).toHaveBeenCalledOnce()
    popupButtons[0].handlers.get("click")!()
    await Promise.resolve()
    expect(onAction).toHaveBeenCalledTimes(callCount)
  })

  it("streams translation into a non-modal reader panel instead of opening chat UI", async () => {
    const fixture = host()
    const register = vi.fn()
    fixture.zotero.Reader!.registerEventListener = register
    const onAction = vi.fn(async (_action: unknown, hooks?: { onTranslationText?: (text: string) => void }) => {
      hooks?.onTranslationText?.("## 流式译文")
      return { translation: "## 完整译文\n\n- 公式：$E = mc^2$" }
    })
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
    const doc = new DocumentStub()
    const append = vi.fn((node: ElementStub) => doc.body.append(node))
    register.mock.calls[1][1]({
      reader: fixture.reader,
      doc,
      append,
      params: { annotation: { text: "Selected source", position: { pageIndex: 0 }, pageLabel: "1" } },
    })

    actionButtons(append.mock.calls[0][0])[0].handlers.get("click")!()
    const panel = doc.body.children.find((node) => node.attributes.has("data-jadense-translation-panel"))!
    await vi.waitFor(() => expect(panel.children[1].children[3].textContent).toBe("## 完整译文\n\n- 公式：$E = mc^2$"))
    expect(panel.hidden).toBe(false)
    expect(panel.attributes.get("role")).toBe("region")
    expect(panel.children[1].children[1].textContent).toBe("Selected source")
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "translate", text: "Selected source" }),
      expect.objectContaining({ onTranslationText: expect.any(Function) }),
    )
    expect(panel.children[2].children[0].className).toBe("jdx-window-appearance")
    expect(panel.children[2].children[0].children[0].textContent).toBe("外观")
    expect(descendants(panel.children[2]).some(node => node.attributes.has("data-jdx-translation-opacity"))).toBe(true)
    expect(panel.children.filter(node => node.dataset.jdxResize)).toHaveLength(8)
    panel.children[2].children[1].handlers.get("click")!()
    expect(doc.clipboardWrite).toHaveBeenCalledWith("## 完整译文\n\n- 公式：$E = mc^2$")
    cleanup()
  })

  it("keeps empty-selection actions inside the reader with a dismissible live hint", async () => {
    vi.useFakeTimers()
    try {
      const fixture = host()
      const register = vi.fn()
      fixture.zotero.Reader!.registerEventListener = register
      const onAction = vi.fn()
      const cleanup = registerReaderTools(fixture.zotero, "test@jadense", onAction)
      const doc = new DocumentStub()
      const append = vi.fn((node: ElementStub) => doc.body.append(node))
      register.mock.calls[0][1]({ reader: fixture.reader, doc, append })
      const buttons = actionButtons(append.mock.calls[0][0])
      const notice = doc.body.children.find((node) => node.attributes.has("data-jadense-reader-notice"))!
      const preventDefault = vi.fn()
      buttons[2].handlers.get("mousedown")!({ preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
      buttons[2].handlers.get("click")!()
      await Promise.resolve()
      expect(onAction).not.toHaveBeenCalled()
      expect(notice.hidden).toBe(false)
      expect(notice.textContent).toContain("先选中文献中的文字")
      expect(notice.attributes.get("role")).toBe("status")
      expect(notice.attributes.get("aria-live")).toBe("polite")
      expect(notice.style.left).toBe("532px")
      doc.handlers.get("keydown")!({ key: "Escape" })
      expect(notice.hidden).toBe(true)
      register.mock.calls[1][1]({ reader: fixture.reader, doc, append })
      actionButtons(append.mock.calls[1][0])[0].handlers.get("click")!()
      expect(notice.textContent).toContain("翻译")
      await vi.advanceTimersByTimeAsync(5000)
      expect(notice.hidden).toBe(true)
      expect(onAction).not.toHaveBeenCalled()
      cleanup()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it("shows action failures locally and removes document styling when a reader closes", async () => {
    vi.mocked(openChatSidebar).mockRejectedValueOnce(new Error("unavailable"))
    const fixture = host()
    const register = vi.fn()
    fixture.zotero.Reader!.registerEventListener = register
    const cleanup = registerReaderTools(fixture.zotero, "test@jadense", vi.fn().mockRejectedValue(new Error("unavailable")))
    const doc = new DocumentStub()
    const append = vi.fn((node: ElementStub) => doc.body.append(node))
    register.mock.calls[0][1]({ reader: fixture.reader, doc, append })
    actionButtons(append.mock.calls[0][0])[0].handlers.get("click")!()
    const notice = doc.body.children.find((node) => node.attributes.has("data-jadense-reader-notice"))!
    await vi.waitFor(() => expect(notice.hidden).toBe(false))
    expect(notice.textContent).toContain("unavailable")
    doc.windowHandlers.get("pagehide")!()
    expect(doc.head.children).toHaveLength(0)
    expect(doc.body.children).toHaveLength(0)
    expect(doc.handlers.size).toBe(0)
    expect(() => cleanup()).not.toThrow()
  })

  it("does not prevent ordinary chat initialization when reader hooks are unavailable", () => {
    const cleanup = registerReaderTools({}, "test@jadense", vi.fn())
    expect(() => cleanup()).not.toThrow()
    const broken: ZoteroReaderHost = { Reader: { registerEventListener: () => { throw new Error("unsupported") } } }
    expect(() => registerReaderTools(broken, "test@jadense", vi.fn())).not.toThrow()
  })
})
