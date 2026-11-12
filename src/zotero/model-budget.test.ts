/** 容量来自真实偏好与模型目录；覆盖自动模式、BYOK、完整序列化输入及可选目录失败。 */
import { describe, expect, it } from 'vitest'
import { rememberModelCatalog } from './model-catalog'
import { readingTranslationBudget } from './translation-budget'
import { translationCapacity } from './translation-chunks'
import type { ZoteroLike } from './runtime'

function host(route: 'jadense' | 'byok', contextWindow: number, maxOutputTokens = 96000) {
  const selection = route === 'byok' ? { route, modelId: 'm' } : { route, selection: { kind: 'model', modelId: 'm' } }
  const prefs = new Map<string, unknown>([
    ['extensions.jadenseInZotero.baseUrl', 'https://synthetic.invalid'], ['extensions.jadenseInZotero.token', 'synthetic'],
    ['extensions.jadenseInZotero.aiModelSettings', JSON.stringify({ version: 1, followChatModel: false, models: { chat: selection, translation: selection, analysis: selection, figure: selection } })],
    ['extensions.jadenseInZotero.byokConfig', JSON.stringify({ version: 2, providers: [{ id: 'p', protocol: 'openai', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic' }], models: [{ id: 'm', providerId: 'p', model: 'synthetic', contextWindow, maxOutputTokens }] })],
  ])
  const value = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, v: unknown) => prefs.set(key, v) } } as unknown as ZoteroLike
  rememberModelCatalog(value, { options: [{ kind: 'model', modelId: 'm', displayName: 'Synthetic', contextWindow, maxOutputTokens }], defaultSelection: { kind: 'model', modelId: 'm' } })
  return { value, prefs }
}

describe('feature model capacity', () => {
  it.each(['jadense', 'byok'] as const)('uses the selected %s model capacity automatically across translation modes', route => {
    const { value } = host(route, 1048576)
    expect(readingTranslationBudget(value, 'pdf').contextWindow).toBe(1048576)
    expect(readingTranslationBudget(value, 'simple').contextWindow).toBe(1048576)
    expect(translationCapacity(value).contextWindow).toBe(1048576)
  })
  it('caps BYOK manual budgets and Markdown batches at both model limits', () => {
    const { value, prefs } = host('byok', 8192, 4096)
    prefs.set('extensions.jadenseInZotero.readingTranslationBudgets', JSON.stringify({ pdf: 2000000, future: true }))
    expect(readingTranslationBudget(value, 'pdf').contextWindow).toBe(8192)
    expect(translationCapacity(value).sourceTokens * 3 + 512).toBeLessThanOrEqual(4096)
  })
  it('preserves old explicit caps instead of treating a saved 128K as automatic', () => {
    const { value, prefs } = host('jadense', 1048576)
    prefs.set('extensions.jadenseInZotero.readingTranslationBudgets', JSON.stringify({ pdf: 131072 }))
    prefs.set('extensions.jadenseInZotero.translationCapacity', JSON.stringify({ contextWindow: 65536 }))
    expect(readingTranslationBudget(value, 'pdf').contextWindow).toBe(131072)
    expect(translationCapacity(value).contextWindow).toBe(65536)
  })
})
