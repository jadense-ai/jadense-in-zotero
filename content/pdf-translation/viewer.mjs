/** 插件专属 PDF.js 视图；只接收父控制器给出的本地 PDF 字节，不接受窗口消息/URL。 */
/* global URL, Blob, Worker, document, window, cancelAnimationFrame, requestAnimationFrame */
import * as pdfjs from './pdf.mjs'
import { EventBus, PDFViewer, PDFLinkService, PDFFindController } from './pdf_viewer.mjs'

const container = document.getElementById('viewerContainer')
const eventBus = new EventBus()
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 })
const findController = new PDFFindController({ eventBus, linkService })
const viewer = new PDFViewer({ container, viewer: document.getElementById('viewer'), eventBus, linkService, findController, textLayerMode: 1, annotationMode: 0 })
linkService.setViewer(viewer)
let loading, worker, workerURL, notify = () => {}, suppress = false, frame = 0, revision = 0
let readingState = { page: 1, fraction: 0, scale: 1, rotation: 0 }
function state() {
  // 隐藏 iframe 没有有效布局；保留最近锚点，不能把全零页偏移解释成末页。
  if (!container.clientHeight) return { ...readingState }
  let index = Math.max(0, viewer.currentPageNumber - 1)
  while (index > 0 && viewer.getPageView(index).div.offsetTop > container.scrollTop) index--
  while (index + 1 < viewer.pagesCount && viewer.getPageView(index + 1).div.offsetTop <= container.scrollTop) index++
  const page = viewer.getPageView(index)?.div
  readingState = { page: index + 1, fraction: page ? Math.max(0, Math.min(1, (container.scrollTop - page.offsetTop) / page.offsetHeight)) : 0, scale: viewer.currentScale, rotation: viewer.pagesRotation }
  return { ...readingState }
}
function changed() { if (!suppress && container.clientHeight) notify(JSON.stringify(state())) }
eventBus.on('updateviewarea', changed)
eventBus.on('scalechanging', changed)
eventBus.on('rotationchanging', changed)
window.JadensePDFView = {
  async open(bytes, callback, workerSource) {
    const generation = ++revision
    const nextURL = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
    const nextWorker = new Worker(nextURL)
    const nextLoading = pdfjs.getDocument({ data: new Uint8Array(bytes), worker: new pdfjs.PDFWorker({ port: nextWorker }), isEvalSupported: false, cMapUrl: 'chrome://jadense-pdf-reader/content/cmaps/', cMapPacked: true, standardFontDataUrl: 'chrome://jadense-pdf-reader/content/standard_fonts/' })
    let pdf
    try { pdf = await nextLoading.promise; if (generation !== revision) throw new Error('PDF view closed') } catch (error) {
      await nextLoading.destroy(); nextWorker.terminate(); URL.revokeObjectURL(nextURL); throw error
    }
    // 新 PDF 加载成功前保持旧文档可读；交换后再释放旧 Worker。
    const oldLoading = loading, oldWorker = worker, oldURL = workerURL
    const anchor = loading ? state() : null
    loading = nextLoading; worker = nextWorker; workerURL = nextURL
    // PDF.js 初始化新文档时会短暂回到第一页；该事件不能同步回原文阅读位置。
    notify = () => {}
    const initialized = new Promise(resolve => { eventBus.on('pagesinit', resolve, { once: true }) })
    viewer.setDocument(pdf); linkService.setDocument(pdf)
    await initialized
    viewer.currentScale = anchor?.scale > 0 ? anchor.scale : 1
    if (anchor) window.JadensePDFView.set(anchor)
    await viewer.onePageRendered
    notify = callback
    await oldLoading?.destroy().catch(() => {}); oldWorker?.terminate(); if (oldURL) URL.revokeObjectURL(oldURL)
    return pdf.numPages
  },
  state,
  stateJSON() { return JSON.stringify(state()) },
  set(value) {
    readingState = { ...value }
    if (!container.clientHeight) return
    suppress = true
    if (value.rotation !== viewer.pagesRotation) viewer.pagesRotation = value.rotation
    if (value.scale > 0 && Math.abs(value.scale - viewer.currentScale) > .001) viewer.currentScale = value.scale
    const page = viewer.getPageView(Math.max(0, Math.min(viewer.pagesCount - 1, value.page - 1)))?.div
    if (page) container.scrollTop = page.offsetTop + page.offsetHeight * value.fraction
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => { suppress = false })
  },
  find(query, again = false) { eventBus.dispatch('find', { source: window, type: again ? 'again' : '', query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false }) },
  async destroy() { revision++; notify = () => {}; cancelAnimationFrame(frame); viewer.setDocument(null); await loading?.destroy(); worker?.terminate(); if (workerURL) URL.revokeObjectURL(workerURL) },
}
window.addEventListener('pagehide', () => { void window.JadensePDFView.destroy() }, { once: true })
