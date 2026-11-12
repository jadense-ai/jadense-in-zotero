/** 全文保存、冷启动回读与文件缺失隔离；全部IO在内存执行。 */
import { describe, expect, it } from 'vitest'
import { LocalMessageBodies } from './local-message-bodies'
import { createLocalChatSession, appendLocalChatMessage, readLocalChatState, LOCAL_CHAT_PREF_KEY } from './local-chat-store'

it('keeps a message larger than the entire Prefs budget through a UUID body reference', () => {
  const values = new Map<string, unknown>()
  const prefs = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value) }, clear: (key: string) => { values.delete(key) } }
  const session = createLocalChatSession(prefs), text = '完整正文'.repeat(300000)
  appendLocalChatMessage(prefs, session.id, { id: 'message', role: 'user', text, createdAt: new Date().toISOString() })
  expect(String(prefs.get(LOCAL_CHAT_PREF_KEY)).length).toBeLessThan(30000)
  expect(readLocalChatState(prefs).sessions[0].messages[0].text).toBe(text)
})

describe('profile message bodies', () => {
  it('restores full Unicode text after a cold start without overwriting it with a preview', async () => {
    const files = new Map<string, string>()
    const platform = () => ({ IOUtils: { makeDirectory: async () => {}, writeUTF8: async (path: string, text: string) => { files.set(path, text) }, readUTF8: async (path: string) => files.get(path)! }, PathUtils: { profileDir: '/synthetic', join: (...parts: string[]) => parts.join('/') } })
    const store = new LocalMessageBodies(platform), text = '正文😀\n'.repeat(30000)
    const reference = store.project({ text }); await store.flush()
    const restored = new LocalMessageBodies(platform)
    restored.project(reference); await restored.flush()
    await restored.hydrate([reference])
    expect(restored.restore(reference).text).toBe(text)
    expect([...files.values()]).toEqual([text])
  })
  it('ignores malformed UUID references and retains memory text when disk is unavailable', async () => {
    const store = new LocalMessageBodies(() => ({})), text = 'x'.repeat(100000)
    expect(store.restore({ text: 'preview', textRef: '../private-file' })).toEqual({ text: 'preview' })
    const reference = store.project({ text }); await store.flush()
    expect(store.restore(reference).text).toBe(text)
  })
})
