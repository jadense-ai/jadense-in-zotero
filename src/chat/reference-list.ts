/** 引用识别与确定性匹配：原文范围是事实，结构化字段及 AI 建议只是可丢弃的补充。 */
import type { PdfLine, PdfTextDocument } from "@/zotero/pdf-document"

export type ReferenceMetadata = { title: string; authors: string[]; year: string; doi?: string; url?: string; publicationTitle?: string; itemType?: string }
export type ReferenceEntry = {
  id: string; order: number; label?: string; raw: string; lines: PdfLine[]; fields: ReferenceMetadata
  uncertain: boolean; verification: "pending" | "unverified" | "verified"; reason?: string; verified?: ReferenceMetadata
  imported?: { libraryID: number; itemKey: string; itemID: number }; importUncertain?: boolean
}

const heading = /^\s*(?:\d+[.\s]*)?(?:references|bibliography|literature cited|works cited|参考文献|參考文獻|引用文献)\s*[:：]?\s*$/iu
const endHeading = /^(?:appendix(?:\s+[a-z\d]+)?|appendices|supplementary (?:material|information)|acknowledg(?:e)?ments|附录|附錄|致谢)\s*[:：]?$/iu
const numbered = /^\s*(?:\[(\d{1,4})\]|(\d{1,4})[.)、])\s*/u
const authorYear = /^[\p{L}][\p{L}'’\- ]{1,45},?\s+(?:[A-Z][., ]+|[\p{L}]+[, &]).*?(?:\(?\b(?:19|20)\d{2}[a-z]?\)?)/u

export function normalizeDoi(value: string) {
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi\s*:\s*/i, "").replace(/[.,;]+$/u, "").toLowerCase()
}

/** 断行只在 DOI token 内连接；保留原始 raw，归一化文本不能替代来源。 */
export function parseReferenceFields(raw: string): ReferenceMetadata {
  const joined = raw.replace(/(10\.\d{4,9}\/\S*)\s*\n\s*([\w./();:-]+)/gu, "$1$2").replace(/\s+/gu, " ").replace(numbered, "").trim()
  const doi = joined.match(/\b10\.\d{4,9}\/[^\s<>"]+/iu)?.[0]
  const yearMatch = joined.match(/\b((?:18|19|20)\d{2})[a-z]?\b/u)
  const year = yearMatch?.[1] ?? ""
  let title = "", authorText = "", publicationTitle = ""
  const parenthesizedYear = joined.match(/^(.*?)\(\s*(?:18|19|20)\d{2}[a-z]?\s*\)\s*[.,]?\s*(.+)$/u)
  if (parenthesizedYear) {
    authorText = parenthesizedYear[1]
    const pieces = parenthesizedYear[2].split(/\.\s+(?=[\p{Lu}\p{Lo}])/u)
    title = pieces[0]; publicationTitle = pieces[1] ?? ""
  } else {
    // 作者缩写后的句点不作为题名分界：只使用后面紧随完整单词的句点。
    const split = joined.match(/^(.*?[\p{L}][.]?)\.\s+([\p{Lu}\p{Lo}][\p{L}\d-]{2,}.*?)\.(?:\s+|$)(.*)$/u)
    if (split) { authorText = split[1]; title = split[2]; publicationTitle = split[3].split(/[.;]/u)[0] }
  }
  const authors = authorText.split(/\s*(?:;|\band\b|&|(?<=\.)\s*,\s*(?=[\p{L}][\p{L}'’-]+,))\s*/u).map(value => value.trim().replace(/[.,]+$/u, "")).filter(Boolean)
  const url = joined.match(/https?:\/\/[^\s<>"]+/iu)?.[0]?.replace(/[.,;]+$/u, "")
  return { title: title.replace(/[.,]+$/u, "").trim(), authors, year, ...(doi ? { doi: normalizeDoi(doi) } : {}), ...(url ? { url } : {}), ...(publicationTitle ? { publicationTitle } : {}) }
}

function entry(lines: PdfLine[], order: number, knownBoundary: boolean): ReferenceEntry {
  const raw = lines.map(line => line.text).join("\n")
  const match = raw.match(numbered)
  const fields = parseReferenceFields(raw)
  return { id: `ref-${lines[0].id}`, order, ...(match ? { label: match[1] || match[2] } : {}), raw, lines, fields,
    uncertain: !knownBoundary || !fields.title || !fields.authors.length || !fields.year, verification: "pending" }
}

/** 一处源范围只读取一次，不按题名或 DOI 去重；不认识的尾部片段也保留。 */
export function extractReferences(document: PdfTextDocument): ReferenceEntry[] {
  const seen = new Set<string>()
  const lines = document.pages.flatMap(page => page.lines).filter(line => {
    if (seen.has(line.id)) return false
    seen.add(line.id); return true
  })
  let first = lines.findIndex(line => heading.test(line.text))
  if (first >= 0) first++
  else {
    const numberedStarts = lines.map((line, i) => numbered.test(line.text) ? i : -1).filter(i => i >= 0)
    const authorStarts = lines.map((line, i) => authorYear.test(line.text) ? i : -1).filter(i => i >= 0)
    first = numberedStarts.length >= 3 ? numberedStarts[0] : authorStarts.length >= 2 ? authorStarts[0] : -1
  }
  if (first < 0) return []
  const result: ReferenceEntry[] = []
  let group: PdfLine[] = [], boundaryKnown = false
  const flush = () => { if (group.length) result.push(entry(group, result.length, boundaryKnown)); group = [] }
  let previousNumber: number | undefined
  for (const line of lines.slice(first)) {
    if (endHeading.test(line.text.trim())) break
    if (heading.test(line.text) || (line.text.trim() === line.pageLabel && line.rects[0]?.[3] < 35)) continue
    const number = line.text.match(numbered)
    const n = number ? Number(number[1] || number[2]) : undefined
    const starts = Boolean(number || authorYear.test(line.text))
    // 悬挂缩进：上一段结束，下一行回到条目左缘，且有作者/年份证据。
    const hanging = !number && group.at(-1)?.paragraphEnd && /\b(?:18|19|20)\d{2}\b/u.test(line.text)
      && Boolean(line.rects[0] && group[0]?.rects[0] && line.rects[0][0] <= group[0].rects[0][0] + 3)
    if ((starts || hanging) && group.length) flush()
    if (!group.length) {
      boundaryKnown = starts || Boolean(hanging)
      if (n !== undefined && previousNumber !== undefined && n !== previousNumber + 1) boundaryKnown = false
      if (n !== undefined) previousNumber = n
    }
    group.push(line)
  }
  flush()
  return result
}

export function normalizedTitle(value: string) { return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") }
function surname(value: string) { return normalizedTitle(value.trim().split(/[,\s]/u)[0] || "") }
function firstInitial(value: string) { return normalizedTitle(value.split(",").slice(1).join(",")).slice(0, 1) }

/** DOI 存在不代表原始引用匹配；缺少匹配证据时保持静态未验证条目。 */
export function metadataMatches(fields: ReferenceMetadata, candidate: ReferenceMetadata): boolean {
  return Boolean(fields.title && fields.year && fields.authors.length && candidate.title && candidate.authors.length
    && normalizedTitle(fields.title) === normalizedTitle(candidate.title) && fields.year === candidate.year
    && fields.authors.every((author, index) => {
      const other = candidate.authors[index] || ""
      const initial = firstInitial(author), otherInitial = firstInitial(other)
      return surname(author) === surname(other) && (!initial || !otherInitial || initial === otherInitial)
    }))
}

/** AI 只能返回当前原文的连续行分组；覆盖不完整/重叠/越界则保留整个原条目。 */
export function applyReferenceSuggestion(original: ReferenceEntry, value: unknown): ReferenceEntry[] {
  const groups = (value as { references?: unknown[] } | null)?.references
  if (!Array.isArray(groups) || !groups.length) return [original]
  let offset = 0
  const result: ReferenceEntry[] = []
  for (const group of groups) {
    if (!group || typeof group !== "object") return [original]
    const row = group as Record<string, unknown>
    const start = row.startLine, end = row.endLine
    if (start !== offset || !Number.isInteger(end) || Number(end) < offset || Number(end) >= original.lines.length) return [original]
    const next = entry(original.lines.slice(offset, Number(end) + 1), original.order + result.length, true)
    const rawNormalized = next.raw.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase()
    const supported = (v: unknown) => typeof v === "string" && rawNormalized.includes(v.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase()) ? v : ""
    next.fields.title ||= supported(row.title)
    next.fields.year ||= supported(row.year)
    if (!next.fields.authors.length && Array.isArray(row.authors)) next.fields.authors = row.authors.map(supported).filter(Boolean)
    next.uncertain = !next.fields.title || !next.fields.authors.length || !next.fields.year
    result.push(next); offset = Number(end) + 1
  }
  return offset === original.lines.length ? result : [original]
}
