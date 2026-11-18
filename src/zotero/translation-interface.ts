/** 传统翻译配置独立于 AI 模型；选文和全文分别保存，旧 profile 偏好作为兼容来源。 */
import { isMachineService, machineServices, type TranslationService } from '@/chat/machine-services'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { createJdxSelect } from './custom-select'
import { translationCapacity, TRANSLATION_CAPACITY_PREF } from './translation-chunks'
import { wireReadingBudgetSettings } from './translation-budget-settings'
import { featureModelDescription, observeAiModelSettings } from './ai-settings'

export const TRANSLATION_INTERFACE_PREF = 'extensions.jadenseInZotero.translationInterface'
export type TranslationScope = 'selection' | 'document'
export const TRANSLATION_INTERFACE_PREFS = { selection: 'extensions.jadenseInZotero.selectionTranslationInterface', document: 'extensions.jadenseInZotero.fullTranslationInterface' } as const
export type TranslationInterface = { kind: 'ai' | 'machine'; service: TranslationService }

/** 逐字段读取可选偏好，旧配置默认 AI；附加字段不影响翻译。 */
export function readTranslationInterface(host: ZoteroLike, scope?: TranslationScope): TranslationInterface {
  try {
    const raw = (scope ? host.Prefs?.get(TRANSLATION_INTERFACE_PREFS[scope], true) : undefined) ?? host.Prefs?.get(TRANSLATION_INTERFACE_PREF, true)
    const row = typeof raw === 'string' ? JSON.parse(raw) : raw
    return { kind: row?.kind === 'machine' ? 'machine' : 'ai', service: isMachineService(row?.service) ? row.service : 'bing' }
  } catch { return { kind: 'ai', service: 'bing' } }
}

export function saveTranslationInterface(host: ZoteroLike, value: TranslationInterface, scope?: TranslationScope) {
  try {
    if (!host.Prefs?.set) return false
    host.Prefs.set(scope ? TRANSLATION_INTERFACE_PREFS[scope] : TRANSLATION_INTERFACE_PREF, JSON.stringify({ kind: value.kind, service: value.service }), true)
    return true
  } catch { return false }
}

/** 在已有翻译模型行前插入配置，隐藏传统模式无关的 AI 行，卸载时释放观察器与菜单。 */
export function wireTranslationInterface(host: ZoteroLike | null, root: HTMLElement | null, scope: TranslationScope = 'selection') {
  if (!root || !host) return () => {}
  const doc = root.ownerDocument
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
  const modelRow = element('p'); modelRow.className = 'jdx-manager-settings-note jdx-pref-card-note'; modelRow.dataset.translationAiRow = ''; root.append(modelRow)
  const container = element('div'); container.className = 'jdx-translation-interface'
  const makeField = (labelText: string, name: string) => {
    const row = element('div'); row.className = 'jdx-feature-model-row jdx-translation-interface-row'
    const label = element('div'), title = element('h3'); title.textContent = labelText
    const help = element('p'); help.className = 'jdx-manager-settings-note jdx-pref-card-note'
    label.append(title, help)
    const selectRoot = element('div'); selectRoot.dataset.translationSetting = name
    const select = createJdxSelect(selectRoot, { ariaLabel: labelText, popupWidth: 220 })
    row.append(label, selectRoot); container.append(row)
    return { row, select, help }
  }
  const kind = makeField(uiText('翻译方式', 'Translation method'), 'kind')
  const service = makeField(uiText('翻译服务', 'Translation service'), 'service')
  const status = element('p'); status.setAttribute('role', 'status'); container.append(status)
  const capacity = element('details'), capacityTitle = element('summary')
  capacityTitle.textContent = uiText('翻译上下文预算', 'Translation context budgets'); capacity.append(capacityTitle)
  const stopBudgets = wireReadingBudgetSettings(host, capacity)
  const capacityInputs: HTMLInputElement[] = []
  for (const [key, title, fallback] of [['contextWindow', uiText('上下文窗口 tokens', 'Context window tokens'), '']] as const) {
    const label = element('label'), input = element('input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.value = String(fallback); input.dataset.capacity = key
    try { const saved = JSON.parse(String(host.Prefs?.get(TRANSLATION_CAPACITY_PREF, true) ?? '{}')); if (Number.isFinite(saved[key]) && saved[key] >= 1024) input.value = String(saved[key]) } catch { /* optional */ }
    label.textContent = uiText('全文 Markdown · ', 'Full Markdown · ') + title; label.append(input); capacity.append(label); capacityInputs.push(input)
    input.addEventListener('change', () => {
      try {
        let values: Record<string, unknown> = {}
        try { const saved = JSON.parse(String(host.Prefs?.get(TRANSLATION_CAPACITY_PREF, true) ?? '{}')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) values = saved } catch { /* optional */ }
        if (input.value && Number(input.value) > 0) values.contextWindow = Number(input.value); else delete values.contextWindow
        host.Prefs?.set?.(TRANSLATION_CAPACITY_PREF, JSON.stringify(values), true)
      } catch { status.textContent = uiText('容量设置保存失败', 'Could not save capacity') } finally { sync() }
    })
  }
  modelRow.before(container)
  modelRow.after(capacity)
  const sync = () => {
    const value = readTranslationInterface(host, scope)
    kind.select.setOptions([{ value: 'ai', label: uiText('AI 生成', 'AI generation') }, { value: 'machine', label: uiText('翻译接口', 'Translation service') }], value.kind)
    service.select.setOptions(Object.entries(machineServices).map(([id, { name }]) => ({ value: id, label: id === 'libretranslate' ? uiText('LibreTranslate（本机）', 'LibreTranslate (local)') : name })), value.service)
    service.help.textContent = value.service === 'libretranslate'
      ? uiText('需先在本机 127.0.0.1:5000 启动免密钥 LibreTranslate 并安装所需语言。原文仅发送到本机。', 'Start a keyless LibreTranslate instance at 127.0.0.1:5000 with the required languages installed. Source text stays on this computer.')
      : value.service === 'mymemory'
      ? uiText('原文发送至 MyMemory。匿名免费额度有限，更适合选文或短文。', 'Source text is sent to MyMemory. Its free anonymous quota is best suited to selections and short texts.')
      : uiText('原文直接发送至所选免费服务，无需 API Key；网络或服务限流可能影响可用性。', 'Source text goes directly to the selected free service. No API key is needed; availability depends on network access and rate limits.')
    service.row.hidden = value.kind !== 'machine'
    modelRow.textContent = value.kind === 'machine' ? `${uiText('当前服务', 'Current service')}：${machineServices[value.service].name}` : `${uiText('当前翻译模型', 'Current translation model')}：${featureModelDescription(host, 'translation')}。${uiText('在常规设置中修改。', 'Change it in General settings.')}`
    capacity.hidden = scope !== 'document' || value.kind === 'machine'
    let limits: Record<string, unknown> = {}
    try { limits = JSON.parse(String(host.Prefs?.get(TRANSLATION_CAPACITY_PREF, true) ?? '{}')) ?? {} } catch { /* optional */ }
    for (const field of capacityInputs) {
      const value = Number(limits[field.dataset.capacity!])
      field.value = Number.isFinite(value) && value > 0 ? String(value) : ''; field.placeholder = uiText('自动跟随模型 · ', 'Automatic · ') + translationCapacity(host).contextWindow.toLocaleString()
    }
    kind.help.textContent = scope === 'document'
      ? uiText('对照翻译、简阅和 Markdown 全文翻译共用此设置。选择「翻译接口」可使用免费服务。', 'Bilingual PDF, reading mode and full Markdown translation share this setting. Choose Translation service to use a free service.')
      : uiText('选中文本时使用。选择「翻译接口」可免费获取译文；AI 生成还可结合上下文处理术语与歧义。', 'Applies to selected text. Choose Translation service for free translation, or AI generation for contextual help with terms and ambiguity.')
  }
  const save = (value: TranslationInterface) => {
    status.textContent = saveTranslationInterface(host, value, scope) ? '' : uiText('设置保存失败，请重试。', 'Could not save settings. Please try again.')
    sync()
  }
  kind.select.onChange(value => save({ ...readTranslationInterface(host, scope), kind: value === 'machine' ? 'machine' : 'ai' }))
  service.select.onChange(value => save({ ...readTranslationInterface(host, scope), service: isMachineService(value) ? value : 'bing' }))
  sync()
  const stopModels = observeAiModelSettings(host, sync)
  let observer: unknown
  let capacityObserver: unknown
  try { observer = host.Prefs?.registerObserver?.(TRANSLATION_INTERFACE_PREFS[scope], sync, true) } catch { /* 跨窗通知不可用时仍可配置和翻译。 */ }
  try { capacityObserver = host.Prefs?.registerObserver?.(TRANSLATION_CAPACITY_PREF, sync, true) } catch { /* optional */ }
  return () => {
    if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer)
    if (capacityObserver !== undefined) host.Prefs?.unregisterObserver?.(capacityObserver)
    stopModels(); stopBudgets(); kind.select.destroy(); service.select.destroy(); container.remove(); capacity.remove(); modelRow.remove()
  }
}
