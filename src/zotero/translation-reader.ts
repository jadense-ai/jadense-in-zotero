import { createJdxSelect } from "./ui/select"
/** 连续译文阅读器：Reader 原生侧栏、停靠栏和 Manager 历史共用；不拥有模型请求生命周期。 */
import { updateChatMarkdown } from "@/chat/markdown"
import { documentJobs } from "./document-jobs"
import { navigateDocument, type DocumentHost } from "./pdf-document"
import type { ZoteroLike } from "./runtime"
import { observeTheme, uiText } from "./ui-preferences"
import { READER_UI_THEME_CSS } from "./reader-ui-theme"
import { copyTextToClipboard } from "./connection-display"
import { actionIcon, element, action } from "./ui/controls"
import type { TranslationReadingPosition, TranslationReadingRow } from "./translation-reading"

const FONT = "extensions.jadenseInZotero.translationReadingFontSize"
const LINE = "extensions.jadenseInZotero.translationReadingLineHeight"
const CSS = `${READER_UI_THEME_CSS}
.jdx-translation-reader{--jdx-text:var(--jdx-reader-text);--jdx-muted:var(--jdx-reader-muted);--jdx-surface:var(--jdx-reader-background);--jdx-line-strong:var(--jdx-reader-line);--jdx-press-bg:var(--jdx-reader-hover);--jdx-green-deep:#0f7c56;--jdx-active-bg:var(--jdx-reader-hover);--jdx-popup-shadow:0 6px 18px #0002;display:flex;flex-direction:column;position:relative;min-width:0;min-height:0;height:100%;overflow:hidden;background:var(--jdx-reader-background);color:var(--jdx-reader-text);font:13px/1.4 system-ui,sans-serif;container-type:inline-size;box-sizing:border-box}
.jdx-translation-reader *{box-sizing:border-box}
.jdx-translation-reader [hidden]{display:none!important}
.jdx-translation-reader button,.jdx-translation-reader select{font:inherit;color:inherit;max-width:100%;border:1px solid transparent;border-radius:5px;background:transparent;min-height:28px;padding:4px 7px;cursor:pointer}
.jdx-translation-reader button:hover,.jdx-translation-reader summary:hover{background:var(--jdx-reader-hover)}
.jdx-translation-reader button:disabled{opacity:.5;cursor:default}
.jdx-translation-reader :focus-visible{outline:2px solid #16cf8c;outline-offset:2px}
.jdx-reading-toolbar{position:relative;display:flex;align-items:center;gap:4px;flex:none;padding:7px 12px;border-bottom:1px solid var(--jdx-reader-line);z-index:2}
.jdx-reading-modes{display:flex;gap:2px;margin-inline-end:auto}
.jdx-reading-modes [aria-pressed=true]{background:var(--jdx-reader-hover);font-weight:600}
.jdx-reading-popover{position:static;font-size:13px;flex:none}
.jdx-reading-popover>summary{list-style:none;cursor:pointer;min-height:28px;display:flex;align-items:center;padding:4px 7px;border-radius:5px}
.jdx-reading-popover>summary::-webkit-details-marker{display:none}
.jdx-reading-menu{position:absolute;inset-inline-end:8px;top:calc(100% + 4px);display:flex;flex-direction:column;gap:6px;width:220px;max-width:calc(100% - 16px);max-height:55vh;overflow:auto;padding:10px;background:var(--jdx-reader-background);border:1px solid var(--jdx-reader-line);border-radius:6px;box-shadow:0 4px 12px #0001;z-index:3}
.jdx-reading-menu button{text-align:start}
.jdx-reading-menu label{display:flex;justify-content:space-between;align-items:center;gap:12px}
.jdx-reading-menu select{border-color:var(--jdx-reader-line);background:var(--jdx-reader-background)}
.jdx-reading-progress{position:absolute;bottom:-1px;left:0;width:100%;height:2px;border:0;appearance:none;background:transparent;accent-color:#16cf8c}
.jdx-reading-progress::-moz-progress-bar{background:#16cf8c}
.jdx-reading-progress::-webkit-progress-bar{background:transparent}
.jdx-reading-progress::-webkit-progress-value{background:#16cf8c}
.jdx-reading-body{position:relative;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:24px;overflow-anchor:none;font-size:var(--jdx-reading-font,14px);line-height:var(--jdx-reading-line,1.8);text-align:start;user-select:text;word-break:normal;overflow-wrap:break-word}
.jdx-reading-block{position:relative;margin:0 auto .8em;max-width:40em;border:0;padding:0;background:transparent;scroll-margin-top:24px}
.jdx-reading-block p{margin:0 0 .8em;line-height:inherit}
.jdx-reading-block>:last-child{margin-bottom:0}
.jdx-reading-block h1,.jdx-reading-block h2,.jdx-reading-block h3,.jdx-reading-block h4{font-size:1.143em;font-weight:600;line-height:1.5;margin:1.5em 0 .7em}
.jdx-reading-block:first-child :is(h1,h2,h3,h4){margin-top:0}
.jdx-reading-block ul,.jdx-reading-block ol{padding-inline-start:1.5em;margin:.6em 0}
.jdx-reading-block pre,.jdx-reading-block table,.jdx-reading-block .katex-display{display:block;max-width:100%;overflow:auto;overscroll-behavior-x:contain}
.jdx-reading-block pre{white-space:pre;font-size:.9em;padding:10px;background:var(--jdx-reader-hover)}
.jdx-reading-block table{border-collapse:collapse;font-size:.9em}
.jdx-reading-block td,.jdx-reading-block th{padding:6px 10px;border-bottom:1px solid var(--jdx-reader-line)}
.jdx-reading-block a{color:inherit;text-decoration:underline;text-underline-offset:3px}
.jdx-translation-reader[data-mode=locate] .jdx-reading-block{cursor:pointer}
.jdx-translation-reader[data-mode=locate] .jdx-reading-block:is(:hover,:focus-visible,[data-active=true]){background:var(--jdx-reader-hover);box-shadow:-3px 0 #16cf8c}
.jdx-reading-gap{font-size:13px;line-height:1.6;color:var(--jdx-reader-muted);padding:12px 0;max-width:40em;margin:0 auto 12px;border-bottom:1px solid var(--jdx-reader-line)}
.jdx-reading-footer{display:flex;align-items:center;gap:6px;min-height:34px;flex:none;padding:3px 12px;border-top:1px solid var(--jdx-reader-line);color:var(--jdx-reader-muted);font-size:12px}
.jdx-reading-state{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.jdx-reading-state[data-error=true]{color:var(--jdx-reader-error)}
.jdx-reading-location{max-width:45%;font-size:12px!important}
@container (max-width:360px){.jdx-reading-body{padding:20px 16px}.jdx-reading-toolbar{padding-inline:8px;gap:0}.jdx-reading-toolbar button,.jdx-reading-popover>summary{padding-inline:6px}}
`

/** 单独阅读偏好不叠加通用字号倍率，非法可选值回退默认。 */
export function translationReadingAppearance(host: ZoteroLike) {
  const number = (key: string, fallback: number, min: number, max: number) => {
    try { const value = Number(host.Prefs?.get(key, true)); return Number.isFinite(value) && value >= min && value <= max ? value : fallback } catch { return fallback }
  }
  return { fontSize: number(FONT, 14, 12, 24), lineHeight: number(LINE, 1.8, 1.4, 2.2) }
}

export function installTranslationReadingStyles(doc: Document) {
  if (doc.getElementById("jdx-translation-reading-css")) return
  const style = element(doc, "style"); style.id = "jdx-translation-reading-css"; style.textContent = CSS
  ;(doc.head || doc.documentElement).append(style)
}

/** 挂载连续译文；dispose 只保存阅读位置与释放 UI，不停止后台任务。 */
export function mountTranslationReader(root: HTMLElement, host: ZoteroLike, taskID: string, options: {
  onReplace?(id: string): void; onHistory?(): void; readerDocument?: Document
} = {}) {
  const doc = root.ownerDocument, win = doc.defaultView, jobs = documentJobs(host)
  installTranslationReadingStyles(doc)
  if (!doc.getElementById('jdx-translation-controls-css')) {
    const link = element(doc, 'link'); link.id = 'jdx-translation-controls-css'; link.rel = 'stylesheet'; link.href = 'chrome://jadense-in-zotero/content/ui.css'
    ;(doc.head || doc.documentElement).append(link)
  }
  root.classList.add("jdx-translation-reader"); root.setAttribute("data-jadense-reader-theme", ""); root.dataset.mode = "read"
  root.setAttribute("aria-label", uiText("全文译文", "Full translation")); root.replaceChildren()
  const stopTheme = observeTheme(host, root)
  const toolbar = element(doc, "div", "jdx-reading-toolbar"), modes = element(doc, "div", "jdx-reading-modes")
  modes.setAttribute("role", "group"); modes.setAttribute("aria-label", uiText("阅读模式", "Reading mode"))
  const body = element(doc, "div", "jdx-reading-body"), footer = element(doc, "footer", "jdx-reading-footer")
  body.tabIndex = 0; body.setAttribute("role", "document")
  const toast = element(doc, "div", "jdx-notice jdx-result-toast"); toast.setAttribute("role", "status")
  let toastTimer: ReturnType<typeof setTimeout> | undefined, previousStatus: string | undefined
  const feedback = (message: string) => { clearTimeout(toastTimer); toast.textContent = message; toastTimer = setTimeout(() => { toast.textContent = "" }, 3500) }
  const state = element(doc, "span", "jdx-reading-state"); state.setAttribute("role", "status")
  const locations = element(doc, "div", "jdx-reading-location"); locations.hidden = true; locations.setAttribute("aria-label", uiText("当前段落原文位置", "Source locations for this paragraph"))
  const locationSelect = createJdxSelect(locations, { compact: true, portal: true, ariaLabel: uiText("原文位置", "Source location"), popupWidth: 180 })
  const progress = element(doc, "div", "jdx-reading-progress"); progress.setAttribute("aria-label", uiText("翻译进度", "Translation progress"))
  progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', '100')
  const progressFill = element(doc, 'span'); progress.append(progressFill)
  let disposed = false, fetching = false, dirty = false, initialized = false, locating = false, activeID = "", lastNotice = ""
  let rows: TranslationReadingRow[] = [], saved: TranslationReadingPosition | null = null
  let documentAssets: Record<string, string> | undefined
  let saveTimer: number | undefined
  const blocks = new Map<string, { node: HTMLElement; gap: HTMLElement; text?: string }>()
  const menus: Array<{ trigger: HTMLButtonElement; content: HTMLElement }> = []
  const closeMenus = () => { for (const menu of menus) { menu.content.hidden = true; menu.trigger.setAttribute('aria-expanded', 'false') } }
  const menu = (label: string, accessible = label) => {
    const details = element(doc, 'div', 'jdx-reading-popover'), content = element(doc, 'div', 'jdx-reading-menu')
    content.hidden = true; content.id = `jdx-reading-menu-${Math.random().toString(36).slice(2)}`; content.setAttribute('role', 'group'); content.setAttribute('aria-label', accessible)
    const trigger = action(doc, label, () => { const open = content.hidden; closeMenus(); content.hidden = !open; trigger.setAttribute('aria-expanded', String(open)) })
    actionIcon(trigger, label === "Aa" ? "type" : label === "⋯" ? "more" : "list", accessible)
    trigger.setAttribute('aria-label', accessible); trigger.title = accessible; trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', content.id)
    details.append(trigger, content); menus.push({ trigger, content })
    return { details, content }
  }
  const setMode = (value: boolean) => {
    value = value && jobs.get(taskID)?.status !== 'running'
    locating = value; root.dataset.mode = value ? "locate" : "read"
    read.setAttribute("aria-pressed", String(!value)); locate.setAttribute("aria-pressed", String(value))
    for (const [id, view] of blocks) view.node.tabIndex = value && id === (activeID || rows.find(row => row.text)?.block.id) ? 0 : -1
    locations.hidden = !value || !activeID
  }
  const read = action(doc, uiText("阅读", "Read"), () => setMode(false))
  const locate = action(doc, uiText("定位", "Locate"), () => setMode(true))
  actionIcon(read, "read"); actionIcon(locate, "locate")
  read.dataset.readingMode = "read"; locate.dataset.readingMode = "locate"; modes.append(read, locate)
  const outline = menu(uiText("目录", "Contents")); outline.details.hidden = true
  const appearance = menu("Aa", uiText("正文排版", "Typography")), more = menu("⋯", uiText("更多", "More"))
  const font = element(doc, 'div'), line = element(doc, 'div')
  const fontSelect = createJdxSelect(font, { compact: true, portal: true, ariaLabel: uiText('字号', 'Font size'), popupWidth: 100 })
  const lineSelect = createJdxSelect(line, { compact: true, portal: true, ariaLabel: uiText('行距', 'Line height'), popupWidth: 100 })
  fontSelect.setOptions(Array.from({ length: 13 }, (_, index) => ({ value: String(index + 12), label: `${index + 12}px` })), '14')
  lineSelect.setOptions([1.4, 1.6, 1.8, 2, 2.2].map(value => ({ value: String(value), label: String(value) })), '1.8')
  const fontLabel = element(doc, "label", "", uiText("字号", "Font size")), lineLabel = element(doc, "label", "", uiText("行距", "Line height"))
  fontLabel.append(font); lineLabel.append(line); appearance.content.append(fontLabel, lineLabel)
  const capture = (): TranslationReadingPosition | null => {
    if (body.scrollTop < 2) return { blockID: "", offset: 0 }
    const view = [...blocks.values()].find(view => !view.node.hidden && view.node.offsetTop + view.node.offsetHeight > body.scrollTop)
    return view ? { blockID: view.node.dataset.readingBlock!, offset: (body.scrollTop - view.node.offsetTop) / Math.max(1, view.node.offsetHeight) } : saved
  }
  const restore = (anchor: TranslationReadingPosition | null) => {
    if (!anchor) return
    if (!anchor.blockID) { body.scrollTop = 0; return }
    const node = blocks.get(anchor.blockID)?.node
    if (node && !node.hidden) body.scrollTop = node.offsetTop + anchor.offset * Math.max(1, node.offsetHeight)
  }
  const applyAppearance = () => {
    const anchor = capture(), value = translationReadingAppearance(host)
    root.style.setProperty("--jdx-reading-font", `${value.fontSize}px`); root.style.setProperty("--jdx-reading-line", String(value.lineHeight))
    fontSelect.setValue(String(value.fontSize)); lineSelect.setValue(String(value.lineHeight)); restore(anchor)
  }
  for (const [select, key] of [[fontSelect, FONT], [lineSelect, LINE]] as const) select.onChange(value => {
    try { host.Prefs?.set?.(key, value, true) } catch { /* 展示偏好保存失败不阻断阅读。 */ }
    const anchor = capture(); root.style.setProperty(key === FONT ? "--jdx-reading-font" : "--jdx-reading-line", key === FONT ? `${value}px` : value); restore(anchor)
  })
  const observers: unknown[] = []
  for (const key of [FONT, LINE]) try { const id = host.Prefs?.registerObserver?.(key, applyAppearance, true); if (id !== undefined) observers.push(id) } catch { /* 当前窗口仍可调整。 */ }
  const notice = (message: string, error = false) => { if (!error) { feedback(message); return }; lastNotice = message; state.textContent = message; state.title = message; state.dataset.error = String(error) }
  const restart = action(doc, uiText("重新翻译", "Translate again"), () => {
    closeMenus(); const task = jobs.get(taskID); if (!task) return
    restart.disabled = true
    void jobs.start("translation", task.source.itemID, true, { extractionID: task.extractionID }).then(next => options.onReplace?.(next.id)).catch(error => notice(String(error), true)).finally(() => { restart.disabled = false })
  })
  const copyAll = action(doc, uiText("复制全文", "Copy all"), () => {
    closeMenus(); void jobs.copy(taskID).then(async text => { if (!await copyTextToClipboard(host, text)) throw new Error(uiText("复制失败", "Copy failed")); notice(uiText("已复制", "Copied")) }).catch(error => notice(String(error), true))
  })
  more.content.append(copyAll)
  if (options.onHistory) more.content.append(action(doc, uiText("翻译历史", "Translation history"), () => { closeMenus(); options.onHistory?.() }))
  more.content.append(restart)
  const diagnostics = element(doc, "p"); diagnostics.style.whiteSpace = "pre-wrap"; more.content.append(diagnostics)
  const pause = action(doc, uiText("暂停", "Pause"), () => { lastNotice = ""; if (jobs.get(taskID)?.status === "running") jobs.pause(taskID); else jobs.resume(taskID) })
  pause.dataset.translationPause = ""; footer.append(state, locations, pause)
  toolbar.append(modes, outline.details, appearance.details, more.details, progress); root.append(toolbar, body, footer, toast)
  const jump = async (id: string, locationIndex = 0) => {
    const row = rows.find(row => row.block.id === id), task = jobs.get(taskID)
    if (!row?.paragraph || !task || task.status === 'running' || row.draft) return
    const sourceLocations = row.paragraph.locations?.length ? row.paragraph.locations : [row.paragraph]
    activeID = id
    const range = sourceLocations.length > 1 ? `${sourceLocations[0].pageIndex + 1}–${sourceLocations.at(-1)!.pageIndex + 1}` : ""
    const locationOptions = sourceLocations.map((source, index) => {
      const label = index === 0 && range ? uiText(`第 ${range} / ${task.totalPages} 页 · 起点`, `Pages ${range} / ${task.totalPages} · start`) : uiText(`第 ${source.pageIndex + 1} / ${task.totalPages} 页`, `Page ${source.pageIndex + 1} / ${task.totalPages}`)
      return { value: String(index), label }
    })
    locationSelect.setOptions(locationOptions, String(locationIndex)); locations.hidden = false
    locations.title = sourceLocations.map(location => location.pageIndex + 1).join("–")
    for (const [key, view] of blocks) { view.node.dataset.active = String(key === id); view.node.tabIndex = key === id ? 0 : -1 }
    try { await navigateDocument(host as unknown as DocumentHost, task.source, sourceLocations[locationIndex] ?? sourceLocations[0], options.readerDocument) } catch (error) { notice(String(error), true) }
  }
  locationSelect.onChange(value => { if (activeID) void jump(activeID, Number(value)) })
  let down: { x: number; y: number } | undefined
  body.addEventListener("pointerdown", event => { down = { x: event.clientX, y: event.clientY } })
  body.addEventListener("click", event => {
    const target = event.target as Element, link = target.closest("a")
    if (link) {
      event.preventDefault(); const url = link.getAttribute("href") || ""
      if (/^https?:\/\//iu.test(url)) (host as ZoteroLike & { launchURL?(url: string): void }).launchURL?.(url)
      return
    }
    if (!locating || doc.getSelection()?.isCollapsed === false || down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return
    const id = target.closest<HTMLElement>("[data-reading-block]")?.dataset.readingBlock
    if (id) void jump(id)
  })
  body.addEventListener("keydown", event => {
    if (!locating || (event.target as Element).closest("a,button,select,input")) return
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || doc.getSelection()?.isCollapsed === false) return
    const id = (event.target as Element).closest<HTMLElement>("[data-reading-block]")?.dataset.readingBlock
    if ((event.key === "Enter" || event.key === " ") && id) { event.preventDefault(); void jump(id); return }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
    const ready = rows.filter(row => row.text); if (!ready.length) return
    event.preventDefault(); const index = ready.findIndex(row => row.block.id === id)
    const next = event.key === "Home" ? 0 : event.key === "End" ? ready.length - 1 : Math.max(0, Math.min(ready.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
    blocks.get(ready[next].block.id)?.node.focus()
  })
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    if (menus.some(menu => !menu.content.hidden)) { const menu = menus.find(menu => !menu.content.hidden); closeMenus(); menu?.trigger.focus(); event.stopPropagation() }
    else if (locating) { setMode(false); read.focus(); event.stopPropagation() }
  }
  root.addEventListener("keydown", onKey)
  const outside = (event: Event) => { if (!toolbar.contains(event.target as Node)) closeMenus() }
  doc.addEventListener("pointerdown", outside)
  const savePosition = () => { saved = capture(); if (saved) void jobs.store.saveReadingPosition(taskID, saved) }
  body.addEventListener("scroll", () => { saved = capture(); if (saveTimer !== undefined) win?.clearTimeout(saveTimer); saveTimer = win?.setTimeout(savePosition, 350) })
  let lastWidth = 0
  let resize: ResizeObserver | undefined
  try { resize = new (win as Window & typeof globalThis).ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width !== lastWidth) { lastWidth = width; restore(saved) } }); resize.observe(body) } catch { /* 宿主不支持时使用滚动事件恢复。 */ }
  const update = async () => {
    dirty = true; if (fetching || disposed) return
    fetching = true
    try {
      do {
        dirty = false; const task = jobs.get(taskID); if (!task) return
        const next = await jobs.reading(taskID)
        documentAssets ??= task.extractionID ? await jobs.store.assets(task.extractionID) : {}
        const assets = documentAssets; if (disposed) return
        const anchor = initialized ? capture() : await jobs.store.readingPosition(taskID)
        if (disposed) return
        // 宿主已呈现题名；版权声明可能排在题名前，只略过原文完全匹配的题名块，结果仍保留。
        rows = next.filter(row => row.paragraph?.text.replace(/\s+/gu, " ").trim().toLowerCase() !== task.source.title.replace(/\s+/gu, " ").trim().toLowerCase())
        const headings = new Map<string, HTMLElement>(); let gap = false
        for (const row of rows) {
          let view = blocks.get(row.block.id)
          if (!view) {
            const node = element(doc, "section", "jdx-reading-block"), missing = element(doc, "p", "jdx-reading-gap")
            node.dataset.readingBlock = row.block.id; node.tabIndex = -1; body.append(missing, node)
            view = { node, gap: missing }; blocks.set(row.block.id, view)
          }
          view.node.hidden = !row.text
          view.gap.hidden = row.draft ? false : Boolean(row.text) || gap
          if (row.draft) view.gap.textContent = uiText('未完成译文草稿', 'Incomplete translation draft')
          if (!row.text && !gap) view.gap.textContent = row.missing ? uiText("此处文字未能可靠提取，请在 PDF 中核对。", "Text could not be reliably extracted here. Check the PDF.")
            : task.status === "running" ? uiText("正在翻译后续内容…", "Translating the next passage…") : uiText("此处译文尚未完成。继续翻译后会在原位补齐。", "Translation is incomplete here. Resume to fill this passage.")
          gap = !row.text
          if (row.text && view.text !== row.text) {
            const visibleText = row.draft ? row.text.replace(/⟦F\d*$/u, '') : row.text
            updateChatMarkdown(view.node, row.paragraph?.heading && !/^#/u.test(visibleText) ? `## ${visibleText}` : visibleText, assets); view.text = row.text
            // 仅替换存储在本机来源中的公式；模型不能指定 URL 或注入 HTML。
            const formulas = row.paragraph?.formulas ?? {}
            const walker = doc.createTreeWalker(view.node, 4), textNodes: Text[] = []
            while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
            for (const node of textNodes) {
              const parts = node.data.split(/(⟦F\d+⟧)/u)
              if (parts.length < 2) continue
              const fragment = doc.createDocumentFragment()
              for (const part of parts) {
                const source = formulas[part]
                if (source && /^data:image\/png;base64,[a-z\d+/]+=*$/iu.test(source)) {
                  const image = element(doc, 'img'); image.src = source; image.alt = uiText('原文公式', 'Source formula'); image.style.maxWidth = '100%'; image.style.verticalAlign = 'middle'; fragment.append(image)
                } else fragment.append(doc.createTextNode(part))
              }
              node.replaceWith(fragment)
            }
          }
          view.node.dataset.draft = String(Boolean(row.draft))
          view.node.setAttribute('aria-label', row.draft ? uiText('未完成译文草稿', 'Incomplete translation draft') : uiText('译文', 'Translation'))
          if (row.text) for (const [index, heading] of Array.from(view.node.querySelectorAll<HTMLElement>('h1,h2,h3')).entries()) headings.set(`${row.block.id}-heading-${index}`, heading)
        }
        const headingSignature = [...headings].map(([id, node]) => `${id}:${node.textContent}`).join('|')
        if (outline.content.dataset.headings !== headingSignature) {
          outline.content.replaceChildren(...[...headings].map(([, node]) => action(doc, node.textContent || '', () => { closeMenus(); node.scrollIntoView({ block: 'start' }) })))
          outline.content.dataset.headings = headingSignature; outline.details.hidden = !headings.size
        }
        const percent = task.total ? Math.floor(task.completed / task.total * 100) : 0
        const status = { running: uiText(`已翻译 ${percent}%`, `${percent}% translated`), paused: uiText(`已暂停 · ${percent}%`, `Paused · ${percent}%`), complete: "", partial: uiText(`部分完成 · ${percent}%`, `Partial · ${percent}%`), error: uiText(`翻译中断 · ${percent}%`, `Interrupted · ${percent}%`) }[task.status]
        if (previousStatus && previousStatus !== "complete" && task.status === "complete") feedback(uiText("翻译完成", "Translation complete"))
        previousStatus = task.status
        const layoutWarnings = [...new Set(rows.map(row => row.page?.layoutWarning).filter(Boolean))]
        state.textContent = task.storageWarning ? uiText("译文未完整保存，请及时复制", "Not fully saved; copy your translation") : task.error || lastNotice || (task.status === 'running' ? jobs.translationPhase(taskID) : '') || status + (layoutWarnings.length ? uiText(" · 需核对版式", " · check source layout") : "")
        state.title = state.textContent; state.dataset.error = String(Boolean(task.error || task.storageWarning))
        if (task.storageWarning && copyAll.parentElement !== footer) footer.append(copyAll)
        else if (!task.storageWarning && copyAll.parentElement !== more.content) more.content.prepend(copyAll)
        diagnostics.textContent = [task.error, ...task.warnings, ...layoutWarnings].filter(Boolean).join("\n"); diagnostics.hidden = !diagnostics.textContent
        progressFill.style.width = `${percent}%`; progress.setAttribute('aria-valuenow', String(percent)); progress.setAttribute('aria-valuetext', `${task.completed} / ${task.total}`); progress.hidden = task.status === 'complete'
        progress.dataset.state = task.status; footer.dataset.state = task.error || task.storageWarning ? 'error' : task.status
        pause.hidden = task.status === "complete" || task.status === "partial" && task.completed === task.total; pause.textContent = task.status === "running" ? uiText("暂停", "Pause") : uiText("继续", "Continue")
        actionIcon(pause, task.status === "running" ? "pause" : "play")
        restart.disabled = task.status === "running"
        locate.disabled = task.status === 'running'
        locate.title = task.status === 'running' ? uiText('生成期间暂不支持定位', 'Location is unavailable while generating') : uiText('定位', 'Locate')
        if ((task.extractionVersion ?? 0) < 5) pause.hidden = true
        setMode(locating); restore(anchor); saved = capture(); initialized = true
      } while (dirty && !disposed)
    } catch (error) { if (!disposed) notice(String(error), true) } finally { fetching = false }
  }
  setMode(false); applyAppearance()
  const stop = jobs.subscribe(() => { void update() }); void jobs.ready.then(update)
  return () => {
    locationSelect.destroy(); fontSelect.destroy(); lineSelect.destroy()
    if (disposed) return
    disposed = true; clearTimeout(toastTimer); stop()
    try { savePosition() } catch { /* 窗口已销毁时保留最后一次正常滚动锚点。 */ }
    for (const id of observers) host.Prefs?.unregisterObserver?.(id)
    stopTheme(); resize?.disconnect()
    if (saveTimer !== undefined) win?.clearTimeout(saveTimer)
    doc.removeEventListener("pointerdown", outside); root.removeEventListener("keydown", onKey)
  }
}
