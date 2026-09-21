/** 发送前全请求预算与本地文档引用测试，不通过旧来源文字上限。 */
import { describe, expect, it, vi } from 'vitest'
import { prepareDocumentRequest, chatDocumentCapacity } from './chat-document-request'
import { documentTokenCost } from '@/chat/long-document-context'
import { localChatMessages } from '@/chat/temporary-chat'
import type { ChatDocument } from './chat-documents'
import type { ZoteroLike } from './runtime'
const { ensure } = vi.hoisted(() => ({ ensure: vi.fn() }))
vi.mock('./chat-documents', () => ({ chatDocuments: () => ({ ensure, save: async () => {} }) }))

function setup() {
  const items = new Map([1, 2].map(id => [id, { id, libraryID: 7, key: `PDF${id}`, attachmentModificationTime: 1, isPDFAttachment: () => true }]))
  const host = { Items: { get: (id: number) => items.get(id) }, Prefs: { get: () => undefined } } as unknown as ZoteroLike
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
    const request = await prepareDocumentRequest({ host: f.host, feature: 'chat', sources: [f.docs[0].source], messages: [{ id: 'q', role: 'user', text: '第 81 页是什么？' }],
      imageCount: 0, signal: new AbortController().signal, modelIdentity: 'platform', progress: vi.fn(), update: vi.fn(),
      generate: async () => { f.items.get(1)!.attachmentModificationTime = 2; return 'summary' } })
    expect(request.messages[0].text).toBe('第 81 页是什么？')
    expect(request.reading?.notice).toContain('已变化')
    expect(request.reading?.sources).toEqual([])
  })
})
