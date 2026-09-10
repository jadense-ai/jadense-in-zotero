/** 参考文献 AI 偏好与两处设置入口；缺失偏好始终关闭，不迁移旧模型设置。 */
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

export const REFERENCE_AI_PREF = 'extensions.jadenseInZotero.referenceAIEnabled'
export function referenceAIEnabled(host: ZoteroLike) { return host.Prefs?.get(REFERENCE_AI_PREF, true) === true }

/** 原生页和 Manager 使用同一偏好；监听跨窗口修改并在卸载时移除。 */
export function wireReferenceAISetting(host: ZoteroLike, root: HTMLElement | null) {
  if (!root) return () => {}
  const doc = root.ownerDocument
  const label = doc.createElementNS('http://www.w3.org/1999/xhtml', 'label') as HTMLLabelElement
  label.className = 'jdx-reference-ai-setting'
  const control = doc.createElementNS('http://www.w3.org/1999/xhtml', 'input') as HTMLInputElement
  control.type = 'checkbox'; control.dataset.referenceAi = ''
  const text = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span')
  text.textContent = uiText('AI 参与参考文献识别', 'Use AI for reference identification')
  const help = doc.createElementNS('http://www.w3.org/1999/xhtml', 'p')
  help.textContent = uiText('默认关闭。开启后，新任务批量发送待识别参考文献，可能消耗积分；原文与非 AI 核验始终保留。', 'Off by default. New tasks send uncertain references in batches and may consume points. Source text and non-AI verification are preserved.')
  label.append(control, text, help); root.insertBefore(label, root.querySelector('.jdx-temporary-recovery'))
  const sync = () => { control.checked = referenceAIEnabled(host) }
  control.addEventListener('change', () => { try { host.Prefs?.set(REFERENCE_AI_PREF, control.checked, true) } finally { sync() } })
  sync()
  const observer = host.Prefs?.registerObserver?.(REFERENCE_AI_PREF, sync, true)
  return () => { if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer); label.remove() }
}
