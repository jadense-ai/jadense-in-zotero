/** 从真实版本选择器切换解析记录，验证三个正文页与参考文献任务始终对应。 */
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { mountDocumentResults } from './document-results'
import { initializeUiLocale } from './ui-preferences'

const fixture = vi.hoisted(() => {
  const source = { itemID: 42, libraryID: 1, itemKey: 'PDF42', title: 'Paper', authors: [] }
  const records = ['older', 'newer'].map((id, index) => ({
    id, source, createdAt: `2026-11-0${index + 1}T00:00:00Z`, summary: `${id} summary`, notes: `${id} notes`, referenceTaskID: `ref-${id}`,
  }))
  const tasks = records.map(record => ({
    id: record.referenceTaskID, kind: 'references', createdAt: record.createdAt, source, status: 'complete', warnings: [`${record.id} bibliography`],
  }))
  return { source, records, tasks }
})
vi.mock('./document-jobs', () => ({ documentJobs: () => ({
  ready: Promise.resolve(), list: () => fixture.tasks, get: (id: string) => fixture.tasks.find(task => task.id === id),
  referencePhase: () => undefined, subscribe: () => () => {}, store: { references: async () => [] },
}) }))
vi.mock('./analysis-runtime', () => ({ analysisRuntime: () => ({ records: () => fixture.records, unsaved: () => false, subscribe: () => () => {}, get: () => undefined }) }))

it('keeps the chosen summary, notes and linked references after navigation and a live update', async () => {
  initializeUiLocale({ locale: 'en-US' })
  const dom = new JSDOM('<!doctype html><main></main>'), root = dom.window.document.querySelector('main')!
  const view = mountDocumentResults(root, {}, fixture.source, 'analysis', { analysisTab: 'summary', hideAnalysisTabs: true })
  try {
    await vi.waitFor(() => expect(root.querySelector('.jdx-analysis-summary')?.textContent).toContain('newer summary'))
    root.querySelector<HTMLButtonElement>('.jdx-result-version .jdx-select-trigger')!.click()
    dom.window.document.querySelectorAll<HTMLElement>('.jdx-select-portal .jdx-select-option')[1]!.click()
    expect(view.selectedRecordID()).toBe('older')
    view.setAnalysisTab('notes')
    expect(root.querySelector('.jdx-analysis-notes-text')?.textContent).toContain('older notes')
    view.setRun({ source: fixture.source, busy: true, message: 'Only for the new run', createdAt: fixture.records[1].createdAt, referenceTaskID: fixture.tasks[1].id })
    view.setAnalysisTab('references')
    const refs = root.querySelector('.jdx-reference-details')!
    expect(refs.closest('[hidden]')).toBeNull()
    await vi.waitFor(() => expect(refs.textContent).toContain('older bibliography'))
    expect(refs.textContent).not.toContain('newer bibliography')
    view.setAnalysisTab('summary')
    expect(root.querySelector('.jdx-analysis-summary')?.textContent).toContain('older summary')
    expect(root.textContent).not.toContain('Only for the new run')
  } finally { view.remove(); dom.window.close() }
})

it('identifies attachment-level references for an older version with no saved task link', async () => {
  initializeUiLocale({ locale: 'en-US' })
  const dom = new JSDOM('<!doctype html><main></main>'), root = dom.window.document.querySelector('main')!
  const records = fixture.records.map(record => ({ ...record, referenceTaskID: record.id === 'older' ? undefined : record.referenceTaskID }))
  const view = mountDocumentResults(root, {}, fixture.source, 'analysis', { analysisTab: 'references', recordID: 'older', hideAnalysisTabs: true,
    analysis: { records: () => records, unsaved: () => false, openSource: async () => true, stop() {}, onReferenceTask() {} },
  })
  try {
    await vi.waitFor(() => expect(root.querySelector('.jdx-reference-details')?.textContent).toContain('newer bibliography'))
    expect(root.querySelector(':scope > .jdx-notice')?.textContent).toContain('for this attachment')
    view.setAnalysisTab('notes')
    expect(root.querySelector(':scope > .jdx-notice')?.textContent).toBe('')
    expect(root.querySelector('.jdx-analysis-notes-text')?.textContent).toContain('older notes')
  } finally { view.remove(); dom.window.close() }
})
