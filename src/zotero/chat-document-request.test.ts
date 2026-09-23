/** 发送前全请求预算与本地文档引用测试，不通过旧来源文字上限。 */
import { describe, expect, it, vi } from 'vitest'
import { prepareDocumentRequest, chatDocumentCapacity } from './chat-document-request'
import { documentChunks, documentTokenCost } from '@/chat/long-document-context'
import { localChatMessages } from '@/chat/temporary-chat'
import type { ChatDocument } from './chat-documents'
import type { ZoteroLike } from './runtime'
import { saveChatDocumentMode } from './chat-document-policy'
const { ensure } = vi.hoisted(() => ({ ensure: vi.fn() }))
vi.mock('./chat-documents', () => ({ chatDocuments: () => ({ ensure, save: async () => {} }) }))

function setup() {
  const items = new Map([1, 2].map(id => [id, { id, libraryID: 7, key: `PDF${id}`, attachmentModificationTime: 1, isPDFAttachment: () => true }]))
  const prefs = new Map<string, unknown>()
  const host = { Items: { get: (id: number) => items.get(id) }, Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => { prefs.set(key, value) } } } as unknown as ZoteroLike
  const docs: ChatDocument[] = [1, 2].map(id => {
    const source = { itemID: id, libraryID: 7, itemKey: `PDF${id}`, title: `文献 ${id}`, modificationTime: 1 }
    return { source: { ...source, id: `pdf${id}`, kind: 'file', contentType: 'application/pdf', citation: '', text: 'legacy clipped text' },
      state: { version: 1, id: crypto.randomUUID(), source, totalPages: 81, pageIndexes: [], extractionVersion: 1, complete: true, summaries: {} },
      pages: Array.from({ length: 81 }, (_, pageIndex) => ({ pageIndex, pageLabel: String(pageIndex + 1), lines: [], paragraphs: [{ id: `p${pageIndex}`, lineIDs: [], rects: [], pageIndex, pageLabel: String(pageIndex + 1), text: pageIndex === 80 ? `TAIL-${id}=7391` : '中英双语 evidence '.repeat(160) }] })) }
  })
  ensure.mockImplementation(async (_host, source) => { const document = docs.find(row => row.source.itemID === source.itemID)!; document.source = { ...source, text: '', document: { id: document.state.id, version: 1, totalPages: 81, readablePages: 81, complete: true } }; return document })
  return { host, docs, items }
}

describe('PDF request preparation', () => {
  it('budgets multi-PDF text, history, image and output while finding both tail pages', async () => {
    const f = setup()
    const input = { host: f.host, feature: 'chat' as const, sources: f.docs.map(row => row.source),
      messages: [{ id: 'old', role: 'user' as const, text: 'history '.repeat(15000) }, { id: 'last', role: 'user' as const, text: '第 81 页 TAIL 是多少？' }],
      imageCount: 1, signal: new AbortController().signal, modelIdentity: 'platform', progress: vi.fn(), update: vi.fn(),
      generate: vi.fn(async (prompt: string) => prompt.includes('只返回 JSON') ? '{"ids":[]}' : '文献概括') }
    const request = await prepareDocumentRequest(input)
    const projected = localChatMessages(request.messages, request.sources)
    expect(projected.at(-1)?.content).toContain('TAIL-1=7391')
    expect(projected.at(-1)?.content).toContain('TAIL-2=7391')
    expect(documentTokenCost(JSON.stringify(projected)) + 4096).toBeLessThanOrEqual(chatDocumentCapacity(f.host, 'chat').input)
    expect(input.messages[0].text.length).toBeGreaterThan(100000)
    expect(request.reading?.notice).toContain('省略较早对话')
    expect(request.sources.every(source => !source.text)).toBe(true)
  })
  it('removes stale material when a PDF changes during intermediate generation', async () => {
    const f = setup()
    saveChatDocumentMode(f.host, 'summarize')
    const request = await prepareDocumentRequest({ host: f.host, feature: 'chat', sources: [f.docs[0].source], messages: [{ id: 'q', role: 'user', text: '请全面总结第 81 页是什么？' }],
      imageCount: 0, signal: new AbortController().signal, modelIdentity: 'platform', progress: vi.fn(), update: vi.fn(),
      generate: async () => { f.items.get(1)!.attachmentModificationTime = 2; return 'summary' } })
    expect(request.messages[0].text).toBe('请全面总结第 81 页是什么？')
    expect(request.reading?.notice).toContain('已变化')
    expect(request.reading?.sources).toEqual([])
  })
  it('answers a figure from the relevant PDF page without waiting for long-document summaries', async () => {
    const f = setup()
    const generate = vi.fn(async () => 'unneeded summary')
    const request = await prepareDocumentRequest({ host: f.host, feature: 'figure', sources: [f.docs[0].source],
      messages: [{ id: 'figure', role: 'user', text: '请解读这张图片。\n页码：81\n图注：TAIL-1' }],
      imageCount: 1, signal: new AbortController().signal, modelIdentity: 'platform', progress: vi.fn(), update: vi.fn(), generate })
    expect(generate).not.toHaveBeenCalled()
    expect(request.messages[0].text).toContain('TAIL-1=7391')
    expect(request.reading?.sources[0].pages).toContainEqual({ pageIndex: 80, pageLabel: '81' })
    saveChatDocumentMode(f.host, 'summarize')
    await prepareDocumentRequest({ host: f.host, feature: 'figure', sources: [f.docs[0].source],
      messages: [{ id: 'figure', role: 'user', text: '请解读这张图片。\n页码：81\n图注：TAIL-1' }],
      imageCount: 1, signal: new AbortController().signal, modelIdentity: 'platform', progress: vi.fn(), update: vi.fn(), generate })
    expect(generate).toHaveBeenCalled()
  })
  it('uses the feature setting rather than prompt wording to start full-text summary batches', async () => {
    const f = setup(), messages = [{ id: 'summary', role: 'user' as const, text: '请概括全文，包括最后一页' }]
    const generate = vi.fn(async (_prompt: string) => '概括了全部相关证据')
    const input = { host: f.host, feature: 'chat' as const, sources: [f.docs[0].source], messages, imageCount: 0,
      signal: new AbortController().signal, modelIdentity: 'platform', progress: vi.fn(), update: vi.fn(), generate }
    await prepareDocumentRequest(input)
    expect(generate).not.toHaveBeenCalled()
    saveChatDocumentMode(f.host, 'summarize')
    const request = await prepareDocumentRequest(input)
    const calls = generate.mock.calls.map(row => row[0])
    const summaryBudget = chatDocumentCapacity(f.host, 'chat').input - documentTokenCost(messages[0].text) - 1024
    const batches = documentChunks([f.docs[0]], [1], summaryBudget)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter(prompt => prompt.includes('请用不超过 300 字'))).toHaveLength(batches.length)
    expect(batches.length).toBeLessThan(documentChunks([f.docs[0]], [1], 2000).length)
    expect(batches.slice(0, -1).every(chunk => documentTokenCost(chunk.text) > summaryBudget * .65)).toBe(true)
    expect(calls.every(prompt => documentTokenCost(prompt) <= chatDocumentCapacity(f.host, 'chat').input)).toBe(true)
    expect(request.reading?.notice).toContain('全部可读正文已分段整理')
  })
})
