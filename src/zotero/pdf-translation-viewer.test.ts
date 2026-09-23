/** 执行实际译文 viewer 脚本，覆盖 PDF.js 当前页与视口顶部页不同的滚动场景。 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('anchors to the top visible page and sets vertical position without page-navigation side effects', () => {
  const container = { scrollTop: 800, scrollLeft: 45, clientHeight: 700 }
  const pages = [0, 1000, 2000].map(top => ({ div: {
    get offsetTop() { return container.clientHeight ? top : 0 },
    get offsetHeight() { return container.clientHeight ? 1000 : 0 },
  } }))
  const viewer = {
    currentScale: 1, pagesRotation: 0, pagesCount: 3,
    get currentPageNumber() { return 2 },
    set currentPageNumber(_page: number) { container.scrollLeft = 0; container.scrollTop = 1000 },
    getPageView(index: number) { return pages[index] },
  }
  const window = { addEventListener() {}, JadensePDFView: undefined as unknown as { state(): { page: number; fraction: number }; set(state: { page: number; fraction: number; scale: number; rotation: number }): void } }
  const source = readFileSync(new URL('../../content/pdf-translation/viewer.mjs', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
  runInNewContext(source, {
    window, document: { getElementById: () => container },
    EventBus: class { on() {} }, PDFViewer: function () { return viewer },
    PDFLinkService: class { setViewer() {} }, PDFFindController: class {},
    cancelAnimationFrame() {}, requestAnimationFrame() { return 1 },
  })
  expect(window.JadensePDFView.state()).toMatchObject({ page: 1, fraction: .8 })
  window.JadensePDFView.set({ page: 1, fraction: .6, scale: 1, rotation: 0 })
  expect(container).toMatchObject({ scrollTop: 600, scrollLeft: 45 })
  container.scrollTop = 2300
  expect(window.JadensePDFView.state()).toMatchObject({ page: 3, fraction: .3 })
  // iframe 隐藏时所有页面几何归零；仍应保留阅读位置，并接受原文侧的新锚点。
  window.JadensePDFView.set({ page: 1, fraction: .6, scale: 1, rotation: 0 })
  container.clientHeight = 0
  expect(window.JadensePDFView.state()).toMatchObject({ page: 1, fraction: .6 })
  window.JadensePDFView.set({ page: 2, fraction: .25, scale: 1, rotation: 0 })
  const anchor = window.JadensePDFView.state()
  expect(anchor).toMatchObject({ page: 2, fraction: .25 })
  container.clientHeight = 700
  window.JadensePDFView.set({ ...anchor, scale: 1, rotation: 0 })
  expect(container.scrollTop).toBe(1250)
})

it('keeps the readable document when a progressive replacement fails and releases it only after success', async () => {
  const callbacks = new Map<string, () => void>(), destroyed = [vi.fn(), vi.fn(), vi.fn()]
  const documents = [{ numPages: 2 }, { numPages: 2 }]
  let call = 0
  const viewer = { currentPageNumber: 1, pagesCount: 2, pagesRotation: 0, currentScale: 1,
    getPageView: () => ({ div: { offsetTop: 0, offsetHeight: 1000 } }),
    setDocument: vi.fn(() => { callbacks.get('updateviewarea')?.(); callbacks.get('pagesinit')?.() }) }
  const window = { addEventListener() {}, JadensePDFView: undefined as unknown as { open(bytes: Uint8Array, callback: () => void, source: string): Promise<number> } }
  const source = readFileSync(new URL('../../content/pdf-translation/viewer.mjs', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
  runInNewContext(source, {
    window, document: { getElementById: () => ({ clientHeight: 700, scrollTop: 0 }) },
    EventBus: class { on(name: string, callback: () => void) { callbacks.set(name, callback) } },
    PDFViewer: function () { return viewer }, PDFLinkService: class { setViewer() {} setDocument() {} }, PDFFindController: class {},
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, Blob: class {}, Worker: class { terminate() {} },
    cancelAnimationFrame() {}, requestAnimationFrame() { return 1 },
    pdfjs: { PDFWorker: class {}, getDocument: () => {
      const index = call++
      return { promise: index === 1 ? Promise.reject(new Error('damaged PDF')) : Promise.resolve(documents[index ? 1 : 0]), destroy: async () => { destroyed[index]() } }
    } },
  })
  const notify = vi.fn()
  await window.JadensePDFView.open(new Uint8Array(), notify, '')
  expect(notify).not.toHaveBeenCalled()
  await expect(window.JadensePDFView.open(new Uint8Array(), () => {}, '')).rejects.toThrow('damaged PDF')
  expect(viewer.setDocument).toHaveBeenCalledTimes(1)
  expect(destroyed[0]).not.toHaveBeenCalled()
  expect(destroyed[1]).toHaveBeenCalledOnce()
  await window.JadensePDFView.open(new Uint8Array(), notify, '')
  expect(notify).not.toHaveBeenCalled()
  expect(viewer.setDocument).toHaveBeenLastCalledWith(documents[1])
  expect(destroyed[0]).toHaveBeenCalledOnce()
})
