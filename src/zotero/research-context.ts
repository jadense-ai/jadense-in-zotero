import { uiText } from "./ui-preferences"
/**
 * Zotero 本地文献/文件与对话来源之间的适配层。
 * 只读取调用方明确指定的条目或当前选择；正文提取是可降级的可选能力，
 * 不遍历资料库、不上传文件，也不把来源中的 URL 当作可执行操作。
 */
import { MAX_CHAT_SOURCES, normalizeChatSources, type ChatSource } from "@/chat/research-context"
import type { ZoteroLike } from "./runtime"

export { createQuoteSource } from "@/chat/research-context"

export const MAX_PDF_SOURCE_PAGES = 80

export type ResearchZotero = Omit<ZoteroLike, "Items" | "getActiveZoteroPane"> & {
  Items?: ZoteroLike["Items"] & {
    getAsync?(itemID: number): Promise<unknown>
  }
  PDFWorker?: {
    getFullText?(itemID: number, maxPages: number): Promise<unknown>
  }
  Reader?: {
    open?(itemID: number, location?: { pageIndex: number }): unknown | Promise<unknown>
  }
  getActiveZoteroPane?: () => {
    getSelectedItems?: () => unknown[]
    getSelectedCollection?: () => unknown
    selectItem?(itemID: number): unknown | Promise<unknown>
  }
}

type LocalItem = Record<string, unknown>

function itemRecord(value: unknown): LocalItem | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LocalItem : null
}

function positiveID(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/** 在独立原生选择器内明确选择文献或附件；取消返回 []，入口不可用返回 null，不回退到主窗口选区。 */
export async function chooseChatSourceItems(zotero: ResearchZotero): Promise<number[] | null> {
  try {
    const win = zotero.getMainWindow?.() as (Window & {
      openDialog?(url: string, name: string, features: string, io: unknown): unknown
    }) | null | undefined
    if (!win?.openDialog) return null
    const io = { dataIn: null, dataOut: null as unknown, onlyRegularItems: false, multiSelect: true }
    // Zotero 9.0.5 selectItemsDialog.js：regularOnly=false 保留附件树，modal 关闭后 dataOut 为已选 ID。
    // https://github.com/zotero/zotero/blob/9.0.5/chrome/content/zotero/selectItemsDialog.js
    win.openDialog("chrome://zotero/content/selectItemsDialog.xhtml", "", "chrome,dialog=no,modal,centerscreen,resizable=yes", io)
    return Array.isArray(io.dataOut) ? [...new Set(io.dataOut.filter(positiveID))] : []
  } catch {
    return null
  }
}

function predicate(item: LocalItem, name: string) {
  try {
    return typeof item[name] === "function" ? Boolean(item[name].call(item)) : item[name] === true
  } catch {
    return false
  }
}

function field(item: LocalItem, name: string) {
  try {
    const value = typeof item.getField === "function" ? item.getField.call(item, name) : item[name]
    return typeof value === "string" ? value.trim() : ""
  } catch {
    return ""
  }
}

function isAttachment(item: LocalItem) {
  return predicate(item, "isAttachment") || item.itemType === "attachment"
}

function contentType(item: LocalItem) {
  return typeof item.attachmentContentType === "string" ? item.attachmentContentType.toLowerCase().trim() : ""
}

function isPDF(item: LocalItem) {
  return predicate(item, "isPDFAttachment") || contentType(item) === "application/pdf"
}

function availableItem(value: unknown) {
  const item = itemRecord(value)
  return item && item.deleted !== true && !predicate(item, "isNote") && !predicate(item, "isAnnotation")
    && item.itemType !== "note" && item.itemType !== "annotation" ? item : null
}

/** 通过本地 ID 读取一个条目；失效引用只使该来源不可用。 */
async function localItem(zotero: ResearchZotero, itemID: unknown): Promise<LocalItem | null> {
  if (!positiveID(itemID)) return null
  try {
    const item = availableItem(zotero.Items?.getAsync
      ? await zotero.Items.getAsync(itemID)
      : await zotero.Items?.get?.(itemID))
    return item?.id === itemID ? item : null
  } catch {
    return null
  }
}

function authors(item: LocalItem) {
  try {
    const value = typeof item.getCreators === "function" ? item.getCreators.call(item) : []
    if (!Array.isArray(value)) return ""
    return value.slice(0, 8).map((creator) => {
      const row = itemRecord(creator)
      if (!row) return ""
      return (typeof row.name === "string" ? row.name : [row.firstName, row.lastName]
        .filter((part) => typeof part === "string").join(" ")).slice(0, 160)
    }).filter(Boolean).join("; ")
  } catch {
    return ""
  }
}

function metadataSource(item: LocalItem): ChatSource | null {
  const title = field(item, "title") || uiText("未命名 Zotero 来源", "Untitled Zotero source")
  const abstract = field(item, "abstractNote")
  const doi = field(item, "DOI")
  return normalizeChatSources([{
    kind: "item",
    itemID: item.id,
    libraryID: item.libraryID,
    itemKey: item.key,
    title,
    citation: [authors(item), field(item, "date"), title, field(item, "publicationTitle"), doi ? `DOI: ${doi}` : ""]
      .filter(Boolean).join(". "),
    text: abstract ? `摘要：${abstract}` : "",
  }])[0] ?? null
}

async function parentItem(zotero: ResearchZotero, item: LocalItem) {
  const parent = await localItem(zotero, item.parentID)
  return parent && parent.libraryID === item.libraryID && !isAttachment(parent) ? parent : null
}

/** 使用 Zotero 9 原生提取 API；PDF 不降级到可能触发无界全文提取的 attachmentText。 */
async function attachmentSource(zotero: ResearchZotero, item: LocalItem, includeText = true): Promise<ChatSource | null> {
  const reference = metadataSource(item)
  if (!reference) return null
  const parent = await parentItem(zotero, item)
  const parentSource = parent ? metadataSource(parent) : null
  const source: ChatSource = {
    ...reference,
    id: "",
    kind: "file",
    citation: parentSource?.citation || reference.citation,
    text: "",
    ...(contentType(item) ? { contentType: contentType(item) } : {}),
    ...(parentSource ? { parentItem: {
      itemID: parentSource.itemID,
      libraryID: parentSource.libraryID,
      itemKey: parentSource.itemKey,
      title: parentSource.title,
    } } : {}),
  }
  if (!includeText) return normalizeChatSources([source])[0] ?? null
  try {
    if (isPDF(item)) {
      source.contentType = "application/pdf"
      // 官方 9.0.5：PDFWorker.getFullText(itemID, maxPages) -> { text, extractedPages, totalPages }。
      // https://github.com/zotero/zotero/blob/9.0.5/chrome/content/zotero/xpcom/pdfWorker/manager.js
      if (zotero.PDFWorker?.getFullText) {
        const result = itemRecord(await zotero.PDFWorker.getFullText(source.itemID, MAX_PDF_SOURCE_PAGES))
        source.text = typeof result?.text === "string" ? result.text.trim() : ""
        const extractedPages = result?.extractedPages
        const totalPages = result?.totalPages
        source.warning = positiveID(extractedPages) && positiveID(totalPages)
          ? uiText(`PDF 已提取 ${extractedPages} / ${totalPages} 页的可读文字${extractedPages < totalPages ? "；其余页面未提供" : ""}。`, `Extracted readable text from ${extractedPages} of ${totalPages} PDF pages.${extractedPages < totalPages ? " Other pages were not supplied." : ""}`)
          : uiText(`PDF 提取范围最多为前 ${MAX_PDF_SOURCE_PAGES} 页；未取得完整页数信息。`, `PDF extraction covers at most the first ${MAX_PDF_SOURCE_PAGES} pages; the total page count is unavailable.`)
        if (!source.text) source.warning += uiText(" 未找到可提取文字，可能是扫描件；仅保留来源引用。", " No extractable text was found. This may be a scan; only the source reference is retained.")
      } else {
        source.warning = uiText("当前 Zotero 未提供 PDF 文本提取接口；仅保留来源引用。", "PDF text extraction is unavailable in this Zotero version; only the source reference is retained.")
      }
    } else if (contentType(item).startsWith("text/") || contentType(item) === "application/xhtml+xml"
      || contentType(item) === "application/epub+zip") {
      // attachmentText 是 Promise getter，不读取/保存文件路径，也不自行抓取附件 URL。
      const extracted = await item.attachmentText
      source.text = typeof extracted === "string" ? extracted.trim() : ""
      source.warning = source.text
        ? uiText("使用 Zotero 可读文本；原始排版、图片与全文完整性未确认。", "Using text extracted by Zotero; layout, images, and full-text completeness have not been verified.")
        : uiText("Zotero 未提供此附件的可读文本；仅保留来源引用。", "Zotero supplied no readable text for this attachment; only the source reference is retained.")
    } else {
      source.warning = uiText("此附件暂不支持文本提取；仅保留来源引用。", "Text extraction is unavailable for this attachment; only the source reference is retained.")
    }
  } catch {
    // 原生错误可能含文件路径；不持久化或发送错误原文。
    source.warning = uiText("附件文字提取失败，可能未下载、加密或不可读；仅保留来源引用。", "Attachment text extraction failed. The file may be missing, encrypted, or unreadable; only the source reference is retained.")
  }
  return normalizeChatSources([source])[0] ?? null
}

/** 读取指定附件的文本，或指定文献的元数据；不自动关联其它条目。 */
export async function collectSourceForItem(
  zotero: ResearchZotero,
  itemID: number,
  options: { includeText?: boolean } = {},
): Promise<ChatSource | null> {
  const item = await localItem(zotero, itemID)
  return item ? isAttachment(item) ? attachmentSource(zotero, item, options.includeText !== false) : metadataSource(item) : null
}

/** 显式 ID 优先（包括空数组）；未指定 ID 时才读取 Zotero 当前选择。 */
export async function collectChatSources(
  zotero: ResearchZotero,
  input: { mode: "items" | "files" | "auto"; itemIDs?: number[] },
): Promise<ChatSource[]> {
  let selected: unknown[]
  if (input.itemIDs !== undefined) {
    selected = input.itemIDs
  } else {
    try {
      selected = zotero.getActiveZoteroPane?.()?.getSelectedItems?.() ?? []
    } catch {
      selected = []
    }
  }
  const sources: ChatSource[] = []
  const seen = new Set<string>()
  const files = new Map<number, ChatSource | null>()
  const add = (source: ChatSource | null) => {
    if (source && !seen.has(source.id)) {
      sources.push(source)
      seen.add(source.id)
    }
  }
  const collectAttachment = async (item: LocalItem) => {
    if (!positiveID(item.id)) return null
    // 同时选择父条目和附件、或拖入重复 ID 时，原生解析只执行一次。
    if (!files.has(item.id)) files.set(item.id, await attachmentSource(zotero, item))
    return files.get(item.id) ?? null
  }
  for (const selectedItem of selected) {
    try {
      const item = typeof selectedItem === "number" ? await localItem(zotero, selectedItem) : availableItem(selectedItem)
      if (!item) continue
      if (isAttachment(item)) {
        if (input.mode === "files") {
          const parent = await parentItem(zotero, item)
          if (parent) add(metadataSource(parent))
        }
        add(input.mode === "items"
          ? metadataSource(await parentItem(zotero, item) ?? item)
          : await collectAttachment(item))
      } else {
        const source = metadataSource(item)
        add(source)
        if (input.mode === "files" && source) {
          let attachments: unknown = []
          try {
            attachments = typeof item.getAttachments === "function" ? await item.getAttachments.call(item) : []
          } catch {
            source.warning = uiText("无法读取此文献的附件列表；已保留元数据和摘要。", "Could not read the attachment list. Metadata and the abstract were retained.")
            continue
          }
          let pdfCount = 0
          for (const id of Array.isArray(attachments) ? attachments : []) {
            const attachment = await localItem(zotero, id)
            // 展开附件仍须属于已选文献，不能因过时父子关系关联其它文献的文件。
            if (!attachment || attachment.parentID !== item.id || attachment.libraryID !== item.libraryID
              || !isAttachment(attachment) || !isPDF(attachment)) continue
            pdfCount += 1
            add(await collectAttachment(attachment))
            if (sources.length > MAX_CHAT_SOURCES) break
          }
          if (!pdfCount) source.warning = uiText("此文献没有可关联的 PDF 附件；已保留元数据和摘要。", "This item has no PDF attachment to link. Metadata and the abstract were retained.")
        }
      }
    } catch {
      // 单条目的可选元数据/附件不可用，不影响其余明确选择的来源。
    }
    if (sources.length > MAX_CHAT_SOURCES) break
  }
  return normalizeChatSources(sources)
}

/** 只打开核实过身份的本地来源；任何来源 URL、路径或 model 字段都不参与操作。 */
export async function openChatSource(zotero: ResearchZotero, source: ChatSource): Promise<boolean> {
  const normalized = normalizeChatSources([source])[0]
  if (!normalized) return false
  const item = await localItem(zotero, normalized.itemID)
  if (!item || item.key !== normalized.itemKey || item.libraryID !== normalized.libraryID) return false
  try {
    if (normalized.kind !== "item" && isAttachment(item) && zotero.Reader?.open
      && (isPDF(item) || ["application/epub+zip", "text/html", "application/xhtml+xml"].includes(contentType(item)))) {
      await zotero.Reader.open(normalized.itemID, normalized.pageIndex === undefined ? undefined : { pageIndex: normalized.pageIndex })
      return true
    }
    const pane = zotero.getActiveZoteroPane?.()
    if (pane?.selectItem) return await pane.selectItem(normalized.itemID) !== false
  } catch {
    // 本地文件已删除或阅读器不可用，不执行远程 URL 作为替代。
  }
  return false
}
