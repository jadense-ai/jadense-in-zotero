/** 父文献聚合的身份与兼容回归：正文保留在原存储，未知字段不能阻断读取。 */
import { describe, expect, it } from 'vitest'
import { literaturePapers } from './analysis-workspace-model'
import type { ZoteroLike } from './runtime'
import type { DocumentTask } from './document-store'
import type { TranslationRecord } from '@/chat/translation-history'
import { readLiteratureIdentity } from './document-identity'

const parent = (id: number, libraryID = 1) => ({ id, key: `P${id}`, libraryID, getField: () => 'Same title' })
const attachment = (id: number, parentItem = parent(10)) => ({ id, key: `A${id}`, libraryID: parentItem.libraryID, parentItem, getField: () => 'PDF' })
function fixtures() {
  const items = [attachment(1), attachment(2), attachment(3, parent(20)), attachment(4, parent(10, 2))]
  const host = { Items: { get: (id: number) => items.find(item => item.id === id) } } as unknown as ZoteroLike
  const tasks: DocumentTask[] = items.map((item, index) => ({ version: 1, id: `task${index}`, kind: 'extraction', source: { itemID: item.id, itemKey: item.key, libraryID: item.libraryID, title: 'Same title' }, createdAt: `2026-09-12T00:00:0${index}Z`, status: 'complete', totalPages: 1, total: 1, completed: 1, warnings: [], models: [] }))
  return { host, tasks }
}
describe('literature result projection', () => {
  it('groups two PDFs by verified parent, separates same-title papers and libraries', () => {
    const { host, tasks } = fixtures(), papers = literaturePapers(host, [], tasks, [])
    expect(papers).toHaveLength(3); expect(papers.find(paper => paper.attachments.length === 2)?.results).toHaveLength(2)
  })
  it('includes a paper with only selection translation and preserves its original record', () => {
    const { host, tasks } = fixtures()
    const record: TranslationRecord = { id: 'selection', createdAt: tasks[0].createdAt, source: { ...tasks[0].source, text: 'Original text' }, result: { text: '译文', sourceLanguage: 'en', targetLanguage: 'zh-CN' } }
    const papers = literaturePapers(host, [], [], [record])
    expect(papers).toHaveLength(1); expect(papers[0].results[0].selection).toBe(record); expect(papers[0].results[0].mode).toBe('selection')
  })
  it('keeps source, translations, selections and analysis in the same paper with attachment identities intact', () => {
    const { host, tasks } = fixtures()
    const analysis = { id: 'a', createdAt: '2026-09-13', source: { ...tasks[0].source, authors: [] }, summary: 'Summary' }
    const translation = { ...tasks[1], id: 't', kind: 'translation' as const, extractionID: tasks[1].id }
    const papers = literaturePapers(host, [analysis], [tasks[0], tasks[1], translation], [])
    expect(papers).toHaveLength(1); expect(papers[0].results).toHaveLength(4); expect(papers[0].source.itemID).toBe(1)
    expect(papers[0].results.find(row => row.id === 't')?.source.itemID).toBe(2)
  })
  it('does not trust reused item IDs or group legacy records by title', () => {
    const { host, tasks } = fixtures()
    tasks[0].source.itemKey = 'OLDKEY'
    const papers = literaturePapers(host, [], tasks.slice(0, 2), [])
    expect(papers).toHaveLength(2)
  })
  it('retains a saved parent snapshot after an attachment disappears', () => {
    const { tasks } = fixtures(), host = { Items: { get: () => undefined } } as unknown as ZoteroLike
    for (const task of tasks.slice(0, 2)) task.source.literature = { itemID: 10, itemKey: 'P10', libraryID: 1, title: 'Saved title' }
    const papers = literaturePapers(host, [], tasks.slice(0, 2), [])
    expect(papers).toHaveLength(1); expect(papers[0].title).toBe('Saved title')
  })
  it('keeps standalone attachments and missing-identity histories readable', () => {
    const host = { Items: { get: () => undefined } } as unknown as ZoteroLike
    const record: TranslationRecord = { id: 'old', createdAt: '', source: { itemID: 1, title: 'Same title', text: 'old' }, result: { text: 'text', sourceLanguage: 'en', targetLanguage: 'zh' } }
    const papers = literaturePapers(host, [], [], [record, { ...record, id: 'older' }])
    expect(papers).toHaveLength(2); expect(papers.every(paper => paper.results.length === 1)).toBe(true)
  })
  it('contains malformed optional snapshots and accepts additive fields', () => {
    expect(readLiteratureIdentity({ itemID: 1 })).toBeUndefined()
    expect(readLiteratureIdentity({ itemID: 1, libraryID: 1, itemKey: 'P1', title: 'Title', future: true })).toEqual({ itemID: 1, libraryID: 1, itemKey: 'P1', title: 'Title' })
  })
})
