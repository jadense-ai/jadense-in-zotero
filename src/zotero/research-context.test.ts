/** 原生来源适配契约：仅显式材料、正确父子关系、独立降级及本地身份校验。 */
import { describe, expect, it, vi } from "vitest"
import { createQuoteSource, groupChatSources, normalizeChatSources } from "@/chat/research-context"
import { chooseChatSourceItems, collectChatSources, collectSourceForItem, MAX_PDF_SOURCE_PAGES, openChatSource, type ResearchZotero } from "./research-context"

function paper(id = 1, attachmentIDs: number[] = []) {
  const fields: Record<string, string> = {
    title: "Example study", date: "2026", publicationTitle: "Journal", abstractNote: "Abstract evidence", DOI: "10.1/example",
  }
  return {
    id, libraryID: 7, key: `PAPER${id}`, itemType: "journalArticle",
    isAttachment: () => false,
    getField: (field: string) => fields[field] ?? "",
    getCreators: () => [{ firstName: "A.", lastName: "Researcher" }],
    getAttachments: vi.fn(() => attachmentIDs),
  }
}

function attachment(id = 2, contentType = "application/pdf", parentID = 1) {
  return {
    id, libraryID: 7, key: `FILE${id}`, parentID, itemType: "attachment", attachmentContentType: contentType,
    isAttachment: () => true,
    isPDFAttachment: () => contentType === "application/pdf",
    getField: (field: string) => field === "title" ? `Attachment ${id}` : "",
  }
}

function harness(items: Array<{ id: number }>, selected: unknown[] = items) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const get = vi.fn((id: string | number) => byId.get(Number(id)))
  const getAll = vi.fn(() => [...byId.values()])
  const getSelectedItems = vi.fn(() => selected)
  const selectItem = vi.fn(async () => true)
  const open = vi.fn(async () => undefined)
  const getFullText = vi.fn(async (_id: number, _maxPages: number) => ({ text: "Page one.\fPage two.", extractedPages: 2, totalPages: 2 }))
  const zotero: ResearchZotero = {
    Items: { get, getAll },
    PDFWorker: { getFullText },
    Reader: { open },
    getActiveZoteroPane: () => ({ getSelectedItems, selectItem }),
  }
  return { zotero, get, getAll, getSelectedItems, selectItem, open, getFullText }
}

describe("Zotero local research sources", () => {
  it("opens the native multi-item/attachment chooser and uses only its explicit returned IDs", async () => {
    const mock = harness([paper(), attachment()])
    const nativeWindow = {
      openDialog: vi.fn(function (this: unknown, url: string, _name: string, features: string, io: { dataOut: unknown; onlyRegularItems?: boolean; multiSelect?: boolean }) {
        expect(this).toBe(nativeWindow)
        expect(url).toBe("chrome://zotero/content/selectItemsDialog.xhtml")
        expect(features).toContain("modal")
        expect(io.onlyRegularItems).toBe(false)
        expect(io.multiSelect).toBe(true)
        io.dataOut = [2, 2, 1, "3", 0, -1, Number.NaN]
      }),
    }
    mock.zotero.getMainWindow = () => nativeWindow as unknown as Window & typeof globalThis
    expect(await chooseChatSourceItems(mock.zotero)).toEqual([2, 1])
    expect(mock.getSelectedItems).not.toHaveBeenCalled()
    expect(mock.getAll).not.toHaveBeenCalled()
    expect(mock.getFullText).not.toHaveBeenCalled()
  })

  it("distinguishes native chooser cancellation from unavailability without reading the current selection", async () => {
    const mock = harness([paper(), attachment()])
    expect(await chooseChatSourceItems(mock.zotero)).toBeNull()
    const openDialog = vi.fn(() => undefined)
    mock.zotero.getMainWindow = () => ({ openDialog }) as unknown as Window & typeof globalThis
    expect(await chooseChatSourceItems(mock.zotero)).toEqual([])
    openDialog.mockImplementation(() => { throw new Error("Native chooser unavailable") })
    expect(await chooseChatSourceItems(mock.zotero)).toBeNull()
    expect(mock.getSelectedItems).not.toHaveBeenCalled()
    expect(mock.getFullText).not.toHaveBeenCalled()
  })

  it("never falls back to selection or the library when an explicit empty ID list is passed", async () => {
    const mock = harness([paper(), attachment()])
    expect(await collectChatSources(mock.zotero, { mode: "files", itemIDs: [] })).toEqual([])
    expect(mock.getSelectedItems).not.toHaveBeenCalled()
    expect(mock.getAll).not.toHaveBeenCalled()
    expect(mock.getFullText).not.toHaveBeenCalled()
  })

  it("uses metadata for items and for parents of selected attachments without extracting files", async () => {
    const main = paper(1, [2])
    const pdf = attachment()
    const textGetter = vi.fn(() => { throw new Error("Should not read file text") })
    Object.defineProperty(pdf, "attachmentText", { get: textGetter })
    const mock = harness([main, pdf], [pdf, main])
    const result = await collectChatSources(mock.zotero, { mode: "items" })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: "item", itemID: 1, text: "摘要：Abstract evidence" })
    expect(result[0]?.citation).toContain("Researcher")
    expect(result[0]?.citation).toContain("10.1/example")
    expect(textGetter).not.toHaveBeenCalled()
    expect(mock.getFullText).not.toHaveBeenCalled()
    expect(main.getAttachments).not.toHaveBeenCalled()
  })

  it("expands only selected parents' PDFs and preserves references when one extraction fails", async () => {
    const main = paper(1, [2, 3, 4, 5, 6, 999])
    const mock = harness([
      main, attachment(2), attachment(3), attachment(4, "text/plain"), attachment(5, "application/pdf", 100),
      { ...attachment(6), libraryID: 99 },
    ], [main])
    mock.getFullText.mockImplementation(async (id) => {
      if (id === 3) throw new Error("C:\\private\\missing.pdf")
      return { text: "Readable evidence.", extractedPages: MAX_PDF_SOURCE_PAGES, totalPages: 120 }
    })
    const result = await collectChatSources(mock.zotero, { mode: "files" })
    expect(result.map((source) => source.itemID)).toEqual([1, 2, 3])
    expect(mock.getFullText.mock.calls).toEqual([[2, MAX_PDF_SOURCE_PAGES], [3, MAX_PDF_SOURCE_PAGES]])
    expect(result[1]).toMatchObject({ text: "Readable evidence.", warning: expect.stringContaining("80 / 120") })
    expect(result[1]?.citation).toContain("Example study")
    expect(result[1]?.parentItem).toEqual({ itemID: 1, libraryID: 7, itemKey: "PAPER1", title: "Example study" })
    expect(result[2]).toMatchObject({ kind: "file", text: "", warning: expect.stringContaining("提取失败") })
    expect(JSON.stringify(result)).not.toContain("private")
    expect(mock.getAll).not.toHaveBeenCalled()
  })

  it("keeps metadata when a selected paper has no readable attachment list or no PDFs", async () => {
    const unreadable = paper(2)
    unreadable.getAttachments.mockImplementation(() => { throw new Error("Unavailable optional data") })
    const mock = harness([paper(1), unreadable])
    const result = await collectChatSources(mock.zotero, { mode: "files" })
    expect(result).toHaveLength(2)
    expect(result.every((source) => source.kind === "item" && source.warning?.includes("元数据"))).toBe(true)
    expect(mock.getFullText).not.toHaveBeenCalled()
  })

  it("extracts a PDF once when both its parent and duplicate attachment IDs are selected", async () => {
    const mock = harness([paper(1, [2]), attachment(2)])
    const sources = await collectChatSources(mock.zotero, { mode: "files", itemIDs: [1, 2, 2] })
    expect(sources.map((source) => source.itemID)).toEqual([1, 2])
    expect(mock.getFullText).toHaveBeenCalledTimes(1)
  })

  it("files mode retains the explicitly selected PDF's parent metadata without expanding sibling attachments", async () => {
    const main = paper(1, [2, 3])
    const mock = harness([main, attachment(2), attachment(3)])
    const sources = await collectChatSources(mock.zotero, { mode: "files", itemIDs: [2] })
    expect(sources.map((source) => source.itemID)).toEqual([1, 2])
    expect(sources[1]?.parentItem?.itemID).toBe(1)
    expect(main.getAttachments).not.toHaveBeenCalled()
    expect(mock.getFullText.mock.calls).toEqual([[2, MAX_PDF_SOURCE_PAGES]])
    const fileOnly = await collectChatSources(mock.zotero, { mode: "auto", itemIDs: [2] })
    expect(fileOnly.map((source) => source.itemID)).toEqual([2])
    expect(fileOnly[0]?.parentItem?.itemID).toBe(1)
  })

  it("omits unavailable or cross-library optional parents and still returns the selected file", async () => {
    for (const parent of [undefined, { ...paper(), deleted: true }, { ...paper(), libraryID: 99 }]) {
      const mock = harness([...(parent ? [parent] : []), attachment(2)])
      const source = await collectSourceForItem(mock.zotero, 2, { includeText: false })
      expect(source).toMatchObject({ kind: "file", itemID: 2 })
      expect(source).not.toHaveProperty("parentItem")
      expect(mock.getFullText).not.toHaveBeenCalled()
    }
  })

  it("auto mode expands neither paper attachments nor the rest of the library and reads selected text files", async () => {
    const main = paper(1, [2, 4])
    const text = attachment(2, "text/plain")
    Object.defineProperty(text, "attachmentText", { get: () => Promise.resolve("Plain text evidence") })
    const mock = harness([main, text, attachment(4)], [main, text])
    const result = await collectChatSources(mock.zotero, { mode: "auto" })
    expect(result).toMatchObject([{ kind: "item", itemID: 1 }, { kind: "file", itemID: 2, text: "Plain text evidence" }])
    expect(main.getAttachments).not.toHaveBeenCalled()
    expect(mock.getFullText).not.toHaveBeenCalled()
    expect(mock.getAll).not.toHaveBeenCalled()
  })

  it("creates an attachment locator for a reader quote without extracting any surrounding file text", async () => {
    const pdf = attachment()
    const textGetter = vi.fn(() => { throw new Error("Do not extract an entire file") })
    Object.defineProperty(pdf, "attachmentText", { get: textGetter })
    const mock = harness([paper(), pdf])
    const source = await collectSourceForItem(mock.zotero, 2, { includeText: false })
    expect(source).toMatchObject({ kind: "file", itemID: 2, itemKey: "FILE2", libraryID: 7, text: "" })
    expect(source?.citation).toContain("Researcher")
    const quote = createQuoteSource(source!, { text: "Original selection" })
    expect(quote.parentItem).toEqual({ itemID: 1, libraryID: 7, itemKey: "PAPER1", title: "Example study" })
    expect(mock.getFullText).not.toHaveBeenCalled()
    expect(textGetter).not.toHaveBeenCalled()
    expect(await collectSourceForItem(mock.zotero, 900)).toBeNull()
  })

  it("does not use the unbounded PDF attachmentText fallback when the worker is unavailable", async () => {
    const pdf = attachment()
    const textGetter = vi.fn(() => Promise.resolve("Unbounded full text"))
    Object.defineProperty(pdf, "attachmentText", { get: textGetter })
    const mock = harness([pdf])
    delete mock.zotero.PDFWorker
    const source = await collectSourceForItem(mock.zotero, 2)
    expect(source).toMatchObject({ kind: "file", text: "", warning: expect.stringContaining("未提供") })
    expect(textGetter).not.toHaveBeenCalled()
  })

  it("opens a local attachment at its page and rejects stale identities without executing arbitrary URLs", async () => {
    const mock = harness([paper(), attachment()])
    const file = await collectSourceForItem(mock.zotero, 2, { includeText: false })
    if (!file) throw new Error("Fixture attachment is required")
    const quote = createQuoteSource(file, { text: "Quoted evidence", pageIndex: 3, pageLabel: "4" })
    expect(await openChatSource(mock.zotero, quote)).toBe(true)
    expect(mock.open).toHaveBeenCalledWith(2, { pageIndex: 3 })
    mock.open.mockClear()
    expect(await openChatSource(mock.zotero, { ...file, libraryID: 99 })).toBe(false)
    expect(await openChatSource(mock.zotero, { ...file, itemKey: "DIFFERENT" })).toBe(false)
    expect(await openChatSource(mock.zotero, { ...file, itemID: 900 })).toBe(false)
    expect(mock.open).not.toHaveBeenCalled()
    expect(mock.selectItem).not.toHaveBeenCalled()

    const [itemSource] = normalizeChatSources([{ ...file, kind: "item", url: "javascript:evil()", path: "C:\\private" }])
    expect(await openChatSource(mock.zotero, itemSource)).toBe(true)
    expect(mock.selectItem).toHaveBeenCalledWith(2)
    expect(mock.open).not.toHaveBeenCalled()
  })

  it("revalidates grouped parent identity before opening it and never turns a matching title into navigation", async () => {
    const mock = harness([paper(), attachment()])
    const file = await collectSourceForItem(mock.zotero, 2, { includeText: false })
    const group = groupChatSources([file!])[0]
    expect(await openChatSource(mock.zotero, group.item!)).toBe(true)
    expect(mock.selectItem).toHaveBeenCalledWith(1)
    mock.selectItem.mockClear()
    expect(await openChatSource(mock.zotero, { ...group.item!, itemKey: "STALE" })).toBe(false)
    expect(mock.selectItem).not.toHaveBeenCalled()
    expect(mock.open).not.toHaveBeenCalled()
  })
})
