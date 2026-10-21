/** 选文译文的独立阅读字号：复用浮窗外观菜单，仅缩放译文，偏好故障不影响阅读或翻译。 */
import { uiText, type UiPreferenceHost } from './ui-preferences'

const FONT_PREF = 'extensions.jadenseInZotero.selectionTranslationFontScale'
let controlSequence = 0

/** 展示输入只做归一化；无效或未来格式回到默认，越界值收敛到可读范围。 */
function normalizeSize(value: unknown): number {
  const number = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN
  return Number.isFinite(number) ? Math.min(200, Math.max(80, Math.round(number / 10) * 10)) : 100
}

/** 调整继承字号而不重建 Markdown，保留原生文本选择；返回 Reader 卸载时的监听清理函数。 */
export function selectionTranslationAppearance(host: UiPreferenceHost, doc: Document, result: HTMLElement) {
  const element = doc.createElement('div'), label = doc.createElement('label'), size = doc.createElement('input')
  const value = doc.createElement('output'), reset = doc.createElement('button'), status = doc.createElement('p')
  label.textContent = uiText('译文字号', 'Translation text size')
  size.type = 'range'; size.min = '80'; size.max = '200'; size.step = '10'
  size.id = `jdx-selection-translation-font-${++controlSequence}`
  size.setAttribute('data-jdx-selection-translation-font-size', '')
  size.setAttribute('aria-label', uiText('译文字号', 'Translation text size'))
  value.setAttribute('for', size.id)
  reset.type = 'button'; reset.textContent = uiText('恢复默认', 'Reset')
  reset.setAttribute('data-jdx-selection-translation-font-reset', '')
  status.setAttribute('role', 'status'); status.setAttribute('data-jdx-selection-translation-font-status', '')
  status.className = 'jadense-translation-language-hint'; status.hidden = true
  label.append(value, size); element.append(label, reset, status)
  let current = 100
  const apply = (next: number) => {
    current = next; size.value = String(next); value.textContent = `${next}%`
    size.setAttribute('aria-valuetext', `${next}%`); reset.disabled = next === 100
    // 外层已提供全局字号；百分比仅额外作用于译文，不改变原文、标签或工具栏。
    result.style.fontSize = `${next}%`
  }
  const refresh = () => {
    try { apply(normalizeSize(host.Prefs?.get(FONT_PREF, true))) } catch { apply(current) }
  }
  const change = (next: unknown) => {
    const normalized = normalizeSize(next)
    let saved = false
    try {
      if (host.Prefs?.set) { host.Prefs.set(FONT_PREF, String(normalized), true); saved = true }
    } catch { /* 本次字号仍立即生效；可选偏好保存不阻断译文、复制或后续请求。 */ }
    apply(normalized)
    status.hidden = saved
    status.textContent = saved ? '' : uiText('字号未能保存，当前窗口仍已生效。', 'Could not save text size. It still applies in this window.')
  }
  size.addEventListener('input', () => change(size.value))
  size.addEventListener('change', () => change(size.value))
  reset.addEventListener('click', () => change(100))
  refresh()
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(FONT_PREF, refresh, true) } catch { /* 缺少监听不影响当前窗口。 */ }
  return { element, remove: () => {
    try { if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer) } catch { /* 已销毁宿主不阻断清理。 */ }
    observer = undefined; element.remove()
  } }
}
