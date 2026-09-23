import { lifecycleTrace } from './lifecycle-diagnostics'
import type { SelectionQuote } from './chat-runtime'
import type { AnalysisDetailTab } from "./analysis-workspace"
import { mountDocumentResults, resultLabels, type DocumentResultMode } from "./document-results"
import { openManagerWindow } from "./manager-window"
import { collectSourceForItem } from "./research-context"
import { mountReaderChat } from "./reader-chat"
import { createJdxSelect } from "./ui/select"
import { messageAction } from "./chat-message-ui"
/** Reader 工作区承载：首选现有原生 Jadense 区域；无原生侧栏的窗口使用同一内容的停靠壳。 */
import { documentJobs } from "./document-jobs"
import { installTranslationReadingStyles } from "./translation-reader"
import { element } from "./ui/controls"
import { observeTheme, uiText } from "./ui-preferences"
import type { ZoteroLike } from "./runtime"
import { isLiveDocumentReader } from "./pdf-document"

const PANE = "jadense-in-zotero-sync-panel"
const WIDTH = "extensions.jadenseInZotero.readerSidebarWidth"
export type ReaderSidebarSource = { itemID: number; tabID?: string; _iframe?: HTMLElement; _iframeWindow?: Window; _window?: Window }
type ResultPage = Exclude<DocumentResultMode, 'analysis'> | AnalysisDetailTab
type Reader = ReaderSidebarSource
type Details = HTMLElement & { tabID?: string; pinnedPane?: string; scrollToPane?(id: string, behavior: string): Promise<unknown>; render?(): Promise<unknown> }
type Surface = { itemID: number; doc: Document; root: HTMLElement; show(start?: boolean, history?: () => void, chat?: boolean, quote?: SelectionQuote, resultPage?: ResultPage): Promise<void>; remove(): void }
const surfaces = new WeakMap<ZoteroLike, Set<Surface>>()
const styleDocuments = new WeakMap<ZoteroLike, Set<Document>>()
const bodies = new WeakMap<HTMLElement, Surface>()
const docks = new WeakMap<Document, Surface>()
// Gecko 的 waived/Xray 包装可能不相等，仍只接受同一个 DOM Document。
function sameDocument(left: Document | undefined, right: Document) { try { return left === right || Boolean(left?.isSameNode(right)) } catch { return false } }
const readers = (host: ZoteroLike) => ((host as ZoteroLike & { Reader?: { _readers?: Reader[] } }).Reader?._readers ?? []).filter(isLiveDocumentReader)

function styles(doc: Document) {
  installTranslationReadingStyles(doc)
  for (const file of ['ui', 'chat', 'analysis', 'reader-workspace']) {
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
  return readers(host).find(reader => reader.tabID && reader.tabID === detail?.tabID && (!reader._window || sameDocument(reader._window.document, body.ownerDocument)))
}

function width(host: ZoteroLike, doc: Document) {
  let saved = 480
  try { const value = Number(host.Prefs?.get(WIDTH, true)); if (value >= 280 && value <= 900) saved = value } catch { /* 首次默认宽度。 */ }
  return Math.min(Math.max(320, saved), Math.max(0, (doc.defaultView?.innerWidth || 1100) - 160))
}
function saveWidth(host: ZoteroLike, value: number) { if (value < 280 || value > 900) return; try { host.Prefs?.set?.(WIDTH, Math.round(value), true) } catch { /* 宽度不是运行依赖。 */ } }

/** 停靠只移动插件自己的根节点，不重建正文或移动 PDF browser。 */
function dockFrame(root: HTMLElement, target: HTMLElement, host: ZoteroLike) {
  const doc = root.ownerDocument, separator = element(doc, "div", "jdx-reader-dock-resizer")
  let dockWidth = width(host, doc)
  separator.tabIndex = 0; separator.setAttribute("role", "separator"); separator.setAttribute("aria-orientation", "vertical"); separator.setAttribute("aria-label", uiText("调整阅读侧栏宽度", "Resize reading sidebar"))
  const fit = (value = dockWidth) => {
    if (target.clientWidth <= 160) return
    dockWidth = Math.min(Math.max(320, value), target.clientWidth - 160)
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
  let observer: ResizeObserver | undefined
  const resized = () => { if (root.classList.contains('jdx-reader-dock')) fit() }
  doc.defaultView?.addEventListener('resize', resized)
  try { observer = new (doc.defaultView as Window & typeof globalThis).ResizeObserver(resized); observer.observe(target) } catch { /* 窗口 resize 兜底。 */ }
  return {
    dispose() { observer?.disconnect(); doc.defaultView?.removeEventListener('resize', resized); this.hide() },
    show() { target.setAttribute("data-jdx-docked", ""); root.classList.add("jdx-reader-dock"); if (root.parentElement !== target) target.append(root); root.append(separator); root.style.height = "100%"; fit() },
    hide() { target.removeAttribute("data-jdx-docked"); root.classList.remove("jdx-reader-dock"); separator.remove() },
  }
}

/** 挂载壳只恢复已有结果；只有明确启动操作才创建翻译任务。 */
function surface(host: ZoteroLike, doc: Document, itemID: number, options: {
  root: HTMLElement; activate(): Promise<void> | void; hide(): void; cleanup(): void; history?(): void; readerDocument?: Document
}): Surface {
  const root = options.root
  const cleanups: Array<() => void> = [() => root.remove()]
  try {
  const styled = styleDocuments.get(host) ?? new Set<Document>(); styled.add(doc); styleDocuments.set(host, styled)
  styles(doc); root.classList.add("jdx-reader-workspace"); root.setAttribute("data-jadense-reader-theme", ""); root.dataset.readerItem = String(itemID)
  const stopTheme = observeTheme(host, root); cleanups.push(stopTheme)
  const header = element(doc, "header", "jdx-reader-workspace-header")
  const left = element(doc, 'div', 'jdx-reader-header-left'), center = element(doc, 'div', 'jdx-reader-header-center'), right = element(doc, 'div', 'jdx-reader-header-right')
  const pageHost = element(doc, 'div'); left.append(pageHost)
  const pageSelect = createJdxSelect(pageHost, { compact: true, portal: true, popupWidth: 180, ariaLabel: uiText('切换功能', 'Switch page'), iconPath: 'M4 6h16M4 12h16M4 18h16' })
  cleanups.push(() => pageSelect.destroy())
  const { source, translation, selection } = resultLabels()
  const labels = { source, translation, selection, summary: uiText('解析总结', 'Summary'), notes: uiText('解析笔记', 'Analysis notes'), references: uiText('参考文献', 'References') }
  pageSelect.setOptions([{ value: 'chat', label: uiText('对话', 'Chat') }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))], 'chat')
  const sessionHost = element(doc, 'div'), heading = element(doc, 'strong'); center.append(sessionHost, heading)
  const newChat = messageAction(doc, uiText('新建对话', 'New conversation'), 'M12 5v14M5 12h14'); newChat.classList.add('jdx-button')
  right.append(newChat); header.append(left, center, right)
  const pages = element(doc, 'section', 'jdx-reader-workspace-pages'), chat = element(doc, 'section', 'jdx-reader-workspace-content')
  pages.append(chat); root.append(header, pages)
  const chatView = mountReaderChat(chat, sessionHost, host, itemID)
  cleanups.push(() => chatView.remove())
  const views = new Map<ResultPage, { root: HTMLElement; view: ReturnType<typeof mountDocumentResults> }>()
  let page = 'chat', removed = false, sequence = 0
  let loading: HTMLElement | undefined
  const setPage = async (next: string, recordID?: string) => {
    if (removed) return
    clearRecovery(pages)
    loading?.remove(); loading = undefined
    page = next; const generation = ++sequence
    root.dataset.page = next; pageSelect.setValue(next); pageSelect.close(); chatView.closeMenus()
    chat.hidden = next !== 'chat'; sessionHost.hidden = chat.hidden; newChat.hidden = chat.hidden; heading.hidden = !chat.hidden
    for (const [mode, view] of views) view.root.hidden = mode !== next
    if (next === 'chat') { chatView.refresh(); return }
    const resultPage = next as ResultPage
    const analysisTab = resultPage === 'summary' || resultPage === 'notes' || resultPage === 'references' ? resultPage : undefined
    const mode: DocumentResultMode = analysisTab ? 'analysis' : resultPage as DocumentResultMode
    heading.textContent = labels[resultPage]
    let existing = views.get(resultPage)
    if (recordID && existing) { existing.view.remove(); existing.root.remove(); views.delete(resultPage); existing = undefined }
    const placeholder = element(doc, 'section', 'jdx-sidebar-loading jdx-reader-workspace-empty', uiText('正在读取当前 PDF 的成果…', 'Loading results for this PDF…'))
    placeholder.setAttribute('role', 'status'); pages.append(placeholder); loading = placeholder
    let timer: ReturnType<typeof setTimeout> | undefined
    let keepPlaceholder = false
    try {
      const loaded = await Promise.race([
        (async () => {
          if (existing) { await existing.view.refresh(); return null }
          const jobs = documentJobs(host); await jobs.ready
          const current = await collectSourceForItem(host, itemID, { includeText: false }).catch(() => undefined)
          return { jobs, current }
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Sidebar results timed out'), { code: 'SIDEBAR_RESULTS_TIMEOUT' })), 10000) }),
      ])
      if (removed || generation !== sequence) return
      if (!loaded) return
      const { jobs, current } = loaded
      const saved = jobs.list().find(task => task.source.itemID === itemID)?.source
      const source = current?.kind === 'file' ? { ...current, title: current.parentItem?.title || current.title, authors: [] } : saved ? { ...saved, authors: [] } : undefined
      if (!source) { placeholder.textContent = uiText('当前 PDF 不可用，请重新打开 PDF 后重试。', 'This PDF is unavailable. Reopen it and retry.'); keepPlaceholder = true; return }
      const panel = element(doc, 'section', 'jdx-reader-workspace-content')
      const view = mountDocumentResults(panel, host, source, mode, { recordID, readerDocument: options.readerDocument, analysisTab, hideAnalysisTabs: true,
        onTranslate: id => { void setPage('translation', id).catch(() => navigate('translation')) },
        onWorkbench: (resultMode, taskID) => {
          openManagerWindow({ zotero: host, win: host.getMainWindow?.() as Parameters<typeof openManagerWindow>[0]['win'],
            context: { pluginID: 'jadense-in-zotero@jadense.cn', rootURI: '' }, section: 'analysis', action: { kind: 'fullTranslate', itemID, taskID, resultMode: analysisTab || resultMode } })
        },
      })
      pages.append(panel); views.set(resultPage, { root: panel, view })
    } catch (error) { if (!removed && generation === sequence) {
      const trace = lifecycleTrace(host, 'reader-sidebar', 'results'); trace.fail(error, 'results_mount', 'SIDEBAR_RESULTS_FAILED'); trace.end('error')
      recovery(pages, host, () => navigate(next), trace.id)
    } } finally { clearTimeout(timer); if (loading === placeholder && !keepPlaceholder) { placeholder.remove(); loading = undefined } }
  }
  const navigate = (next: string) => { void setPage(next).catch(error => {
    const trace = lifecycleTrace(host, 'reader-sidebar', 'navigate'); trace.fail(error, 'content_mount', 'SIDEBAR_CONTENT_FAILED'); trace.end('error')
    if (!removed) recovery(pages, host, () => navigate(next), trace.id)
  }) }
  newChat.onclick = () => { void chatView.newSession().catch(() => navigate('chat')) }
  pageSelect.onChange(navigate); root.dataset.page = page
  const value: Surface = {
    itemID, doc, root,
    async show(shouldStart = false, _onHistory, newConversation, quote, resultPage) {
      if (removed) return
      await options.activate()
      if (removed) return
      try {
        if (newConversation) { await setPage('chat'); await chatView.newSession(quote); return }
        if (resultPage) await setPage(resultPage)
        else if (shouldStart) await setPage('translation')
        else if (page !== 'chat') await setPage(page)
      } catch (error) { throw Object.assign(new Error('Sidebar content unavailable'), { code: 'SIDEBAR_CONTENT_FAILED', cause: error }) }
    },
    remove() {
      if (removed) return
      removed = true; sequence++; loading?.remove(); loading = undefined
      const trace = lifecycleTrace(host, 'reader-sidebar', 'cleanup'); let failed = false
      for (const cleanup of [() => clearRecovery(pages), ...Array.from(views.values(), view => () => view.view.remove()), stopTheme, () => pageSelect.destroy(), () => chatView.remove(), options.cleanup, () => root.remove()]) {
        try { cleanup() } catch (error) { failed = true; trace.fail(error, 'cleanup_failed', 'SIDEBAR_CLEANUP_FAILED') }
      }
      surfaces.get(host)?.delete(value); trace.end(failed ? 'error' : 'success')
    },
  }
  const registry = surfaces.get(host) ?? new Set<Surface>(); registry.add(value); surfaces.set(host, registry)
  return value
  } catch (error) {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch { /* 继续回收部分视图。 */ } }
    throw Object.assign(new Error('Sidebar content unavailable'), { code: 'SIDEBAR_CONTENT_FAILED', cause: error })
  }
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
  let oldCollapsed: boolean | undefined, oldNavCollapsed: boolean | undefined, oldNotes: boolean | undefined
  let active = false, wanted = false, docked = false, fallback = false, oldWidth = "", oldMinWidth = "", oldNativeMinWidth = "", oldWidthAttribute: string | null = null, oldPin = "", resize: ResizeObserver | undefined, layout: MutationObserver | undefined
  let visibilityTimer: ReturnType<typeof setTimeout> | undefined
  const visible = () => {
    const rect = root.getBoundingClientRect()
    if (!root.isConnected || rect.width <= 0 || rect.height <= 0) return false
    for (let node: HTMLElement | null = root; node; node = node.parentElement) {
      const style = win?.getComputedStyle?.(node)
      if (node.hidden || style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    return true
  }
  const foreground = () => {
    const selected = (reader._window as (Window & { Zotero_Tabs?: { selectedID?: string } }) | undefined)?.Zotero_Tabs?.selectedID
    // Zotero 顶层 XUL document 即使正在显示也报告 visibilityState=hidden；以宿主 tab/deck 判断。
    return (!selected || selected === reader.tabID) && detail.classList.contains('deck-selected') && !win?.closed
  }
  const verifyVisible = () => {
    if (!active || !wanted || fallback || !foreground() || !win?.getComputedStyle || visibilityTimer) return
    // 宿主布局可能跨帧完成；只恢复持续不可见的当前 Reader，不影响后台标签页。
    visibilityTimer = setTimeout(() => {
      visibilityTimer = undefined
      if (!active || !wanted || !foreground()) return
      const rect = root.getBoundingClientRect(), trace = lifecycleTrace(host, 'reader-sidebar', 'visibility')
      const shown = visible()
      trace.event('visibility_checked', { width: rect.width, height: rect.height, visible: shown, page: root.dataset.page })
      if (!shown && dock) {
        leave(false); fallback = true; active = true
        fit()
        trace.event('dock_recovered', { visible: visible(), page: root.dataset.page })
      }
      trace.end(shown || visible() ? 'success' : 'error')
    }, 1000)
  }
  const collapsed = (value: boolean) => {
    const pane = nativePane as (HTMLElement & { collapsed: boolean }) | null
    if (pane && pane.collapsed !== value) pane.collapsed = value
  }
  const fit = () => {
    // 停靠兜底已主动收起原生侧栏；宿主重新展开代表用户要回到宿主侧栏。
    if (active && docked && nativePane && !(nativePane as HTMLElement & { collapsed: boolean }).collapsed) {
      leave(true, true); return
    }
    // 用户收起 Zotero 原生侧栏时结束本次激活，不能把有意隐藏误判为挂载失败并转为停靠侧栏。
    if (active && !docked && (nativePane as (HTMLElement & { collapsed?: boolean }) | null)?.collapsed) {
      leave(true, true); return
    }
    if (active && dock && (fallback || outerPane?.classList.contains("stacked"))) {
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
    verifyVisible()
  }
  const leave = (clear = true, preserveHostCollapse = false) => {
    clearTimeout(visibilityTimer); visibilityTimer = undefined
    if (clear) wanted = false
    if (!active) return
    active = false
    detail.removeAttribute("data-jdx-reading-active"); section.removeAttribute("data-jdx-reading-pane")
    if (docked) { docked = false; dock?.hide(); body.append(root) }
    if (nativePane) nativePane.style.minWidth = oldNativeMinWidth
    if (outerPane) { outerPane.style.width = oldWidth; outerPane.style.minWidth = oldMinWidth; if (oldWidthAttribute === null) outerPane.removeAttribute("width"); else outerPane.setAttribute("width", oldWidthAttribute) }
    if (!preserveHostCollapse && detail.pinnedPane === paneID) detail.pinnedPane = oldPin
    if (!preserveHostCollapse && oldCollapsed !== undefined) collapsed(oldCollapsed)
    const nav = (detail as Details & { sidenav?: { _collapsed?: boolean; _contextNotesPaneVisible?: boolean } }).sidenav
    if (nav && !preserveHostCollapse) { nav._collapsed = oldNavCollapsed; nav._contextNotesPaneVisible = oldNotes }
  }
  const activateNative = () => {
    const readerDoc = reader._iframeWindow?.document
    if (readerDoc) void openReaderSidebar(host, readerDoc, reader.itemID, onHistory, reader, false, undefined, undefined, true)
  }
  const nativeClick = (event: Event) => {
    if ((detail as Details & { sidenav?: { container?: HTMLElement } }).sidenav?.container !== detail) return
    const button = (event.target as Element)?.closest<HTMLElement>(".btn[data-pane]")
    if (!button) return
    if (button.dataset.pane === paneID) activateNative()
    else leave()
  }
  let value: Surface
  try { value = surface(host, doc, reader.itemID, { root, history: onHistory, readerDocument: reader._iframeWindow?.document,
    async activate() {
      wanted = true
      root.hidden = false
      if (!active) {
        oldCollapsed = (nativePane as (HTMLElement & { collapsed?: boolean }) | null)?.collapsed
        const nav = (detail as Details & { sidenav?: { _collapsed?: boolean; _contextNotesPaneVisible?: boolean } }).sidenav
        oldNavCollapsed = nav?._collapsed; oldNotes = nav?._contextNotesPaneVisible
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
      if (!docked) collapsed(false)
      detail.pinnedPane = paneID
      fit(); if (!docked) await detail.scrollToPane?.(paneID, "instant"); if (active) fit()
    },
    hide() { leave(); collapsed(true) },
    cleanup() { leave(); dock?.dispose(); resize?.disconnect(); layout?.disconnect(); doc.removeEventListener("click", nativeClick); win?.removeEventListener("resize", fit); bodies.delete(body) },
  }) } catch (error) { leave(); dock?.dispose(); root.remove(); throw error }
  bodies.set(body, value); doc.addEventListener("click", nativeClick); win?.addEventListener("resize", fit)
  try { resize = new (win as Window & typeof globalThis).ResizeObserver(fit); resize.observe(detail); if (nativePane) resize.observe(nativePane) } catch { /* 窗口 resize 仍负责尺寸。 */ }
  try {
    layout = new (win as Window & typeof globalThis).MutationObserver(() => {
      const selected = detail.classList.contains("deck-selected")
      // 宿主折叠也可能暂时移除 deck-selected；先判折叠，避免按切换标签回滚它。
      if (active && !docked && (nativePane as (HTMLElement & { collapsed?: boolean }) | null)?.collapsed) leave(true, true)
      else if (!selected && active) leave(false)
      else if (selected && wanted && !active) activateNative()
      else if (active) fit()
    })
    if (outerPane) layout.observe(outerPane, { attributes: true, attributeFilter: ["class", "collapsed"] })
    if (nativePane && nativePane !== outerPane) layout.observe(nativePane, { attributes: true, attributeFilter: ["collapsed"] })
    layout.observe(detail, { attributes: true, attributeFilter: ["class"] })
  } catch { /* 旧宿主仍响应窗口 resize。 */ }
  fit(); return true
}

/** 错误提示只恢复视图，不保存正文或重放业务动作。 */
function recovery(parent: HTMLElement, host: ZoteroLike, retry: () => void, id?: string, waiting = false) {
  clearRecovery(parent)
  const doc = parent.ownerDocument, root = element(doc, 'section', 'jdx-sidebar-recovery jdx-reader-workspace-empty')
  root.setAttribute('role', 'status'); root.setAttribute('aria-atomic', 'true')
  root.style.cssText = 'display:grid;gap:8px;padding:16px;box-sizing:border-box;white-space:normal;overflow-wrap:anywhere;max-width:100%;font:13px/1.5 system-ui;background:var(--jdx-reader-background,Canvas);color:var(--jdx-reader-text,CanvasText)'
  root.setAttribute('data-jadense-reader-theme', '')
  let stopTheme = () => {}
  try { stopTheme = observeTheme(host, root) } catch { /* 系统 Canvas 颜色兜底。 */ }
  if (parent === doc.body || parent === doc.documentElement) root.style.cssText += ';position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;border:1px solid GrayText'
  root.append(element(doc, 'p', '', waiting ? uiText('阅读器正在准备…', 'Preparing the reader…') : uiText('侧栏暂时无法打开，请重试或打开攻玉工作台。', 'The sidebar is unavailable. Retry or open Jadense Workspace.')))
  if (id && !waiting) root.append(element(doc, 'small', '', uiText(`诊断编号：${id}`, `Diagnostic ID: ${id}`)))
  if (!waiting) {
    const button = element(doc, 'button', '', uiText('重试', 'Retry')); button.type = 'button'; button.onclick = retry; root.append(button)
    const manager = element(doc, 'button', '', uiText('打开攻玉工作台', 'Open Jadense Workspace')); manager.type = 'button'
    manager.onclick = () => {
      try {
        if (!openManagerWindow({ zotero: host, win: host.getMainWindow?.() as Parameters<typeof openManagerWindow>[0]['win'], context: { pluginID: 'jadense-in-zotero@jadense.cn', rootURI: '' }, section: 'chat' })) throw new Error('Manager unavailable')
      } catch { manager.textContent = uiText('工作台不可用，请从 Zotero 工具菜单导出诊断', 'Workspace unavailable. Export diagnostics from Zotero Tools.') }
    }
    root.append(manager)
    for (const action of [button, manager]) action.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid GrayText;border-radius:6px;padding:6px 10px;text-align:start;cursor:pointer'
  }
  parent.append(root)
  const releases = pending.get(host) ?? new Set<() => void>(); pending.set(host, releases)
  const remove = () => { try { stopTheme() } catch { /* 继续回收。 */ } root.remove(); releases.delete(remove); recoveryCleanups.delete(root); doc.defaultView?.removeEventListener('pagehide', remove) }; releases.add(remove)
  recoveryCleanups.set(root, remove); doc.defaultView?.addEventListener('pagehide', remove, { once: true })
  return remove
}

const recoveryCleanups = new WeakMap<HTMLElement, () => void>()
function clearRecovery(parent: HTMLElement) { const root = parent.querySelector<HTMLElement>('.jdx-sidebar-recovery'); if (root) { recoveryCleanups.get(root)?.(); root.remove() } }
const pending = new WeakMap<ZoteroLike, Set<() => void>>()
const nativeWaiting = new WeakMap<HTMLElement, () => void>()
const nativeTabs = new WeakMap<HTMLElement, string | undefined>()
const epochs = new WeakMap<ZoteroLike, number>()
const notices = new WeakMap<Document, () => void>()
const opening = new WeakMap<Document, { itemID: number; latest: Navigation; promise: Promise<void>; cancel(): void }>()
type Navigation = { chat: boolean; quote?: SelectionQuote; resultPage?: ResultPage; preserve?: boolean }
const cancelled = () => Object.assign(new Error('Sidebar opening cancelled'), { name: 'AbortError' })

/** 挂载等待可取消，避免关闭/卸载后长时间宿主 Promise 留下迟到视图。 */
function whileActive<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
async function pause(signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await whileActive(new Promise<void>(resolve => { timer = setTimeout(resolve, 100) }), signal) }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

/** 原生 onRender 允许 Reader 晚到，永不误退到文献库上传视图。 */
export function renderNativeReaderSidebar(body: HTMLElement, host: ZoteroLike, onHistory?: () => void) {
  const detail = body.closest('item-details') as Details | null, tabID = detail?.tabID
  const existing = bodies.get(body), reader = sidebarReader(host, body)
  if (existing && existing.itemID === reader?.itemID) return
  existing?.remove()
  if (nativeWaiting.has(body) && nativeTabs.get(body) === tabID) return
  nativeWaiting.get(body)?.(); nativeTabs.set(body, tabID)
  const controller = new AbortController(), releases = pending.get(host) ?? new Set<() => void>()
  pending.set(host, releases)
  let clear = () => {}, wasConnected = body.isConnected
  const cancel = () => { controller.abort(); clear(); releases.delete(cancel); if (nativeWaiting.get(body) === cancel) nativeWaiting.delete(body) }
  releases.add(cancel); nativeWaiting.set(body, cancel)
  const trace = lifecycleTrace(host, 'reader-sidebar', 'native_render', 'reader')
  void (async () => {
    try {
      trace.event('reader_lookup')
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted || (wasConnected && !body.isConnected) || detail?.tabID !== tabID) throw cancelled()
        wasConnected ||= body.isConnected
        if (sidebarReader(host, body)) {
          clear(); mountNativeReaderSidebar(body, host, onHistory); trace.event('content_mounted'); trace.end(); return
        }
        if (attempt === 30) throw Object.assign(new Error('Reader not ready'), { code: 'SIDEBAR_READER_TIMEOUT' })
        if (!attempt) clear = recovery(body, host, () => {}, undefined, true)
        await pause(controller.signal)
      }
    } catch (error) {
      clear()
      if ((error as Error).name === 'AbortError') { trace.event('window_closed'); trace.end('cancelled'); return }
      trace.fail(error, 'native_mount'); trace.end('error')
      clear = recovery(body, host, () => { cancel(); renderNativeReaderSidebar(body, host, onHistory) }, trace.id)
    } finally { if (nativeWaiting.get(body) === cancel) nativeWaiting.delete(body); releases.delete(cancel) }
  })().catch(error => { trace.fail(error, 'closed_surface'); trace.end('cancelled') })
}
export function removeNativeReaderSidebar(body: HTMLElement) { nativeWaiting.get(body)?.(); bodies.get(body)?.remove(); clearRecovery(body) }

/** 工具栏与原生入口共享一次挂载，最后一次显式导航获胜。 */
export async function openTranslationSidebar(host: ZoteroLike, readerDoc: Document, itemID: number, onHistory: () => void, originReader?: Reader) {
  return openReaderSidebar(host, readerDoc, itemID, onHistory, originReader, false)
}
export async function openChatSidebar(host: ZoteroLike, readerDoc: Document, itemID: number, originReader?: Reader, quote?: SelectionQuote) {
  return openReaderSidebar(host, readerDoc, itemID, undefined, originReader, true, quote)
}
function openReaderSidebar(host: ZoteroLike, readerDoc: Document, itemID: number, onHistory: (() => void) | undefined, originReader: Reader | undefined, chat: boolean, quote?: SelectionQuote, resultPage?: ResultPage, preserve = false): Promise<void> {
  const existing = opening.get(readerDoc), navigation = { chat, quote, resultPage, preserve }
  if (existing?.itemID === itemID) { existing.latest = navigation; return existing.promise }
  existing?.cancel(); notices.get(readerDoc)?.(); notices.delete(readerDoc)
  const controller = new AbortController(), epoch = epochs.get(host) ?? 0
  const trace = lifecycleTrace(host, 'reader-sidebar', 'open', 'reader')
  const releases = pending.get(host) ?? new Set<() => void>(); pending.set(host, releases)
  const cancel = () => controller.abort(); releases.add(cancel)
  readerDoc.defaultView?.addEventListener('pagehide', cancel, { once: true })
  const state = { itemID, latest: navigation, promise: Promise.resolve(), cancel }
  opening.set(readerDoc, state)
  let initiallySelected: boolean | undefined
  let reader: Reader | undefined, targetBody: HTMLElement | undefined, mounted: Surface | undefined
  const check = () => {
    if (reader?.tabID) {
      const selected = (reader._window as (Window & { Zotero_Tabs?: { selectedID?: string } }) | undefined)?.Zotero_Tabs?.selectedID
      initiallySelected ??= selected === reader.tabID
      if (initiallySelected && selected !== reader.tabID) throw cancelled()
    }
    if (controller.signal.aborted || (originReader && (originReader.itemID !== itemID || !isLiveDocumentReader(originReader))) || (epochs.get(host) ?? 0) !== epoch || readerDoc.defaultView?.closed || (reader && (!isLiveDocumentReader(reader) || reader.itemID !== itemID || !sameDocument(reader._iframeWindow?.document, readerDoc)))) throw cancelled()
  }
  const show = async (value: Surface) => {
    // 激活等待期间收到的新导航在同一视图上完成，不重复挂载。
    let navigation: Navigation
    do {
      check(); navigation = state.latest
      await whileActive(value.show(!navigation.chat && !navigation.preserve, onHistory, navigation.chat, navigation.quote, navigation.resultPage), controller.signal)
      check()
    } while (navigation !== state.latest)
  }
  state.promise = (async () => {
    try {
      trace.event('reader_lookup')
      for (let attempt = 0; ; attempt++) {
        check()
        reader = originReader?.itemID === itemID && isLiveDocumentReader(originReader) && sameDocument(originReader._iframeWindow?.document, readerDoc) ? originReader : readers(host).find(value => value.itemID === itemID && sameDocument(value._iframeWindow?.document, readerDoc))
        if (reader) break
        if (attempt === 30) throw Object.assign(new Error('Reader not ready'), { code: 'SIDEBAR_READER_TIMEOUT' })
        if (!attempt) notices.set(readerDoc, recovery(readerDoc.body ?? readerDoc.documentElement, host, () => {}, undefined, true))
        await pause(controller.signal)
      }
      check(); notices.get(readerDoc)?.(); notices.delete(readerDoc)
      const previous = docks.get(readerDoc)
      if (previous?.itemID === itemID) { mounted = previous; await show(previous); trace.event('dock_reused'); trace.end(); return }
      previous?.remove()
      const doc = reader._window?.document
      try {
        if (doc && reader.tabID) {
          const detail = Array.from(doc.querySelectorAll('item-details')).find(value => (value as Details).tabID === reader!.tabID) as Details | undefined
          const selector = `item-pane-custom-section[data-pane$="${PANE}"] [data-type="body"]`
          trace.event('native_render')
          if (detail && !detail.querySelector(selector)) await whileActive(Promise.resolve(detail.render?.()), controller.signal)
          check()
          if (detail && detail.tabID !== reader.tabID) throw cancelled()
          targetBody = detail?.querySelector<HTMLElement>(selector) ?? undefined
          if (targetBody && !bodies.has(targetBody)) { nativeWaiting.get(targetBody)?.(); mountNativeReaderSidebar(targetBody, host, onHistory) }
          mounted = targetBody ? bodies.get(targetBody) : undefined
          if (mounted) { trace.event('native_activate'); await show(mounted); trace.event('native_ready'); trace.end(); return }
        }
      } catch (error) {
        mounted?.remove(); mounted = undefined
        check()
        if ((error as { code?: string }).code === 'SIDEBAR_CONTENT_FAILED') throw error
        trace.fail(error, 'native_failed', 'SIDEBAR_NATIVE_FAILED')
      }
      check(); trace.event('dock_mount')
      const parent = reader._iframe?.parentElement, owner = parent?.ownerDocument ?? readerDoc
      const target = parent ?? readerDoc.body ?? readerDoc.documentElement
      const root = element(owner, 'aside'), dock = dockFrame(root, target, host)
      const remove = () => mounted?.remove()
      try {
        mounted = surface(host, owner, itemID, { root, history: onHistory, readerDocument: readerDoc,
          activate() { check(); root.hidden = false; dock.show() },
          hide() { root.hidden = true; dock.hide() },
          cleanup() { dock.dispose(); readerDoc.defaultView?.removeEventListener('pagehide', remove); docks.delete(readerDoc) },
        })
      } catch (error) { dock.dispose(); root.remove(); throw error }
      readerDoc.defaultView?.addEventListener('pagehide', remove, { once: true })
      docks.set(readerDoc, mounted); await show(mounted); trace.event('dock_ready'); trace.end()
    } catch (error) {
      mounted?.remove(); notices.get(readerDoc)?.(); notices.delete(readerDoc)
      if ((error as Error).name === 'AbortError') { trace.event('window_closed'); trace.end('cancelled'); return }
      trace.fail(error, 'open_failed', (error as { code?: string }).code === 'SIDEBAR_READER_TIMEOUT' ? 'SIDEBAR_READER_TIMEOUT' : 'SIDEBAR_OPEN_FAILED'); trace.end('error')
      // 重试只恢复当前功能页，不再次创建引用会话。
      const retry = () => { void openReaderSidebar(host, readerDoc, itemID, onHistory, originReader, false, undefined, state.latest.resultPage ?? (state.latest.chat ? undefined : 'translation'), state.latest.chat || state.latest.preserve) }
      notices.set(readerDoc, recovery(targetBody?.isConnected ? targetBody : readerDoc.body ?? readerDoc.documentElement, host, retry, trace.id))
    } finally {
      releases.delete(cancel); readerDoc.defaultView?.removeEventListener('pagehide', cancel)
      if (opening.get(readerDoc) === state) opening.delete(readerDoc)
    }
  })().catch(error => { trace.fail(error, 'closed_surface'); trace.end('cancelled') })
  return state.promise
}

export function removeReaderSidebars(host: ZoteroLike) {
  epochs.set(host, (epochs.get(host) ?? 0) + 1)
  for (const cancel of [...pending.get(host) ?? []]) { try { cancel() } catch { /* 继续清理。 */ } }
  pending.delete(host)
  const mounted = [...surfaces.get(host) ?? []]
  for (const value of mounted) { try { value.remove() } catch { /* 一个失效窗口不阻断其余视图清理。 */ } }
  for (const doc of styleDocuments.get(host) ?? []) {
    try {
      for (const id of ['jdx-reader-sidebar-css', 'jdx-ui-css', 'jdx-chat-css', 'jdx-analysis-css', 'jdx-reader-workspace-css']) doc.getElementById(id)?.remove()
      if (!doc.querySelector('.jdx-translation-reader')) doc.getElementById('jdx-translation-reading-css')?.remove()
    } catch { /* 已关闭文档无需再清理 DOM。 */ }
  }
  styleDocuments.delete(host)
}
export function removeReaderDock(doc: Document) { opening.get(doc)?.cancel(); notices.get(doc)?.(); notices.delete(doc); docks.get(doc)?.remove() }

/** 明确查看解析时才展开当前 PDF 的总结侧栏。 */
export function openAnalysisSidebar(host: ZoteroLike, doc: Document, itemID: number, reader?: Reader) {
  return openReaderSidebar(host, doc, itemID, undefined, reader, false, undefined, "summary")
}
