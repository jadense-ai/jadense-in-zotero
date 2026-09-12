/** 多视图共享运行时的行为回归；全部使用合成附件、Prefs 和本地模型 stub。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatRuntime } from './chat-runtime'
import { createLocalChatSession, readLocalChatState, selectLocalChatSession } from '@/chat/local-chat-store'
import { saveByokModel, saveByokProvider, saveFeatureModelSelection } from './ai-settings'
import type { ZoteroLike } from './runtime'

afterEach(() => vi.unstubAllGlobals())
function harness() {
  const files = new Map<string, string>()
  vi.stubGlobal('PathUtils', { profileDir: '/synthetic', join: (...parts: string[]) => parts.join('/'), filename: (path: string) => path.split('/').at(-1) })
  vi.stubGlobal('IOUtils', { makeDirectory: async () => {}, getChildren: async (path: string) => [...files.keys()].filter(key => key.startsWith(path + '/')), readUTF8: async (path: string) => files.get(path), writeUTF8: async (path: string, text: string) => { files.set(path, text) } })
  const values = new Map<string, unknown>()
  const attachment = { id: 2, libraryID: 7, key: 'PDF2', itemType: 'attachment', attachmentContentType: 'application/pdf', isAttachment: () => true, isPDFAttachment: () => true, getField: () => 'Synthetic PDF' }
  const get = vi.fn(() => attachment as typeof attachment | undefined)
  const extract = vi.fn(async () => ({ text: 'Synthetic evidence', extractedPages: 1, totalPages: 1 }))
  const host = { Prefs: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value) }, clear: (key: string) => { values.delete(key) } }, Items: { get }, PDFWorker: { getFullText: extract } } as unknown as ZoteroLike
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  const runtime = new ChatRuntime(host, fetch)
  saveByokProvider(host, { id: 'provider', name: 'Synthetic', protocol: 'openai-chat-completions', baseUrl: 'http://localhost:12345/v1', apiKey: 'synthetic' })
  saveByokModel(host, { id: 'model', providerId: 'provider', name: 'Synthetic', model: 'synthetic-model', contextWindow: 10000, maxOutputTokens: 1000 })
  saveFeatureModelSelection(host, 'chat', { route: 'byok', modelId: 'model' })
  return { host, runtime, fetch, extract, get, attachment }
}

describe('shared Reader Chat lifecycle', () => {
  it('creates a linked PDF conversation without changing another view selection', async () => {
    const { runtime } = harness()
    const old = createLocalChatSession(runtime.preferences)
    const id = await runtime.create(2)
    const state = readLocalChatState(runtime.preferences)
    expect(state.activeSessionId).toBe(old.id)
    expect(state.sessions.find(session => session.id === id)?.sources[0]).toMatchObject({ kind: 'file', itemID: 2, text: 'Synthetic evidence' })
  })
  it('does not associate merely by selecting; sending associates before dispatch and deduplicates', async () => {
    const { runtime, fetch, extract } = harness()
    const session = createLocalChatSession(runtime.preferences)
    selectLocalChatSession(runtime.preferences, session.id)
    expect(readLocalChatState(runtime.preferences).sessions[0].sources).toEqual([])
    await runtime.send({ sessionID: session.id, itemID: 2, prompt: 'Question' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user' })]))
    await runtime.send({ sessionID: session.id, itemID: 2, prompt: 'Follow-up' })
    expect(readLocalChatState(runtime.preferences).sessions[0].sources).toHaveLength(1)
    expect(extract).toHaveBeenCalledTimes(1)
  })
  it('pins the session while extracting, shares one generation lock, and permits view selection', async () => {
    const { runtime, extract, fetch } = harness()
    let release!: (value: { text: string; extractedPages: number; totalPages: number }) => void
    extract.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = createLocalChatSession(runtime.preferences), other = createLocalChatSession(runtime.preferences)
    const send = runtime.send({ sessionID: first.id, itemID: 2, prompt: 'First question' })
    await vi.waitFor(() => expect(release).toBeDefined())
    selectLocalChatSession(runtime.preferences, other.id)
    expect(await runtime.send({ sessionID: other.id, prompt: 'Parallel' })).toBe(false)
    release({ text: 'Evidence', extractedPages: 1, totalPages: 1 }); await send
    const state = readLocalChatState(runtime.preferences)
    expect(state.activeSessionId).toBe(other.id)
    expect(state.sessions.find(s => s.id === other.id)?.messages).toEqual([])
    expect(state.sessions.find(s => s.id === first.id)?.messages.at(-1)?.text).toBe('Answer')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects a changed attachment without association, accepting a message, or dispatch', async () => {
    const { runtime, extract, attachment, fetch } = harness()
    extract.mockImplementationOnce(async () => { attachment.key = 'REUSED'; return { text: 'Other file', extractedPages: 1, totalPages: 1 } })
    const session = createLocalChatSession(runtime.preferences), accepted = vi.fn()
    await runtime.send({ sessionID: session.id, itemID: 2, prompt: 'Question', onAccepted: accepted })
    expect(fetch).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled()
    expect(readLocalChatState(runtime.preferences).sessions[0]).toMatchObject({ sources: [], messages: [] })
  })
  it('keeps source metadata when optional PDF text extraction fails', async () => {
    const { runtime, extract, fetch } = harness()
    extract.mockRejectedValueOnce(new Error('No text layer'))
    const session = createLocalChatSession(runtime.preferences)
    await runtime.send({ sessionID: session.id, itemID: 2, prompt: 'Question' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(readLocalChatState(runtime.preferences).sessions[0].sources[0].warning).toBeTruthy()
  })
  it('unsubscribing a closed view does not stop a request or another view updates', async () => {
    const { runtime } = harness()
    const closed = vi.fn(), open = vi.fn()
    runtime.subscribe(closed)(); runtime.subscribe(open)
    const session = createLocalChatSession(runtime.preferences)
    await runtime.send({ sessionID: session.id, prompt: 'Question' })
    expect(closed).not.toHaveBeenCalled(); expect(open).toHaveBeenCalled()
    expect(readLocalChatState(runtime.preferences).sessions[0].messages.at(-1)?.status).toBe('complete')
  })
  it('stops an unresponsive PDF read immediately and ignores late results without clearing drafts', async () => {
    const { runtime, extract, fetch } = harness()
    let release!: (value: { text: string; extractedPages: number; totalPages: number }) => void
    extract.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const session = createLocalChatSession(runtime.preferences), accepted = vi.fn()
    const sending = runtime.send({ sessionID: session.id, itemID: 2, prompt: 'Keep draft', onAccepted: accepted })
    await vi.waitFor(() => expect(release).toBeDefined())
    runtime.stop(); expect(await sending).toBe(false); expect(runtime.busy).toBe(false)
    release({ text: 'Late result', extractedPages: 1, totalPages: 1 }); await Promise.resolve()
    expect(accepted).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    expect(readLocalChatState(runtime.preferences).sessions[0]).toMatchObject({ sources: [], messages: [] })
  })
  it('an unavailable attachment leaves an existing session unchanged', async () => {
    const { runtime, get, fetch } = harness()
    const session = createLocalChatSession(runtime.preferences)
    get.mockReturnValue(undefined)
    expect(await runtime.send({ sessionID: session.id, itemID: 2, prompt: 'Question' })).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(readLocalChatState(runtime.preferences).sessions[0]).toMatchObject({ sources: [], messages: [] })
  })
})
