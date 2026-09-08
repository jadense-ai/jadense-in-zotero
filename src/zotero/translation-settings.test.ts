/** 文章偏好以稳定本地身份隔离，同篇附件共用；不可用的可选存储局部降级。 */
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_TRANSLATION_LANGUAGES } from "@/chat/translation-languages"
import { ARTICLE_TRANSLATION_LANGUAGES_PREF_PREFIX, readArticleTranslationLanguages, writeArticleTranslationLanguages } from "./translation-settings"

function fixture() {
  const values = new Map<string, unknown>()
  const items = new Map<number, Record<string, unknown>>([
    [3, { id: 3, libraryID: 2, key: "PAPER003", itemType: "journalArticle" }],
    [17, { id: 17, libraryID: 2, key: "PDFKEY17", parentID: 3, itemType: "attachment" }],
    [18, { id: 18, libraryID: 2, key: "PDFKEY18", parentID: 3, itemType: "attachment" }],
    [21, { id: 21, libraryID: 4, key: "PAPER003", itemType: "journalArticle" }],
    [22, { id: 22, libraryID: 4, key: "PDFKEY22", parentID: 21, itemType: "attachment" }],
    [30, { id: 30, libraryID: 2, key: "ORPHAN30", itemType: "attachment" }],
  ])
  return {
    values, items,
    zotero: {
      Items: { get: vi.fn((itemID: number) => items.get(itemID)) },
      Prefs: {
        get: vi.fn((key: string) => values.get(key)),
        set: vi.fn((key: string, value: string) => { values.set(key, value) }),
      },
    },
  }
}

describe("article translation preferences", () => {
  it("shares a parent paper's languages across attachments and profile reload, isolating libraries and orphan PDFs", async () => {
    const { zotero, values } = fixture()
    const languages = { sourceLanguage: "de", targetLanguage: "ja" }
    expect(await writeArticleTranslationLanguages(zotero, 17, languages)).toBe(true)
    const key = `${ARTICLE_TRANSLATION_LANGUAGES_PREF_PREFIX}2.PAPER003`
    expect(zotero.Prefs.set).toHaveBeenCalledWith(key, JSON.stringify(languages), true)
    const reopened = { Items: zotero.Items, Prefs: { get: (pref: string) => values.get(pref) } }
    expect(await readArticleTranslationLanguages(reopened, 18)).toEqual(languages)
    expect(await readArticleTranslationLanguages(zotero, 22)).toEqual(DEFAULT_TRANSLATION_LANGUAGES)
    expect(await readArticleTranslationLanguages(zotero, 30)).toEqual(DEFAULT_TRANSLATION_LANGUAGES)
    expect(await writeArticleTranslationLanguages(zotero, 30, { sourceLanguage: "auto", targetLanguage: "fr" })).toBe(true)
    expect(await readArticleTranslationLanguages(zotero, 30)).toEqual({ sourceLanguage: "auto", targetLanguage: "fr" })
    expect(await readArticleTranslationLanguages(zotero, 17)).toEqual(languages)
  })

  it("uses only verified same-library parents and never persists under a reused bare item ID", async () => {
    const { zotero, items, values } = fixture()
    const languages = { sourceLanguage: "fr", targetLanguage: "en" }
    items.get(17)!.parentID = 21
    expect(await writeArticleTranslationLanguages(zotero, 17, languages)).toBe(true)
    expect(values.has(`${ARTICLE_TRANSLATION_LANGUAGES_PREF_PREFIX}2.PDFKEY17`)).toBe(true)
    expect(await readArticleTranslationLanguages(zotero, 22)).toEqual(DEFAULT_TRANSLATION_LANGUAGES)
    items.set(17, { id: 17, libraryID: 2, key: "REUSED17", itemType: "attachment" })
    expect(await readArticleTranslationLanguages(zotero, 17)).toEqual(DEFAULT_TRANSLATION_LANGUAGES)
    items.set(17, { id: 18, libraryID: 2, key: "MISMATCH", itemType: "attachment" })
    expect(await writeArticleTranslationLanguages(zotero, 17, languages)).toBe(false)
  })

  it("projects additive fields and defaults malformed optional preferences", async () => {
    const { zotero, values } = fixture()
    const key = `${ARTICLE_TRANSLATION_LANGUAGES_PREF_PREFIX}2.PAPER003`
    values.set(key, JSON.stringify({ sourceLanguage: "auto", targetLanguage: "JA", itemID: 22, future: true }))
    expect(await readArticleTranslationLanguages(zotero, 17)).toEqual({ sourceLanguage: "auto", targetLanguage: "ja" })
    values.set(key, JSON.stringify({ sourceLanguage: null, targetLanguage: "fr", future: true }))
    expect(await readArticleTranslationLanguages(zotero, 17)).toEqual({ sourceLanguage: "en", targetLanguage: "fr" })
    values.set(key, '{"sourceLanguage":')
    expect(await readArticleTranslationLanguages(zotero, 17)).toEqual(DEFAULT_TRANSLATION_LANGUAGES)
  })

  it("contains missing, throwing or read-only preference and item stores", async () => {
    const { zotero } = fixture()
    const unavailable = () => { throw new Error("Unavailable") }
    for (const host of [{}, { Items: { get: unavailable } }, { Items: zotero.Items }, {
      Items: zotero.Items, Prefs: { get: unavailable, set: unavailable },
    }]) {
      expect(await readArticleTranslationLanguages(host, 17)).toEqual(DEFAULT_TRANSLATION_LANGUAGES)
      expect(await writeArticleTranslationLanguages(host, 17, DEFAULT_TRANSLATION_LANGUAGES)).toBe(false)
    }
  })
})
