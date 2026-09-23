/** 对话正文的独立 profile 缓存：逐页写入、版本复核；不创建 OCR/翻译任务。 */
import type { ChatSource } from '@/chat/research-context'
import { DocumentStore } from './document-store'
import { readTextDocument, validateDocument, type DocumentHost, type DocumentIdentity, type DocumentPage } from './pdf-document'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

export type ChatDocumentState = {
  version: 1; id: string; source: DocumentIdentity; extractionVersion: 1
  totalPages: number; pageIndexes: number[]; complete: boolean; storageWarning?: boolean; extractionID?: string
  summaries: Record<string, { requestId: string; text?: string }>
}
export type ChatDocument = { state: ChatDocumentState; pages: DocumentPage[]; source: ChatSource }
export type DocumentProgress = (text: string) => void

/** 同一附件只有相同且已知的文件版本可复用，未知版本重新读取。 */
function sameFile(a: DocumentIdentity, b: DocumentIdentity) {
  return a.itemID === b.itemID && a.libraryID === b.libraryID && a.itemKey === b.itemKey
    && a.modificationTime !== undefined && a.modificationTime === b.modificationTime
}
const sameIdentity = (a: DocumentIdentity, b: DocumentIdentity) => a.itemID === b.itemID && a.libraryID === b.libraryID && a.itemKey === b.itemKey

export class ChatDocuments {
  private active = new Set<string>()
  private pending = new Map<string, Promise<ChatDocument>>()
  constructor(readonly store = new DocumentStore(undefined, undefined, 'jadense-chat-documents'), private documents = new DocumentStore()) {}

  async save(state: ChatDocumentState) {
    const saved = await this.store.saveChat(state)
    state.storageWarning ||= !saved
  }

  /** 只解析调用方已经关联的附件，提取前后都复核身份和文件版本。 */
  async ensure(host: ZoteroLike, source: ChatSource, signal?: AbortSignal, progress: DocumentProgress = () => {}, retry = false): Promise<ChatDocument> {
    const key = `${source.libraryID}/${source.itemKey}/${source.itemID}`
    let work = this.pending.get(key)
    if (!work) {
      work = this.read(host, source, signal, progress, retry)
      this.pending.set(key, work)
    }
    try { const result = await work; signal?.throwIfAborted(); return result }
    finally { if (this.pending.get(key) === work) this.pending.delete(key) }
  }

  private async read(host: ZoteroLike, source: ChatSource, signal?: AbortSignal, progress: DocumentProgress = () => {}, retry = false): Promise<ChatDocument> {
    signal?.throwIfAborted()
    const documentHost = host as unknown as DocumentHost
    await validateDocument(documentHost, source)
    const item = await host.Items?.get?.(source.itemID) as { attachmentModificationTime?: number | Promise<number | null> } | undefined
    const modified = await item?.attachmentModificationTime
    const identity: DocumentIdentity = { itemID: source.itemID, libraryID: source.libraryID, itemKey: source.itemKey, title: source.title,
      ...(typeof modified === 'number' && Number.isFinite(modified) ? { modificationTime: modified } : {}) }
    let state = source.document ? await this.store.chat(source.document.id) : null
    const reusableRecord = (row: ChatDocumentState) => row.extractionVersion === 1 && (sameFile(row.source, identity)
      || (identity.modificationTime === undefined && row.source.modificationTime === undefined && sameIdentity(row.source, identity)))
    if (!state || !reusableRecord(state)) {
      state = (await this.store.chats()).find(reusableRecord) ?? null
    }
    state ??= { version: 1, id: crypto.randomUUID(), source: identity, extractionVersion: 1, totalPages: 0, pageIndexes: [], complete: false, summaries: {} }
    this.active.add(state.id)
    try {
      let pages = (await Promise.all(state.pageIndexes.map(index => this.store.page(state!.id, index)))).filter((page): page is NonNullable<typeof page> => !!page)
      // 手动 OCR 产生的新原文可以补齐缺页；关联/发送本身绝不安装或启动 OCR。
      const extracted = (await this.documents.list()).find(task => task.kind === 'extraction' && ['complete', 'partial'].includes(task.status) && sameFile(task.source, identity))
      if (extracted && extracted.id !== state.extractionID) {
        const value = await this.documents.extraction(extracted.id)
        if (value?.pages.length === extracted.totalPages) {
          state.pageIndexes = []; state.summaries = {}; state.totalPages = extracted.totalPages
          for (const page of value.pages) {
            signal?.throwIfAborted()
            const saved = await this.store.savePage(state.id, { ...page, translations: {}, pieces: [] })
            state.storageWarning ||= !saved; state.pageIndexes.push(page.pageIndex)
          }
          pages = value.pages.map(page => ({ ...page, translations: {}, pieces: [] }))
          state.complete = true; state.extractionID = extracted.id
          await this.save(state)
        }
      }
      // 重新关联只补齐失败/空白页；完整且版本一致的缓存无需逐页重写状态。
      const retryMissing = retry && pages.some(page => !page.paragraphs.length || page.warning)
      if (!state.complete || pages.length !== state.totalPages || retryMissing || identity.modificationTime === undefined) {
        state.complete = false
        await this.save(state)
        const old = new Map(pages.map(page => [page.pageIndex, page]))
        const result = await readTextDocument(documentHost, source.itemID, signal, async (page, total) => {
          signal?.throwIfAborted()
          state!.totalPages = total
          if (old.get(page.pageIndex) !== page) {
            const saved = await this.store.savePage(state!.id, { ...page, translations: {}, pieces: [] })
            state!.storageWarning ||= !saved
            if (!state!.pageIndexes.includes(page.pageIndex)) state!.pageIndexes.push(page.pageIndex)
            await this.save(state!)
          }
          progress(uiText(`已提取 ${page.pageIndex + 1}/${total} 页`, `Extracted ${page.pageIndex + 1}/${total} pages`))
        }, identity.modificationTime === undefined ? [] : pages)
        await validateDocument(documentHost, identity)
        signal?.throwIfAborted()
        pages = result.pages.map(page => ({ ...page, translations: {}, pieces: [] }))
        const changed = pages.some(page => JSON.stringify(page.paragraphs) !== JSON.stringify(old.get(page.pageIndex)?.paragraphs)) || old.size !== pages.length
        state.totalPages = pages.length; state.pageIndexes = pages.map(page => page.pageIndex); state.complete = true
        if (changed) state.summaries = {}
        await this.save(state)
      }
      await validateDocument(documentHost, identity)
      signal?.throwIfAborted()
      const readablePages = pages.filter(page => page.paragraphs.some(row => row.text.trim())).length
      const missing = pages.filter(page => !page.paragraphs.some(row => row.text.trim()) || page.warning).map(page => page.pageLabel)
      const warning = [uiText(`已提取 ${pages.length}/${state.totalPages} 页；${readablePages} 页有可读文字。`, `Extracted ${pages.length}/${state.totalPages} pages; ${readablePages} pages contain readable text.`),
        missing.length ? uiText(`缺失或需核对的页码：${missing.slice(0, 20).join('、')}${missing.length > 20 ? ` 等 ${missing.length} 页` : ''}。可在全文 Markdown 中手动提取/OCR 后补齐。`, `Missing or uncertain pages: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` (${missing.length} pages total)` : ''}. Use Full Markdown extraction/OCR to fill the gaps.`) : '',
        state.storageWarning ? uiText('正文暂未完整保存到本机，重启后可能需要重新提取。', 'Local storage is incomplete; extraction may be needed after restarting.') : ''].filter(Boolean).join(' ')
      return { state, pages, source: { ...source, text: '', warning, document: { id: state.id, version: 1, totalPages: state.totalPages, readablePages, complete: state.complete } } }
    } finally { this.active.delete(state.id) }
  }

  /** 只清理无对话引用的专用缓存；独立文献任务目录永不进入此删除路径。 */
  async prune(sources: readonly ChatSource[]) {
    const used = new Set(sources.flatMap(source => source.document ? [source.document.id] : []))
    for (const state of await this.store.chats()) if (!used.has(state.id) && !this.active.has(state.id)) await this.store.delete(state.id)
  }
}

const caches = new WeakMap<object, ChatDocuments>()
export function chatDocuments(host: ZoteroLike) {
  let cache = caches.get(host)
  if (!cache) { cache = new ChatDocuments(); caches.set(host, cache) }
  return cache
}
