/** 教学复用真实调度入口的边界测试：不携带当前会话，不把接纳、片段或取消误判为成功。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appendLocalChatMessage, createLocalChatSession, readLocalChatState } from '@/chat/local-chat-store'
import { checkOnboardingEngines, sendOnboardingHello } from './manager-onboarding-actions'
import type { ZoteroLike } from './runtime'

const fakes = vi.hoisted(() => ({ runtime: null as unknown, ocr: vi.fn(), exists: vi.fn(), check: vi.fn() }))
vi.mock('./chat-runtime', () => ({ chatRuntime: () => fakes.runtime }))
vi.mock('./local-ocr', () => ({ localOCRReadiness: fakes.ocr }))
vi.mock('./pdf-translation-runtime', () => ({ PDF_ENGINE: 'engine', pdfRuntimeRoot: () => 'runtime', pdfPlatform: () => ({ IOUtils: { exists: fakes.exists }, PathUtils: { join: (...parts: string[]) => parts.join('/') } }) }))
vi.mock('./pdf-translation-jobs', () => ({ pdfTranslationJobs: () => ({ checkEngine: fakes.check }) }))

function fixture(status: 'complete' | 'failed' | 'streaming' = 'complete', text = '你好！', kind = 'success') {
  const data = new Map<string, unknown>()
  const preferences = { get: (key: string) => data.get(key), set: (key: string, value: unknown) => { data.set(key, value) }, clear: (key: string) => { data.delete(key) } }
  const host = { Prefs: preferences } as ZoteroLike
  const runtime = { busy: false, preferences, statusKind: kind, status: 'response status', send: vi.fn(async (input: { sessionID: string; prompt: string; prepare: () => Promise<unknown> }) => {
    expect(input.prompt).toBe('你好')
    expect(await input.prepare()).toEqual({ requestText: '你好', requireComplete: true })
    appendLocalChatMessage(preferences, input.sessionID, { id: 'hello-reply', role: 'assistant', text, status, createdAt: new Date().toISOString() })
    return true
  }) }
  fakes.runtime = runtime
  return { host, runtime, preferences }
}

beforeEach(() => { vi.clearAllMocks(); fakes.ocr.mockResolvedValue(true); fakes.exists.mockResolvedValue(true); fakes.check.mockResolvedValue(undefined) })

describe('onboarding hello', () => {
  it('creates a separate empty conversation and requires a complete nonempty response', async () => {
    const { host, preferences } = fixture()
    const existing = createLocalChatSession(preferences, { title: 'Existing work' })
    appendLocalChatMessage(preferences, existing.id, { id: 'draft-context', role: 'user', text: 'Private context', createdAt: new Date().toISOString() })
    const created = vi.fn()
    expect(await sendOnboardingHello(host, created)).toEqual({ success: true })
    expect(created).toHaveBeenCalledOnce()
    const state = readLocalChatState(preferences)
    expect(state.activeSessionId).not.toBe(existing.id)
    expect(state.sessions.find(s => s.id === existing.id)?.messages[0].text).toBe('Private context')
    expect(state.sessions.find(s => s.id === state.activeSessionId)?.sources).toEqual([])
  })
  it.each([['failed', 'failure', 'error'], ['streaming', 'partial', 'success'], ['complete', '  ', 'success'], ['complete', 'text', 'idle']] as const)('does not accept %s / %s / %s', async (status, text, kind) => {
    const { host } = fixture(status, text, kind)
    expect((await sendOnboardingHello(host)).success).toBe(false)
  })
  it('does not create or dispatch while another conversation is running', async () => {
    const { host, runtime, preferences } = fixture()
    runtime.busy = true
    expect((await sendOnboardingHello(host)).success).toBe(false)
    expect(runtime.send).not.toHaveBeenCalled()
    expect(readLocalChatState(preferences).sessions).toEqual([])
  })
})

describe('onboarding engine checks', () => {
  it('requires OCR model readiness and an actual successful PDF check', async () => {
    expect(await checkOnboardingEngines(fixture().host, new AbortController().signal)).toEqual({ ocr: true, pdf: true })
    expect(fakes.check).toHaveBeenCalledOnce()
  })
  it('does not install or check a missing PDF engine', async () => {
    fakes.ocr.mockResolvedValue(null); fakes.exists.mockResolvedValue(false)
    expect(await checkOnboardingEngines(fixture().host, new AbortController().signal)).toEqual({ ocr: false, pdf: false })
    expect(fakes.check).not.toHaveBeenCalled()
  })
  it('contains independent check failures to their engine', async () => {
    fakes.check.mockRejectedValue(new Error('broken PDF engine'))
    expect(await checkOnboardingEngines(fixture().host, new AbortController().signal)).toEqual({ ocr: true, pdf: false })
    fakes.ocr.mockRejectedValue(new Error('OCR unavailable')); fakes.check.mockResolvedValue(undefined)
    expect(await checkOnboardingEngines(fixture().host, new AbortController().signal)).toEqual({ ocr: false, pdf: true })
  })
})
