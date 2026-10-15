/** 真目录解析 → 功能偏好 → 选择器 → HTTP 的集成回归；所有账号和模型均为合成值。 */
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { parseJadenseChatModelCatalog } from '@/jadense/api'
import { TemporaryChatClient, jadenseChatSelectionBody } from '@/chat/temporary-chat'
import { createJdxSelect } from './ui/select'
import { buildFeatureModelSelectOptions, configureFeatureModelThinking } from './ai-model-select'
import { effectiveFeatureModelSelection, featureModelSelectionFromKey, featureModelSelectionKey, saveFeatureModelSelection, saveAutoFollowChatModel, saveByokModel, saveByokProvider, featureModelState } from './ai-settings'
import { chatDocumentCapacity } from './chat-document-request'
import { rememberModelCatalog } from './model-catalog'
import type { ZoteroLike } from './runtime'

function fixture(follow = false) {
  const prefs = new Map<string, unknown>([['extensions.jadenseInZotero.autoFollowChatModel', follow]])
  const host = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) } } as ZoteroLike
  const catalog = parseJadenseChatModelCatalog({ future: true, options: [
    { kind: 'route', routeTier: 'standard', displayName: 'Standard' },
    { kind: 'model', modelId: 'fast', displayName: 'Fast', contextWindow: 262144, maxOutputTokens: 32768,
      consumptionMultiplier: 1.2, baseConsumptionMultiplier: 2, sourceMultiplier: 0.6,
      defaultThinkingEffort: 'medium', reasoningConfig: { reasoningEfforts: ['none', 'low', 'medium', 'high', 'future-effort'], future: true } },
    { kind: 'model', modelId: 'plain', displayName: 'Plain', contextWindow: -1, reasoningConfig: null },
  ] })
  for (const feature of ['chat', 'translation', 'fullTranslation'] as const) saveFeatureModelSelection(host, feature, { route: 'jadense', selection: { kind: 'model', modelId: 'fast', thinkingEffort: 'auto' } })
  const dom = new JSDOM('<main><div id="models"></div></main>')
  const root = dom.window.document.getElementById('models')!
  const select = createJdxSelect(root, { compact: true, searchPlaceholder: '搜索模型', showSelectedIcon: true })
  const render = () => {
    const selection = effectiveFeatureModelSelection(host, 'fullTranslation')
    select.setOptions(buildFeatureModelSelectOptions(host, catalog, selection), featureModelSelectionKey(selection))
    configureFeatureModelThinking(select, host, 'fullTranslation', catalog)
  }
  select.onChange(value => { saveFeatureModelSelection(host, 'fullTranslation', featureModelSelectionFromKey(value)); render() })
  render()
  return { host, prefs, catalog, dom, root, select, render }
}

describe('model thinking and metadata', () => {
  it('puts Auto first beside models and keeps the Standard selection identity', () => {
    const f = fixture()
    const options = buildFeatureModelSelectOptions(f.host, f.catalog, effectiveFeatureModelSelection(f.host, 'chat'))
    expect(options[0]).toMatchObject({ value: 'route:standard', label: 'Auto', iconSrc: 'chrome://jadense-in-zotero/content/auto.svg', iconThemed: true })
    expect(options[0].group).toBe(options[1].group)
    f.root.querySelector<HTMLButtonElement>('.jdx-select-trigger')!.click()
    f.root.querySelector<HTMLButtonElement>('.jdx-model-heading')!.click()
    const selected = f.root.querySelector<HTMLElement>('[role=option][aria-selected="true"]')!
    expect(selected.querySelector('.jdx-select-option-icon path')?.getAttribute('d')).toContain('M12 1a11')
    expect(selected.querySelector('.jdx-select-selected-model-icon')).not.toBeNull()
    expect(selected.querySelector('.jdx-select-option-status')).toBeNull()
    const first = f.root.querySelector<HTMLElement>('[role=option]')!
    expect(first.textContent).toContain('Auto')
    first.click()
    expect(effectiveFeatureModelSelection(f.host, 'fullTranslation')).toEqual({ route: 'jadense', selection: { kind: 'route', routeTier: 'standard' } })
    expect(f.root.querySelector('input[type=range]')).toBeNull()
    f.select.destroy(); f.dom.window.close()
  })
  it('selects a sole BYOK effort and returns to provider default', () => {
    const prefs = new Map<string, unknown>()
    const host = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) } } as ZoteroLike
    saveByokProvider(host, { id: 'p', name: 'P', protocol: 'openai-chat-completions', baseUrl: 'https://provider.test/v1', apiKey: 'synthetic' })
    saveByokModel(host, { id: 'm', providerId: 'p', name: 'M', model: 'model', thinkingEfforts: ['ultra'] })
    saveFeatureModelSelection(host, 'chat', { route: 'byok', modelId: 'm' })
    const dom = new JSDOM('<main><div id="models"></div></main>')
    const root = dom.window.document.getElementById('models')!
    const select = createJdxSelect(root, { compact: true })
    const catalog = { options: [], defaultSelection: null }
    const selection = effectiveFeatureModelSelection(host, 'chat')
    select.setOptions(buildFeatureModelSelectOptions(host, catalog, selection), featureModelSelectionKey(selection))
    configureFeatureModelThinking(select, host, 'chat', catalog)
    root.querySelector<HTMLButtonElement>('.jdx-select-trigger')!.click()
    const only = root.querySelector<HTMLButtonElement>('.jdx-model-single-effort')!
    expect(only.disabled).toBe(false)
    only.click()
    expect(effectiveFeatureModelSelection(host, 'chat')).toMatchObject({ thinkingEffort: 'ultra' })
    expect(featureModelState(host, 'chat')).toMatchObject({ config: { thinkingEffort: 'ultra' } })
    root.querySelector<HTMLButtonElement>('.jdx-model-header button[aria-label="自动"]')!.click()
    expect(effectiveFeatureModelSelection(host, 'chat')).toEqual({ route: 'byok', modelId: 'm' })
    select.destroy(); dom.window.close()
  })

  it('preserves declared metadata and uses real platform capacity for document budgeting', () => {
    const f = fixture()
    expect(f.catalog.options[1]).toMatchObject({ contextWindow: 262144, maxOutputTokens: 32768, reasoningConfig: { reasoningEfforts: ['none', 'low', 'medium', 'high', 'future-effort'] } })
    expect(f.root.querySelector('[data-source-price] svg')).not.toBeNull()
    expect(f.root.querySelector('[data-source-price]')!.textContent).toBe('')
    expect(f.root.querySelector('.jdx-select-trigger')!.getAttribute('aria-label') ?? f.root.querySelector('.jdx-select-trigger')!.getAttribute('title')).toContain('6折')
    rememberModelCatalog(f.host, f.catalog)
    expect(chatDocumentCapacity(f.host, 'chat')).toMatchObject({ context: 262144, output: 32768 })
    expect(f.root.querySelector('[title*="262,144"]')).not.toBeNull()
    expect(f.catalog.options[2]).not.toHaveProperty('contextWindow')
    f.select.destroy(); f.dom.window.close()
  })

  it('keeps row pricing concise and explains free, discounts and surcharges without saving', () => {
    const f = fixture()
    f.root.querySelector<HTMLButtonElement>('.jdx-select-trigger')!.click()
    f.root.querySelector<HTMLButtonElement>('.jdx-model-heading')!.click()
    const row = f.root.querySelector<HTMLElement>('[role=option][aria-selected=true]')!
    row.focus()
    expect(row.textContent).toContain('1.20x')
    expect(row.textContent).not.toContain('6折')
    const card = f.root.querySelector<HTMLElement>('[role=tooltip]')!
    expect(card.hidden).toBe(false)
    expect(card.textContent).toContain('6折')
    expect(card.textContent).not.toContain('Zotero 端')
    expect(card.textContent).toContain('原消费倍率2.00x')
    expect(card.textContent).toContain('当前消费倍率1.20x')
    const saved = f.prefs.get('extensions.jadenseInZotero.aiModelSettings')
    for (const [rate, label, discount] of [[0, '免费', true], [1, '', false], [1.2, '来源倍率 1.2×', false]] as const) {
      const options = buildFeatureModelSelectOptions(f.host, { ...f.catalog, options: f.catalog.options.map(option => option.kind === 'model' ? { ...option, sourceMultiplier: rate, consumptionMultiplier: 2 * rate } : option) }, effectiveFeatureModelSelection(f.host, 'fullTranslation'))
      const option = options.find(option => option.value.includes('fast'))!
      expect(option.sourcePriceLabel ?? '').toContain(label)
      expect(option.priceDetail?.discounted).toBe(discount)
    }
    const english = buildFeatureModelSelectOptions(f.host, f.catalog, effectiveFeatureModelSelection(f.host, 'fullTranslation'), true)
    expect(english.find(option => option.value.includes('fast'))?.sourcePriceLabel).toBe('40% off')
    const prefixed = buildFeatureModelSelectOptions(f.host, { ...f.catalog, options: f.catalog.options.map(option => option.kind === 'model' ? { ...option, sourcePricePrefix: '错峰' } : option) }, effectiveFeatureModelSelection(f.host, 'fullTranslation'))
    expect(prefixed.find(option => option.value.includes('fast'))?.sourcePriceLabel).toBe('错峰6折')
    expect(f.prefs.get('extensions.jadenseInZotero.aiModelSettings')).toBe(saved)
    f.select.destroy(); f.dom.window.close()
  })

  it('saves a low translation effort and serializes it into the actual temporary request', async () => {
    const f = fixture()
    f.root.querySelector<HTMLButtonElement>('.jdx-select-trigger')!.click()
    const range = f.root.querySelector<HTMLInputElement>('input[type=range]')!
    range.value = '0'; range.dispatchEvent(new f.dom.window.Event('input'))
    expect(effectiveFeatureModelSelection(f.host, 'fullTranslation')).toEqual({ route: 'jadense', selection: { kind: 'model', modelId: 'fast', thinkingEffort: 'auto' } })
    range.dispatchEvent(new f.dom.window.Event('change'))
    const selection = effectiveFeatureModelSelection(f.host, 'fullTranslation')
    expect(selection).toEqual({ route: 'jadense', selection: { kind: 'model', modelId: 'fast', thinkingEffort: 'low' } })
    expect(f.root.querySelector('.jdx-model-effort')!.textContent).toBe('低')
    expect(effectiveFeatureModelSelection(f.host, 'chat')).not.toEqual(selection)
    const fetchImpl = vi.fn(async () => new Response('data: {"type":"text-delta","delta":"译文"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    const client = new TemporaryChatClient({ baseUrl: 'https://fixture.invalid', token: 'synthetic', selection: selection.route === 'jadense' ? selection.selection : undefined, fetchImpl })
    await client.send({ clientRequestId: 'request', conversationId: 'conversation', messages: [{ id: 'message', role: 'user', text: 'Translate' }] })
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1].body))).toMatchObject({ modelId: 'fast', thinkingEffort: 'low' })
    f.select.destroy(); f.dom.window.close()
  })

  it('keeps model browsing separate from selection and returns from the list on Escape', () => {
    const f = fixture()
    f.root.querySelector<HTMLButtonElement>('.jdx-select-trigger')!.click()
    f.root.querySelector<HTMLButtonElement>('.jdx-model-heading')!.click()
    const search = f.root.querySelector<HTMLInputElement>('input[type=search]')!
    expect(search.hidden).toBe(false)
    f.dom.window.dispatchEvent(new f.dom.window.Event('resize'))
    expect(f.root.dataset.open).toBe('true')
    search.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(f.root.dataset.open).toBe('true'); expect(search.hidden).toBe(true)
    f.root.querySelector<HTMLButtonElement>('.jdx-model-heading')!.click()
    const plain = [...f.root.querySelectorAll<HTMLElement>('[role=option]')].find(row => row.textContent?.includes('Plain'))!
    plain.click()
    expect(f.select.getValue()).toBe('model:plain'); expect(f.root.dataset.open).toBe('true')
    expect(f.root.querySelector<HTMLInputElement>('input[type=range]')).toBeNull()
    f.select.destroy(); f.dom.window.close()
  })

  it('keeps the translation effort independent when following chat is enabled', () => {
    const f = fixture(true)
    f.root.querySelector<HTMLButtonElement>('.jdx-select-trigger')!.click()
    const range = f.root.querySelector<HTMLInputElement>('input[type=range]')!
    range.value = '0'; range.dispatchEvent(new f.dom.window.Event('change'))
    expect(effectiveFeatureModelSelection(f.host, 'translation')).toMatchObject({ selection: { thinkingEffort: 'low' } })
    saveAutoFollowChatModel(f.host, false)
    expect(effectiveFeatureModelSelection(f.host, 'translation')).toMatchObject({ selection: { modelId: 'fast' } })
    expect(jadenseChatSelectionBody({ kind: 'route', routeTier: 'standard' })).toEqual({ routeTier: 'standard' })
    f.select.destroy(); f.dom.window.close()
  })
})
