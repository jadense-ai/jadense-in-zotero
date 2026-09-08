import { describe, expect, it, vi } from "vitest"
import {
  buildSDTFigureIndex,
  normalizeFigureImage,
  registerReaderFigureTools,
  type FigureInterpretationAction,
} from "./reader-figure-tools"

type Listener = (event: unknown) => void

class EventTargetStub {
  listeners = new Map<string, Set<Listener>>()
  addEventListener(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }
  removeEventListener(name: string, listener: Listener) { this.listeners.get(name)?.delete(listener) }
  emit(name: string, event: Record<string, unknown> = {}) {
    const payload = { preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: this, ...event }
    for (const listener of this.listeners.get(name) ?? []) listener(payload)
    return payload
  }
}

class ElementStub extends EventTargetStub {
  children: ElementStub[] = []
  parentElement: ElementStub | null = null
  attributes = new Map<string, string>()
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  hidden = false
  disabled = false
  textContent = ""
  title = ""
  type = ""
  className = ""
  width = 0
  height = 0
  removed = false
  rect = { left: 0, top: 0, right: 600, bottom: 800, x: 0, y: 0 }

  constructor(readonly ownerDocument: DocumentStub, readonly tagName: string) { super() }
  append(...children: ElementStub[]) {
    for (const child of children) { child.parentElement = this; this.children.push(child) }
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  removeAttribute(name: string) { this.attributes.delete(name) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  contains(node: ElementStub): boolean { return node === this || this.children.some(child => child.contains(node)) }
  getBoundingClientRect() { return this.rect }
  closest(selector: string): ElementStub | null {
    if (selector === ".page" && this.className.split(/\s+/u).includes("page")) return this
    if (selector.startsWith("#") && this.getAttribute("id") === selector.slice(1)) return this
    return this.parentElement?.closest(selector) ?? null
  }
  remove() {
    this.removed = true
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
    this.parentElement = null
  }
  focus() { this.ownerDocument.activeElement = this }
  getContext(_kind: string) { return this.ownerDocument.canvasContext }
  toDataURL(mimeType: string, quality?: number) { return this.ownerDocument.canvasOutput(mimeType, quality) }
}

class MutationObserverStub {
  static instances: MutationObserverStub[] = []
  disconnect = vi.fn()
  observe = vi.fn()
  constructor(readonly callback: () => void) { MutationObserverStub.instances.push(this) }
}

class WindowStub extends EventTargetStub {
  Array = { of: <T>(...values: T[]) => values }
  Object = Object
  Element = ElementStub
  MutationObserver = MutationObserverStub
  navigator = { platform: "Win32" }
  innerWidth = 900
  innerHeight = 700
  nextFrame = 0
  cancelledFrames = new Set<number>()
  document!: DocumentStub
  Image: new () => {
    naturalWidth: number
    naturalHeight: number
    width: number
    height: number
    onload: null | (() => void)
    onerror: null | (() => void)
    src: string
  }
  requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = ++this.nextFrame
    queueMicrotask(() => { if (!this.cancelledFrames.has(id)) callback(0) })
    return id
  }
  cancelAnimationFrame = (id: number) => { this.cancelledFrames.add(id) }

  constructor(width: number, height: number) {
    super()
    this.Image = class {
      naturalWidth = width
      naturalHeight = height
      width = width
      height = height
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      private value = ""
      set src(value: string) { this.value = value; queueMicrotask(() => this.onload?.()) }
      get src() { return this.value }
    }
  }
}

class DocumentStub extends EventTargetStub {
  head: ElementStub
  body: ElementStub
  defaultView: WindowStub
  activeElement: ElementStub | null = null
  canvasCreates = 0
  canvasContext = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() }
  canvasOutput: (mimeType: string, quality?: number) => string
  elementsFromPoint = vi.fn((_x: number, _y: number): ElementStub[] => [])

  constructor(options: { imageWidth?: number; imageHeight?: number; canvasOutput?: DocumentStub["canvasOutput"] } = {}) {
    super()
    this.defaultView = new WindowStub(options.imageWidth ?? 640, options.imageHeight ?? 480)
    this.defaultView.document = this
    this.head = new ElementStub(this, "head")
    this.body = new ElementStub(this, "body")
    this.canvasOutput = options.canvasOutput ?? ((mimeType) => `data:${mimeType};base64,cG5n`)
  }
  createElement(tagName: string) {
    if (tagName === "canvas") this.canvasCreates++
    return new ElementStub(this, tagName)
  }
  getElementById(id: string) {
    const visit = (node: ElementStub): ElementStub | null => {
      if (node.getAttribute("id") === id) return node
      for (const child of node.children) {
        const found = visit(child)
        if (found) return found
      }
      return null
    }
    return visit(this.body)
  }
}

class EventBusStub {
  listeners = new Map<string, Set<Listener>>()
  on(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) ?? new Set()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }
  off(name: string, listener: Listener) { this.listeners.get(name)?.delete(listener) }
  emit(name: string, event: unknown = {}) { for (const listener of this.listeners.get(name) ?? []) listener(event) }
}

function structure(content?: unknown[]) {
  return {
    catalog: { pages: [{ viewRect: [0, 0, 600, 800], label: "S1" }] },
    content: content ?? [
      { type: "image", anchor: { pageRects: [[0, 100, 400, 500, 700]] }, additive: "ignored" },
      {
        type: "caption",
        content: [{ type: "text", text: "Figure 1. Local evidence" }],
        anchor: { pageRects: [[0, 100, 360, 500, 390]] },
      },
    ],
  }
}

function viewFixture(doc = new DocumentStub()) {
  const container = doc.createElement("div")
  container.setAttribute("id", "viewerContainer")
  const page = doc.createElement("div")
  page.className = "page"
  page.dataset.pageNumber = "1"
  container.append(page)
  doc.body.append(container)
  doc.elementsFromPoint.mockImplementation((x, y) => {
    const rect = page.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? [page, container] : [container]
  })
  const eventBus = new EventBusStub()
  const render = vi.fn(async () => "data:image/png;base64,cG5n")
  const cropProvider = vi.fn(() => vi.fn(() => [{ displayWidth: 400, displayHeight: 300, render }]))
  const renderRegionCrops = vi.fn(async (_pageIndex: number, _rects: number[][]) => ["data:image/png;base64,cG5n"])
  const pageView = {
    div: page,
    viewport: {
      width: 600, height: 800,
      convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
      convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
    },
  }
  Object.assign(doc.defaultView, {
    PDFViewerApplication: {
      pdfViewer: { getPageView: (pageIndex: number) => pageIndex === 0 ? pageView : undefined, _pages: [pageView] },
      eventBus,
    },
  })
  return { doc, container, page, pageView, eventBus, render, cropProvider, renderRegionCrops, view: {
    initializedPromise: Promise.resolve(), _iframeWindow: doc.defaultView, createSDTBlockCropProvider: cropProvider,
    _pdfRenderer: { renderRegionCrops },
  } }
}

function readerFixture(options: { secondary?: boolean } = {}) {
  const outerDoc = new DocumentStub()
  const primary = viewFixture()
  const secondary = options.secondary ? viewFixture() : undefined
  const sdt = structure()
  const internal = {
    _state: { tool: { type: "pointer" }, pageLabels: ["i"] },
    _loadSDT: vi.fn(async () => ({ structure: sdt })),
    _primaryView: primary.view,
    ...(secondary ? { _secondaryView: secondary.view } : {}),
  }
  const reader = { itemID: 11, _initPromise: Promise.resolve(), _internalReader: internal }
  const register = vi.fn()
  const unregister = vi.fn()
  const zotero = {
    version: "10.0.1",
    Items: { get: vi.fn(async () => ({ parentItem: { getField: () => "Paper title" } })) },
    Reader: { registerEventListener: register, unregisterEventListener: unregister },
  }
  return { outerDoc, primary, secondary, sdt, internal, reader, register, unregister, zotero }
}

function findByAttribute(doc: DocumentStub, attribute: string) {
  return [...doc.head.children, ...doc.body.children].find((node) => node.attributes.has(attribute))
}

function captureShortcut(view: ReturnType<typeof viewFixture>, overrides: Record<string, unknown> = {}) {
  return view.doc.defaultView.emit("keydown", {
    target: view.page, key: "s", code: "KeyS", ctrlKey: true, altKey: true, metaKey: false, shiftKey: false,
    ...overrides,
  })
}

function captureRegion(view: ReturnType<typeof viewFixture>, start = [120, 180], end = [420, 360]) {
  const win = view.doc.defaultView
  const target = findByAttribute(view.doc, "data-jadense-capture-surface") ?? view.page
  const pointer = { pointerId: 1, pointerType: "mouse", isPrimary: true }
  const down = { target, button: 0, buttons: 1, detail: 1, clientX: start[0], clientY: start[1] }
  const move = { target, button: 0, buttons: 1, clientX: end[0], clientY: end[1] }
  win.emit("pointerdown", { ...down, ...pointer })
  win.emit("mousedown", down)
  win.emit("pointermove", { ...move, ...pointer })
  win.emit("mousemove", move)
  win.emit("pointerup", { ...move, ...pointer, buttons: 0 })
  win.emit("mouseup", { ...move, buttons: 0 })
  // The compatibility click after pointerup must leave the manually locked region intact.
  return win.emit("click", { ...move, buttons: 0, detail: 1 })
}

describe("SDT figure index", () => {
  it("combines caption parts and prefers a nearby caption below the image", () => {
    const indexed = buildSDTFigureIndex(structure([
      { type: "image", anchor: { pageRects: [[0, 100, 400, 500, 700]] } },
      {
        type: "caption", nextPart: [2], content: [{ text: "Figure 2." }],
        anchor: { pageRects: [[0, 100, 370, 500, 390]] },
      },
      {
        type: "caption", previousPart: [1], content: [{ text: "Accuracy improves." }],
        anchor: { pageRects: [[0, 100, 350, 500, 369]] },
      },
      {
        type: "caption", content: [{ text: "Figure 9. Above" }],
        anchor: { pageRects: [[0, 100, 710, 500, 730]] },
      },
    ]))

    expect(indexed).toEqual([expect.objectContaining({
      ref: [0], pageIndex: 0, rect: [100, 400, 500, 700], cropIndex: 0,
      caption: "Figure 2. Accuracy improves.",
    })])
  })

  it("follows nested previousPart and nextPart references", () => {
    const indexed = buildSDTFigureIndex(structure([{
      type: "section",
      content: [
        { type: "image", anchor: { pageRects: [[0, 100, 400, 500, 700]] } },
        {
          type: "caption", nextPart: [0, 2], content: [{ text: "Figure S1." }],
          anchor: { pageRects: [[0, 100, 370, 500, 390]] },
        },
        {
          type: "caption", previousPart: [0, 1], content: [{ text: "Nested reference." }],
          anchor: { pageRects: [[0, 100, 350, 500, 369]] },
        },
      ],
    }]))

    expect(indexed[0]).toMatchObject({ ref: [0, 0], caption: "Figure S1. Nested reference." })
  })

  it("drops table captions, ambiguous captions and malformed blocks without blocking other figures", () => {
    const indexed = buildSDTFigureIndex(structure([
      {
        type: "caption", content: [{ text: "Figure A. First" }],
        anchor: { pageRects: [[0, 100, 370, 500, 390]] },
      },
      { type: "image", anchor: { pageRects: [[0, 100, 400, 500, 700]] } },
      {
        type: "caption", content: [{ text: "Figure B. Second" }],
        anchor: { pageRects: [[0, 100, 370, 500, 390]] },
      },
      {
        type: "caption", content: [{ text: "Table 1. Excluded" }],
        anchor: { pageRects: [[0, 100, 395, 500, 399]] },
      },
      { type: "image", anchor: { pageRects: [[0, 0, "bad", 20, 20]] } },
    ]))

    expect(indexed).toHaveLength(1)
    expect(indexed[0].caption).toBeUndefined()
    expect(buildSDTFigureIndex({ content: "broken" })).toEqual([])
    expect(buildSDTFigureIndex(null)).toEqual([])
  })

  it("aligns crop indexes with Zotero's page-sorted crop provider", () => {
    const indexed = buildSDTFigureIndex({
      catalog: { pages: [
        { viewRect: [0, 0, 600, 800] },
        { viewRect: [0, 0, 600, 800] },
      ] },
      content: [{ type: "image", anchor: { pageRects: [
        [1, 20, 20, 120, 120],
        [0, 10, 10, 110, 110],
      ] } }],
    })

    expect(indexed.map(({ pageIndex, cropIndex }) => ({ pageIndex, cropIndex }))).toEqual([
      { pageIndex: 0, cropIndex: 0 },
      { pageIndex: 1, cropIndex: 1 },
    ])
  })
})

describe("figure image normalization", () => {
  it("keeps a small native PNG without creating a canvas", async () => {
    const doc = new DocumentStub()
    const image = await normalizeFigureImage("data:image/png;base64,cG5n", doc as unknown as Document)
    expect(image).toEqual({ dataUrl: "data:image/png;base64,cG5n", mimeType: "image/png", name: "figure.png" })
    expect(doc.canvasCreates).toBe(0)
  })

  it("downscales a large crop and falls back to bounded JPEG", async () => {
    const oversized = `data:image/png;base64,${"A".repeat(8_388_612)}`
    const doc = new DocumentStub({
      imageWidth: 4_096,
      imageHeight: 1_024,
      canvasOutput: (mimeType) => mimeType === "image/png" ? oversized : "data:image/jpeg;base64,anBlZw==",
    })
    const image = await normalizeFigureImage("data:image/png;base64,cG5n", doc as unknown as Document, "figure-page-3.png")
    const canvas = doc.body.children.find((child) => child.tagName === "canvas")
    expect(image.mimeType).toBe("image/jpeg")
    expect(image.dataUrl).toBe("data:image/jpeg;base64,anBlZw==")
    expect(image.name).toBe("figure-page-3.jpg")
    expect(canvas).toBeUndefined()
    expect(doc.canvasContext.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 2048, 512)
  })

  it("rejects malformed image input at the requested capability boundary", async () => {
    await expect(normalizeFigureImage("https://example.test/figure.png", new DocumentStub() as unknown as Document)).rejects.toThrow()
  })

  it("rejects a crop that remains above the attachment limit after every reduction", async () => {
    const oversizedPayload = "A".repeat(8_388_612)
    const doc = new DocumentStub({
      imageWidth: 4_096,
      imageHeight: 4_096,
      canvasOutput: (mimeType) => `data:${mimeType};base64,${oversizedPayload}`,
    })

    await expect(normalizeFigureImage(
      `data:image/png;base64,${oversizedPayload}`,
      doc as unknown as Document,
    )).rejects.toThrow("Image exceeds limit")
  })
})

describe("native Reader figure overlay", () => {
  it("isolates capture from earlier native mouse handlers and preserves release and text input after Exit or Escape", async () => {
    const fixture = readerFixture()
    const view = fixture.primary
    const win = view.doc.defaultView
    let nativeDown = false
    let nativeSelecting = false
    let nativeText = ""
    // Zotero 先在 window 捕获 mousedown，并按目标是否在 viewerContainer 内创建选文动作。
    win.addEventListener("mousedown", (event) => {
      nativeDown = true
      nativeSelecting = Boolean((event as { target: ElementStub }).target.closest("#viewerContainer"))
    })
    win.addEventListener("pointermove", () => { if (nativeSelecting) nativeText += "selected" })
    const cleanup = registerReaderFigureTools(fixture.zotero, "test", vi.fn())
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc })
    await vi.waitFor(() => expect(findByAttribute(view.doc, "data-jadense-figure-overlay")).toBeTruthy())
    const surface = findByAttribute(view.doc, "data-jadense-capture-surface")!
    const overlay = findByAttribute(view.doc, "data-jadense-figure-overlay")!
    expect(surface).toBeTruthy()
    expect(surface.hidden).toBe(true)
    expect(surface.parentElement).toBe(view.doc.body)
    expect(view.container.contains(surface)).toBe(false)
    // 原生释放处理位于 window 冒泡阶段，截图不能截断它或取消浏览器默认释放。
    const release = vi.fn((event: unknown) => {
      const payload = event as { preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> }
      expect(payload.preventDefault).not.toHaveBeenCalled()
      expect(payload.stopPropagation).not.toHaveBeenCalled()
      nativeDown = false
      nativeSelecting = false
    })
    win.addEventListener("pointerup", release)
    win.addEventListener("mouseup", release)
    for (const exit of [
      () => overlay.children[0].children[2].emit("click"),
      () => win.emit("keydown", { key: "Escape" }),
    ]) {
      nativeText = ""
      captureShortcut(view)
      expect(surface.hidden).toBe(false)
      captureRegion(view)
      expect(nativeDown).toBe(false)
      expect(nativeSelecting).toBe(false)
      expect(surface.hidden).toBe(false)
      expect(overlay.dataset.state).toBe("locked")
      win.emit("pointermove", { target: surface, buttons: 0, clientX: 450, clientY: 390 })
      expect(nativeText).toBe("")
      exit()
      expect(surface.hidden).toBe(true)
      expect(overlay.hidden).toBe(true)
      const down = win.emit("mousedown", { target: view.page, buttons: 1 })
      expect(down.preventDefault).not.toHaveBeenCalled()
      win.emit("pointermove", { target: view.page, buttons: 1, clientX: 450, clientY: 390 })
      expect(nativeText).toBe("selected")
      win.emit("pointerup", { target: view.page, buttons: 0 })
      expect(nativeDown).toBe(false)
      expect(nativeSelecting).toBe(false)
    }
    expect(release).toHaveBeenCalledTimes(6)
    cleanup()
    expect(surface.removed).toBe(true)
  })

  it("keeps the capture surface aligned on resize and ignores page gaps and tiny drags", async () => {
    const fixture = readerFixture()
    const view = fixture.primary
    view.container.rect = { left: 30, top: 40, right: 630, bottom: 640, x: 30, y: 40 }
    view.page.rect = { left: 100, top: 100, right: 500, bottom: 600, x: 100, y: 100 }
    const cleanup = registerReaderFigureTools(fixture.zotero, "test", vi.fn())
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc })
    await vi.waitFor(() => expect(findByAttribute(view.doc, "data-jadense-figure-overlay")).toBeTruthy())
    const surface = findByAttribute(view.doc, "data-jadense-capture-surface")!
    const overlay = findByAttribute(view.doc, "data-jadense-figure-overlay")!
    captureShortcut(view)
    expect(surface.style).toMatchObject({ left: "30px", top: "40px", width: "600px", height: "600px" })
    captureRegion(view, [40, 50], [300, 300])
    expect(overlay.hidden).toBe(true)
    expect(surface.hidden).toBe(false)
    captureRegion(view, [150, 150], [152, 152])
    expect(overlay.hidden).toBe(true)
    expect(view.container.getAttribute("data-jadense-capture")).toBe("")
    view.container.rect = { left: 45, top: 60, right: 745, bottom: 660, x: 45, y: 60 }
    view.doc.defaultView.emit("resize")
    await vi.waitFor(() => expect(surface.style).toMatchObject({ left: "45px", top: "60px", width: "700px", height: "600px" }))
    captureRegion(view, [150, 150], [300, 300])
    expect(overlay.dataset.state).toBe("locked")
    expect(surface.hidden).toBe(false)
    view.doc.defaultView.emit("keydown", { key: "Escape" })
    expect(surface.hidden).toBe(true)
    cleanup()
  })

  it("exits through an event currentTarget wrapper from another Reader compartment", async () => {
    const fixture = readerFixture()
    const onAction = vi.fn()
    const cleanup = registerReaderFigureTools(fixture.zotero, "test", onAction)
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc })
    await vi.waitFor(() => expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")).toBeTruthy())
    const overlay = findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")!
    captureShortcut(fixture.primary)
    captureRegion(fixture.primary)
    const exit = overlay.children[0].children[2]
    const eventWrapper = { getAttribute: (name: string) => exit.getAttribute(name) }
    exit.emit("click", { currentTarget: eventWrapper })
    expect(overlay.hidden).toBe(true)
    expect(fixture.primary.renderRegionCrops).not.toHaveBeenCalled()
    expect(onAction).not.toHaveBeenCalled()
    cleanup()
  })

  it("keeps SDT and manual capture available when optional observers fail and binds later split views on load", async () => {
    class BrokenObserver extends MutationObserverStub {
      observe = vi.fn(() => { throw new Error("Observer unavailable") })
    }
    const fixture = readerFixture()
    fixture.outerDoc.defaultView.MutationObserver = BrokenObserver
    fixture.primary.doc.defaultView.MutationObserver = BrokenObserver
    const onAction = vi.fn()
    const cleanup = registerReaderFigureTools(fixture.zotero, "test", onAction)
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc })
    await vi.waitFor(() => expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")).toBeTruthy())
    expect(fixture.internal._loadSDT).toHaveBeenCalledOnce()
    const overlay = findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")!
    fixture.primary.container.emit("pointermove", { target: fixture.primary.page, clientX: 200, clientY: 200, buttons: 0 })
    expect(overlay.hidden).toBe(false)
    expect(overlay.dataset.source).toBe("automatic")
    captureShortcut(fixture.primary)
    captureRegion(fixture.primary)
    overlay.children[0].children[0].emit("click")
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledOnce())
    const secondary = viewFixture()
    Object.assign(fixture.internal, { _secondaryView: secondary.view })
    fixture.outerDoc.emit("load")
    await vi.waitFor(() => expect(findByAttribute(secondary.doc, "data-jadense-figure-overlay")).toBeTruthy())
    captureShortcut(secondary)
    expect(secondary.container.getAttribute("data-jadense-capture")).toBe("")
    cleanup()
    expect(fixture.outerDoc.listeners.get("load")?.size).toBe(0)
  })

  it("routes a toolbar shortcut to the last active split view and releases outer listeners", async () => {
    const fixture = readerFixture({ secondary: true })
    const cleanup = registerReaderFigureTools(fixture.zotero, "test", vi.fn())
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc })
    await vi.waitFor(() => expect(findByAttribute(fixture.secondary!.doc, "data-jadense-figure-overlay")).toBeTruthy())
    Object.assign(fixture.internal, { _lastViewPrimary: false })
    const keyboard = { target: fixture.outerDoc.body, key: "s", code: "KeyS", ctrlKey: true, altKey: true, metaKey: false, shiftKey: false }
    const key = fixture.outerDoc.defaultView.emit("keydown", keyboard)
    expect(key.preventDefault).toHaveBeenCalledOnce()
    expect(fixture.secondary!.container.getAttribute("data-jadense-capture")).toBe("")
    expect(fixture.primary.container.getAttribute("data-jadense-capture")).toBeNull()
    fixture.secondary!.doc.defaultView.emit("keydown", { key: "Escape" })
    expect(fixture.secondary!.container.getAttribute("data-jadense-capture")).toBeNull()
    cleanup()
    expect([...fixture.outerDoc.defaultView.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  it.each(["missing", "rejected", "pending", "empty"])("captures in both PDF views with %s SDT without rendering or dispatching before confirmation", async (mode) => {
    const fixture = readerFixture({ secondary: true })
    if (mode === "missing") fixture.internal._loadSDT = undefined
    if (mode === "rejected") fixture.internal._loadSDT.mockRejectedValue(new Error("SDT unavailable"))
    if (mode === "pending") fixture.internal._loadSDT.mockReturnValue(new Promise(() => undefined))
    if (mode === "empty") fixture.internal._loadSDT.mockResolvedValue({ structure: structure([]) })
    fixture.primary.view.createSDTBlockCropProvider = undefined
    const onAction = vi.fn()
    const cleanup = registerReaderFigureTools(fixture.zotero, "test", onAction)
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc })
    for (const view of [fixture.primary, fixture.secondary!]) {
      await vi.waitFor(() => expect(findByAttribute(view.doc, "data-jadense-figure-overlay")).toBeTruthy())
      const overlay = findByAttribute(view.doc, "data-jadense-figure-overlay")!
      const key = captureShortcut(view)
      expect(key.preventDefault).toHaveBeenCalledOnce()
      expect(view.container.getAttribute("data-jadense-capture")).toBe("")
      const click = captureRegion(view)
      expect(click.preventDefault).toHaveBeenCalledOnce()
      expect(view.container.getAttribute("data-jadense-capture")).toBeNull()
      expect(overlay.dataset).toMatchObject({ state: "locked", source: "manual", pageIndex: "0" })
      expect(overlay.style).toMatchObject({ left: "120px", top: "180px", width: "300px", height: "180px" })
      const [newButton, currentButton, exit] = overlay.children[0].children
      expect(exit.getAttribute("data-jadense-action")).toBe("exitFigure")
      expect(view.renderRegionCrops).not.toHaveBeenCalled()
      expect(onAction).not.toHaveBeenCalled()
      view.doc.defaultView.emit("keydown", { key: "Tab", shiftKey: true })
      expect(view.doc.activeElement).toBe(exit)
      exit.emit("click")
      expect(overlay.hidden).toBe(true)
      captureShortcut(view)
      captureRegion(view)
      ;(view === fixture.primary ? newButton : currentButton).emit("click")
      await vi.waitFor(() => expect(view.renderRegionCrops).toHaveBeenCalledWith(0, [[120, 440, 420, 620]]))
      await vi.waitFor(() => expect(onAction).toHaveBeenCalled())
      expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: "interpretFigure", conversationTarget: view === fixture.primary ? "new" : "current", itemID: 11,
        pageIndex: 0, pageLabel: "i", caption: undefined, image: expect.objectContaining({ mimeType: "image/png" }),
      }))
      expect(view.cropProvider).not.toHaveBeenCalled()
      onAction.mockClear()
    }
    cleanup()
    for (const view of [fixture.primary, fixture.secondary!]) {
      expect([...view.doc.defaultView.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    }
  })

  it("keeps manual PDF coordinates aligned through rotation, clamps reverse drags to one page, and reads changed shortcuts", async () => {
    const fixture = readerFixture()
    const shortcut = { value: "Ctrl+Shift+Y" }
    Object.assign(fixture.zotero, { Prefs: { get: () => shortcut.value } })
    const onAction = vi.fn()
    const cleanup = registerReaderFigureTools(fixture.zotero, "test", onAction)
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc })
    await vi.waitFor(() => expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")).toBeTruthy())
    const view = fixture.primary
    const overlay = findByAttribute(view.doc, "data-jadense-figure-overlay")!
    expect(captureShortcut(view).preventDefault).not.toHaveBeenCalled()
    captureShortcut(view, { key: "Y", code: "KeyY", altKey: false, shiftKey: true })
    // Rotation 90° at 2x zoom with a page offset: inverse mapping must reach PDF points.
    view.page.rect = { left: 20, top: 30, right: 1620, bottom: 1230, x: 20, y: 30 }
    Object.assign(view.pageView.viewport, {
      width: 1600, height: 1200,
      convertToViewportPoint: (x: number, y: number) => [y * 2, x * 2],
      convertToPdfPoint: (x: number, y: number) => [y / 2, x / 2],
    })
    captureRegion(view, [420, 330], [-20, -40])
    expect(overlay.style).toMatchObject({ left: "20px", top: "30px", width: "400px", height: "300px" })
    Object.assign(view.pageView.viewport, {
      width: 600, height: 800,
      convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
      convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
    })
    view.eventBus.emit("rotationchanging")
    await vi.waitFor(() => expect(overlay.style).toMatchObject({ left: "20px", top: "630px", width: "150px", height: "200px" }))
    overlay.children[0].children[0].emit("click")
    await vi.waitFor(() => expect(view.renderRegionCrops).toHaveBeenCalledWith(0, [[0, 0, 150, 200]]))
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledOnce())
    view.eventBus.emit("pagechanging", { pageNumber: 2 })
    expect(overlay.hidden).toBe(true)
    shortcut.value = ""
    expect(captureShortcut(view, { key: "Y", code: "KeyY", altKey: false, shiftKey: true }).preventDefault).not.toHaveBeenCalled()
    cleanup()
  })

  it("cancels armed, interrupted, tiny and in-flight captures locally and removes view listeners on close", async () => {
    const fixture = readerFixture()
    const view = fixture.primary
    let finishCrop: (images: string[]) => void = () => undefined
    view.renderRegionCrops.mockImplementation(() => new Promise(resolve => { finishCrop = resolve }))
    const onAction = vi.fn()
    const cleanup = registerReaderFigureTools(fixture.zotero, "test", onAction)
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc })
    await vi.waitFor(() => expect(findByAttribute(view.doc, "data-jadense-figure-overlay")).toBeTruthy())
    const overlay = findByAttribute(view.doc, "data-jadense-figure-overlay")!
    const surface = findByAttribute(view.doc, "data-jadense-capture-surface")!
    for (const cancel of [
      () => view.doc.defaultView.emit("keydown", { key: "Escape" }),
      () => view.doc.defaultView.emit("pointercancel"),
      () => view.eventBus.emit("scalechanging"),
    ]) {
      captureShortcut(view)
      view.doc.defaultView.emit("pointerdown", { target: surface, button: 0, clientX: 100, clientY: 100 })
      cancel()
      expect(view.container.getAttribute("data-jadense-capture")).toBeNull()
      expect(overlay.hidden).toBe(true)
      expect(surface.hidden).toBe(true)
    }
    captureShortcut(view)
    captureRegion(view, [100, 100], [102, 102])
    expect(overlay.hidden).toBe(true)
    expect(view.container.getAttribute("data-jadense-capture")).toBe("")
    captureRegion(view)
    const cloneArray = vi.spyOn(view.doc.defaultView.Array, "of")
    overlay.children[0].children[0].emit("click")
    expect(cloneArray).toHaveBeenCalledWith(120, 440, 420, 620)
    expect(cloneArray).toHaveBeenCalledWith([120, 440, 420, 620])
    overlay.children[0].children[2].emit("click")
    finishCrop(["data:image/png;base64,cG5n"])
    await Promise.resolve()
    await Promise.resolve()
    expect(onAction).not.toHaveBeenCalled()
    view.doc.defaultView.emit("pagehide")
    expect([...view.doc.defaultView.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
    expect(overlay.removed).toBe(true)
    expect(surface.removed).toBe(true)
    cleanup()
  })

  it("uses renderToolbar only for discovery and handles hover, lock, crop, action and cleanup in both views", async () => {
    const fixture = readerFixture({ secondary: true })
    const readerRealmRef = [0]
    const cloneRef = vi.fn(() => readerRealmRef)
    fixture.primary.doc.defaultView.Array.of = cloneRef
    const provideCrops = vi.fn(() => [{ displayWidth: 400, displayHeight: 300, render: fixture.primary.render }])
    fixture.primary.cropProvider.mockReturnValue(provideCrops)
    const readerTabHandler = vi.fn((event: unknown) => {
      const keyboard = event as { key?: string; preventDefault?: () => void }
      if (keyboard.key === "Tab") keyboard.preventDefault?.()
    })
    fixture.primary.doc.defaultView.addEventListener("keydown", readerTabHandler)
    const onAction = vi.fn(async (_action: FigureInterpretationAction) => undefined)
    const cleanup = registerReaderFigureTools(fixture.zotero, "test@jadense", onAction)

    expect(fixture.register).toHaveBeenCalledWith("renderToolbar", expect.any(Function), "test@jadense")
    const append = vi.fn()
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc, append })
    await vi.waitFor(() => expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")).toBeTruthy())
    await vi.waitFor(() => expect(findByAttribute(fixture.secondary!.doc, "data-jadense-figure-overlay")).toBeTruthy())
    expect(append).not.toHaveBeenCalled()

    const overlay = findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")!
    const actions = overlay.children[0]
    actions.rect = { left: 0, top: 0, right: 220, bottom: 64, x: 0, y: 0 }
    const [newConversationButton, currentConversationButton] = actions.children
    fixture.primary.container.emit("pointermove", { target: fixture.primary.page, clientX: 200, clientY: 200, buttons: 0 })
    expect(overlay.hidden).toBe(false)
    expect(overlay.dataset).toMatchObject({ state: "hover", pageIndex: "0" })
    expect(overlay.style).toMatchObject({ left: "100px", top: "100px", width: "400px", height: "300px" })

    const click = fixture.primary.container.emit("click", { target: fixture.primary.page, clientX: 200, clientY: 200 })
    expect(click.preventDefault).toHaveBeenCalledOnce()
    expect(overlay.dataset.state).toBe("locked")
    expect(actions.attributes.get("data-jadense-figure-actions")).toBe("")
    expect(newConversationButton.attributes.get("data-jadense-action")).toBe("interpretFigure")
    expect(newConversationButton.attributes.get("data-jadense-conversation-target")).toBe("new")
    expect(newConversationButton.attributes.get("aria-label")).toBe("图片解读（开启新对话）")
    expect(newConversationButton.textContent).toBe("图片解读（开启新对话）")
    expect(currentConversationButton.attributes.get("data-jadense-action")).toBe("interpretFigure")
    expect(currentConversationButton.attributes.get("data-jadense-conversation-target")).toBe("current")
    expect(currentConversationButton.attributes.get("aria-label")).toBe("图片解读（追加在当前对话）")
    expect(currentConversationButton.textContent).toBe("图片解读（追加在当前对话）")
    expect(actions.style).toMatchObject({ left: "176px", right: "auto", top: "-68px", maxWidth: "884px" })
    const firstTab = fixture.primary.doc.defaultView.emit("keydown", { key: "Tab", shiftKey: false })
    expect(readerTabHandler).toHaveBeenCalled()
    expect(firstTab.stopPropagation).toHaveBeenCalled()
    expect(fixture.primary.doc.activeElement).toBe(newConversationButton)
    fixture.primary.doc.defaultView.emit("keydown", { key: "Tab", shiftKey: false })
    expect(fixture.primary.doc.activeElement).toBe(currentConversationButton)
    fixture.primary.doc.defaultView.emit("keydown", { key: "Tab", shiftKey: true })
    expect(fixture.primary.doc.activeElement).toBe(newConversationButton)
    newConversationButton.emit("click")
    expect(newConversationButton.disabled).toBe(true)
    expect(currentConversationButton.disabled).toBe(true)
    expect(newConversationButton.textContent).toBe("处理中…")
    newConversationButton.emit("click")
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(newConversationButton.textContent).toBe("图片解读（开启新对话）"))
    expect(newConversationButton.disabled).toBe(false)
    expect(currentConversationButton.disabled).toBe(false)
    expect(currentConversationButton.textContent).toBe("图片解读（追加在当前对话）")
    expect(fixture.primary.cropProvider).toHaveBeenCalledOnce()
    expect(cloneRef).toHaveBeenCalledWith(0)
    expect(provideCrops).toHaveBeenCalledWith(readerRealmRef)
    expect(onAction).toHaveBeenNthCalledWith(1, {
      kind: "interpretFigure",
      conversationTarget: "new",
      itemID: 11,
      pageIndex: 0,
      pageLabel: "i",
      caption: "Figure 1. Local evidence",
      paperTitle: "Paper title",
      image: { dataUrl: "data:image/png;base64,cG5n", mimeType: "image/png", name: "figure-page-1.png" },
    })
    currentConversationButton.emit("click")
    currentConversationButton.emit("click")
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(currentConversationButton.textContent).toBe("图片解读（追加在当前对话）"))
    expect(onAction).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: "interpretFigure",
      conversationTarget: "current",
    }))
    expect(fixture.primary.cropProvider).toHaveBeenCalledTimes(2)

    fixture.primary.page.rect = { left: -300, top: 0, right: 300, bottom: 800, x: -300, y: 0 }
    fixture.primary.eventBus.emit("updateviewarea")
    await vi.waitFor(() => expect(overlay.style.left).toBe("-200px"))
    expect(Number.parseFloat(overlay.style.left) + Number.parseFloat(actions.style.left)).toBe(8)
    fixture.primary.page.rect = { left: 700, top: 0, right: 1_300, bottom: 800, x: 700, y: 0 }
    fixture.primary.eventBus.emit("updateviewarea")
    await vi.waitFor(() => expect(overlay.style.left).toBe("800px"))
    expect(Number.parseFloat(overlay.style.left) + Number.parseFloat(actions.style.left)).toBe(672)
    fixture.primary.page.rect = { left: 20, top: 30, right: 620, bottom: 830, x: 20, y: 30 }
    fixture.primary.eventBus.emit("updateviewarea")
    await vi.waitFor(() => expect(overlay.style.left).toBe("120px"))
    fixture.primary.eventBus.emit("pagechanging", { pageNumber: 2 })
    expect(overlay.hidden).toBe(true)

    cleanup()
    fixture.primary.doc.defaultView.removeEventListener("keydown", readerTabHandler)
    expect(fixture.primary.doc.defaultView.listeners.get("keydown")?.size ?? 0).toBe(0)
    expect(fixture.unregister).toHaveBeenCalledWith("renderToolbar", fixture.register.mock.calls[0][1])
    expect(overlay.removed).toBe(true)
    expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-style")).toBeUndefined()
    expect([...fixture.primary.eventBus.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
  })

  it("ignores annotation tools and drags, clears with Escape, and contains callback failures", async () => {
    const fixture = readerFixture()
    const cleanup = registerReaderFigureTools(fixture.zotero, "test@jadense", vi.fn(async () => { throw new Error("manager unavailable") }))
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc, append: vi.fn() })
    await vi.waitFor(() => expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")).toBeTruthy())
    const overlay = findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")!

    fixture.internal._state.tool.type = "highlight"
    fixture.primary.container.emit("pointermove", { target: fixture.primary.page, clientX: 200, clientY: 200, buttons: 0 })
    expect(overlay.hidden).toBe(true)
    fixture.internal._state.tool.type = "pointer"
    fixture.primary.container.emit("pointerdown", { target: fixture.primary.page, clientX: 150, clientY: 150 })
    fixture.primary.container.emit("pointermove", { target: fixture.primary.page, clientX: 170, clientY: 170, buttons: 1 })
    fixture.primary.container.emit("click", { target: fixture.primary.page, clientX: 170, clientY: 170 })
    expect(overlay.hidden).toBe(true)

    fixture.primary.container.emit("click", { target: fixture.primary.page, clientX: 200, clientY: 200 })
    expect(overlay.hidden).toBe(false)
    fixture.primary.doc.emit("keydown", { key: "Escape" })
    expect(overlay.hidden).toBe(true)
    fixture.primary.container.emit("click", { target: fixture.primary.page, clientX: 200, clientY: 200 })
    overlay.children[0].children[0].emit("click")
    const notice = findByAttribute(fixture.primary.doc, "data-jadense-figure-notice")!
    await vi.waitFor(() => expect(notice.hidden).toBe(false))
    expect(notice.textContent).toBe("图片解读未完成，请稍后重试。")
    cleanup()
  })

  it("does not dispatch after the Reader closes while image decoding is pending", async () => {
    const fixture = readerFixture()
    let finishImage: (() => void) | undefined
    fixture.primary.doc.defaultView.Image = class {
      naturalWidth = 640
      naturalHeight = 480
      width = 640
      height = 480
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      set src(_value: string) { finishImage = () => this.onload?.() }
    }
    const onAction = vi.fn()
    const cleanup = registerReaderFigureTools(fixture.zotero, "test@jadense", onAction)
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc, append: vi.fn() })
    await vi.waitFor(() => expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")).toBeTruthy())
    const overlay = findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")!
    fixture.primary.container.emit("click", { target: fixture.primary.page, clientX: 200, clientY: 200 })
    overlay.children[0].children[0].emit("click")
    await vi.waitFor(() => expect(finishImage).toBeTypeOf("function"))

    fixture.outerDoc.defaultView.emit("pagehide")
    finishImage?.()
    await Promise.resolve()
    expect(onAction).not.toHaveBeenCalled()
    cleanup()
  })

  it("stops retrying a view after its crop capability is found missing", async () => {
    const fixture = readerFixture()
    let initializationReads = 0
    Object.defineProperty(fixture.primary.view, "initializedPromise", {
      configurable: true,
      get() { initializationReads += 1; return Promise.resolve() },
    })
    fixture.primary.view.createSDTBlockCropProvider = undefined
    fixture.primary.view._pdfRenderer = undefined
    const cleanup = registerReaderFigureTools(fixture.zotero, "test@jadense", vi.fn())
    const observerStart = MutationObserverStub.instances.length
    fixture.register.mock.calls[0][1]({ reader: fixture.reader, doc: fixture.outerDoc, append: vi.fn() })
    await vi.waitFor(() => expect(initializationReads).toBe(1))
    await Promise.resolve()
    const outerObserver = MutationObserverStub.instances.slice(observerStart)[0]
    outerObserver.callback()
    outerObserver.callback()
    await Promise.resolve()

    expect(initializationReads).toBe(1)
    expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")).toBeUndefined()
    cleanup()
  })

  it("stays unavailable on Zotero 8/9 or when Reader hooks are missing", () => {
    const register = vi.fn()
    expect(() => registerReaderFigureTools({ version: "9.0.5", Reader: { registerEventListener: register } }, "test", vi.fn())()).not.toThrow()
    expect(register).not.toHaveBeenCalled()
    expect(() => registerReaderFigureTools({ version: "10.0.1" }, "test", vi.fn())()).not.toThrow()
  })

  it("releases a closed Reader runtime before plugin shutdown", async () => {
    const fixture = readerFixture()
    const cleanup = registerReaderFigureTools(fixture.zotero, "test@jadense", vi.fn())
    const handler = fixture.register.mock.calls[0][1]
    handler({ reader: fixture.reader, doc: fixture.outerDoc, append: vi.fn() })
    await vi.waitFor(() => expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")).toBeTruthy())

    fixture.outerDoc.defaultView.emit("pagehide")
    expect(findByAttribute(fixture.primary.doc, "data-jadense-figure-overlay")).toBeUndefined()
    handler({ reader: fixture.reader, doc: fixture.outerDoc, append: vi.fn() })
    await vi.waitFor(() => expect(fixture.internal._loadSDT).toHaveBeenCalledTimes(2))
    cleanup()
  })
})
