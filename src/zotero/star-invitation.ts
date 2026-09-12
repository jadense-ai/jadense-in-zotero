/** 本地功能成功计数与 GitHub Star 邀请；不读取身份、凭证或访问服务端。 */
import type { ZoteroLike } from './runtime'
import { shouldShowManagerQuickStart } from './manager-quick-start'
import { openHelpLink, REPOSITORY_URL } from './manager-help'
import { observeTheme, uiText } from './ui-preferences'

export const STAR_INVITATION_PREF = 'extensions.jadenseInZotero.starInvitation'
const DAY = 24 * 60 * 60 * 1000
type State = { uses: number; lastPrompt: number; outcome: 'unknown' | 'later' | 'likely' | 'confirmed' }

/** 仅选取本模块字段；偏好损坏或不可用时不打扰用户。 */
export function readStarInvitation(host: ZoteroLike): State | null {
  try {
    if (!host.Prefs) return null
    const raw = host.Prefs.get(STAR_INVITATION_PREF, true)
    const value = raw ? JSON.parse(String(raw)) : {}
    return {
      uses: Number.isSafeInteger(value.uses) && value.uses >= 0 ? value.uses : 0,
      lastPrompt: Number.isFinite(value.lastPrompt) && value.lastPrompt >= 0 ? value.lastPrompt : 0,
      outcome: ['later', 'likely', 'confirmed'].includes(value.outcome) ? value.outcome : 'unknown',
    }
  } catch { return null }
}

/** 至少五次成功；再次邀请需同时满 24 小时并跨本地日历日，时钟回拨不会提前。 */
export function starInvitationDue(state: State | null, now = Date.now()) {
  return !!state && state.uses >= 5 && !['likely', 'confirmed'].includes(state.outcome)
    && (!state.lastPrompt || (now - state.lastPrompt >= DAY && new Date(now).toDateString() !== new Date(state.lastPrompt).toDateString()))
}

function save(host: ZoteroLike, state: State) {
  try {
    if (!host.Prefs) return false
    host.Prefs.set(STAR_INVITATION_PREF, JSON.stringify(state), true)
    return true
  } catch { return false }
}

/** 成功调用点每次只计一次；计数与展示的任何异常均不改变业务结果。 */
export function recordStarInvitationUse(host: ZoteroLike) {
  try {
    const state = readStarInvitation(host)
    if (!state || ['likely', 'confirmed'].includes(state.outcome)) return
    if (!save(host, { ...state, uses: Math.min(state.uses + 1, Number.MAX_SAFE_INTEGER) })) return
    const win = host.getMainWindow?.()
    win?.setTimeout(() => showStarInvitation(win.document, host), 0)
  } catch { /* 可选邀请不影响功能。 */ }
}

/** HTML dialog 同时用于原生主窗口和 Manager；保留原生焦点管理及 Escape。 */
export function showStarInvitation(document: Document, host: ZoteroLike) {
  let dialog: HTMLDialogElement | undefined
  let stopTheme: (() => void) | undefined
  try {
    const state = readStarInvitation(host)
    if (!starInvitationDue(state) || (document.getElementById('jadense-quick-start-dialog') && shouldShowManagerQuickStart(host)) || !document.hasFocus()
      || document.querySelector('dialog[open], [role="dialog"]:not([hidden])')) return
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
      const node = document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
      node.textContent = text
      return node
    }
    dialog = element('dialog')
    dialog.id = 'jadense-star-invitation'
    dialog.setAttribute('aria-labelledby', 'jadense-star-title')
    dialog.setAttribute('aria-describedby', 'jadense-star-description')
    const style = element('style', `
      #jadense-star-invitation { color-scheme: light dark; color: light-dark(#111510,#f1f5ef); background: light-dark(#fff,#111611); border: 1px solid #80808040; border-radius: 12px; padding: 24px; width: min(440px,calc(100vw - 64px)); max-height: calc(100vh - 64px); overflow: auto; font: 14px/1.7 system-ui; }
      #jadense-star-invitation::backdrop { background: #0005; }
      #jadense-star-invitation h2 { font-size: 20px; margin: 0 0 12px; }
      #jadense-star-invitation footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
      #jadense-star-invitation button { font: inherit; padding: 7px 12px; border: 1px solid #80808060; border-radius: 6px; cursor: pointer; }
      #jadense-star-invitation button:first-child { background: #16D78F; color: #111510; }
    `)
    const title = element('h2', uiText('喜欢攻玉的话，送我们一颗 Star 吧', 'Enjoying Jadense? Give us a Star'))
    title.id = 'jadense-star-title'
    const description = element('p', uiText('攻玉已经陪你完成了几次工作，希望帮你省下了一些时间。如果用着顺手，愿意去 GitHub 点一颗 Star 吗？这份小小的支持，会给我们继续打磨插件很大的动力。谢谢你！', 'We hope Jadense has saved you some time. If it has been helpful, would you give us a Star on GitHub? Your support means a lot and encourages us to keep improving. Thank you!'))
    description.id = 'jadense-star-description'
    const status = element('p')
    status.setAttribute('role', 'status')
    const actions = element('footer')
    const finish = (outcome: State['outcome']) => {
      const current = readStarInvitation(host)
      if (current) save(host, { ...current, outcome })
      dialog?.close()
    }
    const visit = element('button', uiText('去 GitHub 点 Star', 'Star on GitHub'))
    visit.addEventListener('click', () => {
      try {
        openHelpLink(host as ZoteroLike & { launchURL?: (url: string) => void }, REPOSITORY_URL)
        // ponytail: 浏览器打开成功仅代表疑似 Star；没有 GitHub 身份时不声称远程核验。
        finish('likely')
      } catch { status.textContent = uiText('暂时无法打开浏览器，请稍后再试。', 'Could not open your browser. Please try again later.') }
    })
    const confirmed = element('button', uiText('已经 Star 啦', 'Already starred'))
    confirmed.addEventListener('click', () => finish('confirmed'))
    const later = element('button', uiText('稍后再说', 'Maybe later'))
    later.autofocus = true
    later.addEventListener('click', () => finish('later'))
    actions.append(visit, confirmed, later)
    dialog.append(style, title, description, status, actions)
    dialog.addEventListener('close', () => { stopTheme?.(); dialog?.remove() }, { once: true })
    document.documentElement.append(dialog)
    // 先保存展示时间以跨窗口去重；存储失败只跳过邀请。
    if (!save(host, { ...state!, lastPrompt: Date.now(), outcome: 'later' })) { dialog.remove(); return }
    stopTheme = observeTheme(host, dialog)
    dialog.showModal()
  } catch { stopTheme?.(); dialog?.remove() }
}

/** Manager 活跃时接收成功计数；切回窗口可展示积累的邀请，不启动轮询。 */
export function wireStarInvitation(document: Document, host: ZoteroLike | null) {
  if (!host) return
  const win = document.defaultView
  const check = () => { win?.setTimeout(() => showStarInvitation(document, host), 0) }
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(STAR_INVITATION_PREF, check, true) } catch { /* 仍可在聚焦时检查。 */ }
  win?.addEventListener('focus', check)
  win?.addEventListener('unload', () => {
    win.removeEventListener('focus', check)
    try { if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer) } catch { /* 关闭无需阻塞。 */ }
  }, { once: true })
  check()
}
