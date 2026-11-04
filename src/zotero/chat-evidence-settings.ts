/** 溯源开关只影响后续发送；与正文准备隔离，偏好不可用不阻断普通对话。 */
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

export const CHAT_EVIDENCE_PREF_KEY = 'extensions.jadenseInZotero.chatEvidenceEnabled'
export function readChatEvidenceEnabled(host: ZoteroLike) {
  try { return host.Prefs?.get(CHAT_EVIDENCE_PREF_KEY) === true } catch { return false }
}

/** 两个宿主复用相同开关；观察者只同步显示，不停止正在生成的回复。 */
export function bindChatEvidenceToggle(root: HTMLElement, host: ZoteroLike) {
  const button = root.querySelector<HTMLButtonElement>('[data-chat-evidence-toggle]')
  if (!button) return () => {}
  const update = () => {
    const enabled = readChatEvidenceEnabled(host)
    button.setAttribute('aria-pressed', String(enabled))
    button.title = enabled
      ? uiText('证据溯源已开启 · 后续回答附原文引用，点击定位 PDF 文段', 'Evidence tracing is on · Future answers cite passages you can open in the PDF')
      : uiText('开启证据溯源 · 为关联 PDF 的关键论断附原文引用', 'Enable evidence tracing · Cite original passages for claims about linked PDFs')
  }
  const toggle = () => {
    try { host.Prefs?.set(CHAT_EVIDENCE_PREF_KEY, !readChatEvidenceEnabled(host)) }
    catch { button.title = uiText('暂时无法保存证据溯源设置，请重试。', 'Could not save evidence tracing. Try again.'); return }
    update()
  }
  button.addEventListener('click', toggle)
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(CHAT_EVIDENCE_PREF_KEY, update) } catch { /* 当前开关仍可操作。 */ }
  update()
  return () => {
    button.removeEventListener('click', toggle)
    try { if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer) } catch { /* 宿主已关闭。 */ }
  }
}
