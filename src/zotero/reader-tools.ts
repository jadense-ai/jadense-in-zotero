import { requestStageLabel, type RequestProgress, type RequestProgressListener } from '@/chat/request-feedback'
import { JADENSE_BRAND_PARTS } from './jadense-brand'
import { lifecycleTrace } from './lifecycle-diagnostics'
import { show as showToast, type ToastHandle } from './ui/toast'
import { analysisRuntime } from './analysis-runtime'
import { analysisOCREnabled, readDocument } from './document-extraction'
import { ocrEngine } from './cloud-ocr-config'
import { readPDFTextPage, snapshotPDFChars, type TextLayerPDF } from './pdf-document'
import { openAnalysisSidebar } from './reader-sidebar'
import { markDiagnosticAbort } from "./diagnostics"
import { silentlyCheckForUpdates } from './update-notification'
import { enhanceSelection } from './selection-ocr'
import type { OCRSelectionRegion } from './local-ocr'
import { openChatSidebar } from "./reader-sidebar"
import { SELECTION_PREF, readSelectionPreferences, saveSelectionPreferences } from './selection-preferences'
// Zotero 阅读器适配层：本地 PDF 字符坐标 -> 可引用原句 -> 原生批注；AI 只返回原句 ID。
// 私有读取接口核对自 Zotero 9.0.5 的 reader 子模块 9643fac7a4e86c8d7ff9548af0191e9df63aa998。
import {
  ANALYSIS_CATEGORIES,
  type AnalysisPassage,
  type PaperAnalysisAnnotation,
} from "@/chat/paper-analysis"
import type { ChatImageInput } from "@/chat/image-input"
import { updateChatMarkdown } from "@/chat/markdown"
import {
  DEFAULT_TRANSLATION_LANGUAGES,
  TRANSLATION_LANGUAGES,
  normalizeTranslationLanguages,
  translationLanguageDisplayLabel,
  type TranslationLanguages,
} from "@/chat/translation-languages"
import { matchesReaderShortcut, readReaderShortcut } from "./reader-shortcuts"
import { initializeUiLocale, observeTheme, uiText, type UiPreferenceHost } from "./ui-preferences"
import { makeTranslationWindowInteractive, translationAppearanceControl, removeDocumentSurfaces } from "./document-ui"
import type { ZoteroLike } from "./runtime"
import { READER_UI_THEME_CSS } from "./reader-ui-theme"
import { bindReaderActionMenu } from "./reader-toolbar-menu"
import { readArticleTranslationLanguages } from "./translation-settings"
import { openPDFTranslation, stopPDFTranslationReaders } from './pdf-translation-reader'
import { stopPDFTranslationJobs } from './pdf-translation-jobs'
import { openSimpleReading, stopSimpleReadingReaders } from './simple-reading'
import { stopSimpleReadingJobs } from './simple-reading-jobs'

type Rect = [number, number, number, number]
type PdfPosition = { pageIndex: number; rects: Rect[] }
type PdfChar = {
  c: string
  rect?: number[]
  inlineRect?: number[]
  fontSize?: number
  baseline?: number
  rotation?: number
  ignorable?: boolean
  spaceAfter?: boolean
  lineBreakAfter?: boolean
  paragraphBreakAfter?: boolean
}
type PdfPage = { chars: PdfChar[]; viewBox?: number[] }
type PdfDocument = {
  numPages: number
  getPageLabels?(): Promise<string[] | null>
}
type SelectionAnnotation = {
  text?: string
  pageLabel?: string
  position?: { pageIndex?: number; rects?: number[][] }
}
type PdfSelectionRange = {
  anchorOffset?: number
  headOffset?: number
  text?: string
  position?: { pageIndex?: number; rects?: number[][] }
}
type ReaderPdfView = {
  initializedPromise?: Promise<unknown>
  _ensureBasicPageData?: (pageIndex: number) => Promise<void>
  _selectionRanges?: PdfSelectionRange[]
  _pdfPages?: Record<number, PdfPage>
  _iframeWindow?: {
    JSON?: Pick<JSON, 'stringify'>
    document?: Document
    addEventListener?: Window["addEventListener"]
    removeEventListener?: Window["removeEventListener"]
    PDFViewerApplication?: { pdfDocument?: PdfDocument; pdfViewer?: { getPageView(index: number): { div: HTMLElement; viewport: { convertToViewportRectangle(rect: number[]): number[] } } } }
  }
}
type ReaderInstance = {
  itemID: number
  _initPromise?: Promise<unknown>
  _internalReader?: {
    _lastViewPrimary?: boolean
    _state?: {
      primaryViewSelectionPopup?: { annotation?: SelectionAnnotation } | null
      secondaryViewSelectionPopup?: { annotation?: SelectionAnnotation } | null
    }
    _primaryView?: ReaderPdfView
    _secondaryView?: ReaderPdfView
  }
}
type ReaderEvent = {
  reader: ReaderInstance
  doc: Document
  params?: { annotation?: SelectionAnnotation }
  append: (element: HTMLElement) => void
}
type ReaderEventType = "renderToolbar" | "renderTextSelectionPopup"
type ReaderHandler = (event: ReaderEvent) => void

/** 保存原生选区的 PDF 坐标，显示时转换到外层 Reader 坐标；不依赖 popup 的存活。 */
function selectionAnchor(reader: ReaderInstance, fallback: HTMLElement, annotation?: SelectionAnnotation, primary = reader._internalReader?._lastViewPrimary !== false) {
  const internal = reader._internalReader
  const view = primary ? internal?._primaryView : internal?._secondaryView
  const position = (annotation ?? (primary ? internal?._state?.primaryViewSelectionPopup : internal?._state?.secondaryViewSelectionPopup)?.annotation)?.position
  let last: { left: number; top: number; bottom: number } | undefined
  return () => {
    try {
      const page = position?.pageIndex !== undefined ? view?._iframeWindow?.PDFViewerApplication?.pdfViewer?.getPageView(position.pageIndex) : undefined
      const frame = (view?._iframeWindow as Window | undefined)?.frameElement?.getBoundingClientRect()
      if (page && frame && position?.rects?.length) {
        const rects = position.rects.map(rect => page.viewport.convertToViewportRectangle(rect)).filter(rect => rect.length === 4 && rect.every(Number.isFinite))
        if (rects.length) {
          const bounds = page.div.getBoundingClientRect()
          // Gecko 跨 compartment 的 flatMap 不保证展开回调创建的数组；只跨边界传递数值。
          return {
            left: frame.left + bounds.left + Math.min(...rects.map(rect => Math.min(rect[0], rect[2]))),
            top: frame.top + bounds.top + Math.min(...rects.map(rect => Math.min(rect[1], rect[3]))),
            bottom: frame.top + bounds.top + Math.max(...rects.map(rect => Math.max(rect[1], rect[3]))),
          }
        }
      }
    } catch { /* 旧宿主退回原生 popup 的最后位置。 */ }
    if (fallback.isConnected) { const rect = fallback.getBoundingClientRect(); last = { left: rect.left, top: rect.top, bottom: rect.bottom } }
    return last
  }
}
type AnnotationItem = {
  annotationText?: string
  annotationPosition?: string
  getTags?: () => Array<{ tag: string }>
}
type PdfMetadataItem = {
  getField?: (field: string) => unknown
  getCreators?: () => unknown
}
type PdfItem = PdfMetadataItem & {
  id: number
  key: string
  libraryID: number
  deleted?: boolean
  parentItem?: PdfMetadataItem
  attachmentModificationTime?: Promise<number | null> | number | null
  isPDFAttachment?: () => boolean
  isEditable?: () => boolean
  getAnnotations?: () => AnnotationItem[]
}

// 与上传、普通 Chat 的 Zotero 投影分开：阅读器失效不得成为它们的启动依赖。
export type ZoteroReaderHost = UiPreferenceHost & {
  Prefs?: { get: (key: string, global?: boolean) => unknown; set?: (key: string, value: unknown, global?: boolean) => void }
  Items?: {
    get?: (id: number) => unknown | Promise<unknown>
    getByLibraryAndKey?: (libraryID: number, key: string) => unknown | Promise<unknown>
  }
  Reader?: {
    _readers?: ReaderInstance[]
    open?: (itemID: number) => Promise<ReaderInstance | undefined>
    registerEventListener?: (type: ReaderEventType, handler: ReaderHandler, pluginID: string) => void
    unregisterEventListener?: (type: ReaderEventType, handler: ReaderHandler) => void
  }
  Annotations?: {
    saveFromJSON?: (attachment: unknown, json: Record<string, unknown>) => Promise<unknown>
  }
  DataObjectUtilities?: { generateKey?: () => string }
}

type ReaderToolbarAction = {
  kind: "attach" | "quote" | "translate" | "analyze" | "fullTranslate" | "references"
  taskID?: string
  resultMode?: import('./document-results').DocumentResultMode | import('./analysis-workspace').AnalysisDetailTab
  itemID: number
  text?: string
  pageIndex?: number
  pageLabel?: string
  languages?: TranslationLanguages
}

export type FigureInterpretationAction = {
  kind: "interpretFigure"
  conversationTarget: "new" | "current"
  itemID: number
  pageIndex: number
  pageLabel?: string
  paperTitle?: string
  caption?: string
  image: ChatImageInput
  text?: never
}

export type ReaderAction = ReaderToolbarAction | FigureInterpretationAction

export type ReaderActionResult = {
  translation?: string
}

export type ReaderActionHooks = {
  signal?: AbortSignal
  onTranslationProgress?: RequestProgressListener
  onTranslationText?: (text: string) => void
}

export type PdfAnalysisPassage = AnalysisPassage & { position: PdfPosition; sortIndex: string }
export type PaperAnalysisMetadata = {
  title: string
  authors: string[]
  date?: string
  year?: string
  publicationTitle?: string
  doi?: string
}
export type PdfAnalysisSnapshot = {
  itemID: number
  libraryID: number
  itemKey: string
  title: string
  metadata: PaperAnalysisMetadata
  attachmentModificationTime?: number
  passages: PdfAnalysisPassage[]
  coverage: {
    pagesRead: number
    totalPages: number
    limited: boolean
    pageNumbers: number[]
    warnings: string[]
  }
}
export type SavedAnalysisAnnotations = { created: number; skipped: number; failed: number; unprocessed: number; warnings: string[] }

const MAX_PAGES = 80
const MAX_PASSAGES = 1200
const MAX_TEXT_CHARS = 120_000
const AI_TAG = "Jadense AI"
const writes = new WeakMap<ZoteroReaderHost, Map<number, Promise<SavedAnalysisAnnotations>>>()

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error(uiText("已停止文献解析。", "Literature analysis stopped."))
    error.name = "AbortError"
    throw error
  }
}

/** 等待 Zotero 自身的加载 Promise，同时允许用户立即停止。 */
async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  abortIfNeeded(signal)
  if (!signal) return promise
  let listener: () => void = () => undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        listener = () => {
          const error = new Error(uiText("已停止文献解析。", "Literature analysis stopped."))
          error.name = "AbortError"
          reject(error)
        }
        signal.addEventListener("abort", listener, { once: true })
      }),
    ])
  } finally {
    signal.removeEventListener("abort", listener)
  }
}

async function getPdfItem(zotero: ZoteroReaderHost, itemID: number): Promise<PdfItem> {
  const item = await zotero.Items?.get?.(itemID) as PdfItem | undefined
  if (!item || item.id !== itemID || !item.key || !Number.isInteger(item.libraryID)
    || item.deleted || !item.isPDFAttachment?.()) {
    throw new Error(uiText("请先选择或打开一个有效的 Zotero PDF 附件。", "Select or open a valid Zotero PDF attachment first."))
  }
  return item
}

function validRect(value: number[] | undefined): value is Rect {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    && value[2] > value[0] && value[3] > value[1]
}

/** 使用 PDF 原始坐标和行边界，不把屏幕像素或模型输出当作批注位置。 */
function rangeRects(chars: PdfChar[], first: number, last: number): Rect[] {
  const rects: Rect[] = []
  let line: Rect | undefined
  for (let index = first; index <= last; index++) {
    const char = chars[index]
    if (!char.ignorable && typeof char.c === "string" && char.c.trim()) {
      const rect = validRect(char.inlineRect) ? char.inlineRect : char.rect
      // 真实字形缺少坐标时舍弃该句，不能补造高亮位置。
      if (!validRect(rect)) return []
      line = line
        ? [Math.min(line[0], rect[0]), Math.min(line[1], rect[1]), Math.max(line[2], rect[2]), Math.max(line[3], rect[3])]
        : [...rect]
    }
    if (line && (char.lineBreakAfter || char.paragraphBreakAfter || index === last)) {
      rects.push(line.map((value) => Math.round(value * 1000) / 1000) as Rect)
      line = undefined
    }
  }
  return rects
}

/** 保留多字节字形、连字和换行空格到 PDF chars 的对应关系，再按原句切分。 */
function pagePassages(page: PdfPage, pageIndex: number, pageLabel: string): PdfAnalysisPassage[] {
  const chars = page.chars
  const offsets: number[] = []
  let text = ""
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]
    if (char.ignorable || typeof char.c !== "string") continue
    text += char.c
    for (let offset = 0; offset < char.c.length; offset++) offsets.push(index)
    if (char.spaceAfter || char.lineBreakAfter || char.paragraphBreakAfter) {
      text += char.paragraphBreakAfter ? "\n" : " "
      offsets.push(index)
    }
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" })
  const passages: PdfAnalysisPassage[] = []
  for (const segment of segmenter.segment(text)) {
    const content = segment.segment.trim()
    // ponytail: 只标注 10–2000 字符的完整句子；公式/无标点长段留给人工阅读，勿伪造句界。
    if (content.length < 10 || content.length > 2000 || !/\p{L}/u.test(content)) continue
    const start = segment.index + segment.segment.indexOf(content)
    const first = offsets[start]
    const last = offsets[start + content.length - 1]
    if (first === undefined || last === undefined) continue
    const rects = rangeRects(chars, first, last)
    if (!rects.length) continue
    const height = page.viewBox ? page.viewBox[3] - page.viewBox[1] : 0
    const top = Math.max(0, Math.floor(height - Math.max(...rects.map((rect) => rect[3]))))
    passages.push({
      id: `p${pageIndex + 1}-c${first}`,
      text: content,
      pageIndex,
      pageLabel,
      position: { pageIndex, rects },
      sortIndex: [String(pageIndex).padStart(5, "0"), String(first).padStart(6, "0"), String(top).padStart(5, "0")].join("|"),
    })
  }
  return passages
}

function sampleIndexes(total: number, count: number): number[] {
  if (count === 1) return [0]
  return Array.from({ length: count }, (_, index) => Math.round(index * (total - 1) / (count - 1)))
}

/** 均匀保留前中后原句；输入上限归本地拥有，模型包装层不再暗中截断。 */
function boundedPassages(passages: PdfAnalysisPassage[]): PdfAnalysisPassage[] {
  let count = Math.min(passages.length, MAX_PASSAGES)
  let selected = sampleIndexes(passages.length, count).map((index) => passages[index])
  let size = selected.reduce((sum, passage) => sum + passage.text.length, 0)
  while (size > MAX_TEXT_CHARS && count > 1) {
    count = Math.max(1, Math.min(count - 1, Math.floor(count * MAX_TEXT_CHARS / size)))
    selected = sampleIndexes(passages.length, count).map((index) => passages[index])
    size = selected.reduce((sum, passage) => sum + passage.text.length, 0)
  }
  return selected
}

function metadataField(item: PdfMetadataItem, field: string, maxLength: number) {
  try {
    const value = item.getField?.(field)
    return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
  } catch {
    return ""
  }
}

/** 从真实父文献读取展示元数据；任一可选字段损坏都只丢弃自身。 */
function paperMetadata(item: PdfItem): PaperAnalysisMetadata {
  let source: PdfMetadataItem = item
  try { source = item.parentItem ?? item } catch { /* 父文献不可用时退回附件本身。 */ }
  const title = metadataField(source, "title", 500) || metadataField(item, "title", 500) || uiText("PDF 文献", "PDF document")
  const authors: string[] = []
  try {
    const creators = source.getCreators?.()
    if (Array.isArray(creators)) {
      for (const creator of creators.slice(0, 8)) {
        if (!creator || typeof creator !== "object" || Array.isArray(creator)) continue
        const row = creator as Record<string, unknown>
        const name = (typeof row.name === "string" ? row.name : [row.firstName, row.lastName]
          .filter((part) => typeof part === "string").join(" ")).trim().slice(0, 160)
        if (name) authors.push(name)
      }
    }
  } catch { /* 作者只用于历史展示。 */ }
  const date = metadataField(source, "date", 80)
  const year = metadataField(source, "year", 20) || date.match(/\b(?:1[5-9]\d{2}|20\d{2}|21\d{2})\b/)?.[0] || ""
  const publicationTitle = metadataField(source, "publicationTitle", 500)
  const doi = metadataField(source, "DOI", 300)
  return {
    title,
    authors,
    ...(date ? { date } : {}),
    ...(year ? { year } : {}),
    ...(publicationTitle ? { publicationTitle } : {}),
    ...(doi ? { doi } : {}),
  }
}

/** 读取当前附件的文字层，给 AI 的每条原句都保留对应的本地真实高亮坐标。 */
export async function readPdfForAnalysis(
  zotero: ZoteroReaderHost,
  itemID: number,
  options: { signal?: AbortSignal; onProgress?: (progress: { pagesRead: number; totalPages: number }) => void; onNotice?: (message: string) => void } = {},
): Promise<PdfAnalysisSnapshot> {
  const { signal, onProgress } = options
  abortIfNeeded(signal)
  const item = await getPdfItem(zotero, itemID)
  let modificationTime: number | null | undefined
  try { modificationTime = await item.attachmentModificationTime } catch { /* 只使用实际可用的文件版本信息。 */ }
  const warnings: string[] = []
  const useOCR = analysisOCREnabled(zotero as unknown as ZoteroLike)
  // 纯文字 OCR 适配不提供定位能力，解析无需先上传整篇再丢弃结果。
  const supportsLocations = ['local', 'mineru', 'glm'].includes(ocrEngine(zotero as unknown as ZoteroLike))
  if (useOCR && supportsLocations) {
    const document = await readDocument(zotero as unknown as ZoteroLike, itemID, signal ?? new AbortController().signal, undefined, useOCR)
    const candidates: PdfAnalysisPassage[] = document.pages.flatMap(page => page.paragraphs.flatMap((paragraph, index) => {
      const rects = paragraph.rects.filter(validRect)
      if (!paragraph.text.trim()) return []
      return [{ id: paragraph.id, text: paragraph.text, pageIndex: page.pageIndex, pageLabel: page.pageLabel,
        position: { pageIndex: page.pageIndex, rects }, sortIndex: `${String(page.pageIndex).padStart(5, '0')}|${String(index).padStart(6, '0')}|00000` }]
    }))
    if (candidates.some(passage => passage.position.rects.length)) {
      const passages = boundedPassages(candidates), metadata = paperMetadata(item)
      return { itemID: item.id, libraryID: item.libraryID, itemKey: item.key, title: metadata.title, metadata,
        ...(typeof document.source.modificationTime === 'number' ? { attachmentModificationTime: document.source.modificationTime } : {}), passages,
        coverage: { pagesRead: document.pages.length, totalPages: document.pages.length, pageNumbers: document.pages.map(page => page.pageIndex + 1),
          limited: passages.length < candidates.length || document.pages.some(page => Boolean(page.warning)), warnings: document.pages.flatMap(page => page.warning ? [page.warning] : []) } }
    }
  }
  if (useOCR) {
    const warning = uiText('当前 OCR 未提供有效位置，全文解析已回退到传统文字提取；扫描页若无文字层则无法生成 PDF 批注。', 'The current OCR provides no usable positions. Analysis has fallen back to text-layer extraction; scanned pages without a text layer cannot produce PDF annotations.')
    warnings.push(warning)
    try { options.onNotice?.(warning) } catch { /* 提示失败不影响文字层回退。 */ }
  }
  let reader = zotero.Reader?._readers?.find((candidate) => candidate.itemID === itemID)
  if (!reader && zotero.Reader?.open) reader = await withAbort(zotero.Reader.open(itemID), signal)
  reader ??= zotero.Reader?._readers?.find((candidate) => candidate.itemID === itemID)
  if (!reader) throw new Error(uiText("PDF 阅读器尚未就绪，请打开该 PDF 后重试解析。", "The PDF reader is not ready. Open this PDF and try analysis again."))
  if (reader._initPromise) await withAbort(reader._initPromise, signal)
  const view = reader._internalReader?._primaryView
  if (view?.initializedPromise) await withAbort(view.initializedPromise, signal)
  const pdf = view?._iframeWindow?.PDFViewerApplication?.pdfDocument
  if (!view || !pdf || !Number.isInteger(pdf.numPages) || pdf.numPages < 1) {
    throw new Error(uiText("当前阅读器无法提供 PDF 文字坐标，仍可使用普通对话。", "This reader cannot provide PDF text coordinates. Regular chat is still available."))
  }
  let labels: string[] | null = null
  try { labels = pdf.getPageLabels ? await withAbort(pdf.getPageLabels(), signal) : null } catch { abortIfNeeded(signal) }
  const pageIndexes = sampleIndexes(pdf.numPages, Math.min(MAX_PAGES, pdf.numPages))
  const pageNumbers: number[] = []
  const emptyPages: number[] = []
  const candidates: PdfAnalysisPassage[] = []
  for (const pageIndex of pageIndexes) {
    abortIfNeeded(signal)
    try {
      // 传入 primitive，让阅读器自己构造 worker 参数；跨 Gecko compartment 传对象会 DataCloneError。
      let page
      try { await withAbort(Promise.resolve(view._ensureBasicPageData?.(pageIndex)), signal); page = view._pdfPages?.[pageIndex] } catch { abortIfNeeded(signal) }
      if (!page?.chars?.length && (pdf as TextLayerPDF).getPage) page = await withAbort(readPDFTextPage(pdf as TextLayerPDF, pageIndex), signal)
      if (!Array.isArray(page?.chars)) throw new Error("missing text layer")
      const passages = pagePassages({ chars: snapshotPDFChars(page.chars, view._iframeWindow), viewBox: page.viewBox }, pageIndex, labels?.[pageIndex] || String(pageIndex + 1))
      candidates.push(...passages)
      if (!passages.length) emptyPages.push(pageIndex + 1)
      pageNumbers.push(pageIndex + 1)
    } catch {
      abortIfNeeded(signal)
      warnings.push(uiText(`第 ${pageIndex + 1} 页的文字坐标读取失败，未纳入解析。`, `Text coordinates on page ${pageIndex + 1} could not be read; the page was omitted from analysis.`))
    }
    try { onProgress?.({ pagesRead: pageNumbers.length, totalPages: pdf.numPages }) } catch { /* 进度展示不得阻止正文解析。 */ }
  }
  abortIfNeeded(signal)
  if (!candidates.length) {
    throw new Error([...warnings, uiText("未找到可定位的 PDF 原句。扫描件请先完成 OCR；本次没有生成高亮或批注。", "No PDF passages with usable coordinates were found. Run OCR for scanned documents first. No highlights or annotations were created.")].join('\n'))
  }
  const passages = boundedPassages(candidates)
  const limited = passages.length < candidates.length || pageNumbers.length < pdf.numPages || emptyPages.length > 0
  if (emptyPages.length) warnings.push(uiText(`第 ${emptyPages.join("、")} 页无可定位原句，可能是图像、空白页或缺少文字层，未纳入句子解析。`, `Pages ${emptyPages.join(", ")} contain no passages with usable coordinates and were omitted. They may be images, blank, or lack a text layer.`))
  if (pageIndexes.length < pdf.numPages) warnings.push(uiText(`长文献均匀抽取 ${pageIndexes.length}/${pdf.numPages} 页（包括末页），未读取全部正文。`, `This long document was sampled evenly across ${pageIndexes.length}/${pdf.numPages} pages, including the last page. Not all text was read.`))
  if (passages.length < candidates.length) warnings.push(uiText(`为控制解析长度，均匀选取 ${passages.length}/${candidates.length} 个可定位原句；结论仅基于这些原句。`, `Analysis uses an evenly sampled ${passages.length}/${candidates.length} passages with usable coordinates; conclusions are limited to these passages.`))
  if (modificationTime !== undefined && modificationTime !== null
    && await item.attachmentModificationTime !== modificationTime) {
    throw new Error(uiText("PDF 文件在读取期间已更改，请重新打开后再解析。", "The PDF changed while being read. Reopen it before running analysis again."))
  }
  abortIfNeeded(signal)
  const metadata = paperMetadata(item)
  return {
    itemID: item.id,
    libraryID: item.libraryID,
    itemKey: item.key,
    title: metadata.title,
    metadata,
    ...(typeof modificationTime === "number" ? { attachmentModificationTime: modificationTime } : {}),
    passages,
    coverage: { pagesRead: pageNumbers.length, totalPages: pdf.numPages, limited, pageNumbers, warnings },
  }
}

function annotationIdentity(text: string, pageIndex: number, category: string): string {
  return JSON.stringify([pageIndex, category, text.normalize("NFC").replace(/\s+/g, " ").trim()])
}

function escapeComment(text: string): string {
  // Zotero annotationComment 支持内联富文本；AI/原文里的标签必须作为字面文字保存。
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function existingIdentities(annotations: AnnotationItem[]): Set<string> {
  const identities = new Set<string>()
  for (const annotation of annotations) {
    try {
      const tags = annotation.getTags?.().map((tag) => tag.tag) ?? []
      if (!annotation.annotationText) continue
      const position = JSON.parse(annotation.annotationPosition || "{}") as { pageIndex?: number }
      if (!Number.isInteger(position.pageIndex)) continue
      for (const category of ANALYSIS_CATEGORIES) {
        if (tags.includes(`${AI_TAG}/${category.id}`)) {
          identities.add(annotationIdentity(annotation.annotationText, position.pageIndex!, category.id))
        }
      }
    } catch { /* 单条历史批注损坏时保留原样，不修改或删除。 */ }
  }
  return identities
}

/** 写入前重读权威附件；不能把旧文件坐标写到另一份文献或无编辑权限的文库。 */
async function checkWritable(zotero: ZoteroReaderHost, snapshot: PdfAnalysisSnapshot): Promise<PdfItem> {
  const item = await getPdfItem(zotero, snapshot.itemID)
  if (item.key !== snapshot.itemKey || item.libraryID !== snapshot.libraryID || !item.isEditable?.()) {
    throw new Error(uiText("PDF 已变更或当前文库不可编辑，已停止写入批注。", "The PDF changed or the library is not editable. Annotation saving stopped."))
  }
  if (snapshot.attachmentModificationTime !== undefined
    && await item.attachmentModificationTime !== snapshot.attachmentModificationTime) {
    throw new Error(uiText("PDF 文件在解析期间已更改，请重新打开并解析后再保存批注。", "The PDF changed during analysis. Reopen and analyze it again before saving annotations."))
  }
  return item
}

/** 只新增本地原句对应的高亮；同一附件串行化，重复运行不会覆盖人工批注。 */
export async function saveAnalysisAnnotations(
  zotero: ZoteroReaderHost,
  snapshot: PdfAnalysisSnapshot,
  annotations: ReadonlyArray<Pick<PaperAnalysisAnnotation, "passageId" | "category" | "comment">>,
  options: { signal?: AbortSignal } = {},
): Promise<SavedAnalysisAnnotations> {
  abortIfNeeded(options.signal)
  let locks = writes.get(zotero)
  if (!locks) { locks = new Map(); writes.set(zotero, locks) }
  const previous = locks.get(snapshot.itemID)
  const operation = (async () => {
    await previous?.catch(() => undefined)
    abortIfNeeded(options.signal)
    if (!zotero.Annotations?.saveFromJSON || !zotero.DataObjectUtilities?.generateKey || !zotero.Items?.getByLibraryAndKey) {
      throw new Error(uiText("当前 Zotero 无法保存原生批注；解析结果仍可在解析记录中阅读。", "Zotero cannot save native annotations right now. The analysis remains readable in analysis history."))
    }
    const attachment = await checkWritable(zotero, snapshot)
    if (!attachment.getAnnotations) throw new Error(uiText("无法读取现有批注，已暂停写入以避免重复。", "Existing annotations could not be read. Saving paused to avoid duplicates."))
    const existing = existingIdentities(attachment.getAnnotations())
    const passages = new Map(snapshot.passages.map((passage) => [passage.id, passage]))
    const result: SavedAnalysisAnnotations = { created: 0, skipped: 0, failed: 0, unprocessed: annotations.length, warnings: [] }
    let invalid = 0
    for (const suggestion of annotations) {
      if (options.signal?.aborted) { result.warnings.push(uiText("已停止；此前成功保存的批注予以保留。", "Stopped. Previously saved annotations are retained.")); break }
      const passage = passages.get(suggestion?.passageId)
      const comment = typeof suggestion?.comment === "string" ? suggestion.comment.trim() : ""
      const category = ANALYSIS_CATEGORIES.find((entry) => entry.id === suggestion?.category)
        ?? ANALYSIS_CATEGORIES.find((entry) => entry.id === "additional")!
      if (!passage || !comment || typeof passage.text !== "string" || !passage.text.trim()
        || !Number.isInteger(passage.pageIndex) || passage.pageIndex < 0
        || !Array.isArray(passage.position?.rects) || !passage.position.rects.length
        || passage.position.pageIndex !== passage.pageIndex || !passage.position.rects.every(validRect)) {
        invalid++
        result.skipped++
        result.unprocessed--
        continue
      }
      const identity = annotationIdentity(passage.text, passage.pageIndex, category.id)
      if (existing.has(identity)) { result.skipped++; result.unprocessed--; continue }
      let key: string
      try {
        key = zotero.DataObjectUtilities.generateKey()
        // saveFromJSON 会按库内 key 更新旧条目；碰撞或无法核对时不写入，不能覆盖任何旧内容。
        if (await zotero.Items.getByLibraryAndKey(snapshot.libraryID, key)) {
          result.skipped++
          result.unprocessed--
          result.warnings.push(uiText("批注标识发生冲突，已跳过该条，请重试。", "An annotation identifier conflicted. This annotation was skipped; please try again."))
          continue
        }
      } catch {
        result.failed++
        result.unprocessed--
        result.warnings.push(uiText(`第 ${passage.pageIndex + 1} 页的「${category.label}」批注未能核对新标识，未开始写入；其余批注继续保存。`, `The new identifier for a “${category.id}” annotation on page ${passage.pageIndex + 1} could not be verified. It was not saved; other annotations continue.`))
        continue
      }
      // 异步标识核对后再验证附件，避免期间更换文件或文库权限后仍使用旧坐标。
      let current: PdfItem
      try { current = await checkWritable(zotero, snapshot) } catch (error) {
        result.warnings.push(error instanceof Error ? error.message : uiText("附件状态改变，已停止写入。", "The attachment changed. Saving stopped."))
        break
      }
      if (options.signal?.aborted) { result.warnings.push(uiText("已停止；此前成功保存的批注予以保留。", "Stopped. Previously saved annotations are retained.")); break }
      try {
        // 已发起保存的同一原句/分类在本轮不重试：抛错也可能已经持久化，不能盲目新增副本。
        existing.add(identity)
        await zotero.Annotations.saveFromJSON(current, {
          key,
          type: "highlight",
          text: passage.text,
          comment: escapeComment(`【${category.label}】\n${comment}`),
          color: category.color,
          pageLabel: passage.pageLabel || String(passage.pageIndex + 1),
          sortIndex: passage.sortIndex,
          position: { pageIndex: passage.pageIndex, rects: passage.position.rects.map((rect) => [...rect]) },
          tags: [{ name: `${AI_TAG}/${category.id}` }, { name: category.label }],
        })
        result.created++
      } catch {
        result.failed++
        result.warnings.push(uiText(`第 ${passage.pageIndex + 1} 页的「${category.label}」批注未确认保存；请先检查 PDF 中的批注再重试。`, `A “${category.id}” annotation on page ${passage.pageIndex + 1} could not be confirmed as saved. Check the PDF annotations before retrying.`))
      }
      result.unprocessed--
    }
    if (invalid) result.warnings.push(uiText(`${invalid} 条建议缺少有效笔记或本地原句坐标，已跳过；其余正确批注予以保留。`, `${invalid} suggestions lacked valid notes or local passage coordinates and were skipped. Other valid annotations are retained.`))
    if (result.unprocessed) result.warnings.push(uiText(`另有 ${result.unprocessed} 条建议尚未处理，没有为它们确认新增批注。`, `${result.unprocessed} additional suggestions remain unprocessed; no new annotations were confirmed for them.`))
    return result
  })()
  locks.set(snapshot.itemID, operation)
  try { return await operation } finally {
    if (locks.get(snapshot.itemID) === operation) locks.delete(snapshot.itemID)
  }
}

const SUBSCRIPT_GLYPHS: Readonly<Record<string, string>> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ",
  m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", x: "ₓ",
}
const SUPERSCRIPT_GLYPHS: Readonly<Record<string, string>> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ",
  i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ",
  r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
}

function percentile(values: number[], ratio: number): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.round((sorted.length - 1) * ratio)]
}

function normalizeSelectedText(text: string): string {
  return text.replace(/\s+/gu, " ").trim()
}

/** 仅展开 Unicode 标准拉丁连字；不能对整段做 NFKC，否则会抹掉上下标等数学语义。 */
function normalizeSelectionLigatures(text: string): string {
  return text.replace(/[\uFB00-\uFB06]/gu, glyph => glyph.normalize('NFKD'))
}

function charRect(char: PdfChar): number[] | undefined {
  const rect = char.rect
  return rect?.length === 4 && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]
    ? rect
    : undefined
}

function selectedCharsText(chars: readonly PdfChar[], replacements?: ReadonlyMap<PdfChar, string>): string {
  const text: string[] = []
  for (const char of chars) {
    if (!char.ignorable) {
      text.push(replacements?.get(char) ?? char.c)
      if (char.spaceAfter || char.lineBreakAfter) text.push(" ")
    }
    if (!char.ignorable && char.paragraphBreakAfter) text.push(" ")
  }
  return text.join("").trim()
}

/**
 * PDF 弹窗文本会丢掉字号和基线；只在活动 range 与弹窗文本完全对应时，
 * 用仍在 reader 页缓存中的字形几何恢复 Unicode 上下标及剔除精确重复叠印。证据不足时保留原文。
 */
function enrichSelectionScripts(annotationText: string, view?: ReaderPdfView): string {
  const ranges = view?._selectionRanges
  if (!ranges?.length || !view?._pdfPages) return annotationText
  const plainRanges: string[] = []
  const enrichedRanges: string[] = []
  for (const range of ranges) {
    const pageIndex = range.position?.pageIndex
    const anchor = range.anchorOffset
    const head = range.headOffset
    if (!Number.isInteger(pageIndex) || !Number.isInteger(anchor) || !Number.isInteger(head) || anchor === head) {
      return annotationText
    }
    const pageChars = view._pdfPages[pageIndex!]?.chars
    if (!pageChars) return annotationText
    const start = Math.min(anchor!, head!)
    const end = Math.max(anchor!, head!)
    if (start < 0 || end > pageChars.length) return annotationText
    const chars = pageChars.slice(start, end)
    const plainText = selectedCharsText(chars)
    if (range.text && normalizeSelectedText(range.text) !== normalizeSelectedText(plainText)) return annotationText

    const replacements = new Map<PdfChar, string>()
    const seenGlyphs = new Set<string>()
    let line: PdfChar[] = []
    const recoverLine = () => {
      const measured = line.flatMap((char) => {
        const rect = charRect(char)
        if (!rect || char.ignorable || (char.rotation !== undefined && char.rotation !== 0)) return []
        const fontSize = typeof char.fontSize === "number" && Number.isFinite(char.fontSize) && char.fontSize > 0
          ? char.fontSize
          : rect[3] - rect[1]
        const vertical = typeof char.baseline === "number" && Number.isFinite(char.baseline)
          ? char.baseline
          : (rect[1] + rect[3]) / 2
        return [{ char, fontSize, vertical }]
      })
      const bodySize = percentile(measured.map(({ fontSize }) => fontSize), 0.75)
      if (!bodySize) return
      const body = measured.filter(({ fontSize }) => fontSize >= bodySize * 0.9)
      const bodyVertical = percentile(body.map(({ vertical }) => vertical), 0.5)
      if (bodyVertical === undefined) return
      for (const metric of measured) {
        if (metric.fontSize > bodySize * 0.82) continue
        const shift = metric.vertical - bodyVertical
        if (Math.abs(shift) < bodySize * 0.16) continue
        const replacement = shift < 0
          ? SUBSCRIPT_GLYPHS[metric.char.c]
          : SUPERSCRIPT_GLYPHS[metric.char.c]
        if (replacement) replacements.set(metric.char, replacement)
      }
    }
    for (const char of chars) {
      // 只合并同页、同字、同矩形和同字号/基线的叠印；不同位置的 ff、1111 或公式字符不删。
      const rect = charRect(char)
      const key = rect && !char.ignorable && (char.rotation === undefined || char.rotation === 0)
        ? JSON.stringify([char.c, rect, char.fontSize, char.baseline]) : undefined
      if (key && seenGlyphs.has(key)) replacements.set(char, '')
      else { if (key) seenGlyphs.add(key); line.push(char) }
      if (char.lineBreakAfter || char.paragraphBreakAfter) { recoverLine(); line = [] }
    }
    if (line.length) recoverLine()
    plainRanges.push(plainText)
    enrichedRanges.push(selectedCharsText(chars, replacements))
  }
  if (normalizeSelectedText(plainRanges.join(" ")) !== normalizeSelectedText(annotationText)) return annotationText
  return enrichedRanges.join(" ").trim()
}

function selectedAction(kind: ReaderToolbarAction["kind"], reader: ReaderInstance, annotation?: SelectionAnnotation, primary?: boolean): ReaderToolbarAction {
  const action: ReaderToolbarAction = { kind, itemID: reader.itemID }
  if (kind !== "quote" && kind !== "translate") return action
  const internal = reader._internalReader
  primary ??= internal?._lastViewPrimary !== false
  if (!annotation) {
    annotation = (primary ? internal?._state?.primaryViewSelectionPopup : internal?._state?.secondaryViewSelectionPopup)?.annotation
  }
  if (typeof annotation?.text === "string" && annotation.text.trim()) {
    const text = annotation.text.trim()
    const activeView = primary ? internal?._primaryView : internal?._secondaryView
    action.text = normalizeSelectionLigatures(enrichSelectionScripts(text, activeView))
    // 异步 OCR 前保存副本；只在 range 文本与当前 popup 一致时使用多页坐标。
    const regions: OCRSelectionRegion[] = []
    const rangeTexts: string[] = []
    for (const range of activeView?._selectionRanges ?? []) {
      const pageIndex = range.position?.pageIndex
      const start = Math.min(range.anchorOffset ?? -1, range.headOffset ?? -1)
      const end = Math.max(range.anchorOffset ?? -1, range.headOffset ?? -1)
      const page = pageIndex === undefined ? undefined : activeView?._pdfPages?.[pageIndex]
      if (!page || !Number.isInteger(pageIndex) || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > page.chars.length) { regions.length = 0; break }
      const chars = page.chars.slice(start, end)
      const plain = selectedCharsText(chars)
      if (range.text && normalizeSelectedText(range.text) !== normalizeSelectedText(plain)) { regions.length = 0; break }
      const rects = range.position?.rects?.length && range.position.rects.every(validRect)
        ? range.position.rects : chars.filter(char => !char.ignorable).map(charRect)
      if (rects.some(rect => !rect)) { regions.length = 0; break }
      regions.push({ pageIndex: pageIndex!, rects: rects.map(rect => [...rect!]) }); rangeTexts.push(plain)
    }
    if (regions.length && normalizeSelectedText(rangeTexts.join(' ')) === normalizeSelectedText(text)) selectionRegions.set(action, regions)
    else if (!activeView?._selectionRanges?.length && Number.isInteger(annotation.position?.pageIndex)
      && annotation.position?.rects?.length && annotation.position.rects.every(validRect)) {
      selectionRegions.set(action, [{ pageIndex: annotation.position.pageIndex!, rects: annotation.position.rects.map(rect => [...rect]) }])
    }
  }
  if (Number.isInteger(annotation?.position?.pageIndex)) action.pageIndex = annotation!.position!.pageIndex
  if (typeof annotation?.pageLabel === "string") action.pageLabel = annotation.pageLabel
  return action
}

const selectionRegions = new WeakMap<ReaderToolbarAction, OCRSelectionRegion[]>()

// 样式只命中自有节点；自有主题变量支持显式浅深色和跟随 Zotero，不覆盖 PDF。
const READER_TOOLS_CSS = `${READER_UI_THEME_CSS}

[data-jadense-reader-tools] {
  display:inline-flex;align-items:center;gap:2px;flex:none;box-sizing:border-box;
  padding:2px;border:1px solid var(--jdx-reader-line,rgba(17,21,16,.12));border-radius:7px;
  color:var(--jdx-reader-text,CanvasText);background:var(--jdx-reader-surface,transparent);
  font:inherit;-moz-window-dragging:no-drag;
}
[data-jadense-reader-tools] .jadense-reader-brand {
  display:flex;align-items:center;justify-content:center;flex:none;padding:0 6px 0 4px;margin-inline-end:2px;
  border-inline-end:1px solid var(--jdx-reader-line,rgba(17,21,16,.12));
}
:is([data-jadense-reader-tools], .jadense-reader-actions) > button {
  appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;
  gap:5px;min-width:28px;height:28px;margin:0;padding:0 6px;border:0;border-radius:5px;
  background:transparent;color:inherit;font:inherit;font-size:calc(12px * var(--jdx-font-scale,1));font-weight:500;line-height:1;
  white-space:nowrap;cursor:pointer;-moz-window-dragging:no-drag;
}
:is([data-jadense-reader-tools], .jadense-reader-actions) > button:hover {
  background:var(--jdx-reader-hover,rgba(17,21,16,.06));
}
:is([data-jadense-reader-tools], .jadense-reader-actions) > button:active {
  background:var(--jdx-reader-active,rgba(17,21,16,.12));
}
:is([data-jadense-reader-tools], .jadense-reader-actions) > button:focus-visible {
  outline:2px solid var(--jdx-reader-text,CanvasText);outline-offset:1px;
}
:is([data-jadense-reader-tools], .jadense-reader-actions) svg {width:16px;height:16px;flex:none;pointer-events:none;}
[data-jadense-reader-tools] .jadense-reader-brand svg {width:20px;height:20px;}
[data-jadense-reader-tools] .jadense-reader-brand[data-runtime]:not([data-runtime="idle"]) {width:180px;max-width:32vw;gap:6px;overflow:hidden;}
[data-jadense-reader-tools] .jadense-reader-brand[data-runtime="running"] svg {transform-box:fill-box;transform-origin:center;animation:jdx-analysis-logo-spin 1.4s linear infinite;}
[data-jadense-reader-tools] .jadense-reader-brand[data-runtime="complete"] {color:var(--jdx-reader-text,CanvasText);box-shadow:inset 0 -2px #16cf8c;}
[data-jadense-reader-tools] .jadense-reader-brand[data-runtime="error"] {box-shadow:inset 0 0 0 2px var(--jdx-reader-error,#b42318);}
[data-jadense-reader-tools] .jadense-reader-brand[data-runtime="retrying"] {box-shadow:inset 0 0 0 1px #c37d0d;}
[data-jadense-reader-tools][data-compact="true"] .jadense-reader-brand[data-runtime]:not([data-runtime="idle"]) {width:auto;max-width:100px;padding:0 4px;gap:0;overflow:hidden;}
[data-jadense-reader-tools] .jadense-reader-runtime-stop[hidden] {display:none!important;}
.jadense-reader-runtime-label {overflow:hidden;text-overflow:ellipsis;}
@keyframes jdx-analysis-logo-spin {to {transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce) {[data-jadense-reader-tools] .jadense-reader-brand[data-runtime="running"] svg {animation:none;}}
[data-jadense-reader-tools="renderTextSelectionPopup"] {
  display:flex;flex-wrap:wrap;width:100%;max-width:100%;min-width:0;
  margin-top:4px;padding:3px;background:var(--jdx-reader-surface,transparent);
}
/* 选文插槽受宿主弹窗宽度限制；大字号或长标签换行，不撑宽原生颜色/批注工具。 */
[data-jadense-reader-tools="renderTextSelectionPopup"] > button {
  flex:1 1 auto;max-width:100%;height:auto;min-height:28px;padding:5px 6px;
  white-space:normal;line-height:1.3;
}
[data-jadense-reader-tools="renderTextSelectionPopup"] .jadense-reader-label {min-width:0;overflow-wrap:anywhere;}
[data-jadense-translation-panel] {
  position:fixed;z-index:10000;top:56px;right:16px;display:grid;grid-template-rows:auto minmax(0,1fr) auto;
  box-sizing:border-box;width:min(430px,calc(100vw - 16px));min-width:min(300px,calc(100vw - 16px));min-height:min(220px,calc(100vh - 16px));max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:hidden;
  border:1px solid var(--jdx-reader-border,rgba(17,21,16,.16));border-radius:8px;
  color:var(--jdx-reader-text,CanvasText);background:var(--jdx-reader-background,Canvas);
  box-shadow:0 8px 24px rgba(0,0,0,.14);font:calc(13px * var(--jdx-font-scale,1))/1.65 system-ui,sans-serif;
}
[data-jadense-translation-panel][hidden] {display:none;}
[data-jadense-translation-panel] header {display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--jdx-reader-line,rgba(17,21,16,.12));}
[data-jadense-translation-panel] header strong {font-size:calc(13px * var(--jdx-font-scale,1));}
[data-jadense-translation-panel] button {appearance:none;border:1px solid var(--jdx-reader-line,rgba(17,21,16,.12));border-radius:5px;padding:5px 9px;color:inherit;background:transparent;font:inherit;cursor:pointer;}
[data-jadense-translation-panel] button:hover:not(:disabled) {background:var(--jdx-reader-hover,rgba(17,21,16,.06));}
[data-jadense-translation-panel] button:disabled {cursor:default;opacity:.5;}
[data-jadense-translation-panel] .jadense-translation-close {border:0;padding:2px 7px;font-size:calc(18px * var(--jdx-font-scale,1));line-height:1.2;}
.jadense-translation-content {min-height:0;overflow-y:auto;padding:12px;}
.jadense-translation-label {margin:0 0 4px;color:var(--jdx-reader-muted,currentColor);font-size:calc(11px * var(--jdx-font-scale,1));font-weight:650;letter-spacing:.02em;}
.jadense-translation-text {margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;}
/* 覆盖阅读器宿主的禁选样式，原文和 Markdown 译文均允许原生拖选复制。 */
[data-jadense-translation-panel] .jadense-translation-text,
[data-jadense-translation-panel] .jadense-translation-text * {-moz-user-select:text;user-select:text;}
.jadense-translation-result {margin-bottom:0;padding:10px;border-radius:7px;background:var(--jdx-reader-surface,rgba(17,21,16,.04));}
.jadense-translation-source {margin-top:14px;border-top:1px solid var(--jdx-reader-line,rgba(17,21,16,.12));}
.jadense-translation-source summary {cursor:pointer;padding:9px 0;color:var(--jdx-reader-muted,currentColor);font-size:calc(11px * var(--jdx-font-scale,1));font-weight:650;}
.jadense-translation-source .jadense-translation-text {margin:0 0 4px;}
.jadense-translation-result[data-error="true"] {color:var(--jdx-reader-error,#b42318);}
.jadense-translation-markdown:not([data-error="true"]) {white-space:normal;}
.jadense-translation-markdown:not([data-error="true"]) > :first-child {margin-top:0;}
.jadense-translation-markdown:not([data-error="true"]) > :last-child {margin-bottom:0;}
.jadense-translation-markdown p,.jadense-translation-markdown ul,.jadense-translation-markdown ol,.jadense-translation-markdown blockquote,.jadense-translation-markdown pre,.jadense-translation-markdown table {margin:0 0 10px;}
.jadense-translation-markdown ul,.jadense-translation-markdown ol {padding-inline-start:22px;}
.jadense-translation-markdown blockquote {border-inline-start:3px solid var(--jdx-reader-border,rgba(17,21,16,.2));padding-inline-start:10px;color:var(--jdx-reader-muted,currentColor);}
.jadense-translation-markdown code {border-radius:3px;padding:1px 4px;background:var(--jdx-reader-hover,rgba(17,21,16,.07));font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em;}
.jadense-translation-markdown pre {max-width:100%;overflow:auto;border-radius:5px;padding:9px;background:var(--jdx-reader-hover,rgba(17,21,16,.07));}
.jadense-translation-markdown pre code {padding:0;background:transparent;white-space:pre;}
.jadense-translation-markdown table {display:block;max-width:100%;overflow:auto;border-collapse:collapse;}
.jadense-translation-markdown th,.jadense-translation-markdown td {border:1px solid var(--jdx-reader-line,rgba(17,21,16,.12));padding:4px 6px;text-align:start;}
.jadense-translation-markdown a {color:inherit;text-decoration:underline;text-underline-offset:2px;}
.jadense-translation-markdown .katex {font-size:1.04em;}
.jadense-translation-markdown .katex-display {display:block;max-width:100%;overflow-x:auto;overflow-y:hidden;margin:10px 0;padding-block:2px;}
.jadense-translation-markdown .jdx-math-error {color:var(--jdx-reader-error,#b42318);}
.jadense-translation-actions {display:flex;align-items:center;gap:8px;justify-content:flex-end;padding:9px 12px;border-top:1px solid var(--jdx-reader-line,rgba(17,21,16,.12));}
.jadense-translation-languages {display:inline-flex;align-items:center;gap:4px;min-width:0;}
[data-jadense-reader-tools] .jadense-translation-languages {margin-inline-start:4px;padding-inline-start:5px;border-inline-start:1px solid var(--jdx-reader-line,rgba(17,21,16,.12));}
.jadense-translation-languages select {box-sizing:border-box;width:82px;min-width:0;height:28px;padding:2px 3px;border:1px solid var(--jdx-reader-line,rgba(17,21,16,.12));border-radius:5px;color:inherit;background:var(--jdx-reader-background,Canvas);font:calc(12px * var(--jdx-font-scale,1)) system-ui,sans-serif;}
.jadense-translation-languages select:focus-visible {outline:2px solid var(--jdx-reader-text,CanvasText);outline-offset:1px;}
[data-jadense-reader-tools] select {box-sizing:border-box;max-width:100%;min-width:0;padding:4px 6px;border:1px solid var(--jdx-reader-line);border-radius:5px;background:var(--jdx-reader-background,Canvas);color:inherit;font:inherit;}
[data-jadense-reader-tools="renderTextSelectionPopup"] > select {flex:1 1 100%;width:100%;}
[data-jadense-translation-panel] header {flex-wrap:wrap;gap:6px;}
[data-jadense-sentence-languages] {flex-basis:100%;flex-wrap:wrap;}
[data-jadense-sentence-languages] button {margin-inline-start:auto;}
.jadense-translation-language-hint {flex-basis:100%;margin:0;color:var(--jdx-reader-muted,currentColor);font-size:calc(11px * var(--jdx-font-scale,1));}
[data-jadense-reader-tools] .jadense-reader-actions-toggle {display:none;width:28px;padding:0;font-size:14px;letter-spacing:1px;}
.jadense-reader-actions {display:inline-flex;align-items:center;gap:2px;color:var(--jdx-reader-text,CanvasText);}
[data-jadense-reader-tools][data-compact=true] > .jadense-reader-actions {display:none;}
[data-jadense-reader-tools][data-compact=true] > .jadense-reader-actions-toggle {display:inline-flex;}
[data-jadense-action-menu] {position:fixed;z-index:10003;display:flex;flex-direction:column;align-items:stretch;gap:3px;box-sizing:border-box;width:max-content;min-width:170px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow-y:auto;padding:6px;border:1px solid var(--jdx-reader-line);border-radius:9px;background:var(--jdx-reader-background,Canvas);box-shadow:0 8px 28px rgba(0,0,0,.18);}
[data-jadense-action-menu] > button {justify-content:flex-start;min-height:34px;height:auto;padding:9px 10px;white-space:normal;text-align:start;}

`

const READER_ACTION_ICONS: Record<ReaderToolbarAction["kind"], string> = {
  fullTranslate: "M4 3h16v18H4z M8 7h8 M8 11h8 M8 15h6",
  references: "M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h6",
  attach: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M8 9h8 M8 13h5",
  analyze: "M11 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8l6 6v3 M14 2v6h6 M8 12h2 M8 16h1 M20 16a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M19 19l3 3",
  translate: "M3 5h12 M9 3v2 M5 5c0 5 6 9 8 9 M13 5c0 5-6 9-8 9 M14 21l4-10 4 10 M15.5 17h5",
  quote: "M4 6h6v7H6c0 3-1 5-3 6 M4 6v7 M14 6h6v7h-4c0 3-1 5-3 6 M14 6v7",
}

let readerBrandSequence = 0

/** 用 reader 自己的 document 构建品牌 SVG；独立渐变 ID 避免多次渲染相互引用。 */
function brandIcon(doc: Document): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg"
  const svg = doc.createElementNS(namespace, "svg")
  for (const [name, value] of Object.entries({
    viewBox: "0 0 575 552", width: "20", height: "20", "aria-hidden": "true", focusable: "false",
  })) svg.setAttribute(name, value)
  const definitions = doc.createElementNS(namespace, "defs")
  svg.append(definitions)
  const prefix = `jadense-reader-brand-${++readerBrandSequence}`
  JADENSE_BRAND_PARTS.forEach((part, index) => {
    const gradient = doc.createElementNS(namespace, "linearGradient")
    const id = `${prefix}-${index}`
    for (const [name, value] of Object.entries({ id, gradientUnits: "userSpaceOnUse", ...part.coordinates })) {
      gradient.setAttribute(name, value)
    }
    for (const [offset, color] of part.stops) {
      const stop = doc.createElementNS(namespace, "stop")
      stop.setAttribute("offset", offset)
      stop.setAttribute("stop-color", color)
      gradient.append(stop)
    }
    definitions.append(gradient)
    const path = doc.createElementNS(namespace, "path")
    path.setAttribute("d", part.path)
    path.setAttribute("fill", `url(#${id})`)
    svg.append(path)
  })
  return svg
}

/** 简阅入口沿用工作台「阅读」的书本图形，同一语义在插件各处保持同一图标。 */
const SIMPLE_READING_ICON = "M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3zM12 6v15"

/** 对照翻译使用常见的 Languages 图标，路径与提供的 languages.svg 一致。 */
const LANGUAGES_ICON = [
  "m5 8 6 6",
  "m4 14 6-6 2-3",
  "M2 5h12",
  "M7 2h1",
  "m22 22-5-10-5 10",
  "M14 18h6",
] as const

/** 统一线性图标仅作装饰；完整动作名仍由原生 button 的 aria-label/title 承担。 */
function lineIcon(doc: Document, d: string | readonly string[], strokeWidth = "1.7"): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": strokeWidth,
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
  })) svg.setAttribute(name, value)
  for (const pathData of typeof d === "string" ? [d] : d) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", pathData)
    svg.append(path)
  }
  return svg
}

function actionIcon(doc: Document, kind: ReaderToolbarAction["kind"]): SVGSVGElement {
  return lineIcon(doc, READER_ACTION_ICONS[kind])
}

/** 文章与本句使用相同的原生语言选择框；仅源语言提供自动识别。 */
function translationLanguageControls(doc: Document, scope: "文章" | "本句") {
  const element = doc.createElement("span")
  element.className = "jadense-translation-languages"
  element.setAttribute(scope === "文章" ? "data-jadense-article-languages" : "data-jadense-sentence-languages", "")
  element.setAttribute("role", "group")
  const scopeLabel = uiText(scope, scope === "文章" ? "Document " : "Selection ")
  element.setAttribute("aria-label", uiText(`${scope}翻译语言`, `${scopeLabel}translation languages`))
  const select = (label: string, source: boolean) => {
    const control = doc.createElement("select")
    control.setAttribute("aria-label", `${scopeLabel}${label}`)
    control.title = `${scopeLabel}${label}`
    for (const language of source ? [{ value: "auto", label: "自动识别" }, ...TRANSLATION_LANGUAGES] : TRANSLATION_LANGUAGES) {
      const option = doc.createElement("option")
      option.value = language.value
      option.textContent = translationLanguageDisplayLabel(language.value)
      control.append(option)
    }
    return control
  }
  const source = select(uiText("源语言", "source language"), true)
  const target = select(uiText("目标语言", "target language"), false)
  const arrow = doc.createElement("span")
  arrow.textContent = "→"
  arrow.setAttribute("aria-hidden", "true")
  element.append(source, arrow, target)
  const set = (languages: TranslationLanguages) => {
    source.value = languages.sourceLanguage
    target.value = languages.targetLanguage
  }
  set(DEFAULT_TRANSLATION_LANGUAGES)
  return {
    element, source, target, set,
    get: () => normalizeTranslationLanguages({ sourceLanguage: source.value, targetLanguage: target.value }),
    disable: (disabled: boolean) => { source.disabled = disabled; target.disabled = disabled },
  }
}

/** 在原生扩展插槽内追加小型按钮；不重排 Zotero 自有控件，卸载时移除监听与 DOM。 */
export function registerReaderTools(
  zotero: ZoteroReaderHost,
  pluginID: string,
  onAction: (action: ReaderAction, hooks?: ReaderActionHooks) => void | ReaderActionResult | Promise<void | ReaderActionResult>,
  onOpenManager?: (section?: 'settings-connection') => void,
): () => void {
  initializeUiLocale(zotero)
  const themeCleanups = new Map<HTMLElement, () => void>()
  const themeRoot = (root: HTMLElement) => {
    root.setAttribute("data-jadense-reader-theme", "")
    themeCleanups.set(root, observeTheme(zotero, root))
  }
  const nodes = new Set<HTMLElement>()
  const handlers = new Map<ReaderEventType, ReaderHandler>()
  const shortcutCleanups = new Map<Document, () => void>()
  const analysisCleanups = new Map<HTMLElement, () => void>()
  const toolbarMenus = new Map<HTMLElement, ReturnType<typeof bindReaderActionMenu>>()
  const selectionAnchors = new Map<Document, () => { left: number; top: number; bottom: number } | undefined>()
  const automaticSelections = new Map<Document, { key: string; group: HTMLElement; timer: ReturnType<typeof setTimeout> }>()
  const selectionJobs = new Map<Document, AbortController>()
  const preparedSelections = new WeakSet<ReaderToolbarAction>()
  const documents = new Map<Document, {
    show: (anchor: HTMLElement, text: string) => void
    hide: () => void
    dismiss: () => boolean
    beginTranslation: (selection: ReaderToolbarAction) => number
    setTranslationLanguages: (requestID: number, languages: TranslationLanguages) => boolean
    setTranslationSource: (requestID: number, selection: ReaderToolbarAction) => boolean
    updateTranslation: (requestID: number, text: string) => void
    updateProgress: (requestID: number, progress: RequestProgress) => void
    finishTranslation: (requestID: number, text: string, error?: boolean) => void
    remove: () => void
    reposition: () => void
    refreshSettings: () => void
  }>()
  let active = true
  const refreshSettings = () => {
    for (const entry of documents.values()) entry.refreshSettings()
  }
  let settingsObserver: unknown
  try { settingsObserver = zotero.Prefs?.registerObserver?.(SELECTION_PREF, refreshSettings, true) } catch { /* 无观察器时仍在每次调用读取偏好。 */ }
  // 每个 reader document 共享一份 CSS 和就地提示，避免选区弹出层反复创建样式。
  const documentTools = (doc: Document) => {
    const existing = documents.get(doc)
    if (existing) return existing
    const style = doc.createElement("style")
    style.setAttribute("data-jadense-reader-style", "")
    style.textContent = READER_TOOLS_CSS
    const styleHost = doc.head || doc.documentElement
    styleHost.append(style)
    const noticeHost = doc.body || doc.documentElement
    const translationPanel = doc.createElement("aside")
    translationPanel.setAttribute("data-jadense-translation-panel", "")
    translationPanel.setAttribute("role", "region")
    translationPanel.setAttribute("aria-label", uiText("智能翻译结果", "AI translation result"))
    translationPanel.hidden = true
    const translationHeader = doc.createElement("header")
    const translationTitle = doc.createElement("strong")
    translationTitle.textContent = uiText("智能翻译", "AI translation")
    const translationClose = doc.createElement("button")
    translationClose.type = "button"
    translationClose.className = "jadense-translation-close"
    translationClose.setAttribute("aria-label", uiText("关闭翻译浮窗", "Close translation panel"))
    translationClose.title = uiText("关闭", "Close")
    translationClose.textContent = "×"
    translationHeader.append(translationTitle, translationClose)
    const sentenceLanguages = translationLanguageControls(doc, "本句")
    const retranslate = doc.createElement("button")
    retranslate.type = "button"
    retranslate.textContent = uiText("重新翻译", "Translate again")
    retranslate.disabled = true
    sentenceLanguages.element.append(retranslate)
    const languageHint = doc.createElement("p")
    languageHint.className = "jadense-translation-language-hint"
    languageHint.textContent = uiText("语言修改仅用于当前选文。", "Language changes apply to this selection only.")
    const progressText = doc.createElement('p'), stopTranslation = doc.createElement('button')
    progressText.setAttribute('role', 'status'); progressText.className = 'jadense-translation-language-hint'
    stopTranslation.type = 'button'; stopTranslation.textContent = uiText('停止', 'Stop'); stopTranslation.hidden = true
    stopTranslation.addEventListener('click', () => { const controller = selectionJobs.get(doc); markDiagnosticAbort(controller?.signal, 'user_stop'); controller?.abort() })
    translationHeader.append(sentenceLanguages.element, languageHint, progressText, stopTranslation)
    const translationContent = doc.createElement("div")
    translationContent.className = "jadense-translation-content"
    const resultLabel = doc.createElement("p")
    resultLabel.className = "jadense-translation-label"
    resultLabel.textContent = uiText("译文", "Translation")
    const resultText = doc.createElement("div")
    resultText.className = "jadense-translation-text jadense-translation-result jadense-translation-markdown"
    resultText.setAttribute("aria-live", "polite")
    const sourceSection = doc.createElement("details")
    sourceSection.className = "jadense-translation-source"
    const sourceLabel = doc.createElement("summary")
    sourceLabel.textContent = uiText("原文", "Original")
    const sourceText = doc.createElement("div")
    sourceText.className = "jadense-translation-text jadense-translation-markdown"
    sourceSection.append(sourceLabel, sourceText)
    translationContent.append(resultLabel, resultText, sourceSection)
    const translationActions = doc.createElement("footer")
    translationActions.className = "jadense-translation-actions"
    const copyTranslation = doc.createElement("button")
    copyTranslation.type = "button"
    copyTranslation.textContent = uiText("复制译文", "Copy translation")
    copyTranslation.disabled = true
    const appearance = translationAppearanceControl(zotero as unknown as ZoteroLike, doc)
    translationActions.append(appearance.element, copyTranslation)
    translationPanel.append(translationHeader, translationContent, translationActions)
    noticeHost.append(translationPanel)
    const interaction = makeTranslationWindowInteractive(translationPanel, translationHeader, {
      read: () => readSelectionPreferences(zotero),
      save: (geometry, moved) => {
        saveSelectionPreferences(zotero, { geometry, ...(moved ? { placement: 'remember' as const } : {}) })
        if (moved) placement.value = 'remember'
      },
    })
    const placement = doc.createElement('select')
    placement.setAttribute('aria-label', uiText('浮窗位置', 'Panel position'))
    for (const [value, label] of [['remember', uiText('记住窗口位置', 'Remember position')], ['selection', uiText('跟随选中文本', 'Near selection')]]) {
      const option = doc.createElement('option'); option.value = value; option.textContent = label; placement.append(option)
    }
    placement.value = readSelectionPreferences(zotero).placement
    placement.addEventListener('change', () => { saveSelectionPreferences(zotero, { placement: placement.value === 'selection' ? 'selection' : 'remember' }); interaction.clamp() })
    const placementLabel = doc.createElement('label')
    placementLabel.textContent = uiText('浮窗位置', 'Panel position')
    placementLabel.append(placement)
    appearance.element.querySelector('.jdx-window-appearance-menu')?.append(placementLabel)
    themeRoot(translationPanel)
    let latestProgress: (RequestProgress & { startedAt: number }) | undefined
    const refreshProgress = () => { if (latestProgress && !stopTranslation.hidden) progressText.textContent = `${requestStageLabel(latestProgress.stage)} · ${Math.max(0, Math.floor((Date.now() - latestProgress.startedAt) / 1000))}s · ${uiText('已接收正文', 'Text received')} ${latestProgress.receivedCharacters ?? 0}` }
    const progressTimer = doc.defaultView?.setInterval?.(refreshProgress, 1000)
    let translationRequestID = 0
    let translationError = false
    let translationMarkdown = ""
    let translationSelection: ReaderToolbarAction | undefined
    let noticeHandle: ToastHandle | undefined
    let noticeVisible = false
    const renderTranslationMarkdown = (text: string, target = resultText) => {
      try { updateChatMarkdown(target, text) } catch { target.textContent = text }
    }
    const hide = () => {
      noticeHandle?.close()
      noticeHandle = undefined
      noticeVisible = false
    }
    const closeTranslation = () => { markDiagnosticAbort(selectionJobs.get(doc)?.signal, "user_stop"); selectionJobs.get(doc)?.abort(); translationRequestID += 1; appearance.close(); translationPanel.hidden = true }
    const dismiss = () => {
      if (appearance.close()) return true
      for (const [node, menu] of toolbarMenus) if (node.ownerDocument === doc && menu.close()) return true
      if (!translationPanel.hidden) { closeTranslation(); return true }
      if (noticeVisible) { hide(); return true }
      return false
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      dismiss()
    }
    translationClose.addEventListener("click", closeTranslation)
    const changeSentenceLanguages = () => {
      if (!translationSelection) return
      // 语言一经改变，旧请求的增量和结束事件均失效，下一次发送仍引用原选文快照。
      translationRequestID += 1
      translationMarkdown = ""
      translationError = false
      resultText.textContent = uiText("语言已修改，点击「重新翻译」。", "Languages changed. Click “Translate again”.")
      resultText.setAttribute("data-error", "false")
      copyTranslation.disabled = true
      retranslate.disabled = false
    }
    sentenceLanguages.source.addEventListener("change", changeSentenceLanguages)
    sentenceLanguages.target.addEventListener("change", changeSentenceLanguages)
    retranslate.addEventListener("click", () => {
      if (!translationSelection || retranslate.disabled) return
      const next = { ...translationSelection, languages: sentenceLanguages.get() }
      if (preparedSelections.has(translationSelection)) preparedSelections.add(next)
      const regions = selectionRegions.get(translationSelection)
      if (regions) selectionRegions.set(next, regions)
      translate(doc, retranslate, next)
    })
    copyTranslation.addEventListener("click", () => {
      const value = translationError ? "" : translationMarkdown.trim()
      if (!value) return
      void doc.defaultView?.navigator.clipboard?.writeText(value)
    })
    const remove = () => {
      markDiagnosticAbort(selectionJobs.get(doc)?.signal, "reader_selection_changed"); selectionJobs.get(doc)?.abort(); selectionJobs.delete(doc)
      clearTimeout(automaticSelections.get(doc)?.timer); automaticSelections.delete(doc); selectionAnchors.delete(doc)
      hide()
      for (const [root, stop] of themeCleanups) if (root.ownerDocument === doc) { stop(); themeCleanups.delete(root) }
      shortcutCleanups.get(doc)?.()
      doc.removeEventListener("keydown", onKeyDown)
      doc.defaultView?.removeEventListener("pagehide", remove)
      style.remove()
      appearance.remove()
      interaction.remove()
      doc.defaultView?.clearInterval?.(progressTimer)
      translationPanel.remove()
      removeDocumentSurfaces(doc)
      for (const node of nodes) if (node.ownerDocument === doc) {
        toolbarMenus.get(node)?.remove(); analysisCleanups.get(node)?.(); analysisCleanups.delete(node)
        node.remove(); nodes.delete(node); toolbarMenus.delete(node)
      }
      documents.delete(doc)
    }
    const entry = {
      reposition: interaction.clamp,
      refreshSettings: () => { placement.value = readSelectionPreferences(zotero).placement; interaction.clamp() },
      hide,
      dismiss,
      remove,
      beginTranslation: (selection: ReaderToolbarAction) => {
        latestProgress = { stage: 'queued', startedAt: Date.now(), receivedCharacters: 0 }; stopTranslation.hidden = false; refreshProgress()
        translationRequestID += 1
        translationSelection = selection
        sourceSection.open = false
        renderTranslationMarkdown(selection.text ?? "", sourceText)
        sentenceLanguages.set(selection.languages ?? DEFAULT_TRANSLATION_LANGUAGES)
        sentenceLanguages.disable(true)
        retranslate.disabled = true
        translationMarkdown = ""
        resultText.textContent = uiText("正在翻译…", "Translating…")
        translationError = false
        resultText.setAttribute("data-error", "false")
        copyTranslation.disabled = true
        translationPanel.hidden = false
        placement.value = readSelectionPreferences(zotero).placement
        interaction.open(selectionAnchors.get(doc))
        return translationRequestID
      },
      setTranslationLanguages: (requestID: number, languages: TranslationLanguages) => {
        if (requestID !== translationRequestID || translationPanel.hidden) return false
        sentenceLanguages.set(languages)
        sentenceLanguages.disable(false)
        return true
      },
      setTranslationSource: (requestID: number, selection: ReaderToolbarAction) => {
        if (requestID !== translationRequestID || translationPanel.hidden) return false
        translationSelection = selection
        renderTranslationMarkdown(selection.text ?? '', sourceText)
        return true
      },
      updateTranslation: (requestID: number, text: string) => {
        if (requestID !== translationRequestID || translationPanel.hidden || !text) return
        translationMarkdown = text
        renderTranslationMarkdown(text)
      },
      updateProgress: (requestID: number, progress: RequestProgress) => { if (requestID !== translationRequestID) return; latestProgress = { ...latestProgress, ...progress, startedAt: latestProgress?.stage === progress.stage ? latestProgress.startedAt : Date.now() }; refreshProgress() },
      finishTranslation: (requestID: number, text: string, error = false) => {
        if (requestID !== translationRequestID) return
        stopTranslation.hidden = true; progressText.textContent = error ? text : ''
        translationMarkdown = error ? translationMarkdown : text
        const displayText = text || (error ? uiText("翻译未完成。", "Translation did not complete.") : uiText("AI 没有返回可显示的译文。", "The AI did not return a translation."))
        if (error && translationMarkdown) renderTranslationMarkdown(translationMarkdown)
        else if (error || !text) resultText.textContent = displayText
        else renderTranslationMarkdown(displayText)
        translationError = error
        resultText.setAttribute("data-error", String(error))
        copyTranslation.disabled = !translationMarkdown.trim()
        retranslate.disabled = false
      },
      show: (anchor: HTMLElement, message: string) => {
        hide()
        const rect = anchor.getBoundingClientRect()
        noticeHandle = showToast({ document: doc, themeRoot: translationPanel, message, duration: 5000, anchor: { left: rect.left, top: rect.top, height: rect.height }, onClose: () => { noticeVisible = false; noticeHandle = undefined } })
        noticeVisible = true
      },
    }
    documents.set(doc, entry)
    doc.addEventListener("keydown", onKeyDown)
    doc.defaultView?.addEventListener("pagehide", remove, { once: true })
    return entry
  }
  /** 点击与快捷键共用翻译请求、流式浮窗与本地错误，避免产生第二条对话入口。 */
  const translate = (doc: Document, anchor: HTMLElement, selection: ReaderToolbarAction) => {
    if (!active) return
    const feedback = documentTools(doc)
    if (!selection.text) {
      feedback.show(anchor, uiText("请先选中文献中的文字，再使用翻译。", "Select text in the document before translating."))
      return
    }
    feedback.hide()
    markDiagnosticAbort(selectionJobs.get(doc)?.signal, "reader_selection_changed")
    selectionJobs.get(doc)?.abort()
    const controller = new AbortController(); selectionJobs.set(doc, controller)
    const requestID = feedback.beginTranslation(selection)
    controller.signal.addEventListener('abort', () => {
      if (active && documents.has(doc)) feedback.finishTranslation(requestID, uiText('选文提取已取消；可重新翻译或选择新文本。', 'Selection extraction cancelled. Translate again or select new text.'), true)
    }, { once: true })
    void Promise.resolve().then(async () => {
      const prepared = preparedSelections.has(selection) ? selection : await enhanceSelection(zotero as unknown as ZoteroLike, selection,
        selectionRegions.get(selection), controller.signal, text => feedback.updateTranslation(requestID, text), text => feedback.show(anchor, text))
      if (controller.signal.aborted || !active || !documents.has(doc) || !feedback.setTranslationSource(requestID, prepared)) return undefined
      if (prepared !== selection) preparedSelections.add(prepared)
      const regions = selectionRegions.get(selection)
      if (regions) selectionRegions.set(prepared, regions)
      const languages = selection.languages
        ? normalizeTranslationLanguages(selection.languages)
        : await readArticleTranslationLanguages(zotero, selection.itemID)
      if (controller.signal.aborted || !active || !documents.has(doc)) return undefined
      if (!feedback.setTranslationLanguages(requestID, languages)) return undefined
      if (selectionJobs.get(doc) === controller) selectionJobs.delete(doc)
      return onAction({ ...prepared, languages }, { signal: controller.signal, onTranslationProgress: progress => feedback.updateProgress(requestID, progress), onTranslationText: (text) => feedback.updateTranslation(requestID, text) })
    }).then((result) => {
      if (controller.signal.aborted || !active || !documents.has(doc)) return
      feedback.finishTranslation(requestID, result && typeof result === "object" ? result.translation?.trim() ?? "" : "")
    }).catch((error) => {
      if (controller.signal.aborted) return
      if (!active || !documents.has(doc)) return
      feedback.finishTranslation(requestID, error instanceof Error ? error.message : uiText("翻译未完成，请稍后重试。", "Translation did not complete. Please try again."), true)
    })
  }
  /** 手动引用和自动引用共享 OCR 准备，旧选区或已关闭 Reader 的结果不得继续打开对话。 */
  const quote = (doc: Document, anchor: HTMLElement, selection: ReaderToolbarAction, send: (value: ReaderToolbarAction) => unknown) => {
    markDiagnosticAbort(selectionJobs.get(doc)?.signal, "reader_selection_changed")
    selectionJobs.get(doc)?.abort()
    const controller = new AbortController(); selectionJobs.set(doc, controller)
    const feedback = documentTools(doc)
    void enhanceSelection(zotero as unknown as ZoteroLike, selection, selectionRegions.get(selection), controller.signal,
      text => feedback.show(anchor, text), text => feedback.show(anchor, text)).then(value => {
      if (!active || controller.signal.aborted || !documents.has(doc)) return
      if (selectionJobs.get(doc) === controller) selectionJobs.delete(doc)
      if (value !== selection) feedback.hide()
      return send(value)
    }).catch(error => {
      if (active && !controller.signal.aborted && documents.has(doc)) feedback.show(anchor, error instanceof Error ? error.message : String(error))
    })
  }
  /** PDF iframe 不向外层冒泡键盘事件；跟随主视图/分屏加载并在卸载时解除监听。 */
  const bindTranslationShortcut = (event: ReaderEvent) => {
    const { doc, reader } = event
    if (shortcutCleanups.has(doc)) return
    const bindings = new Map<NonNullable<ReaderPdfView["_iframeWindow"]>, EventListener>()
    const reposition = () => documents.get(doc)?.reposition()
    const clearSelection = () => { markDiagnosticAbort(selectionJobs.get(doc)?.signal, "reader_selection_changed"); selectionJobs.get(doc)?.abort(); clearTimeout(automaticSelections.get(doc)?.timer); automaticSelections.delete(doc) }
    let disposed = false
    const bind = (win: ReaderPdfView["_iframeWindow"], primary?: boolean) => {
      if (!win?.addEventListener || bindings.has(win)) return
      const handler: EventListener = (raw) => {
        const key = raw as KeyboardEvent
        if (disposed || !active) return
        // 快捷键翻译保持 PDF 焦点，Escape 需转交外层浮窗，同时允许图片层自行取消。
        if (primary !== undefined && key.key === "Escape" && documents.get(doc)?.dismiss()) {
          key.preventDefault()
          key.stopPropagation()
          return
        }
        if (!matchesReaderShortcut(key, readReaderShortcut(zotero, "translate"))) return
        key.preventDefault()
        key.stopImmediatePropagation()
        selectionAnchors.set(doc, selectionAnchor(reader, doc.body || doc.documentElement, undefined, primary))
        translate(doc, doc.body || doc.documentElement, selectedAction("translate", reader, undefined, primary))
      }
      win.addEventListener("keydown", handler, true)
      win.addEventListener('scroll', reposition, true)
      win.addEventListener('resize', reposition)
      if (primary !== undefined) win.addEventListener('pointerdown', clearSelection, true)
      bindings.set(win, handler)
    }
    const refresh = async () => {
      try {
        await reader._initPromise
        const internal = reader._internalReader
        const views = [internal?._primaryView, internal?._secondaryView]
        if (disposed || !active) return
        for (const [win, handler] of bindings) {
          if (win !== doc.defaultView && !views.some((view) => view?._iframeWindow === win)) {
            win.removeEventListener?.("keydown", handler, true)
            win.removeEventListener?.('scroll', reposition, true); win.removeEventListener?.('resize', reposition)
            win.removeEventListener?.('pointerdown', clearSelection, true)
            bindings.delete(win)
          }
        }
        await Promise.all(views.map(async (view, index) => {
          try {
            await view?.initializedPromise
            const current = index === 0 ? reader._internalReader?._primaryView : reader._internalReader?._secondaryView
            if (!disposed && active && view && view === current) bind(view._iframeWindow, index === 0)
          } catch { /* 一个分屏初始化失败不影响另一视图的快捷键。 */ }
        }))
      } catch { /* 私有阅读器不可用时仅缺少快捷键，普通按钮仍可工作。 */ }
    }
    const onLoad = () => { void refresh() }
    const Observer = doc.defaultView?.MutationObserver
    let observer: MutationObserver | undefined
    try {
      if (Observer && doc.body) {
        // Reader 外层 document 来自原生 customEvent，字典也必须属于它的 Window realm。
        const options = new doc.defaultView!.Object() as MutationObserverInit
        options.childList = true
        options.subtree = true
        observer = new Observer(onLoad)
        observer.observe(doc.body, options)
      }
    } catch {
      observer?.disconnect()
      observer = undefined
      // 分屏观察是可选增强；不能阻止 renderToolbar 回调追加已有阅读工具。
    }
    doc.addEventListener("load", onLoad, true)
    bind(doc.defaultView ?? undefined)
    shortcutCleanups.set(doc, () => {
      disposed = true
      observer?.disconnect()
      doc.removeEventListener("load", onLoad, true)
      for (const [win, handler] of bindings) {
        win.removeEventListener?.("keydown", handler, true)
        win.removeEventListener?.('scroll', reposition, true); win.removeEventListener?.('resize', reposition)
        win.removeEventListener?.('pointerdown', clearSelection, true)
      }
      bindings.clear()
      shortcutCleanups.delete(doc)
    })
    void refresh()
  }
  const cleanup = () => {
    active = false
    stopPDFTranslationReaders()
    stopSimpleReadingReaders()
    stopSimpleReadingJobs(zotero as unknown as ZoteroLike)
    stopPDFTranslationJobs(zotero as unknown as ZoteroLike)
    try { if (settingsObserver !== undefined) zotero.Prefs?.unregisterObserver?.(settingsObserver) } catch { /* 清理其他资源。 */ }
    for (const [type, handler] of handlers) {
      try { zotero.Reader?.unregisterEventListener?.(type, handler) } catch { /* 继续清理其他监听。 */ }
    }
    handlers.clear()
    for (const entry of documents.values()) { try { entry.remove() } catch { /* 已销毁窗口不阻止其他 reader 清理。 */ } }
    documents.clear()
    for (const node of nodes) { try { node.remove() } catch { /* 阅读器窗口可能已经关闭。 */ } }
    nodes.clear()
    for (const stop of analysisCleanups.values()) { try { stop() } catch { /* 已关闭窗口不阻断其余清理。 */ } }
    analysisCleanups.clear()
    for (const stop of themeCleanups.values()) { try { stop() } catch { /* 已关闭窗口不阻断其余清理。 */ } }
    themeCleanups.clear()
  }
  if (!zotero.Reader?.registerEventListener) { const trace = lifecycleTrace(zotero, 'initialization', 'reader_tools'); trace.fail(new Error('Reader API unavailable'), 'reader_api_missing', 'READER_API_UNAVAILABLE'); trace.end('error'); return cleanup }
  const actions = [
    { kind: "attach", label: uiText("发起新对话，向 AI 提问（当前文献）", "Start a new AI chat about this document"), short: uiText("提问", "Ask") },
    { kind: "analyze", label: uiText("解析文献", "Analyze document"), short: uiText("解析", "Analyze") },
    { kind: "translate", label: uiText("智能翻译", "AI translation"), short: uiText("翻译", "Translate") },
    { kind: "quote", label: uiText("引用选文", "Quote selection"), short: uiText("引用", "Quote") },
  ] as const
  for (const type of ["renderToolbar", "renderTextSelectionPopup"] as const) {
    const handler: ReaderHandler = (event) => {
      if (!active || !Number.isInteger(event.reader.itemID)) return
      if (type === 'renderToolbar') void silentlyCheckForUpdates(event.doc, zotero, pluginID)
      for (const node of nodes) if (!node.isConnected) {
        toolbarMenus.get(node)?.remove(); analysisCleanups.get(node)?.(); analysisCleanups.delete(node)
        for (const [root, stop] of themeCleanups) if (root === node || node.contains?.(root)) { stop(); themeCleanups.delete(root) }
        nodes.delete(node); toolbarMenus.delete(node)
      }
      const feedback = documentTools(event.doc)
      if (type === "renderToolbar") bindTranslationShortcut(event)
      const group = event.doc.createElement("span")
      group.setAttribute("data-jadense-reader-tools", type)
      themeRoot(group)
      group.setAttribute("role", "group")
      group.setAttribute("aria-label", uiText("Jadense 阅读工具", "Jadense reading tools"))
      if (type === "renderToolbar") {
        const brand = event.doc.createElement("button")
        brand.type = "button"
        brand.className = "jadense-reader-brand"
        brand.title = uiText("打开攻玉工作台", "Open Jadense workspace")
        brand.setAttribute("aria-label", brand.title)
        const icon = brandIcon(event.doc), stateLabel = event.doc.createElement('span')
        stateLabel.className = 'jadense-reader-runtime-label'
        stateLabel.setAttribute('role', 'status')
        brand.append(icon, stateLabel)
        const runtime = analysisRuntime(zotero as unknown as ZoteroLike)
        const stop = event.doc.createElement('button')
        stop.type = 'button'; stop.className = 'jadense-reader-runtime-stop'; stop.textContent = '■'
        stop.title = uiText('停止本次解析', 'Stop analysis'); stop.setAttribute('aria-label', stop.title)
        stop.addEventListener('click', () => runtime.stop(event.reader.itemID))
        const update = () => {
          const run = runtime.get(event.reader.itemID)
          brand.dataset.runtime = run ? run.busy ? run.retrying ? 'retrying' : 'running' : run.error ? 'error' : 'complete' : 'idle'
          brand.setAttribute('aria-busy', String(Boolean(run?.busy)))
          stateLabel.textContent = run ? run.busy ? run.message.replace('已收到 ', '').replace(' 字符', ' 字').replace('characters received', 'chars') : run.error ? uiText('解析异常 · 查看详情', 'Analysis issue · Details') : uiText('查看解析', 'View analysis') : ''
          brand.title = run ? `${run.message} · ${uiText('点击查看', 'Click to view')}` : uiText('打开攻玉工作台', 'Open Jadense workspace')
          brand.setAttribute('aria-label', brand.title)
          stop.hidden = !run?.busy
        }
        analysisCleanups.set(group, runtime.subscribe(update)); update()
        // 仅打开或聚焦工作台，不触发阅读器提问，也不附加当前文献。
        brand.addEventListener("click", () => {
          if (!active) return
          toolbarMenus.get(group)?.close()
          feedback.hide()
          if (runtime.get(event.reader.itemID)) {
            void openAnalysisSidebar(zotero as unknown as ZoteroLike, event.doc, event.reader.itemID, event.reader as unknown as import('./reader-sidebar').ReaderSidebarSource)
              .catch(error => feedback.show(brand, error instanceof Error ? error.message : String(error)))
            return
          }
          try { onOpenManager?.() } catch {
            feedback.show(brand, uiText("无法打开攻玉工作台，请稍后重试。", "The Jadense workspace could not be opened. Please try again."))
          }
        })
        group.append(brand, stop)
      }
      const actionList = type === "renderToolbar" ? event.doc.createElement("span") : group
      if (actionList !== group) {
        actionList.className = "jadense-reader-actions jadense-reader-action-menu"
        themeRoot(actionList)
        const toggle = event.doc.createElement("button")
        toggle.type = "button"
        toggle.className = "jadense-reader-actions-toggle"
        toggle.textContent = "•••"
        group.append(toggle, actionList)
      }
      for (const action of actions) {
        if (type === "renderToolbar" && action.kind === "translate") continue
        if (type === "renderTextSelectionPopup" && action.kind !== "translate" && action.kind !== "quote") continue
        const button = event.doc.createElement("button")
        button.type = "button"
        const label = event.doc.createElement("span")
        label.className = "jadense-reader-label"
        label.textContent = type === "renderToolbar" ? action.short : action.label
        button.append(actionIcon(event.doc, action.kind), label)
        button.title = `Jadense · ${action.label}`
        button.setAttribute("aria-label", action.label)
        button.setAttribute("data-jadense-action", action.kind)
        button.addEventListener("mousedown", (mouseEvent) => mouseEvent.preventDefault())
        button.addEventListener("click", () => {
          if (!active) return
          clearTimeout(automaticSelections.get(event.doc)?.timer)
          const selection = selectedAction(action.kind, event.reader, event.params?.annotation)
          toolbarMenus.get(group)?.close()
          const anchor = group.getAttribute("data-compact") === "true"
            ? group.querySelector<HTMLButtonElement>(".jadense-reader-actions-toggle") || button : button
          if ((action.kind === "translate" || action.kind === "quote") && !selection.text) {
            feedback.show(anchor, uiText(`请先选中文献中的文字，再点击「${action.short}」。`, `Select text in the document before clicking “${action.short}”.`))
            return
          }
          feedback.hide()
          if (selection.kind === 'analyze') {
            void analysisRuntime(zotero as unknown as ZoteroLike).start(selection.itemID)
            return
          }
          if (selection.kind === 'attach') {
            void openChatSidebar(zotero as unknown as ZoteroLike, event.doc, selection.itemID, event.reader as unknown as import('./reader-sidebar').ReaderSidebarSource)
              .catch(error => feedback.show(anchor, error instanceof Error ? error.message : String(error)))
            return
          }
          // 在原生点击同步阶段保留选区；让焦点变化或 popup 关闭发生后仍引用同一段文字。
          if (selection.kind === "translate") {
            translate(event.doc, anchor, selection)
            return
          }
          if (selection.kind === 'quote') { quote(event.doc, anchor, selection, value => onAction(value)); return }
          void Promise.resolve().then(() => { if (active) return onAction(selection) })
            .catch(() => {
              if (active && documents.has(event.doc)) feedback.show(anchor, uiText("操作未完成，请稍后重试，或打开 Jadense 对话查看。", "The action did not complete. Try again or open Jadense Chat for details."))
            })
        })
        actionList.append(button)
      }
      if (type === 'renderToolbar') {
        const simple = event.doc.createElement('button'), simpleCaption = event.doc.createElement('span')
        simple.type = 'button'; simple.dataset.jadenseSimpleReading = ''; simple.title = uiText('简阅模式', 'Reading mode'); simple.setAttribute('aria-label', simple.title)
        simpleCaption.className = 'jadense-reader-label'; simpleCaption.textContent = simple.title; simple.append(lineIcon(event.doc, SIMPLE_READING_ICON), simpleCaption)
        simple.addEventListener('click', () => {
          if (!active) return
          toolbarMenus.get(group)?.close()
          const anchor = group.getAttribute('data-compact') === 'true' ? group.querySelector<HTMLButtonElement>('.jadense-reader-actions-toggle') || simple : simple
          void openSimpleReading(zotero as unknown as ZoteroLike, event.reader as unknown as Parameters<typeof openSimpleReading>[1])
            .catch(error => feedback.show(anchor, error instanceof Error ? error.message : String(error)))
        })
        actionList.append(simple)
        const label = uiText('对照翻译', 'Bilingual PDF')
        const button = event.doc.createElement('button'), caption = event.doc.createElement('span')
        button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.dataset.jadensePdfMode = 'compare'
        caption.className = 'jadense-reader-label'; caption.textContent = label
        button.append(lineIcon(event.doc, LANGUAGES_ICON, "2"), caption)
        button.addEventListener('click', () => {
          if (!active) return
          toolbarMenus.get(group)?.close()
          const anchor = group.getAttribute('data-compact') === 'true'
            ? group.querySelector<HTMLButtonElement>('.jadense-reader-actions-toggle') || button : button
          void openPDFTranslation(zotero as unknown as ZoteroLike, event.reader as unknown as Parameters<typeof openPDFTranslation>[1], 'compare')
            .catch(error => feedback.show(anchor, error instanceof Error ? error.message : String(error)))
        })
        actionList.append(button)
      }
      nodes.add(group)
      event.append(group)
      // 原生选区 popup 在用户完成选择后渲染；短暂合并重复渲染，避免同一选区重复请求。
      if (type === 'renderTextSelectionPopup') {
        const selection = selectedAction('translate', event.reader, event.params?.annotation)
        const position = event.params?.annotation?.position
        selectionAnchors.set(event.doc, selectionAnchor(event.reader, group, event.params?.annotation))
        const key = JSON.stringify([selection.itemID, selection.pageIndex, selection.text, position, event.reader._internalReader?._lastViewPrimary])
        const previous = automaticSelections.get(event.doc)
        if (previous?.key === key) previous.group = group
        if (previous?.key !== key) {
          markDiagnosticAbort(selectionJobs.get(event.doc)?.signal, "reader_selection_changed"); selectionJobs.get(event.doc)?.abort()
          clearTimeout(previous?.timer)
          const timer = setTimeout(() => {
            const currentGroup = automaticSelections.get(event.doc)?.group
            if (!active || !currentGroup?.isConnected || !selection.text) return
            const behavior = readSelectionPreferences(zotero).behavior
            if (behavior === 'translate') translate(event.doc, group, selection)
            if (behavior === 'quote') quote(event.doc, group, selection, value => openChatSidebar(zotero as unknown as ZoteroLike, event.doc, value.itemID, event.reader as unknown as import('./reader-sidebar').ReaderSidebarSource, { text: value.text!, pageIndex: value.pageIndex, pageLabel: value.pageLabel }))
          }, 350)
          automaticSelections.set(event.doc, { key, group, timer })
        }
      }
      if (actionList !== group) toolbarMenus.set(group, bindReaderActionMenu(group, actionList, group.querySelector<HTMLButtonElement>(".jadense-reader-actions-toggle")!))
    }
    handlers.set(type, handler)
    try { zotero.Reader.registerEventListener(type, handler, pluginID) } catch (error) { const trace = lifecycleTrace(zotero, 'initialization', 'reader_tools'); trace.fail(error, 'reader_registration_failed'); trace.end('error'); cleanup(); break }
  }
  return cleanup
}
