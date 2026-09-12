/** 从 Zotero 可信条目关系取得文献归属；历史身份不完整时不猜测同名文献。 */
import type { DocumentIdentity } from './pdf-document'
import type { ZoteroLike } from './runtime'

export type LiteratureIdentity = { itemID: number; libraryID: number; itemKey: string; title: string }

/** 归属快照是可选展示数据；字段不完整时舍弃，不拒绝成果正文。 */
export function readLiteratureIdentity(value: unknown): LiteratureIdentity | undefined {
  const row = value as Partial<LiteratureIdentity> | undefined
  return row && Number.isSafeInteger(row.itemID) && Number.isSafeInteger(row.libraryID) && typeof row.itemKey === 'string' && typeof row.title === 'string'
    ? { itemID: row.itemID!, libraryID: row.libraryID!, itemKey: row.itemKey, title: row.title } : undefined
}

/** 只在附件完整身份匹配后读取父条目；已删除附件可使用先前保存的身份快照。 */
export function literatureIdentity(host: ZoteroLike, source: Partial<DocumentIdentity>): LiteratureIdentity | undefined {
  type Item = { id: number; libraryID: number; key: string; parentItemID?: number; parentItem?: Item; getField?(field: string): unknown }
  try {
    const items = host.Items as unknown as { get(id: number): Item | undefined }
    const item = source.itemID ? items?.get(source.itemID) : undefined
    if (item && item.id === source.itemID && item.libraryID === source.libraryID && item.key === source.itemKey) {
      const parent = item.parentItem || (item.parentItemID ? items.get(item.parentItemID) : undefined)
      const owner = parent?.libraryID === item.libraryID ? parent : item
      return { itemID: owner.id, libraryID: owner.libraryID, itemKey: owner.key, title: String(owner.getField?.('title') || source.title || 'PDF') }
    }
  } catch { /* 元数据不可用不妨碍已保存成果阅读。 */ }
  const saved = source.literature
  return saved && Number.isSafeInteger(saved.itemID) && saved.libraryID === source.libraryID && typeof saved.itemKey === 'string' ? saved : undefined
}
