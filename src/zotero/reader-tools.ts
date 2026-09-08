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
  translationLanguageLabel,
  type TranslationLanguages,
} from "@/chat/translation-languages"
import { matchesReaderShortcut, readReaderShortcut } from "./reader-shortcuts"
import { readArticleTranslationLanguages, writeArticleTranslationLanguages } from "./translation-settings"

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
  position?: { pageIndex?: number }
}
type PdfSelectionRange = {
  anchorOffset?: number
  headOffset?: number
  text?: string
  position?: { pageIndex?: number }
}
type ReaderPdfView = {
  initializedPromise?: Promise<unknown>
  _ensureBasicPageData?: (pageIndex: number) => Promise<void>
  _selectionRanges?: PdfSelectionRange[]
  _pdfPages?: Record<number, PdfPage>
  _iframeWindow?: {
    document?: Document
    addEventListener?: Window["addEventListener"]
    removeEventListener?: Window["removeEventListener"]
    PDFViewerApplication?: { pdfDocument?: PdfDocument }
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
export type ZoteroReaderHost = {
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
  kind: "attach" | "quote" | "translate" | "analyze"
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
    const error = new Error("已停止文献解析。")
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
          const error = new Error("已停止文献解析。")
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
    throw new Error("请先选择或打开一个有效的 Zotero PDF 附件。")
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
  const title = metadataField(source, "title", 500) || metadataField(item, "title", 500) || "PDF 文献"
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
  options: { signal?: AbortSignal; onProgress?: (progress: { pagesRead: number; totalPages: number }) => void } = {},
): Promise<PdfAnalysisSnapshot> {
  const { signal, onProgress } = options
  abortIfNeeded(signal)
  const item = await getPdfItem(zotero, itemID)
  let modificationTime: number | null | undefined
  try { modificationTime = await item.attachmentModificationTime } catch { /* 只使用实际可用的文件版本信息。 */ }
  let reader = zotero.Reader?._readers?.find((candidate) => candidate.itemID === itemID)
  if (!reader && zotero.Reader?.open) reader = await withAbort(zotero.Reader.open(itemID), signal)
  reader ??= zotero.Reader?._readers?.find((candidate) => candidate.itemID === itemID)
  if (!reader) throw new Error("PDF 阅读器尚未就绪，请打开该 PDF 后重试解析。")
  if (reader._initPromise) await withAbort(reader._initPromise, signal)
  const view = reader._internalReader?._primaryView
  if (view?.initializedPromise) await withAbort(view.initializedPromise, signal)
  const pdf = view?._iframeWindow?.PDFViewerApplication?.pdfDocument
  if (!view?._ensureBasicPageData || !view._pdfPages || !pdf || !Number.isInteger(pdf.numPages) || pdf.numPages < 1) {
    throw new Error("当前阅读器无法提供 PDF 文字坐标，仍可使用普通对话。")
  }
  let labels: string[] | null = null
  try { labels = pdf.getPageLabels ? await withAbort(pdf.getPageLabels(), signal) : null } catch { abortIfNeeded(signal) }
  const pageIndexes = sampleIndexes(pdf.numPages, Math.min(MAX_PAGES, pdf.numPages))
  const warnings: string[] = []
  const pageNumbers: number[] = []
  const emptyPages: number[] = []
  const candidates: PdfAnalysisPassage[] = []
  for (const pageIndex of pageIndexes) {
    abortIfNeeded(signal)
    try {
      // 传入 primitive，让阅读器自己构造 worker 参数；跨 Gecko compartment 传对象会 DataCloneError。
      await withAbort(view._ensureBasicPageData(pageIndex), signal)
      const page = view._pdfPages[pageIndex]
      if (!Array.isArray(page?.chars)) throw new Error("missing text layer")
      const passages = pagePassages(page, pageIndex, labels?.[pageIndex] || String(pageIndex + 1))
      candidates.push(...passages)
      if (!passages.length) emptyPages.push(pageIndex + 1)
      pageNumbers.push(pageIndex + 1)
    } catch {
      abortIfNeeded(signal)
      warnings.push(`第 ${pageIndex + 1} 页的文字坐标读取失败，未纳入解析。`)
    }
    try { onProgress?.({ pagesRead: pageNumbers.length, totalPages: pdf.numPages }) } catch { /* 进度展示不得阻止正文解析。 */ }
  }
  abortIfNeeded(signal)
  if (!candidates.length) {
    throw new Error("未找到可定位的 PDF 原句。扫描件请先完成 OCR；本次没有生成高亮或批注。")
  }
  const passages = boundedPassages(candidates)
  const limited = passages.length < candidates.length || pageNumbers.length < pdf.numPages || emptyPages.length > 0
  if (emptyPages.length) warnings.push(`第 ${emptyPages.join("、")} 页无可定位原句，可能是图像、空白页或缺少文字层，未纳入句子解析。`)
  if (pageIndexes.length < pdf.numPages) warnings.push(`长文献均匀抽取 ${pageIndexes.length}/${pdf.numPages} 页（包括末页），未读取全部正文。`)
  if (passages.length < candidates.length) warnings.push(`为控制解析长度，均匀选取 ${passages.length}/${candidates.length} 个可定位原句；结论仅基于这些原句。`)
  if (modificationTime !== undefined && modificationTime !== null
    && await item.attachmentModificationTime !== modificationTime) {
    throw new Error("PDF 文件在读取期间已更改，请重新打开后再解析。")
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
      if (!tags.includes(AI_TAG) || !annotation.annotationText) continue
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
    throw new Error("PDF 已变更或当前文库不可编辑，已停止写入批注。")
  }
  if (snapshot.attachmentModificationTime !== undefined
    && await item.attachmentModificationTime !== snapshot.attachmentModificationTime) {
    throw new Error("PDF 文件在解析期间已更改，请重新打开并解析后再保存批注。")
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
      throw new Error("当前 Zotero 无法保存原生批注；解析结果仍可在解析记录中阅读。")
    }
    const attachment = await checkWritable(zotero, snapshot)
    if (!attachment.getAnnotations) throw new Error("无法读取现有批注，已暂停写入以避免重复。")
    const existing = existingIdentities(attachment.getAnnotations())
    const passages = new Map(snapshot.passages.map((passage) => [passage.id, passage]))
    const result: SavedAnalysisAnnotations = { created: 0, skipped: 0, failed: 0, unprocessed: annotations.length, warnings: [] }
    let invalid = 0
    for (const suggestion of annotations) {
      if (options.signal?.aborted) { result.warnings.push("已停止；此前成功保存的批注予以保留。"); break }
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
          result.warnings.push("批注标识发生冲突，已跳过该条，请重试。")
          continue
        }
      } catch {
        result.failed++
        result.unprocessed--
        result.warnings.push(`第 ${passage.pageIndex + 1} 页的「${category.label}」批注未能核对新标识，未开始写入；其余批注继续保存。`)
        continue
      }
      // 异步标识核对后再验证附件，避免期间更换文件或文库权限后仍使用旧坐标。
      let current: PdfItem
      try { current = await checkWritable(zotero, snapshot) } catch (error) {
        result.warnings.push(error instanceof Error ? error.message : "附件状态改变，已停止写入。")
        break
      }
      if (options.signal?.aborted) { result.warnings.push("已停止；此前成功保存的批注予以保留。"); break }
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
          tags: [{ name: AI_TAG }, { name: `${AI_TAG}/${category.id}` }, { name: category.label }],
        })
        result.created++
      } catch {
        result.failed++
        result.warnings.push(`第 ${passage.pageIndex + 1} 页的「${category.label}」批注未确认保存；请先检查 PDF 中的批注再重试。`)
      }
      result.unprocessed--
    }
    if (invalid) result.warnings.push(`${invalid} 条建议缺少有效笔记或本地原句坐标，已跳过；其余正确批注予以保留。`)
    if (result.unprocessed) result.warnings.push(`另有 ${result.unprocessed} 条建议尚未处理，没有为它们确认新增批注。`)
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
 * 用仍在 reader 页缓存中的字形几何恢复 Unicode 上下标。证据不足时保留原文。
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
      line.push(char)
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
    action.text = kind === "translate" ? enrichSelectionScripts(text, activeView) : text
  }
  if (Number.isInteger(annotation?.position?.pageIndex)) action.pageIndex = annotation!.position!.pageIndex
  if (typeof annotation?.pageLabel === "string") action.pageLabel = annotation.pageLabel
  return action
}

// 样式只命中自有节点；颜色沿用原生 reader token，随 Zotero 浅/深色切换。
const READER_TOOLS_CSS = `
[data-jadense-reader-tools] {
  display:inline-flex;align-items:center;gap:2px;flex:none;box-sizing:border-box;
  padding:2px;border:1px solid var(--color-border50,rgba(17,21,16,.12));border-radius:7px;
  color:var(--fill-primary,CanvasText);background:var(--fill-senary,transparent);
  font:inherit;-moz-window-dragging:no-drag;
}
[data-jadense-reader-tools] .jadense-reader-brand {
  display:flex;align-items:center;justify-content:center;flex:none;padding:0 6px 0 4px;margin-inline-end:2px;
  border-inline-end:1px solid var(--color-border50,rgba(17,21,16,.12));
}
[data-jadense-reader-tools] > button {
  appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;
  gap:5px;min-width:28px;height:28px;margin:0;padding:0 6px;border:0;border-radius:5px;
  background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:500;line-height:1;
  white-space:nowrap;cursor:pointer;-moz-window-dragging:no-drag;
}
[data-jadense-reader-tools] > button:hover {
  background:var(--fill-quinary,rgba(17,21,16,.06));
}
[data-jadense-reader-tools] > button:active {
  background:var(--fill-quarternary,rgba(17,21,16,.12));
}
[data-jadense-reader-tools] > button:focus-visible {
  outline:2px solid var(--fill-primary,CanvasText);outline-offset:1px;
}
[data-jadense-reader-tools] svg {width:16px;height:16px;flex:none;pointer-events:none;}
[data-jadense-reader-tools] .jadense-reader-brand svg {width:20px;height:20px;}
[data-jadense-reader-tools="renderTextSelectionPopup"] {
  margin-top:4px;padding:3px;background:transparent;
}
[data-jadense-reader-notice] {
  position:fixed;z-index:10001;box-sizing:border-box;width:260px;max-width:calc(100vw - 16px);
  padding:9px 11px;border:1px solid var(--color-border,rgba(17,21,16,.16));border-radius:6px;
  color:var(--fill-primary,CanvasText);background:var(--material-background,Canvas);
  box-shadow:0 2px 8px rgba(0,0,0,.1);font:12px/1.6 system-ui,sans-serif;pointer-events:none;
}
[data-jadense-reader-notice][hidden] {display:none;}
[data-jadense-translation-panel] {
  position:fixed;z-index:10000;top:56px;right:16px;display:grid;grid-template-rows:auto minmax(0,1fr) auto;
  box-sizing:border-box;width:min(430px,calc(100vw - 32px));max-height:calc(100vh - 72px);overflow:hidden;
  border:1px solid var(--color-border,rgba(17,21,16,.16));border-radius:10px;
  color:var(--fill-primary,CanvasText);background:var(--material-background,Canvas);
  box-shadow:0 12px 32px rgba(0,0,0,.18);font:13px/1.65 system-ui,sans-serif;
}
[data-jadense-translation-panel][hidden] {display:none;}
[data-jadense-translation-panel] header {display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--color-border50,rgba(17,21,16,.12));}
[data-jadense-translation-panel] header strong {font-size:13px;}
[data-jadense-translation-panel] button {appearance:none;border:1px solid var(--color-border50,rgba(17,21,16,.12));border-radius:5px;padding:5px 9px;color:inherit;background:transparent;font:inherit;cursor:pointer;}
[data-jadense-translation-panel] button:hover:not(:disabled) {background:var(--fill-quinary,rgba(17,21,16,.06));}
[data-jadense-translation-panel] button:disabled {cursor:default;opacity:.5;}
[data-jadense-translation-panel] .jadense-translation-close {border:0;padding:2px 7px;font-size:18px;line-height:1.2;}
.jadense-translation-content {min-height:0;overflow-y:auto;padding:12px;}
.jadense-translation-label {margin:0 0 4px;color:var(--fill-secondary,currentColor);font-size:11px;font-weight:650;letter-spacing:.02em;}
.jadense-translation-text {margin:0 0 14px;white-space:pre-wrap;overflow-wrap:anywhere;}
.jadense-translation-result {margin-bottom:0;padding:10px;border-radius:7px;background:var(--fill-senary,rgba(17,21,16,.04));}
.jadense-translation-result[data-error="true"] {color:#b42318;}
.jadense-translation-result[data-error="false"] {white-space:normal;}
.jadense-translation-result[data-error="false"] > :first-child {margin-top:0;}
.jadense-translation-result[data-error="false"] > :last-child {margin-bottom:0;}
.jadense-translation-result p,.jadense-translation-result ul,.jadense-translation-result ol,.jadense-translation-result blockquote,.jadense-translation-result pre,.jadense-translation-result table {margin:0 0 10px;}
.jadense-translation-result ul,.jadense-translation-result ol {padding-inline-start:22px;}
.jadense-translation-result blockquote {border-inline-start:3px solid var(--color-border,rgba(17,21,16,.2));padding-inline-start:10px;color:var(--fill-secondary,currentColor);}
.jadense-translation-result code {border-radius:3px;padding:1px 4px;background:var(--fill-quinary,rgba(17,21,16,.07));font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em;}
.jadense-translation-result pre {max-width:100%;overflow:auto;border-radius:5px;padding:9px;background:var(--fill-quinary,rgba(17,21,16,.07));}
.jadense-translation-result pre code {padding:0;background:transparent;white-space:pre;}
.jadense-translation-result table {display:block;max-width:100%;overflow:auto;border-collapse:collapse;}
.jadense-translation-result th,.jadense-translation-result td {border:1px solid var(--color-border50,rgba(17,21,16,.12));padding:4px 6px;text-align:start;}
.jadense-translation-result a {color:inherit;text-decoration:underline;text-underline-offset:2px;}
.jadense-translation-result .katex {font-size:1.04em;}
.jadense-translation-result .katex-display {display:block;max-width:100%;overflow-x:auto;overflow-y:hidden;margin:10px 0;padding-block:2px;}
.jadense-translation-result .jdx-math-error {color:#b42318;}
.jadense-translation-actions {display:flex;justify-content:flex-end;padding:9px 12px;border-top:1px solid var(--color-border50,rgba(17,21,16,.12));}
.jadense-translation-languages {display:inline-flex;align-items:center;gap:4px;min-width:0;}
[data-jadense-reader-tools] .jadense-translation-languages {margin-inline-start:4px;padding-inline-start:5px;border-inline-start:1px solid var(--color-border50,rgba(17,21,16,.12));}
.jadense-translation-languages select {box-sizing:border-box;width:82px;min-width:0;height:28px;padding:2px 3px;border:1px solid var(--color-border50,rgba(17,21,16,.12));border-radius:5px;color:inherit;background:var(--material-background,Canvas);font:12px system-ui,sans-serif;}
.jadense-translation-languages select:focus-visible {outline:2px solid var(--fill-primary,CanvasText);outline-offset:1px;}
[data-jadense-translation-panel] header {flex-wrap:wrap;gap:6px;}
[data-jadense-sentence-languages] {flex-basis:100%;flex-wrap:wrap;}
[data-jadense-sentence-languages] button {margin-inline-start:auto;}
.jadense-translation-language-hint {flex-basis:100%;margin:0;color:var(--fill-secondary,currentColor);font-size:11px;}
.jadense-article-language-menu {display:inline-flex;align-items:center;}
.jadense-article-language-toggle {display:none;}
[data-jadense-language-popover] {position:fixed;z-index:10002;top:44px;right:8px;margin:0;padding:8px;border:1px solid var(--color-border50,rgba(17,21,16,.12));border-radius:6px;background:var(--material-background,Canvas);box-shadow:0 2px 8px rgba(0,0,0,.1);}
@media (max-width:1100px) {
  [data-jadense-reader-tools="renderToolbar"] .jadense-reader-label {display:none;}
  [data-jadense-reader-tools="renderToolbar"] > button[data-jadense-action] {padding:0;width:28px;}
  .jadense-article-language-toggle {display:inline-flex;flex:none;align-items:center;justify-content:center;min-width:36px;height:28px;padding:0 6px;white-space:nowrap;border:0;border-radius:5px;color:inherit;background:transparent;font:12px system-ui,sans-serif;cursor:pointer;}
  .jadense-article-language-toggle:hover {background:var(--fill-quinary,rgba(17,21,16,.06));}
  .jadense-article-language-toggle:focus-visible {outline:2px solid var(--fill-primary,CanvasText);outline-offset:1px;}
  [data-jadense-reader-tools] [data-jadense-article-languages] {display:none;}
}
`

const READER_ACTION_ICONS: Record<ReaderToolbarAction["kind"], string> = {
  attach: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M8 9h8 M8 13h5",
  analyze: "M11 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8l6 6v3 M14 2v6h6 M8 12h2 M8 16h1 M20 16a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M19 19l3 3",
  translate: "M3 5h12 M9 3v2 M5 5c0 5 6 9 8 9 M13 5c0 5-6 9-8 9 M14 21l4-10 4 10 M15.5 17h5",
  quote: "M4 6h6v7H6c0 3-1 5-3 6 M4 6v7 M14 6h6v7h-4c0 3-1 5-3 6 M14 6v7",
}

// 与 icons/jadense-20.svg 保持相同的几何和渐变；reader content 不依赖 chrome:// 图片加载。
const READER_BRAND_PARTS = [
  {
    coordinates: {"x1":"180","y1":"20","x2":"410","y2":"425"},
    stops: [["0","#61c59a"],["0.53","#28ad78"],["1","#1f7a5d"]],
    path: "M 359 429.5 C 358.46 429.18 357.92 429.04 357.5 429 C 359.33 427.5 365 424.67 370 420.5 C 375 416.33 382.42 409.58 387.5 404 C 392.58 398.42 396.17 394.17 400.5 387 C 404.83 379.83 410.17 369.83 413.5 361 C 416.83 352.17 419.17 344.17 420.5 334 C 421.83 323.83 421.15 305.48 420.5 299 C 420.33 297.17 420.32 290.48 419.5 288 C 419 284.67 419.17 277.17 417.5 269 C 415.83 260.83 411.17 244.5 409.5 239 C 408.83 237.85 408.25 236.85 407.5 236 C 406.33 233 405.33 227.5 402.5 221 C 399.67 214.5 395.67 205.67 390.5 197 C 385.33 188.33 376.5 175.83 371.5 169 C 366.5 162.17 365.08 160.92 360.5 156 C 355.92 151.08 349.58 144.58 344 139.5 C 338.42 134.42 332.5 129.67 327 125.5 C 321.5 121.33 318.67 119 311 114.5 C 303.33 110 291 103 281 98.5 C 271 94 259.5 90.17 251 87.5 C 242.5 84.83 235.33 83.5 230 82.5 C 224.67 81.5 220.65 81.48 218 80.5 C 214.33 80.17 200.32 79.48 196 78.5 C 192.5 78.33 179.15 78.68 175 79.5 C 172.67 79.67 163.98 79.68 161 80.5 C 159.25 80.75 151.75 82.75 151.5 81 C 151.25 79.25 154.58 75.42 159.5 70 C 164.42 64.58 174.25 54.58 181 48.5 C 187.75 42.42 192.5 38.67 200 33.5 C 207.5 28.33 218.17 21.83 226 17.5 C 233.83 13.17 241 10 247 7.5 C 253 5 257.83 3.5 262 2.5 C 266.17 1.5 270.52 1.48 273 0.5 C 276 0.25 287.35 0.17 291 0.5 C 293 0.58 297.33 0 302 0.5 C 306.67 1.17 310.67 1.33 319 4.5 C 327.33 7.67 340.83 13.17 352 19.5 C 363.17 25.83 375.58 34.08 386 42.5 C 396.42 50.92 407.25 62.25 414.5 70 C 421.75 77.75 425.33 83.33 429.5 89 C 433.67 94.67 435 95.83 439.5 104 C 444 112.17 451.83 126.5 456.5 138 C 461.17 149.5 465.67 166.5 467.5 173 C 467.82 174.35 467.86 175.72 467.5 177 C 468 179.5 470 185.17 470.5 188 C 471 190.83 470.68 193.18 471.5 195 C 471.83 198.83 472.17 213.17 472.5 217 C 472.56 217.36 473.48 217.66 473.5 218 C 473.52 223.5 472.48 244.85 471.5 251 C 471.33 252.33 471.32 257.02 470.5 259 C 470 262 469.5 270.5 468.5 276 C 467.5 281.5 466.67 285 464.5 292 C 462.33 299 458.67 310.17 455.5 318 C 452.33 325.83 448.83 332.67 445.5 339 C 442.17 345.33 440 349.33 435.5 356 C 431 362.67 426.25 370.25 418.5 379 C 410.75 387.75 396.75 401.42 389 408.5 C 381.25 415.58 377 418 372 421.5 C 367 425 361.42 428.25 359 429.5 Z",
  },
  {
    coordinates: {"x1":"330","y1":"175","x2":"40","y2":"520"},
    stops: [["0","#1e7758"],["0.42","#22aa75"],["1","#64c49a"]],
    path: "M 152 548.5 C 148.75 548.42 140.33 547.5 132 545.5 C 123.67 543.5 108.67 538.83 102 536.5 C 95.33 534.17 93.3 532.33 90 531.5 C 85.17 529.17 71.33 522.5 63 517.5 C 54.67 512.5 46.25 506.42 40 501.5 C 33.75 496.58 29.75 492.75 25.5 488 C 21.25 483.25 17.33 477.5 14.5 473 C 11.67 468.5 10.33 465.5 8.5 461 C 6.67 456.5 4.5 450.17 3.5 446 C 2.5 441.83 2.48 437.48 1.5 435 C 1.33 433.67 1.32 428.98 0.5 427 C 0.25 421.17 0 401.33 0 393 C 0 384.67 0.6 379.48 1.5 376 C 1.83 373.5 1.33 368.67 2.5 362 C 3.67 355.33 6.17 344.17 8.5 336 C 10.83 327.83 13 321.33 16.5 313 C 20 304.67 25 294.17 29.5 286 C 34 277.83 39.5 269.83 43.5 264 C 47.5 258.17 46.42 258.58 53.5 251 C 60.58 243.42 76.92 226.58 86 218.5 C 95.08 210.42 101.17 207 108 202.5 C 114.83 198 120.17 195 127 191.5 C 133.83 188 141.33 184.5 149 181.5 C 156.67 178.5 165.5 175.5 173 173.5 C 180.5 171.5 190.68 169.98 195 168.5 C 197.33 168.17 206.02 167.48 209 166.5 C 210.67 166.33 216.68 166.32 219 165.5 C 225 165.33 248.35 165.68 255 166.5 C 256.67 166.67 262.68 166.68 265 167.5 C 266.33 167.67 271.02 167.68 273 168.5 C 275.67 169 282.83 169.33 288 170.5 C 293.17 171.67 300.83 174.67 304 175.5 C 305 175.58 306 175.58 307 175.5 C 311.5 177 323.67 181.33 331 184.5 C 338.33 187.67 347.67 193.2 351 196.5 C 348.33 195.5 341 190.83 335 188.5 C 329 186.17 320.17 183.67 315 182.5 C 309.83 181.33 305.65 181.48 303 180.5 C 300.67 180.33 291.98 180.32 289 179.5 C 285.83 179.5 273.82 180.52 270 181.5 C 268 181.83 265.33 180.83 259 182.5 C 252.67 184.17 238.17 189.17 232 191.5 C 228.65 192.78 225.12 194.55 222 196.5 C 216.67 199.67 207.17 205.33 200 210.5 C 192.83 215.67 185.08 222.08 179 227.5 C 172.92 232.92 167.92 238.25 163.5 243 C 159.08 247.75 156.5 250.83 152.5 256 C 148.5 261.17 143.33 268.17 139.5 274 C 135.67 279.83 133.17 283.83 129.5 291 C 125.83 298.17 121.17 307.17 117.5 317 C 113.83 326.83 109.17 343.83 107.5 350 C 107.1 351.32 107.1 352.68 107.5 354 C 107 356.5 105 362.17 104.5 365 C 104 367.83 104.32 370.18 103.5 372 C 103.33 373.5 103.32 378.85 102.5 381 C 102.33 383.67 102.32 393.68 101.5 397 C 101.5 401.67 102.52 419.68 103.5 425 C 103.67 426.5 103.68 431.85 104.5 434 C 105.17 437.67 105.33 446.17 107.5 455 C 109.67 463.83 113.67 477 117.5 487 C 121.33 497 126.17 506.83 130.5 515 C 134.83 523.17 140 530.83 143.5 536 C 147 541.17 150.26 544.79 152 548.5 Z",
  },
  {
    coordinates: {"x1":"170","y1":"420","x2":"565","y2":"330"},
    stops: [["0","#21805f"],["0.48","#23ad77"],["1","#78c49e"]],
    path: "M 396 551.5 C 390.67 551.5 369.98 550.48 364 549.5 C 362.5 549.33 357.15 549.32 355 548.5 C 353 548.17 347.5 548.17 344 547.5 C 340.5 546.83 336.33 545 334 544.5 C 332.72 544.25 331.32 544.25 330 544.5 C 324.67 543 308.33 537.83 302 535.5 C 295.67 533.17 293.3 531.33 290 530.5 C 285.33 528.17 272.17 521.5 264 516.5 C 255.83 511.5 247.33 505.33 241 500.5 C 234.67 495.67 231.58 492.92 226 487.5 C 220.42 482.08 212.92 474.25 207.5 468 C 202.08 461.75 197.83 456.17 193.5 450 C 189.17 443.83 185.17 437.5 181.5 431 C 177.83 424.5 175 419.33 171.5 411 C 168 402.67 163 388.67 160.5 381 C 158 373.33 157.5 370.33 156.5 365 C 155.5 359.67 154.65 351.48 153.5 348 C 153.33 346.83 153.32 342.82 152.5 341 C 152.17 336.67 151.85 320.17 152.5 316 C 153 319.83 153.5 332.5 154.5 339 C 155.5 345.5 157.33 351.33 158.5 355 C 159.55 358.25 161.25 362.35 162.5 366 C 164 369.5 166.33 375.5 170.5 382 C 174.67 388.5 183.08 399.58 187.5 405 C 191.92 410.42 193.08 411.08 197 414.5 C 200.92 417.92 206.5 422.33 211 425.5 C 215.5 428.67 218.83 430.67 224 433.5 C 229.17 436.33 234 439.17 242 442.5 C 250 445.83 262.67 450.67 272 453.5 C 281.33 456.33 291.5 458.33 298 459.5 C 304.5 460.67 308.67 460.17 311 460.5 C 329.5 461.95 352.5 461.45 372 459.5 C 375.5 458.83 383.83 458.5 392 456.5 C 400.17 454.5 410.5 451.67 421 447.5 C 431.5 443.33 446 436.33 455 431.5 C 464 426.67 468.33 423.33 475 418.5 C 481.67 413.67 488.58 408.25 495 402.5 C 501.42 396.75 508.75 389.08 513.5 384 C 518.25 378.92 518.5 379 523.5 372 C 528.5 365 537.92 351.75 543.5 342 C 549.08 332.25 553.33 314.5 557 313.5 C 559.55 318.7 563.05 327.95 565.5 336 C 567.92 344.08 570.33 355.5 571.5 362 C 572.67 368.5 572.52 373.02 573.5 376 C 573.67 378 573.68 385.35 574.5 388 C 574.67 392.67 574.32 410.68 573.5 416 C 573.17 419.33 572.48 432.02 571.5 436 C 571.38 437.05 571.62 438.82 571.5 441 C 571.17 443.17 570.83 445 569.5 449 C 568.17 453 566.33 459.33 563.5 465 C 560.67 470.67 556.58 477.58 552.5 483 C 548.42 488.42 542.92 493.75 539 497.5 C 535.08 501.25 534.5 501.67 529 505.5 C 523.5 509.33 513.83 516 506 520.5 C 498.17 525 490.67 528.83 482 532.5 C 473.33 536.17 460.67 540.33 454 542.5 C 447.33 544.67 444.67 545 442 545.5 C 440.65 545.6 439.32 545.55 438 545.5 C 435.5 546 429.83 548 427 548.5 C 424.17 549 421.82 548.68 420 549.5 C 416 549.83 401 550.17 397 550.5 C 396.65 550.85 396.32 551.18 396 551.5 Z",
  },
]
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
  READER_BRAND_PARTS.forEach((part, index) => {
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

/** 统一线性图标仅作装饰；完整动作名仍由原生 button 的 aria-label/title 承担。 */
function actionIcon(doc: Document, kind: ReaderToolbarAction["kind"]): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7",
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
  })) svg.setAttribute(name, value)
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", READER_ACTION_ICONS[kind])
  svg.append(path)
  return svg
}

/** 文章与本句使用相同的原生语言选择框；仅源语言提供自动识别。 */
function translationLanguageControls(doc: Document, scope: "文章" | "本句") {
  const element = doc.createElement("span")
  element.className = "jadense-translation-languages"
  element.setAttribute(scope === "文章" ? "data-jadense-article-languages" : "data-jadense-sentence-languages", "")
  element.setAttribute("role", "group")
  element.setAttribute("aria-label", `${scope}翻译语言`)
  const select = (label: string, source: boolean) => {
    const control = doc.createElement("select")
    control.setAttribute("aria-label", `${scope}${label}`)
    control.title = `${scope}${label}`
    for (const language of source ? [{ value: "auto", label: "自动识别" }, ...TRANSLATION_LANGUAGES] : TRANSLATION_LANGUAGES) {
      const option = doc.createElement("option")
      option.value = language.value
      option.textContent = language.label
      control.append(option)
    }
    return control
  }
  const source = select("源语言", true)
  const target = select("目标语言", false)
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
  onOpenManager?: () => void,
): () => void {
  const nodes = new Set<HTMLElement>()
  const handlers = new Map<ReaderEventType, ReaderHandler>()
  const shortcutCleanups = new Map<Document, () => void>()
  const articleLanguageRefreshes = new Map<HTMLElement, () => void>()
  const articleLanguageClosers = new Map<HTMLElement, () => boolean>()
  const documents = new Map<Document, {
    show: (anchor: HTMLElement, text: string) => void
    hide: () => void
    dismiss: () => boolean
    beginTranslation: (selection: ReaderToolbarAction) => number
    setTranslationLanguages: (requestID: number, languages: TranslationLanguages) => boolean
    updateTranslation: (requestID: number, text: string) => void
    finishTranslation: (requestID: number, text: string, error?: boolean) => void
    remove: () => void
  }>()
  let active = true
  // 每个 reader document 共享一份 CSS 和就地提示，避免选区弹出层反复创建样式。
  const documentTools = (doc: Document) => {
    const existing = documents.get(doc)
    if (existing) return existing
    const style = doc.createElement("style")
    style.setAttribute("data-jadense-reader-style", "")
    style.textContent = READER_TOOLS_CSS
    const styleHost = doc.head || doc.documentElement
    styleHost.append(style)
    const notice = doc.createElement("div")
    notice.setAttribute("data-jadense-reader-notice", "")
    notice.setAttribute("role", "status")
    notice.setAttribute("aria-live", "polite")
    notice.setAttribute("aria-atomic", "true")
    notice.hidden = true
    const noticeHost = doc.body || doc.documentElement
    noticeHost.append(notice)
    const translationPanel = doc.createElement("aside")
    translationPanel.setAttribute("data-jadense-translation-panel", "")
    translationPanel.setAttribute("role", "region")
    translationPanel.setAttribute("aria-label", "智能翻译结果")
    translationPanel.hidden = true
    const translationHeader = doc.createElement("header")
    const translationTitle = doc.createElement("strong")
    translationTitle.textContent = "智能翻译"
    const translationClose = doc.createElement("button")
    translationClose.type = "button"
    translationClose.className = "jadense-translation-close"
    translationClose.setAttribute("aria-label", "关闭翻译浮窗")
    translationClose.title = "关闭"
    translationClose.textContent = "×"
    translationHeader.append(translationTitle, translationClose)
    const sentenceLanguages = translationLanguageControls(doc, "本句")
    const retranslate = doc.createElement("button")
    retranslate.type = "button"
    retranslate.textContent = "重新翻译"
    retranslate.disabled = true
    sentenceLanguages.element.append(retranslate)
    const languageHint = doc.createElement("p")
    languageHint.className = "jadense-translation-language-hint"
    languageHint.textContent = "仅修改本句；文章默认语言在顶部工具条设置。"
    translationHeader.append(sentenceLanguages.element, languageHint)
    const translationContent = doc.createElement("div")
    translationContent.className = "jadense-translation-content"
    const sourceLabel = doc.createElement("p")
    sourceLabel.className = "jadense-translation-label"
    sourceLabel.textContent = "原文"
    const sourceText = doc.createElement("p")
    sourceText.className = "jadense-translation-text"
    const resultLabel = doc.createElement("p")
    resultLabel.className = "jadense-translation-label"
    resultLabel.textContent = "译文"
    const resultText = doc.createElement("div")
    resultText.className = "jadense-translation-text jadense-translation-result"
    resultText.setAttribute("aria-live", "polite")
    translationContent.append(sourceLabel, sourceText, resultLabel, resultText)
    const translationActions = doc.createElement("footer")
    translationActions.className = "jadense-translation-actions"
    const copyTranslation = doc.createElement("button")
    copyTranslation.type = "button"
    copyTranslation.textContent = "复制译文"
    copyTranslation.disabled = true
    translationActions.append(copyTranslation)
    translationPanel.append(translationHeader, translationContent, translationActions)
    noticeHost.append(translationPanel)
    let translationRequestID = 0
    let translationError = false
    let translationMarkdown = ""
    let translationSelection: ReaderToolbarAction | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const renderTranslationMarkdown = (text: string) => {
      try { updateChatMarkdown(resultText, text) } catch { resultText.textContent = text }
    }
    const hide = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      notice.hidden = true
      notice.textContent = ""
    }
    const closeTranslation = () => { translationRequestID += 1; translationPanel.hidden = true }
    const dismiss = () => {
      for (const [node, close] of articleLanguageClosers) if (node.ownerDocument === doc && close()) return true
      if (!translationPanel.hidden) { closeTranslation(); return true }
      if (!notice.hidden) { hide(); return true }
      return false
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      dismiss()
    }
    const refreshArticleLanguages = () => {
      for (const [node, refresh] of articleLanguageRefreshes) {
        if (node.ownerDocument === doc && node.isConnected) refresh()
      }
    }
    translationClose.addEventListener("click", closeTranslation)
    const changeSentenceLanguages = () => {
      if (!translationSelection) return
      // 语言一经改变，旧请求的增量和结束事件均失效，下一次发送仍引用原选文快照。
      translationRequestID += 1
      translationMarkdown = ""
      translationError = false
      resultText.textContent = "语言已修改，点击「重新翻译」。"
      resultText.setAttribute("data-error", "false")
      copyTranslation.disabled = true
      retranslate.disabled = false
    }
    sentenceLanguages.source.addEventListener("change", changeSentenceLanguages)
    sentenceLanguages.target.addEventListener("change", changeSentenceLanguages)
    retranslate.addEventListener("click", () => {
      if (!translationSelection || retranslate.disabled) return
      translate(doc, retranslate, { ...translationSelection, languages: sentenceLanguages.get() })
    })
    copyTranslation.addEventListener("click", () => {
      const value = translationError ? "" : translationMarkdown.trim()
      if (!value) return
      void doc.defaultView?.navigator.clipboard?.writeText(value)
    })
    const remove = () => {
      hide()
      shortcutCleanups.get(doc)?.()
      doc.removeEventListener("keydown", onKeyDown)
      doc.defaultView?.removeEventListener("pagehide", remove)
      doc.defaultView?.removeEventListener("focus", refreshArticleLanguages, true)
      style.remove()
      notice.remove()
      translationPanel.remove()
      for (const node of nodes) if (node.ownerDocument === doc) {
        articleLanguageClosers.get(node)?.()
        node.remove(); nodes.delete(node); articleLanguageRefreshes.delete(node); articleLanguageClosers.delete(node)
      }
      documents.delete(doc)
    }
    const entry = {
      hide,
      dismiss,
      remove,
      beginTranslation: (selection: ReaderToolbarAction) => {
        translationRequestID += 1
        translationSelection = { ...selection }
        sourceText.textContent = selection.text ?? ""
        sentenceLanguages.set(selection.languages ?? DEFAULT_TRANSLATION_LANGUAGES)
        sentenceLanguages.disable(true)
        retranslate.disabled = true
        translationMarkdown = ""
        resultText.textContent = "正在翻译…"
        translationError = false
        resultText.setAttribute("data-error", "false")
        copyTranslation.disabled = true
        translationPanel.hidden = false
        return translationRequestID
      },
      setTranslationLanguages: (requestID: number, languages: TranslationLanguages) => {
        if (requestID !== translationRequestID || translationPanel.hidden) return false
        sentenceLanguages.set(languages)
        sentenceLanguages.disable(false)
        return true
      },
      updateTranslation: (requestID: number, text: string) => {
        if (requestID !== translationRequestID || translationPanel.hidden || !text) return
        translationMarkdown = text
        renderTranslationMarkdown(text)
      },
      finishTranslation: (requestID: number, text: string, error = false) => {
        if (requestID !== translationRequestID) return
        translationMarkdown = error ? "" : text
        const displayText = text || (error ? "翻译未完成。" : "AI 没有返回可显示的译文。")
        if (error || !text) resultText.textContent = displayText
        else renderTranslationMarkdown(displayText)
        translationError = error
        resultText.setAttribute("data-error", String(error))
        copyTranslation.disabled = error || !text.trim()
        retranslate.disabled = false
      },
      show: (anchor: HTMLElement, message: string) => {
        hide()
        const rect = anchor.getBoundingClientRect()
        const width = doc.defaultView?.innerWidth || 800
        const height = doc.defaultView?.innerHeight || 600
        notice.style.left = `${Math.max(8, Math.min(rect.left, width - 268))}px`
        notice.style.top = `${Math.max(8, Math.min(rect.bottom + 8, height - 72))}px`
        notice.textContent = message
        notice.hidden = false
        timer = setTimeout(hide, 5000)
      },
    }
    documents.set(doc, entry)
    doc.addEventListener("keydown", onKeyDown)
    doc.defaultView?.addEventListener("pagehide", remove, { once: true })
    doc.defaultView?.addEventListener("focus", refreshArticleLanguages, true)
    return entry
  }
  /** 点击与快捷键共用翻译请求、流式浮窗与本地错误，避免产生第二条对话入口。 */
  const translate = (doc: Document, anchor: HTMLElement, selection: ReaderToolbarAction) => {
    if (!active) return
    const feedback = documentTools(doc)
    if (!selection.text) {
      feedback.show(anchor, "请先选中文献中的文字，再使用翻译。")
      return
    }
    feedback.hide()
    const requestID = feedback.beginTranslation(selection)
    void Promise.resolve().then(async () => {
      const languages = selection.languages
        ? normalizeTranslationLanguages(selection.languages)
        : await readArticleTranslationLanguages(zotero, selection.itemID)
      if (!active || !documents.has(doc)) return undefined
      if (!feedback.setTranslationLanguages(requestID, languages)) return undefined
      return onAction({ ...selection, languages }, { onTranslationText: (text) => feedback.updateTranslation(requestID, text) })
    }).then((result) => {
      if (!active || !documents.has(doc)) return
      feedback.finishTranslation(requestID, result && typeof result === "object" ? result.translation?.trim() ?? "" : "")
    }).catch((error) => {
      if (!active || !documents.has(doc)) return
      feedback.finishTranslation(requestID, error instanceof Error ? error.message : "翻译未完成，请稍后重试。", true)
    })
  }
  /** PDF iframe 不向外层冒泡键盘事件；跟随主视图/分屏加载并在卸载时解除监听。 */
  const bindTranslationShortcut = (event: ReaderEvent) => {
    const { doc, reader } = event
    if (shortcutCleanups.has(doc)) return
    const bindings = new Map<NonNullable<ReaderPdfView["_iframeWindow"]>, EventListener>()
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
        translate(doc, doc.body || doc.documentElement, selectedAction("translate", reader, undefined, primary))
      }
      win.addEventListener("keydown", handler, true)
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
      for (const [win, handler] of bindings) win.removeEventListener?.("keydown", handler, true)
      bindings.clear()
      shortcutCleanups.delete(doc)
    })
    void refresh()
  }
  const cleanup = () => {
    active = false
    for (const [type, handler] of handlers) {
      try { zotero.Reader?.unregisterEventListener?.(type, handler) } catch { /* 继续清理其他监听。 */ }
    }
    handlers.clear()
    for (const entry of documents.values()) { try { entry.remove() } catch { /* 已销毁窗口不阻止其他 reader 清理。 */ } }
    documents.clear()
    for (const node of nodes) { try { node.remove() } catch { /* 阅读器窗口可能已经关闭。 */ } }
    nodes.clear()
  }
  if (!zotero.Reader?.registerEventListener) return cleanup
  const actions = [
    { kind: "attach", label: "发起新对话，向 AI 提问（当前文献）", short: "提问" },
    { kind: "analyze", label: "解析文献", short: "解析" },
    { kind: "translate", label: "智能翻译", short: "翻译" },
    { kind: "quote", label: "引用选文", short: "引用" },
  ] as const
  for (const type of ["renderToolbar", "renderTextSelectionPopup"] as const) {
    const handler: ReaderHandler = (event) => {
      if (!active || !Number.isInteger(event.reader.itemID)) return
      for (const node of nodes) if (!node.isConnected) {
        articleLanguageClosers.get(node)?.()
        nodes.delete(node); articleLanguageRefreshes.delete(node); articleLanguageClosers.delete(node)
      }
      const feedback = documentTools(event.doc)
      if (type === "renderToolbar") bindTranslationShortcut(event)
      const group = event.doc.createElement("span")
      group.setAttribute("data-jadense-reader-tools", type)
      group.setAttribute("role", "group")
      group.setAttribute("aria-label", "Jadense 阅读工具")
      if (type === "renderToolbar") {
        const brand = event.doc.createElement("button")
        brand.type = "button"
        brand.className = "jadense-reader-brand"
        brand.title = "打开攻玉工作台"
        brand.setAttribute("aria-label", brand.title)
        brand.append(brandIcon(event.doc))
        // 仅打开或聚焦工作台，不触发阅读器提问，也不附加当前文献。
        brand.addEventListener("click", () => {
          if (!active) return
          articleLanguageClosers.get(group)?.()
          feedback.hide()
          try { onOpenManager?.() } catch {
            feedback.show(brand, "无法打开攻玉工作台，请稍后重试。")
          }
        })
        group.append(brand)
      }
      for (const action of actions) {
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
          articleLanguageClosers.get(group)?.()
          const selection = selectedAction(action.kind, event.reader, event.params?.annotation)
          if ((action.kind === "translate" || action.kind === "quote") && !selection.text) {
            feedback.show(button, `请先选中文献中的文字，再点击「${action.short}」。`)
            return
          }
          feedback.hide()
          // 在原生点击同步阶段保留选区；让焦点变化或 popup 关闭发生后仍引用同一段文字。
          if (selection.kind === "translate") {
            translate(event.doc, button, selection)
            return
          }
          void Promise.resolve().then(() => { if (active) return onAction(selection) })
            .catch(() => {
              if (active && documents.has(event.doc)) feedback.show(button, "操作未完成，请稍后重试，或打开 Jadense 对话查看。")
            })
        })
        group.append(button)
      }
      if (type === "renderToolbar") {
        const articleLanguages = translationLanguageControls(event.doc, "文章")
        articleLanguages.disable(true)
        const menu = event.doc.createElement("span")
        menu.className = "jadense-article-language-menu"
        const toggle = event.doc.createElement("button")
        toggle.type = "button"
        toggle.className = "jadense-article-language-toggle"
        toggle.textContent = "语言"
        toggle.title = "当前文章的翻译语言"
        toggle.setAttribute("aria-label", "文章翻译语言设置")
        toggle.setAttribute("aria-expanded", "false")
        let open = false
        const setOpen = (value: boolean) => {
          open = value
          toggle.setAttribute("aria-expanded", String(open))
          // 原生 toolbar 自有堆叠上下文；展开时挂到 body，避免被翻译结果与提示遮住。
          if (open) {
            articleLanguages.element.setAttribute("data-jadense-language-popover", "")
            ;(event.doc.body || event.doc.documentElement).append(articleLanguages.element)
          } else {
            articleLanguages.element.removeAttribute("data-jadense-language-popover")
            menu.append(articleLanguages.element)
          }
        }
        toggle.addEventListener("click", () => { setOpen(!open); if (open) articleLanguageRefreshes.get(group)?.() })
        articleLanguageClosers.set(group, () => {
          if (!open) return false
          setOpen(false)
          if (event.doc.activeElement && menu.contains(event.doc.activeElement)) toggle.focus()
          return true
        })
        menu.append(toggle, articleLanguages.element)
        group.append(menu)
        let saving = false
        let revision = 0
        const refresh = () => {
          if (saving) return
          const current = ++revision
          void readArticleTranslationLanguages(zotero, event.reader.itemID).then((languages) => {
            if (!active || !group.isConnected || current !== revision) return
            articleLanguages.set(languages)
            toggle.title = `当前文章：${translationLanguageLabel(languages.sourceLanguage)} → ${translationLanguageLabel(languages.targetLanguage)}`
            articleLanguages.disable(false)
          })
        }
        articleLanguageRefreshes.set(group, refresh)
        refresh()
        const saveLanguages = async () => {
          if (saving) return
          saving = true
          revision += 1
          articleLanguages.disable(true)
          const saved = await writeArticleTranslationLanguages(zotero, event.reader.itemID, articleLanguages.get())
          if (!active || !group.isConnected) return
          if (!saved) {
            articleLanguages.set(await readArticleTranslationLanguages(zotero, event.reader.itemID))
            if (!active || !group.isConnected) return
            feedback.show(articleLanguages.element, "未能保存文章翻译语言，请稍后重试；仍可在翻译浮窗修改本句语言。")
          }
          saving = false
          articleLanguages.disable(false)
          // 同篇多附件窗口共享文章偏好；重新读取各自身份，不把本句快照一并覆盖。
          if (saved) for (const refresh of articleLanguageRefreshes.values()) refresh()
        }
        articleLanguages.source.addEventListener("change", () => { void saveLanguages() })
        articleLanguages.target.addEventListener("change", () => { void saveLanguages() })
      }
      nodes.add(group)
      event.append(group)
    }
    handlers.set(type, handler)
    try { zotero.Reader.registerEventListener(type, handler, pluginID) } catch { cleanup(); break }
  }
  return cleanup
}
