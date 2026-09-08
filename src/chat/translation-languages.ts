/** 阅读器翻译语言的共同词表；工具条、句级浮窗和请求运行时只保存语言代码。 */
export type TranslationLanguages = {
  sourceLanguage: string
  targetLanguage: string
}

export const DEFAULT_TRANSLATION_LANGUAGES: TranslationLanguages = {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
}

export const TRANSLATION_LANGUAGES = [
  { value: "en", label: "英文" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁体中文" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "fr", label: "法语" },
  { value: "de", label: "德语" },
  { value: "es", label: "西班牙语" },
  { value: "pt", label: "葡萄牙语" },
  { value: "it", label: "意大利语" },
  { value: "ru", label: "俄语" },
  { value: "ar", label: "阿拉伯语" },
  { value: "hi", label: "印地语" },
  { value: "tr", label: "土耳其语" },
  { value: "vi", label: "越南语" },
  { value: "th", label: "泰语" },
  { value: "id", label: "印度尼西亚语" },
  { value: "ms", label: "马来语" },
  { value: "nl", label: "荷兰语" },
  { value: "pl", label: "波兰语" },
  { value: "uk", label: "乌克兰语" },
  { value: "sv", label: "瑞典语" },
  { value: "da", label: "丹麦语" },
  { value: "fi", label: "芬兰语" },
  { value: "no", label: "挪威语" },
  { value: "cs", label: "捷克语" },
  { value: "el", label: "希腊语" },
  { value: "he", label: "希伯来语" },
  { value: "fa", label: "波斯语" },
  { value: "bn", label: "孟加拉语" },
  { value: "ta", label: "泰米尔语" },
  { value: "ur", label: "乌尔都语" },
] as const

function languageCode(value: unknown, allowAuto: boolean): string | undefined {
  if (typeof value !== "string") return undefined
  const code = value.trim().replaceAll("_", "-").toLowerCase()
  if (allowAuto && code === "auto") return "auto"
  const canonical = code === "zh" || code === "zh-hans" ? "zh-cn" : code === "zh-hant" ? "zh-tw" : code
  return TRANSLATION_LANGUAGES.find(({ value }) => value.toLowerCase() === canonical)?.value
}

/** 可选偏好逐字段降级；未知附加字段不会阻断翻译，目标语言不使用自动识别。 */
export function normalizeTranslationLanguages(
  value: unknown,
  fallback: TranslationLanguages = DEFAULT_TRANSLATION_LANGUAGES,
): TranslationLanguages {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  return {
    sourceLanguage: languageCode(row.sourceLanguage, true)
      ?? languageCode(fallback.sourceLanguage, true) ?? DEFAULT_TRANSLATION_LANGUAGES.sourceLanguage,
    targetLanguage: languageCode(row.targetLanguage, false)
      ?? languageCode(fallback.targetLanguage, false) ?? DEFAULT_TRANSLATION_LANGUAGES.targetLanguage,
  }
}

/** 请求与历史使用人类可读标签；旧调用方直接传入的语言名称仍可显示。 */
export function translationLanguageLabel(code: string): string {
  const value = languageCode(code, true)
  return value === "auto" ? "自动识别" : TRANSLATION_LANGUAGES.find((language) => language.value === value)?.label ?? code.trim()
}
