import { readPDFTranslationMode, pdfModeLabel, type PDFTranslationMode } from './pdf-translation-policy'
import { wireReadingBudgetSettings } from './translation-budget-settings'
/** 原生 PDF 旁的译文视图；保持原 Reader 实例，退出恢复宿主布局与批注交互。 */
import type { ZoteroLike } from './runtime'
import { pdfTranslationJobs, type PDFTranslationTask } from './pdf-translation-jobs'
import { uiText } from './ui-preferences'
import { pdfTranslationStatusView, type PDFStatusNotice } from './pdf-translation-status'
import { observeTheme } from './ui-preferences'
import { READER_UI_THEME_CSS } from './reader-ui-theme'
import { chromeContentUrl } from './chrome-registration'
import type { ZoteroManagerWindow } from './manager-window'
import { copyTextToClipboard } from './connection-display'
import { validateDocument, type DocumentIdentity } from './pdf-document'
import { createJdxSelect, type JdxSelect } from './ui/select'
import { actionIcon } from './ui/controls'
import { createChevron } from './ui/chevron'
import { bindReaderControlPopover } from './reader-toolbar-menu'
import { leaveOtherReadingMode, registerReadingMode, readingTransition } from './simple-reading-modes'

export type PDFReadingState = { page: number; fraction: number; scale: number; rotation: number }
type NativePDF = { pagesCount: number; currentPageNumber: number; currentScale: number; currentScaleValue: string; pagesRotation: number; container: HTMLElement; getPageView(index: number): { div: HTMLElement }; eventBus: { on(name: string, callback: () => void): void; off(name: string, callback: () => void): void } }
type Reader = { itemID: number; _initPromise?: Promise<unknown>; _internalReader?: { _primaryView?: { initializedPromise?: Promise<unknown>; _iframeWindow?: Window & { PDFViewerApplication?: { pdfViewer?: NativePDF } } } } }
type PDFView = { open(bytes: Uint8Array, notify: (state: PDFReadingState) => void, workerSource: string): Promise<number>; state(): PDFReadingState; set(state: PDFReadingState): void; find(query: string, again?: boolean): void; destroy(): Promise<void> }
type WireView = Omit<PDFView, 'open'> & { open(bytes: Uint8Array, notify: (state: string) => void, workerSource: string): Promise<number>; stateJSON(): string }
const views = new Map<Reader, { taskID(): string | undefined; show(mode: 'compare' | 'inplace'): void; remove(): void }>()

/** 从历史返回原生原文阅读器，关闭该附件已有的对照视图。 */
export async function openOriginalPDF(host: ZoteroLike, source: DocumentIdentity) {
  await validateDocument(host, source)
  const reader = await (host as ZoteroLike & { Reader?: { open(id: number): Promise<Reader | undefined> } }).Reader?.open(source.itemID)
  if (reader) { await leaveOtherReadingMode(reader, 'pdf'); views.get(reader)?.remove() }
}

/** 将页内位置规范化，不使用左右阅读区不同的绝对滚动像素。 */
export function normalizedPDFState(value: PDFReadingState): PDFReadingState {
  return { page: Math.max(1, Math.floor(value.page) || 1), fraction: Number.isFinite(value.fraction) ? Math.max(0, Math.min(1, value.fraction)) : 0,
    scale: Number.isFinite(value.scale) && value.scale > 0 ? value.scale : 1, rotation: ((Math.round(value.rotation / 90) * 90 || 0) % 360 + 360) % 360 }
}

/** 从历史明确打开指定版本；不调用 start，配置变化不会重新翻译。 */
export async function openSavedPDFTranslation(host: ZoteroLike, id: string) {
  const jobs = pdfTranslationJobs(host), task = jobs.get(id)
  await jobs.bytes(id)
  const reader = await (host as ZoteroLike & { Reader?: { open(id: number): Promise<Reader | undefined> } }).Reader?.open(task!.source.itemID)
  if (!reader) throw new Error(uiText('无法打开 PDF 阅读器。', 'Could not open the PDF reader.'))
  await reader._initPromise
  await reader._internalReader?._primaryView?.initializedPromise
  await openPDFTranslation(host, reader, 'compare', id)
}

export async function openPDFTranslation(host: ZoteroLike, reader: Reader, mode: 'compare' | 'inplace', savedTaskID?: string) {
  return readingTransition(reader, () => mountPDFTranslation(host, reader, mode, savedTaskID))
}

async function mountPDFTranslation(host: ZoteroLike, reader: Reader, mode: 'compare' | 'inplace', savedTaskID?: string) {
  await leaveOtherReadingMode(reader, 'pdf')
  const existing = views.get(reader)
  if (existing && (!savedTaskID || existing.taskID() === savedTaskID)) { existing.show(mode); return }
  existing?.remove()
  const nativeWindow = reader._internalReader?._primaryView?._iframeWindow
  const native = nativeWindow?.PDFViewerApplication?.pdfViewer
  const original = nativeWindow?.frameElement as HTMLElement | null, parent = original?.parentElement
  if (!native || !original || !parent) throw new Error(uiText('PDF 阅读器尚未就绪，请稍后重试。', 'PDF reader is not ready. Try again.'))
  const automaticPDFScale = /^(?:auto|page-width|page-fit|page-height)$/u.test(native.currentScaleValue) ? native.currentScaleValue : undefined
  const doc = parent.ownerDocument, win = doc.defaultView!, jobs = pdfTranslationJobs(host)
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
  const panel = element('section'), toolbar = element('div'), status = element('div'), embeddedFrame = element('iframe'), style = element('style')
  let frame = embeddedFrame
  panel.className = 'jdx-pdf-translation'; toolbar.className = 'jdx-pdf-translation-toolbar'; status.className = 'jdx-pdf-translation-popover jdx-pdf-translation-status-panel'
  panel.setAttribute('data-jadense-reader-theme', '')
  panel.setAttribute('aria-label', uiText('PDF 译文', 'Translated PDF'))
  status.hidden = true; status.setAttribute('role', 'dialog'); status.setAttribute('aria-label', uiText('翻译状态', 'Translation status'))
  style.textContent = `${READER_UI_THEME_CSS}
.jdx-pdf-translation{position:absolute;inset:0;z-index:3;pointer-events:none;color:var(--jdx-reader-text,#222);display:flex;align-items:flex-end;flex-direction:column;font:calc(13px * var(--jdx-font-scale,1)) system-ui;min-width:0;container-type:inline-size;--jdx-green:#16cf8c;--jdx-text:var(--jdx-reader-text);--jdx-muted:var(--jdx-reader-muted);--jdx-line:var(--jdx-reader-line);--jdx-line-strong:var(--jdx-reader-border);--jdx-surface:var(--jdx-reader-background);--jdx-subtle:var(--jdx-reader-surface);--jdx-active-bg:var(--jdx-reader-active);--jdx-green-deep:var(--jdx-green)}
.jdx-pdf-translation-toolbar{display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--jdx-reader-line);flex:none;box-sizing:border-box;width:100%;min-height:42px;background:var(--jdx-reader-background,#fff);pointer-events:auto;white-space:nowrap;overflow:hidden}
.jdx-pdf-translation-group{display:flex;align-items:center;gap:4px;min-width:0}
.jdx-pdf-translation-primary{width:100%}
.jdx-pdf-translation-primary .jdx-pdf-task{margin-inline-start:auto}
.jdx-pdf-translation button,.jdx-pdf-translation input{box-sizing:border-box;font:inherit;color:inherit;border:1px solid var(--jdx-reader-border);border-radius:6px;min-height:32px}
.jdx-pdf-translation button{padding:4px 9px;background:transparent;cursor:pointer;white-space:nowrap}
.jdx-pdf-translation button:hover{background:var(--jdx-reader-hover)}
.jdx-pdf-translation button:disabled{opacity:.45;cursor:default}
.jdx-pdf-translation button:focus-visible,.jdx-pdf-translation input:focus-visible{outline:2px solid var(--jdx-green);outline-offset:1px}
.jdx-pdf-translation input{padding:4px 8px;width:58px;background:var(--jdx-reader-surface);border-color:var(--jdx-reader-line)}
.jdx-pdf-translation input[type=search]{width:100%;max-width:100%}
.jdx-pdf-translation button[aria-pressed=true]{background:var(--jdx-reader-surface);border-color:var(--jdx-green);color:var(--jdx-reader-text)}
.jdx-pdf-translation .jdx-pdf-save{background:var(--jdx-reader-surface);border-color:var(--jdx-reader-line)}
.jdx-pdf-translation .jdx-icon-action{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;min-width:32px;padding:0;font-size:0}
.jdx-pdf-translation .jdx-icon-action::before{content:"";width:18px;height:18px;background:currentColor;mask:var(--jdx-action-icon) center/contain no-repeat}
.jdx-pdf-translation .jdx-pdf-mode{width:auto;min-width:32px;padding:4px 9px;gap:6px;font-size:inherit}
.jdx-pdf-translation .jdx-pdf-return{width:auto;min-width:32px;padding:4px 9px;gap:6px;font-size:inherit}
.jdx-pdf-translation-popover{position:absolute;z-index:5;top:44px;box-sizing:border-box;min-width:220px;max-width:min(320px,calc(100% - 16px));max-height:calc(100% - 52px);overflow:auto;padding:8px;border:1px solid var(--jdx-reader-border);border-radius:8px;background:var(--jdx-reader-background);box-shadow:0 10px 24px rgba(0,0,0,.16);pointer-events:auto;white-space:normal}
.jdx-pdf-translation-popover[hidden]{display:none!important}
.jdx-pdf-translation-popover .jdx-pdf-translation-group{display:flex;align-items:stretch;flex-direction:column;gap:2px;padding:5px 0;border-bottom:1px solid var(--jdx-reader-line)}
.jdx-pdf-translation-popover .jdx-pdf-translation-group:last-child{border:0}
.jdx-pdf-translation-popover .jdx-pdf-translation-group::before{content:attr(aria-label);padding:2px 8px;color:var(--jdx-reader-muted);font-size:calc(11px * var(--jdx-font-scale,1));font-weight:600}
.jdx-pdf-translation-popover .jdx-pdf-translation-group>button{text-align:start;width:100%}
.jdx-pdf-translation-search{min-width:210px}
.jdx-pdf-scope{width:100%;padding:4px 0}
.jdx-pdf-view{width:130px;min-width:100px;max-width:150px;flex:none;padding:0}
.jdx-pdf-scope .jdx-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:32px;padding:4px 8px;border:1px solid var(--jdx-reader-border);background:var(--jdx-reader-surface);text-align:start}
.jdx-pdf-scope .jdx-select-chevron{flex:none;width:14px;height:14px}
.jdx-pdf-scope .jdx-select-popup{position:fixed;z-index:10;display:none;overflow:auto;border:1px solid var(--jdx-reader-border);border-radius:8px;padding:4px;background:var(--jdx-reader-background);box-shadow:0 10px 24px rgba(0,0,0,.16)}
.jdx-pdf-scope[data-open=true] .jdx-select-popup{display:block}
.jdx-pdf-scope .jdx-select-list{list-style:none;margin:0;padding:0}
.jdx-pdf-scope .jdx-select-option{min-height:32px;padding:6px 8px;border-radius:5px;cursor:pointer}
.jdx-pdf-scope .jdx-select-option[data-active=true]{background:var(--jdx-reader-hover)}
.jdx-pdf-scope .jdx-select-option[aria-selected=true]{color:var(--jdx-green-deep)}
.jdx-pdf-scope .jdx-select-option-description{display:none}
@container (max-width:390px){.jdx-pdf-view{width:92px;min-width:92px}.jdx-pdf-translation .jdx-pdf-return{width:32px;padding:0;font-size:0}}
.jdx-pdf-translation iframe{width:50%;flex:1;min-height:0;border:0;border-left:1px solid var(--jdx-reader-line);box-sizing:border-box;pointer-events:auto}
.jdx-pdf-status-chip{display:inline-flex;align-items:center;gap:6px;max-width:min(320px,42%);min-width:0;text-align:start}
.jdx-pdf-status-chip .jdx-pdf-status-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jdx-pdf-status-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--jdx-reader-muted)}
.jdx-pdf-status-chip[data-state=busy] .jdx-pdf-status-dot,.jdx-pdf-status-chip[data-state=success] .jdx-pdf-status-dot{background:var(--jdx-green)}
.jdx-pdf-status-chip[data-state=warning] .jdx-pdf-status-dot{background:#c37d0d}
.jdx-pdf-status-chip[data-state=error] .jdx-pdf-status-dot{background:#d45656}
.jdx-pdf-status-chip.is-working .jdx-pdf-status-dot{animation:jdx-pdf-working 1.6s ease-in-out infinite}
.jdx-pdf-status-chip .jdx-pdf-status-chevron{flex:none;width:14px;height:14px;color:var(--jdx-reader-muted)}
.jdx-pdf-status-chip[aria-expanded=true] .jdx-pdf-status-chevron{transform:rotate(180deg)}
.jdx-pdf-translation-status-panel{min-width:260px;max-width:min(420px,calc(100% - 16px))}
.jdx-pdf-status-content{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.4;color:var(--jdx-reader-muted);user-select:text;outline:none}
.jdx-pdf-status-content progress{display:block;width:100%;height:4px;margin:2px 0 6px;accent-color:var(--jdx-green)}
.jdx-pdf-status-content details{font-size:12px;margin-top:6px}
.jdx-pdf-status-content summary{cursor:pointer}
.jdx-pdf-status-actions{display:flex;gap:6px;margin-top:8px;padding-top:6px;border-top:1px solid var(--jdx-reader-line)}
@keyframes jdx-pdf-working{0%,100%{opacity:1}50%{opacity:.35}}
@media(prefers-reduced-motion:reduce){.jdx-pdf-status-chip.is-working .jdx-pdf-status-dot{animation:none}}
.jdx-pdf-translation [hidden]{display:none!important}`
  const previousWidth = original.style.width, previousVisibility = original.style.visibility, previousPosition = parent.style.position, previousTop = original.style.top, previousHeight = original.style.height, previousFramePosition = original.style.position
  if (win.getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
  original.style.position = 'absolute'
  let currentMode = mode, showingOriginal = false, removed = false, task: PDFTranslationTask | undefined, api: PDFView | undefined, loadedID = '', loadingID = '', renderEpoch = 0
  let detached: Window | undefined, detachedPanel: HTMLElement | undefined, openingWindow = false, restoredAnchor: PDFReadingState | undefined, lastReadingState: PDFReadingState | undefined
  let stopDetachedTheme: (() => void) | undefined, detachedObserver: MutationObserver | undefined, detachedObserverCleanup: (() => void) | undefined
  let stopFrameIntent: (() => void) | undefined
  let windowError = ''
  let notice: PDFStatusNotice | undefined
  let statusPopoverClosers: Array<() => void> = []
  let pendingWindow: Window | undefined
  let preparation = new AbortController()
  let linked = host.Prefs?.get('extensions.jadenseInZotero.pdfLinkedScroll', true) !== false
  let activeSide: 'native' | 'translation' = 'native'
  const cleanups: (() => void)[] = []
  // 输入决定主导侧；目标视图延迟发出的 PDF.js 事件不能反向拉回正在操作的视图。
  const trackIntent = (target: Window, side: typeof activeSide) => {
    const activate = () => { activeSide = side }
    const names = ['wheel', 'pointerdown', 'keydown', 'touchstart']
    for (const name of names) target.addEventListener(name, activate, true)
    return () => { try { for (const name of names) target.removeEventListener(name, activate, true) } catch { /* 已关闭的内容窗口已自动释放监听。 */ } }
  }
  cleanups.push(trackIntent(nativeWindow!, 'native'))
  const control = <T extends HTMLElement>(node: T, id: string) => { node.dataset.pdfControl = id; return node }
  const primary = element('div'), overflow = element('div'), searchPanel = element('div')
  primary.className = 'jdx-pdf-translation-group jdx-pdf-translation-primary'; primary.setAttribute('role', 'group'); primary.setAttribute('aria-label', uiText('对照翻译主要操作', 'PDF translation primary actions'))
  overflow.className = 'jdx-pdf-translation-popover'; overflow.hidden = true; overflow.setAttribute('role', 'dialog'); overflow.setAttribute('aria-label', uiText('对照翻译操作', 'PDF translation actions'))
  searchPanel.className = 'jdx-pdf-translation-popover jdx-pdf-translation-search'; searchPanel.hidden = true; searchPanel.setAttribute('role', 'search'); searchPanel.setAttribute('aria-label', uiText('译文搜索', 'Translation search'))
  toolbar.append(primary)
  const group = (label: string, parent = overflow) => { const node = element('div'); node.className = 'jdx-pdf-translation-group'; node.setAttribute('role', 'group'); node.setAttribute('aria-label', label); parent.append(node); return node }
  const navigation = group(uiText('阅读与视图', 'Reading and view')), saveGroup = group(uiText('保存', 'Save')), configGroup = group(uiText('翻译设置', 'Translation settings'))
  navigation.dataset.pdfSection = 'reading'
  let buttonGroup = navigation
  const button = (label: string, callback: () => void, id: string) => { const node = control(element('button'), id); node.type = 'button'; node.textContent = label; node.addEventListener('click', callback); buttonGroup.append(node); return node }
  const error = (value: unknown) => { if (!removed) { notice = { text: value instanceof Error ? value.message : String(value), tone: 'error' }; void render() } }
  const nativeState = (): PDFReadingState => {
    let index = Math.max(0, native.currentPageNumber - 1)
    // currentPageNumber 可能指向完全可见的下一页；位置锚点必须取视口顶部所在页。
    while (index > 0 && native.getPageView(index).div.offsetTop > native.container.scrollTop) index--
    while (index + 1 < native.pagesCount && native.getPageView(index + 1).div.offsetTop <= native.container.scrollTop) index++
    const page = native.getPageView(index)?.div
    return normalizedPDFState({ page: index + 1, fraction: page ? (native.container.scrollTop - page.offsetTop) / page.offsetHeight : 0, scale: native.currentScale, rotation: native.pagesRotation })
  }
  const setNative = (input: PDFReadingState) => {
    const value = normalizedPDFState(input)
    if (native.pagesRotation !== value.rotation) native.pagesRotation = value.rotation
    if (Math.abs(native.currentScale - value.scale) > .001) native.currentScale = value.scale
    const page = native.getPageView(value.page - 1)?.div
    if (page) native.container.scrollTop = page.offsetTop + page.offsetHeight * value.fraction
  }
  const fromNative = () => {
    if (activeSide !== 'native' || !loadedID || !api || !(currentMode === 'compare' || showingOriginal)) return
    if (linked || currentMode === 'inplace') api.set(nativeState())
  }
  const alignHeader = () => { const height = detached ? 0 : toolbar.offsetHeight; original.style.top = detached ? previousTop : `${height}px`; original.style.height = detached ? previousHeight : `calc(100% - ${height}px)` }
  const fit = () => {
    if (!automaticPDFScale || native.currentScaleValue !== automaticPDFScale || currentMode !== 'compare' || detached || !api) return
    const current = nativeState()
    native.currentScaleValue = automaticPDFScale
    const state = { ...current, scale: native.currentScale }
    setNative(state); api.set(state)
  }
  const applyMode = (anchor = api && !showingOriginal ? api.state() : nativeState()) => {
    original.style.width = !detached && currentMode === 'compare' && !showingOriginal && api ? '50%' : previousWidth
    original.style.visibility = !detached && currentMode === 'inplace' && !showingOriginal && api ? 'hidden' : previousVisibility
    frame.style.width = !detached && currentMode === 'compare' ? '50%' : '100%'
    frame.hidden = showingOriginal || !api
    link.hidden = currentMode !== 'compare' || showingOriginal; link.disabled = !api
    viewSelect.setValue(detached ? 'multi' : showingOriginal ? 'source' : currentMode === 'inplace' ? 'translation' : 'compare')
    multiScreen.disabled = !api || openingWindow
    multiScreen.textContent = detached ? uiText('返回对照阅读', 'Return to comparison') : uiText('多屏模式', 'Multi-screen')
    multiScreen.title = detached ? uiText('关闭独立译文窗口，返回双栏对照阅读。', 'Close the separate translation window and return to comparison.') : uiText('在独立窗口阅读译文，可拖到另一块屏幕。', 'Read the translated PDF in a separate window that can be moved to another screen.')
    alignHeader(); setNative(anchor); api?.set(anchor)
  }
  const viewHost = control(element('div'), 'view'); viewHost.className = 'jdx-pdf-scope jdx-pdf-view'; primary.append(viewHost)
  const viewSelect = createJdxSelect(viewHost, { ariaLabel: uiText('阅读视图', 'Reading view') })
  viewSelect.setOptions([
    { value: 'source', label: uiText('原 PDF', 'Original PDF') },
    { value: 'compare', label: uiText('双视图', 'Split view') },
    { value: 'translation', label: uiText('仅显示译文', 'Translation only') },
    { value: 'multi', label: uiText('多屏模式', 'Multi-screen') },
  ], 'compare')
  viewSelect.onChange(value => {
    if (value === 'multi') { if (api) multiScreen.click(); else viewSelect.setValue(showingOriginal ? 'source' : 'compare'); return }
    if (value === 'translation' && !api) { viewSelect.setValue('source'); return }
    const anchor = showingOriginal || !api ? nativeState() : api.state()
    showingOriginal = value === 'source'; currentMode = value === 'translation' ? 'inplace' : 'compare'; applyMode(anchor)
  })
  cleanups.push(() => viewSelect.destroy())
  const multiScreen = button(uiText('多屏模式', 'Multi-screen'), () => { if (detached) restorePanel(); else void detachPanel().catch(error) }, 'multi-screen')
  multiScreen.hidden = true
  multiScreen.title = uiText('在独立窗口阅读译文，可拖到另一块屏幕。', 'Read the translated PDF in a separate window that can be moved to another screen.')
  const link = button(uiText('同步滚动', 'Sync scroll'), () => {
    linked = !linked; link.setAttribute('aria-pressed', String(linked))
    host.Prefs?.set('extensions.jadenseInZotero.pdfLinkedScroll', linked, true)
    if (linked && api) { if (activeSide === 'translation') setNative(api.state()); else api.set(nativeState()) }
  }, 'sync')
  link.setAttribute('aria-pressed', String(linked)); link.title = uiText('开启后，两侧按页码和页内高度同步；关闭后可独立阅读。', 'Link page and relative vertical position, or scroll each PDF independently.')
  const find = control(element('input'), 'find'); find.type = 'search'; find.placeholder = uiText('搜索译文', 'Find'); find.setAttribute('aria-label', find.placeholder); searchPanel.append(find)
  find.addEventListener('input', () => { activeSide = 'translation'; api?.find(find.value) }); find.addEventListener('keydown', event => { if (event.key === 'Enter') api?.find(find.value, true) })
  buttonGroup = saveGroup
  const mono = button(uiText('保存译文', 'Save PDF'), () => { if (task) void jobs.export(task.id, 'mono', win).catch(error) }, 'save-pdf')
  const dual = button(uiText('保存对照', 'Save bilingual'), () => { if (task) void jobs.export(task.id, 'dual', win).catch(error) }, 'save-bilingual')
  mono.className = dual.className = 'jdx-pdf-save'
  buttonGroup = configGroup
  let translationMode: PDFTranslationMode = savedTaskID ? jobs.get(savedTaskID)?.mode ?? 'full' : readPDFTranslationMode(host)
  const scopeHost = control(element('div'), 'scope'); scopeHost.className = 'jdx-pdf-scope'; configGroup.append(scopeHost)
  const scopeOptions = (['concise', 'full'] as const).map(value => ({ value, label: pdfModeLabel(value) }))
  const scope = createJdxSelect(scopeHost, { ariaLabel: uiText('翻译范围', 'Translation scope') })
  let detachedScope: JdxSelect | undefined
  scope.setOptions(scopeOptions, translationMode)
  scope.onChange(value => { translationMode = value as PDFTranslationMode; detachedScope?.setValue(value) })
  const regenerate = button(uiText('按当前设置重新翻译', 'Translate again with current settings'), () => { savedTaskID = undefined; void start(true) }, 'regenerate')
  cleanups.push(wireReadingBudgetSettings(host, configGroup, ['pdf']))
  const retry = button(uiText('重试', 'Retry'), () => { if (task?.status === 'complete') void render(); else if (task) jobs.retry(task.id); else void start() }, 'retry')
  const cancel = button(uiText('取消', 'Cancel'), () => { if (task) jobs.cancel(task.id); preparation.abort() }, 'cancel')
  const closeMenu = button(uiText('退出对照翻译', 'Exit PDF translation'), () => remove(), 'exit'); closeMenu.hidden = true
  const statusContent = element('div'); statusContent.className = 'jdx-pdf-status-content'; statusContent.setAttribute('role', 'status'); statusContent.tabIndex = 0
  const statusActions = element('div'); statusActions.className = 'jdx-pdf-status-actions'; status.append(statusContent, statusActions)
  const copyStatus = control(element('button'), 'copy-status'); copyStatus.type = 'button'; copyStatus.textContent = uiText('复制提示', 'Copy details')
  copyStatus.addEventListener('click', () => {
    void copyTextToClipboard(host, statusContent.textContent ?? '').then(copied => {
      copyStatus.textContent = copied ? uiText('已复制提示', 'Details copied') : uiText('复制失败，请选择提示文字复制', 'Copy failed; select the details to copy')
    })
  })
  const repair = control(element('button'), 'repair'); repair.type = 'button'; repair.textContent = uiText('修复引擎', 'Repair engine')
  repair.addEventListener('click', () => {
    if (task?.status === 'running' || task?.status === 'queued') { notice = { text: uiText('请先取消当前任务，再修复引擎。', 'Cancel the current task before repairing the engine.'), tone: 'info' }; void render(); return }
    preparation = new AbortController()
    void jobs.prepare(preparation.signal, stage => { notice = { text: stage === 'assets' ? uiText('准备模型和字体…', 'Preparing models and fonts…') : uiText('安装引擎…', 'Installing engine…'), tone: 'info' }; void render() }, true).then(() => { notice = { text: uiText('引擎已准备，请点击重试。', 'Engine ready. Click Retry.'), tone: 'info' }; void render() }).catch(error)
  })
  statusActions.append(copyStatus, repair)
  const statusToggle = control(element('button'), 'status-toggle'); statusToggle.type = 'button'; statusToggle.className = 'jdx-pdf-status-chip'; statusToggle.hidden = true
  const statusDot = element('span'); statusDot.className = 'jdx-pdf-status-dot'; statusDot.setAttribute('aria-hidden', 'true')
  const statusLabel = element('span'); statusLabel.className = 'jdx-pdf-status-label'
  statusToggle.append(statusDot, statusLabel, createChevron(doc, 'jdx-pdf-status-chevron', 'down', 14))
  primary.prepend(statusToggle)
  const searchToggle = control(element('button'), 'search-toggle'); searchToggle.type = 'button'; searchToggle.textContent = uiText('搜索译文', 'Find translation'); actionIcon(searchToggle, 'search', searchToggle.textContent); primary.append(searchToggle)
  const taskAction = control(element('button'), 'task-action'); taskAction.type = 'button'; taskAction.className = 'jdx-pdf-task'; taskAction.addEventListener('click', () => { if (!cancel.hidden) cancel.click(); else if (task && task.status !== 'complete') retry.click(); else mono.click() }); primary.append(taskAction)
  const moreToggle = control(element('button'), 'more-toggle'); moreToggle.type = 'button'; moreToggle.textContent = uiText('更多操作', 'More actions'); actionIcon(moreToggle, 'more', moreToggle.textContent); primary.append(moreToggle)
  const closeMain = control(element('button'), 'close-main'); closeMain.type = 'button'; closeMain.textContent = uiText('关闭', 'Close'); actionIcon(closeMain, 'close', closeMain.textContent); closeMain.addEventListener('click', () => remove()); primary.append(closeMain)
  const bindPopovers = (root: HTMLElement, select: JdxSelect) => {
    const more = root.querySelector<HTMLButtonElement>('[data-pdf-control="more-toggle"]')!
    const search = root.querySelector<HTMLButtonElement>('[data-pdf-control="search-toggle"]')!
    const statusChip = root.querySelector<HTMLButtonElement>('[data-pdf-control="status-toggle"]')!
    const menu = root.querySelector<HTMLElement>('.jdx-pdf-translation-popover:not(.jdx-pdf-translation-search):not(.jdx-pdf-translation-status-panel)')!
    const searchBox = root.querySelector<HTMLElement>('.jdx-pdf-translation-search')!
    const statusPanel = root.querySelector<HTMLElement>('.jdx-pdf-translation-status-panel')!
    const menuBinding = bindReaderControlPopover(more, menu, root, () => select.close()), searchBinding = bindReaderControlPopover(search, searchBox, root), statusBinding = bindReaderControlPopover(statusChip, statusPanel, root)
    statusPopoverClosers.push(statusBinding.close)
    const dismiss = (event: Event) => { if ((event.target as HTMLElement).closest('button[data-pdf-control]')) menuBinding.close() }
    const moreClick = () => { searchBinding.close(); statusBinding.close() }, searchClick = () => { menuBinding.close(); statusBinding.close() }, statusClick = () => { menuBinding.close(); searchBinding.close() }
    more.addEventListener('click', moreClick); search.addEventListener('click', searchClick); statusChip.addEventListener('click', statusClick)
    menu.addEventListener('click', dismiss)
    return () => { menuBinding.remove(); searchBinding.remove(); statusBinding.remove(); statusPopoverClosers = statusPopoverClosers.filter(close => close !== statusBinding.close); menu.removeEventListener('click', dismiss); more.removeEventListener('click', moreClick); search.removeEventListener('click', searchClick); statusChip.removeEventListener('click', statusClick) }
  }
  const stopTheme = observeTheme(host, panel)
  // 原控件始终留在来源文档，独立窗口使用副本，避免 Gecko 关闭窗口时销毁被跨文档移动的节点。
  const syncDetached = () => {
    if (!detachedPanel || detached?.closed) return
    for (const source of Array.from(panel.querySelectorAll<HTMLElement>('[data-pdf-control]'))) {
      const id = source.dataset.pdfControl!
      const copy = detachedPanel.querySelector<HTMLElement>(`[data-pdf-control="${id}"]`)
      if (!copy || id === 'scope' || id === 'status-toggle') continue
      copy.hidden = id === 'exit' || id === 'multi-screen' ? false : source.hidden || id === 'close-main' || id === 'view'
      if (source.localName === 'button' || source.localName === 'span') copy.textContent = source.textContent
      for (const name of ['disabled', 'aria-pressed', 'aria-label', 'title', 'min', 'max']) {
        const value = source.getAttribute(name)
        if (value === null) copy.removeAttribute(name); else copy.setAttribute(name, value)
      }
      if (source.localName === 'input') (copy as HTMLInputElement).value = (source as HTMLInputElement).value
    }
    // 状态徽章含 LED/chevron 子元素，不能用 textContent 压平；展开态由独立窗口本地弹层自管，不回写。
    const chipCopy = detachedPanel.querySelector<HTMLElement>('[data-pdf-control="status-toggle"]')!
    chipCopy.hidden = statusToggle.hidden
    if (statusToggle.dataset.state) chipCopy.dataset.state = statusToggle.dataset.state; else delete chipCopy.dataset.state
    chipCopy.classList.toggle('is-working', statusToggle.classList.contains('is-working'))
    const chipLabel = chipCopy.querySelector<HTMLElement>('.jdx-pdf-status-label'); if (chipLabel) chipLabel.textContent = statusLabel.textContent
    const chipLabelText = statusToggle.getAttribute('aria-label'); if (chipLabelText) chipCopy.setAttribute('aria-label', chipLabelText)
    const detachedReturn = detachedPanel.querySelector<HTMLButtonElement>('[data-pdf-control="multi-screen"]')
    if (detachedReturn) { detachedReturn.setAttribute('aria-label', detachedReturn.textContent || ''); detachedReturn.title = detachedReturn.textContent || '' }
    detachedScope?.setValue(scope.getValue()); detachedScope?.setDisabled(task?.status === 'queued' || task?.status === 'running')
    const statusContentCopy = detachedPanel.querySelector<HTMLElement>('.jdx-pdf-status-content')!
    const detailsOpen = statusContentCopy.querySelector('details')?.open
    statusContentCopy.replaceChildren(...Array.from(statusContent.childNodes, node => node.cloneNode(true)))
    const copiedDetails = statusContentCopy.querySelector('details'); if (copiedDetails && detailsOpen) copiedDetails.open = true
  }
  const disposeView = () => {
    stopFrameIntent?.(); stopFrameIntent = undefined
    try { void api?.destroy().catch(() => {}) } catch { /* 宿主关闭时，内容 compartment 可能已自动释放。 */ }
    api = undefined
  }
  const reloadView = (nextFrame: HTMLIFrameElement) => {
    try { restoredAnchor = api?.state() ?? lastReadingState ?? nativeState() } catch { restoredAnchor = lastReadingState ?? nativeState() }
    renderEpoch++; disposeView(); loadedID = loadingID = ''
    frame = nextFrame; frame.hidden = true; frame.removeAttribute('srcdoc')
    applyMode(); syncDetached(); void render()
  }
  const restorePanel = () => {
    const closing = detached
    if (!closing) return
    closing.removeEventListener('unload', onDetachedClose)
    detachedObserver?.disconnect(); detachedObserver = undefined; detachedObserverCleanup?.(); detachedObserverCleanup = undefined; stopDetachedTheme?.(); stopDetachedTheme = undefined
    detachedPanel = undefined
    detached = undefined; currentMode = 'compare'; showingOriginal = false
    panel.style.display = ''
    if (!removed) reloadView(embeddedFrame)
    if (!closing.closed) closing.close()
  }
  const onDetachedClose = (event: Event) => {
    if (event.target === detached || event.target === detached?.document) restorePanel()
  }
  const detachPanel = async () => {
    if (openingWindow || removed) return
    const main = host.getMainWindow?.() as ZoteroManagerWindow | undefined
    if (!main?.openDialog) throw new Error(uiText('无法打开独立窗口。', 'Unable to open a separate window.'))
    openingWindow = true; windowError = ''; applyMode()
    let opened: Window | undefined
    try {
      opened = main.openDialog(chromeContentUrl('pdf-translation-window.xhtml'), '', 'chrome,dialog=no,titlebar,resizable,centerscreen,width=960,height=760') as Window | undefined
      pendingWindow = opened
      if (!opened) throw new Error(uiText('无法打开独立窗口。', 'Unable to open a separate window.'))
      const deadline = Date.now() + 10_000
      let body: HTMLElement | null | undefined
      while (!body && !opened.closed && !removed && Date.now() < deadline) {
        const browser = opened.document.getElementById('translation-host') as (Element & { contentDocument?: Document }) | null
        // 无 src 的 content browser 保留初始空文档；等待原生壳载入完成后再挂载，不导航替换它。
        body = opened.document.readyState === 'complete' ? browser?.contentDocument?.body : undefined
        if (!body) await new Promise(resolve => win.setTimeout(resolve, 30))
      }
      if (removed || opened.closed) { if (!opened.closed) opened.close(); return }
      if (!body) throw new Error(uiText('独立阅读器未就绪，请重试。', 'Separate reader is not ready. Try again.'))
      opened.document.title = uiText('PDF 译文', 'Translated PDF')
      detached = opened; currentMode = 'compare'; showingOriginal = false
      opened.addEventListener('unload', onDetachedClose)
       detachedPanel = body.ownerDocument.importNode(panel, true)
       const detachedPrimary = detachedPanel.querySelector<HTMLElement>('.jdx-pdf-translation-primary')!
       detachedPanel.querySelector<HTMLElement>('[data-pdf-control="view"]')!.hidden = true
       const detachedReturn = detachedPanel.querySelector<HTMLButtonElement>('[data-pdf-control="multi-screen"]')!
       detachedPrimary.insertBefore(detachedReturn, detachedPrimary.firstChild)
       actionIcon(detachedReturn, 'back', uiText('返回对照阅读', 'Return to comparison'))
       detachedReturn.classList.add('jdx-pdf-return')
      const detachedFrame = detachedPanel.querySelector('iframe')!
      detachedFrame.removeAttribute('srcdoc'); detachedFrame.hidden = true
       const controls = new Map(Array.from(panel.querySelectorAll<HTMLElement>('[data-pdf-control]')).map(node => [node.dataset.pdfControl!, node]))
       const cloneControlOptions = <T,>(value: T) => (globalThis as unknown as { Components: { utils: { cloneInto<T>(value: T, target: Window): T } } }).Components.utils.cloneInto(value, win)
       detachedPanel.querySelectorAll<HTMLElement>('[data-pdf-control]').forEach(copy => {
         const id = copy.dataset.pdfControl!, source = controls.get(id)
         if (!source || id === 'scope' || id === 'more-toggle' || id === 'search-toggle' || id === 'close-main' || id === 'status-toggle') return
         if (copy.localName === 'button') copy.addEventListener('click', () => source.click())
         else if (copy.localName === 'input') for (const name of ['input', 'change', 'keydown']) copy.addEventListener(name, event => {
           (source as HTMLInputElement).value = (copy as HTMLInputElement).value
           source.dispatchEvent(name === 'keydown' ? new win.KeyboardEvent(name, cloneControlOptions({ key: (event as KeyboardEvent).key })) : new win.Event(name))
         })
       })
       const detachedScopeHost = detachedPanel.querySelector<HTMLElement>('[data-pdf-control="scope"]')!
       detachedScopeHost.replaceChildren()
       detachedScope = createJdxSelect(detachedScopeHost, { ariaLabel: uiText('翻译范围', 'Translation scope') })
       detachedScope.setOptions(scopeOptions, scope.getValue())
       detachedScope.onChange(value => { scope.setValue(value); translationMode = value as PDFTranslationMode })
       const unbindDetachedPopovers = bindPopovers(detachedPanel, detachedScope)
       const copiedBudget = detachedPanel.querySelector<HTMLElement>('[data-reading-budgets]')!
       const budgetParent = copiedBudget.parentElement!
       copiedBudget.remove()
       const stopDetachedBudget = wireReadingBudgetSettings(host, budgetParent, ['pdf'])
       body.append(detachedPanel); stopDetachedTheme = observeTheme(host, detachedPanel)
       detachedObserverCleanup = () => { stopDetachedBudget(); unbindDetachedPopovers(); detachedScope?.destroy(); detachedScope = undefined }
      detachedObserver = new win.MutationObserver(syncDetached)
      const observerOptions = cloneControlOptions({ subtree: true, attributes: true, childList: true, characterData: true })
       detachedObserver.observe(panel, observerOptions)
      panel.style.display = 'none'; reloadView(detachedFrame); opened.focus()
    } catch (value) { windowError = value instanceof Error ? value.message : String(value); if (opened && !opened.closed) opened.close(); throw value }
    finally { pendingWindow = undefined; openingWindow = false; if (!removed) applyMode() }
  }
  const render = async () => {
    if (removed) return
    const detailsOpen = statusContent.querySelector('details')?.open
    const busyTask = task && (task.status === 'queued' || task.status === 'running') ? task : undefined
    const view = pdfTranslationStatusView({ task, windowError, notice, hasOutput: task ? jobs.hasOutput(task) : false, speed: busyTask ? jobs.speed(busyTask.id) : undefined })
    notice = undefined
    statusToggle.hidden = !view.visible
    statusToggle.dataset.state = view.led
    statusToggle.classList.toggle('is-working', view.working)
    statusLabel.textContent = view.label
    statusToggle.setAttribute('aria-label', view.label ? uiText(`翻译状态：${view.label}`, `Translation status: ${view.label}`) : uiText('翻译状态', 'Translation status'))
    if (!view.visible) for (const close of statusPopoverClosers) close()
    const statusMeter = view.progress ? element('progress') : undefined
    if (statusMeter) {
      statusMeter.setAttribute('aria-label', uiText('翻译进度', 'Translation progress'))
      if (view.progress && view.progress !== 'indeterminate') { statusMeter.max = view.progress.max; statusMeter.value = view.progress.value }
    }
    const statusBody = element('div'); statusBody.textContent = view.lines.join('\n')
    statusContent.replaceChildren(...(statusMeter ? [statusMeter] : []), statusBody)
    if (view.details) {
      const details = element('details'), summary = element('summary'), detailBody = element('div')
      details.open = Boolean(detailsOpen); summary.textContent = uiText('详细信息', 'Details'); detailBody.textContent = view.details; details.append(summary, detailBody); statusContent.append(details)
    }
    if (!task) return
    const busy = task.status === 'queued' || task.status === 'running'
    const hasOutput = jobs.hasOutput(task), resumeNeeded = !busy && task.status !== 'complete'
    scope.setDisabled(busy); regenerate.disabled = busy; repair.hidden = hasOutput; cancel.hidden = !busy; retry.hidden = !resumeNeeded || hasOutput; retry.disabled = jobs.isActive(task.id); mono.disabled = dual.disabled = !hasOutput
    retry.textContent = uiText('重试', 'Retry')
    if (task.stage === 'finishing' && busy) cancel.disabled = true; else cancel.disabled = false
    taskAction.hidden = !busy && !resumeNeeded && mono.disabled
    taskAction.textContent = busy ? uiText('取消', 'Cancel') : resumeNeeded ? hasOutput ? uiText('补译', 'Resume') : uiText('重试', 'Retry') : uiText('保存译文', 'Save PDF')
    taskAction.title = busy ? uiText('取消翻译', 'Cancel translation') : resumeNeeded ? hasOutput ? uiText('补译未完成部分', 'Translate remaining passages') : retry.textContent || '' : uiText('保存译文', 'Save PDF')
    taskAction.setAttribute('aria-label', taskAction.title)
    taskAction.disabled = busy ? cancel.disabled : resumeNeeded ? retry.disabled : mono.disabled
    alignHeader()
    const artifactID = `${task.id}:${task.artifact?.revision ?? 'legacy'}`
    // 零翻译的渐进 PDF 只是原文快照，不能让“仅显示译文”变成同一份原文。
    if (!jobs.hasOutput(task) || (task.artifact?.coverage ?? task.coverage)?.translated === 0 || loadedID === artifactID || Boolean(loadingID)) return
    if (api) restoredAnchor = api.state()
    const renderingTask = { ...task }, previousAPI = api, epoch = ++renderEpoch
    const current = () => !removed && epoch === renderEpoch && task?.id === renderingTask.id
    loadingID = artifactID
    try {
      const bytes = await jobs.bytes(renderingTask.id, renderingTask.artifact)
      if (!current()) return
      const hostWindow = host.getMainWindow?.()
      if (!hostWindow) throw new Error('Zotero window unavailable')
      // 只插入插件打包的固定 HTML；srcdoc 继承 Reader 内容权限，不能读凭据或本地文件。
      if (!api) {
      const template = await hostWindow.fetch('chrome://jadense-in-zotero/content/pdf-translation/viewer.html')
      const html = await template.text()
      if (!current()) return
      // srcdoc 导航异步发生；补译刷新时不能拿到即将销毁的旧文档 API。
      const previousDocument = frame.contentDocument
      frame.srcdoc = html
      api = await new Promise<PDFView>((resolve, reject) => {
        const deadline = Date.now() + 15_000
        const poll = () => {
          const window = frame.contentWindow as Window & { wrappedJSObject?: Window; JadensePDFView?: WireView }
          const value = (window?.wrappedJSObject as Window & { JadensePDFView?: WireView } | undefined)?.JadensePDFView ?? window?.JadensePDFView
          if (!current()) reject(new Error('Reader changed'))
          else if (value && frame.contentDocument !== previousDocument) {
            stopFrameIntent = trackIntent(frame.contentWindow!, 'translation')
            // bootstrap 属于特权 compartment；内容 iframe 只能读取显式克隆的数据和导出回调。
            const utils = (globalThis as unknown as { Components: { utils: { cloneInto<T>(data: T, target: Window): T; exportFunction<T extends (...args: never[]) => unknown>(callback: T, target: Window): T } } }).Components.utils
            const clone = <T,>(data: T) => utils.cloneInto(data, window)
            resolve({
              open(data, notify, source) { return value.open(clone(data), utils.exportFunction((state: string) => { lastReadingState = normalizedPDFState(JSON.parse(state)); notify(lastReadingState); syncDetached() }, window), source) },
              state: () => lastReadingState = normalizedPDFState(JSON.parse(value.stateJSON())),
              set: state => { lastReadingState = normalizedPDFState(state); value.set(clone(state)); syncDetached() },
              find: (query, again) => value.find(query, again),
              destroy: () => value.destroy(),
            })
          }
          else if (Date.now() > deadline) reject(new Error('PDF viewer failed to load'))
          else win.setTimeout(poll, 50)
        }; poll()
      })
      }
      if (!current()) return
      frame.hidden = false
      const workerResponse = await hostWindow.fetch('chrome://jadense-pdf-reader/content/viewer-worker.js')
      const restoring = Boolean(restoredAnchor), anchor = previousAPI?.state() ?? restoredAnchor ?? nativeState()
      const pages = await api.open(bytes, state => { if (!current() || !loadedID || activeSide !== 'translation') return; if (linked || currentMode === 'inplace') setNative(state) }, await workerResponse.text())
      if (!current()) return
      if (pages !== renderingTask.pages) throw new Error('Translated PDF page count changed')
      const finalAnchor = previousAPI ? lastReadingState ?? anchor : anchor
      loadedID = artifactID; panel.dataset.pdfArtifactRevision = renderingTask.artifact?.revision ?? 'legacy'; restoredAnchor = undefined; api.set(finalAnchor); applyMode(); win.requestAnimationFrame(() => { if (current() && !restoring) fit() })
    } catch (value) { if (current()) { if (!previousAPI) { void api?.destroy(); api = undefined; frame.hidden = true } applyMode(); error(value); retry.hidden = false } } finally { if (current()) { loadingID = ''; if (`${task!.id}:${task!.artifact?.revision ?? 'legacy'}` !== artifactID) void render() } }
  }
  const unsubscribe = jobs.subscribe(() => { void render() })
  const speedTimer = win.setInterval(() => { if (task?.status === 'running' || task?.status === 'queued') void render() }, 1000)
  cleanups.push(() => win.clearInterval(speedTimer))
  let starting = false
  const start = async (fresh = false) => {
    if (starting) return
    starting = true; regenerate.disabled = true
    notice = { text: uiText('准备 PDF 翻译…', 'Preparing PDF translation…'), tone: 'info' }; void render()
    try {
      const next = fresh ? await jobs.start(reader.itemID, translationMode, true)
        : savedTaskID ? jobs.get(savedTaskID) : await jobs.openOrStart(reader.itemID, translationMode)
      if (!next || (savedTaskID && next.source.itemID !== reader.itemID)) throw new Error(uiText('翻译记录不可用。', 'Translation record unavailable.'))
      if (removed) return
      if (task && task.id !== next.id) { renderEpoch++; void api?.destroy(); api = undefined; loadedID = loadingID = ''; frame.hidden = true }
      task = next; translationMode = task.mode ?? 'full'; scope.setValue(translationMode); panel.dataset.pdfTaskId = next.id; applyMode(); await render()
    } catch (value) { error(value); retry.hidden = false }
    finally { starting = false; if (!removed) regenerate.disabled = Boolean(task && jobs.isActive(task.id)) }
  }
  const remove = () => {
    if (removed) return
    removed = true; views.delete(reader); unsubscribe(); stopTheme(); preparation.abort()
    restorePanel()
    if (pendingWindow && !pendingWindow.closed) pendingWindow.close()
    for (const cleanup of cleanups) cleanup()
    for (const name of ['updateviewarea', 'scalechanging', 'rotationchanging']) native.eventBus.off(name, fromNative)
    win.removeEventListener('pagehide', remove)
    headerObserver.disconnect(); win.cancelAnimationFrame(fitFrame); disposeView(); panel.remove(); original.style.width = previousWidth; original.style.visibility = previousVisibility; original.style.top = previousTop; original.style.height = previousHeight; original.style.position = previousFramePosition; parent.style.position = previousPosition
  }
  frame.title = uiText('PDF 译文', 'Translated PDF'); frame.hidden = true
  panel.append(style, toolbar, overflow, searchPanel, status, frame); parent.append(panel)
  cleanups.push(bindPopovers(panel, scope), () => scope.destroy())
  let fitFrame = 0, lastWidth = 0
  const resized = () => {
    alignHeader()
    const width = original.getBoundingClientRect().width
    if (!width || width === lastWidth) return
    lastWidth = width; win.cancelAnimationFrame(fitFrame)
    fitFrame = win.requestAnimationFrame(() => { if (!removed) fit() })
  }
  const headerObserver = new win.ResizeObserver(resized); headerObserver.observe(toolbar); headerObserver.observe(parent); headerObserver.observe(original)
  for (const name of ['updateviewarea', 'scalechanging', 'rotationchanging']) native.eventBus.on(name, fromNative)
  win.addEventListener('pagehide', remove, { once: true })
  views.set(reader, { taskID: () => task?.id, show(next) { if (detached) { detached.focus(); return }; currentMode = next; showingOriginal = false; applyMode() }, remove })
  cleanups.push(registerReadingMode(reader, 'pdf', remove))
  mono.disabled = dual.disabled = true; applyMode(); await start()
}

export function stopPDFTranslationReaders() { for (const value of [...views.values()]) value.remove() }
