/** 真实简阅挂载/任务/镜像接缝；仅替换宿主 SDT 获取和网络，不以静态 HTML 代替状态流。 */
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { openSimpleReading, stopSimpleReadingReaders } from './simple-reading'
import { acquireNativeReading } from './simple-reading-native'
import { readingBlocks } from './simple-reading-blocks'
import { SimpleReadingJobs, readingTransport, type ReadingTransport } from './simple-reading-jobs'
import { SimpleReadingStore, type ReadingIdentity } from './simple-reading-store'
import { pdfSource } from './pdf-translation-jobs'
import type { PDFPlatform } from './pdf-translation-runtime'
import type { ZoteroLike } from './runtime'

vi.mock('./simple-reading-native', async importOriginal => ({ ...await importOriginal<typeof import('./simple-reading-native')>(), acquireNativeReading: vi.fn() }))
vi.mock('./simple-reading-jobs', async importOriginal => ({ ...await importOriginal<typeof import('./simple-reading-jobs')>(), readingTransport: vi.fn() }))
vi.mock('./pdf-translation-jobs', () => ({ pdfSource: vi.fn() }))
afterEach(() => { stopSimpleReadingReaders(); vi.restoreAllMocks() })
function fakePDF(window: Window) {
  const doc = window.document, page = doc.createElement('div'), container = doc.createElement('div')
  container.append(page)
  return { container, currentScaleValue: 'page-width', currentPageNumber: 1, pagesCount: 1,
    getPageView: () => ({ div: page }), eventBus: { on: vi.fn(), off: vi.fn(), dispatch: vi.fn() } }
}

it('gates empty and loading views, marks missing paragraphs, and clears markers after translation', async () => {
  const window = new JSDOM('<div><iframe id="pdf"></iframe><iframe id="sdt"></iframe></div>', { pretendToBeVisual: true }).window
  const frame = window.document.querySelector<HTMLIFrameElement>('#pdf')!, doc = window.document.querySelector<HTMLIFrameElement>('#sdt')!.contentDocument!
  frame.style.display = 'none' // 宿主切到 SDT 时临时隐藏 PDF。
  frame.contentDocument!.body.textContent = 'Original PDF'
  doc.body.innerHTML = '<article id="sdt-content"><p data-ref-path="0">First paragraph</p><p data-ref-path="1">Second paragraph</p></article>'
  const root = doc.querySelector<HTMLElement>('article')!, blocks = readingBlocks(root)
  const identity: ReadingIdentity = { source: { itemID: 1, itemKey: 'PDF', libraryID: 1, title: 'Paper' }, fingerprint: 'file', sdtHash: 'sdt', contentHash: 'content' }
  const restore = vi.fn(async () => {})
  const showPDF = vi.fn(async () => { frame.style.display = 'block' })
  vi.mocked(acquireNativeReading).mockResolvedValue({ root, frame, pdfFrameStyle: 'display: block;', blocks, identity, authors: [], restore, showPDF, pdf: fakePDF(window as unknown as Window), pages: [[0], [0]], view: {}, baseWindow: undefined, createCrops: () => undefined })
  vi.mocked(pdfSource).mockResolvedValue({ source: identity.source, fingerprint: 'file' } as Awaited<ReturnType<typeof pdfSource>>)
  const files = new Map<string, string>()
  const platform = { IOUtils: { exists: async () => true, makeDirectory: async () => {}, writeUTF8: async (file: string, text: string) => { files.set(file, text) }, readUTF8: async (file: string) => files.get(file)!, getChildren: async () => [...files.keys()] }, PathUtils: { profileDir: 'test', join: (...parts: string[]) => parts.join('/'), filename: (file: string) => file.split('/').at(-1)! } } as unknown as PDFPlatform
  const jobs = new SimpleReadingJobs(new SimpleReadingStore(platform))
  const host = { __jadenseSimpleReading: jobs } as ZoteroLike
  let release: (output: Record<string, string>) => void = () => {}
  const send = vi.fn<ReadingTransport['send']>().mockImplementationOnce(async () => new Promise(resolve => { release = resolve })).mockResolvedValue({})
  vi.mocked(readingTransport).mockResolvedValue({ configuration: 'test', limit: 10000, concurrency: 2, machine: false, cost: text => text.length, send })
  const reader = { itemID: 1 }
  let finishLoading!: () => void
  const load = jobs.load.bind(jobs)
  vi.spyOn(jobs, 'load').mockImplementationOnce(() => new Promise<void>(resolve => { finishLoading = () => { void load().then(resolve) } }))
  const opening = openSimpleReading(host, reader)
  await vi.waitFor(() => expect(finishLoading).toBeTypeOf('function'))
  const panel = window.document.querySelector<HTMLElement>('.jdx-simple-reading')!
  const button = (name: RegExp) => Array.from(panel.querySelectorAll('button')).find(node => name.test(node.textContent!))!
  expect(panel.querySelector('.jdx-simple-status')?.textContent).toMatch(/正在读取简阅内容|Loading reading content/u)
  expect(panel.querySelector('.jdx-simple-status-toggle')?.textContent).toMatch(/正在读取简阅历史|Loading reading history/u)
  button(/^(翻译|Translate)$/u).click()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(send).not.toHaveBeenCalled()
  expect(button(/^(翻译|Translate)$/u).disabled).toBe(true)
  finishLoading(); await opening
  expect(button(/^(翻译|Translate)$/u).disabled).toBe(false)
  const view = panel.querySelector<HTMLElement>('.jdx-simple-view')!
  const viewOption = (label: RegExp) => Array.from(view.querySelectorAll<HTMLElement>('[role="option"]')).find(node => label.test(node.textContent!))!
  const languageButton = (label: RegExp) => Array.from(view.querySelectorAll<HTMLButtonElement>('.jdx-simple-language button')).find(node => label.test(node.textContent!))!
  expect(showPDF).toHaveBeenCalledOnce()
  expect(view.querySelectorAll('[role="option"]')).toHaveLength(4)
  expect(view.querySelector('.jdx-simple-language')).not.toBeNull()
  expect(languageButton(/译文|Translation/u).disabled).toBe(true)
  expect(view.querySelector('.jdx-select-value')?.textContent).toMatch(/双视图|Split view/u)
  expect(viewOption(/简阅内容|Reading content/u).getAttribute('aria-disabled')).toBe('false')
  expect(viewOption(/多屏阅读|Separate window/u).getAttribute('aria-disabled')).toBe('false')
  expect(panel.querySelector('iframe')?.hidden).toBe(false)
  expect(panel.querySelector('iframe')?.contentDocument?.body.textContent).toContain('First paragraph')
  expect(frame.contentDocument?.body.textContent).toBe('Original PDF')
  expect(send).not.toHaveBeenCalled()
  button(/^(翻译|Translate)$/u).click()
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  expect(viewOption(/双视图|Split view/u).getAttribute('aria-disabled')).toBe('false'); expect(panel.querySelector('iframe')?.hidden).toBe(false)
  release({ '0': '第一段译文' })
  await vi.waitFor(() => expect(jobs.list()[0].status).toBe('partial'))
  expect(viewOption(/双视图|Split view/u).getAttribute('aria-disabled')).toBe('false')
  const mirror = panel.querySelector('iframe')!.contentDocument!
  expect(mirror.querySelector('[data-ref-path="0"]')?.textContent).toBe('第一段译文')
  expect(mirror.querySelector('[data-ref-path="1"]')?.textContent).toMatch(/未翻译|Not translated/u)
  expect(languageButton(/译文|Translation/u).disabled).toBe(false)
  const requestsBeforeLanguage = send.mock.calls.length
  languageButton(/原文|Original/u).click()
  await vi.waitFor(() => expect(mirror.querySelector('[data-ref-path="0"]')?.textContent).toBe('First paragraph'))
  expect(languageButton(/原文|Original/u).getAttribute('aria-pressed')).toBe('true')
  expect(send).toHaveBeenCalledTimes(requestsBeforeLanguage)
  languageButton(/译文|Translation/u).click()
  await vi.waitFor(() => expect(mirror.querySelector('[data-ref-path="0"]')?.textContent).toBe('第一段译文'))
  expect(send).toHaveBeenCalledTimes(requestsBeforeLanguage)
  expect(root.textContent).toBe('First paragraphSecond paragraph')
  expect(frame.contentDocument?.body.textContent).toBe('Original PDF')
  viewOption(/简阅内容|Reading content/u).click(); expect(frame.style.visibility).toBe('hidden')
  send.mockImplementation(async (_task, request) => Object.fromEntries(request.blocks.map(block => [block.id, '补译成果'])))
  button(/仅补译|Translate missing/u).click()
  await vi.waitFor(() => expect(jobs.list()[0].status).toBe('complete'))
  expect(mirror.querySelector('[data-jdx-reading-status]')).toBeNull()
  expect(mirror.querySelector('[data-ref-path="1"]')?.textContent).toBe('补译成果')
  let restored!: () => void
  restore.mockImplementationOnce(() => new Promise<void>(resolve => { restored = resolve }))
  const acquisitions = vi.mocked(acquireNativeReading).mock.calls.length
  button(/退出简阅|Close reading mode/u).click()
  await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce())
  expect(frame.style.display).toBe('block')
  const reopening = openSimpleReading(host, reader)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(acquireNativeReading).toHaveBeenCalledTimes(acquisitions)
  restored(); await reopening
  expect(acquireNativeReading).toHaveBeenCalledTimes(acquisitions + 1)
  stopSimpleReadingReaders(); window.close()
})

it('abandons an opening reader when its PDF closes and still opens another PDF', async () => {
  vi.mocked(acquireNativeReading).mockReset()
  const firstWindow = new JSDOM('<div><iframe></iframe></div>', { pretendToBeVisual: true }).window
  const secondWindow = new JSDOM('<div><iframe></iframe></div>', { pretendToBeVisual: true }).window
  const native = (window: typeof firstWindow, itemID: number) => {
    const frame = window.document.querySelector('iframe')!, doc = frame.contentDocument!
    doc.body.innerHTML = `<article id="sdt-content"><p data-ref-path="0">Paper ${itemID}</p></article>`
    const root = doc.querySelector<HTMLElement>('article')!
    return { root, frame, blocks: readingBlocks(root), identity: { source: { itemID, itemKey: `PDF${itemID}`, libraryID: 1, title: `Paper ${itemID}` }, fingerprint: `file${itemID}`, sdtHash: `sdt${itemID}`, contentHash: `content${itemID}` }, authors: [], restore: vi.fn(async () => {}), showPDF: vi.fn(async () => {}), pdf: fakePDF(window as unknown as Window), pages: [[0]], view: {}, baseWindow: undefined, createCrops: () => undefined }
  }
  const oldNative = native(firstWindow, 1), nextNative = native(secondWindow, 2)
  let finishOld!: (value: typeof oldNative) => void
  vi.mocked(acquireNativeReading).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockResolvedValueOnce(nextNative)
  const files = new Map<string, string>()
  const platform = { IOUtils: { exists: async () => true, makeDirectory: async () => {}, writeUTF8: async (file: string, value: string) => { files.set(file, value) }, readUTF8: async (file: string) => files.get(file)!, getChildren: async () => [...files.keys()] }, PathUtils: { profileDir: 'test', join: (...parts: string[]) => parts.join('/'), filename: (file: string) => file.split('/').at(-1)! } } as unknown as PDFPlatform
  const host = { __jadenseSimpleReading: new SimpleReadingJobs(new SimpleReadingStore(platform)) } as ZoteroLike
  const first = openSimpleReading(host, { itemID: 1, _iframeWindow: firstWindow as unknown as Window })
  await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'))
  firstWindow.dispatchEvent(new firstWindow.Event('unload'))
  expect(await Promise.race([first.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('stuck'), 50))])).toBe('closed')
  finishOld(oldNative)
  const second = openSimpleReading(host, { itemID: 2, _iframeWindow: secondWindow as unknown as Window })
  await second
  expect(firstWindow.document.querySelector('.jdx-simple-reading')).toBeNull()
  expect(secondWindow.document.querySelector('.jdx-simple-status-toggle')?.textContent).toMatch(/待翻译|Not translated/u)
  expect(oldNative.restore).not.toHaveBeenCalled()
  stopSimpleReadingReaders(); firstWindow.close(); secondWindow.close()
})

it('clears the loading toolbar when a PDF closes during history loading', async () => {
  vi.mocked(acquireNativeReading).mockReset()
  const firstWindow = new JSDOM('<div><iframe></iframe></div>', { pretendToBeVisual: true }).window
  const secondWindow = new JSDOM('<div><iframe></iframe></div>', { pretendToBeVisual: true }).window
  const native = (window: typeof firstWindow, itemID: number) => {
    const frame = window.document.querySelector('iframe')!, doc = frame.contentDocument!
    doc.body.innerHTML = `<article id="sdt-content"><p data-ref-path="0">Paper ${itemID}</p></article>`
    const root = doc.querySelector<HTMLElement>('article')!
    return { root, frame, blocks: readingBlocks(root), identity: { source: { itemID, itemKey: `PDF${itemID}`, libraryID: 1, title: `Paper ${itemID}` }, fingerprint: `file${itemID}`, sdtHash: `sdt${itemID}`, contentHash: `content${itemID}` }, authors: [], restore: vi.fn(async () => {}), showPDF: vi.fn(async () => {}), pdf: fakePDF(window as unknown as Window), pages: [[0]], view: {}, baseWindow: undefined, createCrops: () => undefined }
  }
  const firstNative = native(firstWindow, 1)
  firstNative.restore.mockImplementation(() => new Promise<void>(() => {}))
  vi.mocked(acquireNativeReading).mockResolvedValueOnce(firstNative).mockResolvedValueOnce(native(secondWindow, 2))
  const platform = { IOUtils: { exists: async () => false }, PathUtils: { profileDir: 'test', join: (...parts: string[]) => parts.join('/'), filename: (file: string) => file.split('/').at(-1)! } } as unknown as PDFPlatform
  const jobs = new SimpleReadingJobs(new SimpleReadingStore(platform)), host = { __jadenseSimpleReading: jobs } as ZoteroLike
  const load = jobs.load.bind(jobs)
  vi.spyOn(jobs, 'load').mockImplementationOnce(() => new Promise<void>(() => {})).mockImplementationOnce(load)
  const first = openSimpleReading(host, { itemID: 1, _iframeWindow: firstWindow as unknown as Window })
  await vi.waitFor(() => expect(firstWindow.document.querySelector('.jdx-simple-status-toggle')?.textContent).toMatch(/正在读取|Loading/u))
  firstWindow.dispatchEvent(new firstWindow.Event('unload'))
  expect(await Promise.race([first.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('stuck'), 50))])).toBe('closed')
  expect(firstWindow.document.querySelector('.jdx-simple-reading')).toBeNull()
  expect(firstNative.restore).not.toHaveBeenCalled()
  await openSimpleReading(host, { itemID: 2, _iframeWindow: secondWindow as unknown as Window })
  expect(secondWindow.document.querySelector('.jdx-simple-status-toggle')?.textContent).toMatch(/待翻译|Not translated/u)
  stopSimpleReadingReaders(); firstWindow.close(); secondWindow.close()
})

it('lets the original PDF open when reading history stalls, then applies late history', async () => {
  vi.mocked(acquireNativeReading).mockReset()
  const window = new JSDOM('<div><iframe></iframe></div>', { pretendToBeVisual: true }).window
  const frame = window.document.querySelector('iframe')!, doc = frame.contentDocument!
  doc.body.innerHTML = '<article id="sdt-content"><p data-ref-path="0">Paper</p></article>'
  const root = doc.querySelector<HTMLElement>('article')!
  vi.mocked(acquireNativeReading).mockResolvedValue({ root, frame, blocks: readingBlocks(root), identity: { source: { itemID: 1, itemKey: 'PDF', libraryID: 1, title: 'Paper' }, fingerprint: 'file', sdtHash: 'sdt', contentHash: 'content' }, authors: [], restore: vi.fn(async () => {}), showPDF: vi.fn(async () => {}), pdf: fakePDF(window as unknown as Window), pages: [[0]], view: {}, baseWindow: undefined, createCrops: () => undefined })
  const platform = { IOUtils: { exists: async () => false }, PathUtils: { profileDir: 'test', join: (...parts: string[]) => parts.join('/'), filename: (file: string) => file.split('/').at(-1)! } } as unknown as PDFPlatform
  const jobs = new SimpleReadingJobs(new SimpleReadingStore(platform)), host = { __jadenseSimpleReading: jobs } as ZoteroLike
  let finishLoading!: () => void
  const load = jobs.load.bind(jobs)
  vi.spyOn(jobs, 'load').mockImplementationOnce(() => new Promise<void>(resolve => { finishLoading = () => { void load().then(resolve) } }))
  const nativeTimeout = globalThis.setTimeout.bind(globalThis)
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => nativeTimeout(callback, delay === 10000 ? 20 : delay, ...args))
  const opening = openSimpleReading(host, { itemID: 1, _iframeWindow: window as unknown as Window })
  await vi.waitFor(() => expect(finishLoading).toBeTypeOf('function'))
  await opening
  const toolbar = window.document.querySelector<HTMLElement>('.jdx-simple-status-toggle')!
  expect(toolbar.textContent).toMatch(/历史读取较慢|History is slow/u)
  const translate = Array.from(window.document.querySelectorAll<HTMLButtonElement>('.jdx-simple-reading button')).find(button => /^(翻译|Translate)$/u.test(button.textContent!))!
  expect(translate.disabled).toBe(false)
  finishLoading()
  await vi.waitFor(() => expect(toolbar.textContent).not.toMatch(/历史读取较慢|History is slow/u))
  expect(toolbar.textContent).toMatch(/待翻译|Not translated/u)
  stopSimpleReadingReaders(); window.close()
})
