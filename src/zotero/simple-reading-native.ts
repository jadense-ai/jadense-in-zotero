/** 原生 Reader 私有 API 的能力边界；只调用宿主 SDT 缓存与阅读模式。 */
import { requestHash } from '@/chat/temporary-request-store'
import { pdfSource } from './pdf-translation-jobs'
import { readingBlocks, type BoundReadingBlock } from './simple-reading-blocks'
import type { ReadingIdentity } from './simple-reading-store'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

type Crop = { displayWidth: number; displayHeight: number; render(): Promise<string> }
type CropProvider = (ref: number[]) => Crop[]
export type ReadingPDF = { container: HTMLElement; currentScaleValue: string; currentPageNumber: number; pagesCount: number; getPageView(index: number): { div: HTMLElement }; eventBus: { on(name: string, callback: () => void): void; off(name: string, callback: () => void): void; dispatch?(name: string, data: unknown): void } }
export type NativeReadingView = {
  initializedPromise?: Promise<unknown>; _iframe?: HTMLIFrameElement; _iframeWindow?: Window; _iframeDocument?: Document
  getData?(): { getBlockCrops?(ref: number[]): Crop[] }
  createSDTBlockCropProvider?(structure: unknown): CropProvider
}
export type SimpleReader = { itemID: number; _initPromise?: Promise<unknown>; _iframeWindow?: Window; _internalReader?: {
  _primarySDTView?: NativeReadingView; _primaryView?: NativeReadingView
  _state?: { primaryReadingModeEnabled?: boolean }; _setReadingMode?(primary: boolean, enabled: boolean): Promise<void>
  _loadSDT?(): Promise<{ structure?: unknown } | null>; getSDTReader?(): Promise<{ materialize(): Promise<unknown> } | null>
} }
export type ReadingPage = { contentRange?: [number[], number[]] }
/** 页范围按 SDT 顶层块索引归属；跨页块取首次出现的物理页。 */
export function readingBlockPages(structure: unknown): number[][] {
  const value = structure as { content?: unknown[]; catalog?: { pages?: ReadingPage[] } } | null
  const pages = value?.catalog?.pages, count = value?.content?.length
  if (!Array.isArray(pages) || !Number.isInteger(count)) return []
  const mapped: number[][] = Array.from({ length: count! }, () => [])
  pages.forEach((page, pageIndex) => {
    const [start, end] = page?.contentRange ?? []
    if (!Array.isArray(start) || !Array.isArray(end) || !Number.isInteger(start[0]) || !Number.isInteger(end[0])) return
    const first = start[0], last = end[0] + (end.length > 1 ? 1 : 0)
    if (first < 0 || last > mapped.length || first >= last) return
    for (let i = first; i < last; i++) mapped[i].push(pageIndex)
  })
  return mapped
}
export function readingUnavailable() { return new Error(uiText('此附件的简阅模式不可用。请继续使用 PDF、全文 Markdown 或对照翻译。', 'Reading mode is unavailable for this attachment. PDF, full Markdown and bilingual PDF remain available.')) }
export class ReadingClosedError extends Error { constructor() { super('Reader closed during simple reading initialization') } }
export function assertReadingOpen(signal?: AbortSignal) { if (signal?.aborted) throw new ReadingClosedError() }
/** Gecko 内容 realm 不能读取插件对象的字典属性；仅克隆无凭据的 DOM 选项。 */
export function readingDOMOptions<T>(value: T, win: Window): T {
  const bridge = globalThis as typeof globalThis & { Components?: { utils?: { cloneInto?<V>(value: V, target: Window): V } } }
  return bridge.Components?.utils?.cloneInto?.(value, win) ?? value
}

/** 来源与原生结构均确认后才显示；返回恢复函数，初始化失败同样恢复宿主。 */
export async function acquireNativeReading(host: ZoteroLike, reader: SimpleReader, signal?: AbortSignal) {
  await reader._initPromise
  assertReadingOpen(signal)
  const internal = reader._internalReader
  if (!internal?._setReadingMode || (!internal._loadSDT && !internal.getSDTReader)) throw readingUnavailable()
  const wasReading = Boolean(internal._state?.primaryReadingModeEnabled ?? internal._primarySDTView), base = internal._primaryView?._iframeWindow
  const pdfFrame = internal._primaryView?._iframe ?? base?.frameElement as HTMLIFrameElement | undefined
  // SDT 会临时隐藏 PDF iframe；退出时必须恢复进入 SDT 前的 PDF 样式。
  const pdfFrameStyle = pdfFrame?.getAttribute('style') ?? null
  const pdf = (base as Window & { PDFViewerApplication?: { pdfViewer?: ReadingPDF } })?.PDFViewerApplication?.pdfViewer
  const position = pdf ? { top: pdf.container.scrollTop, left: pdf.container.scrollLeft, scale: pdf.currentScaleValue } : undefined
  const showPDF = async () => {
    await internal._setReadingMode!(true, false)
    if (pdf && position) { pdf.currentScaleValue = position.scale; pdf.container.scrollTop = position.top; pdf.container.scrollLeft = position.left }
  }
  const restore = async () => {
    await internal._setReadingMode!(true, wasReading)
    if (pdf && position && !wasReading) { pdf.currentScaleValue = position.scale; pdf.container.scrollTop = position.top; pdf.container.scrollLeft = position.left }
  }
  try {
    const origin = await pdfSource(host, reader.itemID)
    assertReadingOpen(signal)
    const structure = internal._loadSDT ? (await internal._loadSDT())?.structure : await (await internal.getSDTReader!())?.materialize()
    assertReadingOpen(signal)
    if (!structure) throw readingUnavailable()
    await internal._setReadingMode(true, true)
    assertReadingOpen(signal)
    const view = internal._primarySDTView
    await view?.initializedPromise
    assertReadingOpen(signal)
    const doc = view?._iframeDocument ?? view?._iframeWindow?.document, root = doc?.getElementById('sdt-content')
    const frame = view?._iframe ?? view?._iframeWindow?.frameElement as HTMLIFrameElement | undefined
    if (!root || !frame || !view || !pdfFrame || !pdf) throw readingUnavailable()
    const item = await host.Items?.get?.(reader.itemID) as unknown as { parentItem?: { getCreators?(): Array<{ firstName?: string; lastName?: string; name?: string }> } }
    assertReadingOpen(signal)
    const authors = item?.parentItem?.getCreators?.().map(a => a.name || [a.firstName, a.lastName].filter(Boolean).join(' ')) ?? []
    const blocks = readingBlocks(root, authors)
    const identity: ReadingIdentity = { source: origin.source, fingerprint: origin.fingerprint, sdtHash: await requestHash(JSON.stringify(structure)), contentHash: await requestHash(JSON.stringify(blocks.map(({ id, text }) => ({ id, text })))) }
    assertReadingOpen(signal)
    return { view, root, frame: pdfFrame, pdfFrameStyle, sdtFrame: frame, blocks, identity, authors, restore, showPDF, baseWindow: base, pdf, pages: readingBlockPages(structure), createCrops: () => internal._primaryView?.createSDTBlockCropProvider?.(structure) }
  } catch (error) { if (!signal?.aborted) await restore().catch(() => {}); throw error }
}

/** 从当前原生样式镜像正文。独立 iframe 没有原生批注/模型 HTML 事件处理器。 */
export function mirrorNativeReading(source: HTMLElement, doc: Document, authors: string[]) {
  const original = source.ownerDocument
  doc.head.replaceChildren()
  for (const style of Array.from(original.querySelectorAll('head style'))) doc.head.append(doc.importNode(style, true))
  const copyAttributes = (from: Element, to: Element) => {
    for (const attr of Array.from(to.attributes)) to.removeAttribute(attr.name)
    for (const attr of Array.from(from.attributes)) if (!attr.name.startsWith('on')) to.setAttribute(attr.name, attr.value)
  }
  copyAttributes(original.documentElement, doc.documentElement); copyAttributes(original.body, doc.body)
  const root = doc.importNode(source, true)
  for (const node of Array.from(root.querySelectorAll('script,iframe,object,embed,form'))) node.remove()
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) for (const attr of Array.from(node.attributes)) {
    if (/^on/iu.test(attr.name) || attr.name === 'srcdoc' || (['href', 'src', 'xlink:href'].includes(attr.name) && !/^(?:#|data:image\/(?:png|jpeg);base64,)/u.test(attr.value))) node.removeAttribute(attr.name)
  }
  doc.body.replaceChildren(root)
  const refreshStyles = () => {
    copyAttributes(original.documentElement, doc.documentElement); copyAttributes(original.body, doc.body)
    doc.head.replaceChildren(...Array.from(original.querySelectorAll('head style'), style => doc.importNode(style, true)))
  }
  const sourceWindow = original.defaultView as (Window & typeof globalThis) | null
  const observer = sourceWindow ? new sourceWindow.MutationObserver(refreshStyles) : undefined
  if (observer && sourceWindow) {
    observer.observe(original.documentElement, readingDOMOptions({ attributes: true }, sourceWindow)); observer.observe(original.body, readingDOMOptions({ attributes: true }, sourceWindow)); observer.observe(original.head, readingDOMOptions({ childList: true, subtree: true, characterData: true }, sourceWindow))
  }
  return { root, blocks: readingBlocks(root, authors), remove: () => observer?.disconnect() }
}

/** 关闭临时 SDT iframe 前保存可安全重复镜像的 DOM 和样式，不引用死窗口。 */
export function snapshotNativeReading(source: HTMLElement, owner: Document): HTMLElement {
  const snapshot = owner.implementation.createHTMLDocument('')
  const original = source.ownerDocument
  for (const node of [original.documentElement, original.body] as const) {
    const target = node === original.body ? snapshot.body : snapshot.documentElement
    for (const attr of Array.from(node.attributes)) if (!attr.name.startsWith('on')) target.setAttribute(attr.name, attr.value)
  }
  for (const style of Array.from(original.querySelectorAll('head style'))) snapshot.head.append(snapshot.importNode(style, true))
  const root = snapshot.importNode(source, true) as HTMLElement
  snapshot.body.append(root)
  return root
}

/** 镜像裁图在自身视口可见时才请求原生 provider，串行解码控制内存。 */
export function observeReadingCrops(root: HTMLElement, provider: CropProvider | undefined, baseWindow?: Window) {
  const win = root.ownerDocument.defaultView as Window & typeof globalThis
  let disposed = false, queue = Promise.resolve()
  // provider 按页面聚合裁图并冻结第一次 render 的清单；不能向原生视图已渲染的 provider 追加索引。
  // 每个镜像独占一个宿主 provider，先登记全部几何，再按可见区域调用 render。
  const prepared = new Map<string, Crop[]>()
  for (const figure of Array.from(root.querySelectorAll<HTMLElement>('figure.sdt-source-crop'))) {
    try { const parts = (figure.dataset.refPath ?? '').split('.').map(Number), realm = baseWindow as Window & { Array?: ArrayConstructor }; prepared.set(figure.dataset.refPath!, provider?.(realm?.Array?.of(...parts) ?? parts) ?? []) } catch { prepared.set(figure.dataset.refPath!, []) }
  }
  const load = async (figure: HTMLElement) => {
    if (disposed) return
    let phase = 'provider'
    try {
      const crops = prepared.get(figure.dataset.refPath!) ?? [], pages = figure.querySelector('.sdt-source-crop-pages')
      phase = 'empty-crops'
      if (!pages || !crops.length) throw readingUnavailable()
      const children: HTMLElement[] = []
      for (const crop of crops) {
        if (disposed) return
        phase = 'render'
        const src = await crop.render()
        phase = 'image-format'
        if (!/^data:image\/(?:png|jpeg);base64,/u.test(src)) throw readingUnavailable()
        const page = root.ownerDocument.createElement('div'), img = root.ownerDocument.createElement('img')
        phase = 'image-dom'
        page.className = 'sdt-source-crop-page'; page.style.width = `${crop.displayWidth}px`; page.style.aspectRatio = `${crop.displayWidth} / ${crop.displayHeight}`
        img.src = src; img.alt = uiText('原页裁图，未翻译', 'Original page crop, untranslated'); page.append(img); children.push(page)
      }
      if (!disposed) { pages.replaceChildren(...children); figure.dataset.sourceCropState = 'loaded' }
    } catch { if (!disposed) { figure.dataset.sourceCropState = 'unavailable'; figure.dataset.jdxCropError = phase; figure.title = uiText('原页裁图暂不可用', 'Original page crop unavailable') } }
  }
  if (!win.IntersectionObserver) {
    const visible = () => { for (const figure of Array.from(root.querySelectorAll<HTMLElement>('figure.sdt-source-crop'))) {
      if (figure.dataset.jdxCropQueued) continue
      const box = figure.getBoundingClientRect()
      if (box.bottom >= -300 && box.top <= win.innerHeight + 300) { figure.dataset.jdxCropQueued = 'true'; queue = queue.then(() => load(figure)) }
    } }
    win.addEventListener('scroll', visible); visible()
    return () => { disposed = true; win.removeEventListener('scroll', visible) }
  }
  const observer = new win.IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); queue = queue.then(() => load(entry.target as HTMLElement)) }
  }, readingDOMOptions({ rootMargin: '300px' }, win))
  for (const figure of Array.from(root.querySelectorAll<HTMLElement>('figure.sdt-source-crop'))) {
    figure.title = uiText('原页内容，未翻译', 'Original content, untranslated')
    observer.observe(figure)
  }
  return () => { disposed = true; observer.disconnect() }
}

export function visibleReadingBlocks(blocks: BoundReadingBlock[]) {
  const height = blocks[0]?.element.ownerDocument.defaultView?.innerHeight ?? 0
  return new Set(blocks.filter(block => { const r = block.element.getBoundingClientRect(); return r.bottom >= 0 && r.top <= height }).map(block => block.id))
}
