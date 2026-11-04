/** 实际原文投影、历史与安全 Markdown 的证据链回归。 */
import { describe, expect, it, vi } from 'vitest'
import { normalizeChatEvidence, usedChatEvidence, withoutEvidenceMarkers, type ChatEvidence } from './evidence'
import { buildLongDocumentContext } from './long-document-context'
import { renderChatMarkdown } from './markdown'
import { appendLocalChatMessage, createLocalChatSession, readLocalChatState, removeLocalChatSource, updateLocalChatMessage } from './local-chat-store'
import type { ChatDocument } from '@/zotero/chat-documents'

const source = { itemID: 2, libraryID: 7, itemKey: 'PDF2', title: 'Synthetic paper', modificationTime: 12 }
const evidence: ChatEvidence = { entries: [{ id: 's1b1', sourceNumber: 1, source, pageIndex: 2, pageLabel: 'iii', quote: 'The effect was 20%.', rects: [[10, 20, 300, 40]] }] }
const document = (id = 2): ChatDocument => ({ source: { ...source, itemID: id, itemKey: `PDF${id}`, id: `pdf-${id}`, kind: 'file', citation: '', text: '' },
  state: { version: 1, id: `cache-${id}`, source: { ...source, itemID: id, itemKey: `PDF${id}` }, extractionVersion: 1, totalPages: 2, pageIndexes: [0, 1], complete: true, summaries: {} },
  pages: [0, 1].map(pageIndex => ({ pageIndex, pageLabel: pageIndex ? 'iii' : 'ii', lines: [], paragraphs: [0, 1].map(p => ({
    id: `p${pageIndex}-${p}`, pageIndex, pageLabel: pageIndex ? 'iii' : 'ii', lineIDs: [], rects: [[10, 20 + p * 30, 300, 40 + p * 30]], text: `Original ${id}-${pageIndex}-${p}. The effect was 20%.` })) })) })

describe('chat evidence', () => {
  it('anchors one passage per citation and sends no local identity or rectangles to the model', async () => {
    const generate = vi.fn(async () => 'summary')
    const result = await buildLongDocumentContext({ documents: [document(), document(3)], sourceNumbers: [1, 4], question: 'Effect?', recent: '', budget: 9000, modelKey: 'test', evidenceEnabled: true,
      signal: new AbortController().signal, progress() {}, save: async () => {}, generate })
    expect(result.evidence?.entries).toHaveLength(8)
    expect(result.evidence?.entries[0]).toMatchObject({ id: 's1b1', quote: 'Original 2-0-0. The effect was 20%.', pageIndex: 0, pageLabel: 'ii', rects: [[10, 20, 300, 40]] })
    expect(result.evidence?.entries[4]).toMatchObject({ sourceNumber: 4, source: { itemID: 3 } })
    expect(result.context).toContain('[[evidence:段落id]]')
    expect(result.context).not.toMatch(/"(?:itemID|libraryID|itemKey|rects)"/u)
    expect(generate).not.toHaveBeenCalled()
  })
  it('only indexes raw passages actually included in a budgeted request, even with summaries', async () => {
    const doc = document()
    doc.pages[0].paragraphs[0].text = 'Large source text. '.repeat(4000)
    const result = await buildLongDocumentContext({ documents: [doc], sourceNumbers: [1], question: 'Original 2-1-1', recent: '', budget: 2500, mode: 'summarize', modelKey: 'test', evidenceEnabled: true,
      signal: new AbortController().signal, progress() {}, save: async () => {}, generate: async () => 'Summary only.' })
    const raw = JSON.parse(result.context.split('本轮原文：')[1]) as Array<{ id: string; text: string }>
    expect(result.evidence?.entries.length).toBeGreaterThan(0)
    expect(result.evidence?.entries.map(entry => entry.id)).toEqual(raw.map(row => row.id))
    for (const entry of result.evidence!.entries) expect(raw.find(row => row.id === entry.id)?.text).toContain(entry.quote)
    expect(result.evidence?.entries.some(entry => entry.quote.includes('Summary only'))).toBe(false)
  })
  it('ignores unknown fields and drops invalid optional positions without losing the message', () => {
    expect(normalizeChatEvidence({ extra: true, entries: [{ ...evidence.entries[0], extra: true, source: { ...source, url: 'file:///secret' }, rects: [[0, 0, -1, 9], ['1', 2, 3, 4]] }, { id: 'bad' }] }))
      .toEqual({ entries: [{ ...evidence.entries[0], rects: [] }] })
    expect(normalizeChatEvidence(null)).toBeUndefined()
    expect(normalizeChatEvidence({ entries: [evidence.entries[0], evidence.entries[0]] })?.entries).toHaveLength(1)
  })
  it('keeps saved citations independent of current source order and association', () => {
    const values = new Map<string, unknown>(), prefs = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value) }, clear: (key: string) => { values.delete(key) } }
    const session = createLocalChatSession(prefs)
    appendLocalChatMessage(prefs, session.id, { id: 'answer', role: 'assistant', text: 'Effect [[evidence:s1b1]]', createdAt: new Date().toISOString() })
    updateLocalChatMessage(prefs, session.id, 'answer', { evidence })
    removeLocalChatSource(prefs, session.id, 'pdf-2')
    expect(readLocalChatState(prefs).sessions[0].messages[0].evidence).toEqual(evidence)
    expect(usedChatEvidence(evidence, 'Effect [[evidence:s1b1]] [[evidence:s999b1]]')).toEqual(evidence)
    expect(withoutEvidenceMarkers('Effect [[evidence:s1b1]]')).toBe('Effect ')
  })
  it('renders only message-owned IDs and leaves code, HTML, nested links and user text inert', () => {
    const html = renderChatMarkdown('Effect [[evidence:s1b1]] and [[evidence:s999b1]]', undefined, evidence)
    expect(html).toContain('data-evidence-id="s1b1"')
    expect(html).toContain('来源不可用')
    expect(html).not.toContain('data-evidence-id="s999b1"')
    expect(renderChatMarkdown('[[evidence:s1b1]]')).not.toContain('data-evidence-id')
    for (const text of ['`[[evidence:s1b1]]`', '```\n[[evidence:s1b1]]\n```', '[go [[evidence:s1b1]]](https://example.com)']) {
      expect(renderChatMarkdown(text, undefined, evidence)).not.toContain('data-evidence-id')
    }
    expect(renderChatMarkdown('Effect [[evidence:s1', undefined, evidence)).not.toContain('[[evidence:')
    expect(renderChatMarkdown('[[evidence:<img src=x onerror=alert(1)>]]', undefined, evidence)).not.toContain('<img')
    expect(renderChatMarkdown('[unsafe](zotero://open-pdf/library/items/OTHER)', undefined, evidence)).not.toContain('href=')
  })
})
