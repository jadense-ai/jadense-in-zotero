/**
 * 插件窗口与 Zotero 宿主文档共用的短消息层。调用方提供目标 Document，
 * 本模块只管理该文档内的展示、计时和操作，不参与任务执行或权限判断。
 */
import { uiText } from "@/zotero/ui-preferences"

export type ToastPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right"
export type ToastType = "info" | "success" | "warning" | "error"
export type ToastAction = { label: string; onClick(): void | Promise<void>; closeOnClick?: boolean }
export type ToastAnchor = { left: number; top: number; width?: number; height?: number }
export type ToastInput = {
  document: Document
  themeRoot?: Element | null
  type?: ToastType
  message: string
  position?: ToastPosition
  duration?: number
  actions?: readonly ToastAction[]
  anchor?: ToastAnchor
  diagnosticId?: string
  onClose?(): void
}
export type ToastHandle = { close(): void }

type Entry = { node: HTMLElement; persistent: boolean; close(): void }
type Registry = { entries: Entry[]; stacks: Map<string, HTMLElement>; styleLink?: HTMLLinkElement; onUnload?: () => void }
const registries = new WeakMap<Document, Registry>()
const HTML_NS = "http://www.w3.org/1999/xhtml"
const MAX_VISIBLE = 3

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, name: K): HTMLElementTagNameMap[K] {
  return (typeof doc.createElementNS === "function" ? doc.createElementNS(HTML_NS, name) : doc.createElement(name)) as HTMLElementTagNameMap[K]
}

/** 六个方位保持固定名称；无效的可选位置只影响展示，回落到右下。 */
export function toastPosition(value: unknown): ToastPosition {
  return value === "top-left" || value === "top-center" || value === "top-right"
    || value === "bottom-left" || value === "bottom-center" || value === "bottom-right"
    ? value : "bottom-right"
}

function registry(doc: Document): Registry {
  let value = registries.get(doc)
  if (!value) {
    value = { entries: [], stacks: new Map() }
    value.onUnload = () => { for (const entry of [...value!.entries]) entry.close() }
    doc.defaultView?.addEventListener("unload", value.onUnload)
    registries.set(doc, value)
  }
  return value
}

function installStyles(doc: Document, state: Registry) {
  if (state.styleLink || doc.getElementById("jdx-toast-css")) return
  const link = element(doc, "link")
  link.id = "jdx-toast-css"
  link.rel = "stylesheet"
  link.href = "chrome://jadense-in-zotero/content/toast.css"
  ;(doc.head || doc.documentElement).append(link)
  state.styleLink = link
}

function copyTheme(source: Element | null | undefined, target: HTMLElement) {
  const view = source?.ownerDocument.defaultView
  if (!source || !view?.getComputedStyle) return
  const style = view.getComputedStyle(source)
  const read = (...names: string[]) => names.map(name => style.getPropertyValue(name).trim()).find(Boolean) || ""
  target.style.setProperty("--jdx-toast-surface", read("--jdx-surface", "--jdx-reader-background", "--jdx-pref-surface") || style.backgroundColor)
  target.style.setProperty("--jdx-toast-text", read("--jdx-text", "--jdx-reader-text", "--jdx-pref-text") || style.color)
  target.style.setProperty("--jdx-toast-muted", read("--jdx-muted", "--jdx-reader-muted", "--jdx-pref-muted") || style.color)
  target.style.setProperty("--jdx-toast-line", read("--jdx-line", "--jdx-reader-line", "--jdx-pref-line") || "currentColor")
  target.style.setProperty("--jdx-toast-green", read("--jdx-green-deep", "--jdx-pref-green-text") || "#0f9b6b")
  target.style.setProperty("--jdx-toast-font-scale", read("--jdx-font-scale") || "1")
  target.style.colorScheme = style.colorScheme
  target.style.font = style.font
}

/** 每条通知返回独立关闭句柄；duration=0 供可操作错误保持可读。 */
export function show(input: ToastInput): ToastHandle {
  const doc = input.document
  const state = registry(doc)
  installStyles(doc, state)
  const position = toastPosition(input.position)
  const key = input.anchor ? `anchor-${Math.random().toString(36).slice(2)}` : position
  let stack = state.stacks.get(key)
  if (!stack) {
    stack = element(doc, "div")
    stack.className = "jdx-toast-stack"
    stack.dataset.position = input.anchor ? "anchor" : position
    // 样式表在原生窗口异步加载；先固定到正确位置，避免短暂落在正文末尾。
    stack.style.position = "fixed"
    stack.style.zIndex = "2147483647"
    stack.style.display = "grid"
    stack.style.gap = "8px"
    stack.style.width = input.anchor ? "min(280px, calc(100vw - 16px))" : "min(360px, calc(100vw - 16px))"
    stack.style.pointerEvents = "none"
    if (!input.anchor) {
      stack.style[position.startsWith("top") ? "top" : "bottom"] = "12px"
      if (position.endsWith("center")) { stack.style.left = "50%"; stack.style.transform = "translateX(-50%)" }
      else stack.style[position.endsWith("left") ? "left" : "right"] = "12px"
    }
    ;(doc.body || doc.documentElement).append(stack)
    state.stacks.set(key, stack)
  }
  copyTheme(input.themeRoot ?? doc.documentElement, stack)
  if (input.anchor) {
    const width = doc.defaultView?.innerWidth ?? 960, height = doc.defaultView?.innerHeight ?? 640
    stack.style.left = `${Math.max(8, Math.min(input.anchor.left, width - 288))}px`
    stack.style.top = `${Math.max(8, Math.min(input.anchor.top + (input.anchor.height ?? 0) + 8, height - 80))}px`
  }

  const card = element(doc, "section")
  card.className = "jdx-toast"
  card.dataset.type = input.type ?? "info"
  card.setAttribute("role", input.type === "error" ? "alert" : "status")
  card.setAttribute("aria-live", input.type === "error" ? "assertive" : "polite")
  card.setAttribute("aria-atomic", "true")
  if (input.diagnosticId) card.dataset.diagnosticId = input.diagnosticId
  const message = element(doc, "div")
  message.className = "jdx-toast-message"
  message.textContent = input.message
  const closeButton = element(doc, "button")
  closeButton.type = "button"
  closeButton.className = "jdx-toast-close"
  closeButton.textContent = "×"
  closeButton.setAttribute("aria-label", uiText("关闭通知", "Dismiss notification"))
  card.append(message, closeButton)

  let timer: ReturnType<typeof setTimeout> | undefined
  let started = 0
  let remaining = input.duration ?? ((input.actions?.length ?? 0) > 0 ? 0 : 3500)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    card.remove()
    const index = state.entries.indexOf(entry)
    if (index >= 0) state.entries.splice(index, 1)
    if (!stack!.children.length) { stack!.remove(); state.stacks.delete(key) }
    if (!state.entries.length) {
      state.styleLink?.remove(); state.styleLink = undefined
      if (state.onUnload) doc.defaultView?.removeEventListener("unload", state.onUnload)
      registries.delete(doc)
    }
    input.onClose?.()
  }
  const entry: Entry = { node: card, persistent: remaining === 0, close }
  const startTimer = () => { if (remaining > 0) { clearTimeout(timer); started = Date.now(); timer = setTimeout(close, remaining) } }
  const pauseTimer = () => { if (timer) { clearTimeout(timer); timer = undefined; remaining = Math.max(1, remaining - (Date.now() - started)) } }
  closeButton.addEventListener("click", close)
  card.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); close() } })
  card.addEventListener("mouseenter", pauseTimer)
  card.addEventListener("mouseleave", startTimer)
  card.addEventListener("focusin", pauseTimer)
  card.addEventListener("focusout", event => { if (!card.contains(event.relatedTarget as Node | null)) startTimer() })
  if (input.actions?.length) {
    const actions = element(doc, "div")
    actions.className = "jdx-toast-actions"
    for (const action of input.actions) {
      const button = element(doc, "button")
      button.type = "button"
      button.textContent = action.label
      button.addEventListener("click", () => {
        try { void Promise.resolve(action.onClick()).catch(() => {}) } catch { /* 展示操作不改变原任务状态。 */ }
        if (action.closeOnClick !== false) close()
      })
      actions.append(button)
    }
    card.append(actions)
  }
  stack.append(card)
  state.entries.push(entry)
  while (state.entries.length > MAX_VISIBLE) (state.entries.find(item => !item.persistent && item !== entry) ?? state.entries[0]).close()
  startTimer()
  return { close }
}
