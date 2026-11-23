/** 真实 Manager 成果入口：多附件的历史跳转、搜索空态与单个来源的重试，均不启动任务。 */
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { mountLiteratureWorkspace } from './literature-workspace'
import { initializeUiLocale } from './ui-preferences'
import type { ZoteroLike } from './runtime'
import type { PDFTranslationTask } from './pdf-translation-jobs'

const data = vi.hoisted(() => {
  const literature = { itemID: 1, libraryID: 2, itemKey: 'PAPER', title: 'Research paper' }
  const attachment = { itemID: 3, libraryID: 2, itemKey: 'ATTACH', title: 'Attachment A', authors: [], literature }
  const second = { ...attachment, itemID: 4, itemKey: 'OTHER', title: 'Attachment B' }
  const markdown = { id: 'legacy', kind: 'extraction', status: 'complete', source: second, createdAt: '2026-11-20', warnings: [] }
  const reading = { id: 'reading-older', source: attachment, createdAt: '2026-11-10', languages: { targetLanguage: 'en' }, outputs: { first: 'text' }, total: 2, status: 'partial' }
  const simple = [reading, { ...reading, id: 'reading-newer', createdAt: '2026-11-15' }]
  return { attachment, second, markdown, simple, open: vi.fn(async () => {}), readPDFs: vi.fn(async () => {}), readSimple: vi.fn(async () => {}),
    listPDFs: vi.fn<() => PDFTranslationTask[]>(() => []), exportPDF: vi.fn(async () => {}), retryPDF: vi.fn() }
})
vi.mock('./document-jobs', () => ({ documentJobs: () => ({
  ready: Promise.resolve(), list: (kind?: string) => !kind || kind === 'extraction' ? [data.markdown] : [], get: () => data.markdown,
  subscribe: () => () => {}, store: { extraction: async () => ({ markdown: 'Original text from B', assets: [] }), assets: async () => ({}) },
}) }))
vi.mock('./simple-reading-jobs', () => ({ simpleReadingJobs: () => ({ list: () => data.simple, load: data.readSimple, subscribe: () => () => {} }) }))
vi.mock('./pdf-translation-jobs', () => ({ pdfTranslationJobs: () => ({ list: data.listPDFs, loadHistory: data.readPDFs, subscribe: () => () => {},
  hasOutput: () => true, isActive: () => false, export: data.exportPDF, retry: data.retryPDF }) }))
vi.mock('./simple-reading', () => ({ openSavedSimpleReading: data.open }))

function mount(host: ZoteroLike = {}) {
  initializeUiLocale({ locale: 'en-US' })
  const dom = new JSDOM('<!doctype html><section class="jdx-analysis-section"><main></main></section>')
  const root = dom.window.document.querySelector('main')!
  const view = mountLiteratureWorkspace(root, host, { records: () => [], unsaved: () => false, openSource: async () => true, stop() {}, onReferenceTask() {} })
  return { root, dom, view, close() { view.remove(); dom.window.close() } }
}
afterEach(() => { vi.clearAllMocks(); data.listPDFs.mockImplementation(() => []) })

it('groups both PDF exports, dispatches the chosen format only, and keeps translation recovery beside its status', async () => {
  data.listPDFs.mockReturnValue([{ id: 'partial-pdf', version: 1, engine: 'fixture', configuration: '', source: data.attachment, fingerprint: 'fixture',
    languages: { sourceLanguage: 'en', targetLanguage: 'fr' }, pages: 2, skipped: [], status: 'partial', stage: 'complete', percent: 50 }])
  const app = mount()
  try {
    app.view.open(data.attachment, 'files', 'partial-pdf')
    const row = app.root.querySelector<HTMLElement>('[data-pdf-task-id="partial-pdf"]')!
    expect(row.querySelector('.jdx-button-primary')?.textContent).toBe('Open bilingual PDF')
    expect(row.querySelector('.jdx-literature-event-heading button')?.textContent).toBe('Translate remaining passages')
    const exports = row.querySelector('details')!
    expect(exports.open).toBe(false)
    exports.querySelector('summary')!.click()
    const formats = [...exports.querySelectorAll('button')]
    expect(formats.map(button => button.textContent)).toEqual(['Export translated PDF', 'Export bilingual PDF'])
    formats[1].click()
    expect(data.exportPDF).toHaveBeenCalledOnce()
    expect(data.exportPDF.mock.calls[0].slice(0, 2)).toEqual(['partial-pdf', 'dual'])
    expect(data.retryPDF).not.toHaveBeenCalled()
  } finally { app.close() }
})

it('keeps other papers during a selection-index failure and shows saved page and language in the collapsed translation', async () => {
  const record = { id: 'selected', createdAt: '2026-11-01', source: { ...data.attachment, text: 'Review this source', pageLabel: 'iv' }, result: { text: 'Traduction', targetLanguage: 'fr' } }
  let readable = false
  const app = mount({ Prefs: { get() { if (!readable) throw new Error('Not ready'); return JSON.stringify({ records: [record] }) }, set() {}, clear() {} } })
  try {
    await vi.waitFor(() => expect(app.root.querySelector('.jdx-literature-load-warning')?.textContent).toContain('Selection translations'))
    expect(app.root.querySelector('.jdx-analysis-title')?.textContent).toBe('Research paper')
    readable = true
    app.root.querySelector<HTMLButtonElement>('.jdx-literature-load-warning button')!.click()
    app.view.open(data.attachment, 'selection')
    await vi.waitFor(() => expect(app.root.querySelector('.jdx-selection-toggle')).not.toBeNull())
    const row = app.root.querySelector<HTMLButtonElement>('.jdx-selection-toggle')!
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.firstElementChild?.textContent).toBe('Review this source')
    expect(row.querySelector('.jdx-selection-meta')?.textContent).toContain('Page ivFrench')
    expect(row.querySelector('.jdx-selection-meta')?.lastElementChild?.tagName).toBe('TIME')
    row.click()
    expect(app.dom.window.document.getElementById(row.getAttribute('aria-controls')!)?.textContent).toContain('Traduction')
  } finally { app.close() }
})

it('distinguishes a search miss, restores its field, and retries just the missing source while existing results stay readable', async () => {
  data.readPDFs.mockRejectedValueOnce(new Error('Offline'))
  const app = mount()
  try {
    await vi.waitFor(() => expect(app.root.querySelector('.jdx-literature-load-warning')).not.toBeNull())
    expect(app.root.querySelector('.jdx-analysis-title')?.textContent).toBe('Research paper')
    const search = app.root.querySelector<HTMLInputElement>('input[type=search]')!
    search.value = 'non-matching'
    search.dispatchEvent(new app.dom.window.Event('input'))
    const empty = app.root.querySelector<HTMLElement>('.jdx-analysis-list .jdx-result-empty')!
    expect(empty.hidden).toBe(false)
    expect(empty.textContent).toContain('non-matching')
    empty.querySelector('button')!.click()
    expect(search.value).toBe('')
    expect(app.dom.window.document.activeElement).toBe(search)
    app.root.querySelector<HTMLButtonElement>('.jdx-literature-load-warning button')!.click()
    await vi.waitFor(() => expect(app.root.querySelector('.jdx-literature-load-warning')).toBeNull())
    expect(data.readPDFs).toHaveBeenCalledTimes(2)
    expect(data.readSimple).toHaveBeenCalledTimes(1)
  } finally { app.close() }
})

it('opens an older reading version in one click and returns from legacy Markdown to its history row with History selected', async () => {
  const app = mount()
  try {
    app.view.open(data.attachment, 'history')
    expect(app.root.querySelectorAll('[role=tab]')).toHaveLength(8)
    app.root.querySelector<HTMLButtonElement>('[data-history-record="reading-older"]')!.click()
    expect(data.open).toHaveBeenCalledTimes(1)
    expect(data.open).toHaveBeenCalledWith({}, expect.objectContaining({ itemID: data.attachment.itemID }), 'reading-older')
    app.root.querySelector<HTMLButtonElement>('[data-history-record="legacy"]')!.click()
    const tab = app.root.querySelector('[role=tab][aria-selected=true]')!
    expect(tab.textContent).toBe('History')
    const panel = app.dom.window.document.getElementById(tab.getAttribute('aria-controls')!)!
    await vi.waitFor(() => expect(panel.textContent).toContain('Original text from B'))
    panel.querySelector<HTMLButtonElement>('.jdx-history-return')!.click()
    const origin = app.dom.window.document.activeElement
    expect(origin?.getAttribute('data-history-record')).toBe('legacy')
    expect(origin?.closest('[hidden]')).toBeNull()
    expect(data.open).toHaveBeenCalledTimes(1)
  } finally { app.close() }
})
