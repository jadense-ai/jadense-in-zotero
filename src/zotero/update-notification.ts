/** 工作台和 Reader 的可选更新提示；共享宿主状态去重，任何失败均不阻塞阅读。 */
import { createJadenseBrandIcon } from './jadense-brand'
import { checkLatestRelease, compareGeckoVersions, installedPluginVersion, openHelpLink, visibleReleaseNotes } from './manager-help'
import { getUiLocale, observeTheme, uiText, type UiPreferenceHost } from './ui-preferences'
import { channelOpenedMessage, createDownloadChannelsPanel, UPDATE_CHANNELS_STYLES } from './update-channels'

type Release = Awaited<ReturnType<typeof checkLatestRelease>>
type UpdateHost = UiPreferenceHost & {
  launchURL?: (url: string) => void
  __jadenseReleaseCheck?: { pending?: Promise<void>; result?: Release; nextCheck: number; shown: Set<string> }
}
const waitingDocuments = new WeakMap<Document, () => void>()
const HTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** 多窗口共用请求和已提醒版本；成功缓存半小时，失败一分钟后允许重试。 */
export async function silentlyCheckForUpdates(document: Document, host: UpdateHost, pluginID: string) {
  try {
    const win = document.defaultView
    if (!win) return
    const state = host.__jadenseReleaseCheck ??= { nextCheck: 0, shown: new Set() }
    if (!state.pending && Date.now() >= state.nextCheck) {
      state.nextCheck = Date.now() + 60_000
      state.pending = (async () => {
        const platform = host.getMainWindow?.() ?? win
        const gecko = platform as unknown as Parameters<typeof installedPluginVersion>[1]
        const current = await installedPluginVersion(pluginID, gecko)
        state.result = await checkLatestRelease(current, (a, b) => compareGeckoVersions(a, b, gecko), platform.fetch.bind(platform))
        state.nextCheck = Date.now() + 30 * 60_000
      })().catch(() => { /* 离线、限流、版本缺失保持静默。 */ }).finally(() => { state.pending = undefined })
    }
    await state.pending
    waitingDocuments.get(document)?.()
    const result = state.result
    if (!result || result.state !== 'available' || state.shown.has(result.latest) || win.closed) return
    const show = () => {
      if (state.shown.has(result.latest)) { cleanup(); return }
      if (!document.hasFocus() || document.querySelector('dialog[open], [role="dialog"]:not([hidden])')) return
      if (showUpdateDialog(document, host, result)) { state.shown.add(result.latest); cleanup() }
    }
    const cleanup = () => {
      win.removeEventListener('focus', show)
      document.removeEventListener('close', show, true)
      win.removeEventListener('unload', cleanup)
      waitingDocuments.delete(document)
    }
    waitingDocuments.set(document, cleanup)
    win.addEventListener('focus', show)
    document.addEventListener('close', show, true)
    win.addEventListener('unload', cleanup, { once: true })
    show()
  } catch { /* 可选展示不能成为工作台或 Reader 的入口条件。 */ }
}

function createArrowRightIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.65')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const line = doc.createElementNS(SVG_NS, 'path')
  line.setAttribute('d', 'M3.2 8h9.4')
  const head = doc.createElementNS(SVG_NS, 'path')
  head.setAttribute('d', 'M9.1 4.5 12.6 8l-3.5 3.5')
  svg.append(line, head)
  return svg
}

function createCloseIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '15')
  svg.setAttribute('height', '15')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.65')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = doc.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8')
  svg.append(path)
  return svg
}

/** 独立 HTML dialog，继承插件主题，原生管理焦点、Escape 和模态层，并提供三大下载渠道。 */
export function showUpdateDialog(document: Document, host: UpdateHost, release: Release) {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = document.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K]
    if (text) node.textContent = text
    return node
  }
  const dialog = element('dialog')
  dialog.id = 'jadense-update-dialog'
  dialog.setAttribute('aria-labelledby', 'jadense-update-title')
  dialog.setAttribute('aria-describedby', 'jadense-update-description')
  // Reader 全局 margin:0 会覆盖 dialog 原生居中，必须在自有容器恢复自动外边距与内部间距。
  const style = element('style', `
    @keyframes jdx-update-enter {
      from { opacity: 0; transform: translateY(6px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    #jadense-update-dialog {
      box-sizing: border-box;
      margin: auto;
      color: light-dark(#111510, #edf2ee);
      background: light-dark(#ffffff, #1d2420);
      border: 1px solid light-dark(#d6e0da, #313e37);
      border-radius: 14px;
      padding: 24px;
      width: min(504px, calc(100vw - 32px));
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px);
      overflow: auto;
      box-shadow: 0 22px 58px rgb(0 0 0 / 0.22);
      font: 13.5px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      scrollbar-width: thin;
      scrollbar-color: light-dark(#c6d3cc transparent, #3a4941 transparent);
    }
    #jadense-update-dialog[open] {
      animation: jdx-update-enter 180ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    @media (prefers-reduced-motion: reduce) {
      #jadense-update-dialog[open] { animation: none; }
    }
    #jadense-update-dialog * { box-sizing: border-box; }
    #jadense-update-dialog ::selection { background: rgb(22 207 140 / 0.24); }
    #jadense-update-dialog::backdrop { background: rgb(9 14 11 / 0.44); backdrop-filter: blur(2px); }
    #jadense-update-dialog .jdx-update-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin: 0 0 16px;
    }
    #jadense-update-dialog .jdx-update-brand-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      min-width: 0;
    }
    #jadense-update-dialog .jdx-update-logo {
      flex: none;
      width: 38px;
      height: 38px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: light-dark(#f2f7f4, #24302a);
      border: 1px solid light-dark(#dce8e1, #32433a);
    }
    #jadense-update-dialog .jdx-update-heading-group {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    #jadense-update-dialog h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
      line-height: 1.3;
      letter-spacing: -0.015em;
    }
    #jadense-update-dialog .versions {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      flex-wrap: wrap;
      margin: 0;
      font-size: 12.5px;
      line-height: 1.4;
      font-variant-numeric: tabular-nums;
      color: light-dark(#4e5e56, #9ab0a4);
    }
    #jadense-update-dialog .versions .version-current { overflow-wrap: anywhere; }
    #jadense-update-dialog .versions .version-arrow {
      display: inline-flex;
      color: light-dark(#7d9086, #6e8579);
    }
    #jadense-update-dialog .versions .version-latest {
      display: inline-flex;
      align-items: center;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 650;
      background: light-dark(#e3f8ee, #153627);
      color: light-dark(#086241, #76efc0);
      overflow-wrap: anywhere;
    }
    #jadense-update-dialog .jdx-update-close {
      appearance: none;
      flex: none;
      width: 28px;
      height: 28px;
      margin: -2px -4px 0 0;
      padding: 0;
      border: 0;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: light-dark(#56665d, #93a79c);
      background: transparent;
      cursor: pointer;
      transition: background-color 140ms ease, color 140ms ease;
    }
    #jadense-update-dialog .jdx-update-close:hover {
      background: light-dark(#edf2ef, #2a342e);
      color: inherit;
    }
    #jadense-update-dialog .jdx-update-close:focus-visible {
      outline: 2px solid #16cf8c;
      outline-offset: 2px;
    }
    #jadense-update-dialog .notes {
      margin: 0 0 16px;
      padding: 12px 14px;
      background: light-dark(#f4f7f5, #232c27);
      border: 1px solid light-dark(#e2eae5, #2f3b34);
      border-radius: 10px;
      max-height: min(28vh, 200px);
      overflow: auto;
      overflow-wrap: anywhere;
      scrollbar-width: thin;
      scrollbar-color: light-dark(#c6d3cc transparent, #3a4941 transparent);
    }
    #jadense-update-dialog .notes h3 {
      margin: 0 0 6px;
      font-size: 12.5px;
      font-weight: 600;
      color: light-dark(#3b4a42, #b4c7bd);
    }
    #jadense-update-dialog .notes ul {
      margin: 0;
      padding-inline-start: 18px;
      font-size: 13px;
      line-height: 1.55;
    }
    #jadense-update-dialog .notes li + li { margin-top: 5px; }
    #jadense-update-dialog .notes li::marker { color: light-dark(#0f7c56, #4fe3ab); }
    #jadense-update-dialog .jdx-update-status {
      margin: 12px 0 0;
      padding: 9px 11px;
      border-radius: 8px;
      font-size: 12.5px;
      line-height: 1.5;
      border: 1px solid light-dark(#cfe4d8, #284738);
      background: light-dark(#f2faf6, #162b21);
      color: light-dark(#0d5c3e, #9de9c8);
    }
    #jadense-update-dialog .jdx-update-status[data-kind="error"] {
      border-color: light-dark(#f0c7c3, #5c2a26);
      background: light-dark(#fdf3f2, #321b19);
      color: light-dark(#9f2218, #f7a79f);
    }
    #jadense-update-dialog .jdx-update-status:empty { display: none; }
    #jadense-update-dialog footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px 12px;
      margin: 18px 0 0;
      padding: 14px 0 0;
      border-top: 1px solid light-dark(#e6ede9, #2c3731);
    }
    #jadense-update-dialog .jdx-update-install-note {
      margin: 0;
      font-size: 12px;
      line-height: 1.5;
      color: light-dark(#56665d, #93a79c);
      flex: 1 1 200px;
      min-width: 0;
    }
    #jadense-update-dialog footer button {
      appearance: none;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: auto;
      min-height: 34px;
      margin: 0;
      padding: 6px 14px;
      border: 1px solid light-dark(#c6d3cc, #3d4d45);
      border-radius: 8px;
      color: inherit;
      background: transparent;
      font: 500 13px/1.4 system-ui, -apple-system, sans-serif;
      cursor: pointer;
      transition: background-color 140ms ease, border-color 140ms ease;
    }
    #jadense-update-dialog footer button:hover {
      background: light-dark(#eef3f0, #2a342e);
      border-color: light-dark(#9ab0a5, #576a60);
    }
    #jadense-update-dialog footer button:focus-visible {
      outline: 2px solid #16cf8c;
      outline-offset: 2px;
    }
    @media (max-width: 440px) {
      #jadense-update-dialog { padding: 18px; }
      #jadense-update-dialog footer { justify-content: flex-end; }
    }
    ${UPDATE_CHANNELS_STYLES}
  `)

  const header = element('header')
  header.className = 'jdx-update-header'

  const brandRow = element('div')
  brandRow.className = 'jdx-update-brand-row'

  const logoWrap = element('span')
  logoWrap.className = 'jdx-update-logo'
  logoWrap.append(createJadenseBrandIcon(document, { size: 24 }))

  const headingGroup = element('div')
  headingGroup.className = 'jdx-update-heading-group'
  const title = element('h2', uiText('Jadense in Zotero 有新版本', 'New version of Jadense in Zotero'))
  title.id = 'jadense-update-title'

  const versions = element('p')
  versions.id = 'jadense-update-description'
  versions.className = 'versions'
  const currentSpan = element('span', uiText(`当前 ${release.current}`, `Current ${release.current}`))
  currentSpan.className = 'version-current'
  const arrowSpan = element('span')
  arrowSpan.className = 'version-arrow'
  arrowSpan.append(createArrowRightIcon(document))
  const latestStrong = element('strong', `v${release.latest}`)
  latestStrong.className = 'version-latest'
  versions.append(currentSpan, arrowSpan, latestStrong)

  headingGroup.append(title, versions)
  brandRow.append(logoWrap, headingGroup)

  const closeIconBtn = element('button')
  closeIconBtn.type = 'button'
  closeIconBtn.className = 'jdx-update-close'
  closeIconBtn.setAttribute('aria-label', uiText('关闭', 'Close'))
  closeIconBtn.title = uiText('关闭', 'Close')
  closeIconBtn.append(createCloseIcon(document))
  closeIconBtn.addEventListener('click', () => dialog.close())

  header.append(brandRow, closeIconBtn)

  const visible = visibleReleaseNotes(release.notes)
  const notes = element('section')
  notes.className = 'notes'
  if (visible.items.length) {
    notes.append(element('h3', uiText('本次更新', 'What’s new') + (getUiLocale() === 'en-US' && visible.language === 'zh-CN' ? ' (中文)' : '')))
    const list = element('ul')
    for (const item of visible.items) list.append(element('li', item))
    notes.append(list)
  }

  const status = element('p')
  status.className = 'jdx-update-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  const channelsPanel = createDownloadChannelsPanel(document, {
    version: release.latest,
    githubUrl: release.url,
    onOpen: channel => {
      try {
        openHelpLink(host, channel.url)
        status.dataset.kind = 'info'
        status.textContent = channelOpenedMessage(channel)
      } catch {
        status.dataset.kind = 'error'
        status.textContent = uiText('无法打开默认浏览器，请重试。', 'Could not open your browser. Please retry.')
      }
    },
    onCopyPasscode: (channel, copied) => {
      status.dataset.kind = copied ? 'info' : 'error'
      status.textContent = copied
        ? uiText(`已复制${channel.name}提取码：${channel.passcode}`, `Copied ${channel.name} code: ${channel.passcode}`)
        : uiText(`未能写入剪贴板，请手动输入提取码：${channel.passcode}`, `Could not copy automatically. Code: ${channel.passcode}`)
    },
  })

  const actions = element('footer')
  const installNote = element('p', uiText('下载 .xpi 后在 Zotero「工具 → 插件」中覆盖安装', 'Install the .xpi via Zotero Tools → Add-ons'))
  installNote.className = 'jdx-update-install-note'
  const later = element('button', uiText('稍后再说', 'Not now'))
  later.type = 'button'
  later.autofocus = true
  later.addEventListener('click', () => dialog.close())
  actions.append(installNote, later)

  dialog.append(style, header)
  if (visible.items.length) dialog.append(notes)
  dialog.append(channelsPanel.element, status, actions)

  let stopTheme: (() => void) | undefined
  const cleanup = () => {
    channelsPanel.cleanup()
    stopTheme?.()
    dialog.remove()
    document.defaultView?.removeEventListener('unload', cleanup)
  }
  dialog.addEventListener('close', cleanup, { once: true })
  document.defaultView?.addEventListener('unload', cleanup, { once: true })
  try {
    document.documentElement.append(dialog)
    stopTheme = observeTheme(host, dialog)
    dialog.showModal()
    // 矮窗下避免因底部按钮 autofocus 将标题滚出可视区。
    dialog.scrollTop = 0
    return true
  } catch { cleanup(); return false }
}
