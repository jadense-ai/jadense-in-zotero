/** 分层阅读契约：尾页召回、全文覆盖、输入预算与稳定中间请求。 */
import { describe, expect, it, vi } from 'vitest'
import { buildLongDocumentContext, documentChunks, documentTokenCost, type LongDocumentInput } from './long-document-context'
import type { ChatDocument } from '@/zotero/chat-documents'
import { ByokResponseError } from './byok-chat'

function fixture(count = 81, budget = 7000) {
  const source = { itemID: 2, libraryID: 7, itemKey: 'PDF2', title: 'Long paper', modificationTime: 1 }
  const document: ChatDocument = { source: { ...source, id: 'pdf', kind: 'file', citation: '', text: '' },
    state: { version: 1, id: crypto.randomUUID(), source, extractionVersion: 1, totalPages: count, pageIndexes: Array.from({ length: count }, (_, i) => i), complete: true, summaries: {} },
    pages: Array.from({ length: count }, (_, i) => ({ pageIndex: i, pageLabel: String(i + 1), lines: [], paragraphs: [{ id: `p${i}`, pageIndex: i, pageLabel: String(i + 1), rects: [], lineIDs: [], text: i === count - 1 ? 'TAIL_UNIQUE_FACT = 7391. Appendix conclusion.' : `page-${i + 1}: ` + 'Ordinary method and evidence. '.repeat(70) }] })) }
  const generate = vi.fn(async (prompt: string, _requestId: string, _conversationId: string) => {
    if (prompt.includes('只返回 JSON')) return '{"all":false,"ids":["evil-id"]}'
    return '概括 [来源 1，第 81 页]：方法与限制。'
  })
  const input: LongDocumentInput = { documents: [document], sourceNumbers: [1], question: `第 ${count} 页的 TAIL_UNIQUE_FACT 是多少？`, recent: '', budget,
    modelKey: 'synthetic-model', signal: new AbortController().signal, progress: vi.fn(), save: vi.fn(async () => {}), generate }
  return { document, input, generate }
}

describe('long PDF context', () => {
  it('sends full text directly when it fits without any intermediate model call', async () => {
    const f = fixture(26, 100000)
    const result = await buildLongDocumentContext(f.input)
    expect(result.context).toContain('TAIL_UNIQUE_FACT = 7391')
    expect(result.reading.sources[0].pages).toHaveLength(26)
    expect(f.generate).not.toHaveBeenCalled()
  })
  it.each([26, 81, 300])('finds the last-page fact in %i pages within the request budget', async count => {
    const f = fixture(count), result = await buildLongDocumentContext(f.input)
    expect(result.context).toContain('TAIL_UNIQUE_FACT = 7391')
    expect(result.reading.sources[0].pages).toContainEqual({ pageIndex: count - 1, pageLabel: String(count) })
    expect(documentTokenCost(result.context)).toBeLessThanOrEqual(f.input.budget)
    const before = f.generate.mock.calls.length
    await buildLongDocumentContext(f.input)
    expect(f.generate).toHaveBeenCalledTimes(before)
  })
  it('processes every chunk including the appendix for a comprehensive question', async () => {
    const f = fixture(81)
    f.input.question = '请全面审查研究方法及附录中的限制'
    const result = await buildLongDocumentContext(f.input)
    const prompts = f.generate.mock.calls.map(row => row[0])
    for (const chunk of documentChunks([f.document], [1])) expect(prompts.some(prompt => prompt.includes(JSON.stringify(chunk.text)))).toBe(true)
    expect(prompts.some(prompt => prompt.includes('TAIL_UNIQUE_FACT'))).toBe(true)
    expect(result.reading.notice).toContain('全部可读正文已分段整理')
    expect(documentTokenCost(result.context)).toBeLessThanOrEqual(f.input.budget)
  })
  it('contains optional generation failure and keeps tail-page raw evidence without claiming full coverage', async () => {
    const f = fixture(81)
    f.generate.mockRejectedValueOnce(new Error('network uncertain'))
    const first = await buildLongDocumentContext(f.input)
    expect(first.context).toContain('7391')
    expect(first.reading.notice).toContain('未完成')
    const firstID = f.generate.mock.calls[0][1]
    await buildLongDocumentContext(f.input)
    expect(f.generate.mock.calls[1][1]).toBe(firstID)
  })
  it('preserves every character when a paragraph exceeds one chunk', () => {
    const f = fixture(1), text = '科学 αβ test. '.repeat(9000)
    f.document.pages[0].paragraphs[0].text = text
    const chunks = documentChunks([f.document], [1], 1000)
    expect(chunks.map(chunk => chunk.text.replace(/^\[第 .*?\]\n/u, '')).join('')).toBe(text)
  })
  it('stops serial generation on cancellation and retains completed summaries', async () => {
    const f = fixture(81), controller = new AbortController()
    f.input.signal = controller.signal
    f.generate.mockImplementationOnce(async () => 'first completed')
    f.generate.mockImplementationOnce(async () => { controller.abort(); return 'late result' })
    await expect(buildLongDocumentContext(f.input)).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.generate).toHaveBeenCalledTimes(2)
    expect(Object.values(f.document.state.summaries).filter(row => row.text)).toHaveLength(1)
  })
  it('uses a new identity only after a definite rejection on a later user attempt', async () => {
    const f = fixture(26)
    f.generate.mockRejectedValueOnce(new ByokResponseError(429, 'rate limited'))
    await buildLongDocumentContext(f.input)
    const rejectedID = f.generate.mock.calls[0][1]
    await buildLongDocumentContext(f.input)
    expect(f.generate.mock.calls[1][1]).not.toBe(rejectedID)
    const before = f.generate.mock.calls.length
    f.input.modelKey = 'changed-model'
    await buildLongDocumentContext(f.input)
    expect(f.generate.mock.calls.length).toBeGreaterThan(before)
  })
  it('retains execution identities even if the optional document cache is rebuilt', async () => {
    const f = fixture(26)
    await buildLongDocumentContext(f.input)
    const [, firstRequest, firstConversation] = f.generate.mock.calls[0]
    f.document.state.summaries = {}; f.document.state.id = crypto.randomUUID()
    f.generate.mockClear()
    await buildLongDocumentContext(f.input)
    expect(f.generate.mock.calls[0].slice(1)).toEqual([firstRequest, firstConversation])
  })
})
