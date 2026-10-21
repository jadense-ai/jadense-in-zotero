// @vitest-environment jsdom
/** 真实 PDF 控制器接缝：缩放只改变阅读状态，不派发翻译；保留锚点及同步语义。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openPDFTranslation, stopPDFTranslationReaders, type PDFReadingState } from './pdf-translation-reader'
import { initializeUiLocale } from './ui-preferences'
import type { ZoteroLike } from './runtime'

const jobs = vi.hoisted(() => ({ get: vi.fn(), openOrStart: vi.fn(), start: vi.fn(), retry: vi.fn(), hasOutput: vi.fn(),
  isActive: () => false, subscribe: () => () => {}, bytes: async () => new Uint8Array([1]) }))
vi.mock('./pdf-translation-jobs', () => ({ pdfTranslationJobs: () => jobs }))
vi.mock('./translation-budget-settings', () => ({ wireReadingBudgetSettings: () => () => {} }))

/** 只替换内容 PDF.js API；挂载、输入、按钮和原生状态同步运行真实实现。 */
async function mount(linked = true, hasOutput = true) {
  document.body.innerHTML = '<div><iframe id="original"></iframe></div>'
  const original = document.querySelector<HTMLIFrameElement>('#original')!, nativeWindow = original.contentWindow!
  const events = new Map<string, () => void>(), container = document.createElement('div')
  container.scrollTop = 1350
  const pages = [0, 1000, 2000].map(top => {
    const div = document.createElement('div')
    Object.defineProperties(div, { offsetTop: { get: () => top }, offsetHeight: { get: () => 1000 } })
    return { div }
  })
  const native = { pagesCount: 3, currentPageNumber: 2, currentScale: 1.2, currentScaleValue: '1.2', pagesRotation: 90,
    container, getPageView: (index: number) => pages[index], eventBus: { on: (name: string, callback: () => void) => events.set(name, callback), off() {} } }
  Object.assign(nativeWindow, { PDFViewerApplication: { pdfViewer: native } })
  let state: PDFReadingState = { page: 1, fraction: 0, scale: 1, rotation: 0 }
  const viewer = { open: async () => 3, stateJSON: () => JSON.stringify(state), set: (value: PDFReadingState) => { state = { ...value } }, find() {}, destroy: async () => {} }
  vi.spyOn(HTMLIFrameElement.prototype, 'srcdoc', 'set').mockImplementation(function (this: HTMLIFrameElement) {
    Object.defineProperty(this, 'contentDocument', { configurable: true, value: document.implementation.createHTMLDocument() })
    Object.assign(this.contentWindow!, { JadensePDFView: viewer })
  })
  const host = { Prefs: { get: (key: string) => key.endsWith('pdfLinkedScroll') ? linked : undefined, set() {} },
    getMainWindow: () => ({ fetch: async () => ({ text: async () => '' }) }) } as unknown as ZoteroLike
  const saved = { id: 'zoom-task', source: { itemID: 1 }, status: 'complete', pages: 3, skipped: [], coverage: { total: 1, translated: 1, failed: 0, preserved: 0, failedPages: [] } }
  jobs.get.mockReturnValue(saved); jobs.hasOutput.mockReturnValue(hasOutput)
  const reader = { itemID: 1, _internalReader: { _primaryView: { _iframeWindow: nativeWindow } } }
  await openPDFTranslation(host, reader, 'compare', saved.id)
  const control = <T extends HTMLElement = HTMLButtonElement>(id: string) => document.querySelector<T>(`[data-pdf-control="${id}"]`)!
  const change = (value: string) => { const input = control<HTMLInputElement>('zoom'); input.value = value; input.dispatchEvent(new Event('change')) }
  return { control, change, native, events, state: () => state, show: () => openPDFTranslation(host, reader, 'compare', saved.id) }
}

beforeEach(() => {
  vi.clearAllMocks(); initializeUiLocale({ locale: 'zh-CN' })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('Components', { utils: { cloneInto: <T>(value: T) => value, exportFunction: <T>(value: T) => value } })
})
afterEach(() => { stopPDFTranslationReaders(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })

it('offers local zoom and preserves page, fraction and rotation without translating again', async () => {
  const { control, state, native, change } = await mount()
  expect(control('zoom-in')).not.toBeNull()
  control('zoom-in').click()
  expect(state()).toEqual({ page: 2, fraction: .35, scale: 1.3, rotation: 90 })
  expect(native.currentScale).toBe(1.3)
  change('160')
  expect(state().scale).toBe(1.6)
  control('zoom-reset').click()
  expect(state().scale).toBe(1)
  expect(jobs.start).not.toHaveBeenCalled(); expect(jobs.retry).not.toHaveBeenCalled(); expect(jobs.openOrStart).not.toHaveBeenCalled()
})

it('zooms only the translation when scroll is unlinked and keeps the controls open', async () => {
  const { control, state, native, show } = await mount(false)
  control('more-toggle').click()
  const menu = control('zoom-in').closest('.jdx-pdf-translation-popover') as HTMLElement
  control('zoom-in').click(); control('zoom-in').click()
  expect(state().scale).toBe(1.4); expect(native.currentScale).toBe(1.2)
  expect(menu.hidden).toBe(false)
  await show()
  expect(native.currentScale).toBe(1.2); expect(state().scale).toBe(1.4)
  Array.from(document.querySelectorAll<HTMLElement>('[data-pdf-control="view"] [role="option"]')).find(option => option.textContent === '仅显示译文')!.click()
  control('zoom-in').click()
  expect(native.currentScale).toBe(1.2); expect(state().scale).toBe(1.5)
})

it('normalizes optional input and reflects original-side zoom', async () => {
  const { change, control, state, native, events } = await mount()
  expect(document.querySelector('.jdx-pdf-translation')?.getAttribute('data-pdf-artifact-revision'), document.querySelector('.jdx-pdf-status-content')?.textContent ?? '').toBe('legacy')
  change(''); expect(state().scale).toBe(1.2)
  change('999'); expect(state().scale).toBe(5); expect(control('zoom-in').hasAttribute('disabled')).toBe(true)
  change('1'); expect(state().scale).toBe(.25); expect(control('zoom-out').hasAttribute('disabled')).toBe(true)
  // 原文获得操作主导权后，原生缩放即时回显到译文百分比。
  const original = document.querySelector<HTMLIFrameElement>('#original')!
  original.contentWindow!.dispatchEvent(new Event('pointerdown'))
  native.currentScale = 1.75; events.get('scalechanging')?.()
  expect(control<HTMLInputElement>('zoom').value).toBe('175')
  const input = control<HTMLInputElement>('zoom'); input.focus(); input.value = '18'
  native.currentScale = 1.8; events.get('scalechanging')?.()
  expect(input.value).toBe('18')
  input.value = '190'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  expect(state().scale).toBe(1.9)
  input.value = ''; input.blur(); expect(input.value).toBe('190')
})

it('disables zoom until a readable PDF exists', async () => {
  const { control } = await mount(true, false)
  for (const id of ['zoom', 'zoom-in', 'zoom-out', 'zoom-reset']) expect(control(id)?.hasAttribute('disabled')).toBe(true)
})
