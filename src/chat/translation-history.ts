/**
 * Zotero profile 本地翻译档案。
 * 上游接收阅读器选文与 AI 译文，下游仅写独立首选项，不混入本地对话历史。
 */

export const TRANSLATION_HISTORY_PREF_KEY = "extensions.jadenseInZotero.translationHistory"

export type TranslationPreferenceStore = {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

export type TranslationSource = {
  text: string
  itemID: number
  libraryID?: number
  itemKey?: string
  title?: string
  citation?: string
  pageIndex?: number
  pageLabel?: string
}

export type TranslationResult = {
  text: string
  sourceLanguage: string
  targetLanguage: string
}

export type TranslationRecord = {
  id: string
  createdAt: string
  source: TranslationSource
  result: TranslationResult
}

export type TranslationHistory = {
  version: 1
  records: TranslationRecord[]
}

const MAX_RECORDS = 200
const MAX_SERIALIZED_LENGTH = 1_000_000
const MAX_SOURCE_LENGTH = 20_000
const MAX_RESULT_LENGTH = 40_000

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return ""
  return value.trim().slice(0, maxLength)
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  return text(value, maxLength) || undefined
}

function identityText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return ""
  const normalized = value.trim()
  return normalized.length <= maxLength ? normalized : ""
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function normalizeRecord(value: unknown): TranslationRecord | null {
  const row = object(value)
  const source = object(row?.source)
  const result = object(row?.result)
  const id = text(row?.id, 120)
  const createdAt = text(row?.createdAt, 64)
  const sourceText = text(source?.text, MAX_SOURCE_LENGTH)
  const resultText = text(result?.text, MAX_RESULT_LENGTH)
  const itemID = nonNegativeInteger(source?.itemID)
  if (!id || !createdAt || !sourceText || !resultText || itemID === undefined) return null

  const hasLibraryID = source && Object.prototype.hasOwnProperty.call(source, "libraryID")
  const hasItemKey = source && Object.prototype.hasOwnProperty.call(source, "itemKey")
  const libraryID = nonNegativeInteger(source?.libraryID)
  const itemKey = identityText(source?.itemKey, 80) || undefined
  // 旧记录完全没有稳定身份时保留；新格式若身份残缺则不能降级成仅 itemID 导航。
  if ((hasLibraryID || hasItemKey) && (libraryID === undefined || !itemKey)) return null
  const pageIndex = nonNegativeInteger(source?.pageIndex)
  return {
    id,
    createdAt,
    source: {
      text: sourceText,
      itemID,
      ...(libraryID !== undefined && itemKey ? { libraryID, itemKey } : {}),
      ...(optionalText(source?.title, 500) ? { title: optionalText(source?.title, 500) } : {}),
      ...(optionalText(source?.citation, 1_000) ? { citation: optionalText(source?.citation, 1_000) } : {}),
      ...(pageIndex !== undefined ? { pageIndex } : {}),
      ...(optionalText(source?.pageLabel, 80) ? { pageLabel: optionalText(source?.pageLabel, 80) } : {}),
    },
    result: {
      text: resultText,
      sourceLanguage: text(result?.sourceLanguage, 80) || "自动识别",
      targetLanguage: text(result?.targetLanguage, 80) || "简体中文",
    },
  }
}

function emptyHistory(): TranslationHistory {
  return { version: 1, records: [] }
}

function fitHistory(history: TranslationHistory): TranslationHistory {
  const records = history.records.slice(0, MAX_RECORDS)
  while (records.length && JSON.stringify({ version: 1, records }).length > MAX_SERIALIZED_LENGTH) {
    records.pop()
  }
  return { version: 1, records }
}

export function readTranslationHistory(preferences: TranslationPreferenceStore): TranslationHistory {
  const raw = preferences.get(TRANSLATION_HISTORY_PREF_KEY)
  if (typeof raw !== "string" || !raw.trim()) return emptyHistory()
  try {
    const value = object(JSON.parse(raw))
    return fitHistory({
      version: 1,
      records: (Array.isArray(value?.records) ? value.records : [])
        .map(normalizeRecord)
        .filter((record): record is TranslationRecord => Boolean(record)),
    })
  } catch {
    return emptyHistory()
  }
}

export function appendTranslationRecord(
  preferences: TranslationPreferenceStore,
  input: TranslationRecord,
): TranslationRecord {
  const record = normalizeRecord(input)
  if (!record) throw new Error("翻译记录缺少原文或译文。")
  if (record.source.libraryID === undefined || !record.source.itemKey || record.source.itemID <= 0) {
    throw new Error("新翻译记录缺少可复核的 Zotero 附件身份。")
  }
  const history = readTranslationHistory(preferences)
  const next = fitHistory({
    version: 1,
    records: [record, ...history.records.filter((item) => item.id !== record.id)],
  })
  preferences.set(TRANSLATION_HISTORY_PREF_KEY, JSON.stringify(next))
  return record
}
