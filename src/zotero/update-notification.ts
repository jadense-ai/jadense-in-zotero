/** 工作台和 Reader 的可选更新提示；共享宿主状态去重，任何失败均不阻塞阅读。 */
import { checkLatestRelease, compareGeckoVersions, installedPluginVersion, openHelpLink } from './manager-help'
import { observeTheme, uiText, type UiPreferenceHost } from './ui-preferences'

type Release = Awaited<ReturnType<typeof checkLatestRelease>>
type UpdateHost = UiPreferenceHost & {
  launchURL?: (url: string) => void
  __jadenseReleaseCheck?: { pending?: Promise<void>; result?: Release; nextCheck: number; shown: Set<string> }
}
const waitingDocuments = new WeakMap<Document, () => void>()

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

/** 独立 HTML dialog，继承插件主题，原生管理焦点、Escape 和模态层。 */
export function showUpdateDialog(document: Document, host: UpdateHost, release: Release) {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    node.textContent = text
    return node
  }
  const dialog = element('dialog')
  dialog.id = 'jadense-update-dialog'
  dialog.setAttribute('aria-labelledby', 'jadense-update-title')
  dialog.setAttribute('aria-describedby', 'jadense-update-description')
  // Reader 全局 margin:0 会覆盖 dialog 原生居中，必须在自有容器恢复自动外边距。
  const style = element('style', `
    #jadense-update-dialog { box-sizing:border-box; margin:auto; color:light-dark(#111510,#f1f5ef); background:light-dark(#fff,#111611); border:1px solid #80808030; border-radius:16px; padding:28px; width:min(460px,calc(100vw - 32px)); max-height:calc(100vh - 32px); overflow:auto; box-shadow:0 20px 64px #0003; font:14px/1.65 system-ui; }
    #jadense-update-dialog::backdrop { background:#0005; }
    #jadense-update-dialog .eyebrow { color:light-dark(#08784f,#16d78f); font-size:12px; font-weight:600; margin:0 0 8px; }
    #jadense-update-dialog h2 { font-size:22px; line-height:1.35; margin:0 0 12px; }
    #jadense-update-dialog p { margin:0 0 16px; }
    #jadense-update-dialog .versions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; background:light-dark(#f2f5ef,#1a241d); border-radius:8px; padding:14px 16px; margin:20px 0; }
    #jadense-update-dialog .versions span { overflow-wrap:anywhere; }
    #jadense-update-dialog footer { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:8px; }
    #jadense-update-dialog button { appearance:none; box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; height:auto; min-height:36px; margin:0; padding:8px 14px; border:1px solid #80808040; border-radius:8px; color:inherit; background:transparent; font:inherit; line-height:1.4; cursor:pointer; }
    #jadense-update-dialog button.primary { background:#16d78f; color:#111510; border-color:transparent; font-weight:600; }
    #jadense-update-dialog button:hover { filter:brightness(.94); }
    #jadense-update-dialog button:focus-visible { outline:2px solid #16d78f; outline-offset:3px; }
    #jadense-update-dialog [role=status]:empty { display:none; }
  `)
  const eyebrow = element('p', 'Jadense in Zotero'); eyebrow.className = 'eyebrow'
  const title = element('h2', uiText('新版本已就绪', 'A new version is ready')); title.id = 'jadense-update-title'
  const description = element('p', uiText('发现新的正式版本。前往 GitHub 查看更新内容并下载升级。', 'A new stable release is available. Visit GitHub to see what’s new and download the update.')); description.id = 'jadense-update-description'
  const versions = element('div'); versions.className = 'versions'
  versions.append(element('span', uiText(`当前 ${release.current}`, `Current ${release.current}`)), element('span', '→'), element('strong', `v${release.latest}`))
  const status = element('p'); status.setAttribute('role', 'status')
  const actions = element('footer')
  const later = element('button', uiText('稍后再说', 'Not now')); later.type = 'button'; later.autofocus = true
  later.addEventListener('click', () => dialog.close())
  const upgrade = element('button', uiText('前往升级 ↗', 'Get the update ↗')); upgrade.type = 'button'; upgrade.className = 'primary'
  upgrade.addEventListener('click', () => {
    try { openHelpLink(host, release.url); dialog.close() }
    catch { status.textContent = uiText('无法打开浏览器，请重试。', 'Could not open your browser. Please retry.') }
  })
  actions.append(later, upgrade)
  dialog.append(style, eyebrow, title, description, versions, status, actions)
  let stopTheme: (() => void) | undefined
  const cleanup = () => { stopTheme?.(); dialog.remove(); document.defaultView?.removeEventListener('unload', cleanup) }
  dialog.addEventListener('close', cleanup, { once: true })
  document.defaultView?.addEventListener('unload', cleanup, { once: true })
  try {
    document.documentElement.append(dialog)
    stopTheme = observeTheme(host, dialog)
    dialog.showModal()
    return true
  } catch { cleanup(); return false }
}
