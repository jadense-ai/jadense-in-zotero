import { describe, expect, it } from "vitest"

import {
  TRANSLATION_HISTORY_PREF_KEY,
  appendTranslationRecord,
  readTranslationHistory,
  type TranslationPreferenceStore,
} from "./translation-history"

function preferences(initial?: string) {
  const values = new Map<string, unknown>()
  if (initial !== undefined) values.set(TRANSLATION_HISTORY_PREF_KEY, initial)
  const store: TranslationPreferenceStore = {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
  }
  return { store, values }
}

describe("local translation history", () => {
  it("stores the selected source and translated result separately from chat", () => {
    const fixture = preferences()
    appendTranslationRecord(fixture.store, {
      id: "translation-1",
      createdAt: "2026-09-02T08:00:00.000Z",
      source: {
        text: "A selected sentence.", itemID: 17, libraryID: 2, itemKey: "PDFKEY17",
        title: "Paper", pageIndex: 2, pageLabel: "3",
      },
      result: { text: "一个被选中的句子。", sourceLanguage: "自动识别", targetLanguage: "简体中文" },
    })

    expect(readTranslationHistory(fixture.store).records[0]).toMatchObject({
      source: { text: "A selected sentence.", itemID: 17, libraryID: 2, itemKey: "PDFKEY17", title: "Paper" },
      result: { text: "一个被选中的句子。", targetLanguage: "简体中文" },
    })
    expect(fixture.values.has("extensions.jadenseInZotero.localChatState")).toBe(false)
  })

  it("keeps legacy item-only records but discards incomplete new attachment identities", () => {
    const fixture = preferences(JSON.stringify({
      version: 1,
      records: [
        {
          id: "legacy", createdAt: "2026-09-02T08:00:00.000Z",
          source: { text: "legacy source", itemID: 9 },
          result: { text: "legacy result", sourceLanguage: "auto", targetLanguage: "zh-CN" },
        },
        {
          id: "partial", createdAt: "2026-09-02T08:00:00.000Z",
          source: { text: "new source", itemID: 10, libraryID: 2 },
          result: { text: "new result", sourceLanguage: "auto", targetLanguage: "zh-CN" },
        },
        {
          id: "bad-key", createdAt: "2026-09-02T08:00:00.000Z",
          source: { text: "new source", itemID: 11, libraryID: 2, itemKey: " " },
          result: { text: "new result", sourceLanguage: "auto", targetLanguage: "zh-CN" },
        },
        {
          id: "long-key", createdAt: "2026-09-02T08:00:00.000Z",
          source: { text: "new source", itemID: 12, libraryID: 2, itemKey: "K".repeat(81) },
          result: { text: "new result", sourceLanguage: "auto", targetLanguage: "zh-CN" },
        },
      ],
    }))

    expect(readTranslationHistory(fixture.store).records).toEqual([expect.objectContaining({ id: "legacy" })])
  })

  it("rejects item-only records at the append boundary while retaining legacy read compatibility", () => {
    const fixture = preferences()
    expect(() => appendTranslationRecord(fixture.store, {
      id: "new-without-identity", createdAt: "2026-09-02T08:00:00.000Z",
      source: { text: "source", itemID: 9 },
      result: { text: "result", sourceLanguage: "auto", targetLanguage: "zh-CN" },
    })).toThrow(/附件身份/)
    expect(fixture.values.has(TRANSLATION_HISTORY_PREF_KEY)).toBe(false)
  })

  it("keeps valid additive records while discarding corrupt siblings and unknown fields", () => {
    const fixture = preferences(JSON.stringify({
      version: 1,
      future: true,
      records: [
        {
          id: "valid", createdAt: "2026-09-02T08:00:00.000Z", future: "discarded",
          source: { text: "source", itemID: 9, extra: true },
          result: { text: "result", sourceLanguage: "auto", targetLanguage: "zh-CN", extra: true },
        },
        { id: "missing-result", createdAt: "2026-09-02T08:00:00.000Z", source: { text: "source", itemID: 9 } },
      ],
    }))

    expect(readTranslationHistory(fixture.store)).toEqual({
      version: 1,
      records: [{
        id: "valid",
        createdAt: "2026-09-02T08:00:00.000Z",
        source: { text: "source", itemID: 9 },
        result: { text: "result", sourceLanguage: "auto", targetLanguage: "zh-CN" },
      }],
    })
  })

  it("bounds profile preference storage by dropping the oldest records", () => {
    const fixture = preferences()
    for (let index = 0; index < 240; index += 1) {
      appendTranslationRecord(fixture.store, {
        id: `translation-${index}`,
        createdAt: new Date(2026, 8, 2, 8, index).toISOString(),
        source: { text: `source ${index}`, itemID: index + 1, libraryID: 1, itemKey: `PDF${index}` },
        result: { text: `result ${index}`, sourceLanguage: "auto", targetLanguage: "zh-CN" },
      })
    }

    const serialized = String(fixture.values.get(TRANSLATION_HISTORY_PREF_KEY))
    expect(serialized.length).toBeLessThanOrEqual(1_000_000)
    expect(readTranslationHistory(fixture.store).records).toHaveLength(200)
    expect(readTranslationHistory(fixture.store).records[0].id).toBe("translation-239")
  })
})
