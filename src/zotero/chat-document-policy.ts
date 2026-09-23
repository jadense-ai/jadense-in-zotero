/** 关联 PDF 的本地对话策略；功能配置只保存模式，不保存正文或模型请求。 */
import type { ZoteroLike } from './runtime'

export type ChatDocumentMode = 'truncate' | 'summarize'

export const CHAT_DOCUMENT_MODE_PREF_KEY = 'extensions.jadenseInZotero.chatLongDocumentMode'

/** 未配置或旧版偏好默认只按本轮容量截取；未知值不启动额外 AI 请求。 */
export function readChatDocumentMode(host: ZoteroLike): ChatDocumentMode {
  try { return host.Prefs?.get(CHAT_DOCUMENT_MODE_PREF_KEY) === 'summarize' ? 'summarize' : 'truncate' }
  catch { return 'truncate' }
}

/** 用户在对应功能配置中选择后，仅影响后续发送。 */
export function saveChatDocumentMode(host: ZoteroLike, mode: ChatDocumentMode) {
  if (!host.Prefs?.set) throw new Error('Preferences unavailable')
  host.Prefs.set(CHAT_DOCUMENT_MODE_PREF_KEY, mode)
}
