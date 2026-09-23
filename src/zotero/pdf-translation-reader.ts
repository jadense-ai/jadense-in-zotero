import { readPDFTranslationMode, pdfModeLabel, pdfCoverageText, type PDFTranslationMode } from './pdf-translation-policy'
/** 原生 PDF 旁的译文视图；保持原 Reader 实例，退出恢复宿主布局与批注交互。 */
import type { ZoteroLike } from './runtime'
import { pdfTranslationJobs, type PDFTranslationTask } from './pdf-translation-jobs'
import { uiText } from './ui-preferences'
import { translationSpeedText } from './translation-speed-settings'
import { observeTheme } from './ui-preferences'
import { READER_UI_THEME_CSS } from './reader-ui-theme'
import { chromeContentUrl } from './chrome-registration'
import type { ZoteroManagerWindow } from './manager-window'
import { copyTextToClipboard } from './connection-display'

export type PDFReadingState = { page: number; fraction: number; scale: number; rotation: number }
type NativePDF = { pagesCount: number; currentPageNumber: number; currentScale: number; pagesRotation: number; container: HTMLElement; getPageView(index: number): { div: HTMLElement }; eventBus: { on(name: string, callback: () => void): void; off(name: string, callback: () => void): void } }
type Reader = { itemID: number; _initPromise?: Promise<unknown>; _internalReader?: { _primaryView?: { initializedPromise?: Promise<unknown>; _iframeWindow?: Window & { PDFViewerApplication?: { pdfViewer?: NativePDF } } } } }
type PDFView = { open(bytes: Uint8Array, notify: (state: PDFReadingState) => void, workerSource: string): Promise<number>; state(): PDFReadingState; set(state: PDFReadingState): void; find(query: string, again?: boolean): void; destroy(): Promise<void> }
type WireView = Omit<PDFView, 'open'> & { open(bytes: Uint8Array, notify: (state: string) => void, workerSource: string): Promise<number>; stateJSON(): string }
const views = new Map<Reader, { taskID(): string | undefined; show(mode: 'compare' | 'inplace'): void; remove(): void }>()

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
  const existing = views.get(reader)
  if (existing && (!savedTaskID || existing.taskID() === savedTaskID)) { existing.show(mode); return }
  existing?.remove()
  const nativeWindow = reader._internalReader?._primaryView?._iframeWindow
  const native = nativeWindow?.PDFViewerApplication?.pdfViewer
  const original = nativeWindow?.frameElement as HTMLElement | null, parent = original?.parentElement
  if (!native || !original || !parent) throw new Error(uiText('PDF 阅读器尚未就绪，请稍后重试。', 'PDF reader is not ready. Try again.'))
  const doc = parent.ownerDocument, win = doc.defaultView!, jobs = pdfTranslationJobs(host)
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
  const panel = element('section'), toolbar = element('div'), status = element('div'), embeddedFrame = element('iframe'), style = element('style')
  let frame = embeddedFrame
  panel.className = 'jdx-pdf-translation'; toolbar.className = 'jdx-pdf-translation-toolbar'; status.className = 'jdx-pdf-translation-status'
  panel.setAttribute('data-jadense-reader-theme', '')
  panel.setAttribute('aria-label', uiText('PDF 译文', 'Translated PDF')); status.setAttribute('role', 'status')
  style.textContent = `${READER_UI_THEME_CSS}
.jdx-pdf-translation{position:absolute;inset:0;z-index:3;pointer-events:none;color:var(--jdx-reader-text,#222);display:flex;align-items:flex-end;flex-direction:column;font:13px system-ui;min-width:0}
.jdx-pdf-translation-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 12px;border-bottom:1px solid var(--jdx-reader-line);flex:none;box-sizing:border-box;width:100%;background:var(--jdx-reader-background,#fff);pointer-events:auto}
.jdx-pdf-translation-group{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}
.jdx-pdf-translation-actions{margin-left:auto}
.jdx-pdf-translation button,.jdx-pdf-translation input,.jdx-pdf-translation select{box-sizing:border-box;font:inherit;color:inherit;border:1px solid transparent;border-radius:6px;min-height:30px}
.jdx-pdf-translation button{padding:4px 9px;background:transparent;cursor:pointer;white-space:nowrap}
.jdx-pdf-translation button:hover{background:var(--jdx-reader-hover)}
.jdx-pdf-translation button:disabled{opacity:.45;cursor:default}
.jdx-pdf-translation button:focus-visible,.jdx-pdf-translation input:focus-visible,.jdx-pdf-translation select:focus-visible{outline:2px solid #16d78f;outline-offset:1px}
.jdx-pdf-translation input{padding:4px 8px;width:58px;background:var(--jdx-reader-surface);border-color:var(--jdx-reader-line)}
.jdx-pdf-translation select{padding:4px 8px;background:var(--jdx-reader-surface);border-color:var(--jdx-reader-line);max-width:100%}
.jdx-pdf-translation input[type=search]{width:150px;max-width:100%}
.jdx-pdf-translation button[aria-pressed=true]{background:var(--jdx-reader-surface);border-color:#16d78f;color:var(--jdx-reader-text)}
.jdx-pdf-translation .jdx-pdf-save{background:var(--jdx-reader-surface);border-color:var(--jdx-reader-line)}
.jdx-pdf-translation-page-count{color:var(--jdx-reader-muted);padding:0 6px;font-variant-numeric:tabular-nums}
.jdx-pdf-translation iframe{width:50%;flex:1;min-height:0;border:0;border-left:1px solid var(--jdx-reader-line);box-sizing:border-box;pointer-events:auto}
.jdx-pdf-translation-status{box-sizing:border-box;width:100%;flex:none;user-select:text;background:var(--jdx-reader-background,#fff);color:var(--jdx-reader-muted);pointer-events:auto;padding:8px 12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:25%;overflow:auto;border-bottom:1px solid var(--jdx-reader-line)}
.jdx-pdf-translation-status.jdx-pdf-status-expanded{max-height:60%}
.jdx-pdf-translation-status.is-working::before{content:"";display:inline-block;width:12px;height:12px;margin-inline-end:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:-2px;animation:jdx-pdf-working 1s linear infinite}
.jdx-pdf-translation-status progress{display:block;width:100%;height:5px;margin:8px 0;accent-color:#16d78f}
.jdx-pdf-translation-status details{font-size:12px;margin-top:6px}
.jdx-pdf-translation-status summary{cursor:pointer}
@keyframes jdx-pdf-working{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.jdx-pdf-translation-status.is-working::before{animation:none}}
.jdx-pdf-translation [hidden]{display:none!important}`
  const previousWidth = original.style.width, previousVisibility = original.style.visibility, previousPosition = parent.style.position, previousTop = original.style.top, previousHeight = original.style.height, previousFramePosition = original.style.position
  if (win.getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
  original.style.position = 'absolute'
  let currentMode = mode, showingOriginal = false, removed = false, task: PDFTranslationTask | undefined, api: PDFView | undefined, loadedID = '', loadingID = '', renderEpoch = 0
  let detached: Window | undefined, detachedPanel: HTMLElement | undefined, openingWindow = false, restoredAnchor: PDFReadingState | undefined, lastReadingState: PDFReadingState | undefined
  let stopDetachedTheme: (() => void) | undefined, detachedObserver: MutationObserver | undefined
  let stopFrameIntent: (() => void) | undefined
  let windowError = ''
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
  const group = (label: string, actions = false) => { const node = element('div'); node.className = `jdx-pdf-translation-group${actions ? ' jdx-pdf-translation-actions' : ''}`; node.setAttribute('role', 'group'); node.setAttribute('aria-label', label); toolbar.append(node); return node }
  const navigation = group(uiText('阅读控制', 'Reading controls')), searchGroup = group(uiText('译文搜索', 'Translation search')), actions = group(uiText('文件操作', 'File actions'), true)
  let buttonGroup = navigation
  const button = (label: string, callback: () => void) => { const node = element('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', callback); buttonGroup.append(node); return node }
  const error = (value: unknown) => { if (!removed) { status.hidden = false; status.textContent = value instanceof Error ? value.message : String(value) } }
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
    if (linked || currentMode === 'inplace') { const state = nativeState(); pageInput.value = String(state.page); api.set(state) }
  }
  const alignHeader = () => { const height = detached ? 0 : toolbar.offsetHeight + (status.hidden ? 0 : status.offsetHeight); original.style.top = detached ? previousTop : `${height}px`; original.style.height = detached ? previousHeight : `calc(100% - ${height}px)` }
  const fit = () => {
    const current = nativeState(), width = native.getPageView(current.page - 1)?.div.clientWidth
    if (!width) return
    const state = { ...current, scale: Math.max(.1, current.scale * ((detached ? frame.clientWidth : native.container.clientWidth) - 24) / width) }
    setNative(state); api?.set(state)
  }
  const applyMode = (anchor = api && !showingOriginal ? api.state() : nativeState()) => {
    original.style.width = !detached && currentMode === 'compare' && api ? '50%' : previousWidth
    original.style.visibility = !detached && currentMode === 'inplace' && !showingOriginal && api ? 'hidden' : previousVisibility
    frame.style.width = !detached && currentMode === 'compare' ? '50%' : '100%'
    frame.hidden = showingOriginal || !api
    link.hidden = currentMode !== 'compare'; link.disabled = !api
    toggle.hidden = currentMode !== 'inplace' || !api
    toggle.textContent = showingOriginal ? uiText('返回译文', 'Show translation') : uiText('查看原文', 'Show original')
    translationOnly.setAttribute('aria-pressed', String(currentMode === 'inplace'))
    translationOnly.disabled = !api || Boolean(detached)
    multiScreen.setAttribute('aria-pressed', String(Boolean(detached)))
    multiScreen.disabled = !api || openingWindow
    multiScreen.textContent = detached ? uiText('返回对照阅读', 'Return to comparison') : uiText('多屏模式', 'Multi-screen')
    alignHeader(); setNative(anchor); api?.set(anchor)
  }
  const translationOnly = button(uiText('仅显示译文', 'Translation only'), () => {
    const anchor = showingOriginal ? nativeState() : api!.state()
    currentMode = currentMode === 'inplace' ? 'compare' : 'inplace'; showingOriginal = false; applyMode(anchor)
  })
  translationOnly.title = uiText('切换为整页译文，再次点击恢复对照阅读。', 'Show the translation full-width; click again to restore comparison.')
  const multiScreen = button(uiText('多屏模式', 'Multi-screen'), () => { if (detached) restorePanel(); else void detachPanel().catch(error) })
  multiScreen.title = uiText('在独立窗口阅读译文，可拖到另一块屏幕。', 'Read the translated PDF in a separate window that can be moved to another screen.')
  const toggle = button(uiText('查看原文', 'Show original'), () => { const anchor = showingOriginal ? nativeState() : api!.state(); showingOriginal = !showingOriginal; applyMode(anchor) })
  const link = button(uiText('同步滚动', 'Sync scroll'), () => {
    linked = !linked; link.setAttribute('aria-pressed', String(linked))
    host.Prefs?.set('extensions.jadenseInZotero.pdfLinkedScroll', linked, true)
    if (linked && api) { if (activeSide === 'translation') setNative(api.state()); else api.set(nativeState()) }
  })
  link.setAttribute('aria-pressed', String(linked)); link.title = uiText('开启后，两侧按页码和页内高度同步；关闭后可独立阅读。', 'Link page and relative vertical position, or scroll each PDF independently.')
  const pageInput = element('input'); pageInput.type = 'number'; pageInput.min = '1'; pageInput.setAttribute('aria-label', uiText('译文页码', 'Translation page')); navigation.append(pageInput)
  const pageCount = element('span'); pageCount.className = 'jdx-pdf-translation-page-count'; pageCount.textContent = '/ —'; navigation.append(pageCount)
  pageInput.addEventListener('change', () => { if (api) { const next = { ...api.state(), page: Math.min(task?.pages || 1, Math.max(1, Number(pageInput.value) || 1)), fraction: 0 }; api.set(next); setNative(next) } })
  const zoomOut = button('−', () => { if (api) { const next = { ...api.state(), scale: Math.max(.1, api.state().scale / 1.2) }; api.set(next); setNative(next) } })
  zoomOut.setAttribute('aria-label', uiText('缩小', 'Zoom out')); zoomOut.title = zoomOut.getAttribute('aria-label')!
  const zoomIn = button('+', () => { if (api) { const next = { ...api.state(), scale: Math.min(10, api.state().scale * 1.2) }; api.set(next); setNative(next) } })
  zoomIn.setAttribute('aria-label', uiText('放大', 'Zoom in')); zoomIn.title = zoomIn.getAttribute('aria-label')!
  button(uiText('适宽', 'Fit width'), fit)
  button(uiText('旋转', 'Rotate'), () => { if (api) { const next = { ...api.state(), rotation: (api.state().rotation + 90) % 360 }; api.set(next); setNative(next) } })
  const find = element('input'); find.type = 'search'; find.placeholder = uiText('搜索译文', 'Find'); find.setAttribute('aria-label', find.placeholder); searchGroup.append(find)
  find.addEventListener('input', () => { activeSide = 'translation'; api?.find(find.value) }); find.addEventListener('keydown', event => { if (event.key === 'Enter') api?.find(find.value, true) })
  buttonGroup = actions
  const mono = button(uiText('保存译文', 'Save PDF'), () => { if (task) void jobs.export(task.id, 'mono', win).catch(error) })
  const dual = button(uiText('保存对照', 'Save bilingual'), () => { if (task) void jobs.export(task.id, 'dual', win).catch(error) })
  mono.className = dual.className = 'jdx-pdf-save'
  let translationMode: PDFTranslationMode = savedTaskID ? jobs.get(savedTaskID)?.mode ?? 'full' : readPDFTranslationMode(host)
  const scope = element('select'); scope.setAttribute('aria-label', uiText('翻译范围', 'Translation scope'))
  for (const value of ['concise', 'full'] as const) { const option = element('option'); option.value = value; option.textContent = pdfModeLabel(value); scope.append(option) }
  scope.value = translationMode; actions.append(scope)
  scope.addEventListener('change', () => { translationMode = scope.value as PDFTranslationMode; savedTaskID = undefined; void start() })
  const retry = button(uiText('重试', 'Retry'), () => { if (task?.status === 'complete') void render(); else if (task) jobs.retry(task.id); else void start() })
  const cancel = button(uiText('取消', 'Cancel'), () => { if (task) jobs.cancel(task.id); preparation.abort() })
  const expandStatus = button(uiText('展开提示', 'Expand details'), () => {
    const expanded = status.classList.toggle('jdx-pdf-status-expanded')
    expandStatus.textContent = expanded ? uiText('收起提示', 'Collapse details') : uiText('展开提示', 'Expand details')
    expandStatus.setAttribute('aria-pressed', String(expanded))
  })
  expandStatus.setAttribute('aria-pressed', 'false')
  const copyStatus = button(uiText('复制提示', 'Copy details'), () => {
    void copyTextToClipboard(host, status.textContent ?? '').then(copied => {
      copyStatus.textContent = copied ? uiText('已复制提示', 'Details copied') : uiText('复制失败，请选择提示文字复制', 'Copy failed; select the details to copy')
    })
  })
  const repair = button(uiText('修复引擎', 'Repair engine'), () => {
    if (task?.status === 'running' || task?.status === 'queued') { status.textContent = uiText('请先取消当前任务，再修复引擎。', 'Cancel the current task before repairing the engine.'); return }
    preparation = new AbortController()
    void jobs.prepare(preparation.signal, stage => { status.textContent = stage === 'assets' ? uiText('准备模型和字体…', 'Preparing models and fonts…') : uiText('安装引擎…', 'Installing engine…') }, true).then(() => { status.textContent = uiText('引擎已准备，请点击重试。', 'Engine ready. Click Retry.') }).catch(error)
  })
  button(uiText('关闭', 'Close'), () => remove())
  const stopTheme = observeTheme(host, panel)
  // 原控件始终留在来源文档，独立窗口使用副本，避免 Gecko 关闭窗口时销毁被跨文档移动的节点。
  const syncDetached = () => {
    if (!detachedPanel || detached?.closed) return
    const source = Array.from(toolbar.querySelectorAll('button,input,select,span')), target = Array.from(detachedPanel.querySelectorAll('.jdx-pdf-translation-toolbar button,.jdx-pdf-translation-toolbar input,.jdx-pdf-translation-toolbar span,.jdx-pdf-translation-toolbar select'))
    source.forEach((node, index) => {
      const copy = target[index] as HTMLInputElement | HTMLButtonElement
      copy.hidden = (node as HTMLElement).hidden
      if (node.localName !== 'select') copy.textContent = node.textContent
      for (const name of ['disabled', 'aria-pressed', 'min', 'max']) {
        const value = node.getAttribute(name)
        if (value === null) copy.removeAttribute(name); else copy.setAttribute(name, value)
      }
      if (node.localName === 'input' || node.localName === 'select') (copy as HTMLInputElement).value = (node as HTMLInputElement).value
    })
    const copyStatus = detachedPanel.querySelector<HTMLElement>('.jdx-pdf-translation-status')!
    const detailsOpen = copyStatus.querySelector('details')?.open
    copyStatus.replaceChildren(...Array.from(status.childNodes, node => node.cloneNode(true))); copyStatus.hidden = status.hidden; copyStatus.className = status.className
    const copiedDetails = copyStatus.querySelector('details'); if (copiedDetails && detailsOpen) copiedDetails.open = true
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
    detachedObserver?.disconnect(); detachedObserver = undefined; stopDetachedTheme?.(); stopDetachedTheme = undefined
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
      const detachedFrame = detachedPanel.querySelector('iframe')!
      detachedFrame.removeAttribute('srcdoc'); detachedFrame.hidden = true
      const controls = Array.from(toolbar.querySelectorAll('button,input,select'))
      const cloneControlOptions = <T,>(value: T) => (globalThis as unknown as { Components: { utils: { cloneInto<T>(value: T, target: Window): T } } }).Components.utils.cloneInto(value, win)
      detachedPanel.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input,select').forEach((copy, index) => {
        const source = controls[index] as HTMLButtonElement | HTMLInputElement
        if (copy.localName === 'button') copy.addEventListener('click', () => source.click())
        else for (const name of ['input', 'change', 'keydown']) copy.addEventListener(name, event => {
          source.value = copy.value
          source.dispatchEvent(name === 'keydown' ? new win.KeyboardEvent(name, cloneControlOptions({ key: (event as KeyboardEvent).key })) : new win.Event(name))
        })
      })
      body.append(detachedPanel); stopDetachedTheme = observeTheme(host, detachedPanel)
      detachedObserver = new win.MutationObserver(syncDetached)
      const observerOptions = cloneControlOptions({ subtree: true, attributes: true, childList: true, characterData: true })
      detachedObserver.observe(toolbar, observerOptions)
      detachedObserver.observe(status, observerOptions)
      panel.style.display = 'none'; reloadView(detachedFrame); opened.focus()
    } catch (value) { windowError = value instanceof Error ? value.message : String(value); if (opened && !opened.closed) opened.close(); throw value }
    finally { pendingWindow = undefined; openingWindow = false; if (!removed) applyMode() }
  }
  const render = async () => {
    const detailsOpen = status.querySelector('details')?.open
    if (!task || removed) return
    const busy = task.status === 'queued' || task.status === 'running'
    scope.disabled = busy; scope.value = task.mode ?? translationMode; repair.hidden = jobs.hasOutput(task); cancel.hidden = !busy; retry.hidden = busy || task.status === 'complete'; retry.disabled = jobs.isActive(task.id); mono.disabled = dual.disabled = !jobs.hasOutput(task)
    retry.textContent = jobs.hasOutput(task) && task.status !== 'complete' ? uiText('补译未完成部分', 'Translate remaining passages') : uiText('重试', 'Retry')
    const stages: Record<string, string> = { parse_missing: uiText('建立 PDF 版面缓存', 'Building PDF layout cache'), parse_invalid: uiText('版面缓存不可用，重新解析 PDF', 'Layout cache unavailable; parsing PDF again'), preparing_pdf: uiText('检查 PDF 与版面缓存', 'Checking PDF and layout cache'), finishing: uiText('正在保存已完成译文', 'Saving completed translations'), layout_cached: uiText('已复用 PDF 版面', 'Reusing PDF layout'), queued: uiText('等待其他 PDF 任务', 'Waiting for another PDF task'), dependencies: uiText('安装 PDF 翻译引擎', 'Installing PDF translation engine'), assets: uiText('准备模型和字体', 'Preparing models and fonts'), download: uiText('下载完整引擎包', 'Downloading engine package'), retry: uiText('下载中断，正在续传重试', 'Retrying interrupted download'), verify: uiText('校验引擎包', 'Verifying engine package'), extract: uiText('解压引擎', 'Extracting engine'), check: uiText('离线检测引擎', 'Checking engine offline'), installed: uiText('引擎已安装', 'Engine installed'), parse: uiText('解析 PDF', 'Parsing PDF') }
    const stage = stages[task.stage] || (/translat/iu.test(task.stage) ? uiText('翻译正文', 'Translating text') : /typeset|render|save|generate|write/iu.test(task.stage) ? uiText('生成译文 PDF', 'Typesetting translated PDF') : uiText('解析 PDF 版面', 'Parsing PDF layout'))
    status.textContent = windowError || task.error || (jobs.hasOutput(task) ? task.skipped.length ? uiText(`以下页无可翻译文字，已保留原页：${task.skipped.map(i => i + 1).join('、')}`, `Pages without text were preserved: ${task.skipped.map(i => i + 1).join(', ')}`) : '' : `${stage} · ${Math.round(task.percent)}%`)
    status.classList.toggle('is-working', busy)
    if (busy) status.textContent = task.stage === 'translation_repair' ? uiText('正在补译未完成段落…', 'Filling in the remaining passages…') : `${stage}…`
    if (task.status === 'interrupted') status.textContent = uiText('上次任务已中断，点击重试将复用已完成片段。', 'Previous task interrupted. Retry to reuse completed segments.')
    if (task.status === 'interrupted' && task.legacy) status.textContent = uiText('这是旧版未完成任务。点击重试以新聚合策略重新开始；旧缓存仍保留。', 'Unfinished legacy task. Retry starts the new batching strategy; the old cache is retained.')
    if (task.status === 'running' || task.status === 'queued') {
      const speed = jobs.speed(task.id)
      if (task.total !== undefined) status.textContent += uiText(` · 已完成 ${task.completed ?? 0} / ${task.total} 段`, ` · ${task.completed ?? 0} / ${task.total} passages completed`)
      const retries = Object.values(task.retrying ?? {})
      const seconds = Math.ceil(Math.max(0, ...retries.map(row => row.until - Date.now()), speed?.queued ? speed.waitMs : 0) / 1000)
      if (retries.length) status.textContent += '\n' + (seconds > 0
        ? uiText(`服务暂时繁忙，${seconds} 秒后自动继续，无需重复点击。`, `The service is busy. Continuing automatically in ${seconds}s; no action needed.`)
        : uiText('正在自动恢复未完成内容，无需重复点击。', 'Automatically recovering unfinished work; no action needed.'))
      else if (seconds > 0) status.textContent += '\n' + uiText(`正在等待翻译服务，约 ${seconds} 秒后继续。`, `Waiting for the translation service; continuing in about ${seconds}s.`)
      if (jobs.hasOutput(task)) status.textContent += '\n' + uiText('已有译文已保存，可以先阅读。', 'Completed translations are saved and ready to read.')
    }
    if (task.stage === 'finishing' && busy) { status.textContent = uiText('正在保存已完成译文', 'Saving completed translations'); cancel.disabled = true } else cancel.disabled = false
    if (task.status === 'cancelled') status.textContent = (task.error ? task.error + '\n' : '') + uiText('已取消，点击重试可复用已完成片段。', 'Cancelled. Retry to reuse completed segments.')
    const coverageText = pdfCoverageText(task.artifact?.coverage ?? task.coverage)
    if (task.status === 'partial') status.textContent = uiText('部分段落暂未完成，已有译文已保存，可继续补译。', 'Some passages remain incomplete. Translations are saved; you can retry the remaining passages.') + (task.error ? '\n' + task.error : '')
    if (coverageText && !busy) status.textContent += (status.textContent ? '\n' : '') + coverageText
    if (busy) {
      const meter = element('progress'); meter.setAttribute('aria-label', uiText('翻译进度', 'Translation progress'))
      if (/translat/iu.test(task.stage) && task.total && task.completed !== undefined) { meter.max = task.total; meter.value = task.completed }
      status.append(meter)
    }
    const technical = [windowError, task.error, busy && jobs.speed(task.id) ? translationSpeedText(jobs.speed(task.id)!) : ''].filter(Boolean).join('\n')
    if (technical) {
      const details = element('details'), summary = element('summary'), body = element('div')
      details.open = Boolean(detailsOpen); summary.textContent = uiText('详细信息', 'Details'); body.textContent = technical; details.append(summary, body); status.append(details)
    }
    status.hidden = !status.textContent; alignHeader()
    const artifactID = `${task.id}:${task.artifact?.revision ?? 'legacy'}`
    if (!jobs.hasOutput(task) || loadedID === artifactID || Boolean(loadingID)) return
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
      const pages = await api.open(bytes, state => { if (!current() || !loadedID || activeSide !== 'translation') return; pageInput.value = String(state.page); if (linked || currentMode === 'inplace') setNative(state) }, await workerResponse.text())
      if (!current()) return
      if (pages !== renderingTask.pages) throw new Error('Translated PDF page count changed')
      const finalAnchor = previousAPI ? lastReadingState ?? anchor : anchor
      loadedID = artifactID; panel.dataset.pdfArtifactRevision = renderingTask.artifact?.revision ?? 'legacy'; restoredAnchor = undefined; api.set(finalAnchor); pageInput.max = String(pages); pageCount.textContent = `/ ${pages}`; pageInput.value = String(finalAnchor.page); applyMode(); win.requestAnimationFrame(() => { if (current() && !restoring) fit() })
    } catch (value) { if (current()) { if (!previousAPI) { void api?.destroy(); api = undefined; frame.hidden = true } applyMode(); error(value); retry.hidden = false } } finally { if (current()) { loadingID = ''; if (`${task!.id}:${task!.artifact?.revision ?? 'legacy'}` !== artifactID) void render() } }
  }
  const unsubscribe = jobs.subscribe(() => { void render() })
  const speedTimer = win.setInterval(() => { if (task?.status === 'running' || task?.status === 'queued') void render() }, 1000)
  cleanups.push(() => win.clearInterval(speedTimer))
  const start = async () => {
    status.hidden = false; status.textContent = uiText('准备 PDF 翻译…', 'Preparing PDF translation…')
    try {
      const next = savedTaskID ? jobs.get(savedTaskID) : await jobs.start(reader.itemID, translationMode)
      if (!next || (savedTaskID && next.source.itemID !== reader.itemID)) throw new Error(uiText('翻译记录不可用。', 'Translation record unavailable.'))
      if (removed) return
      if (task && task.id !== next.id) { renderEpoch++; void api?.destroy(); api = undefined; loadedID = loadingID = ''; frame.hidden = true }
      task = next; panel.dataset.pdfTaskId = next.id; applyMode(); await render()
    } catch (value) { error(value); retry.hidden = false }
  }
  const remove = () => {
    if (removed) return
    removed = true; views.delete(reader); unsubscribe(); stopTheme(); preparation.abort()
    restorePanel()
    if (pendingWindow && !pendingWindow.closed) pendingWindow.close()
    for (const cleanup of cleanups) cleanup()
    for (const name of ['updateviewarea', 'scalechanging', 'rotationchanging']) native.eventBus.off(name, fromNative)
    win.removeEventListener('pagehide', remove)
    headerObserver.disconnect(); disposeView(); panel.remove(); original.style.width = previousWidth; original.style.visibility = previousVisibility; original.style.top = previousTop; original.style.height = previousHeight; original.style.position = previousFramePosition; parent.style.position = previousPosition
  }
  frame.title = uiText('PDF 译文', 'Translated PDF'); frame.hidden = true
  panel.append(style, toolbar, status, frame); parent.append(panel)
  const headerObserver = new win.ResizeObserver(() => { expandStatus.hidden = copyStatus.hidden = status.hidden || !status.textContent; alignHeader() }); headerObserver.observe(toolbar); headerObserver.observe(status)
  for (const name of ['updateviewarea', 'scalechanging', 'rotationchanging']) native.eventBus.on(name, fromNative)
  win.addEventListener('pagehide', remove, { once: true })
  views.set(reader, { taskID: () => task?.id, show(next) { if (detached) { detached.focus(); return }; currentMode = next; showingOriginal = false; applyMode() }, remove })
  toggle.hidden = true; mono.disabled = dual.disabled = true; applyMode(); await start()
}

export function stopPDFTranslationReaders() { for (const value of [...views.values()]) value.remove() }
