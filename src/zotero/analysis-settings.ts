/** 文献解析的可选偏好，由工作台和 Zotero 原生设置共用。 */
import { normalizeAnnotationSuggestion } from '@/chat/paper-analysis'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { element } from './ui/controls'

export const ANALYSIS_ANNOTATION_SUGGESTION_PREF = 'extensions.jadenseInZotero.analysisSuggestedMaxAnnotations'
export const ANALYSIS_REFERENCES_PREF = 'extensions.jadenseInZotero.analysisReferencesEnabled'

/** 缺失、损坏或暂不可读的偏好按文献内容自动选择。 */
export function readAnalysisAnnotationSuggestion(host: ZoteroLike): number | undefined {
  try { return normalizeAnnotationSuggestion(host.Prefs?.get(ANALYSIS_ANNOTATION_SUGGESTION_PREF, true)) } catch { return undefined }
}

/** 只有用户明确开启时才随文献解析自动提取参考文献。 */
export function readAnalysisReferencesEnabled(host: ZoteroLike): boolean {
  try { return host.Prefs?.get(ANALYSIS_REFERENCES_PREF, true) === true } catch { return false }
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
  const referenceRow = element(doc, 'div', 'jdx-feature-model-row')
  const heading = element(doc, 'div')
  heading.append(element(doc, 'h3', '', uiText('参考文献', 'References')))
  const referenceControls = element(doc, 'div')
  const referenceLabel = element(doc, 'label', 'jdx-manager-checkbox jdx-pref-checkbox')
  const checkbox = element(doc, 'input')
  checkbox.type = 'checkbox'
  checkbox.dataset.analysisReferencesEnabled = ''
  referenceLabel.append(checkbox, element(doc, 'span', '', uiText('解析文献时自动提取参考文献', 'Automatically extract references during analysis')))
  const referenceHelp = element(doc, 'p', 'jdx-manager-settings-note jdx-pref-card-note',
    uiText('关闭时，仍可在解析详情的「参考文献」中手动提取。', 'When off, you can still extract references manually from the References tab in the analysis details.'))
  const referenceStatus = element(doc, 'p')
  referenceStatus.setAttribute('role', 'status')
  referenceControls.append(referenceLabel, referenceHelp, referenceStatus)
  referenceRow.append(heading, referenceControls)
  root.append(referenceRow)

  function bindPreference(key: string, field: HTMLInputElement, feedback: HTMLElement, sync: () => void, value: () => string | boolean, savedMessage: string) {
    const change = () => {
      try {
        if (!host.Prefs?.set) throw new Error('Preferences unavailable')
        host.Prefs.set(key, value(), true)
        feedback.textContent = savedMessage
      } catch { feedback.textContent = uiText('设置保存失败，请重试。', 'Could not save the setting. Retry.') }
      sync()
    }
    field.addEventListener('change', change)
    let observer: unknown
    try { observer = host.Prefs?.registerObserver?.(key, sync, true) } catch { /* 单窗口设置仍可用。 */ }
    sync()
    return () => {
      field.removeEventListener('change', change)
      try { if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer) } catch { /* 关闭宿主时容忍清理失败。 */ }
    }
  }
  const stopSuggestion = bindPreference(ANALYSIS_ANNOTATION_SUGGESTION_PREF, input, status,
    () => { input.value = String(readAnalysisAnnotationSuggestion(host) ?? '') },
    () => String(normalizeAnnotationSuggestion(input.value) ?? ''), uiText('已保存，下次新解析生效。', 'Saved for new analysis tasks.'))
  const stopReferences = bindPreference(ANALYSIS_REFERENCES_PREF, checkbox, referenceStatus,
    () => { checkbox.checked = readAnalysisReferencesEnabled(host) }, () => checkbox.checked, uiText('已保存。', 'Saved.'))
  return () => {
    stopSuggestion()
    stopReferences()
    row.remove()
    referenceRow.remove()
  }
}
