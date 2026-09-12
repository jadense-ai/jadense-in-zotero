import { literatureIdentity } from "./document-identity"
/**
 * 阅读器选文翻译运行时。
 * 上游接收本地选区，下游按独立翻译模型生成译文并写入独立翻译历史。
 */
import { ReliableByokChatClient as ByokChatClient } from "@/chat/reliable-byok-chat"
import { buildTranslationPrompt } from "@/chat/paper-analysis"
import { normalizeTranslationLanguages, translationLanguageLabel } from "@/chat/translation-languages"
import { ReliableTemporaryChatClient as TemporaryChatClient } from "@/chat/reliable-temporary-chat"
import { JadenseApiError, jadenseModelSubscriptionErrorMessage } from "@/jadense/api"
import {
  appendTranslationRecord,
  type TranslationRecord,
  type TranslationPreferenceStore,
} from "@/chat/translation-history"
import { collectSourceForItem } from "./research-context"
import { featureModelState } from "./ai-settings"
import { readConnection, type ZoteroLike } from "./runtime"
import { readArticleTranslationLanguages } from "./translation-settings"
import type { ReaderAction } from "./reader-tools"
import { uiText } from "./ui-preferences"
import { recordStarInvitationUse } from "./star-invitation"
import { readTranslationInterface } from './translation-interface'
import { translateMachineText } from '@/chat/machine-translation'

function createId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.()
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`
}

function translationPreferences(zotero: ZoteroLike): TranslationPreferenceStore {
  if (!zotero.Prefs) throw new Error(uiText("当前 Zotero 无法保存本地翻译历史。", "Zotero cannot save local translation history right now."))
  return zotero.Prefs
}

function friendlyTranslationError(error: unknown) {
  const message = error instanceof Error ? error.message : uiText("翻译生成失败，请稍后重试。", "Translation failed. Please try again.")
  const subscriptionIssue = jadenseModelSubscriptionErrorMessage(error)
  if (subscriptionIssue) return subscriptionIssue
  if (error instanceof JadenseApiError && error.code?.toUpperCase() === "POINTS_INSUFFICIENT") {
    return uiText("当前可用积分不足。请前往攻玉学术主页签到领积分或补充积分后重试。", "Insufficient points. Visit the Jadense academic homepage to check in or add points, then try again.")
  }
  return error instanceof JadenseApiError && error.code?.toLowerCase() === "insufficient_scope"
    ? uiText("当前令牌缺少翻译所需的对话权限，请在「连接攻玉」中重新生成 Zotero 令牌。", "This token lacks the chat permission required for translation. Generate a new Zotero token in “Connect Jadense”.")
    : message
}

export async function translateReaderSelection(input: {
  zotero: ZoteroLike
  action: ReaderAction
  fetchImpl: typeof fetch
  onTextDelta?: (text: string) => void
}): Promise<TranslationRecord> {
  const selectedText = input.action.text?.trim() ?? ""
  if (!selectedText) throw new Error(uiText("请先选中要翻译的文字。", "Select the text to translate first."))

  // 新历史必须绑定可复核的物理附件身份，不能把读取失败伪装成只含 itemID 的旧记录。
  const source = await Promise.resolve(
    collectSourceForItem(input.zotero, input.action.itemID, { includeText: false }),
  ).catch(() => null)
  const title = source?.parentItem?.title ?? source?.title
  const citation = source?.citation
  const config = readTranslationInterface(input.zotero)
  const model = config.kind === 'ai' ? featureModelState(input.zotero, 'translation') : null
  if (model && !model.ready) throw new Error(model.issue)
  if (!source || source.kind !== "file" || source.itemID !== input.action.itemID) {
    throw new Error(uiText("无法确认当前 PDF 附件身份；本次翻译未发送，也不会写入历史。", "The current PDF attachment could not be verified. No translation request was sent and no history was saved."))
  }
  const languages = normalizeTranslationLanguages(
    "languages" in input.action ? input.action.languages : undefined,
    await readArticleTranslationLanguages(input.zotero, input.action.itemID),
  )

  const id = createId("translation")
  let translatedText = ""
  try {
    if (!model) {
      translatedText = await translateMachineText({ host: input.zotero, service: config.service, text: selectedText, ...languages, fetchImpl: input.fetchImpl, onText: input.onTextDelta })
    } else {
      const connection = readConnection(input.zotero)
      const client = model.route === "byok"
        ? new ByokChatClient({ config: model.config!, fetchImpl: input.fetchImpl })
        : new TemporaryChatClient({ baseUrl: connection.baseUrl, token: connection.token, selection: model.selection.selection, fetchImpl: input.fetchImpl })
      translatedText = await client.send({
        clientFeature: "translation",
        clientRequestId: createId("request"),
        conversationId: id,
        taskId: id,
        operationId: id,
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
    }
  } catch (error) {
    throw new Error(friendlyTranslationError(error))
  }
  if (!translatedText.trim()) throw new Error(uiText("AI 没有返回可显示的译文。", "The AI did not return a translation."))

  const record = appendTranslationRecord(translationPreferences(input.zotero), {
    id,
    createdAt: new Date().toISOString(),
    source: {
      literature: literatureIdentity(input.zotero, source),
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
  recordStarInvitationUse(input.zotero)
  return record
}
