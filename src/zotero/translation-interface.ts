/** 传统翻译配置独立于 AI 模型；选文和全文分别保存，旧 profile 偏好作为兼容来源。 */
import type { TranslationService } from '@/chat/machine-translation'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'
import { createJdxSelect } from './custom-select'
import { TRANSLATION_CAPACITY_PREF } from './translation-chunks'

export const TRANSLATION_INTERFACE_PREF = 'extensions.jadenseInZotero.translationInterface'
export type TranslationScope = 'selection' | 'document'
export const TRANSLATION_INTERFACE_PREFS = { selection: 'extensions.jadenseInZotero.selectionTranslationInterface', document: 'extensions.jadenseInZotero.fullTranslationInterface' } as const
export type TranslationInterface = { kind: 'ai' | 'machine'; service: TranslationService }

/** 逐字段读取可选偏好，旧配置默认 AI；附加字段不影响翻译。 */
export function readTranslationInterface(host: ZoteroLike, scope?: TranslationScope): TranslationInterface {
  try {
    const raw = (scope ? host.Prefs?.get(TRANSLATION_INTERFACE_PREFS[scope], true) : undefined) ?? host.Prefs?.get(TRANSLATION_INTERFACE_PREF, true)
    const row = typeof raw === 'string' ? JSON.parse(raw) : raw
    return { kind: row?.kind === 'machine' ? 'machine' : 'ai', service: row?.service === 'google' ? 'google' : 'bing' }
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
  const model = root.querySelector<HTMLElement>(`[id$="feature-${scope === 'document' ? 'fullTranslation' : 'translation'}-model"]`)
  const modelRow = model?.closest<HTMLElement>('.jdx-feature-model-row, .jdx-pref-field')
  if (!modelRow) return () => {}
  modelRow.dataset.translationAiRow = ''
  const doc = root.ownerDocument
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
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
  service.help.textContent = uiText('原文将直接发送至所选翻译服务，无需攻玉令牌或 API Key；可用性受网络与服务限流影响。', 'Source text is sent directly to the selected service. No Jadense token or API key is required; availability depends on network access and service rate limits.')
  const status = element('p'); status.setAttribute('role', 'status'); container.append(status)
  const capacity = element('details'), capacityTitle = element('summary')
  capacityTitle.textContent = uiText('AI 模型容量（缺少模型元数据时使用）', 'AI model capacity (when model metadata is unavailable)'); capacity.append(capacityTitle)
  const capacityInputs: HTMLInputElement[] = []
  for (const [key, title, fallback] of [['contextWindow', uiText('上下文窗口 tokens', 'Context window tokens'), 16384]] as const) {
    const label = element('label'), input = element('input'); input.type = 'number'; input.min = '1024'; input.step = '1024'; input.value = String(fallback); input.dataset.capacity = key
    try { const saved = JSON.parse(String(host.Prefs?.get(TRANSLATION_CAPACITY_PREF, true) ?? '{}')); if (Number.isFinite(saved[key]) && saved[key] >= 1024) input.value = String(saved[key]) } catch { /* optional */ }
    label.textContent = title; label.append(input); capacity.append(label); capacityInputs.push(input)
    input.addEventListener('change', () => { const values = Object.fromEntries(capacityInputs.map(field => [field.dataset.capacity, Number(field.value)])); try { host.Prefs?.set?.(TRANSLATION_CAPACITY_PREF, JSON.stringify(values), true) } catch { status.textContent = uiText('容量设置保存失败', 'Could not save capacity') } finally { sync() } })
  }
  modelRow.before(container)
  modelRow.after(capacity)
  const sync = () => {
    const value = readTranslationInterface(host, scope)
    kind.select.setOptions([{ value: 'ai', label: uiText('AI 生成', 'AI generation') }, { value: 'machine', label: uiText('翻译接口', 'Translation service') }], value.kind)
    service.select.setOptions([{ value: 'bing', label: 'Bing' }, { value: 'google', label: 'Google' }], value.service)
    service.row.hidden = value.kind !== 'machine'; modelRow.hidden = value.kind === 'machine'
    capacity.hidden = scope !== 'document' || value.kind === 'machine'
    let limits: Record<string, unknown> = {}
    try { limits = JSON.parse(String(host.Prefs?.get(TRANSLATION_CAPACITY_PREF, true) ?? '{}')) ?? {} } catch { /* optional */ }
    for (const field of capacityInputs) {
      const value = Number(limits[field.dataset.capacity!])
      field.value = String(Number.isFinite(value) && value >= 1024 ? value : 16384)
    }
    kind.help.textContent = value.kind === 'machine'
      ? uiText('仅返回译文，不进行额外的术语解析、歧义理清或公式恢复。适用于选文和全文翻译。', 'Returns translation only, without extra terminology analysis, ambiguity clarification or formula recovery. Applies to selected text and full documents.')
      : uiText('沿用当前 AI 翻译能力，可结合上下文处理术语、歧义与公式。', 'Uses the existing AI translation capabilities, including contextual handling of terminology, ambiguity and formulas.')
  }
  const save = (value: TranslationInterface) => {
    status.textContent = saveTranslationInterface(host, value, scope) ? '' : uiText('设置保存失败，请重试。', 'Could not save settings. Please try again.')
    sync()
  }
  kind.select.onChange(value => save({ ...readTranslationInterface(host, scope), kind: value === 'machine' ? 'machine' : 'ai' }))
  service.select.onChange(value => save({ ...readTranslationInterface(host, scope), service: value === 'google' ? 'google' : 'bing' }))
  sync()
  let observer: unknown
  let capacityObserver: unknown
  try { observer = host.Prefs?.registerObserver?.(TRANSLATION_INTERFACE_PREFS[scope], sync, true) } catch { /* 跨窗通知不可用时仍可配置和翻译。 */ }
  try { capacityObserver = host.Prefs?.registerObserver?.(TRANSLATION_CAPACITY_PREF, sync, true) } catch { /* optional */ }
  return () => {
    if (observer !== undefined) host.Prefs?.unregisterObserver?.(observer)
    if (capacityObserver !== undefined) host.Prefs?.unregisterObserver?.(capacityObserver)
    kind.select.destroy(); service.select.destroy(); container.remove(); capacity.remove(); modelRow.hidden = false; delete modelRow.dataset.translationAiRow
  }
}
