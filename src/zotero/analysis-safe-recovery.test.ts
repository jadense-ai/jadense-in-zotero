/** 实际可靠客户端 + 内存执行日志：丢失 POST 响应后只 GET 原执行，不重复派发模型。 */
import { expect, it, vi } from 'vitest'
import { runIndependentPaperAnalysis } from './paper-analysis-runner'
import { AUTO_FOLLOW_CHAT_MODEL_PREF_KEY } from './ai-settings'
import type { PdfAnalysisSnapshot } from './reader-tools'

vi.mock('@/chat/temporary-request-store', async () => {
  const actual = await vi.importActual<typeof import('@/chat/temporary-request-store')>('@/chat/temporary-request-store')
  const rows: import('@/chat/temporary-request-store').LocalTemporaryRequest[] = []
  return { ...actual, TemporaryRequestStore: class {
    async list() { return rows }
    async save(row: typeof rows[number]) { const index = rows.findIndex(value => value.id === row.id); if (index < 0) rows.push(row); else rows[index] = row }
  } }
})

it('recovers the original operation and only then persists one result', async () => {
  const prefs = new Map<string, unknown>([
    [AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, false], ['extensions.jadenseInZotero.token', 'fixture'],
    ['extensions.jadenseInZotero.baseUrl', 'https://fixture.invalid'],
    ['extensions.jadenseInZotero.paperAnalysisModel', JSON.stringify({ route: 'jadense', selection: { kind: 'model', modelId: 'fixture' } })],
  ])
  const zotero = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => { prefs.set(key, value) } } }
  let body: Record<string, string> = {}
  const methods: string[] = []
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'; methods.push(method)
    const headers = { 'x-jadense-temporary-protocol': '1' }
    if (method === 'HEAD') return new Response(null, { headers })
    if (method === 'POST') { body = JSON.parse(String(init?.body)); throw new TypeError('Connection lost after dispatch') }
    expect(String(url)).toContain(`requestId=${body.clientRequestId}`)
    expect(String(url)).toContain(`conversationId=${body.temporaryConversationId}`)
    return new Response(JSON.stringify({ complete: true, state: 'completed', text: JSON.stringify({ summary: 'Recovered summary', annotations: [] }) }), { headers })
  })
  const pdf: PdfAnalysisSnapshot = { itemID: 42, libraryID: 1, itemKey: 'PDF42', title: 'Fixture', metadata: { title: 'Fixture', authors: [] }, passages: [], coverage: { pagesRead: 1, totalPages: 1, limited: false, pageNumbers: [1], warnings: [] } }
  const saveAnnotations = vi.fn()
  const result = await runIndependentPaperAnalysis({ zotero, itemID: 42, signal: new AbortController().signal, fetchImpl,
    services: { readPdf: async () => pdf, saveAnnotations } })
  expect(result.record.summary).toBe('Recovered summary')
  expect(result.historySaved).toBe(true)
  expect(methods).toEqual(['HEAD', 'POST', 'GET'])
  expect(saveAnnotations).not.toHaveBeenCalled()
})
