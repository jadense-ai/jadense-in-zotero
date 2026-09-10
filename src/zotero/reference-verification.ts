/** 引用核验与原生导入：核验零 AI/零文库写入；仅匹配成功的 DOI 能进入可写目标库。 */
import { metadataMatches, normalizeDoi, type ReferenceEntry, type ReferenceMetadata } from "@/chat/reference-list"
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
  const creators = Array.isArray(row.creators) ? row.creators as Array<Record<string, unknown>> : []
  const title = text(row.title)
  const doi = normalizeDoi(text(row.DOI))
  if (!title || !doi) return null
  return { title, doi, authors: creators.filter(c => !c.creatorType || c.creatorType === "author").map(c => [text(c.lastName) || text(c.name), text(c.firstName)].filter(Boolean).join(", ")).filter(Boolean),
    year: text(row.date).match(/\b(?:18|19|20)\d{2}\b/u)?.[0] ?? "", publicationTitle: text(row.publicationTitle),
    url: /^https?:\/\//iu.test(text(row.url)) ? text(row.url) : `https://doi.org/${doi}`, itemType: text(row.itemType) || "journalArticle" }
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
  async verify(entry: ReferenceEntry, signal?: AbortSignal): Promise<void> {
    if (entry.verification === "verified" && entry.verified) return
    entry.verification = "unverified"; delete entry.verified
    try {
      checkCancelled(signal)
      let doi = entry.fields.doi
      if (!doi && entry.fields.title && entry.fields.authors.length && entry.fields.year) {
        const query = new URLSearchParams({ "query.bibliographic": [entry.fields.title, entry.fields.authors.join(" "), entry.fields.year].join(" "), rows: "3" })
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal?.addEventListener("abort", abort, { once: true })
        const timer = setTimeout(abort, 20000)
        try {
          const response = await this.fetchImpl(`https://api.crossref.org/works?${query}`, { signal: controller.signal })
          if (!response.ok) throw new Error(response.status === 429 ? uiText("查询限流，请稍后统一重新核验", "Rate limited; verify again later") : `Crossref HTTP ${response.status}`)
          const data = await response.json() as { message?: { items?: Array<Record<string, unknown>> } }
          const matches = (data.message?.items ?? []).flatMap(row => {
            const candidate: ReferenceMetadata = { title: Array.isArray(row.title) ? text(row.title[0]) : "", doi: normalizeDoi(text(row.DOI)),
              authors: Array.isArray(row.author) ? (row.author as Array<{ family?: string }>).map(a => a.family || "") : [],
              year: String(((row.published as { "date-parts"?: number[][] } | undefined)?.["date-parts"]?.[0]?.[0]) ?? "") }
            return candidate.doi && metadataMatches(entry.fields, candidate) ? [candidate] : []
          })
          const unique = [...new Set(matches.map(row => row.doi!))]
          if (unique.length === 1) doi = unique[0]
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort) }
      }
      checkCancelled(signal)
      if (!doi) { entry.reason = uiText("无已验证 DOI", "No verified DOI"); return }
      const matches = (await this.lookup(normalizeDoi(doi))).filter(row => metadataMatches(entry.fields, row))
      checkCancelled(signal)
      if (matches.length !== 1) { entry.reason = uiText("DOI 与原始引用的匹配证据不足", "The DOI could not be matched to the original citation"); return }
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
  if (entry.verification !== "verified" || !metadata?.doi || !metadataMatches(entry.fields, metadata)) throw new Error(uiText("仅可导入已核验匹配的 DOI 条目", "Only verified DOI matches can be imported"))
  if (!host.Libraries?.get(libraryID)?.editable) throw new Error(uiText("目标文库不可写", "The destination library is read-only"))
  if (collectionID !== undefined && host.Collections?.get(collectionID)?.libraryID !== libraryID) throw new Error(uiText("分类不属于目标文库", "The collection is not in the destination library"))
  if (!host.Search || !host.Item) throw new Error(uiText("Zotero 导入接口不可用", "Zotero import is unavailable"))
  const search = new host.Search(); search.libraryID = libraryID
  search.addCondition("DOI", "contains", metadata.doi)
  for (const id of await search.search()) {
    const item = await host.Items?.get(id) as NativeItem | undefined
    if (item && !item.deleted && item.libraryID === libraryID && normalizeDoi(String(item.getField?.("DOI") || "")) === metadata.doi) {
      return { libraryID, itemID: item.id, itemKey: item.key }
    }
  }
  if (entry.importUncertain) throw new Error(uiText("上次写入结果未确认，请先在 Zotero 检查；不会自动重试写入。", "The previous write is uncertain. Check Zotero before retrying."))
  const supported = ["journalArticle", "book", "bookSection", "conferencePaper", "report", "thesis", "webpage", "preprint"]
  const item = new host.Item(supported.includes(metadata.itemType || "") ? metadata.itemType! : "journalArticle")
  item.libraryID = libraryID
  item.setField("title", metadata.title); item.setField("DOI", metadata.doi); item.setField("date", metadata.year)
  if (metadata.url) item.setField("url", metadata.url)
  if (metadata.publicationTitle && (!metadata.itemType || metadata.itemType === "journalArticle")) item.setField("publicationTitle", metadata.publicationTitle)
  item.setCreators(metadata.authors.map(name => { const [lastName, ...first] = name.split(","); return { lastName: lastName.trim(), firstName: first.join(",").trim(), creatorType: "author" } }))
  if (collectionID !== undefined) item.setCollections?.([collectionID])
  entry.importUncertain = true
  await beforeWrite?.()
  await item.saveTx()
  return { libraryID, itemID: item.id, itemKey: item.key }
}
