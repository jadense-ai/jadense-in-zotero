// @vitest-environment jsdom
/** 原生阅读器恢复按钮接缝：历史仅展示，明确重译才创建新任务，未知 BYOK 请求保留确认。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openPDFTranslation, stopPDFTranslationReaders } from './pdf-translation-reader'
import { initializeUiLocale } from './ui-preferences'
import { pdfTranslationStatusView } from './pdf-translation-status'
import type { PDFTranslationTask } from './pdf-translation-jobs'
import type { ZoteroLike } from './runtime'

const jobs = vi.hoisted(() => ({
  get: vi.fn(), openOrStart: vi.fn(), start: vi.fn(), retry: vi.fn(),
  hasOutput: vi.fn(() => true), isActive: vi.fn(() => false),
  subscribe: vi.fn(() => () => {}), speed: vi.fn(), bytes: vi.fn(), export: vi.fn(),
}))
vi.mock('./pdf-translation-jobs', () => ({ pdfTranslationJobs: () => jobs }))
vi.mock('./translation-budget-settings', () => ({ wireReadingBudgetSettings: () => () => {} }))

const legacyErrors = [
  '原 PDF 或翻译配置已变化，请重新点击翻译按钮。',
  'The PDF or translation settings changed. Click Translate again.',
]
const task = (overrides: Partial<PDFTranslationTask> = {}) => ({
  id: 'old-task', source: { itemID: 1 }, mode: 'concise', status: 'error', stage: 'error', percent: 0, pages: 9, skipped: [],
  coverage: { total: 151, translated: 0, failed: 151, preserved: 1, failedPages: [0, 1] }, ...overrides,
}) as PDFTranslationTask

/** 使用真实 Reader 挂载及按钮事件，仅替换 PDF.js 宿主和任务执行器。 */
async function mount(saved: PDFTranslationTask) {
  document.body.innerHTML = '<div><iframe id="original"></iframe></div>'
  const original = document.querySelector<HTMLIFrameElement>('#original')!
  const nativeWindow = original.contentWindow!
  Object.assign(nativeWindow, { PDFViewerApplication: { pdfViewer: {
    pagesCount: 9, currentPageNumber: 1, currentScale: 1, currentScaleValue: 'page-width', pagesRotation: 0,
    container: document.createElement('div'), getPageView: () => ({ div: document.createElement('div') }),
    eventBus: { on() {}, off() {} },
  } } })
  const reader = { itemID: 1, _internalReader: { _primaryView: { _iframeWindow: nativeWindow } } }
  const host = { Prefs: { get: () => undefined }, getMainWindow: () => window } as unknown as ZoteroLike
  jobs.get.mockReturnValue(saved); jobs.openOrStart.mockResolvedValue(saved)
  jobs.start.mockResolvedValue(task({ id: 'fresh-task', status: 'complete', error: undefined }))
  await openPDFTranslation(host, reader, 'compare', saved.id)
  return (name: string) => document.querySelector<HTMLButtonElement>(`[data-pdf-control="${name}"]`)!
}

beforeEach(() => {
  vi.clearAllMocks()
  initializeUiLocale({ locale: 'zh-CN' })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { stopPDFTranslationReaders(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('PDF translation recovery actions', () => {
  it.each(legacyErrors)('replaces the legacy loop with an explicit fresh action: %s', async error => {
    const saved = task({ error }), control = await mount(saved)
    expect(jobs.start).not.toHaveBeenCalled(); expect(jobs.retry).not.toHaveBeenCalled()
    expect(control('task-action').textContent).toBe('按当前设置重新翻译')
    expect(control('task-action').getAttribute('aria-label')).toBe('按当前设置重新翻译')
    expect(control('retry').hidden).toBe(false)
    expect(document.querySelector('.jdx-pdf-status-content')?.textContent).not.toContain('请重新点击翻译按钮')
    expect(document.querySelector('.jdx-pdf-status-content')?.textContent).not.toContain('Click Translate again.')
    control('task-action').click()
    await vi.waitFor(() => expect(jobs.start).toHaveBeenCalledWith(1, 'concise', true))
    expect(jobs.retry).not.toHaveBeenCalled()
    expect(saved.error).toBe(error)
  })

  it.each(['configuration', 'source'] as const)('uses the classified %s reason for explicit fresh translation', async blockedReason => {
    const control = await mount(task({ blockedReason, error: 'classified local failure' }))
    expect(control('retry').textContent).toBe('按当前设置重新翻译')
    control('retry').click()
    await vi.waitFor(() => expect(jobs.start).toHaveBeenCalledWith(1, 'concise', true))
    expect(jobs.retry).not.toHaveBeenCalled()
  })

  it('keeps ordinary partial-output errors on the original task', async () => {
    const control = await mount(task({ error: 'network unavailable' }))
    expect(control('task-action').textContent).toBe('补译')
    control('task-action').click()
    expect(jobs.retry).toHaveBeenCalledWith('old-task')
    expect(jobs.start).not.toHaveBeenCalled()
  })

  it.each(['task-action', 'retry', 'regenerate'])('requires the existing BYOK confirmation before %s creates a fresh task', async name => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const control = await mount(task({ error: legacyErrors[0], unconfirmed: true }))
    control(name).click()
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0]).toContain('重复计费')
    expect(jobs.start).not.toHaveBeenCalled(); expect(jobs.retry).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    control(name).click()
    await vi.waitFor(() => expect(jobs.start).toHaveBeenCalledWith(1, 'concise', true))
    expect(jobs.retry).not.toHaveBeenCalled()
  })

  it('keeps completed history read-only and uses Save as the main action', async () => {
    const control = await mount(task({ status: 'complete', coverage: { total: 0, translated: 0, failed: 0, preserved: 1, failedPages: [] } }))
    expect(control('task-action').textContent).toBe('保存译文')
    expect(control('retry').hidden).toBe(true)
    expect(jobs.start).not.toHaveBeenCalled(); expect(jobs.retry).not.toHaveBeenCalled(); expect(jobs.openOrStart).not.toHaveBeenCalled()
  })

  it('does not infer a new task from arbitrary error text or stale errors on a completed task', async () => {
    const control = await mount(task({ error: legacyErrors[0] + ' unrelated extra text' }))
    control('task-action').click()
    expect(jobs.retry).toHaveBeenCalledWith('old-task'); expect(jobs.start).not.toHaveBeenCalled()
    const view = pdfTranslationStatusView({ task: task({ status: 'complete', error: legacyErrors[0] }), hasOutput: true })
    expect(view.label).not.toContain('按当前设置重新翻译')
  })

  it('shows accurate recovery instructions in the active locale for old saved errors', () => {
    initializeUiLocale({ locale: 'en-US' })
    const view = pdfTranslationStatusView({ task: task({ error: legacyErrors[0] }), hasOutput: true })
    expect(view.label).toContain('Translate again with current settings')
    expect(view.lines.join('\n')).toContain('0 translated')
    expect(view.details).not.toContain(legacyErrors[0])
  })

  it.each(['interrupted', 'cancelled', 'partial'] as const)('keeps the fresh-task instructions for %s invalidated results', status => {
    const view = pdfTranslationStatusView({ task: task({ status, error: legacyErrors[0] }), hasOutput: true })
    expect(view.label).toContain('按当前设置重新翻译')
    expect(view.lines.join('\n')).not.toMatch(/点击重试|可继续补译/u)
    expect(view.lines.join('\n')).toContain('未译 151 段')
  })
})
