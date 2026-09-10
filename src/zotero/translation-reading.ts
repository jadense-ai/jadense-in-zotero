/** 译文阅读投影：自然段决定排版，片段决定请求，页面与坐标只用于持久化和原文定位。 */
import type { TranslationPage } from "./document-store"
import type { PdfParagraph } from "./pdf-document"

export type TranslationReadingBlock = {
  id: string; pageIndex: number; paragraphID: string; pieceIDs: string[]; section: string
}
export type TranslationReadingIndex = { version: 1; blocks: TranslationReadingBlock[] }
export type TranslationReadingRow = {
  block: TranslationReadingBlock; paragraph?: PdfParagraph; page?: TranslationPage; text?: string; missing?: boolean
}
export type TranslationReadingPosition = { blockID: string; offset: number }

/** 索引可随时从已持久化的原段落重建；标题不会被当作额外生成任务。 */
export function buildTranslationReadingIndex(pages: TranslationPage[]): TranslationReadingIndex {
  let section = ""
  const blocks = pages.flatMap(page => page.paragraphs.map(paragraph => {
    if (paragraph.heading) section = paragraph.text
    return { id: paragraph.id, pageIndex: page.pageIndex, paragraphID: paragraph.id,
      pieceIDs: page.pieces.filter(piece => piece.paragraphID === paragraph.id).map(piece => piece.id), section }
  }))
  return { version: 1, blocks }
}

/** 旧记录的分片仍属同一自然段；仅在 Markdown 结构边界换行，普通句子自然衔接。 */
export function joinTranslationPieces(parts: string[]) {
  return parts.reduce((all, part) => {
    const next = part.trim(); if (!all || !next) return all || next
    if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|\|)|^\$\$/mu.test(next) || /(?:```|\$\$)\s*$/u.test(all)) return `${all}\n\n${next}`
    return `${all}${/[\p{Script=Han}。！？；，：、）】”’]$/u.test(all) || /^[\p{Script=Han}]/u.test(next) ? "" : " "}${next}`
  }, "")
}

/** 缺页保留为明确缺口；索引损坏只重建投影，不阻断已保存译文。 */
export function translationReadingRows(pages: Array<TranslationPage | null>, saved?: TranslationReadingIndex | null): TranslationReadingRow[] {
  const available = pages.filter((page): page is TranslationPage => Boolean(page))
  const rebuilt = buildTranslationReadingIndex(available)
  const index = saved && saved.blocks.length === rebuilt.blocks.length
    && saved.blocks.every((block, i) => block.id === rebuilt.blocks[i].id && block.pageIndex === rebuilt.blocks[i].pageIndex && block.paragraphID === rebuilt.blocks[i].paragraphID)
    ? saved : rebuilt
  const rows: TranslationReadingRow[] = []
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]
    if (!page || page.warning && !page.paragraphs.length) {
      rows.push({ block: { id: `missing-page-${pageIndex}`, pageIndex, paragraphID: "", pieceIDs: [], section: "" }, missing: true })
      continue
    }
    for (const block of index.blocks.filter(block => block.pageIndex === pageIndex)) {
      const paragraph = page.paragraphs.find(value => value.id === block.paragraphID)
      // 从页面真实片段推导完成状态，忽略索引中未知或过期的可选片段字段。
      const pieces = page.pieces.filter(piece => piece.paragraphID === block.paragraphID)
      const complete = pieces.length > 0 && pieces.every(piece => typeof page.translations[piece.id] === "string" && page.translations[piece.id].trim())
      rows.push({ block, paragraph, page, ...(complete ? { text: joinTranslationPieces(pieces.map(piece => page.translations[piece.id])) } : {}) })
    }
  }
  return rows
}
