/** 语言配置读取兼容附加字段及可选值漂移，默认始终为英文到简体中文。 */
import { describe, expect, it } from "vitest"
import { DEFAULT_TRANSLATION_LANGUAGES, TRANSLATION_LANGUAGES, normalizeTranslationLanguages, translationLanguageLabel } from "./translation-languages"

describe("translation languages", () => {
  it("defaults malformed preferences and normalizes supported codes without accepting auto as a target", () => {
    for (const value of [undefined, null, "bad", [], { sourceLanguage: 3, targetLanguage: "future" }]) {
      expect(normalizeTranslationLanguages(value)).toEqual(DEFAULT_TRANSLATION_LANGUAGES)
    }
    expect(normalizeTranslationLanguages({ sourceLanguage: " AUTO ", targetLanguage: "zh_hant", extra: true }))
      .toEqual({ sourceLanguage: "auto", targetLanguage: "zh-TW" })
    expect(normalizeTranslationLanguages({ targetLanguage: "auto" }, { sourceLanguage: "ja", targetLanguage: "fr" }))
      .toEqual({ sourceLanguage: "ja", targetLanguage: "fr" })
    expect(normalizeTranslationLanguages({ sourceLanguage: "ZH", targetLanguage: "EN" }))
      .toEqual({ sourceLanguage: "zh-CN", targetLanguage: "en" })
  })

  it("offers each concrete language as both source and target and keeps readable history labels", () => {
    for (const { value, label } of TRANSLATION_LANGUAGES) {
      expect(normalizeTranslationLanguages({ sourceLanguage: value, targetLanguage: value }))
        .toEqual({ sourceLanguage: value, targetLanguage: value })
      expect(translationLanguageLabel(value)).toBe(label)
    }
    expect(translationLanguageLabel("auto")).toBe("自动识别")
    expect(translationLanguageLabel("English")).toBe("English")
  })
})
