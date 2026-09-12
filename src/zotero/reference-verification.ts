/** 本机查询与原生导入：Zotero 转换器/公开 Crossref 直连，不使用攻玉连接、认证或 AI。 */
import { metadataMatches, normalizeDoi, normalizedTitle, type ReferenceEntry, type ReferenceMetadata } from "@/chat/reference-list"
import { checkCancelled } from "./pdf-document"
import { uiText } from "./ui-preferences"

type NativeItem = { id: number; key: string; libraryID: number; deleted?: boolean; getField?(key: string): unknown; setField(key: string, value: string): void; setCreators(value: unknown[]): void; setCollections?(ids: number[]): void; saveTx(): Promise<unknown> }
export type ReferenceHost = {
  Translate?: { Search: new () => { setIdentifier(value: { DOI: string }): void; getTranslators(): Promise<unknown[]>; setTranslator(value: unknown[]): void; translate(options: { libraryID: false; saveAttachments: false }): Promise<unknown[]> } }
  Libraries?: { get(id: number): { editable?: boolean } | undefined; getAll?(): Array<{ libraryID: number; name: string; editable?: boolean }> }
  Collections?: { get(id: number): { libraryID: number } | undefined; getByLibrary?(id: number, recursive?: boolean): Array<{ id: number; name: string }> }
  Search?: new () => { libraryID: number; addCondition(field: string, operator: string, value: string): void; search(): Promise<number[]> }
  Item?: new (type: string) => NativeItem
  Items?: { get(id: number): unknown }
}

function text(value: unknown) { return typeof value === "string" ? value.trim() : "" }
export function nativeMetadata(value: unknown): ReferenceMetadata | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const creators = Array.isArray(row.creators) ? row.creators.filter(c => c && typeof c === "object") as Array<Record<string, unknown>> : []
  const title = text(row.title)
  const doi = normalizeDoi(text(row.DOI))
  if (!title) return null
  return { title, ...(doi ? { doi } : {}), authors: creators.filter(c => !c.creatorType || c.creatorType === "author").map(c => [text(c.lastName) || text(c.name), text(c.firstName)].filter(Boolean).join(", ")).filter(Boolean),
    year: text(row.date).match(/\b(?:18|19|20)\d{2}\b/u)?.[0] ?? "", publicationTitle: text(row.publicationTitle),
    url: /^https?:\/\//iu.test(text(row.url)) ? text(row.url) : doi ? `https://doi.org/${doi}` : undefined, itemType: text(row.itemType) || "journalArticle" }
}

/** 公开元数据只选取书目字段；单个损坏候选不影响同批其他结果。 */
function crossrefMetadata(value: unknown): ReferenceMetadata | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const first = (value: unknown) => Array.isArray(value) ? text(value[0]) : text(value)
  const date = [row.published, row["published-print"], row["published-online"], row.issued]
    .map(value => (value as { "date-parts"?: unknown[][] } | null)?.["date-parts"]?.[0]?.[0]).find(value => typeof value === "number")
  const types: Record<string, string> = { book: "book", "book-chapter": "bookSection", "proceedings-article": "conferencePaper", dissertation: "thesis", report: "report", "posted-content": "preprint" }
  return nativeMetadata({ title: first(row.title), DOI: row.DOI, date: date ? String(date) : "", url: row.URL,
    publicationTitle: first(row["container-title"]), itemType: types[text(row.type)] || "journalArticle",
    creators: Array.isArray(row.author) ? row.author.filter(a => a && typeof a === "object").map(a => ({ lastName: a.family || a.name, firstName: a.given })) : [] })
}

async function timeout<T>(promise: Promise<T>, milliseconds = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Metadata lookup timed out")), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export class ReferenceVerifier {
  private cache = new Map<string, ReferenceMetadata[]>()
  constructor(private host: ReferenceHost, private fetchImpl: typeof fetch) {}
  private async lookup(doi: string) {
    if (this.cache.has(doi)) return this.cache.get(doi)!
    if (!this.host.Translate?.Search) throw new Error(uiText("Zotero DOI 转换器不可用", "Zotero DOI translators unavailable"))
    const search = new this.host.Translate.Search()
    search.setIdentifier({ DOI: doi })
    search.setTranslator(await timeout(search.getTranslators()))
    const result = (await timeout(search.translate({ libraryID: false, saveAttachments: false }))).map(nativeMetadata).filter((row): row is ReferenceMetadata => Boolean(row?.doi === doi))
    if (result.length) this.cache.set(doi, result)
    return result
  }
  private async crossref(path: string, signal?: AbortSignal) {
    const key = `crossref:${path}`
    if (this.cache.has(key)) return this.cache.get(key)!
    const controller = new AbortController(), abort = () => controller.abort()
    signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, 20000)
    try {
      checkCancelled(signal)
      const response = await this.fetchImpl(`https://api.crossref.org/works${path}`, { signal: controller.signal, credentials: "omit", redirect: "error" })
      if (!response.ok) throw new Error(response.status === 429 ? uiText("查询限流，请稍后统一重新核验", "Rate limited; verify again later") : `Crossref HTTP ${response.status}`)
      const data = await response.json() as { message?: unknown }
      const items = (data?.message as { items?: unknown } | undefined)?.items
      const result = (Array.isArray(items) ? items : [data?.message]).map(crossrefMetadata).filter((row): row is ReferenceMetadata => Boolean(row))
      if (result.length) this.cache.set(key, result)
      return result
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort) }
  }
  async verify(entry: ReferenceEntry, signal?: AbortSignal): Promise<void> {
    if (entry.verification === "verified" && entry.verified) return
    entry.verification = "unverified"; delete entry.verified
    try {
      checkCancelled(signal)
      const doi = entry.fields.doi ? normalizeDoi(entry.fields.doi) : ""
      let candidates: ReferenceMetadata[] = []
      if (doi) {
        try { candidates = await this.lookup(doi) } catch { checkCancelled(signal) /* 转换器失败改为本机直接查询。 */ }
        if (!candidates.some(row => metadataMatches(entry.fields, row))) {
          try { candidates = await this.crossref(`/${encodeURIComponent(doi)}`, signal) } catch (error) {
            checkCancelled(signal)
            if (!entry.fields.title) throw error
          }
        }
      }
      if (!candidates.some(row => metadataMatches(entry.fields, row)) && entry.fields.title) {
        const query = new URLSearchParams({ "query.title": entry.fields.title, rows: "5" })
        candidates = await this.crossref(`?${query}`, signal)
      }
      checkCancelled(signal)
      const matches = [...new Map(candidates.filter(row => metadataMatches(entry.fields, row)).map(row => [row.doi || normalizedTitle(row.title), row])).values()]
      if (matches.length !== 1) { entry.reason = uiText("未找到唯一匹配文献，可按原文搜索", "No unique match; search using the original citation"); return }
      entry.verified = matches[0]; entry.verification = "verified"; delete entry.reason
    } catch (error) {
      checkCancelled(signal)
      entry.reason = error instanceof Error ? error.message : uiText("未验证", "Unverified")
    }
  }
}

/** 已验证状态和匹配证据在执行层再次核对；未验证条目不能通过批量调用进入此处。 */
export async function importReference(host: ReferenceHost, entry: ReferenceEntry, libraryID: number, collectionID?: number, beforeWrite?: () => Promise<void>) {
  const metadata = entry.verified
  if (entry.verification !== "verified" || !metadata || !metadataMatches(entry.fields, metadata)) throw new Error(uiText("仅可导入已核验匹配的文献", "Only verified metadata matches can be imported"))
  if (!host.Libraries?.get(libraryID)?.editable) throw new Error(uiText("目标文库不可写", "The destination library is read-only"))
  if (collectionID !== undefined && host.Collections?.get(collectionID)?.libraryID !== libraryID) throw new Error(uiText("分类不属于目标文库", "The collection is not in the destination library"))
  if (!host.Search || !host.Item) throw new Error(uiText("Zotero 导入接口不可用", "Zotero import is unavailable"))
  const search = new host.Search(); search.libraryID = libraryID
  search.addCondition(metadata.doi ? "DOI" : "title", "contains", metadata.doi || metadata.title)
  for (const id of await search.search()) {
    const item = await host.Items?.get(id) as NativeItem | undefined
    if (item && !item.deleted && item.libraryID === libraryID && (metadata.doi ? normalizeDoi(String(item.getField?.("DOI") || "")) === normalizeDoi(metadata.doi) : normalizedTitle(String(item.getField?.("title") || "")) === normalizedTitle(metadata.title))) {
      return { libraryID, itemID: item.id, itemKey: item.key }
    }
  }
  if (entry.importUncertain) throw new Error(uiText("上次写入结果未确认，请先在 Zotero 检查；不会自动重试写入。", "The previous write is uncertain. Check Zotero before retrying."))
  const supported = ["journalArticle", "book", "bookSection", "conferencePaper", "report", "thesis", "webpage", "preprint"]
  const item = new host.Item(supported.includes(metadata.itemType || "") ? metadata.itemType! : "journalArticle")
  item.libraryID = libraryID
  item.setField("title", metadata.title); if (metadata.doi) item.setField("DOI", metadata.doi); item.setField("date", metadata.year)
  if (metadata.url) item.setField("url", metadata.url)
  if (metadata.publicationTitle && (!metadata.itemType || metadata.itemType === "journalArticle")) item.setField("publicationTitle", metadata.publicationTitle)
  item.setCreators(metadata.authors.map(name => { const [lastName, ...first] = name.split(","); return { lastName: lastName.trim(), firstName: first.join(",").trim(), creatorType: "author" } }))
  if (collectionID !== undefined) item.setCollections?.([collectionID])
  entry.importUncertain = true
  await beforeWrite?.()
  await item.saveTx()
  return { libraryID, itemID: item.id, itemKey: item.key }
}
