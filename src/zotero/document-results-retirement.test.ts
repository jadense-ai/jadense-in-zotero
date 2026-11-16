/** 停用独立全文提取后，旧 Markdown 仍可阅读和复制，浏览历史不再启动提取或 OCR。 */
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { mountDocumentResults } from './document-results'
import { initializeUiLocale } from './ui-preferences'

const fixture = vi.hoisted(() => {
  const source = { itemID: 42, libraryID: 1, itemKey: 'PDF42', title: 'Saved paper', authors: [] }
  const task = { id: 'old-source', kind: 'extraction', source, createdAt: '2026-11-15T00:00:00Z', status: 'complete', warnings: [] }
  return { source, task, start: vi.fn(), ocr: vi.fn(), copy: vi.fn(async () => true) }
})
vi.mock('./document-jobs', () => ({ documentJobs: () => ({
  ready: Promise.resolve(), list: () => [fixture.task], get: () => fixture.task, start: fixture.start,
  subscribe: () => () => {}, store: { extraction: async () => ({ markdown: '# 已有全文\n\n历史正文保留。', assets: [] }), assets: async () => ({}) },
}) }))
vi.mock('./cloud-ocr', () => ({ checkOCREngine: fixture.ocr }))
vi.mock('./connection-display', () => ({ copyTextToClipboard: fixture.copy }))

it('reads and copies saved Markdown without extraction controls or OCR checks', async () => {
  initializeUiLocale({ locale: 'zh-CN' })
  const dom = new JSDOM('<!doctype html><main></main>'), root = dom.window.document.querySelector('main')!
  const view = mountDocumentResults(root, {}, fixture.source, 'source')
  try {
    await vi.waitFor(() => expect(root.textContent).toContain('历史正文保留。'))
    expect(root.textContent).toContain('全文提取已停用')
    expect(root.querySelector('.jdx-result-extract, .jdx-translation-capsule')).toBeNull()
    const copy = [...root.querySelectorAll('button')].find(button => button.textContent === '复制 Markdown')!
    copy.click()
    await vi.waitFor(() => expect(fixture.copy).toHaveBeenCalledWith({}, '# 已有全文\n\n历史正文保留。'))
    expect(fixture.start).not.toHaveBeenCalled()
    expect(fixture.ocr).not.toHaveBeenCalled()
  } finally { view.remove(); dom.window.close() }
})
