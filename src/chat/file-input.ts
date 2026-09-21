/** 文档附件契约：Prefs 只保存元数据，提取文字由 profile 文件存储管理。 */
import { normalizeLocalChatImage, type ChatImageInput } from './image-input'

export type ChatFileInput = { name: string; mimeType: string; size: number; text: string; warning?: string }
export type ChatUploadInput = ChatImageInput | ChatFileInput
export type LocalChatFile = Omit<ChatFileInput, 'text'> & { id: string }
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024
export const MAX_CHAT_FILE_TEXT = 60_000
export const CHAT_FILE_ACCEPT = '.pdf,.docx,.html,.htm,.md,.markdown,.txt,.csv,.tsv,.json,.bib,.tex,.xml,.yaml,.yml,.ris,image/png,image/jpeg'
export const isChatFile = (value: ChatUploadInput): value is ChatFileInput => 'text' in value

/** 元数据的未知字段忽略；UUID 继续约束 profile 内文件访问。 */
export function normalizeLocalChatFile(value: unknown): LocalChatFile | undefined {
  const reference = normalizeLocalChatImage(value)
  if (!reference) return undefined
  const row = value as Record<string, unknown>
  return { id: reference.id, name: reference.name,
    mimeType: typeof row.mimeType === 'string' ? row.mimeType.slice(0, 150) : 'text/plain',
    size: typeof row.size === 'number' && Number.isFinite(row.size) ? Math.max(0, row.size) : 0,
    ...(typeof row.warning === 'string' ? { warning: row.warning.slice(0, 500) } : {}) }
}

export function fileSizeLabel(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
}
