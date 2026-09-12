/** 连续全文容量切片：版面块只提供来源映射，不决定请求数；公式占位符不可拆。 */
import type { PdfTextDocument, PdfParagraph } from './pdf-document'
import type { TranslationPage } from './document-store'
import type { ZoteroLike } from './runtime'
import { featureModelState, readByokSettings } from './ai-settings'

export const OCR_EXTRACTION_VERSION = 5
export const TRANSLATION_CAPACITY_PREF = 'extensions.jadenseInZotero.translationCapacity'
export const FORMULA_MARKER = /⟦F\d+⟧/gu
export const tokenCost = (text: string) => [...text].reduce((sum, c) => sum + (c.charCodeAt(0) < 128 ? 1 / 3 : 1.5), 0)

export function translationCapacity(host: ZoteroLike) {
  let local: { contextWindow?: number; maxOutputTokens?: number } = {}
  try { local = JSON.parse(String(host.Prefs?.get(TRANSLATION_CAPACITY_PREF, true) ?? '{}')) ?? {} } catch { /* 可选容量降级。 */ }
  const valid = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value >= 1024 ? Math.floor(value) : fallback
  const selection = featureModelState(host, 'translation').selection
  const model = selection.route === 'byok' ? readByokSettings(host).models.find(row => row.id === selection.modelId) : undefined
  const contextWindow = valid(model?.contextWindow, valid(local.contextWindow, 16384))
  const maxOutputTokens = valid(model?.maxOutputTokens, valid(local.maxOutputTokens, 8192))
  // 译文最坏估算为原文 token 的 3 倍；预留提示词与输出格式开销。
  return { contextWindow, maxOutputTokens, sourceTokens: Math.max(32, Math.floor(Math.min((contextWindow - 1024) / 4, (maxOutputTokens - 256) / 3))) }
}

/** 优先采用容量最后 20% 中的句界/空白；没有边界则按 Unicode 字符切开。 */
export function capacitySlices(text: string, limit: number, measure: (text: string) => number): Array<{ text: string; start: number; end: number }> {
  const units = text.match(/!\[[^\]\n]*\]\(jdx-asset:image-\d+\)|⟦F\d+⟧|[^]/gu) ?? []
  const result = []
  let start = 0, offset = 0
  while (start < units.length) {
    let end = start, cost = 0, boundary = start
    while (end < units.length && cost + measure(units[end]) <= limit) {
      cost += measure(units[end]); end++
      if (cost >= limit * .8 && /[\s。！？.!?]/u.test(units[end - 1])) boundary = end
    }
    if (end === start && /^!\[/u.test(units[start])) end++ // 图片引用不发送给 Provider，始终作为完整原子保留。
    if (end === start) throw new Error('Translation capacity cannot fit one source unit')
    const stop = end === units.length ? end : boundary > start ? boundary : end
    const part = units.slice(start, stop).join('')
    result.push({ text: part, start: offset, end: offset + part.length })
    offset += part.length; start = stop
  }
  return result
}

/** 每片保留覆盖的所有原文区间与页坐标；显示段落留在 Markdown 内部。 */
export function chunkTranslationDocument(document: PdfTextDocument & { markdown?: string }, limit: number, measure = tokenCost): TranslationPage[] {
  const originals: Array<{ paragraph: PdfParagraph; start: number; end: number }> = []
  let text = ''
  for (const page of document.pages) for (const paragraph of page.paragraphs) {
    if (!paragraph.text) continue
    if (text) text += '\n\n'
    const start = text.length; text += paragraph.text
    originals.push({ paragraph, start, end: text.length })
  }
  const pages: TranslationPage[] = document.pages.map(page => ({ ...page, lines: [], paragraphs: [], pieces: [], translations: {} }))
  // 独立提取成果以保存的 Markdown 为正文权威；块数据只提供原文位置。
  for (const [index, slice] of capacitySlices(document.markdown ?? text, limit, measure).entries()) {
    const sources = originals.filter(row => row.start < slice.end && row.end > slice.start)
    const first = sources[0]?.paragraph ?? originals.at(-1)?.paragraph
    if (!first) continue
    const byPage = new Map<number, NonNullable<PdfParagraph['locations']>[number]>()
    for (const location of sources.flatMap(row => row.paragraph.locations?.length ? row.paragraph.locations : [{ pageIndex: row.paragraph.pageIndex, pageLabel: String(row.paragraph.pageIndex + 1), rects: row.paragraph.rects }])) {
      const previous = byPage.get(location.pageIndex)
      if (previous) previous.rects.push(...location.rects)
      else byPage.set(location.pageIndex, { pageIndex: location.pageIndex, pageLabel: String(location.pageIndex + 1), rects: [...location.rects] })
    }
    const locations = [...byPage.values()]
    const formulas = Object.assign({}, ...sources.map(row => row.paragraph.formulas ?? {})) as Record<string, string>
    const id = `chunk-${index}`
    const paragraph: PdfParagraph = { id, text: slice.text, pageIndex: first.pageIndex, pageLabel: String(first.pageIndex + 1), rects: first.rects,
      lineIDs: sources.map(row => row.paragraph.id), locations, sourceRange: { start: slice.start, end: slice.end }, formulas }
    const page = pages[first.pageIndex]
    page.paragraphs.push(paragraph); page.pieces.push({ id, paragraphID: id, text: slice.text })
  }
  return pages
}

export function hasTranslatableText(text: string) { return /\p{L}/u.test(text.replace(FORMULA_MARKER, '').replace(/!\[[^\]\n]*\]\(jdx-asset:image-\d+\)/gu, '')) }

/** 公式缺失不会被当成完成；保持草稿供查看，用户继续时重试此片。 */
export function formulasPreserved(source: string, translated: string) {
  const markers = /⟦F\d+⟧|!\[[^\]\n]*\]\(jdx-asset:image-\d+\)/gu
  const expected = source.match(markers) ?? [], actual = translated.match(markers) ?? []
  return expected.length === actual.length && expected.every((marker, i) => marker === actual[i])
}
