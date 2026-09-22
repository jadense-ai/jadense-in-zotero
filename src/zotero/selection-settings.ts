/** 工作台与原生功能配置共用选文设置，沿用 Reader 已有偏好和跨窗口同步。 */
import type { ZoteroLike } from './runtime'
import { createJdxSelect } from './custom-select'
import { uiText } from './ui-preferences'
import { SELECTION_PREF, readSelectionPreferences, saveSelectionPreferences } from './selection-preferences'
import { OCR_SELECTION_PREF, readSelectionOCR } from './local-ocr'

/** 设置变化只保存偏好；不触发当前选文的翻译、引用或 OCR。 */
export function wireSelectionSettings(host: ZoteroLike | null, root: HTMLElement | null) {
  if (!host || !root) return () => {}
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = root.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    node.textContent = text
    return node
  }
  const body = make('div'); body.className = 'jdx-selection-settings'; body.dataset.selectionSettings = ''
  const behaviorRoot = make('div')
  const behavior = createJdxSelect(behaviorRoot, { ariaLabel: uiText('选中文本后', 'After selecting text'), popupWidth: 300 })
  const syncBehavior = () => behavior.setOptions([
    { value: 'wait', label: uiText('等待', 'Wait') },
    { value: 'translate', label: uiText('自动翻译', 'Translate automatically') },
    { value: 'quote', label: uiText('自动引用到新对话', 'Quote in a new chat') },
  ], readSelectionPreferences(host).behavior)
  behavior.onChange(value => {
    saveSelectionPreferences(host, { behavior: value === 'translate' || value === 'quote' ? value : 'wait' })
    syncBehavior()
    status.textContent = readSelectionPreferences(host).behavior === value ? '' : uiText('设置保存失败，请重试。', 'Could not save settings. Retry.')
  })
  const label = make('label'); label.className = 'jdx-manager-checkbox jdx-pref-checkbox'
  const selection = make('input'); selection.type = 'checkbox'; selection.dataset.ocrSetting = 'selection'
  const selectionTitle = uiText('OCR增强选中文本内容提取', 'Enhance selected text extraction with OCR')
  selection.setAttribute('aria-label', selectionTitle)
  label.append(selection, make('span', selectionTitle))
  const help = make('p', uiText('默认使用 PDF 文本层。开启后，引用或翻译选文前使用 OCR 配置中选择的引擎识别文本和公式；云端仅接收选区图片。识别失败时提示并使用原选文。', 'Uses the PDF text layer by default. When enabled, uses the configured OCR engine before quoting or translating; cloud services receive selected image regions only. On failure, shows a notice and uses the original selection.'))
  help.className = 'jdx-manager-settings-note jdx-pref-card-note'
  const status = make('p'); status.setAttribute('role', 'status')
  const syncSelection = () => { selection.checked = readSelectionOCR(host) }
  selection.addEventListener('change', () => {
    try { host.Prefs?.set?.(OCR_SELECTION_PREF, selection.checked, true); status.textContent = '' }
    catch { status.textContent = uiText('选文 OCR 设置保存失败，请重试。', 'Could not save selection OCR setting. Please retry.') }
    syncSelection()
  })
  const behaviorRow = make('div'); behaviorRow.className = 'jdx-feature-model-row'
  const behaviorLabel = make('div'); behaviorLabel.append(make('h3', uiText('选中文本后', 'After selecting text')))
  behaviorRow.append(behaviorLabel, behaviorRoot)
  const ocrRow = make('div'); ocrRow.className = 'jdx-feature-model-row'
  const description = make('div'); description.append(label, help, status)
  const controls = make('div'); controls.dataset.ocrSummaryHost = ''
  ocrRow.append(description, controls)
  body.append(behaviorRow, ocrRow)
  root.append(body)
  syncBehavior(); syncSelection()
  const observers: unknown[] = []
  for (const [key, sync] of [[SELECTION_PREF, syncBehavior], [OCR_SELECTION_PREF, syncSelection]] as const) {
    try { const observer = host.Prefs?.registerObserver?.(key, sync, true); if (observer !== undefined) observers.push(observer) } catch { /* 可选跨窗同步不阻断设置。 */ }
  }
  return () => { observers.forEach(observer => host.Prefs?.unregisterObserver?.(observer)); behavior.destroy(); body.remove() }
}
