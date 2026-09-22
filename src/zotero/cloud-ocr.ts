/** Zotero 云识别运行时：本地 PDF.js 渲染，页缓存与远端任务恢复，不依赖本机 Python。 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { ZoteroLike } from './runtime'
import { cloudOCRConfig, ocrEngine, requireCloudOCR, type CloudOCRConfig } from './cloud-ocr-config'
import { recognizeImage, mineruRecognize, CloudOCRError, type CloudPage, type CloudIO, OCR_IMAGE_LIMIT } from './cloud-ocr-client'
import { readTextDocument, validateDocument, checkCancelled, type DocumentHost, type DocumentPage, type PdfRect, type PdfTextDocument } from './pdf-document'
import { ensureLocalOCR, readOCRDocument, readOCRSelection, waitForOCR, type OCRSelectionRegion } from './local-ocr'

type Platform = { IOUtils?: { read(path: string): Promise<Uint8Array>; readUTF8(path: string): Promise<string>; writeUTF8(path: string, text: string, options: { tmpPath: string }): Promise<unknown>; makeDirectory(path: string, options: { ignoreExisting: boolean }): Promise<unknown> }; PathUtils?: { profileDir: string; join(...parts: string[]): string } }
type CacheEntry = { page?: DocumentPage; batchID?: string }
type Host = ZoteroLike & { __jadenseCloudCache?: Map<string, CacheEntry>; __jadenseCloudRunning?: Set<string> }
const VERSION = 1
export async function ocrHash(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(b => b.toString(16).padStart(2, '0')).join('')
}
/** profile-local 文件名只取本地摘要；缓存失败降级到当前会话，不影响识别。 */
class OCRCache {
  private memory: Map<string, CacheEntry>
  constructor(host: Host) { this.memory = host.__jadenseCloudCache ??= new Map() }
  async read(key: string): Promise<CacheEntry> {
    if (this.memory.has(key)) return this.memory.get(key)!
    try {
      const { IOUtils, PathUtils } = globalThis as Platform
      const value = JSON.parse(await IOUtils!.readUTF8(PathUtils!.join(PathUtils!.profileDir, 'jadense-cloud-ocr', `${key}.json`))) as CacheEntry
      return value && typeof value === 'object' ? value : {}
    } catch { return {} }
  }
  async write(key: string, value: CacheEntry) {
    this.memory.set(key, value)
    try {
      const { IOUtils, PathUtils } = globalThis as Platform, dir = PathUtils!.join(PathUtils!.profileDir, 'jadense-cloud-ocr'), path = PathUtils!.join(dir, `${key}.json`)
      await IOUtils!.makeDirectory(dir, { ignoreExisting: true })
      await IOUtils!.writeUTF8(path, JSON.stringify(value), { tmpPath: `${path}.tmp` })
    } catch { /* 会话缓存继续保留；正文最终存储仍报告持久化故障。 */ }
  }
}
export async function checkOCREngine(host: ZoteroLike) {
  const engine = ocrEngine(host)
  if (engine === 'local') { await ensureLocalOCR(host); return }
  requireCloudOCR(await cloudOCRConfig(host, engine))
}
function cloudIO(host: ZoteroLike, signal: AbortSignal, progress: (text: string) => void): CloudIO {
  const win = host.getMainWindow?.()
  return { fetch: win?.fetch.bind(win) ?? globalThis.fetch.bind(globalThis), signal, progress }
}
type RenderSource = { pdf: PDFDocumentProxy; doc: Document }
/** 只对受信任的内置 Reader 创建参数，避免 chrome 对象被内容 realm 的 Xray 隐藏。 */
function readerOptions<T extends object>(doc: Document, value: T): T {
  const win = doc.defaultView as (Window & { Object?: new () => object; wrappedJSObject?: { Object: new () => object } }) | null
  const scope = win?.wrappedJSObject ?? win
  if (!scope?.Object) return value
  const options = new scope.Object() as T
  for (const [key, item] of Object.entries(value)) (options as Record<string, unknown>)[key] = item
  return options
}
async function renderer(host: ZoteroLike, itemID: number, signal: AbortSignal): Promise<RenderSource> {
  const readers = (host as unknown as DocumentHost).Reader
  const reader = readers?._readers?.find(r => r.itemID === itemID && !r._iframeWindow?.closed) ?? await readers?.open?.(itemID)
  await waitForOCR(Promise.resolve(reader?._initPromise), signal)
  const view = reader?._internalReader?._primaryView
  await waitForOCR(Promise.resolve(view?.initializedPromise), signal)
  const frame = view?._iframeWindow as unknown as { document?: Document; PDFViewerApplication?: { pdfDocument?: PDFDocumentProxy } }
  if (!frame?.document || !frame.PDFViewerApplication?.pdfDocument) throw new CloudOCRError('PDF_RENDERER_UNAVAILABLE')
  return { pdf: frame.PDFViewerApplication.pdfDocument, doc: frame.document }
}
/** 保留页面旋转变换，裁剪仅限选区；页图最长边 2400，PNG 超限转 JPEG。 */
export async function renderOCRImage(page: PDFPageProxy, doc: Document, signal: AbortSignal, rect?: number[]) {
  page = (page as PDFPageProxy & { wrappedJSObject?: PDFPageProxy }).wrappedJSObject ?? page
  const base = page.getViewport(readerOptions(doc, { scale: 1 })), viewport = page.getViewport(readerOptions(doc, { scale: Math.min(3, 2400 / Math.max(base.width, base.height)) }))
  const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas') as HTMLCanvasElement
  const context = canvas.getContext('2d')
  if (!context) throw new CloudOCRError('CANVAS_UNAVAILABLE')
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
  const task = page.render(readerOptions(doc, { canvasContext: context, viewport, background: 'white' })), abort = () => task.cancel()
  signal.addEventListener('abort', abort, { once: true })
  let output = canvas
  try {
    checkCancelled(signal); await waitForOCR(task.promise, signal); checkCancelled(signal)
    if (rect) {
      if (rect.length !== 4 || !rect.every(Number.isFinite)) throw new CloudOCRError('INVALID_SELECTION')
      const win = doc.defaultView as (Window & { JSON?: typeof JSON; wrappedJSObject?: { JSON: typeof JSON } }) | null
      const json = (win?.wrappedJSObject ?? win)?.JSON
      const bounds = viewport.convertToViewportRectangle(json ? json.parse(JSON.stringify(rect)) : rect)
      const x = Math.max(0, Math.floor(Math.min(bounds[0], bounds[2]))), y = Math.max(0, Math.floor(Math.min(bounds[1], bounds[3])))
      const width = Math.min(canvas.width, Math.ceil(Math.max(bounds[0], bounds[2]))) - x, height = Math.min(canvas.height, Math.ceil(Math.max(bounds[1], bounds[3]))) - y
      if (width <= 0 || height <= 0) throw new CloudOCRError('INVALID_SELECTION')
      output = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas') as HTMLCanvasElement
      output.width = width; output.height = height
      output.getContext('2d')!.drawImage(canvas, x, y, width, height, 0, 0, width, height)
    }
    let image = output.toDataURL('image/png')
    if (image.length * .75 > OCR_IMAGE_LIMIT) image = output.toDataURL('image/jpeg', .85)
    if (image.length * .75 > OCR_IMAGE_LIMIT) throw new CloudOCRError('IMAGE_TOO_LARGE')
    return image
  } finally { signal.removeEventListener('abort', abort); canvas.width = canvas.height = 0; output.width = output.height = 0 }
}
/** 服务坐标为 0..1000 的左上原点；有原生 viewport 时正确反转旋转，无坐标退回页导航。 */
export function projectCloudPage(value: CloudPage, base: DocumentPage, pdfPage?: PDFPageProxy, doc?: Document): DocumentPage {
  pdfPage = (pdfPage as (PDFPageProxy & { wrappedJSObject?: PDFPageProxy }) | undefined)?.wrappedJSObject ?? pdfPage
  const viewport = pdfPage?.getViewport(doc ? readerOptions(doc, { scale: 1 }) : { scale: 1 })
  const paragraphs = value.blocks.map((block, i) => {
    let rects: PdfRect[] = []
    if (block.bbox && viewport) {
      const [x1, y1, x2, y2] = block.bbox
      const a = viewport.convertToPdfPoint(x1 / 1000 * viewport.width, y1 / 1000 * viewport.height), b = viewport.convertToPdfPoint(x2 / 1000 * viewport.width, y2 / 1000 * viewport.height)
      rects = [[Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]]
    }
    const marker = `⟦I${base.pageIndex * 100000 + i}⟧`
    return { id: `cloud-${base.pageIndex}-${i}`, text: block.image ? `${marker}${block.text ? '\n' + block.text : ''}` : block.text,
      pageIndex: base.pageIndex, pageLabel: base.pageLabel, rects, lineIDs: [], ...(block.image ? { formulas: { [marker]: block.image } } : {}) }
  }).filter(p => p.text.trim())
  return { pageIndex: base.pageIndex, pageLabel: base.pageLabel, ...(value.warning ? { layoutWarning: value.warning } : {}), ...(base.viewBox ? { viewBox: base.viewBox } : {}), paragraphs,
    lines: paragraphs.map(p => ({ id: p.id, text: p.text, pageIndex: p.pageIndex, pageLabel: p.pageLabel, rects: p.rects })) }
}
/** 附图只取 ZIP 内图片或本地 PDF 裁剪，统一 PNG 后复用已有成果资产协议。 */
async function materializeCloudPage(value: CloudPage, base: DocumentPage, page: PDFPageProxy, doc: Document, signal: AbortSignal) {
  const blocks = value.blocks.map(block => ({ ...block }))
  let warning = value.warning
  for (const block of blocks) {
    try {
      if (!block.image && block.bbox && /^(image|figure|picture)$/u.test(block.kind ?? '')) {
        const rect = projectCloudPage({ blocks: [{ ...block, text: 'image' }] }, base, page, doc).paragraphs[0]?.rects[0]
        if (rect) block.image = await renderOCRImage(page, doc, signal, rect)
      }
      if (block.image?.startsWith('data:image/jpeg;base64,')) {
        const image = doc.createElementNS('http://www.w3.org/1999/xhtml', 'img') as HTMLImageElement
        try {
          await waitForOCR(new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('image decode')); image.src = block.image! }), signal)
          if (image.naturalWidth * image.naturalHeight > 16_000_000) throw new Error('image size')
          const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas') as HTMLCanvasElement
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
          try { canvas.getContext('2d')!.drawImage(image, 0, 0); block.image = canvas.toDataURL('image/png') } finally { canvas.width = canvas.height = 0 }
          if (block.image.length * .75 > OCR_IMAGE_LIMIT) throw new Error('image size')
        } finally { image.onload = image.onerror = null; image.removeAttribute('src') }
      }
    } catch {
      checkCancelled(signal); delete block.image; warning = 'OCR 附图未能读取，文字仍保留 / OCR image unavailable; text retained'
    }
  }
  return projectCloudPage({ blocks, warning }, base, page, doc)
}
async function configSnapshot(host: ZoteroLike) {
  const engine = ocrEngine(host)
  if (engine === 'local') return null
  const config = await cloudOCRConfig(host, engine); requireCloudOCR(config); return config
}
export async function readEngineDocument(host: Host, itemID: number, signal: AbortSignal, progress: (text: string) => void): Promise<PdfTextDocument> {
  const config = await configSnapshot(host)
  if (!config) { await waitForOCR(ensureLocalOCR(host), signal); checkCancelled(signal); return readOCRDocument(host, itemID, signal, progress) }
  const base = await waitForOCR(readTextDocument(host as unknown as DocumentHost, itemID, signal), signal)
  const render = await renderer(host, itemID, signal), io = cloudIO(host, signal, progress), cache = new OCRCache(host)
  const item = await (host as unknown as DocumentHost).Items?.get?.(itemID) as { getFilePathAsync(): Promise<string> }
  const bytes = await (globalThis as Platform).IOUtils!.read(await item.getFilePathAsync())
  checkCancelled(signal)
  const fingerprint = await ocrHash(JSON.stringify([VERSION, config.engine, config.endpoint, config.model]))
  const key = await ocrHash(JSON.stringify([base.source.libraryID, base.source.itemKey, await ocrHash(bytes), fingerprint]))
  const running = host.__jadenseCloudRunning ??= new Set()
  if (running.has(key)) throw new CloudOCRError('ALREADY_RUNNING')
  running.add(key)
  const pages = [...base.pages]
  try {
    let completed = 0
    const work: number[] = []
    for (let i = 0; i < pages.length; i++) {
      const saved = await cache.read(`${key}-${i}`)
      if (saved.page?.pageIndex === i && saved.page.paragraphs?.length && !saved.page.warning) { pages[i] = saved.page; completed++ } else work.push(i)
    }
    if (config.engine === 'mineru' && bytes.length <= 200 * 1024 * 1024 && pages.length <= 200 && work.length) {
      const saved = await cache.read(key)
      const result = await mineruRecognize(config, bytes, 'document.pdf', { ...io, batchID: saved.batchID, saveBatch: id => cache.write(key, { batchID: id }) })
      for (const i of work) {
        if (!result[i]?.blocks.length) { pages[i] = { ...pages[i], warning: '云 OCR 此页无结果，保留文字层 / No cloud OCR result; text layer retained' }; continue }
        const page = await materializeCloudPage(result[i], base.pages[i], await render.pdf.getPage(i + 1), render.doc, signal)
        pages[i] = page; await cache.write(`${key}-${i}`, { page })
      }
    } else {
      let cursor = 0
      const worker = async () => {
        while (cursor < work.length) {
          const index = work[cursor++]; checkCancelled(signal)
          try {
            const pdfPage = await render.pdf.getPage(index + 1), image = await renderOCRImage(pdfPage, render.doc, signal), saved = await cache.read(`${key}-${index}`)
            const result = await recognizeImage(config, image, { ...io, batchID: saved.batchID, saveBatch: id => cache.write(`${key}-${index}`, { batchID: id }) })
            if (!result.blocks.length) throw new CloudOCRError('EMPTY_RESULT')
            const page = await materializeCloudPage(result, base.pages[index], pdfPage, render.doc, signal)
            checkCancelled(signal); pages[index] = page; await cache.write(`${key}-${index}`, { page })
          } catch (error) {
            checkCancelled(signal)
            pages[index] = { ...base.pages[index], warning: `${error instanceof CloudOCRError ? error.message : 'Cloud OCR failed'} · 已保留文字层；扫描内容未识别 / Text layer retained; scanned content unrecognized` }
            // 认证、余额/限流影响整个配置，停止后续收费请求；其余页仍可完成。
            if (error instanceof CloudOCRError && ['AUTH', 'RATE_LIMIT_OR_QUOTA', 'PROVIDER_REJECTED'].includes(error.code)) {
              for (; cursor < work.length; cursor++) { const i = work[cursor]; pages[i] = { ...base.pages[i], warning: pages[index].warning } }
            }
          }
          progress(`OCR ${++completed} / ${pages.length}`)
        }
      }
      await Promise.all([worker(), worker()])
    }
    checkCancelled(signal); await validateDocument(host as unknown as DocumentHost, base.source)
    return { ...base, pages, ocrVersion: VERSION, ocr: { engine: config.engine, model: config.model, fingerprint, version: VERSION } }
  } finally { running.delete(key) }
}
export async function readEngineSelection(host: Host, itemID: number, regions: OCRSelectionRegion[], signal: AbortSignal, progress: (text: string) => void) {
  const config = await configSnapshot(host)
  if (!config) return readOCRSelection(host, itemID, regions, signal, progress)
  const base = await waitForOCR(readTextDocument(host as unknown as DocumentHost, itemID, signal), signal), render = await renderer(host, itemID, signal)
  const parts: string[] = [], cache = new OCRCache(host)
  const fingerprint = await ocrHash(JSON.stringify([VERSION, config.engine, config.endpoint, config.model]))
  for (const region of regions) for (const rect of region.rects) {
    checkCancelled(signal)
    const page = await render.pdf.getPage(region.pageIndex + 1), image = await renderOCRImage(page, render.doc, signal, rect)
    const key = await ocrHash(JSON.stringify(['selection', base.source.libraryID, base.source.itemKey, fingerprint, region.pageIndex, rect, image]))
    const saved = await cache.read(key)
    if (saved.page?.paragraphs.length && !saved.page.warning) { parts.push(saved.page.paragraphs.map(p => p.text).join('\n')); continue }
    const result = await recognizeImage(config, image, { ...cloudIO(host, signal, progress), batchID: saved.batchID, saveBatch: id => cache.write(key, { batchID: id }) })
    const text = result.blocks.map(block => block.text).join('\n')
    if (!text.trim()) throw new CloudOCRError('EMPTY_RESULT')
    await cache.write(key, { page: projectCloudPage({ blocks: [{ text }] }, base.pages[region.pageIndex]) })
    parts.push(text)
  }
  await validateDocument(host as unknown as DocumentHost, base.source); checkCancelled(signal)
  if (!parts.join('').trim()) throw new CloudOCRError('EMPTY_RESULT')
  return parts.join('\n\n')
}
/** 设置测试只识别内置生成的小图，不获取 Reader 或用户文献。 */
export async function testCloudOCR(host: ZoteroLike, config: CloudOCRConfig, doc: Document, signal: AbortSignal) {
  const canvas = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas') as HTMLCanvasElement
  canvas.width = 480; canvas.height = 140
  const context = canvas.getContext('2d')!
  context.fillStyle = 'white'; context.fillRect(0, 0, 480, 140); context.fillStyle = 'black'; context.font = '32px sans-serif'; context.fillText('OCR Test 123 测试', 20, 75)
  return (await recognizeImage(config, canvas.toDataURL('image/png'), cloudIO(host, signal, () => {}))).blocks.map(block => block.text).join('\n')
}
