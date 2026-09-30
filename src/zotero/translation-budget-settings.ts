import { readTranslationInterface, TRANSLATION_INTERFACE_PREFS } from './translation-interface'
/** Manager、原生偏好与 Reader 共用的上下文预算编辑；配置不触发翻译。 */
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { READING_BUDGET_PREF, readingTranslationBudget, refreshTranslationLimits, saveReadingTranslationBudget, type ReadingBudgetMode } from './translation-budget'
import { element } from './ui/controls'
import { featureModelDescription, observeAiModelSettings } from './ai-settings'

export function wireReadingBudgetSettings(host: ZoteroLike, root: HTMLElement, modes: ReadingBudgetMode[] = ['pdf', 'simple']) {
  const doc = root.ownerDocument, container = element(doc, 'div'), inputs = new Map<ReadingBudgetMode, { input: HTMLInputElement; help: HTMLElement }>()
  container.dataset.readingBudgets = ''
  for (const mode of modes) {
    const row = element(doc, 'div', 'jdx-feature-model-row jdx-reading-budget-row'), label = element(doc, 'label'), input = element(doc, 'input'), help = element(doc, 'p', 'jdx-manager-settings-note jdx-pref-card-note')
    const title = element(doc, 'span', 'jdx-reading-budget-label')
    title.textContent = mode === 'pdf' ? uiText('对照翻译上下文', 'PDF translation context') : uiText('简阅翻译上下文', 'Reading translation context')
    input.type = 'number'; input.step = '1'; input.dataset.readingBudget = mode; input.style.cssText = 'display:block;width:100%;box-sizing:border-box;min-width:0'
    help.style.cssText = 'white-space:normal;font-size:12px;line-height:1.6'; label.append(title, input); row.append(label, help); container.append(row)
    input.addEventListener('change', () => { saveReadingTranslationBudget(host, mode, Number(input.value)); input.value = String(readingTranslationBudget(host, mode).contextWindow); sync() })
    inputs.set(mode, { input, help })
  }
  const summary = element(doc, 'div', 'jdx-reading-model-summary'), summaryLabel = element(doc, 'span', 'jdx-reading-budget-label'), summaryValue = element(doc, 'strong', 'jdx-reading-model-value'), summaryHint = element(doc, 'span', 'jdx-reading-model-hint')
  summary.append(summaryLabel, summaryValue, summaryHint); container.prepend(summary); root.append(container)
  const sync = () => {
    const service = readTranslationInterface(host, 'document')
    summaryLabel.textContent = service.kind === 'machine' ? uiText('当前服务', 'Current service') : uiText('翻译模型', 'Translation model')
    summaryValue.textContent = service.kind === 'machine' ? service.service : featureModelDescription(host, 'translation')
    summaryHint.textContent = service.kind === 'machine' ? '' : uiText('在常规设置中修改', 'Change in General settings')
    for (const [mode, { input, help }] of inputs) {
      input.disabled = service.kind === 'machine'
      const budget = readingTranslationBudget(host, mode)
      if (doc.activeElement !== input) input.value = String(budget.contextWindow)
      if (budget.maximum) input.max = String(budget.maximum); else input.removeAttribute('max')
      help.textContent = uiText('默认 128K，包含原文、提示与译文空间；下次翻译生效。', 'Default 128K, including source, prompt and output space. Applies to the next translation.') + ' ' + (budget.route === 'byok'
        ? uiText('BYOK 自行填写，不校验模型容量上限。', 'BYOK accepts your value without a model-capacity limit.')
        : budget.maximum ? uiText(`当前攻玉模型上限：${budget.maximum.toLocaleString()}。`, `Jadense model limit: ${budget.maximum.toLocaleString()}.`) : uiText('模型容量暂未读取，使用已设预算。', 'Model capacity is unavailable; using your budget.'))
    }
  }
  let disposed = false
  const refresh = () => { sync(); void refreshTranslationLimits(host).then(() => { if (!disposed) sync() }) }
  const stopModels = observeAiModelSettings(host, refresh)
  refresh(); container.addEventListener('focusin', refresh)
  let serviceObserver: unknown
  try { serviceObserver = host.Prefs?.registerObserver?.(TRANSLATION_INTERFACE_PREFS.document, sync, true) } catch { /* Optional observer. */ }
  let observer: unknown
  try { observer = host.Prefs?.registerObserver?.(READING_BUDGET_PREF, sync, true) } catch { /* 单窗口编辑仍然生效。 */ }
  return () => { disposed = true; stopModels(); if (serviceObserver !== undefined) host.Prefs?.unregisterObserver?.(serviceObserver); if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer); container.remove() }
}
