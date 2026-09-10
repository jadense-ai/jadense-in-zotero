/** 选文浮窗与翻译历史兼容入口：全文交给连续阅读组件，执行与存储归文档任务。 */
import { updateChatMarkdown } from "@/chat/markdown"
import { readTranslationHistory, type TranslationRecord } from "@/chat/translation-history"
import { translationLanguageDisplayLabel as translationLanguageLabel } from "@/chat/translation-languages"
import { documentJobs } from "./document-jobs"
import type { DocumentTask } from "./document-store"
import { mountTranslationReader } from "./translation-reader"
import { copyTextToClipboard } from "./connection-display"
import { READER_UI_THEME_CSS } from "./reader-ui-theme"
import type { ZoteroLike } from "./runtime"
import { observeTheme, translationOpacityControl, translationStyleControl, uiText } from "./ui-preferences"
import { openTranslationSidebar, removeReaderDock, type ReaderSidebarSource } from "./reader-sidebar"

const CSS = `${READER_UI_THEME_CSS}
.jdx-document {color:var(--jdx-reader-text);background:var(--jdx-reader-background);font:calc(13px * var(--jdx-font-scale,1))/1.65 system-ui,sans-serif;min-width:0;overflow-wrap:anywhere;}
.jdx-document [hidden] {display:none!important}
.jdx-document button,.jdx-document select,.jdx-document input {font:inherit;color:inherit;background:var(--jdx-reader-surface);border:1px solid var(--jdx-reader-line);border-radius:6px;padding:5px 8px;cursor:pointer;max-width:100%;}
.jdx-document button:disabled {opacity:.5;cursor:default}
.jdx-document button:hover:not(:disabled) {background:var(--jdx-reader-hover)}
.jdx-document :focus-visible {outline:2px solid #16cf8c;outline-offset:2px}
.jdx-document h3,.jdx-document p {margin:0 0 .6em}
.jdx-document-header,.jdx-document-controls {display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--jdx-reader-line)}
.jdx-document-header strong {flex:1 1 100%;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.jdx-document-status {padding:6px 12px;color:var(--jdx-reader-muted);white-space:pre-wrap}
.jdx-document-pages {overflow:auto;min-height:0;padding:12px;scroll-behavior:smooth}
.jdx-document-page {min-height:100px;margin-bottom:24px;scroll-margin-top:12px}
.jdx-document-page>h3 {font-size:1em;color:var(--jdx-reader-muted);border-bottom:1px solid var(--jdx-reader-line)}
.jdx-document-paragraph {margin-bottom:16px}
.jdx-document-paragraph summary {cursor:pointer;color:var(--jdx-reader-muted)}
.jdx-document-original {white-space:pre-wrap;color:var(--jdx-reader-muted);padding:8px 0}
.jdx-document-paragraph button {font-size:.85em;background:transparent;border:0;padding:0}
.jdx-document .jdx-markdown {overflow-wrap:anywhere}
.jdx-document pre {overflow:auto;white-space:pre}
.jdx-document .katex-display {display:block;overflow:auto}
.jdx-history-row {padding:12px 0;border-bottom:1px solid var(--jdx-reader-line)}
.jdx-history-summary {display:flex;gap:10px;align-items:center;flex-wrap:wrap;cursor:pointer}
.jdx-history-summary>strong {flex:1;min-width:10em}
.jdx-history-summary>small {color:var(--jdx-reader-muted)}
.jdx-history-row>summary {list-style:disclosure-closed}
.jdx-history-row[open]>summary {list-style:disclosure-open}
.jdx-document.jdx-history-detail{display:flex;flex-direction:column;gap:8px;height:calc(100vh - var(--jdx-history-top,180px));overflow:hidden}
.jdx-history-detail>header{display:flex;align-items:center;gap:12px;flex:none;min-width:0;font-size:13px}
.jdx-history-detail>header h3{flex:1;min-width:0;font-size:14px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jdx-history-detail>.jdx-translation-reader{flex:1;height:auto;min-height:0}
.jdx-reference-raw {white-space:pre-wrap;user-select:text}
.jdx-reference-row {padding:14px 0;border-bottom:1px solid var(--jdx-reader-line)}
.jdx-reference-state {color:var(--jdx-reader-muted);font-size:.9em}
/* 透明度只作用于底色；正文和控件不降低 opacity，内部阅读层不得再盖上实色。 */
[data-jdx-floating-window].jdx-document,[data-jdx-floating-window][data-jadense-translation-panel] {background:color-mix(in srgb,var(--jdx-reader-background) var(--jdx-window-opacity,80%),transparent);}
[data-jdx-floating-window][hidden] {display:none!important;}
[data-jdx-floating-window][data-window-style=glass] {backdrop-filter:blur(24px) saturate(1.35);}
[data-jdx-floating-window] {isolation:isolate;}
.jdx-window-glass-background {display:none;position:absolute;inset:0;z-index:-1;overflow:hidden;border-radius:inherit;pointer-events:none;background:var(--jdx-reader-background);}
[data-window-style=glass]>.jdx-window-glass-background {display:block;}
.jdx-window-glass-source {position:absolute;background-repeat:no-repeat;background-size:100% 100%;filter:blur(24px) saturate(1.35);}
.jdx-window-glass-background::after {content:"";position:absolute;inset:0;background:color-mix(in srgb,var(--jdx-reader-background) var(--jdx-window-opacity,80%),transparent);}
[data-jdx-floating-window] .jadense-translation-result {background:transparent;}
[data-jdx-floating-window]>header {cursor:move;touch-action:none;}
[data-jdx-floating-window]>header:focus-visible {outline:2px solid #16cf8c;outline-offset:-3px;}
.jdx-window-footer {flex:none;display:flex;align-items:center;padding:8px 12px;border-top:1px solid var(--jdx-reader-line);}
.jdx-window-appearance {position:relative;margin-inline-end:auto;font-size:calc(12px * var(--jdx-font-scale,1));}
.jdx-window-appearance>summary {display:flex;align-items:center;gap:8px;width:max-content;list-style:none;cursor:pointer;border-radius:5px;padding:5px 8px;user-select:none;}
.jdx-window-appearance>summary::-webkit-details-marker {display:none;}
.jdx-window-appearance>summary::after {content:"";width:5px;height:5px;border-top:1px solid;border-left:1px solid;transform:rotate(45deg);margin-top:3px;}
.jdx-window-appearance[open]>summary,.jdx-window-appearance>summary:hover {background:var(--jdx-reader-hover);}
.jdx-window-appearance>summary:focus-visible {outline:2px solid #16cf8c;outline-offset:1px;}
.jdx-window-appearance-menu {position:absolute;bottom:calc(100% + 8px);left:0;z-index:2;display:grid;gap:14px;box-sizing:border-box;width:min(250px,calc(100vw - 56px));max-height:min(calc(100vh - 110px),var(--jdx-window-menu-max-height,300px));overflow:auto;padding:14px;background:var(--jdx-reader-background);border:1px solid var(--jdx-reader-border);border-radius:8px;box-shadow:0 4px 16px #0002;}
.jdx-window-appearance-menu label {display:grid;grid-template-columns:1fr auto;align-items:center;gap:7px;}
.jdx-window-appearance-menu select,.jdx-window-appearance-menu input {grid-column:1 / -1;width:100%;box-sizing:border-box;font:inherit;color:inherit;}
.jdx-window-appearance-menu select {padding:6px 8px;background:var(--jdx-reader-surface);border:1px solid var(--jdx-reader-line);border-radius:5px;}
.jdx-window-appearance-menu input[type=range] {padding:0;cursor:pointer;accent-color:#16cf8c;}
.jdx-window-appearance-menu output {font-variant-numeric:tabular-nums;color:var(--jdx-reader-muted);}
[data-jdx-resize] {position:absolute;z-index:3;touch-action:none;}
[data-jdx-resize=n],[data-jdx-resize=s] {left:12px;right:12px;height:7px;cursor:ns-resize;}
[data-jdx-resize=e],[data-jdx-resize=w] {top:12px;bottom:12px;width:7px;cursor:ew-resize;}
[data-jdx-resize=n] {top:0;} [data-jdx-resize=s] {bottom:0;} [data-jdx-resize=e] {right:0;} [data-jdx-resize=w] {left:0;}
[data-jdx-resize=ne],[data-jdx-resize=nw],[data-jdx-resize=se],[data-jdx-resize=sw] {width:14px;height:14px;}
[data-jdx-resize=ne],[data-jdx-resize=sw] {cursor:nesw-resize;} [data-jdx-resize=nw],[data-jdx-resize=se] {cursor:nwse-resize;}
[data-jdx-resize=ne] {top:0;right:0;} [data-jdx-resize=nw] {top:0;left:0;} [data-jdx-resize=se] {bottom:0;right:0;} [data-jdx-resize=sw] {bottom:0;left:0;}
[data-jdx-resize=se]::after {content:"";position:absolute;right:4px;bottom:4px;width:5px;height:5px;border-right:1px solid var(--jdx-reader-muted);border-bottom:1px solid var(--jdx-reader-muted);opacity:.6;}
@media (forced-colors:active) {[data-jdx-floating-window].jdx-document,[data-jdx-floating-window][data-jadense-translation-panel] {background:Canvas;backdrop-filter:none;}[data-window-style=glass]>.jdx-window-glass-background {display:none;}}
`

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K]
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}
function button(doc: Document, title: string, callback: () => unknown) {
  const element = node(doc, "button", title); element.type = "button"
  element.addEventListener("click", () => { void callback() }); return element
}
export function installDocumentStyles(doc: Document) {
  if (doc.getElementById("jdx-document-css")) return
  const style = node(doc, "style", CSS); style.id = "jdx-document-css"; (doc.head || doc.documentElement).append(style)
}

/** 两类翻译浮窗共用底部外观菜单；关闭菜单不关闭翻译，不改变运行中的任务。 */
export function translationAppearanceControl(host: ZoteroLike, doc: Document) {
  installDocumentStyles(doc)
  const element = node(doc, "details", undefined, "jdx-window-appearance")
  const toggle = node(doc, "summary", uiText("外观", "Appearance"))
  const menu = node(doc, "div", undefined, "jdx-window-appearance-menu")
  const styleLabel = node(doc, "label", uiText("浮窗样式", "Window style"))
  styleLabel.append(translationStyleControl(host, doc))
  const opacityLabel = node(doc, "label", uiText("背景透明度", "Background transparency"))
  const opacity = translationOpacityControl(host, doc)
  const value = node(doc, "output", `${opacity.value}%`)
  value.setAttribute("data-jdx-translation-opacity-value", "")
  opacityLabel.append(value, opacity)
  opacity.addEventListener("input", () => { value.textContent = `${opacity.value}%` })
  menu.append(styleLabel, opacityLabel); element.append(toggle, menu)
  const close = () => { const opened = element.open; element.open = false; return opened }
  const outside = (event: Event) => { if (!element.contains(event.target as Node)) close() }
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !close()) return
    event.preventDefault(); event.stopPropagation(); toggle.focus()
  }
  element.addEventListener("keydown", escape)
  doc.addEventListener("pointerdown", outside)
  return { element, close, remove: () => { doc.removeEventListener("pointerdown", outside); element.remove() } }
}

let glassSourceSequence = 0
/** Gecko 无法可靠跨 PDF iframe 应用 backdrop-filter；原生 element 图像实时引用已有页面，仅在自有底层模糊。 */
export function translationGlassBackground(root: HTMLElement) {
  const doc = root.ownerDocument as Document & { mozSetImageElement?(id: string, source: Element | null): void }
  if (!doc.mozSetImageElement) return { sync: () => {}, remove: () => {} }
  const background = node(doc, "div", undefined, "jdx-window-glass-background")
  background.setAttribute("aria-hidden", "true"); root.append(background)
  const sources = new Map<Element, { id: string; layer: HTMLElement }>()
  let observer: ResizeObserver | undefined, removed = false
  const drop = (frame: Element, source: { id: string; layer: HTMLElement }) => {
    try { doc.mozSetImageElement?.(source.id, null) } catch { /* Reader 销毁后无需保留图像引用。 */ }
    observer?.unobserve(frame); source.layer.remove(); sources.delete(frame)
  }
  const sync = () => {
    if (removed || root.hidden) return
    // 原生 Reader 两个阅读区；不引用包含插件自身的外层文档，避免递归绘制。
    const frames = Array.from(doc.querySelectorAll<HTMLIFrameElement>("#primary-view iframe, #secondary-view iframe"))
    for (const [frame, source] of sources) if (!frames.includes(frame as HTMLIFrameElement)) drop(frame, source)
    const bounds = root.getBoundingClientRect()
    for (const frame of frames) {
      const rect = frame.getBoundingClientRect()
      let source = sources.get(frame)
      if (!source) {
        const id = `jdx-glass-source-${++glassSourceSequence}`
        try { doc.mozSetImageElement?.(id, frame) } catch { continue /* 可选展示能力不可阻断翻译。 */ }
        const layer = node(doc, "div", undefined, "jdx-window-glass-source")
        layer.style.backgroundImage = `-moz-element(#${id})`; background.append(layer)
        source = { id, layer }; sources.set(frame, source); observer?.observe(frame)
      }
      source.layer.style.left = `${rect.left - bounds.left - root.clientLeft}px`
      source.layer.style.top = `${rect.top - bounds.top - root.clientTop}px`
      source.layer.style.width = `${rect.width}px`; source.layer.style.height = `${rect.height}px`
    }
  }
  try { observer = new (doc.defaultView as Window & typeof globalThis).ResizeObserver(sync) } catch { /* 几何仍由浮窗移动和窗口 resize 更新。 */ }
  doc.addEventListener("load", sync, true); sync()
  return { sync, remove: () => {
    removed = true; doc.removeEventListener("load", sync, true); observer?.disconnect()
    for (const [frame, source] of sources) drop(frame, source)
    background.remove()
  } }
}

/** 标题栏移动、八个边缘缩放共用几何约束；键盘聚焦标题栏后方向键移动，Shift + 方向键缩放。 */
export function makeTranslationWindowInteractive(root: HTMLElement, header: HTMLElement) {
  const doc = root.ownerDocument, win = doc.defaultView
  const glass = translationGlassBackground(root)
  root.setAttribute("data-jdx-floating-window", "")
  header.tabIndex = 0
  const hint = uiText("拖动标题栏移动；方向键移动，Shift + 方向键调整大小", "Drag the title bar to move; arrow keys move, Shift + arrow keys resize")
  header.title = hint; header.setAttribute("aria-label", hint)
  const limit = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(value, Math.max(minimum, maximum)))
  const bounds = () => ({ right: (win?.innerWidth || 800) - 8, bottom: (win?.innerHeight || 600) - 8 })
  const fitMenu = () => {
    const height = root.getBoundingClientRect().height
    const footerHeight = root.querySelector?.("footer")?.getBoundingClientRect().height || 48
    root.style.setProperty?.("--jdx-window-menu-max-height", `${Math.max(40, height - footerHeight - 20)}px`)
    glass.sync()
  }
  const clamp = () => {
    if (root.hidden) return
    const rect = root.getBoundingClientRect(), edge = bounds()
    root.style.left = `${limit(rect.left, 8, edge.right - rect.width)}px`
    root.style.top = `${limit(rect.top, 8, edge.bottom - rect.height)}px`
    root.style.right = "auto"
    fitMenu()
  }
  const change = (rect: DOMRect, direction: string, dx: number, dy: number) => {
    const edge = bounds(), minWidth = Math.min(300, edge.right - 8), minHeight = Math.min(220, edge.bottom - 8)
    if (!direction) {
      root.style.left = `${limit(rect.left + dx, 8, edge.right - rect.width)}px`
      root.style.top = `${limit(rect.top + dy, 8, edge.bottom - rect.height)}px`
    } else {
      const left = direction.includes("w") ? limit(rect.left + dx, 8, rect.right - minWidth) : rect.left
      const top = direction.includes("n") ? limit(rect.top + dy, 8, rect.bottom - minHeight) : rect.top
      const right = direction.includes("e") ? limit(rect.right + dx, left + minWidth, edge.right) : rect.right
      const bottom = direction.includes("s") ? limit(rect.bottom + dy, top + minHeight, edge.bottom) : rect.bottom
      root.style.left = `${left}px`; root.style.top = `${top}px`
      root.style.width = `${right - left}px`; root.style.height = `${bottom - top}px`
    }
    root.style.right = "auto"
    fitMenu()
  }
  const handles = ["n", "e", "s", "w", "ne", "nw", "se", "sw"].map(direction => {
    const handle = node(doc, "span"); handle.dataset.jdxResize = direction; handle.setAttribute("aria-hidden", "true"); root.append(handle); return handle
  })
  let drag: { x: number; y: number; rect: DOMRect; direction: string; pointer: number } | undefined
  const start = (event: PointerEvent) => {
    if (event.button !== 0 || event.isPrimary === false) return
    const target = event.target as Element, handle = target.closest?.<HTMLElement>("[data-jdx-resize]")
    if (!handle && (!header.contains(target) || target.closest?.("button,select,input,label,summary,a"))) return
    if (handle && root.dataset.minimized === "true") return
    drag = { x: event.clientX, y: event.clientY, rect: root.getBoundingClientRect(), direction: handle?.dataset.jdxResize || "", pointer: event.pointerId }
    try { root.setPointerCapture(event.pointerId) } catch { /* 合成事件或旧宿主仍由 document 监听完成拖拽。 */ }
    event.preventDefault()
  }
  const move = (event: PointerEvent) => {
    if (!drag || drag.pointer !== event.pointerId) return
    change(drag.rect, drag.direction, event.clientX - drag.x, event.clientY - drag.y)
    event.preventDefault()
  }
  const end = () => { drag = undefined }
  const keyboard = (event: KeyboardEvent) => {
    // Gecko 事件目标可能经过不同的跨区包装；监听已限定标题栏，只排除其中的交互控件。
    if ((event.target as Element)?.closest?.("button,select,input,textarea,summary,a") || event.altKey || event.ctrlKey || event.metaKey) return
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }
    const delta = arrows[event.key]; if (!delta || (event.shiftKey && root.dataset.minimized === "true")) return
    change(root.getBoundingClientRect(), event.shiftKey ? "se" : "", ...delta); event.preventDefault(); event.stopPropagation()
  }
  root.addEventListener("pointerdown", start); root.addEventListener("lostpointercapture", end)
  doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", end); doc.addEventListener("pointercancel", end)
  header.addEventListener("keydown", keyboard); win?.addEventListener("resize", clamp)
  let observer: ResizeObserver | undefined
  try {
    observer = new (win as Window & typeof globalThis).ResizeObserver(clamp); observer.observe(root)
    const footer = root.querySelector("footer"); if (footer) observer.observe(footer)
  } catch { /* 没有观察器仍可拖动、缩放并响应窗口变化。 */ }
  return { clamp, remove: () => {
    end(); glass.remove(); observer?.disconnect(); win?.removeEventListener("resize", clamp)
    root.removeEventListener("pointerdown", start); root.removeEventListener("lostpointercapture", end)
    doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", end); doc.removeEventListener("pointercancel", end)
    header.removeEventListener("keydown", keyboard); handles.forEach(handle => handle.remove())
  } }
}

function prepare(root: HTMLElement, host: ZoteroLike) {
  installDocumentStyles(root.ownerDocument); root.classList.add("jdx-document"); root.setAttribute("data-jadense-reader-theme", "")
  const stop = observeTheme(host, root); root.ownerDocument.defaultView?.addEventListener("unload", stop, { once: true }); return stop
}
function taskStatus(task: DocumentTask) {
  const labels = { running: uiText("处理中", "Running"), paused: uiText("已暂停", "Paused"), complete: uiText("已完成", "Complete"), partial: uiText("部分完成", "Partial"), error: uiText("需要处理", "Needs attention") }
  return `${labels[task.status]} · ${task.completed}/${task.total}${task.kind === "references" ? uiText(" 来源片段", " source fragments") : ""}${task.storageWarning ? uiText(" · 尚未完整保存，请及时复制", " · Not fully saved; copy before closing") : ""}`
}
async function copy(host: ZoteroLike, text: string) {
  if (!await copyTextToClipboard(host, text)) throw new Error(uiText("复制失败，请检查剪贴板权限。", "Copy failed. Check clipboard permissions."))
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }

/** 全文历史与 Reader 共享连续文章组件，保留原有公开入口。 */
export function mountFullTranslation(root: HTMLElement, host: ZoteroLike, taskID: string, onReplace?: (id: string) => void) {
  return mountTranslationReader(root, host, taskID, { onReplace })
}

/** 工具栏沿用原入口，承载改为原生侧栏或停靠栏。 */
export async function showFullTranslation(host: ZoteroLike, doc: Document, itemID: number, onDetails: (id: string) => void, reader?: ReaderSidebarSource) {
  return openTranslationSidebar(host, doc, itemID, () => {
    const task = documentJobs(host).list("translation").find(task => task.source.itemID === itemID)
    if (task) onDetails(task.id)
  }, reader)
}
const histories = new WeakMap<HTMLElement, { refresh(): void; open(id: string): void }>()
export function renderDocumentHistory(root: HTMLElement, host: ZoteroLike, openSource: (record: TranslationRecord) => Promise<unknown>, taskID?: string) {
  const existing = histories.get(root)
  if (existing) { if (taskID) existing.open(taskID); else existing.refresh(); return }
  prepare(root, host)
  const doc = root.ownerDocument, jobs = documentJobs(host)
  let selected: string | undefined, stopDetail = () => {}, savedScroll = 0
  const refresh = () => {
    if (selected) return
    root.classList.remove("jdx-history-detail")
    const expanded = new Set(Array.from(root.querySelectorAll<HTMLDetailsElement>("details[open][data-record]")).map(row => row.dataset.record))
    const records = host.Prefs ? readTranslationHistory(host.Prefs).records : []
    root.replaceChildren()
    const rows = [...records.map(record => ({ date: record.createdAt, selection: record, task: undefined })), ...jobs.list("translation").map(task => ({ date: task.createdAt, task, selection: undefined }))].sort((a, b) => b.date.localeCompare(a.date))
    if (!rows.length) root.append(node(doc, "p", uiText("还没有翻译记录", "No translations yet")))
    for (const row of rows) {
      if (row.task) {
        const task = row.task, article = node(doc, "article", undefined, "jdx-history-row")
        const openButton = button(doc, "", () => open(task.id)); openButton.className = "jdx-history-summary"
        openButton.append(node(doc, "span", uiText("全文", "Full PDF")), node(doc, "strong", task.source.title), node(doc, "small", `${task.languages ? `${translationLanguageLabel(task.languages.sourceLanguage)} → ${translationLanguageLabel(task.languages.targetLanguage)} · ` : ""}${taskStatus(task)} · ${new Date(task.createdAt).toLocaleString()}`))
        article.append(openButton); root.append(article)
      } else if (row.selection) {
        const record = row.selection, article = node(doc, "details", undefined, "jdx-history-row"); article.dataset.record = record.id; article.open = expanded.has(record.id)
        const summary = node(doc, "summary", undefined, "jdx-history-summary")
        summary.append(node(doc, "span", uiText("选文", "Selection")), node(doc, "strong", record.source.title || "PDF"), node(doc, "small", `${record.result.sourceLanguage} → ${record.result.targetLanguage} · ${record.source.pageLabel || ""} · ${new Date(record.createdAt).toLocaleString()}`))
        const original = node(doc, "p", record.source.text, "jdx-document-original"), result = node(doc, "div", undefined, "jdx-markdown")
        updateChatMarkdown(result, record.result.text)
        const state = node(doc, "p")
        const sourceTitle = button(doc, record.source.title || uiText("打开原文", "Open original"), async () => { try { const value = await openSource(record); if (value === false) state.textContent = uiText("原附件不可用", "Original attachment unavailable") } catch (error) { state.textContent = errorText(error) } })
        sourceTitle.className = "jdx-translation-title"
        sourceTitle.setAttribute("aria-label", uiText("在 Zotero 阅读器中打开原文", "Open original in Zotero Reader"))
        article.append(summary, original, result, sourceTitle, button(doc, uiText("复制译文", "Copy translation"), async () => { try { await copy(host, record.result.text); state.textContent = uiText("已复制", "Copied") } catch (error) { state.textContent = errorText(error) } }), state)
        root.append(article)
      }
    }
  }
  const open = (id: string) => {
    const task = jobs.get(id); if (!task) return
    if (!selected) savedScroll = root.scrollTop
    selected = id; stopDetail(); root.replaceChildren()
    const back = button(doc, uiText("← 翻译历史", "← Translation history"), () => { selected = undefined; stopDetail(); refresh(); root.scrollTop = savedScroll })
    const title = node(doc, "h3", task.source.title), detail = node(doc, "section")
    const remove = button(doc, uiText("删除此全文记录", "Delete this full translation"), async () => { if (!doc.defaultView?.confirm(uiText("删除此全文翻译记录？", "Delete this full translation?"))) return; try { await jobs.delete(id); selected = undefined; stopDetail(); refresh() } catch (error) { doc.defaultView?.alert(errorText(error)) } })
    const header = node(doc, "header"); header.append(back, title, remove)
    root.classList.add("jdx-history-detail"); root.style.setProperty("--jdx-history-top", `${root.getBoundingClientRect().top + 24}px`)
    root.append(header, detail); stopDetail = mountFullTranslation(detail, host, id, open)
  }
  histories.set(root, { refresh, open }); const stop = jobs.subscribe(refresh)
  doc.defaultView?.addEventListener("unload", () => { stop(); stopDetail() }, { once: true })
  void jobs.ready.then(() => { if (taskID) open(taskID); else refresh() })
}

/** 兼容旧引用组件路径，引用展示不再与翻译窗口共用样式或生命周期。 */
export { referenceRow, mountReferenceWorkspace } from "./reference-workspace"

/** 插件卸载时清理 Reader 浮窗及样式；任务由 bootstrap 单独停止。 */
export function removeDocumentSurfaces(doc: Document) { removeReaderDock(doc); doc.getElementById("jdx-document-css")?.remove() }
