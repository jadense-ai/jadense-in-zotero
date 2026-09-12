/** 完整 PDF 文字层适配：逐页保留原文、行与坐标，供全文翻译和参考文献使用，不执行抽样或句子过滤。 */
import { uiText } from "./ui-preferences"

export type PdfRect = [number, number, number, number]
export type PdfLine = { id: string; text: string; pageIndex: number; pageLabel: string; rects: PdfRect[]; paragraphEnd?: boolean; fontSize?: number }
export type PdfParagraph = PdfLine & { lineIDs: string[]; heading?: boolean; formulas?: Record<string, string>; sourceRange?: { start: number; end: number }; locations?: Array<{ pageIndex: number; pageLabel: string; rects: PdfRect[] }> }
export type DocumentIdentity = { itemID: number; libraryID: number; itemKey: string; title: string; modificationTime?: number; literature?: import('./document-identity').LiteratureIdentity }
export type DocumentPage = { pageIndex: number; pageLabel: string; paragraphs: PdfParagraph[]; lines: PdfLine[]; warning?: string; layoutWarning?: string; viewBox?: number[]; excludedLines?: PdfLine[]; continuationFrom?: number[] }
export type PdfTextDocument = { source: DocumentIdentity; pages: DocumentPage[]; ocrVersion?: number }
type Char = { c: string; rect?: number[]; inlineRect?: number[]; fontSize?: number; ignorable?: boolean; spaceAfter?: boolean; lineBreakAfter?: boolean; paragraphBreakAfter?: boolean }
type Item = { id: number; libraryID: number; key: string; deleted?: boolean; parentItem?: Item; getField?(key: string): unknown; isPDFAttachment?(): boolean; attachmentModificationTime?: number | Promise<number | null> }
type View = { initializedPromise?: Promise<unknown>; _ensureBasicPageData?(page: number): Promise<void>; _pdfPages?: Record<number, { chars: Char[]; viewBox?: number[] }>; _iframeWindow?: { PDFViewerApplication?: { pdfDocument?: { numPages: number; getPageLabels?(): Promise<string[] | null> } } } }
type Reader = { itemID: number; _initPromise?: Promise<unknown>; _iframeWindow?: Window; navigate?(location: unknown): unknown; _internalReader?: { _primaryView?: View; navigate?(location: unknown, options?: unknown): unknown } }
export type DocumentHost = { Items?: { get?(id: number): unknown }; Reader?: { _readers?: Reader[]; open?(id: number, location?: unknown): Promise<Reader | undefined> } }

/** Zotero 关闭窗口后可能暂留 Reader/Xray 对象；一个失效窗口不能阻断其他附件。 */
export function isLiveDocumentReader(reader: { _iframeWindow?: { closed?: boolean }; _isTabClosed?: boolean }) {
  try { return !reader._isTabClosed && !reader._iframeWindow?.closed } catch { return false }
}

export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException(uiText("任务已暂停", "Task paused"), "AbortError")
}

async function checkedItem(host: DocumentHost, identity: number | DocumentIdentity): Promise<Item> {
  const id = typeof identity === "number" ? identity : identity.itemID
  const item = await host.Items?.get?.(id) as Item | undefined
  if (!item || item.deleted || item.id !== id || !item.key || !Number.isInteger(item.libraryID) || !item.isPDFAttachment?.()) {
    throw new Error(uiText("PDF 附件不可用。", "The PDF attachment is unavailable."))
  }
  if (typeof identity !== "number" && (item.libraryID !== identity.libraryID || item.key !== identity.itemKey
    || (identity.modificationTime !== undefined && await item.attachmentModificationTime !== identity.modificationTime))) {
    throw new Error(uiText("原 PDF 身份或文件版本已变化；请重新解析。历史仍可阅读。", "The PDF identity or version changed. Extract it again; saved history remains readable."))
  }
  return item
}

export async function validateDocument(host: DocumentHost, source: DocumentIdentity) { await checkedItem(host, source) }

/** 仅在左右栏各有多行且垂直范围重叠时重排；跨栏标题分隔阅读区域，无坐标保持宿主顺序。 */
export function orderColumnLines(lines: PdfLine[]): PdfLine[] {
  const positioned = lines.filter(line => line.rects.length)
  if (positioned.length !== lines.length || lines.length < 4) return lines
  const leftEdge = Math.min(...positioned.map(line => line.rects[0][0]))
  const rightEdge = Math.max(...positioned.map(line => line.rects[0][2]))
  const middle = (leftEdge + rightEdge) / 2
  const left = positioned.filter(line => line.rects[0][2] < middle)
  const right = positioned.filter(line => line.rects[0][0] > middle)
  if (left.length < 2 || right.length < 2) return lines
  const y = (line: PdfLine) => line.rects[0][3]
  if (Math.min(...left.map(y)) > Math.max(...right.map(y)) || Math.min(...right.map(y)) > Math.max(...left.map(y))) return lines
  const columns = new Set([...left, ...right])
  const separators = positioned.filter(line => !columns.has(line)).sort((a, b) => y(b) - y(a))
  const result: PdfLine[] = []; let upper = Infinity
  for (const separator of [...separators, undefined]) {
    const lower = separator ? y(separator) : -Infinity
    for (const column of [left, right]) result.push(...column.filter(line => y(line) <= upper && y(line) > lower).sort((a, b) => y(b) - y(a)))
    if (separator) result.push(separator)
    upper = lower
  }
  return result
}

function rectangle(value?: number[]): value is PdfRect {
  return Boolean(value?.length === 4 && value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1])
}

/** 原生 chars 顺序优先；同一行的有效坐标合并，无坐标文字仍完整保留。 */
export function textPage(chars: Char[], pageIndex: number, pageLabel: string): DocumentPage {
  const lines: PdfLine[] = []
  let text = "", start = 0
  let bounds: PdfRect | undefined
  let sizes: number[] = [], lastRect: PdfRect | undefined
  const flush = (end: boolean) => {
    sizes.sort((a, b) => a - b)
    if (text.trim()) lines.push({ id: `p${pageIndex}-c${start}`, text: text.trim(), pageIndex, pageLabel, rects: bounds ? [bounds] : [], paragraphEnd: end, ...(sizes.length ? { fontSize: sizes[Math.floor(sizes.length / 2)] } : {}) })
    text = ""; bounds = undefined; sizes = []; lastRect = undefined
  }
  chars.forEach((char, index) => {
    if (typeof char.c !== "string") return
    if (char.ignorable) {
      // PDF.js 会把行尾连字符标为 ignorable，但该字符仍可能携带唯一的换行标记。
      if (text && /[-‐\u00ad]/u.test(char.c)) text += "\u00ad"
      if (char.lineBreakAfter || char.paragraphBreakAfter) flush(Boolean(char.paragraphBreakAfter))
      return
    }
    const rect = rectangle(char.inlineRect) ? char.inlineRect : char.rect
    // 字符级几何补足缺失的换行标记，不让数行文字聚成一个“巨大字号”的框。
    if (bounds && lastRect && rectangle(rect) && rect[0] < lastRect[0] - 2 && rect[0] < bounds[0] + Math.max(20, (bounds[2] - bounds[0]) / 2)
      && Math.abs(rect[1] - lastRect[1]) > Math.max(rect[3] - rect[1], lastRect[3] - lastRect[1]) * .7) flush(false)
    if (!text) start = index
    text += char.c
    if (rectangle(rect)) bounds = bounds ? [Math.min(bounds[0], rect[0]), Math.min(bounds[1], rect[1]), Math.max(bounds[2], rect[2]), Math.max(bounds[3], rect[3])] : [...rect]
    if (rectangle(rect)) { lastRect = rect; sizes.push(typeof char.fontSize === "number" && char.fontSize > 0 ? char.fontSize : rect[3] - rect[1]) }
    if (char.paragraphBreakAfter || char.lineBreakAfter || char.c.includes("\n")) flush(Boolean(char.paragraphBreakAfter))
    else if (char.spaceAfter) text += " "
  })
  flush(true)
  const paragraphs: PdfParagraph[] = []
  let group: PdfLine[] = []
  const paragraph = () => {
    if (!group.length) return
    paragraphs.push({ ...group[0], text: group.map(line => line.text).join("\n"), rects: group.flatMap(line => line.rects), lineIDs: group.map(line => line.id) })
    group = []
  }
  const ordered = orderColumnLines(lines)
  for (const line of ordered) {
    const previous = group.at(-1)
    if (previous?.rects[0] && line.rects[0] && line.rects[0][3] > previous.rects[0][3] + 4) paragraph()
    group.push(line); if (line.paragraphEnd) paragraph()
  }
  paragraph()
  return { pageIndex, pageLabel, lines: ordered, paragraphs, ...(!lines.length ? { warning: uiText("无可提取文字（空白或扫描页）", "No extractable text (blank or scanned page)") } : {}) }
}

export async function readTextDocument(host: DocumentHost, itemID: number, signal?: AbortSignal, onPage?: (page: DocumentPage, total: number) => void): Promise<PdfTextDocument> {
  checkCancelled(signal)
  const item = await checkedItem(host, itemID)
  const source: DocumentIdentity = { itemID, libraryID: item.libraryID, itemKey: item.key, title: String(item.parentItem?.getField?.("title") || item.getField?.("title") || "PDF") }
  try { const value = await item.attachmentModificationTime; if (typeof value === "number") source.modificationTime = value } catch { /* 文件版本不可用时仍允许提取。 */ }
  const reader = host.Reader?._readers?.find(row => isLiveDocumentReader(row) && row.itemID === itemID) ?? await host.Reader?.open?.(itemID)
  await reader?._initPromise
  const view = reader?._internalReader?._primaryView
  await view?.initializedPromise
  const pdf = view?._iframeWindow?.PDFViewerApplication?.pdfDocument
  if (!pdf || !view?._ensureBasicPageData || !view._pdfPages) throw new Error(uiText("请打开 PDF 阅读器后重试。", "Open the PDF reader and try again."))
  let labels: string[] | null = null
  try { labels = await pdf.getPageLabels?.() ?? null } catch { /* 页标签只用于展示。 */ }
  const pages: DocumentPage[] = []
  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
    checkCancelled(signal)
    const pageLabel = labels?.[pageIndex] || String(pageIndex + 1)
    let page: DocumentPage
    try {
      await view._ensureBasicPageData(pageIndex)
      const data = view._pdfPages[pageIndex]
      if (!Array.isArray(data?.chars)) throw new Error("missing page text")
      page = textPage(data.chars, pageIndex, pageLabel)
      if (rectangle(data.viewBox)) page.viewBox = [...data.viewBox]
    } catch { page = { pageIndex, pageLabel, lines: [], paragraphs: [], warning: uiText("本页文字读取失败", "Could not read this page") } }
    pages.push(page)
    onPage?.(page, pdf.numPages)
  }
  checkCancelled(signal)
  await validateDocument(host, source)
  return { source, pages }
}

/** 导航权来自已复核附件与本地坐标；无矩形时仅按物理页定位。 */
export async function navigateDocument(host: DocumentHost, source: DocumentIdentity, location: { pageIndex: number; rects?: PdfRect[] }, readerDocument?: Document) {
  await validateDocument(host, source)
  const target = location.rects?.length ? { position: { pageIndex: location.pageIndex, rects: location.rects } } : { pageIndex: location.pageIndex }
  const reader = (readerDocument && host.Reader?._readers?.find(value => isLiveDocumentReader(value) && value.itemID === source.itemID && value._iframeWindow?.document === readerDocument))
    || await host.Reader?.open?.(source.itemID, { pageIndex: location.pageIndex })
  await reader?._initPromise
  const win = reader?._iframeWindow as (Window & typeof globalThis & { wrappedJSObject?: Window & typeof globalThis }) | undefined
  const scope = win?.wrappedJSObject ?? win
  if (reader?._internalReader?.navigate && scope?.JSON) {
    // 先确保物理页已载入，再在 Reader 自身 realm 创建嵌套坐标，避免 Xray 遮蔽对象字段。
    await reader._internalReader.navigate(scope.JSON.parse(JSON.stringify(target)), scope.JSON.parse('{"behavior":"instant"}'))
  } else if (reader?.navigate) await reader.navigate(target)
  else await reader?._internalReader?.navigate?.(target)
}
