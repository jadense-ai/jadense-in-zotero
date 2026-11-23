/** 解析笔记只从同一 Zotero 附件的原生批注读取定位。纯文本、重复引文及历史页标仍可阅读。 */
import { ANALYSIS_CATEGORIES } from '@/chat/paper-analysis'
import type { PaperAnalysisSource } from '@/chat/paper-analysis-history'
import { navigateDocument, type DocumentHost, type PdfRect } from './pdf-document'

type Annotation = {
  key?: string; parentItemID?: number; deleted?: boolean; annotationText?: string
  annotationPageLabel?: string; annotationPosition?: string; getTags?(): { tag: string }[]
}
type Attachment = { id: number; libraryID: number; key: string; deleted?: boolean; isPDFAttachment?(): boolean; getAnnotations?(): Annotation[] }
type Note = { pageLabel: string; category: string; quote: string }
type Origin = { key: string; pageIndex: number; rects: PdfRect[] }

function noteKey(note: Note) { return JSON.stringify([note.pageLabel, note.category, note.quote.trim().normalize('NFC')]) }

/** 按当前附件、页标、攻玉分类和完整引文匹配；同一引文有两处真实位置时保留歧义。 */
async function nativeOrigins(host: DocumentHost, source: PaperAnalysisSource) {
  const origins = new Map<string, Origin | null>()
  if (!host.Reader?.open) return origins
  const item = await host.Items?.get?.(source.itemID) as Attachment | undefined
  if (!item?.isPDFAttachment?.() || item.deleted || item.id !== source.itemID || item.libraryID !== source.libraryID || item.key !== source.itemKey) return origins
  for (const annotation of item.getAnnotations?.() ?? []) {
    try {
      if (annotation.deleted || annotation.parentItemID !== item.id || !annotation.key || !annotation.annotationText || !annotation.annotationPageLabel) continue
      const position = JSON.parse(annotation.annotationPosition ?? 'null') as Origin | null
      if (!position || !Number.isSafeInteger(position.pageIndex) || position.pageIndex < 0 || !Array.isArray(position.rects) || !position.rects.length) continue
      if (!position.rects.every(rect => Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1])) continue
      const tags = annotation.getTags?.() ?? []
      for (const category of ANALYSIS_CATEGORIES) {
        if (!tags.some(tag => tag.tag === `Jadense AI/${category.id}`)) continue
        const key = noteKey({ pageLabel: annotation.annotationPageLabel, quote: annotation.annotationText, category: category.label })
        origins.set(key, origins.has(key) ? null : { key: annotation.key, pageIndex: position.pageIndex, rects: position.rects })
      }
    } catch { /* 一条批注不可读时，其余原文跳转仍可用。 */ }
  }
  return origins
}

/** 点击时重新核对仍存在的同一条批注，避免使用已经删除或移动的旧坐标。 */
export async function readAnalysisNoteOrigins(host: DocumentHost, source: PaperAnalysisSource) {
  const origins = await nativeOrigins(host, source)
  return (note: Note) => {
    const key = noteKey(note), origin = origins.get(key)
    if (!origin) return
    return async () => {
      const current = (await nativeOrigins(host, source)).get(key)
      if (!current || current.key !== origin.key) return false
      await navigateDocument(host, source, current)
      return true
    }
  }
}
