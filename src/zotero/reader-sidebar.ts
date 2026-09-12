import { renderDocumentHistory } from "./document-ui"
import { collectSourceForItem, openChatSource } from "./research-context"
import { mountReaderChat } from "./reader-chat"
import { createJdxSelect } from "./ui/select"
import { messageAction } from "./chat-message-ui"
/** Reader 工作区承载：首选现有原生 Jadense 区域；无原生侧栏的窗口使用同一内容的停靠壳。 */
import { documentJobs } from "./document-jobs"
import { mountTranslationReader, installTranslationReadingStyles } from "./translation-reader"
import { element, action } from "./ui/controls"
import { observeTheme, uiText } from "./ui-preferences"
import type { ZoteroLike } from "./runtime"
import { isLiveDocumentReader } from "./pdf-document"

const PANE = "jadense-in-zotero-sync-panel"
const WIDTH = "extensions.jadenseInZotero.readerSidebarWidth"
export type ReaderSidebarSource = { itemID: number; tabID?: string; _iframe?: HTMLElement; _iframeWindow?: Window; _window?: Window }
type Reader = ReaderSidebarSource
type Details = HTMLElement & { tabID?: string; pinnedPane?: string; scrollToPane?(id: string, behavior: string): Promise<unknown>; render?(): Promise<unknown> }
type Surface = { itemID: number; doc: Document; root: HTMLElement; show(start?: boolean, history?: () => void, chat?: boolean): Promise<void>; remove(): void }
const surfaces = new WeakMap<ZoteroLike, Set<Surface>>()
const bodies = new WeakMap<HTMLElement, Surface>()
const docks = new WeakMap<Document, Surface>()
const readers = (host: ZoteroLike) => ((host as ZoteroLike & { Reader?: { _readers?: Reader[] } }).Reader?._readers ?? []).filter(isLiveDocumentReader)

function styles(doc: Document) {
  installTranslationReadingStyles(doc)
  for (const file of ['ui', 'chat', 'reader-workspace']) {
    if (doc.getElementById(`jdx-${file}-css`)) continue
    const link = element(doc, 'link'); link.id = `jdx-${file}-css`; link.rel = 'stylesheet'; link.href = `chrome://jadense-in-zotero/content/${file}.css`
    ;(doc.head || doc.documentElement).append(link)
  }
  if (doc.getElementById("jdx-reader-sidebar-css")) return
  const style = element(doc, "style"); style.id = "jdx-reader-sidebar-css"
  style.textContent = `.jdx-reader-workspace{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--jdx-reader-background);color:var(--jdx-reader-text);font:13px/1.4 system-ui,sans-serif;box-sizing:border-box}.jdx-reader-workspace[hidden]{display:none!important}.jdx-reader-workspace-header{display:flex;align-items:center;gap:8px;flex:none;height:32px;padding:0 12px;font-size:12px}.jdx-reader-workspace-header strong{font-weight:600;flex:1}.jdx-reader-workspace-header button{background:transparent;color:inherit;border:0;cursor:pointer;padding:4px 6px;font:inherit}.jdx-reader-workspace-content{flex:1;min-height:0;overflow:hidden}.jdx-reader-workspace-empty{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:24px;line-height:1.8}.jdx-reader-workspace-empty p{margin:0;color:var(--jdx-reader-muted)}.jdx-reader-workspace-empty button{padding:6px 12px;background:var(--jdx-reader-hover);color:inherit;border:0;border-radius:5px;font:inherit;cursor:pointer}[data-jdx-docked]{display:flex!important;flex-direction:row!important;min-width:0}[data-jdx-docked]>browser{min-width:160px;flex:1;width:0}.jdx-reader-dock{flex:none;width:var(--jdx-dock-width,480px);height:100%;border-inline-start:1px solid var(--jdx-reader-line);position:relative}.jdx-reader-dock-resizer{position:absolute;top:0;bottom:0;left:-3px;width:6px;cursor:ew-resize;z-index:4;touch-action:none}.jdx-reader-dock-resizer:focus-visible{outline:2px solid #16cf8c}`
  style.textContent += `item-details[data-jdx-reading-active]{min-width:0!important;max-width:100%!important}item-details[data-jdx-reading-active] .zotero-view-item{min-width:0!important;max-width:100%!important;overflow:hidden!important;padding:0!important;--min-scroll-height:0px!important}item-details[data-jdx-reading-active] .zotero-view-item>[data-pane]:not([data-jdx-reading-pane]){display:none!important}[data-jdx-reading-pane]>collapsible-section{padding:0!important}[data-jdx-reading-pane]>collapsible-section>.head{display:none!important}[data-jdx-reading-pane]{margin:0!important;padding:0!important;min-height:0!important}`
  ;(doc.head || doc.documentElement).append(style)
}

/** 从原生区域所属 Reader tab 解析附件，绝不使用 item-pane 的父文献或全局当前选中条目。 */
export function sidebarReader(host: ZoteroLike, body: HTMLElement): Reader | undefined {
  const detail = body.closest("item-details") as Details | null
  return readers(host).find(reader => reader.tabID && reader.tabID === detail?.tabID && (!reader._window || reader._window.document === body.ownerDocument))
}

function width(host: ZoteroLike, doc: Document) {
  let saved = 480
  try { const value = Number(host.Prefs?.get(WIDTH, true)); if (value >= 280 && value <= 900) saved = value } catch { /* 首次默认宽度。 */ }
  return Math.min(Math.max(320, saved), Math.max(0, (doc.defaultView?.innerWidth || 1100) - 160))
}
function saveWidth(host: ZoteroLike, value: number) { try { host.Prefs?.set?.(WIDTH, Math.round(value), true) } catch { /* 宽度不是运行依赖。 */ } }

/** 停靠只移动插件自己的根节点，不重建正文或移动 PDF browser。 */
function dockFrame(root: HTMLElement, target: HTMLElement, host: ZoteroLike) {
  const doc = root.ownerDocument, separator = element(doc, "div", "jdx-reader-dock-resizer")
  let dockWidth = width(host, doc)
  separator.tabIndex = 0; separator.setAttribute("role", "separator"); separator.setAttribute("aria-orientation", "vertical"); separator.setAttribute("aria-label", uiText("调整阅读侧栏宽度", "Resize reading sidebar"))
  const fit = (value = dockWidth) => {
    dockWidth = Math.min(Math.max(320, value), Math.max(0, target.clientWidth - 160))
    root.style.setProperty("--jdx-dock-width", `${dockWidth}px`); separator.setAttribute("aria-valuenow", String(Math.round(dockWidth)))
  }
  separator.addEventListener("pointerdown", event => {
    if (event.button !== 0) return
    event.preventDefault(); separator.setPointerCapture(event.pointerId)
    const start = event.clientX, initial = dockWidth
    const move = (next: PointerEvent) => { fit(initial + start - next.clientX); saveWidth(host, dockWidth) }
    const up = () => { separator.removeEventListener("pointermove", move); separator.removeEventListener("pointerup", up); separator.removeEventListener("pointercancel", up) }
    separator.addEventListener("pointermove", move); separator.addEventListener("pointerup", up); separator.addEventListener("pointercancel", up)
  })
  separator.addEventListener("keydown", event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); fit(dockWidth + (event.key === "ArrowLeft" ? 20 : -20)); saveWidth(host, dockWidth) } })
  return {
    show() { target.setAttribute("data-jdx-docked", ""); root.classList.add("jdx-reader-dock"); if (root.parentElement !== target) target.append(root); root.append(separator); root.style.height = "100%"; fit() },
    hide() { target.removeAttribute("data-jdx-docked"); root.classList.remove("jdx-reader-dock"); separator.remove() },
  }
}

/** 挂载壳只恢复已有结果；只有明确启动操作才创建翻译任务。 */
function surface(host: ZoteroLike, doc: Document, itemID: number, options: {
  root: HTMLElement; activate(): Promise<void> | void; hide(): void; cleanup(): void; history?(): void; readerDocument?: Document
}): Surface {
  const root = options.root, jobs = documentJobs(host)
  styles(doc); root.classList.add("jdx-reader-workspace"); root.setAttribute("data-jadense-reader-theme", ""); root.dataset.readerItem = String(itemID)
  const stopTheme = observeTheme(host, root), header = element(doc, "header", "jdx-reader-workspace-header")
  const left = element(doc, 'div', 'jdx-reader-header-left'), center = element(doc, 'div', 'jdx-reader-header-center'), right = element(doc, 'div', 'jdx-reader-header-right')
  const pageHost = element(doc, 'div'); left.append(pageHost)
  const pageSelect = createJdxSelect(pageHost, { compact: true, portal: true, popupWidth: 180, ariaLabel: uiText('切换功能', 'Switch page'), iconPath: 'M4 6h16M4 12h16M4 18h16' })
  pageSelect.setOptions([{ value: 'chat', label: uiText('对话', 'Chat') }, { value: 'translation', label: uiText('全文翻译', 'Full translation') }, { value: 'selection-history', label: uiText('选中翻译历史', 'Selection translation history') }], 'chat')
  const sessionHost = element(doc, 'div'), translationTitle = element(doc, 'strong', '', uiText('全文翻译', 'Full translation')); center.append(sessionHost, translationTitle)
  const newChat = messageAction(doc, uiText('新建对话', 'New conversation'), 'M12 5v14M5 12h14')
  newChat.classList.add('jdx-button')
  right.append(newChat); header.append(left, center, right)
  const pages = element(doc, 'section', 'jdx-reader-workspace-pages'), chat = element(doc, 'section', 'jdx-reader-workspace-content')
  const content = element(doc, 'section', 'jdx-reader-workspace-content'); pages.append(chat, content); root.append(header, pages)
  const chatView = mountReaderChat(chat, sessionHost, host, itemID)
  const selectionHistory = element(doc, 'section', 'jdx-reader-workspace-content jdx-reader-selection-history')
  const historyTitle = element(doc, 'strong', '', uiText('选中翻译历史', 'Selection translation history'))
  pages.append(selectionHistory); center.append(historyTitle)
  let stopHistory = () => {}, historyRemoved = false, historyLoading = false
  const refreshHistory = async () => {
    if (historyLoading || historyRemoved) return
    historyLoading = true
    if (!selectionHistory.childNodes.length) selectionHistory.textContent = uiText('正在读取翻译历史…', 'Loading translation history…')
    try {
      const source = await collectSourceForItem(host, itemID, { includeText: false })
      if (historyRemoved) return
      if (!source || source.kind !== 'file') throw new Error(uiText('当前 PDF 不可用', 'Current PDF unavailable'))
      stopHistory = renderDocumentHistory(selectionHistory, host, record => openChatSource(host, {
        ...source, pageIndex: record.source.pageIndex, pageLabel: record.source.pageLabel,
      }), undefined, source)
    } catch (error) { if (!historyRemoved) selectionHistory.textContent = String(error) }
    finally { historyLoading = false }
  }
  const refreshButton = messageAction(doc, uiText('刷新翻译历史', 'Refresh translation history'), 'M20 7v5h-5M4 17v-5h5M6 8a7 7 0 0 1 12-2l2 2M4 16l2 2a7 7 0 0 0 12-2')
  refreshButton.classList.add('jdx-button'); right.append(refreshButton)
  refreshButton.onclick = () => { void refreshHistory() }
  const openHistoryLink = (event: MouseEvent) => {
    const link = (event.target as Element).closest('a')
    if (!link) return
    event.preventDefault()
    const url = link.getAttribute('href') || ''
    if (/^https?:\/\//iu.test(url)) (host as ZoteroLike & { launchURL?(url: string): void }).launchURL?.(url)
  }
  selectionHistory.addEventListener('click', openHistoryLink)
  selectionHistory.addEventListener('auxclick', openHistoryLink)
  let page = 'chat'
  const setPage = (next: string) => {
    page = next; root.dataset.page = next; pageSelect.setValue(next); pageSelect.close(); chatView.closeMenus()
    chat.hidden = next !== 'chat'; sessionHost.hidden = chat.hidden; newChat.hidden = chat.hidden
    content.hidden = next !== 'translation'; translationTitle.hidden = content.hidden
    selectionHistory.hidden = next !== 'selection-history'; historyTitle.hidden = selectionHistory.hidden; refreshButton.hidden = selectionHistory.hidden
    if (!selectionHistory.hidden) void refreshHistory()
    if (next === 'chat') chatView.refresh()
  }
  newChat.onclick = () => { void chatView.newSession() }
  pageSelect.onChange(setPage); setPage(page)
  let taskID = "", stopContent = () => {}, removed = false, busy = false, history = options.history
  const mount = (id: string) => {
    if (id === taskID) return
    taskID = id; stopContent(); content.replaceChildren()
    stopContent = mountTranslationReader(content, host, id, { onReplace: mount, onHistory: () => history?.(), readerDocument: options.readerDocument })
    root.dataset.translationTask = id
  }
  const restore = async () => {
    await jobs.ready; if (removed || taskID || busy) return
    const existing = jobs.list("translation").find(task => task.source.itemID === itemID)
    if (existing) mount(existing.id)
  }
  const start = async () => {
    if (busy || taskID || removed) return
    busy = true; startButton.disabled = true; message.textContent = uiText("正在读取文献…", "Reading the paper…")
    try { const task = await jobs.start("translation", itemID); if (!removed) mount(task.id) }
    catch (error) { if (!removed) message.textContent = String(error) }
    finally { busy = false; startButton.disabled = false }
  }
  const empty = element(doc, "div", "jdx-reader-workspace-empty")
  const heading = element(doc, "h2", "", uiText("全文翻译前，先考虑精读", "Consider focused reading first"))
  const advice = element(doc, "p", "", uiText("全文翻译不是推荐做法。建议先使用「解析文献」，再精读关键点、翻译重点句，会更加经济。", "Full translation is not recommended. Analyze the paper first, then read the key points closely and translate important sentences to reduce cost."))
  const message = element(doc, "p", "jdx-reader-translation-status")
  message.setAttribute("role", "status")
  const startButton = action(doc, uiText("仍要翻译", "Translate anyway"), () => { void start() })
  const confirmation = element(doc, "div", "jdx-reader-translation-confirmation")
  confirmation.append(heading, advice, startButton, message)
  empty.append(confirmation); content.append(empty)
  const stopActivity = jobs.subscribe(() => { if (busy && !taskID) message.textContent = jobs.activity || uiText("正在准备翻译…", "Preparing translation…") })
  const value: Surface = {
    itemID, doc, root,
    async show(shouldStart = false, onHistory, newConversation) {
      if (onHistory) history = onHistory
      await options.activate()
      if (newConversation) { setPage('chat'); await chatView.newSession(); return }
      if (shouldStart) setPage('translation')
      // 打开侧栏仅恢复已有译文；新任务必须由「仍要翻译」明确触发。
      await restore()
    },
    remove() {
      if (removed) return
      removed = true; historyRemoved = true
      for (const cleanup of [stopContent, stopHistory, stopTheme, stopActivity, () => pageSelect.destroy(), () => chatView.remove(), options.cleanup, () => root.remove()]) {
        try { cleanup() } catch { /* 已关闭窗口的失效 Xray 不妨碍其他视图清理。 */ }
      }
      surfaces.get(host)?.delete(value)
    },
  }
  const registry = surfaces.get(host) ?? new Set<Surface>(); registry.add(value); surfaces.set(host, registry)
  void restore(); return value
}

/** 原生注册区域保留宿主按钮及调整宽度；固定只作用于当前 Reader 的 item-details。 */
export function mountNativeReaderSidebar(body: HTMLElement, host: ZoteroLike, onHistory?: () => void) {
  const reader = sidebarReader(host, body)
  if (!reader) return false
  const existing = bodies.get(body)
  if (existing?.itemID === reader.itemID) return true
  existing?.remove(); body.replaceChildren()
  const doc = body.ownerDocument, win = doc.defaultView, detail = body.closest("item-details") as Details
  const section = body.closest<HTMLElement>("item-pane-custom-section")!
  const paneID = section?.dataset.pane || `${PANE}`
  const nativePane = body.closest<HTMLElement>("context-pane")
  const outerPane = nativePane?.closest<HTMLElement>("#zotero-context-pane") ?? nativePane
  const root = element(doc, "section"); body.append(root)
  const dock = reader._iframe?.parentElement ? dockFrame(root, reader._iframe.parentElement, host) : undefined
  let active = false, wanted = false, docked = false, oldWidth = "", oldMinWidth = "", oldNativeMinWidth = "", oldWidthAttribute: string | null = null, oldPin = "", resize: ResizeObserver | undefined, layout: MutationObserver | undefined
  const collapsed = (value: boolean) => {
    const pane = nativePane as (HTMLElement & { collapsed: boolean }) | null
    if (pane && pane.collapsed !== value) pane.collapsed = value
  }
  const fit = () => {
    if (active && dock && outerPane?.classList.contains("stacked")) {
      docked = true; detail.removeAttribute("data-jdx-reading-active"); section.removeAttribute("data-jdx-reading-pane"); dock.show(); collapsed(true); return
    }
    if (docked) { docked = false; dock?.hide(); body.append(root); if (active) collapsed(false) }
    if (active) { detail.setAttribute("data-jdx-reading-active", ""); section.setAttribute("data-jdx-reading-pane", "") }
    const scroll = detail.querySelector<HTMLElement>(".zotero-view-item")
    // 不使用由正文反向决定的 clientHeight 上限：它会锁住上一次窗口高度。
    // 直接以真实视口底边为终点，CSS 在宿主 resize 的同一帧重新计算可用高度。
    const top = Math.max(0, scroll?.getBoundingClientRect().top ?? root.getBoundingClientRect().top)
    root.style.height = `max(0px, calc(100vh - ${top + 2}px))`
    if (active && scroll) scroll.scrollTop = 0
    if (active && outerPane && outerPane.clientWidth > 0) saveWidth(host, outerPane.clientWidth)
  }
  const leave = (clear = true) => {
    if (clear) wanted = false
    if (!active) return
    active = false
    detail.removeAttribute("data-jdx-reading-active"); section.removeAttribute("data-jdx-reading-pane")
    if (docked) { docked = false; dock?.hide(); body.append(root) }
    if (nativePane) nativePane.style.minWidth = oldNativeMinWidth
    if (outerPane) { outerPane.style.width = oldWidth; outerPane.style.minWidth = oldMinWidth; if (oldWidthAttribute === null) outerPane.removeAttribute("width"); else outerPane.setAttribute("width", oldWidthAttribute) }
    if (detail.pinnedPane === paneID) detail.pinnedPane = oldPin
  }
  const nativeClick = (event: Event) => {
    if ((detail as Details & { sidenav?: { container?: HTMLElement } }).sidenav?.container !== detail) return
    const button = (event.target as Element)?.closest<HTMLElement>(".btn[data-pane]")
    if (!button) return
    if (button.dataset.pane === paneID) void value.show()
    else leave()
  }
  const value = surface(host, doc, reader.itemID, { root, history: onHistory, readerDocument: reader._iframeWindow?.document,
    async activate() {
      wanted = true
      root.hidden = false
      if (!active) {
        oldPin = detail.pinnedPane || ""; oldWidth = outerPane?.style.width || ""; oldMinWidth = outerPane?.style.minWidth || ""; oldNativeMinWidth = nativePane?.style.minWidth || ""; oldWidthAttribute = outerPane?.getAttribute("width") ?? null; active = true
        if (outerPane) {
          // 宿主右侧图标栏占独立轨道；320px 是内容区的目标，不可让其最小宽度伸到图标下面。
          const chrome = Math.max(0, outerPane.clientWidth - (nativePane?.parentElement?.clientWidth ?? outerPane.clientWidth))
          const desired = Math.max(320 + chrome, width(host, doc))
          outerPane.style.minWidth = `min(${320 + chrome}px, calc(100vw - 160px))`
          outerPane.style.width = `${desired}px`; outerPane.setAttribute("width", String(desired))
          if (nativePane) nativePane.style.minWidth = '0'
        }
      }
      // 宿主负责原生侧栏可见性；不覆写其 DOM 或内容。
      const sidenav = (detail as Details & { sidenav?: { _collapsed?: boolean; _contextNotesPaneVisible?: boolean } }).sidenav
      if (sidenav) { sidenav._contextNotesPaneVisible = false; sidenav._collapsed = false }
      collapsed(false)
      detail.pinnedPane = paneID
      fit(); if (!docked) await detail.scrollToPane?.(paneID, "instant"); fit()
    },
    hide() { leave(); collapsed(true) },
    cleanup() { leave(); resize?.disconnect(); layout?.disconnect(); doc.removeEventListener("click", nativeClick); win?.removeEventListener("resize", fit); bodies.delete(body) },
  })
  bodies.set(body, value); doc.addEventListener("click", nativeClick); win?.addEventListener("resize", fit)
  try { resize = new (win as Window & typeof globalThis).ResizeObserver(fit); resize.observe(detail); if (nativePane) resize.observe(nativePane) } catch { /* 窗口 resize 仍负责尺寸。 */ }
  try {
    layout = new (win as Window & typeof globalThis).MutationObserver(() => {
      const selected = detail.classList.contains("deck-selected")
      if (!selected && active) leave(false)
      else if (selected && wanted && !active) void value.show()
      else if (active) fit()
    })
    if (outerPane) layout.observe(outerPane, { attributes: true, attributeFilter: ["class"] })
    layout.observe(detail, { attributes: true, attributeFilter: ["class"] })
  } catch { /* 旧宿主仍响应窗口 resize。 */ }
  fit(); return true
}

export function removeNativeReaderSidebar(body: HTMLElement) { bodies.get(body)?.remove() }

/** 工具栏与原生入口会合；找不到原生容器才创建停靠视图，不重新挂载 PDF browser。 */
export async function openTranslationSidebar(host: ZoteroLike, readerDoc: Document, itemID: number, onHistory: () => void, originReader?: Reader) {
  return openReaderSidebar(host, readerDoc, itemID, onHistory, originReader, false)
}
export async function openChatSidebar(host: ZoteroLike, readerDoc: Document, itemID: number, originReader?: Reader) {
  return openReaderSidebar(host, readerDoc, itemID, undefined, originReader, true)
}
async function openReaderSidebar(host: ZoteroLike, readerDoc: Document, itemID: number, onHistory: (() => void) | undefined, originReader: Reader | undefined, chat: boolean) {
  const reader = originReader?.itemID === itemID ? originReader : readers(host).find(value => value.itemID === itemID && value._iframeWindow?.document === readerDoc)
  const doc = reader?._window?.document
  if (doc && reader?.tabID) {
    const detail = Array.from(doc.querySelectorAll("item-details")).find(value => (value as Details).tabID === reader.tabID) as Details | undefined
    const selector = `item-pane-custom-section[data-pane$="${PANE}"] [data-type="body"]`
    if (detail && !detail.querySelector(selector)) await detail.render?.()
    const body = detail?.querySelector<HTMLElement>(selector)
    if (body && !bodies.has(body)) mountNativeReaderSidebar(body, host, onHistory)
    const native = body && bodies.get(body)
    if (native) { await native.show(!chat, onHistory, chat); return }
  }
  const previous = docks.get(readerDoc)
  if (previous?.itemID === itemID) { await previous.show(!chat, onHistory, chat); return }
  previous?.remove()
  const browser = reader?._iframe, parent = browser?.parentElement
  // 独立 Reader 有 chrome browser；极旧宿主在 Reader 根内预留实际宽度。
  const owner = parent?.ownerDocument ?? readerDoc
  const target = parent ?? readerDoc.body ?? readerDoc.documentElement
  const root = element(owner, "aside"), dock = dockFrame(root, target, host)
  const fit = () => { if (!root.hidden) dock.show() }
  const value = surface(host, owner, itemID, { root, history: onHistory, readerDocument: readerDoc,
    activate() { root.hidden = false; dock.show() },
    hide() { root.hidden = true; dock.hide() },
    cleanup() { dock.hide(); owner.defaultView?.removeEventListener("resize", fit); readerDoc.defaultView?.removeEventListener("pagehide", remove); docks.delete(readerDoc) },
  })
  const remove = () => value.remove()
  readerDoc.defaultView?.addEventListener("pagehide", remove, { once: true }); owner.defaultView?.addEventListener("resize", fit)
  docks.set(readerDoc, value); await value.show(!chat, onHistory, chat)
}

export function removeReaderSidebars(host: ZoteroLike) {
  const mounted = [...surfaces.get(host) ?? []]
  for (const value of mounted) value.remove()
  for (const doc of new Set(mounted.map(value => value.doc))) {
    doc.getElementById("jdx-reader-sidebar-css")?.remove()
    if (!doc.querySelector(".jdx-translation-reader")) doc.getElementById("jdx-translation-reading-css")?.remove()
  }
}
export function removeReaderDock(doc: Document) { docks.get(doc)?.remove() }
