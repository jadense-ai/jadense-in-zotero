/** 文章翻译偏好只写当前 Zotero profile；通过本地条目身份归属到父文献，同篇 PDF 共用偏好。 */
import { normalizeTranslationLanguages, type TranslationLanguages } from "@/chat/translation-languages"

export const ARTICLE_TRANSLATION_LANGUAGES_PREF_PREFIX = "extensions.jadenseInZotero.articleTranslationLanguages."

type TranslationSettingsHost = {
  Items?: { get?: (itemID: number) => unknown | Promise<unknown> }
  Prefs?: {
    get: (key: string, global?: boolean) => unknown
    set?: (key: string, value: string, global?: boolean) => void
  }
}

type LocalItem = {
  id: number
  libraryID: number
  key: string
  parentID?: number
  deleted?: boolean
  itemType?: string
  isAttachment?: () => boolean
  isNote?: () => boolean
  isAnnotation?: () => boolean
}

/** 不使用显示标题或裸 itemID 作为持久键，避免同名文章或资料库间的偏好串用。 */
async function localItem(zotero: TranslationSettingsHost, itemID: number): Promise<LocalItem | null> {
  if (!Number.isSafeInteger(itemID) || itemID <= 0) return null
  try {
    const item = await zotero.Items?.get?.(itemID) as LocalItem | undefined
    return item?.id === itemID && item.deleted !== true
      && Number.isSafeInteger(item.libraryID) && item.libraryID >= 0
      && typeof item.key === "string" && Boolean(item.key.trim())
      && item.itemType !== "note" && item.itemType !== "annotation" && !item.isNote?.() && !item.isAnnotation?.()
      ? item : null
  } catch {
    return null
  }
}

async function articlePreferenceKey(zotero: TranslationSettingsHost, itemID: number): Promise<string | null> {
  const item = await localItem(zotero, itemID)
  if (!item) return null
  const parent = item.parentID ? await localItem(zotero, item.parentID) : null
  const article = parent && parent.libraryID === item.libraryID
    && parent.itemType !== "attachment" && !parent.isAttachment?.() ? parent : item
  return `${ARTICLE_TRANSLATION_LANGUAGES_PREF_PREFIX}${article.libraryID}.${encodeURIComponent(article.key)}`
}

/** 偏好读取不可用或格式漂移只恢复默认语言，不成为翻译请求的准入条件。 */
export async function readArticleTranslationLanguages(zotero: TranslationSettingsHost, itemID: number): Promise<TranslationLanguages> {
  try {
    const key = await articlePreferenceKey(zotero, itemID)
    const raw = key ? zotero.Prefs?.get(key, true) : undefined
    return normalizeTranslationLanguages(typeof raw === "string" ? JSON.parse(raw) : raw)
  } catch {
    return normalizeTranslationLanguages(undefined)
  }
}

/** 显式保存仅影响本篇；无法保存返回 false，调用方仍可使用当前窗口内的选择。 */
export async function writeArticleTranslationLanguages(
  zotero: TranslationSettingsHost,
  itemID: number,
  languages: TranslationLanguages,
): Promise<boolean> {
  try {
    const key = await articlePreferenceKey(zotero, itemID)
    if (!key || !zotero.Prefs?.set) return false
    zotero.Prefs.set(key, JSON.stringify(normalizeTranslationLanguages(languages)), true)
    return true
  } catch {
    return false
  }
}
