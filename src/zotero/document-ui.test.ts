/** 浮窗交互的合成几何回归：覆盖标题拖动、四边缩放、视口约束、键盘等价操作和卸载。 */
import { describe, expect, it, vi } from "vitest"
import { makeTranslationWindowInteractive, translationGlassBackground } from "./document-ui"

class TestDocument extends EventTarget {
  defaultView = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 800 })
  createElementNS(_namespace: string, tagName: string) { return new TestElement(this, tagName) }
}
class TestElement extends EventTarget {
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  properties = new Map<string, string>()
  style = { left: "100px", top: "80px", width: "430px", height: "350px", right: "", setProperty: (name: string, value: string) => this.properties.set(name, value) }
  children: TestElement[] = []
  parent?: TestElement
  hidden = false
  clientLeft = 1
  clientTop = 1
  constructor(readonly ownerDocument: TestDocument, readonly tagName: string) { super() }
  setAttribute(key: string, value: string) { this.attributes.set(key, value) }
  append(child: TestElement) { this.children.push(child); child.parent = this }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) }
  contains(target: TestElement): boolean { return target === this || this.children.some(child => child.contains(target)) }
  querySelector(selector: string) { return this.children.find(child => child.tagName === selector) }
  closest(selector: string): TestElement | null {
    if (selector === "[data-jdx-resize]" ? Boolean(this.dataset.jdxResize) : selector.split(",").includes(this.tagName)) return this
    return this.parent?.closest(selector) ?? null
  }
  getBoundingClientRect() {
    const left = parseFloat(this.style.left), top = parseFloat(this.style.top)
    const width = parseFloat(this.style.width), height = parseFloat(this.style.height)
    return { left, top, width, height, right: left + width, bottom: top + height }
  }
  setPointerCapture = vi.fn(() => { throw new Error("synthetic pointer") })
}
function event(target: EventTarget, name: string, properties: Record<string, unknown>) {
  const value = new Event(name, { cancelable: true })
  for (const [key, entry] of Object.entries(properties)) Object.defineProperty(value, key, { value: entry })
  target.dispatchEvent(value)
  return value
}
function fixture() {
  const doc = new TestDocument(), root = new TestElement(doc, "aside"), header = new TestElement(doc, "header")
  const button = new TestElement(doc, "button"); root.append(header); header.append(button)
  const control = makeTranslationWindowInteractive(root as unknown as HTMLElement, header as unknown as HTMLElement)
  const down = (target: TestElement) => event(root, "pointerdown", { target, button: 0, pointerId: 1, clientX: 0, clientY: 0 })
  const move = (dx: number, dy: number) => event(doc, "pointermove", { pointerId: 1, clientX: dx, clientY: dy })
  const resize = (direction: string, dx: number, dy: number) => {
    down(root.children.find(child => child.dataset.jdxResize === direction)!); move(dx, dy); event(doc, "pointerup", {})
  }
  return { doc, root, header, button, control, down, move, resize }
}

describe("shared translation floating geometry", () => {
  it("moves a title drag, ignores interactive controls, and stops on pointer cancellation", () => {
    const f = fixture()
    f.down(f.button); f.move(200, 100)
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 100, top: 80 })
    f.down(f.header); f.move(100, 50)
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 200, top: 130, width: 430, height: 350 })
    event(f.doc, "pointercancel", {}); f.move(300, 300)
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 200, top: 130 })
    f.control.remove()
  })

  it("resizes from every edge while preserving the opposite anchor", () => {
    const f = fixture()
    f.resize("e", 70, 0)
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 100, width: 500 })
    f.resize("s", 0, 60)
    expect(f.root.getBoundingClientRect()).toMatchObject({ top: 80, height: 410 })
    f.resize("w", -40, 0)
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 60, right: 600, width: 540 })
    f.resize("n", 0, -30)
    expect(f.root.getBoundingClientRect()).toMatchObject({ top: 50, bottom: 490, height: 440 })
    f.resize("nw", -500, -500)
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 8, top: 8, right: 600, bottom: 490 })
    f.resize("se", 5000, 5000)
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 8, top: 8, right: 992, bottom: 792 })
    f.resize("se", -5000, -5000)
    expect(f.root.getBoundingClientRect()).toMatchObject({ width: 300, height: 220 })
    f.control.remove()
  })

  it("provides keyboard movement and resizing, clamps viewport changes, and cleans up listeners", () => {
    const f = fixture()
    event(f.header, "keydown", { key: "ArrowRight", target: f.header })
    event(f.header, "keydown", { key: "ArrowDown", shiftKey: true, target: f.header })
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 110, top: 80, height: 360 })
    f.doc.defaultView.innerWidth = 500
    f.doc.defaultView.innerHeight = 460
    event(f.doc.defaultView, "resize", {})
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 62, top: 80 })
    f.down(f.header)
    f.control.remove(); f.move(100, 100)
    event(f.header, "keydown", { key: "ArrowLeft", target: f.header })
    expect(f.root.getBoundingClientRect()).toMatchObject({ left: 62, top: 80 })
    expect(f.root.children).toEqual([f.header])
  })

  it("bounds the upward appearance menu to the actual floating height and large footer", () => {
    const f = fixture(), footer = new TestElement(f.doc, "footer")
    footer.style.height = "68px"; f.root.append(footer)
    f.resize("se", -500, -500)
    expect(f.root.getBoundingClientRect().height).toBe(220)
    expect(f.root.properties.get("--jdx-window-menu-max-height")).toBe("132px")
    f.resize("s", 0, 150)
    expect(f.root.properties.get("--jdx-window-menu-max-height")).toBe("282px")
    f.control.remove()
  })

  it("accepts a wrapped title target while leaving header form controls to their native keys", () => {
    const f = fixture()
    const wrappedHeader = { closest: () => null }
    event(f.header, "keydown", { key: "ArrowRight", shiftKey: true, target: wrappedHeader })
    expect(f.root.getBoundingClientRect().width).toBe(440)
    event(f.header, "keydown", { key: "ArrowRight", shiftKey: true, target: f.button })
    expect(f.root.getBoundingClientRect().width).toBe(440)
    f.control.remove()
  })

  it("aligns native live PDF backgrounds for both panes and releases removed frames without modifying them", () => {
    const doc = new TestDocument(), root = new TestElement(doc, "aside")
    const primary = new TestElement(doc, "iframe"), secondary = new TestElement(doc, "iframe")
    primary.style.left = "0px"; primary.style.top = "40px"; primary.style.width = "500px"
    secondary.style.left = "500px"; secondary.style.top = "40px"; secondary.style.width = "500px"
    let frames = [primary, secondary]
    const register = vi.fn()
    Object.assign(doc, { mozSetImageElement: register, querySelectorAll: () => frames })
    const control = translationGlassBackground(root as unknown as HTMLElement)
    const background = root.children[0], [first, second] = background.children
    expect(first.style).toMatchObject({ left: "-101px", top: "-41px", width: "500px" })
    expect(second.style.left).toBe("399px")
    expect(register.mock.calls.map(call => call[1])).toEqual([primary, secondary])
    expect(primary.attributes.size).toBe(0)
    root.style.left = "130px"; control.sync()
    expect(first.style.left).toBe("-131px")
    expect(register).toHaveBeenCalledTimes(2)
    frames = [primary]; control.sync()
    expect(background.children).toEqual([first])
    expect(register.mock.calls[2][1]).toBeNull()
    control.remove()
    expect(root.children).toEqual([])
    expect(register.mock.calls[3][1]).toBeNull()
  })
})
