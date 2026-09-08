// Zotero 10 PDF 图片交互层：支持 SDT 图片/图注和手动框选，Reader 原生裁图只在用户确认后执行。
// 本模块独立注册 Reader 生命周期，不向原生顶部工具条或选区工具条插入任何节点。
import type { ChatImageInput } from "@/chat/image-input"
import type { FigureInterpretationAction } from "./reader-tools"
import { matchesReaderShortcut, readReaderShortcut } from "./reader-shortcuts"

export type { ChatImageInput } from "@/chat/image-input"
export type { FigureInterpretationAction } from "./reader-tools"

type Rect = [number, number, number, number]
type PageRect = [number, number, number, number, number]
type SDTRef = number[]
type SDTNode = {
  type?: string
  text?: string
  content?: unknown
  anchor?: { pageRects?: unknown }
  previousPart?: unknown
  nextPart?: unknown
}
type SDTPage = { viewRect?: unknown; label?: unknown }
type SDTStructure = { content?: unknown; catalog?: { pages?: unknown } }

const FIGURE_ACTIONS = [
  { conversationTarget: "new", label: "图片解读（开启新对话）" },
  { conversationTarget: "current", label: "图片解读（追加在当前对话）" },
] as const satisfies ReadonlyArray<{
  conversationTarget: FigureInterpretationAction["conversationTarget"]
  label: string
}>

export type SDTFigure = {
  ref: SDTRef
  pageIndex: number
  rect: Rect
  cropIndex: number
  caption?: string
}
type FigureSelection = SDTFigure | { manual: true; pageIndex: number; rect: Rect; caption?: undefined }

type Crop = {
  displayWidth?: number
  displayHeight?: number
  render?: () => Promise<string>
}
type PdfPageView = {
  div?: HTMLElement
  viewport?: {
    width?: number
    height?: number
    convertToPdfPoint?: (x: number, y: number) => unknown
    convertToViewportPoint?: (x: number, y: number) => unknown
    convertToViewportRectangle?: (rect: number[]) => unknown
  }
}
type PdfEventBus = {
  on?: (name: string, listener: (event?: unknown) => void) => void
  off?: (name: string, listener: (event?: unknown) => void) => void
}
type ReaderPdfView = {
  initializedPromise?: Promise<unknown>
  _iframeWindow?: Window & {
    PDFViewerApplication?: {
      pdfViewer?: {
        getPageView?: (pageIndex: number) => PdfPageView | undefined
        _pages?: PdfPageView[]
      }
      eventBus?: PdfEventBus
    }
  }
  createSDTBlockCropProvider?: (structure: SDTStructure) => (ref: SDTRef) => Crop[]
  _pdfRenderer?: { renderRegionCrops?: (pageIndex: number, rects: number[][]) => Promise<string[]> }
}
type ReaderInternal = {
  _lastViewPrimary?: boolean
  _state?: { tool?: { type?: string }; pageLabels?: unknown }
  _primaryView?: ReaderPdfView
  _secondaryView?: ReaderPdfView
  _loadSDT?: () => Promise<{ structure?: SDTStructure } | null>
}
type ReaderInstance = {
  itemID: number
  _initPromise?: Promise<unknown>
  _internalReader?: ReaderInternal
}
type ReaderEvent = { reader: ReaderInstance; doc: Document; append?: (element: HTMLElement) => void }
type ReaderHandler = (event: ReaderEvent) => void
type ZoteroItem = {
  parentItem?: ZoteroItem
  getField?: (field: string) => unknown
}

export type ZoteroFigureHost = {
  version?: string
  Prefs?: { get: (key: string) => unknown }
  Items?: { get?: (itemID: number) => unknown | Promise<unknown> }
  Reader?: {
    registerEventListener?: (type: "renderToolbar", handler: ReaderHandler, pluginID: string) => void
    unregisterEventListener?: (type: "renderToolbar", handler: ReaderHandler) => void
  }
}

const MAX_CAPTION_CHARS = 2_000
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_IMAGE_EDGE = 2_048
const FIGURE_PREFIX = /^(?:(?:figure|fig\.?|scheme|plate)\s*[\p{L}\p{N}]|图\s*[\d一二三四五六七八九十百])/iu
const TABLE_PREFIX = /^(?:table\b|表\s*[\d一二三四五六七八九十百])/iu

const FIGURE_CSS = `
[data-jadense-capture-surface] {
  position:fixed;z-index:9997;user-select:none;touch-action:none;
}
[data-jadense-capture-surface][hidden] {display:none;}
[data-jadense-capture-surface][data-state="armed"] {cursor:crosshair;}
[data-jadense-figure-overlay] {
  position:fixed;z-index:9998;box-sizing:border-box;pointer-events:none;
  border:2px solid #16cf8c;border-radius:4px;background:rgba(22,207,140,.035);
}
[data-jadense-figure-overlay][hidden] {display:none;}
[data-jadense-figure-actions] {
  position:absolute;right:4px;top:4px;display:flex;flex-direction:column;align-items:stretch;gap:4px;
  max-width:calc(100vw - 16px);pointer-events:none;
}
[data-jadense-figure-actions] > button {
  pointer-events:auto;appearance:none;box-sizing:border-box;
  min-height:28px;margin:0;padding:5px 9px;border:1px solid rgba(17,21,16,.16);border-radius:5px;
  color:#0d0d0d;background:#16cf8c;font:600 12px/1.3 system-ui,sans-serif;cursor:pointer;
  max-width:100%;box-shadow:0 2px 8px rgba(0,0,0,.14);text-align:start;white-space:normal;
}
[data-jadense-figure-overlay][data-state="hover"] > [data-jadense-figure-actions] {display:none;}
[data-jadense-figure-overlay][data-state="selecting"] > [data-jadense-figure-actions] {display:none;}
[data-jadense-capture], [data-jadense-capture] * {cursor:crosshair!important;user-select:none!important;}
[data-jadense-figure-actions] > [data-jadense-action="exitFigure"] {background:Canvas;color:CanvasText;}
[data-jadense-figure-actions] > button:hover:not(:disabled) {filter:brightness(.96);}
[data-jadense-figure-actions] > button:focus-visible {outline:2px solid CanvasText;outline-offset:2px;}
[data-jadense-figure-actions] > button:disabled {cursor:default;opacity:.7;}
[data-jadense-figure-notice] {
  position:fixed;z-index:9999;top:12px;right:12px;box-sizing:border-box;width:280px;max-width:calc(100vw - 24px);
  padding:9px 11px;border:1px solid var(--color-border,rgba(17,21,16,.16));border-radius:6px;
  color:var(--fill-primary,CanvasText);background:var(--material-background,Canvas);
  box-shadow:0 2px 8px rgba(0,0,0,.12);font:12px/1.6 system-ui,sans-serif;
}
[data-jadense-figure-notice][hidden] {display:none;}
`

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asNode(value: unknown): SDTNode | null {
  return isObject(value) ? value as SDTNode : null
}

function asRef(value: unknown): SDTRef | null {
  return Array.isArray(value) && value.length > 0 && value.every((part) => Number.isInteger(part) && part >= 0)
    ? [...value] as SDTRef
    : null
}

function refKey(ref: SDTRef) {
  return ref.join(".")
}

function getNode(structure: SDTStructure, ref: SDTRef): SDTNode | null {
  let content: unknown = structure.content
  let found: SDTNode | null = null
  for (const part of ref) {
    if (!Array.isArray(content)) return null
    const node = asNode(content[part])
    if (!node) return null
    found = node
    content = node.content
  }
  return found
}

function walkNodes(structure: SDTStructure): Array<{ ref: SDTRef; node: SDTNode; order: number }> {
  const found: Array<{ ref: SDTRef; node: SDTNode; order: number }> = []
  let blockOrder = 0
  const visit = (content: unknown, parent: SDTRef) => {
    if (!Array.isArray(content)) return
    for (const [index, value] of content.entries()) {
      const node = asNode(value)
      if (!node) continue
      const ref = [...parent, index]
      found.push({ ref, node, order: blockOrder })
      if (typeof node.type === "string" && node.type !== "text") blockOrder++
      visit(node.content, ref)
    }
  }
  visit(structure.content, [])
  return found
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(" ")
  const node = asNode(value)
  if (!node) return ""
  return [typeof node.text === "string" ? node.text : "", textOf(node.content)].filter(Boolean).join(" ")
}

function normalizedText(value: unknown): string {
  return textOf(value).replace(/\s+/gu, " ").trim()
}

function readPageRects(node: SDTNode): PageRect[] | null {
  const value = node.anchor?.pageRects
  if (!Array.isArray(value) || value.length === 0) return null
  const rects: PageRect[] = []
  for (const rect of value) {
    if (!Array.isArray(rect) || rect.length !== 5 || !rect.every(Number.isFinite)) return null
    const [pageIndex, x1, y1, x2, y2] = rect
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || !(x2 > x1) || !(y2 > y1)) return null
    rects.push([pageIndex, x1, y1, x2, y2])
  }
  return rects
}

function unionRects(rects: PageRect[]): Map<number, Rect> {
  const result = new Map<number, Rect>()
  for (const [pageIndex, x1, y1, x2, y2] of rects) {
    const current = result.get(pageIndex)
    result.set(pageIndex, current
      ? [Math.min(current[0], x1), Math.min(current[1], y1), Math.max(current[2], x2), Math.max(current[3], y2)]
      : [x1, y1, x2, y2])
  }
  return result
}

function validPage(structure: SDTStructure, pageIndex: number): { viewRect: Rect; height: number; label?: string } | null {
  const pages = structure.catalog?.pages
  if (!Array.isArray(pages)) return null
  const page = asNode(pages[pageIndex]) as SDTPage | null
  if (!page || !Array.isArray(page.viewRect) || page.viewRect.length !== 4 || !page.viewRect.every(Number.isFinite)) return null
  const [x1, y1, x2, y2] = page.viewRect
  if (!(x2 > x1) || !(y2 > y1)) return null
  return {
    viewRect: [x1, y1, x2, y2],
    height: y2 - y1,
    label: typeof page.label === "string" && page.label.trim() ? page.label.trim() : undefined,
  }
}

function fitRect(rect: Rect, page: Rect): Rect | null {
  const fitted: Rect = [
    Math.max(page[0], rect[0]), Math.max(page[1], rect[1]),
    Math.min(page[2], rect[2]), Math.min(page[3], rect[3]),
  ]
  return fitted[2] > fitted[0] && fitted[3] > fitted[1] ? fitted : null
}

function captionChains(
  structure: SDTStructure,
  nodes: Array<{ ref: SDTRef; node: SDTNode; order: number }>,
) {
  const byKey = new Map(nodes.map((entry) => [refKey(entry.ref), entry]))
  const seen = new Set<string>()
  const chains: Array<{ text: string; order: number; rects: Map<number, Rect> }> = []
  for (const entry of nodes) {
    if (entry.node.type !== "caption") continue
    let root = entry.ref
    const backwards = new Set<string>()
    while (true) {
      const key = refKey(root)
      if (backwards.has(key)) break
      backwards.add(key)
      const previous = asRef(getNode(structure, root)?.previousPart)
      if (!previous || getNode(structure, previous)?.type !== "caption") break
      root = previous
    }
    const rootKey = refKey(root)
    if (seen.has(rootKey)) continue
    seen.add(rootKey)

    const parts: Array<{ ref: SDTRef; node: SDTNode; order: number }> = []
    const forward = new Set<string>()
    let current: SDTRef | null = root
    while (current) {
      const key = refKey(current)
      if (forward.has(key)) break
      forward.add(key)
      const known = byKey.get(key)
      const node = known?.node ?? getNode(structure, current)
      if (!node || node.type !== "caption") break
      parts.push({ ref: current, node, order: known?.order ?? Number.MAX_SAFE_INTEGER })
      current = asRef(node.nextPart)
    }

    const text = parts.map(({ node }) => normalizedText(node.content ?? node.text)).filter(Boolean).join(" ").replace(/\s+/gu, " ").trim()
    if (!text || TABLE_PREFIX.test(text) || !FIGURE_PREFIX.test(text)) continue
    const perPage = new Map<number, Rect>()
    let invalid = false
    for (const { node } of parts) {
      const rects = readPageRects(node)
      if (!rects) { invalid = true; break }
      for (const [pageIndex, rect] of unionRects(rects)) {
        const currentRect = perPage.get(pageIndex)
        perPage.set(pageIndex, currentRect
          ? [Math.min(currentRect[0], rect[0]), Math.min(currentRect[1], rect[1]), Math.max(currentRect[2], rect[2]), Math.max(currentRect[3], rect[3])]
          : rect)
      }
    }
    if (!invalid && perPage.size) {
      chains.push({ text: text.slice(0, MAX_CAPTION_CHARS), order: Math.min(...parts.map(({ order }) => order)), rects: perPage })
    }
  }
  return chains
}

function chooseCaption(
  imageRect: Rect,
  imageOrder: number,
  pageIndex: number,
  pageHeight: number,
  captions: ReturnType<typeof captionChains>,
): string | undefined {
  const imageWidth = imageRect[2] - imageRect[0]
  const imageCenter = (imageRect[0] + imageRect[2]) / 2
  const maximumGap = Math.max(24, pageHeight * .06)
  const ranked: Array<{ text: string; below: boolean; gap: number; orderDistance: number }> = []
  for (const caption of captions) {
    const rect = caption.rects.get(pageIndex)
    if (!rect) continue
    const captionWidth = rect[2] - rect[0]
    const overlap = Math.min(imageRect[2], rect[2]) - Math.max(imageRect[0], rect[0])
    const centersAligned = Math.abs(imageCenter - (rect[0] + rect[2]) / 2) <= Math.max(18, Math.min(imageWidth, captionWidth) * .25)
    if (!(overlap > 0) && !centersAligned) continue
    const below = rect[3] <= imageRect[1]
    const above = rect[1] >= imageRect[3]
    if (!below && !above) continue
    const gap = below ? imageRect[1] - rect[3] : rect[1] - imageRect[3]
    if (gap > maximumGap) continue
    ranked.push({ text: caption.text, below, gap, orderDistance: Math.abs(caption.order - imageOrder) })
  }
  ranked.sort((a, b) => Number(b.below) - Number(a.below) || a.gap - b.gap || a.orderDistance - b.orderDistance)
  const best = ranked[0]
  const next = ranked[1]
  if (!best) return undefined
  if (next && best.below === next.below && Math.abs(best.gap - next.gap) < 2 && best.orderDistance === next.orderDistance) return undefined
  return best.text
}

/** 将不可信 SDT 容错投影为可命中的逐页图片；坏块只丢弃自身。 */
export function buildSDTFigureIndex(value: unknown): SDTFigure[] {
  if (!isObject(value)) return []
  const structure = value as SDTStructure
  const nodes = walkNodes(structure)
  const captions = captionChains(structure, nodes)
  const figures: SDTFigure[] = []
  for (const { ref, node, order } of nodes) {
    if (node.type !== "image") continue
    const rects = readPageRects(node)
    if (!rects) continue
    const pages = [...unionRects(rects)].sort(([a], [b]) => a - b)
    for (const [cropIndex, [pageIndex, rawRect]] of pages.entries()) {
      const page = validPage(structure, pageIndex)
      const rect = page && fitRect(rawRect, page.viewRect)
      if (!page || !rect) continue
      figures.push({
        ref: [...ref], pageIndex, rect, cropIndex,
        caption: chooseCaption(rect, order, pageIndex, page.height, captions),
      })
    }
  }
  return figures
}

function dataUrlInfo(dataUrl: string): { mimeType: "image/png" | "image/jpeg"; bytes: number } | null {
  const match = /^data:(image\/(?:png|jpeg));base64,([a-z\d+/]*={0,2})$/iu.exec(dataUrl)
  if (!match) return null
  const payload = match[2]
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return { mimeType: match[1].toLowerCase() as "image/png" | "image/jpeg", bytes: Math.floor(payload.length * 3 / 4) - padding }
}

async function loadDataImage(doc: Document, dataUrl: string): Promise<HTMLImageElement> {
  const ImageConstructor = doc.defaultView?.Image
  if (!ImageConstructor) throw new Error("Image unavailable")
  return new Promise((resolve, reject) => {
    const image = new ImageConstructor()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("Invalid image"))
    image.src = dataUrl
  })
}

/** 将 Reader PNG 约束到 AI 附件上限；超过上限时才进行有损降级。 */
export async function normalizeFigureImage(dataUrl: string, doc: Document, name = "figure.png"): Promise<ChatImageInput> {
  const source = dataUrlInfo(dataUrl)
  if (!source) throw new Error("Unsupported image data")
  const image = await loadDataImage(doc, dataUrl)
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) throw new Error("Empty image")
  if (Math.max(sourceWidth, sourceHeight) <= MAX_IMAGE_EDGE && source.bytes <= MAX_IMAGE_BYTES) {
    return { dataUrl, mimeType: source.mimeType, name: name.replace(/\.[^.]+$/u, source.mimeType === "image/png" ? ".png" : ".jpg") }
  }

  const canvas = doc.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Canvas unavailable")
  const edgeScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sourceWidth, sourceHeight))
  for (const reduction of [1, .8, .64, .5, .4]) {
    canvas.width = Math.max(1, Math.round(sourceWidth * edgeScale * reduction))
    canvas.height = Math.max(1, Math.round(sourceHeight * edgeScale * reduction))
    // 调整画布尺寸会重置绘图状态；每轮都恢复白底，避免透明 PNG 转 JPEG 时出现黑底。
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    if (reduction === 1) {
      const png = canvas.toDataURL("image/png")
      const pngInfo = dataUrlInfo(png)
      if (pngInfo?.mimeType === "image/png" && pngInfo.bytes <= MAX_IMAGE_BYTES) return { dataUrl: png, mimeType: "image/png", name: name.replace(/\.[^.]+$/u, ".png") }
    }
    for (const quality of [.9, .78, .65, .52]) {
      const jpeg = canvas.toDataURL("image/jpeg", quality)
      const jpegInfo = dataUrlInfo(jpeg)
      if (jpegInfo?.mimeType === "image/jpeg" && jpegInfo.bytes <= MAX_IMAGE_BYTES) return { dataUrl: jpeg, mimeType: "image/jpeg", name: name.replace(/\.[^.]+$/u, ".jpg") }
    }
  }
  throw new Error("Image exceeds limit")
}

function zoteroTenOrNewer(version: string | undefined) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version ?? "")
  if (!match) return false
  const [, major, minor, patch] = match.map(Number)
  return major > 10 || (major === 10 && (minor > 0 || patch >= 1))
}

function point(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
    ? [value[0], value[1]]
    : null
}

async function paperTitle(zotero: ZoteroFigureHost, itemID: number): Promise<string | undefined> {
  try {
    const attachment = await zotero.Items?.get?.(itemID) as ZoteroItem | undefined
    const value = (attachment?.parentItem ?? attachment)?.getField?.("title")
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

class FigureViewController {
  private readonly doc: Document
  private readonly viewer: NonNullable<NonNullable<NonNullable<ReaderPdfView["_iframeWindow"]>["PDFViewerApplication"]>["pdfViewer"]>
  private readonly eventBus?: PdfEventBus
  private readonly container: HTMLElement
  private readonly captureSurface: HTMLElement
  private readonly overlay: HTMLElement
  private readonly actionBar: HTMLElement
  private readonly buttons: HTMLButtonElement[]
  private readonly exitButton: HTMLButtonElement
  private readonly notice: HTMLElement
  private readonly style: HTMLStyleElement
  private readonly byPage = new Map<number, SDTFigure[]>()
  private readonly busListeners: Array<[string, (event?: unknown) => void]> = []
  private hovered?: SDTFigure
  private locked?: FigureSelection
  private captureArmed = false
  private captureStart?: { pageIndex: number; x: number; y: number }
  private dragStart?: { x: number; y: number }
  private dragged = false
  private busy = false
  private disposed = false
  private noticeTimer?: ReturnType<typeof setTimeout>
  private animationFrame?: number
  private toolObserver?: MutationObserver

  constructor(
    private readonly zotero: ZoteroFigureHost,
    private readonly reader: ReaderInstance,
    private readonly internal: ReaderInternal,
    private readonly view: ReaderPdfView,
    private structure: SDTStructure,
    figures: SDTFigure[],
    private readonly onAction: (action: FigureInterpretationAction) => void | Promise<void>,
    private readonly onDestroyed: () => void,
  ) {
    const win = view._iframeWindow!
    this.doc = win.document
    this.viewer = win.PDFViewerApplication!.pdfViewer!
    this.eventBus = win.PDFViewerApplication?.eventBus
    this.container = this.doc.getElementById("viewerContainer")!
    this.setFigures(structure, figures)

    this.style = this.doc.createElement("style")
    this.style.setAttribute("data-jadense-figure-style", "")
    this.style.textContent = FIGURE_CSS
    this.doc.head.append(this.style)
    // PDFView 的 window 捕获监听先于插件执行；用 viewerContainer 外的目标避免原生选文/注释起手。
    this.captureSurface = this.doc.createElement("div")
    this.captureSurface.setAttribute("data-jadense-capture-surface", "")
    this.captureSurface.setAttribute("aria-hidden", "true")
    this.captureSurface.hidden = true
    this.overlay = this.doc.createElement("div")
    this.overlay.setAttribute("data-jadense-figure-overlay", "")
    this.overlay.dataset.state = "hover"
    this.overlay.hidden = true
    this.actionBar = this.doc.createElement("div")
    this.actionBar.setAttribute("data-jadense-figure-actions", "")
    this.buttons = FIGURE_ACTIONS.map(({ conversationTarget, label }) => {
      const button = this.doc.createElement("button")
      button.type = "button"
      button.setAttribute("data-jadense-action", "interpretFigure")
      button.setAttribute("data-jadense-conversation-target", conversationTarget)
      button.setAttribute("aria-label", label)
      button.title = `Jadense · ${label}`
      button.textContent = label
      this.actionBar.append(button)
      return button
    })
    this.exitButton = this.doc.createElement("button")
    this.exitButton.type = "button"
    this.exitButton.setAttribute("data-jadense-action", "exitFigure")
    this.exitButton.setAttribute("aria-label", "退出图片解读")
    this.exitButton.title = "退出图片解读（Esc）"
    this.exitButton.textContent = "退出"
    this.actionBar.append(this.exitButton)
    this.overlay.append(this.actionBar)
    this.notice = this.doc.createElement("div")
    this.notice.setAttribute("data-jadense-figure-notice", "")
    this.notice.setAttribute("role", "status")
    this.notice.setAttribute("aria-live", "polite")
    this.notice.hidden = true
    this.doc.body.append(this.captureSurface, this.overlay, this.notice)

    this.container.addEventListener("pointerdown", this.handlePointerDown, true)
    this.container.addEventListener("pointermove", this.handlePointerMove, true)
    this.container.addEventListener("pointerleave", this.handlePointerLeave, true)
    this.container.addEventListener("pointercancel", this.handlePointerCancel, true)
    this.container.addEventListener("click", this.handleClick, true)
    this.container.addEventListener("scroll", this.schedulePosition, { passive: true })
    this.doc.addEventListener("keydown", this.handleKeyDown)
    this.doc.defaultView?.addEventListener("keydown", this.handleTabKeyDown, true)
    this.doc.defaultView?.addEventListener("pointerdown", this.handleCaptureDown, true)
    this.doc.defaultView?.addEventListener("pointermove", this.handleCaptureMove, true)
    this.doc.defaultView?.addEventListener("pointerup", this.handleCaptureUp, true)
    this.doc.defaultView?.addEventListener("pointercancel", this.handleCaptureCancel, true)
    for (const name of ["mousedown", "click", "contextmenu"]) this.doc.defaultView?.addEventListener(name, this.suppressCaptureMouse, true)
    this.doc.defaultView?.addEventListener("resize", this.schedulePosition)
    this.doc.defaultView?.addEventListener("pagehide", this.handlePageHide, { once: true })
    for (const button of [...this.buttons, this.exitButton]) {
      button.addEventListener("pointerdown", this.stopButtonEvent)
      button.addEventListener("mousedown", this.stopButtonEvent)
      button.addEventListener("click", this.handleButtonClick)
    }
    const Observer = this.doc.defaultView?.MutationObserver
    if (Observer) {
      try {
        this.toolObserver = new Observer(() => { if (!this.captureArmed && !this.isManualSelection() && !this.pointerTool()) this.clearSelection() })
        // Gecko 的 Observer 字典与嵌套字段必须属于被观察文档的 realm。
        const options: MutationObserverInit = new this.doc.defaultView!.Object()
        options.attributes = true
        options.attributeFilter = this.doc.defaultView!.Array.of("data-tool")
        this.toolObserver.observe(this.doc.body, options)
      } catch {
        this.toolObserver?.disconnect()
        this.toolObserver = undefined
      }
    }
    for (const name of ["updateviewarea", "pagerendered", "scalechanging", "rotationchanging"]) this.listenBus(name, this.schedulePosition)
    this.listenBus("pagechanging", this.handlePageChanging)
  }

  get isDisposed() { return this.disposed }
  get document() { return this.doc }

  setFigures(structure: SDTStructure, figures: SDTFigure[]) {
    this.structure = structure
    this.byPage.clear()
    if (!this.view.createSDTBlockCropProvider) return
    for (const figure of figures) {
      const list = this.byPage.get(figure.pageIndex) ?? []
      list.push(figure)
      this.byPage.set(figure.pageIndex, list)
    }
  }

  private isManualSelection() { return this.locked && "manual" in this.locked }

  private listenBus(name: string, listener: (event?: unknown) => void) {
    try {
      this.eventBus?.on?.(name, listener)
      this.busListeners.push([name, listener])
    } catch { /* optional private event bus */ }
  }

  private pointerTool() {
    const type = this.internal._state?.tool?.type ?? this.doc.body.dataset.tool
    return type === "pointer"
  }

  private pageView(pageIndex: number): PdfPageView | undefined {
    return this.viewer.getPageView?.(pageIndex) ?? this.viewer._pages?.[pageIndex]
  }

  private bounds(figure: FigureSelection) {
    const page = this.pageView(figure.pageIndex)
    const pageRect = page?.div?.getBoundingClientRect()
    const viewport = page?.viewport
    if (!pageRect || !viewport) return null
    let first: [number, number] | null = null
    let second: [number, number] | null = null
    try {
      first = point(viewport.convertToViewportPoint?.(figure.rect[0], figure.rect[1]))
      second = point(viewport.convertToViewportPoint?.(figure.rect[2], figure.rect[3]))
      if (!first || !second) {
        const converted = viewport.convertToViewportRectangle?.([...figure.rect])
        if (Array.isArray(converted) && converted.length >= 4) {
          first = point([converted[0], converted[1]])
          second = point([converted[2], converted[3]])
        }
      }
    } catch { return null }
    if (!first || !second) return null
    const pageLeft = Number.isFinite(pageRect.left) ? pageRect.left : pageRect.x
    const pageTop = Number.isFinite(pageRect.top) ? pageRect.top : pageRect.y
    if (!Number.isFinite(pageLeft) || !Number.isFinite(pageTop)) return null
    return {
      left: pageLeft + Math.min(first[0], second[0]),
      top: pageTop + Math.min(first[1], second[1]),
      right: pageLeft + Math.max(first[0], second[0]),
      bottom: pageTop + Math.max(first[1], second[1]),
    }
  }

  private hit(clientX: number, clientY: number, target: EventTarget | null): SDTFigure | undefined {
    let pageIndex: number | undefined
    const pageElement = target instanceof this.doc.defaultView!.Element ? target.closest(".page") as HTMLElement | null : null
    const pageNumber = Number(pageElement?.dataset.pageNumber)
    if (Number.isInteger(pageNumber) && pageNumber > 0) pageIndex = pageNumber - 1
    const candidates = pageIndex === undefined ? [...this.byPage.values()].flat() : this.byPage.get(pageIndex) ?? []
    return candidates
      .map((figure) => ({ figure, bounds: this.bounds(figure) }))
      .filter((entry): entry is { figure: SDTFigure; bounds: NonNullable<ReturnType<FigureViewController["bounds"]>> } => {
        const box = entry.bounds
        return !!box && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom
      })
      .sort((a, b) => (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top)
        - (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top))[0]?.figure
  }

  private show(figure: FigureSelection, state: "hover" | "locked" | "selecting") {
    const box = this.bounds(figure)
    if (!box) { this.overlay.hidden = true; return }
    this.overlay.dataset.state = state
    this.overlay.dataset.source = "manual" in figure ? "manual" : "automatic"
    this.overlay.dataset.pageIndex = String(figure.pageIndex)
    this.overlay.style.left = `${box.left}px`
    this.overlay.style.top = `${box.top}px`
    this.overlay.style.width = `${Math.max(1, box.right - box.left)}px`
    this.overlay.style.height = `${Math.max(1, box.bottom - box.top)}px`
    this.actionBar.style.left = "auto"
    this.actionBar.style.right = "4px"
    this.actionBar.style.top = box.top >= 72 ? "-68px" : "4px"
    this.overlay.hidden = false
    if (state === "locked") this.clampActionBar(box)
  }

  private clampActionBar(box: NonNullable<ReturnType<FigureViewController["bounds"]>>) {
    const win = this.doc.defaultView
    const viewportWidth = win?.innerWidth ?? 0
    const viewportHeight = win?.innerHeight ?? 0
    if (viewportWidth <= 16 || viewportHeight <= 16) return
    const maxWidth = viewportWidth - 16
    this.actionBar.style.maxWidth = `${maxWidth}px`
    const rect = this.actionBar.getBoundingClientRect()
    const width = Math.min(maxWidth, Math.max(1, rect.width || rect.right - rect.left))
    const height = Math.max(1, rect.height || rect.bottom - rect.top)
    const left = Math.max(8, Math.min(box.right - width - 4, viewportWidth - width - 8))
    const above = box.top - height - 4
    const preferredTop = above >= 8 ? above : box.top + 4
    const top = Math.max(8, Math.min(preferredTop, Math.max(8, viewportHeight - height - 8)))
    this.actionBar.style.left = `${left - box.left}px`
    this.actionBar.style.right = "auto"
    this.actionBar.style.top = `${top - box.top}px`
  }

  private clearSelection() {
    this.hovered = undefined
    this.locked = undefined
    this.overlay.hidden = true
    this.captureArmed = false
    this.captureStart = undefined
    this.dragStart = undefined
    this.dragged = false
    this.captureSurface.hidden = true
    this.container.removeAttribute("data-jadense-capture")
  }

  /** 命中层只覆盖当前 PDF 视口；锁定截图后继续隔离，退出时恢复原生交互。 */
  private positionCaptureSurface() {
    const box = this.container.getBoundingClientRect()
    this.captureSurface.style.left = `${box.left}px`
    this.captureSurface.style.top = `${box.top}px`
    this.captureSurface.style.width = `${Math.max(0, box.right - box.left)}px`
    this.captureSurface.style.height = `${Math.max(0, box.bottom - box.top)}px`
  }

  /** 手动区域存 PDF 坐标；缩放或旋转后仍裁同一块原文，不依赖 SDT 或屏幕像素。 */
  private capturePoint(pageIndex: number, clientX: number, clientY: number) {
    const page = this.pageView(pageIndex)
    const viewport = page?.viewport
    const box = page?.div?.getBoundingClientRect()
    if (!box || !viewport?.convertToPdfPoint) return null
    const x = Math.max(0, Math.min(viewport.width ?? box.right - box.left, clientX - box.left))
    const y = Math.max(0, Math.min(viewport.height ?? box.bottom - box.top, clientY - box.top))
    try { return point(viewport.convertToPdfPoint(x, y)) } catch { return null }
  }

  private handleCaptureDown = (event: PointerEvent) => {
    if (!this.captureArmed || !(event.target instanceof this.doc.defaultView!.Element)
      || !this.captureSurface.contains(event.target)) return
    this.stopButtonEvent(event)
    if (event.button !== 0 || event.isPrimary === false) return
    // 透明层本身不属于 PDF 页面；按实际坐标找到它下方的页，页间空白不能开始截图。
    const page = this.doc.elementsFromPoint(event.clientX, event.clientY)
      .map(node => node.closest(".page") as HTMLElement | null)
      .find(node => node && this.container.contains(node))
    const pageIndex = Number(page?.dataset.pageNumber) - 1
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || !this.capturePoint(pageIndex, event.clientX, event.clientY)) return
    this.captureStart = { pageIndex, x: event.clientX, y: event.clientY }
    this.locked = undefined
    this.overlay.hidden = true
    this.notice.hidden = true
  }

  private handleCaptureMove = (event: PointerEvent) => {
    if (!this.captureArmed || !this.captureStart) return
    this.stopButtonEvent(event)
    this.updateCaptureRegion(event)
  }

  private updateCaptureRegion(event: PointerEvent) {
    if (!this.captureStart) return
    const start = this.captureStart
    const first = this.capturePoint(start.pageIndex, start.x, start.y)
    const last = this.capturePoint(start.pageIndex, event.clientX, event.clientY)
    if (!first || !last) { this.clearSelection(); return }
    this.locked = { manual: true, pageIndex: start.pageIndex, rect: [
      Math.min(first[0], last[0]), Math.min(first[1], last[1]),
      Math.max(first[0], last[0]), Math.max(first[1], last[1]),
    ] }
    this.show(this.locked, "selecting")
  }

  private handleCaptureUp = (event: PointerEvent) => {
    if (!this.captureArmed || !this.captureStart) return
    // 原生按下监听即使跳过页面，也会设置按下标志；释放必须继续冒泡到 PDFView 完成清理。
    this.updateCaptureRegion(event)
    const box = this.locked && this.bounds(this.locked)
    this.captureStart = undefined
    if (!box || box.right - box.left < 5 || box.bottom - box.top < 5) {
      this.locked = undefined
      this.overlay.hidden = true
      this.showNotice("请在 PDF 页面内拖动框选图片，按 Esc 退出。")
      return
    }
    this.captureArmed = false
    this.captureSurface.dataset.state = "locked"
    this.container.removeAttribute("data-jadense-capture")
    this.show(this.locked!, "locked")
  }

  private handleCaptureCancel = () => { if (this.captureArmed) this.clearSelection() }

  private suppressCaptureMouse = (event: Event) => {
    if ((this.captureArmed || this.isManualSelection()) && event.target instanceof this.doc.defaultView!.Element
      && this.captureSurface.contains(event.target)) this.stopButtonEvent(event)
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (this.captureArmed || this.isManualSelection()) return
    this.dragStart = { x: event.clientX, y: event.clientY }
    this.dragged = false
  }

  private handlePointerMove = (event: PointerEvent) => {
    if (this.captureArmed || this.isManualSelection()) return
    if (this.dragStart && Math.hypot(event.clientX - this.dragStart.x, event.clientY - this.dragStart.y) > 5) this.dragged = true
    if (!this.pointerTool()) { this.clearSelection(); return }
    if (this.locked) { this.show(this.locked, "locked"); return }
    if (event.buttons !== 0) {
      this.hovered = undefined
      this.overlay.hidden = true
      return
    }
    this.hovered = this.hit(event.clientX, event.clientY, event.target)
    if (this.hovered) this.show(this.hovered, "hover")
    else this.overlay.hidden = true
  }

  private handlePointerLeave = () => {
    if (!this.locked) { this.hovered = undefined; this.overlay.hidden = true }
  }

  private handlePointerCancel = () => {
    this.dragStart = undefined
    this.dragged = false
  }

  private handleClick = (event: MouseEvent) => {
    if (this.captureArmed || this.isManualSelection()) return
    const wasDragged = this.dragged
    this.dragStart = undefined
    this.dragged = false
    if (wasDragged || !this.pointerTool()) return
    const figure = this.hit(event.clientX, event.clientY, event.target)
    if (!figure) { this.clearSelection(); return }
    event.preventDefault()
    event.stopPropagation()
    this.locked = figure
    this.hovered = undefined
    this.show(figure, "locked")
  }

  private stopButtonEvent = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }

  private handleButtonClick = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    // Gecko 事件 currentTarget 可与创建节点的 wrapper 不同；与解读按钮一致按动作属性识别。
    const button = event.currentTarget as HTMLButtonElement | null
    if (button?.getAttribute("data-jadense-action") === "exitFigure") { this.notice.hidden = true; this.clearSelection(); return }
    const conversationTarget = button?.getAttribute("data-jadense-conversation-target")
    if (!this.busy && this.locked && (conversationTarget === "new" || conversationTarget === "current")) {
      void this.submit(this.locked, conversationTarget)
    }
  }

  private async submit(figure: FigureSelection, conversationTarget: FigureInterpretationAction["conversationTarget"]) {
    this.busy = true
    for (const button of this.buttons) {
      button.disabled = true
      if (button.getAttribute("data-jadense-conversation-target") === conversationTarget) button.textContent = "处理中…"
    }
    try {
      const [dataUrl, title] = await Promise.all([this.renderCrop(figure), paperTitle(this.zotero, this.reader.itemID)])
      if (this.disposed || this.locked !== figure) return
      const image = await normalizeFigureImage(dataUrl, this.doc, `figure-page-${figure.pageIndex + 1}.png`)
      if (this.disposed || this.locked !== figure) return
      const catalogPage = validPage(this.structure, figure.pageIndex)
      const labels = this.internal._state?.pageLabels
      const stateLabel = Array.isArray(labels) && typeof labels[figure.pageIndex] === "string" ? labels[figure.pageIndex] : undefined
      await this.onAction({
        kind: "interpretFigure",
        conversationTarget,
        itemID: this.reader.itemID,
        pageIndex: figure.pageIndex,
        pageLabel: stateLabel ?? catalogPage?.label,
        caption: figure.caption,
        paperTitle: title,
        image,
      })
    } catch {
      if (!this.disposed && this.locked === figure) this.showNotice("图片解读未完成，请稍后重试。")
    } finally {
      this.busy = false
      this.buttons.forEach((button, index) => {
        button.disabled = false
        button.textContent = FIGURE_ACTIONS[index].label
      })
    }
  }

  private async renderCrop(figure: FigureSelection): Promise<string> {
    // 原生 renderer/provider 读取嵌套数组；每一层都必须属于 PDF iframe realm。
    const array = this.doc.defaultView!.Array
    if ("manual" in figure) {
      const renderer = this.view._pdfRenderer
      const images = await renderer?.renderRegionCrops?.(figure.pageIndex, array.of(array.of(...figure.rect)))
      if (!images?.[0]) throw new Error("Crop unavailable")
      return images[0]
    }
    const crop = this.view.createSDTBlockCropProvider?.(this.structure)(array.of(...figure.ref))?.[figure.cropIndex]
    if (!crop?.render) throw new Error("Crop unavailable")
    return crop.render()
  }

  private showNotice(message: string) {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.notice.textContent = message
    this.notice.hidden = false
    this.noticeTimer = setTimeout(() => { this.notice.hidden = true }, 5_000)
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    this.notice.hidden = true
    this.clearSelection()
  }

  handleCaptureShortcut(event: KeyboardEvent): boolean {
    if (!matchesReaderShortcut(event, readReaderShortcut(this.zotero, "capture"))) return false
    event.preventDefault()
    event.stopPropagation()
    if (this.busy) return true
    this.clearSelection()
    this.doc.defaultView?.focus?.()
    if (!this.view._pdfRenderer?.renderRegionCrops) { this.showNotice("当前阅读器暂不支持 PDF 截图。"); return true }
    this.captureArmed = true
    this.captureSurface.dataset.state = "armed"
    this.positionCaptureSurface()
    this.captureSurface.hidden = false
    this.container.setAttribute("data-jadense-capture", "")
    this.showNotice("请在 PDF 页面内拖动框选图片，按 Esc 退出。")
    return true
  }

  // Zotero PDFView 会接管原生 Tab 顺序；锁定图片时显式把焦点留给这组临时动作。
  private handleTabKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { this.handleKeyDown(event); return }
    if (this.handleCaptureShortcut(event)) return
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey
      || !this.locked || this.overlay.hidden || this.busy) return
    const buttons = [...this.buttons, this.exitButton]
    const current = buttons.indexOf(this.doc.activeElement as HTMLButtonElement)
    const next = current < 0
      ? event.shiftKey ? buttons.length - 1 : 0
      : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
    event.preventDefault()
    event.stopPropagation()
    buttons[next]?.focus()
  }

  private handlePageChanging = (event?: unknown) => {
    if (this.captureArmed) { this.clearSelection(); return }
    const pageNumber = isObject(event) && Number.isInteger(event.pageNumber) ? Number(event.pageNumber) : undefined
    const selected = this.locked ?? this.hovered
    if (pageNumber && selected && selected.pageIndex !== pageNumber - 1) this.clearSelection()
    else this.schedulePosition()
  }

  private schedulePosition = () => {
    if (this.captureStart) { this.clearSelection(); return }
    if (this.animationFrame !== undefined || this.disposed) return
    const win = this.doc.defaultView
    const run = () => {
      this.animationFrame = undefined
      if (!this.captureSurface.hidden) this.positionCaptureSurface()
      const figure = this.locked ?? this.hovered
      if (figure) this.show(figure, this.locked ? "locked" : "hover")
    }
    if (win?.requestAnimationFrame) this.animationFrame = win.requestAnimationFrame(run)
    else run()
  }

  private handlePageHide = () => {
    this.destroy()
    this.onDestroyed()
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    if (this.animationFrame !== undefined) this.doc.defaultView?.cancelAnimationFrame?.(this.animationFrame)
    this.container.removeEventListener("pointerdown", this.handlePointerDown, true)
    this.container.removeEventListener("pointermove", this.handlePointerMove, true)
    this.container.removeEventListener("pointerleave", this.handlePointerLeave, true)
    this.container.removeEventListener("pointercancel", this.handlePointerCancel, true)
    this.container.removeEventListener("click", this.handleClick, true)
    this.container.removeEventListener("scroll", this.schedulePosition)
    this.doc.removeEventListener("keydown", this.handleKeyDown)
    this.doc.defaultView?.removeEventListener("keydown", this.handleTabKeyDown, true)
    this.doc.defaultView?.removeEventListener("pointerdown", this.handleCaptureDown, true)
    this.doc.defaultView?.removeEventListener("pointermove", this.handleCaptureMove, true)
    this.doc.defaultView?.removeEventListener("pointerup", this.handleCaptureUp, true)
    this.doc.defaultView?.removeEventListener("pointercancel", this.handleCaptureCancel, true)
    for (const name of ["mousedown", "click", "contextmenu"]) this.doc.defaultView?.removeEventListener(name, this.suppressCaptureMouse, true)
    this.doc.defaultView?.removeEventListener("resize", this.schedulePosition)
    this.doc.defaultView?.removeEventListener("pagehide", this.handlePageHide)
    for (const button of [...this.buttons, this.exitButton]) {
      button.removeEventListener("pointerdown", this.stopButtonEvent)
      button.removeEventListener("mousedown", this.stopButtonEvent)
      button.removeEventListener("click", this.handleButtonClick)
    }
    this.toolObserver?.disconnect()
    for (const [name, listener] of this.busListeners) {
      try { this.eventBus?.off?.(name, listener) } catch { /* optional private event bus */ }
    }
    this.overlay.remove()
    this.captureSurface.remove()
    this.container.removeAttribute("data-jadense-capture")
    this.notice.remove()
    this.style.remove()
  }
}

class FigureReaderRuntime {
  private structure: SDTStructure = {}
  private figures: SDTFigure[] = []
  private readonly controllers = new Map<ReaderPdfView, FigureViewController>()
  private readonly pending = new Set<ReaderPdfView>()
  private readonly unsupported = new WeakSet<ReaderPdfView>()
  private observer?: MutationObserver
  private disposed = false

  constructor(
    private readonly zotero: ZoteroFigureHost,
    private readonly reader: ReaderInstance,
    private readonly outerDoc: Document,
    private readonly onAction: (action: FigureInterpretationAction) => void | Promise<void>,
    private readonly onDestroyed: () => void,
  ) {
    this.outerDoc.defaultView?.addEventListener("pagehide", this.handlePageHide, { once: true })
    this.outerDoc.defaultView?.addEventListener("keydown", this.handleOuterKeyDown, true)
    this.outerDoc.addEventListener("load", this.attachViews, true)
  }

  async start() {
    try {
      await this.reader._initPromise
      const internal = this.reader._internalReader
      if (this.disposed || !internal) return
      // 截图兜底先安装；SDT 加载慢、缺失或失败只影响自动识别。
      this.attachViews()
      const Observer = this.outerDoc.defaultView?.MutationObserver
      if (Observer && this.outerDoc.body) {
        try {
          this.observer = new Observer(() => this.attachViews())
          const options: MutationObserverInit = new this.outerDoc.defaultView!.Object()
          options.childList = true
          options.subtree = true
          this.observer.observe(this.outerDoc.body, options)
        } catch {
          this.observer?.disconnect()
          this.observer = undefined
        }
      }
      const loaded = await internal._loadSDT?.()
      if (this.disposed || !loaded?.structure) return
      this.structure = loaded.structure
      this.figures = buildSDTFigureIndex(this.structure)
      for (const controller of this.controllers.values()) controller.setFigures(this.structure, this.figures)
    } catch { /* SDT and Reader internals are optional */ }
  }

  private attachViews = () => {
    if (this.disposed) return
    const internal = this.reader._internalReader
    if (!internal) return
    const active = [internal._primaryView, internal._secondaryView].filter((view): view is ReaderPdfView => !!view)
    for (const [view, controller] of this.controllers) {
      if (!active.includes(view) || controller.isDisposed || controller.document !== view._iframeWindow?.document) {
        controller.destroy()
        this.controllers.delete(view)
      }
    }
    for (const view of active) {
      if (!this.controllers.has(view) && !this.pending.has(view) && !this.unsupported.has(view)) void this.attachView(view, internal)
    }
  }

  private async attachView(view: ReaderPdfView, internal: ReaderInternal) {
    this.pending.add(view)
    try {
      await view.initializedPromise
      if (this.disposed || this.controllers.has(view)
        || ![internal._primaryView, internal._secondaryView].includes(view)) return
      const win = view._iframeWindow
      const viewer = win?.PDFViewerApplication?.pdfViewer
      const container = win?.document?.getElementById("viewerContainer")
      if (!viewer || !container || (typeof view.createSDTBlockCropProvider !== "function"
        && typeof view._pdfRenderer?.renderRegionCrops !== "function")) {
        this.unsupported.add(view)
        return
      }
      const controller = new FigureViewController(
        this.zotero, this.reader, internal, view, this.structure, this.figures, this.onAction,
        () => queueMicrotask(this.attachViews),
      )
      this.controllers.set(view, controller)
    } catch { /* one broken view must not disable the other */ }
    finally { this.pending.delete(view) }
  }

  private handlePageHide = () => {
    this.destroy()
    this.onDestroyed()
  }

  private handleOuterKeyDown = (event: KeyboardEvent) => {
    const internal = this.reader._internalReader
    const view = internal?._lastViewPrimary === false ? internal._secondaryView ?? internal._primaryView : internal?._primaryView
    if (view) this.controllers.get(view)?.handleCaptureShortcut(event)
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true
    this.observer?.disconnect()
    this.outerDoc.defaultView?.removeEventListener("pagehide", this.handlePageHide)
    this.outerDoc.defaultView?.removeEventListener("keydown", this.handleOuterKeyDown, true)
    this.outerDoc.removeEventListener("load", this.attachViews, true)
    for (const controller of this.controllers.values()) controller.destroy()
    this.controllers.clear()
    this.pending.clear()
  }
}

/**
 * 注册独立的图片能力发现钩子。renderToolbar 只用于拿到 Reader 实例，绝不调用 event.append。
 */
export function registerReaderFigureTools(
  zotero: ZoteroFigureHost,
  pluginID: string,
  onAction: (action: FigureInterpretationAction) => void | Promise<void>,
): () => void {
  const register = zotero.Reader?.registerEventListener
  if (!register || !zoteroTenOrNewer(zotero.version)) return () => undefined
  const runtimes = new Map<ReaderInstance, FigureReaderRuntime>()
  let disposed = false
  const handler: ReaderHandler = (event) => {
    if (disposed || !event.reader || runtimes.has(event.reader)) return
    const runtime = new FigureReaderRuntime(zotero, event.reader, event.doc, onAction, () => runtimes.delete(event.reader))
    runtimes.set(event.reader, runtime)
    void runtime.start()
  }
  try {
    register.call(zotero.Reader, "renderToolbar", handler, pluginID)
  } catch {
    return () => undefined
  }
  return () => {
    if (disposed) return
    disposed = true
    try { zotero.Reader?.unregisterEventListener?.("renderToolbar", handler) } catch { /* optional Reader seam */ }
    for (const runtime of runtimes.values()) runtime.destroy()
    runtimes.clear()
  }
}
