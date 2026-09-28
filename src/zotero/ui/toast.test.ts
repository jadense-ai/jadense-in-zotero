/** 跨文档 Toast 契约：方位、队列、计时、操作和 XUL 命名空间创建。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { show, toastPosition } from "./toast"

class ElementStub {
  children: ElementStub[] = []
  parent: ElementStub | null = null
  className = ""
  dataset: Record<string, string> = {}
  style = { left: "", top: "", colorScheme: "", font: "", setProperty: vi.fn() }
  textContent = ""
  id = ""
  type = ""
  rel = ""
  href = ""
  handlers = new Map<string, (event: { key?: string; relatedTarget?: ElementStub; stopPropagation(): void }) => void>()
  attributes = new Map<string, string>()
  constructor(readonly ownerDocument: DocumentStub, readonly tag: string) {}
  append(...nodes: ElementStub[]) { nodes.forEach(node => { node.parent = this; this.children.push(node) }) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  addEventListener(name: string, handler: (event: { key?: string; relatedTarget?: ElementStub; stopPropagation(): void }) => void) { this.handlers.set(name, handler) }
  emit(name: string, key?: string) { this.handlers.get(name)?.({ key, stopPropagation: vi.fn() }) }
  contains(node: ElementStub | null) { return node === this || this.children.some(child => child.contains(node)) }
}

class DocumentStub {
  head = new ElementStub(this, "head")
  body = new ElementStub(this, "body")
  documentElement = new ElementStub(this, "html")
  windowHandlers = new Map<string, () => void>()
  defaultView = { innerWidth: 800, innerHeight: 600,
    addEventListener: (name: string, handler: () => void) => { this.windowHandlers.set(name, handler) },
    removeEventListener: (name: string) => { this.windowHandlers.delete(name) } }
  namespaces: string[] = []
  createElement(name: string) { return new ElementStub(this, name) }
  createElementNS(namespace: string, name: string) { this.namespaces.push(namespace); return this.createElement(name) }
  getElementById(id: string) {
    const walk = (node: ElementStub): ElementStub | undefined => node.id === id ? node : node.children.map(walk).find(Boolean)
    return walk(this.head) ?? walk(this.body)
  }
  stack() { return this.body.children.find(node => node.className === "jdx-toast-stack") }
}

const asDoc = (value: DocumentStub) => value as unknown as Document
afterEach(() => vi.useRealTimers())

describe("document-scoped toast", () => {
  it("supports six positions and defaults unknown presentation values to bottom-right", () => {
    for (const position of ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const) {
      expect(toastPosition(position)).toBe(position)
      const positioned = new DocumentStub()
      const handle = show({ document: asDoc(positioned), message: position, position, duration: 0 })
      expect(positioned.stack()?.dataset.position).toBe(position)
      expect((positioned.stack()?.style as unknown as Record<string, string>)[position.startsWith("top") ? "top" : "bottom"]).toBe("12px")
      expect((positioned.stack()?.style as unknown as Record<string, string>)[position.endsWith("left") ? "left" : position.endsWith("right") ? "right" : "left"])
        .toBe(position.endsWith("center") ? "50%" : "12px")
      handle.close()
    }
    expect(toastPosition("future")).toBe("bottom-right")
    const doc = new DocumentStub()
    const handle = show({ document: asDoc(doc), message: "Saved" })
    expect(doc.stack()?.dataset.position).toBe("bottom-right")
    expect(doc.namespaces).toContain("http://www.w3.org/1999/xhtml")
    handle.close()
  })

  it("isolates windows, caps each queue at three, and removes its style after the last close", () => {
    const first = new DocumentStub(), second = new DocumentStub()
    const handles = Array.from({ length: 4 }, (_, index) => show({ document: asDoc(first), message: `Notice ${index}`, duration: 0 }))
    show({ document: asDoc(second), message: "Other window", duration: 0 })
    expect(first.stack()?.children).toHaveLength(3)
    expect(second.stack()?.children).toHaveLength(1)
    handles.forEach(handle => handle.close())
    expect(first.stack()).toBeUndefined()
    expect(first.head.children).toHaveLength(0)
    expect(second.stack()?.children).toHaveLength(1)
  })

  it("pauses on hover, dismisses with Escape, and keeps action errors until closed", async () => {
    vi.useFakeTimers()
    const doc = new DocumentStub()
    const action = vi.fn()
    show({ document: asDoc(doc), message: "Permission required", type: "error", actions: [{ label: "Settings", onClick: action }], duration: 0 })
    const card = doc.stack()!.children[0]
    expect(card.attributes.get("role")).toBe("alert")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(doc.stack()?.children).toHaveLength(1)
    card.children[2].children[0].emit("click")
    expect(action).toHaveBeenCalledOnce()
    expect(doc.stack()).toBeUndefined()

    show({ document: asDoc(doc), message: "Copied", duration: 3500 })
    const transient = doc.stack()!.children[0]
    transient.emit("mouseenter")
    await vi.advanceTimersByTimeAsync(4000)
    expect(doc.stack()).toBeTruthy()
    transient.emit("mouseleave")
    transient.emit("keydown", "Escape")
    expect(doc.stack()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("positions contextual notices inside the host viewport", () => {
    const doc = new DocumentStub()
    show({ document: asDoc(doc), message: "Select text", anchor: { left: 790, top: 580, height: 20 }, duration: 0 })
    expect(doc.stack()?.dataset.position).toBe("anchor")
    expect(doc.stack()?.style.left).toBe("512px")
    expect(doc.stack()?.style.top).toBe("520px")
  })

  it("cleans up persistent notices and listeners when a window unloads", () => {
    const doc = new DocumentStub()
    const onClose = vi.fn()
    show({ document: asDoc(doc), message: "Needs attention", duration: 0, onClose })
    doc.windowHandlers.get("unload")?.()
    expect(onClose).toHaveBeenCalledOnce()
    expect(doc.stack()).toBeUndefined()
    expect(doc.head.children).toHaveLength(0)
    expect(doc.windowHandlers.size).toBe(0)
  })
})
