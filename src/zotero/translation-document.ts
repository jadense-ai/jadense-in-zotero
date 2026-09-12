/** 翻译专属文字整序：原始行不变，结合页边位置/重复与行几何恢复完整段落，供文档任务落盘。 */
import { orderColumnLines, type DocumentPage, type PdfLine, type PdfParagraph, type PdfTextDocument } from "./pdf-document"
import { uiText } from "./ui-preferences"

export const TRANSLATION_EXTRACTION_VERSION = 4
const terminal = /[.!?。！？][”’"')\]]*$/u
const heading = /^(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|introduction|background|results(?: and discussion)?|discussion|conclusions?|methods|materials and methods|references|bibliography|acknowledg[e]?ments|摘要|引言|方法|结果|讨论|结论|参考文献)$/iu
const caption = /^(?:fig(?:ure)?\.?|table|scheme|图|表)\s*\d+(?:[.:]\s|\s*[:：])/iu
const isHeading = (text: string) => {
  if (heading.test(text)) return true
  const title = text.match(/^(?:[1-9]\d?(?:\.\d{1,2})*\.?|[A-Z]\.)\s+([\p{Lu}\p{Script=Han}].*)$/u)?.[1]
  return Boolean(title && title.length < 100 && title.split(/\s+/u).length <= 12 && !/[.!?;,\u00ad]/u.test(title))
}
const height = (line: PdfLine) => line.fontSize || (line.rects[0] ? line.rects[0][3] - line.rects[0][1] : 0)
const signature = (line: PdfLine) => line.text.toLowerCase().replace(/\d+/gu, "#").replace(/\s+/gu, " ").trim()

/** 没有可靠页面尺寸时，不猜页边；短标题本身不是噪声证据。 */
function margin(line: PdfLine, page: DocumentPage) {
  const box = page.viewBox, rect = line.rects[0]
  if (!box || !rect) return ""
  const size = box[3] - box[1]
  if (rect[1] >= box[3] - size * .075) return "top"
  if (rect[3] <= box[1] + size * .075) return "bottom"
  return ""
}
function joinLines(lines: PdfLine[]) {
  return lines.reduce((text, line) => {
    const next = line.text.trim()
    if (!text) return next
    // 只删除明确的软连字符；普通连字符可能属于复合词，保留其语义。
    if (text.endsWith("\u00ad")) return text.slice(0, -1) + next
    if (/[-‐]$/u.test(text) || /[\p{Script=Han}]$/u.test(text) && /^[\p{Script=Han}]/u.test(next)) return text + next
    return text + " " + next
  }, "")
}

/** 利用字号、行距、缩进和栏宽判断段落；宿主逐行 paragraphBreakAfter 不能单独切碎正文。 */
function paragraphs(lines: PdfLine[], title: string): PdfParagraph[] {
  const result: PdfParagraph[] = [], group: PdfLine[] = []
  // 同栏常见基线间距比单行字形高度更能反映实际行距，避免上下标/字号波动制造碎段。
  const gaps = lines.slice(1).flatMap((line, index) => {
    const previous = lines[index], a = previous.rects[0], b = line.rects[0], h = Math.max(height(previous), height(line))
    const gap = a && b ? a[3] - b[3] : 0
    return a && b && Math.abs(a[0] - b[0]) < h * 2 && gap > h * .8 && gap < h * 2.5 ? [gap] : []
  }).sort((a, b) => a - b)
  const lineSpacing = gaps[Math.floor(gaps.length / 2)]
  const flush = () => {
    if (!group.length) return
    const rects = group.flatMap(line => line.rects)
    const text = joinLines(group)
    result.push({ ...group[0], text, rects, lineIDs: group.map(line => line.id),
      ...(isHeading(text) || text.toLowerCase() === title.toLowerCase() ? { heading: true } : {}),
      locations: [{ pageIndex: group[0].pageIndex, pageLabel: group[0].pageLabel, rects }] })
    group.length = 0
  }
  for (const line of lines) {
    const previous = group.at(-1), a = previous?.rects[0], b = line.rects[0]
    if (previous) {
      let boundary = Boolean(previous.paragraphEnd)
      if (a && b) {
        const h = Math.max(height(previous), height(line)), gap = a[3] - b[3]
        const column = b[0] > a[2] && b[3] > a[3]
        const columnWidth = Math.max(...lines.filter(row => row.rects[0] && Math.abs(row.rects[0][0] - a[0]) < h * 2).map(row => row.rects[0][2] - a[0]))
        const shortEnd = a[2] - a[0] < columnWidth * .88
        const indent = b[0] - a[0] > h * .7
        boundary = column ? terminal.test(previous.text) && shortEnd : gap <= 0 || gap > Math.max(h * 1.6, (lineSpacing || 0) * 1.35)
          || Math.abs(height(previous) - height(line)) > h * .25
          || terminal.test(previous.text) && (shortEnd || indent)
        if (caption.test(line.text) || isHeading(line.text) || isHeading(previous.text)
          || Math.abs(height(previous) - height(line)) > h * .25) boundary = true
      }
      if (boundary) flush()
    }
    group.push(line)
  }
  flush()
  return result
}

/** 保守排除重复页边文字和明确页码/文献类型标签；排除行保留供用户核对，不影响引用提取。 */
export function prepareTranslationDocument(document: PdfTextDocument): PdfTextDocument {
  const fonts = new Map<number, number>()
  for (const page of document.pages) for (const line of page.lines) {
    const size = Math.round(height(line) * 10) / 10
    if (size) fonts.set(size, (fonts.get(size) ?? 0) + line.text.length)
  }
  const bodyFont = [...fonts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  // 页底小字号附注独立保留，不得成为跨页正文的前半段。
  const footnote = (paragraph: PdfParagraph, page: DocumentPage) => Boolean(bodyFont && page.viewBox && paragraph.rects[0]
    && height(paragraph) < bodyFont * .95 && paragraph.rects[0][3] < page.viewBox[1] + (page.viewBox[3] - page.viewBox[1]) * .23)
  const occurrences = new Map<string, Set<number>>()
  for (const page of document.pages) for (const line of page.lines) {
    const edge = margin(line, page)
    if (!edge) continue
    const key = `${edge}:${signature(line)}`
    const seen = occurrences.get(key) ?? new Set<number>(); seen.add(page.pageIndex); occurrences.set(key, seen)
  }
  const pages = document.pages.map(page => {
    const excludedLines: PdfLine[] = [], kept: PdfLine[] = []
    for (const line of page.lines) {
      const edge = margin(line, page)
      const repeated = (occurrences.get(`${edge}:${signature(line)}`)?.size ?? 0) >= 2
      const furniture = /^(?:\d+|[ivxlcdm]+|page\s+\d+(?:\s+of\s+\d+)?|第\s*\d+\s*页)$/iu.test(line.text)
        || edge === "top" && /^(?:research\s+article|article|review\s+article|open\s+access)$/iu.test(line.text)
      const verticalIdentifier = /^arXiv:/iu.test(line.text) && line.rects[0] && line.rects[0][3] - line.rects[0][1] > (line.rects[0][2] - line.rects[0][0]) * 3
      ;(verticalIdentifier || edge && (repeated || furniture) ? excludedLines : kept).push(line)
    }
    const complex = kept.filter(line => line.text.length < 12 || line.rects[0] && line.rects[0][3] - line.rects[0][1] > (line.rects[0][2] - line.rects[0][0]) * 3).length
    return { ...page, paragraphs: paragraphs(orderColumnLines(kept), document.source.title), excludedLines, continuationFrom: [] as number[],
      ...(complex > 8 && complex > kept.length * .15 ? { layoutWarning: uiText(`原文 p.${page.pageLabel} 含图内文字或复杂排版，请对照 PDF 核对阅读顺序与公式。`, `Source p.${page.pageLabel} contains figure text or complex layout. Check reading order and equations against the PDF.`) } : {}) }
  })
  // 页面只用于定位/存储，不能成为语义边界。缺页、标题、图表和含糊坐标不跨越。
  let previous: PdfParagraph | undefined
  let previousPage = -2
  for (const page of pages) {
    let firstIndex = 0
    // 页首浮动图可能先出现图内标签、图注，再接上页正文。仅有明确图注与短行几何证据时跳过该前缀。
    const captionIndex = page.paragraphs.findIndex(paragraph => caption.test(paragraph.text))
    const pageWidth = Math.max(0, ...page.lines.filter(line => height(line) >= bodyFont * .95).flatMap(line => line.rects.map(rect => rect[2] - rect[0])))
    if (captionIndex >= 0 && page.paragraphs.slice(0, captionIndex).every(paragraph => !paragraph.heading
      && paragraph.rects.every(rect => rect[2] - rect[0] < pageWidth * .85))) firstIndex = captionIndex + 1
    const first = page.paragraphs[firstIndex]
    const lastLocation = previous?.locations?.at(-1), a = lastLocation?.rects.at(-1), b = first?.rects[0]
    const previousPageData = pages.find(value => value.pageIndex === previousPage)
    const previousBox = previousPageData?.viewBox, box = page.viewBox
    // 句号也可能落在跨页自然段内部：只有满行、页底/页首与无新段缩进共同支持时才续接。
    const columnLines = a ? previousPageData?.lines.filter(line => line.rects[0] && Math.abs(line.rects[0][0] - a[0]) < height(line) * 2) ?? [] : []
    const columnWidth = Math.max(0, ...columnLines.map(line => line.rects[0][2] - line.rects[0][0]))
    const nextLeft = b ? Math.min(...page.lines.filter(line => line.rects[0] && Math.abs(line.rects[0][0] - b[0]) < height(line) * 2).map(line => line.rects[0][0])) : 0
    const fullLineContinuation = Boolean(a && b && previousBox && box && columnWidth
      && a[1] <= previousBox[1] + (previousBox[3] - previousBox[1]) * .22
      && b[3] >= box[3] - (box[3] - box[1]) * .25
      && a[2] - a[0] >= columnWidth * .9 && b[0] - nextLeft < (b[3] - b[1]) * .4)
    if (previous && first && previousPage === page.pageIndex - 1 && !page.warning && a && b
      && (first.text.length >= 45 || terminal.test(first.text))
      && previous.text.length >= 45 && ((!terminal.test(previous.text) && /^[\p{Ll}]/u.test(first.text)) || fullLineContinuation)
      && !first.heading && !previous.heading && !heading.test(first.text) && !caption.test(first.text) && !caption.test(previous.text)
      && Math.abs(height(previous) - height(first)) <= height(first) * .07
      && !footnote(first, page)) {
      previous.text = joinLines([previous, first]); previous.lineIDs.push(...first.lineIDs)
      previous.locations!.push(...first.locations!)
      page.continuationFrom.push(previous.pageIndex)
      page.paragraphs.splice(firstIndex, 1)
    }
    previous = page.paragraphs.filter(paragraph => !footnote(paragraph, page)).at(-1) ?? (page.continuationFrom.length ? previous : undefined)
    previousPage = page.pageIndex
  }
  return { ...document, pages }
}
