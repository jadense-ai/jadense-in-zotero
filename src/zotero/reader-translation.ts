/**
 * 阅读器选文翻译运行时。
 * 上游接收本地选区，下游按当前 AI 通道生成译文并写入独立翻译历史。
 */
import { ByokChatClient, byokConfigurationIssue } from "@/chat/byok-chat"
import { buildTranslationPrompt } from "@/chat/paper-analysis"
import { normalizeTranslationLanguages, translationLanguageLabel } from "@/chat/translation-languages"
import { TemporaryChatClient } from "@/chat/temporary-chat"
import { JadenseApiError } from "@/jadense/api"
import {
  appendTranslationRecord,
  type TranslationRecord,
  type TranslationPreferenceStore,
} from "@/chat/translation-history"
import { collectSourceForItem } from "./research-context"
import { readAiRoute, readByokConfig } from "./ai-settings"
import { readConnection, type ZoteroLike } from "./runtime"
import { readArticleTranslationLanguages } from "./translation-settings"
import type { ReaderAction } from "./reader-tools"

function createId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.()
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`
}

function translationPreferences(zotero: ZoteroLike): TranslationPreferenceStore {
  if (!zotero.Prefs) throw new Error("当前 Zotero profile 不支持本地翻译存储。")
  return zotero.Prefs
}

function friendlyTranslationError(error: unknown) {
  const message = error instanceof Error ? error.message : "翻译生成失败，请稍后重试。"
  if (error instanceof JadenseApiError && error.code?.toUpperCase() === "POINTS_INSUFFICIENT") {
    return "当前可用积分不足。请打开「连接攻玉」签到领积分或补充积分后重试。"
  }
  return error instanceof JadenseApiError && error.code?.toLowerCase() === "insufficient_scope"
    ? "当前令牌缺少翻译所需的对话权限，请在「连接攻玉」中重新生成 Zotero 令牌。"
    : message
}

export async function translateReaderSelection(input: {
  zotero: ZoteroLike
  action: ReaderAction
  fetchImpl: typeof fetch
  onTextDelta?: (text: string) => void
}): Promise<TranslationRecord> {
  const selectedText = input.action.text?.trim() ?? ""
  if (!selectedText) throw new Error("请先选中要翻译的文字。")

  // 新历史必须绑定可复核的物理附件身份，不能把读取失败伪装成只含 itemID 的旧记录。
  const source = await Promise.resolve(
    collectSourceForItem(input.zotero, input.action.itemID, { includeText: false }),
  ).catch(() => null)
  const title = source?.parentItem?.title ?? source?.title
  const citation = source?.citation
  const route = readAiRoute(input.zotero)
  const connection = readConnection(input.zotero)
  const byok = readByokConfig(input.zotero)
  if (route === "byok") {
    const issue = byokConfigurationIssue(byok)
    if (issue) throw new Error(issue)
  } else if (!connection.token) {
    throw new Error("请先在「连接攻玉」中配置攻玉令牌。")
  }
  if (!source || source.kind !== "file" || source.itemID !== input.action.itemID) {
    throw new Error("无法确认当前 PDF 附件身份；本次翻译未发送，也不会写入历史。")
  }
  const languages = normalizeTranslationLanguages(
    "languages" in input.action ? input.action.languages : undefined,
    await readArticleTranslationLanguages(input.zotero, input.action.itemID),
  )

  const client = route === "byok"
    ? new ByokChatClient({ config: byok, fetchImpl: input.fetchImpl })
    : new TemporaryChatClient({ baseUrl: connection.baseUrl, token: connection.token, fetchImpl: input.fetchImpl })
  const id = createId("translation")
  let translatedText = ""
  try {
    translatedText = await client.send({
      clientRequestId: createId("request"),
      conversationId: id,
      messages: [{
        id: createId("user"),
        role: "user",
        text: buildTranslationPrompt({
          text: selectedText,
          title,
          citation,
          pageLabel: input.action.pageLabel,
          ...languages,
        }),
      }],
      onTextDelta: (_delta, accumulatedText) => input.onTextDelta?.(accumulatedText),
    })
  } catch (error) {
    throw new Error(friendlyTranslationError(error))
  }
  if (!translatedText.trim()) throw new Error("AI 没有返回可显示的译文。")

  return appendTranslationRecord(translationPreferences(input.zotero), {
    id,
    createdAt: new Date().toISOString(),
    source: {
      text: selectedText,
      itemID: input.action.itemID,
      libraryID: source.libraryID,
      itemKey: source.itemKey,
      ...(title ? { title } : {}),
      ...(citation ? { citation } : {}),
      ...(input.action.pageIndex !== undefined ? { pageIndex: input.action.pageIndex } : {}),
      ...(input.action.pageLabel ? { pageLabel: input.action.pageLabel } : {}),
    },
    result: {
      text: translatedText,
      sourceLanguage: translationLanguageLabel(languages.sourceLanguage),
      targetLanguage: translationLanguageLabel(languages.targetLanguage),
    },
  })
}
