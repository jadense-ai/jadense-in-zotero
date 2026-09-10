/** 批处理测试覆盖完整来源、预算边界和坏项局部回退。 */
import { describe, it, expect } from 'vitest'
import { referenceBatches, referencePrompt, referenceTokens, applyReferenceBatch } from './reference-batches'
import type { ReferenceEntry } from './reference-list'
function entry(id: string): ReferenceEntry { return { id, order: 0, raw: `${id} Example title`, lines: [{ id, text: `${id} Example title`, pageIndex: 0, pageLabel: '1', rects: [] }], fields: { title: '', authors: [], year: '' }, uncertain: true, verification: 'pending' } }
describe('reference batches', () => {
  it('batches many complete sources, keeps a singleton tail and excludes protected entries', () => {
    const entries = Array.from({ length: 17 }, (_, i) => entry(String(i)))
    expect(referenceBatches([...entries, { ...entry('verified'), verification: 'verified' }], 4000).batches.map(batch => batch.length)).toEqual([16, 1])
  })
  it('counts prompt overhead and skips oversized whole sources', () => {
    const source = entry('one'), budget = referenceTokens(referencePrompt([source]))
    expect(referenceBatches([source], budget).batches).toHaveLength(1)
    expect(referenceBatches([source], budget - 1).oversized).toEqual(['one'])
  })
  it('accepts a supported field and contains missing, conflicting and invented responses', () => {
    const a = entry('a'), b = entry('b'), c = entry('c')
    const result = applyReferenceBatch([a, b, c], { extra: true, items: [
      { id: 'a', references: [{ startLine: 0, endLine: 0, title: 'Example title', extra: true }] },
      { id: 'b', references: [{ startLine: 0, endLine: 0, title: 'Invented' }] },
      { id: 'c', references: [] }, { id: 'c', references: [] },
    ] })
    expect(result[0].fields.title).toBe('Example title'); expect(result[1].fields.title).toBe(''); expect(result[2]).toBe(c)
    expect(result.map(row => row.raw)).toEqual([a.raw, b.raw, c.raw])
  })
})
