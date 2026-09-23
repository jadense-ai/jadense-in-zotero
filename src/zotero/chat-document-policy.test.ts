/** 长文模式偏好回归：旧 profile 默认截取，图片解读沿用 AI 对话。 */
import { describe, expect, it } from 'vitest'
import { CHAT_DOCUMENT_MODE_PREF_KEY, readChatDocumentMode, saveChatDocumentMode } from './chat-document-policy'
import type { ZoteroLike } from './runtime'

describe('linked PDF long-text mode', () => {
  it('defaults to truncation and reads one shared Chat mode', () => {
    const values = new Map<string, unknown>()
    const host = { Prefs: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value) } } } as ZoteroLike
    expect(readChatDocumentMode(host)).toBe('truncate')
    saveChatDocumentMode(host, 'summarize')
    expect(readChatDocumentMode(host)).toBe('summarize')
    values.set(CHAT_DOCUMENT_MODE_PREF_KEY, 'unknown')
    expect(readChatDocumentMode(host)).toBe('truncate')
  })
})
