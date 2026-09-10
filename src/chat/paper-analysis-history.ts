import { uiText } from "@/zotero/ui-preferences"
/**
 * Zotero profile 中独立的文献解析历史。
 * 保存附件身份、元数据、总结与可读笔记备份；不读取或迁移本地对话记录，笔记不作为原生写入输入。
 */

export const PAPER_ANALYSIS_HISTORY_PREF_KEY = "extensions.jadenseInZotero.paperAnalysisHistory"

export type PaperAnalysisHistoryPreferenceStore = {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export type PaperAnalysisSource = {
  itemID: number
  libraryID: number
  itemKey: string
  title: string
  authors: string[]
  date?: string
  year?: string
  publicationTitle?: string
  doi?: string
}

export type PaperAnalysisRecord = {
  id: string
  createdAt: string
  source: PaperAnalysisSource
  summary: string
  notes?: string
  warnings?: string[]
  referenceTaskID?: string
}

export type PaperAnalysisHistory = {
  version: 1
  records: PaperAnalysisRecord[]
}

const MAX_RECORDS = 200
const MAX_SERIALIZED_LENGTH = 1_000_000
const MAX_AUTHORS = 32
const MAX_AUTHOR_LENGTH = 200
const MAX_SUMMARY_LENGTH = 1_600
export const MAX_ANALYSIS_NOTES_LENGTH = 96_000

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  return text(value, maxLength) || undefined
}

function identityText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return ""
  const normalized = value.trim()
  return normalized.length <= maxLength ? normalized : ""
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function normalizeAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((author) => text(author, MAX_AUTHOR_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_AUTHORS)
}

function normalizeRecord(value: unknown): PaperAnalysisRecord | null {
  const row = object(value)
  const source = object(row?.source)
  const id = identityText(row?.id, 120)
  const createdAt = identityText(row?.createdAt, 64)
  const itemID = positiveInteger(source?.itemID)
  const libraryID = nonNegativeInteger(source?.libraryID)
  const itemKey = identityText(source?.itemKey, 80)
  const title = text(source?.title, 500)
  const summary = text(row?.summary, MAX_SUMMARY_LENGTH)
  const notes = text(row?.notes, MAX_ANALYSIS_NOTES_LENGTH)
  const warnings = Array.isArray(row?.warnings)
    ? [...new Set(row.warnings.map((entry) => text(entry, 800)).filter(Boolean))].slice(0, 24)
    : []
  if (!id || !createdAt || !Number.isFinite(Date.parse(createdAt))
    || itemID === undefined || libraryID === undefined || !itemKey || !title || !summary) return null

  return {
    id,
    createdAt,
    source: {
      itemID,
      libraryID,
      itemKey,
      title,
      authors: normalizeAuthors(source?.authors),
      ...(optionalText(source?.date, 80) ? { date: optionalText(source?.date, 80) } : {}),
      ...(optionalText(source?.year, 20) ? { year: optionalText(source?.year, 20) } : {}),
      ...(optionalText(source?.publicationTitle, 500)
        ? { publicationTitle: optionalText(source?.publicationTitle, 500) }
        : {}),
      ...(optionalText(source?.doi, 500) ? { doi: optionalText(source?.doi, 500) } : {}),
    },
    summary,
    ...(typeof row?.referenceTaskID === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(row.referenceTaskID)
      ? { referenceTaskID: row.referenceTaskID } : {}),
    ...(notes ? { notes: typeof row?.notes === "string" && row.notes.trim().length > MAX_ANALYSIS_NOTES_LENGTH
      ? `${notes.slice(0, -20)}\n…（笔记过长，后续已截断）` : notes } : {}),
    ...(warnings.length ? { warnings } : {}),
  }
}

function emptyHistory(): PaperAnalysisHistory {
  return { version: 1, records: [] }
}

function fitHistory(records: PaperAnalysisRecord[]): PaperAnalysisHistory {
  const ids = new Set<string>()
  const fitted = [...records]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .filter((record) => {
      if (ids.has(record.id)) return false
      ids.add(record.id)
      return true
    })
    .slice(0, MAX_RECORDS)
  while (fitted.length && JSON.stringify({ version: 1, records: fitted }).length > MAX_SERIALIZED_LENGTH) {
    fitted.pop()
  }
  return { version: 1, records: fitted }
}

export function readPaperAnalysisHistory(preferences: PaperAnalysisHistoryPreferenceStore): PaperAnalysisHistory {
  try {
    const raw = preferences.get(PAPER_ANALYSIS_HISTORY_PREF_KEY)
    if (typeof raw !== "string" || !raw.trim()) return emptyHistory()
    const value = object(JSON.parse(raw))
    if (value?.version !== 1) return emptyHistory()
    return fitHistory((Array.isArray(value?.records) ? value.records : [])
      .map(normalizeRecord)
      .filter((record): record is PaperAnalysisRecord => Boolean(record)))
  } catch {
    return emptyHistory()
  }
}

export function appendPaperAnalysisRecord(
  preferences: PaperAnalysisHistoryPreferenceStore,
  input: PaperAnalysisRecord,
): PaperAnalysisRecord {
  const record = normalizeRecord(input)
  if (!record) throw new Error(uiText("解析记录缺少有效的附件身份、标题或总结。", "The analysis record is missing a valid attachment identity, title, or summary."))
  const next = fitHistory([record, ...readPaperAnalysisHistory(preferences).records])
  preferences.set(PAPER_ANALYSIS_HISTORY_PREF_KEY, JSON.stringify(next))
  return record
}
