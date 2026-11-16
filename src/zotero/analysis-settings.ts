/** 文献解析数量偏好与两处配置宿主；只为新任务提供模型建议，不限制本地批注写入。 */
import { normalizeAnnotationSuggestion } from '@/chat/paper-analysis'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { element } from './ui/controls'

export const ANALYSIS_ANNOTATION_SUGGESTION_PREF = 'extensions.jadenseInZotero.analysisSuggestedMaxAnnotations'

/** 缺失、损坏或暂不可读的偏好按文献内容自动选择。 */
export function readAnalysisAnnotationSuggestion(host: ZoteroLike): number | undefined {
  try { return normalizeAnnotationSuggestion(host.Prefs?.get(ANALYSIS_ANNOTATION_SUGGESTION_PREF, true)) } catch { return undefined }
}

/** Manager 与原生设置共用输入、可访问名称及跨窗口同步；保存失败仅反馈在本控件。 */
export function wireAnalysisSettings(host: ZoteroLike, root: HTMLElement | null) {
  if (!root) return () => {}
  const doc = root.ownerDocument, row = element(doc, 'div', 'jdx-feature-model-row')
  const description = element(doc, 'div'), title = element(doc, 'h3')
  title.textContent = uiText('批注数量', 'Annotation count'); description.append(title)
  const control = element(doc, 'div'), label = element(doc, 'label'), text = element(doc, 'span'), input = element(doc, 'input')
  text.textContent = uiText('批注最大建议数', 'Suggested maximum annotations')
  input.type = 'number'; input.min = '1'; input.step = '1'; input.dataset.analysisAnnotationSuggestion = ''
  input.placeholder = uiText('自动 · 根据文献内容选择', 'Automatic · Based on paper content')
  input.style.cssText = 'display:block;width:100%;box-sizing:border-box;min-width:0'
  const help = element(doc, 'p', 'jdx-manager-settings-note jdx-pref-card-note'), status = element(doc, 'p')
  help.textContent = uiText('留空由模型根据文献内容选择。填写正整数作为整篇文献的软性建议，必要时模型可超过；不会截断返回批注。仅对新解析任务生效。', 'Leave blank for the model to choose based on the paper. A positive integer is a soft suggestion for the whole paper; the model may exceed it when needed. Returned annotations are not cut off. Applies to new analysis tasks.')
  status.setAttribute('role', 'status'); label.append(text, input); control.append(label, help, status); row.append(description, control); root.append(row)
  const sync = () => { input.value = String(readAnalysisAnnotationSuggestion(host) ?? '') }
  const change = () => {
    try {
      if (!host.Prefs?.set) throw new Error('Preferences unavailable')
      host.Prefs.set(ANALYSIS_ANNOTATION_SUGGESTION_PREF, String(normalizeAnnotationSuggestion(input.value) ?? ''), true)
      status.textContent = uiText('已保存，下次新解析生效。', 'Saved for new analysis tasks.')
    } catch { status.textContent = uiText('设置保存失败，请重试。', 'Could not save the setting. Retry.') }
    sync()
  }
  input.addEventListener('change', change)
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(ANALYSIS_ANNOTATION_SUGGESTION_PREF, sync, true) } catch { /* 单窗口设置仍可用。 */ }
  sync()
  return () => {
    input.removeEventListener('change', change)
    try { if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer) } catch { /* 关闭宿主时容忍清理失败。 */ }
    row.remove()
  }
}
