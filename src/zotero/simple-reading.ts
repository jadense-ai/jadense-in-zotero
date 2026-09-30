import { requestStageLabel } from '@/chat/request-feedback'
import { diagnostics } from './diagnostics'
import { saveDiagnosticExport } from './diagnostics-panel'
import { copyTextToClipboard } from './connection-display'
/** 左侧保留原生 PDF；右侧以 SDT 安全快照呈现可翻译 HTML。 */
import type { ZoteroLike } from './runtime'
import { acquireNativeReading, assertReadingOpen, ReadingClosedError, mirrorNativeReading, observeReadingCrops, visibleReadingBlocks, readingDOMOptions, snapshotNativeReading, type SimpleReader } from './simple-reading-native'
import { applyReadingOutput, SIMPLE_READING_STRATEGY, type BoundReadingBlock } from './simple-reading-blocks'
import { simpleReadingJobs, readingTransport } from './simple-reading-jobs'
import { sameReadingSource, usableReadingOutputs, type ReadingTask } from './simple-reading-store'
import { leaveOtherReadingMode, registerReadingMode, readingTransition } from './simple-reading-modes'
import { readArticleTranslationLanguages } from './translation-settings'
import { validateDocument, type DocumentIdentity } from './pdf-document'
import { uiText, observeTheme } from './ui-preferences'
import { READER_UI_THEME_CSS } from './reader-ui-theme'
import { action, actionIcon, element } from './ui/controls'
import { chromeContentUrl } from './chrome-registration'
import type { ZoteroManagerWindow } from './manager-window'
import { wireReadingBudgetSettings } from './translation-budget-settings'
import { bindReaderControlPopover } from './reader-toolbar-menu'
import { createJdxSelect } from './ui/select'
import { createChevron } from './ui/chevron'

const readers = new Map<SimpleReader, { close(): Promise<void>; taskID(): string | undefined }>()
const openings = new Map<SimpleReader, Promise<void>>()
let lifecycle = 0
class ReadingHistoryTimeoutError extends Error {}
/** Reader 窗口销毁后其计时器和宿主 Promise 可能永不返回；取消只结束本次挂载等待。 */
async function whileReaderOpen<T>(pending: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  assertReadingOpen(signal)
  let onClose: (() => void) | undefined
  const closed = new Promise<never>((_, reject) => { onClose = () => reject(new ReadingClosedError()); signal.addEventListener('abort', onClose, { once: true }) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = timeoutMs === undefined ? undefined : new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReadingHistoryTimeoutError()), timeoutMs) })
  try { return await Promise.race(timedOut ? [pending, closed, timedOut] : [pending, closed]) }
  finally { if (onClose) signal.removeEventListener('abort', onClose); if (timer !== undefined) clearTimeout(timer) }
}
export async function openSavedSimpleReading(host: ZoteroLike, source: DocumentIdentity, taskID?: string) {
  await validateDocument(host, source)
  const reader = await (host as ZoteroLike & { Reader?: { open(id: number): Promise<SimpleReader> } }).Reader?.open(source.itemID)
  if (!reader) throw new Error(uiText('无法打开阅读器。', 'Could not open the reader.'))
  await openSimpleReading(host, reader, taskID)
}
export function openSimpleReading(host: ZoteroLike, reader: SimpleReader, taskID?: string) {
  const pending = openings.get(reader); if (pending) return pending
  const epoch = lifecycle
  const controller = new AbortController(), readerWindow = reader._iframeWindow
  const onUnload = () => controller.abort()
  readerWindow?.addEventListener('unload', onUnload, { once: true })
  const opening = readingTransition(reader, () => epoch === lifecycle && !controller.signal.aborted ? mountSimpleReading(host, reader, taskID, controller.signal) : Promise.resolve())
    .catch(error => { if (!(error instanceof ReadingClosedError) && !controller.signal.aborted) throw error })
    .finally(() => { readerWindow?.removeEventListener('unload', onUnload); openings.delete(reader) })
  openings.set(reader, opening); return opening
}
export function stopSimpleReadingReaders() { lifecycle++; for (const view of readers.values()) void view.close() }

async function mountSimpleReading(host: ZoteroLike, reader: SimpleReader, savedID: string | undefined, signal: AbortSignal) {
  const epoch = lifecycle
  const existing = readers.get(reader)
  if (existing && (!savedID || existing.taskID() === savedID)) return
  if (existing) await whileReaderOpen(existing.close(), signal)
  await whileReaderOpen(leaveOtherReadingMode(reader, 'sdt'), signal)
  const native = await whileReaderOpen(acquireNativeReading(host, reader, signal), signal)
  if (signal.aborted) return
  if (epoch !== lifecycle) { await native.restore(); return }
  const { frame: original } = native, parent = original.parentElement!, doc = parent.ownerDocument, win = doc.defaultView!
  const source = snapshotNativeReading(native.root, doc)
  const jobs = simpleReadingJobs(host)
  let languages: Awaited<ReturnType<typeof readArticleTranslationLanguages>>
  try { languages = await whileReaderOpen(readArticleTranslationLanguages(host, reader.itemID), signal) }
  catch (error) { if (!signal.aborted) await native.restore().catch(() => {}); throw error }
  const cleanups: Array<() => void> = [], originalStyle = native.pdfFrameStyle, parentPosition = parent.style.position
  let disposed = false, task: ReadingTask | undefined, mode: 'source' | 'compare' | 'translation' = 'compare', language: 'original' | 'translated' = 'translated', linked = true, busy = false
  let detached: Window | undefined, mirror: ReturnType<typeof mirrorNativeReading> | undefined, cropCleanup: (() => void) | undefined
  let bound: BoundReadingBlock[] = [], applied = new Map<string, string>(), activeSide: 'source' | 'translation' = 'source'
  let scrollCleanup: (() => void) | undefined
  let starting = false, ready = false
  let historyState: 'ready' | 'slow' | 'failed' = 'ready'
  let mirrorPosition: { id: string; fraction: number } | undefined
  const automaticPDFScale = /^(?:auto|page-width|page-fit|page-height)$/u.test(native.pdf.currentScaleValue) ? native.pdf.currentScaleValue : undefined
  const panel = element(doc, 'section', 'jdx-simple-reading'), toolbar = element(doc, 'div', 'jdx-simple-tools'), status = element(doc, 'div', 'jdx-simple-status'), embeddedFrame = element(doc, 'iframe'), style = element(doc, 'style')
  let frame = embeddedFrame, openingWindow = false
  panel.setAttribute('data-jadense-reader-theme', ''); panel.setAttribute('aria-label', uiText('简阅模式', 'Reading mode')); status.setAttribute('role', 'status')
  status.textContent = uiText('正在读取简阅内容…', 'Loading reading content…')
  frame.title = uiText('简阅 HTML 内容（批注请使用左侧 PDF）', 'Reading HTML (annotate the PDF on the left)')
  // 固定空白文档，不载入 Provider HTML；禁用脚本、表单和弹窗。
  frame.setAttribute('sandbox', 'allow-same-origin'); frame.src = 'about:blank'; frame.hidden = true
  style.textContent = `${READER_UI_THEME_CSS}
.jdx-simple-reading{position:absolute;inset:0;z-index:3;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;min-width:0;container-type:inline-size;color:var(--jdx-reader-text);font:calc(13px * var(--jdx-font-scale,1)) system-ui}
.jdx-simple-tools,.jdx-simple-status{box-sizing:border-box;width:100%;pointer-events:auto;background:var(--jdx-reader-background);border-bottom:1px solid var(--jdx-reader-line);padding:5px 8px}
.jdx-simple-tools{display:flex;align-items:center;gap:6px;flex:none;min-height:42px;white-space:nowrap;overflow:hidden}
.jdx-simple-reading button,.jdx-simple-reading input{box-sizing:border-box;font:inherit;min-height:32px;border:1px solid var(--jdx-reader-border);border-radius:6px;padding:4px 9px;color:inherit;background:transparent;max-width:100%}
.jdx-simple-tools>button{flex:none}
.jdx-simple-tools .jdx-simple-task{margin-inline-start:auto;max-width:30cqw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jdx-simple-reading .jdx-icon-action{display:inline-flex;align-items:center;justify-content:center;width:32px;min-width:32px;padding:0;font-size:0}
.jdx-simple-reading .jdx-icon-action::before{content:"";width:18px;height:18px;flex:none;background:currentColor;mask:var(--jdx-action-icon) center/contain no-repeat}
.jdx-simple-view{flex:none;width:130px;min-width:100px;max-width:150px}
.jdx-simple-view .jdx-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:32px;padding:4px 8px;background:var(--jdx-reader-surface)}
.jdx-simple-view .jdx-select-value{overflow:hidden;text-overflow:ellipsis}
.jdx-simple-view .jdx-select-chevron{width:14px;height:14px;flex:none}
.jdx-simple-view .jdx-select-popup{position:fixed;z-index:10;display:none;overflow:auto;border:1px solid var(--jdx-reader-border);border-radius:8px;padding:4px;background:var(--jdx-reader-background);box-shadow:0 10px 24px rgba(0,0,0,.16)}
.jdx-simple-view[data-open=true] .jdx-select-popup{display:block}
.jdx-simple-view .jdx-select-list{list-style:none;margin:0;padding:0}
.jdx-simple-view .jdx-select-option{min-height:32px;padding:6px 8px;border-radius:5px;cursor:pointer}
.jdx-simple-view .jdx-select-option[data-active=true]{background:var(--jdx-reader-hover)}
.jdx-simple-view .jdx-select-option[aria-selected=true]{color:#16cf8c}
.jdx-simple-view .jdx-select-option-description{display:none}
.jdx-simple-language{margin-top:4px;padding-top:6px;border-top:1px solid var(--jdx-reader-line)}
.jdx-simple-language-label{display:block;padding:2px 8px 5px;color:var(--jdx-reader-muted);font-size:calc(11px * var(--jdx-font-scale,1));font-weight:600}
.jdx-simple-language button{display:block;width:100%;min-height:32px;border:0;padding:6px 8px;text-align:start}
.jdx-simple-reading .jdx-simple-language button[aria-pressed=true]{background:var(--jdx-reader-hover);border:0;color:#16cf8c}
.jdx-simple-tools .jdx-simple-status-toggle{display:inline-flex;align-items:center;gap:6px;max-width:min(320px,42%);min-width:0;text-align:start;color:var(--jdx-reader-text)}
.jdx-simple-status-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jdx-simple-status-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--jdx-reader-muted)}
.jdx-simple-status-toggle[data-state=busy] .jdx-simple-status-dot,.jdx-simple-status-toggle[data-state=success] .jdx-simple-status-dot{background:#16cf8c}
.jdx-simple-status-toggle[data-state=warning] .jdx-simple-status-dot{background:#c37d0d}
.jdx-simple-status-toggle[data-state=error] .jdx-simple-status-dot{background:#d45656}
.jdx-simple-status-chevron{flex:none;width:14px;height:14px;color:var(--jdx-reader-muted)}
.jdx-simple-status-toggle[aria-expanded=true] .jdx-simple-status-chevron{transform:rotate(180deg)}
@container(max-width:390px){.jdx-simple-tools{gap:3px;padding-inline:4px}.jdx-simple-view{width:88px;min-width:88px}.jdx-simple-tools .jdx-simple-task{max-width:58px}.jdx-simple-tools .jdx-simple-status-toggle{width:32px;min-width:32px;padding:0;justify-content:center}.jdx-simple-tools .jdx-simple-status-label,.jdx-simple-tools .jdx-simple-status-chevron{display:none}}
.jdx-simple-reading button:hover{background:var(--jdx-reader-hover)}
.jdx-simple-reading button[aria-pressed=true]{border-color:#16cf8c;background:var(--jdx-reader-active)}
.jdx-simple-reading :focus-visible{outline:2px solid #16cf8c;outline-offset:1px}
.jdx-simple-reading button:disabled{opacity:.5}
.jdx-simple-reading input{width:130px;min-width:60px}
.jdx-simple-status{color:var(--jdx-reader-muted);white-space:pre-wrap;overflow-wrap:anywhere}
.jdx-simple-budget{position:absolute;z-index:5;pointer-events:auto;box-sizing:border-box;min-width:220px;max-width:min(320px,calc(100% - 16px));max-height:calc(100% - 52px);overflow:auto;padding:8px;border:1px solid var(--jdx-reader-border);border-radius:8px;background:var(--jdx-reader-background);box-shadow:0 10px 24px rgba(0,0,0,.16);white-space:normal}
.jdx-simple-budget input{width:100%}
.jdx-simple-group{display:flex;flex-direction:column;gap:2px;padding:5px 0;border-bottom:1px solid var(--jdx-reader-line)}
.jdx-simple-group:last-child{border:0}
.jdx-simple-group::before{content:attr(aria-label);font-size:calc(11px * var(--jdx-font-scale,1));font-weight:600;color:var(--jdx-reader-muted);padding:2px 8px}
.jdx-simple-group>button{text-align:start;width:100%;white-space:normal}
.jdx-simple-search input{width:100%}
.jdx-simple-reading iframe{pointer-events:auto;flex:1;min-height:0;width:50%;border:0;border-left:1px solid var(--jdx-reader-line);background:var(--jdx-reader-background)}
.jdx-simple-reading [hidden]{display:none!important}`
  panel.append(style, toolbar, status, frame); parent.append(panel)
  if (win.getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
  let mirrorDark = false
  const updateMirrorTheme = (dark: boolean) => {
    mirrorDark = dark
    const target = frame.contentDocument
    if (!target?.getElementById('sdt-content')) return
    const html = target.documentElement
    html.dataset.colorScheme = dark ? 'dark' : 'light'
    html.style.colorScheme = dark ? 'dark' : 'light'
    html.style.setProperty('--background-color', dark ? '#2E3440' : '#ffffff')
    html.style.setProperty('--text-color', dark ? '#D8DEE9' : '#111510')
  }
  cleanups.push(observeTheme(host, panel, updateMirrorTheme))
  const layout = () => {
    if (disposed) return
    const top = toolbar.offsetHeight
    original.style.position = 'absolute'; original.style.top = `${top}px`; original.style.height = `calc(100% - ${top}px)`
    original.style.width = mode === 'compare' && !detached ? '50%' : '100%'; original.style.visibility = mode === 'translation' && !detached ? 'hidden' : 'visible'
    frame.hidden = mode === 'source' && !detached
    frame.style.width = detached || mode === 'translation' ? '100%' : '50%'
    linkedButton.hidden = mode !== 'compare' && !detached
    viewSelect.setValue(detached ? 'multi' : mode)
  }
  // 沿用对照翻译的单行主栏与 Reader 输入弹层；SDT 没有 PDF 导出，保留自己的阅读操作。
  const menu = element(doc, 'div', 'jdx-simple-budget jdx-simple-menu'), searchPanel = element(doc, 'div', 'jdx-simple-budget jdx-simple-search')
  status.classList.add('jdx-simple-budget'); status.hidden = menu.hidden = searchPanel.hidden = true
  for (const [popup, label] of [[menu, uiText('简阅操作', 'Reading actions')], [searchPanel, uiText('搜索原文或译文', 'Search either view')], [status, uiText('翻译状态', 'Translation status')]] as const) { popup.setAttribute('aria-label', label); popup.setAttribute('role', 'dialog') }
  const group = (label: string) => { const node = element(doc, 'div', 'jdx-simple-group'); node.setAttribute('role', 'group'); node.setAttribute('aria-label', label); menu.append(node); return node }
  const navigation = group(uiText('阅读与视图', 'Reading and view')), settings = group(uiText('翻译设置', 'Translation settings'))
  const statusToggle = action(doc, uiText('正在读取', 'Loading'), () => {}); statusToggle.classList.add('jdx-simple-status-toggle')
  statusToggle.setAttribute('aria-label', uiText('翻译状态', 'Translation status'))
  const statusDot = element(doc, 'span', 'jdx-simple-status-dot'), statusLabel = element(doc, 'span', 'jdx-simple-status-label')
  statusDot.setAttribute('aria-hidden', 'true'); statusLabel.textContent = statusToggle.textContent
  statusToggle.replaceChildren(statusDot, statusLabel, createChevron(doc, 'jdx-simple-status-chevron', 'down', 14))
  toolbar.append(statusToggle); panel.append(menu, searchPanel)
  const viewHost = element(doc, 'div', 'jdx-simple-view')
  toolbar.prepend(viewHost)
  const viewSelect = createJdxSelect(viewHost, { ariaLabel: uiText('阅读视图', 'Reading view') })
  toolbar.insertBefore(statusToggle, viewHost)
  viewSelect.setOptions([
    { value: 'source', label: uiText('原 PDF', 'Original PDF') },
    { value: 'compare', label: uiText('双视图', 'Split view') },
    { value: 'translation', label: uiText('简阅内容', 'Reading content') },
    { value: 'multi', label: uiText('多屏阅读', 'Separate window') },
  ], mode)
  cleanups.push(() => viewSelect.destroy())
  const languageGroup = element(doc, 'div', 'jdx-simple-language'), languageLabel = element(doc, 'span', 'jdx-simple-language-label')
  languageLabel.textContent = uiText('简阅 HTML', 'Reading HTML'); languageGroup.setAttribute('role', 'group'); languageGroup.setAttribute('aria-label', uiText('简阅 HTML 语言', 'Reading HTML language'))
  const selectLanguage = (next: typeof language) => {
    const hadTranslation = Boolean(task && Object.keys(usableReadingOutputs(task, native.blocks)).length)
    if (next === 'translated' && !hadTranslation) return
    const changedContent = hadTranslation && language !== next
    language = next; viewSelect.close(); viewHost.querySelector<HTMLButtonElement>('.jdx-select-trigger')?.focus()
    if (changedContent && ready) void buildMirror().then(render).catch(error => { status.textContent = error instanceof Error ? error.message : String(error) })
    else if (ready) render()
  }
  const originalLanguage = action(doc, uiText('原文', 'Original'), () => selectLanguage('original'))
  const translatedLanguage = action(doc, uiText('译文', 'Translation'), () => selectLanguage('translated'))
  originalLanguage.setAttribute('aria-pressed', 'true'); translatedLanguage.disabled = true
  languageGroup.append(languageLabel, originalLanguage, translatedLanguage)
  const viewPopup = viewHost.querySelector<HTMLElement>('.jdx-select-popup')!
  viewHost.querySelector<HTMLButtonElement>('.jdx-select-trigger')!.setAttribute('aria-haspopup', 'dialog')
  viewPopup.setAttribute('role', 'dialog'); viewPopup.setAttribute('aria-label', uiText('阅读视图与简阅 HTML', 'Reading view and HTML language'))
  viewPopup.append(languageGroup)
  languageGroup.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); viewSelect.close(); viewHost.querySelector<HTMLButtonElement>('.jdx-select-trigger')?.focus() }
    if (event.key === 'Tab') win.setTimeout(() => { if (!viewHost.contains(doc.activeElement)) viewSelect.close() }, 0)
  })
  const linkedButton = action(doc, uiText('同步滚动', 'Sync scroll'), () => { linked = !linked; linkedButton.setAttribute('aria-pressed', String(linked)); if (linked) syncPages(activeSide) }); linkedButton.setAttribute('aria-pressed', 'true'); linkedButton.hidden = true; toolbar.append(linkedButton)
  const translate = action(doc, uiText('翻译', 'Translate'), () => { void start(false) }), retranslate = action(doc, uiText('重新翻译', 'Retranslate'), () => { void start(true) }), cancel = action(doc, uiText('取消', 'Cancel'), () => { if (task) jobs.cancel(task.id) })
  translate.classList.add('jdx-simple-task'); cancel.classList.add('jdx-simple-task')
  retranslate.hidden = true; cancel.hidden = true; translate.disabled = true
  toolbar.append(translate, cancel); navigation.append(linkedButton); settings.append(retranslate)
  cleanups.push(wireReadingBudgetSettings(host, settings, ['simple']))
  const search = element(doc, 'input'); search.type = 'search'; search.placeholder = uiText('搜索原文或译文', 'Search either view'); search.setAttribute('aria-label', search.placeholder)
  let searchIndex = -1, lastQuery = ''
  const find = () => {
    const query = search.value.trim().toLocaleLowerCase(); if (!query) return
    if (mode === 'source') { native.pdf.eventBus.dispatch?.('find', { source: win, type: 'again', query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false }); return }
    const roots = mirror ? [mirror.root] : []
    const found = roots.flatMap(root => Array.from(root.querySelectorAll<HTMLElement>('p,li,td,th,figcaption,h1,h2,h3,aside')).filter(el => el.textContent?.toLocaleLowerCase().includes(query)))
    searchIndex = query === lastQuery ? (searchIndex + 1) % Math.max(1, found.length) : 0; lastQuery = query
    const target = found[searchIndex]
    if (target) { activeSide = 'translation'; target.scrollIntoView(readingDOMOptions({ block: 'center' as const }, target.ownerDocument.defaultView!)); const selection = target.ownerDocument.defaultView?.getSelection(), range = target.ownerDocument.createRange(); range.selectNodeContents(target); selection?.removeAllRanges(); selection?.addRange(range) }
    status.textContent = found.length ? `${searchIndex + 1} / ${found.length}` : uiText('未找到匹配内容', 'No matches'); layout()
  }
  search.addEventListener('keydown', event => { if (event.key === 'Enter') find() }); searchPanel.append(search, action(doc, uiText('查找下一个', 'Find next'), find))
  const searchToggle = actionIcon(action(doc, search.placeholder, () => {}), 'search'), more = actionIcon(action(doc, uiText('简阅操作', 'Reading actions'), () => {}), 'more')
  toolbar.append(searchToggle, more)
  const popovers = [[more, menu], [searchToggle, searchPanel], [statusToggle, status]] as const
  const bindings = popovers.map(([toggle, popup]) => bindReaderControlPopover(toggle, popup, panel))
  popovers.forEach(([toggle], index) => toggle.addEventListener('click', () => bindings.forEach((binding, other) => { if (index !== other) binding.close() })))
  cleanups.push(...bindings.map(binding => binding.remove))

  const render = () => {
    if (disposed || !ready) return
    if (task) task = jobs.get(task.id) ?? task
    busy = starting || Boolean(task && jobs.active(task.id)); translate.disabled = busy; retranslate.disabled = busy; cancel.hidden = !busy; cancel.disabled = starting
    const outputs = task ? usableReadingOutputs(task, native.blocks) : {}, count = Object.keys(outputs).length
    const showTranslation = language === 'translated' && count > 0
    originalLanguage.setAttribute('aria-pressed', String(!showTranslation))
    translatedLanguage.setAttribute('aria-pressed', String(showTranslation)); translatedLanguage.disabled = count === 0
    detach.disabled = false; retranslate.hidden = !task || busy
    translate.textContent = busy ? uiText('正在翻译', 'Translating') : count ? uiText('仅补译', 'Translate missing') : uiText('翻译', 'Translate')
    translate.title = translate.textContent
    translate.hidden = busy; translate.disabled ||= count === native.blocks.length
    const stageText = task?.progress ? `${requestStageLabel(task.progress.stage)} · ${Math.max(0, Math.floor((Date.now() - task.progress.stageStartedAt) / 1000))}s` : uiText('正在翻译', 'Translating')
    statusLabel.textContent = busy ? stageText : task ? `${count} / ${native.blocks.length}${task.error ? uiText(' · 待重试', ' · Retry needed') : ''}` : uiText('待翻译', 'Not translated')
    if (historyState !== 'ready') statusLabel.textContent += historyState === 'slow' ? uiText(' · 历史读取较慢', ' · History is slow') : uiText(' · 历史读取失败', ' · History unavailable')
    statusToggle.dataset.state = busy ? 'busy' : task?.error ? 'error' : count === native.blocks.length ? 'success' : count ? 'warning' : 'idle'
    statusToggle.title = statusLabel.textContent; statusToggle.setAttribute('aria-label', uiText(`翻译状态：${statusLabel.textContent}`, `Translation status: ${statusLabel.textContent}`))
    const remaining = native.blocks.length - count
    status.textContent = starting ? uiText('正在准备翻译，可继续阅读原文。', 'Preparing translation; you can keep reading the original.') : task ? `${uiText('已译', 'Translated')} ${count} / ${native.blocks.length} · ${busy ? `${stageText} · ${uiText('已接收正文', 'Text received')} ${task.progress?.receivedCharacters ?? 0} ${uiText('字符', 'characters')}` : !remaining ? uiText('已完成', 'Complete') : count ? uiText(`${remaining} 段未翻译，已在文中标明；可点击仅补译`, `${remaining} untranslated blocks are marked below; use Translate missing`) : uiText('尚无译文，请重试翻译', 'No translation yet. Retry Translate')}${task.error ? '\n' + task.error : ''}${task.storageWarning ? '\n' + uiText('未保存，请复制已有译文。', 'Not saved. Copy existing translations.') : ''}`
      : uiText('右侧显示提取的原文 HTML。点击翻译后仅替换右侧文字；图像与公式保留原貌。', 'Extracted original HTML appears on the right. Translate replaces text there only; images and formulas stay unchanged.')
    if (historyState !== 'ready') status.textContent += '\n' + (historyState === 'slow' ? uiText('简阅历史仍在读取，原文可继续阅读。', 'Reading history is still loading; the original remains available.') : uiText('简阅历史读取失败，原文仍可阅读。', 'Reading history could not be loaded; the original remains available.'))
    if (task?.error) {
      const store = diagnostics(host)!
      const exportText = () => store.export(store.list().filter(row => row.context.taskId === `sdt-${task!.id}` || row.id === task!.issue?.localDiagnosticId))
      const details = element(doc, 'details'), summary = element(doc, 'summary'), facts = element(doc, 'pre')
      summary.textContent = uiText('查看关联诊断', 'View linked diagnostics'); facts.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:inherit'
      facts.textContent = JSON.stringify(task.issue ?? {}, null, 2)
      details.append(summary, facts); status.append(details,
        action(doc, uiText('复制诊断', 'Copy diagnostics'), () => { void copyTextToClipboard(host, exportText()) }),
        action(doc, uiText('导出诊断', 'Export diagnostics'), () => { void saveDiagnosticExport(win, exportText()).catch(() => { facts.textContent = uiText('导出失败，可复制诊断。', 'Export failed; copy diagnostics instead.') }) }))
    }
    if (mirror && task && showTranslation) {
      // 外层条目更新后重新定位嵌套块，不能对已脱离 DOM 的旧节点回填。
      for (const block of bound) {
        const output = outputs[block.id]
        const target = mirror.root.querySelector<HTMLElement>(`[data-ref-path="${block.id}"]`)
        if (!target) continue
        if (output) {
          if (applied.get(block.id) !== output && applyReadingOutput({ ...block, element: target }, output)) { applied.set(block.id, output); for (const id of applied.keys()) if (id.startsWith(block.id + '.')) applied.delete(id) }
          target.dataset.jdxTranslationState = 'translated'
        } else {
          target.dataset.jdxTranslationState = busy ? 'pending' : 'missing'
          let label = Array.from(target.children).find(node => node.hasAttribute('data-jdx-reading-status')) as HTMLElement | undefined
          if (!label) {
            label = element(target.ownerDocument, 'span'); label.setAttribute('data-jdx-reading-status', '')
            label.style.cssText = 'display:block;font:normal .7em/1.6 system-ui;opacity:.75;margin-bottom:.35em;padding-inline-start:8px;border-inline-start:2px solid currentColor'
            target.prepend(label)
          }
          label.textContent = busy ? uiText('待翻译 · 以下为原文', 'Translation pending · Original text below') : uiText('未翻译 · 以下为原文', 'Not translated · Original text below')
        }
      }
    }
    layout()
  }
  const progressTimer = win.setInterval(() => { if (busy) render() }, 1000)
  cleanups.push(() => win.clearInterval(progressTimer))
  async function start(fresh: boolean) {
    if (!ready || busy || disposed) return
    starting = true; busy = true; translate.disabled = true; retranslate.disabled = true
    render()
    try {
      // 每次显式执行重新验证文件摘要；打开期间替换源文件也不能启动旧结构的翻译。
      const { pdfSource } = await import('./pdf-translation-jobs')
      const origin = await pdfSource(host, reader.itemID)
      if (disposed) return
      if (origin.fingerprint !== native.identity.fingerprint) throw new Error(uiText('原文件已变化，请关闭并重新打开简阅。', 'The source file changed. Close and reopen reading mode.'))
      const transport = await readingTransport(host)
      if (disposed) return
      task = await jobs.start(native.identity, languages, native.blocks.map(({ id, text, pairs }) => ({ id, text, pairs })), transport, () => mirror ? visibleReadingBlocks(bound.map(block => ({ ...block, element: mirror!.root.querySelector<HTMLElement>(`[data-ref-path="${block.id}"]`) ?? block.element }))) : new Set<string>(), fresh, fresh ? undefined : task?.id)
      if (disposed) return
      if (fresh) { await buildMirror(); applied = new Map() }
      starting = false; render()
    } catch (error) { starting = false; render(); status.textContent = error instanceof Error ? error.message : uiText('无法开始翻译。', 'Could not start translation.'); statusLabel.textContent = uiText('翻译未开始', 'Could not translate'); bindings[2].close(); statusToggle.click(); layout() }
  }
  let synchronizing = false
  const pageAtPDFTop = () => {
    let index = Math.max(0, native.pdf.currentPageNumber - 1)
    const top = native.pdf.container.scrollTop
    while (index > 0 && native.pdf.getPageView(index).div.offsetTop > top) index--
    while (index + 1 < native.pdf.pagesCount && native.pdf.getPageView(index + 1).div.offsetTop <= top) index++
    return index
  }
  const fitPDF = () => {
    if (!automaticPDFScale || native.pdf.currentScaleValue !== automaticPDFScale || mode === 'translation' || detached) return
    const index = pageAtPDFTop(), page = native.pdf.getPageView(index)?.div
    const fraction = page?.offsetHeight ? (native.pdf.container.scrollTop - page.offsetTop) / page.offsetHeight : 0
    native.pdf.currentScaleValue = automaticPDFScale
    const resized = native.pdf.getPageView(index)?.div
    if (resized) native.pdf.container.scrollTop = resized.offsetTop + resized.offsetHeight * Math.max(0, Math.min(1, fraction))
  }
  const syncPages = (side: typeof activeSide) => {
    if (!linked || !mirror || mode !== 'compare' || synchronizing || detached) return
    if (side === 'source') {
      const page = pageAtPDFTop(), index = native.pages.findIndex(mapped => mapped.includes(page))
      const target = index < 0 ? null : mirror.root.querySelector<HTMLElement>(`[data-ref-path="${index}"]`)
      if (!target) return
      synchronizing = true; target.scrollIntoView(readingDOMOptions({ block: 'start' as const }, target.ownerDocument.defaultView!))
    } else {
      const top = Array.from(mirror.root.children).find(node => node.hasAttribute('data-ref-path') && node.getBoundingClientRect().bottom > 0) as HTMLElement | undefined
      const index = Number(top?.dataset.refPath?.split('.')[0]), page = native.pages[index]?.[0]
      const target = page === undefined ? undefined : native.pdf.getPageView(page)?.div
      if (!target) return
      synchronizing = true; native.pdf.container.scrollTop = target.offsetTop
    }
    win.requestAnimationFrame(() => { synchronizing = false })
  }
  async function buildMirror() {
    assertReadingOpen(signal)
    scrollCleanup?.(); cropCleanup?.(); mirror?.remove()
    const deadline = Date.now() + 10000
    while ((!frame.contentDocument?.body || frame.contentDocument.readyState !== 'complete') && !disposed && Date.now() < deadline) await whileReaderOpen(new Promise<void>(resolve => setTimeout(resolve, 30)), signal)
    assertReadingOpen(signal)
    if (disposed) return
    const target = frame.contentDocument
    if (!target) throw new Error(uiText('译文视图尚未就绪。', 'The translation view is not ready.'))
    mirror = mirrorNativeReading(source, target, native.authors); bound = mirror.blocks; applied.clear()
    updateMirrorTheme(mirrorDark)
    cropCleanup = observeReadingCrops(mirror.root, native.createCrops(), native.baseWindow)
    const a = native.baseWindow!, b = target.defaultView!, translated = mirror.root
    const inputA = () => { activeSide = 'source' }, inputB = () => { activeSide = 'translation' }
    const scrollA = () => { if (activeSide === 'source') syncPages('source') }
    const scrollB = () => {
      const anchor = native.blocks.map(block => translated.querySelector<HTMLElement>(`[data-ref-path="${block.id}"]`)).find(el => el && el.getBoundingClientRect().bottom > 0)
      if (anchor) { const rect = anchor.getBoundingClientRect(); mirrorPosition = { id: anchor.dataset.refPath!, fraction: rect.top / Math.max(1, rect.height) } }
      if (activeSide === 'translation') syncPages('translation')
    }
    for (const event of ['wheel', 'pointerdown', 'keydown']) { a?.addEventListener(event, inputA, true); b.addEventListener(event, inputB, true) }
    native.pdf.container.addEventListener('scroll', scrollA); b.addEventListener('scroll', scrollB)
    scrollCleanup = () => { for (const event of ['wheel', 'pointerdown', 'keydown']) { a?.removeEventListener(event, inputA, true); b.removeEventListener(event, inputB, true) }; native.pdf.container.removeEventListener('scroll', scrollA); b.removeEventListener('scroll', scrollB) }
    const position = mirrorPosition
    if (position) win.requestAnimationFrame(() => {
      if (disposed) return
      const anchor = translated.querySelector<HTMLElement>(`[data-ref-path="${position.id}"]`)
      if (anchor) { const rect = anchor.getBoundingClientRect(); b.scrollBy(0, rect.top - position.fraction * rect.height) }
    })
  }
  const detach = action(doc, uiText('多屏阅读', 'Separate window'), () => { void (async () => {
    if (detached) { detached.focus(); return }
    if (openingWindow) return
    openingWindow = true
    const main = host.getMainWindow?.() as ZoteroManagerWindow | undefined
    const opened = main?.openDialog?.(chromeContentUrl('pdf-translation-window.xhtml'), '', 'chrome,dialog=no,titlebar,resizable,centerscreen,width=960,height=760') as Window | undefined
    if (!opened) { openingWindow = false; viewSelect.setValue(mode); return }
    const deadline = Date.now() + 10000
    let body: HTMLElement | null | undefined
    while (!body && !opened.closed && !disposed && Date.now() < deadline) {
      const browser = opened.document.getElementById('translation-host') as (Element & { contentDocument?: Document }) | null
      body = opened.document.readyState === 'complete' ? browser?.contentDocument?.body : undefined
      if (!body) await new Promise(resolve => win.setTimeout(resolve, 30))
    }
    openingWindow = false
    if (disposed) { opened.close(); return }
    if (!body || opened.closed) { opened.close(); throw new Error('Separate reader unavailable') }
    detached = opened; opened.document.title = uiText('简阅译文', 'Reading translation')
    body.replaceChildren(); body.style.cssText = 'margin:0;display:flex;flex-direction:column;height:100vh'
    const detachedRoot = element(body.ownerDocument, 'section', 'jdx-simple-reading'), detachedToolbar = element(body.ownerDocument, 'div', 'jdx-simple-tools')
    detachedRoot.setAttribute('data-jadense-reader-theme', '')
    const back = action(body.ownerDocument, uiText('返回对照阅读', 'Return to compare'), () => opened.close())
    const detachedSearch = element(body.ownerDocument, 'input'); detachedSearch.type = 'search'; detachedSearch.placeholder = search.placeholder; detachedSearch.setAttribute('aria-label', search.placeholder)
    const detachedFind = () => { search.value = detachedSearch.value; activeSide = 'translation'; find() }
    detachedSearch.addEventListener('keydown', event => { if (event.key === 'Enter') detachedFind() })
    detachedToolbar.append(back, detachedSearch, action(body.ownerDocument, uiText('查找下一个', 'Find next'), detachedFind))
    frame = element(body.ownerDocument, 'iframe'); frame.setAttribute('sandbox', 'allow-same-origin'); frame.title = embeddedFrame.title; frame.src = 'about:blank'
    detachedRoot.append(body.ownerDocument.importNode(style, true), detachedToolbar, frame); body.append(detachedRoot); frame.style.cssText = 'flex:1;width:100%;min-height:0;border:0'; embeddedFrame.hidden = true
    const stopTheme = observeTheme(host, detachedRoot, updateMirrorTheme)
    opened.addEventListener('unload', () => { stopTheme(); if (disposed) return; detached = undefined; frame = embeddedFrame; void buildMirror().then(render).catch(() => {}); layout() }, { once: true })
    await buildMirror(); mode = 'compare'; render()
  })().catch(error => { openingWindow = false; detached?.close(); viewSelect.setValue(mode); status.textContent = `${uiText('多屏视图无法打开，请继续在当前窗口阅读。', 'Separate window unavailable. Continue reading here.')}\n${error instanceof Error ? error.message : String(error)}`; statusLabel.textContent = uiText('视图打开失败', 'View unavailable') }) }); detach.disabled = true
  viewSelect.onChange(value => {
    if (value === 'multi') { detach.click(); return }
    mode = value as typeof mode; layout()
  })
  const close = async () => {
    if (disposed) return
    disposed = true; readers.delete(reader); scrollCleanup?.(); cropCleanup?.(); mirror?.remove(); cleanups.forEach(fn => fn()); detached?.close(); panel.remove()
    if (originalStyle === null) original.removeAttribute('style'); else original.setAttribute('style', originalStyle)
    parent.style.position = parentPosition
    if (!readerClosed && !signal.aborted) await native.restore()
  }
  // 关闭也必须进入同一队列；原生 SDT 销毁未完成时，立即重开会读到失效的 iframe。
  toolbar.append(actionIcon(action(doc, uiText('退出简阅', 'Close reading mode'), () => { void readingTransition(reader, close) }), 'close'))
  readers.set(reader, { close, taskID: () => task?.id }); cleanups.push(registerReadingMode(reader, 'sdt', close))
  let readerClosed = false
  const unload = () => { readerClosed = true; void close() }; win.addEventListener('unload', unload, { once: true }); cleanups.push(() => win.removeEventListener('unload', unload))
  let fitFrame = 0, lastWidth = 0
  const scheduleFit = () => {
    const width = original.getBoundingClientRect().width
    if (!width || width === lastWidth) return
    lastWidth = width; win.cancelAnimationFrame(fitFrame)
    fitFrame = win.requestAnimationFrame(() => { if (!disposed) fitPDF() })
  }
  const onResize = () => { layout(); scheduleFit() }
  win.addEventListener('resize', onResize); cleanups.push(() => { win.removeEventListener('resize', onResize); win.cancelAnimationFrame(fitFrame) })
  try { const resize = new win.ResizeObserver(onResize); resize.observe(parent); resize.observe(original); cleanups.push(() => resize.disconnect()) } catch { /* 旧宿主继续使用窗口 resize。 */ }
  layout()
  try {
    statusLabel.textContent = uiText('正在读取简阅结构', 'Loading reading structure')
    await buildMirror()
    await whileReaderOpen(native.showPDF(), signal)
    mirror?.remove()
    if (disposed) return
    scheduleFit()
    statusLabel.textContent = uiText('正在读取简阅历史', 'Loading reading history')
    const historyLoad = jobs.load()
    try { await whileReaderOpen(historyLoad, signal, 10000) }
    catch (error) {
      if (error instanceof ReadingClosedError) throw error
      historyState = error instanceof ReadingHistoryTimeoutError ? 'slow' : 'failed'
      if (historyState === 'slow') void historyLoad.then(() => {
        if (disposed) return
        historyState = 'ready'
        if (!task) {
          const loaded = savedID ? jobs.get(savedID) : jobs.find(native.identity, languages)
          if (loaded && sameReadingSource(loaded, native.identity) && loaded.strategy === SIMPLE_READING_STRATEGY) task = loaded
        }
        render()
      }, () => { if (!disposed) { historyState = 'failed'; render() } })
    }
    if (disposed) return
    task = savedID ? jobs.get(savedID) : jobs.find(native.identity, languages)
    if (savedID && (!task || !sameReadingSource(task, native.identity) || task.strategy !== SIMPLE_READING_STRATEGY)) throw new Error(uiText('此译文与当前原文件或 SDT 结构不匹配，未套用旧译文。', 'This translation does not match the current file or SDT structure. It was not applied.'))
    ready = true; cleanups.push(jobs.subscribe(render)); render()
  } catch (error) { await close(); throw error }
}
