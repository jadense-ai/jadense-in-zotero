/** 迁移与隔离回归：旧选择必须保留，失败重试不得覆盖已独立编辑的用途。 */
import { describe, expect, it, vi } from 'vitest'
import type { ZoteroLike } from './runtime'
import { migrateTranslationConfiguration, TRANSLATION_CONFIG_MIGRATION_PREF } from './translation-config-migration'
import { AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, FEATURE_MODEL_PREF_KEYS, LEGACY_TRANSLATION_MODEL_PREF, effectiveFeatureModelSelection, readFeatureModelSelection, saveAutoFollowChatModel, saveFeatureModelSelection } from './ai-settings'
import { readTranslationInterface, saveTranslationInterface, TRANSLATION_INTERFACE_PREF, TRANSLATION_INTERFACE_PREFS } from './translation-interface'
import { translationCapacity } from './translation-chunks'

function fixture(values = new Map<string, unknown>()) {
  const host: ZoteroLike = { Prefs: { get: key => values.get(key), set: vi.fn((key, value) => { values.set(key, value) }), clear: key => { values.delete(key) } } }
  return { host, values }
}
const oldModel = { route: 'byok', modelId: 'old' } as const
const otherModel = { route: 'byok', modelId: 'other' } as const

describe('translation configuration migration', () => {
  it('preserves Zotero namespaced model keys separately from global interface keys', () => {
    const values = new Map<string, unknown>()
    const keyFor = (key: string, global?: boolean) => global ? key : `extensions.zotero.${key}`
    const host: ZoteroLike = { Prefs: {
      get: (key, global) => values.get(keyFor(key, global)),
      set: (key, value, global) => { values.set(keyFor(key, global), value) },
      clear: key => { values.delete(keyFor(key)) },
    } }
    host.Prefs!.set(LEGACY_TRANSLATION_MODEL_PREF, JSON.stringify(oldModel))
    host.Prefs!.set(AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, false)
    host.Prefs!.set(TRANSLATION_INTERFACE_PREF, JSON.stringify({ kind: 'machine', service: 'google' }), true)
    expect(migrateTranslationConfiguration(host)).toBe(true)
    expect(effectiveFeatureModelSelection(host, 'fullTranslation')).toEqual(oldModel)
    expect(readTranslationInterface(host, 'document')).toEqual({ kind: 'machine', service: 'google' })
    expect(values.has(keyFor(FEATURE_MODEL_PREF_KEYS.fullTranslation))).toBe(true)
    expect(values.has(FEATURE_MODEL_PREF_KEYS.fullTranslation)).toBe(false)
  })
  it.each(['ai', 'bing', 'google'])('preserves %s and the inactive independent model across restart', method => {
    const { host, values } = fixture()
    values.set(TRANSLATION_INTERFACE_PREF, JSON.stringify({ kind: method === 'ai' ? 'ai' : 'machine', service: method, future: true }))
    values.set(LEGACY_TRANSLATION_MODEL_PREF, JSON.stringify(oldModel))
    values.set(FEATURE_MODEL_PREF_KEYS.chat, JSON.stringify(otherModel))
    expect(migrateTranslationConfiguration(host)).toBe(true)
    for (const scope of ['selection', 'document'] as const) expect(readTranslationInterface(host, scope)).toEqual({ kind: method === 'ai' ? 'ai' : 'machine', service: method === 'google' ? 'google' : 'bing' })
    expect(effectiveFeatureModelSelection(host, 'fullTranslation')).toEqual(otherModel)
    saveAutoFollowChatModel(host, false)
    const restored = fixture(values).host
    expect(effectiveFeatureModelSelection(restored, 'translation')).toEqual(oldModel)
    expect(effectiveFeatureModelSelection(restored, 'fullTranslation')).toEqual(oldModel)
    const before = [...values]
    expect(migrateTranslationConfiguration(restored)).toBe(true)
    expect([...values]).toEqual(before)
  })
  it('keeps partial new settings and retries after a write failure', () => {
    const { host, values } = fixture()
    values.set(LEGACY_TRANSLATION_MODEL_PREF, JSON.stringify(oldModel))
    values.set(FEATURE_MODEL_PREF_KEYS.translation, JSON.stringify(otherModel))
    values.set(TRANSLATION_INTERFACE_PREFS.selection, JSON.stringify({ kind: 'machine', service: 'google' }))
    vi.mocked(host.Prefs!.set).mockImplementationOnce(() => { throw new Error('disk') })
    expect(migrateTranslationConfiguration(host)).toBe(false)
    expect(values.has(TRANSLATION_CONFIG_MIGRATION_PREF)).toBe(false)
    expect(readFeatureModelSelection(host, 'fullTranslation')).toEqual(oldModel)
    expect(migrateTranslationConfiguration(host)).toBe(true)
    expect(readFeatureModelSelection(host, 'translation')).toEqual(otherModel)
    expect(readFeatureModelSelection(host, 'fullTranslation')).toEqual(oldModel)
    expect(readTranslationInterface(host, 'selection')).toEqual({ kind: 'machine', service: 'google' })
  })
  it('uses independent services and follows only while the global switch is enabled', () => {
    const { host, values } = fixture()
    migrateTranslationConfiguration(host)
    expect(values.get(AUTO_FOLLOW_CHAT_MODEL_PREF_KEY)).toBeUndefined()
    saveTranslationInterface(host, { kind: 'machine', service: 'google' }, 'selection')
    saveTranslationInterface(host, { kind: 'ai', service: 'bing' }, 'document')
    saveFeatureModelSelection(host, 'chat', oldModel)
    saveFeatureModelSelection(host, 'translation', otherModel)
    saveFeatureModelSelection(host, 'fullTranslation', { route: 'byok', modelId: 'full' })
    expect(effectiveFeatureModelSelection(host, 'fullTranslation')).toEqual(oldModel)
    saveAutoFollowChatModel(host, false)
    expect(effectiveFeatureModelSelection(host, 'translation')).toEqual(otherModel)
    expect(effectiveFeatureModelSelection(host, 'fullTranslation')).toEqual({ route: 'byok', modelId: 'full' })
    expect(readTranslationInterface(host, 'selection').kind).toBe('machine')
    expect(readTranslationInterface(host, 'document').kind).toBe('ai')
    vi.mocked(host.Prefs!.set).mockImplementationOnce(() => { throw new Error('disk') })
    expect(saveTranslationInterface(host, { kind: 'machine', service: 'google' }, 'document')).toBe(false)
    expect(readTranslationInterface(host, 'document').kind).toBe('ai')
  })
  it('uses full translation model capacity instead of the selection model', () => {
    const { host, values } = fixture()
    values.set(AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, false)
    values.set('extensions.jadenseInZotero.byokConfig', JSON.stringify({ version: 2, activeProviderId: 'p', activeModelId: 'old', providers: [{ id: 'p', name: 'P', protocol: 'openai-chat-completions', baseUrl: 'https://test.invalid/v1', apiKey: 'synthetic' }], models: [{ id: 'old', providerId: 'p', name: 'Old', model: 'old', contextWindow: 8192, maxOutputTokens: 2048 }, { id: 'other', providerId: 'p', name: 'Other', model: 'other', contextWindow: 64000, maxOutputTokens: 16000 }] }))
    saveFeatureModelSelection(host, 'translation', oldModel)
    saveFeatureModelSelection(host, 'fullTranslation', otherModel)
    expect(translationCapacity(host)).toMatchObject({ contextWindow: 64000 })
    expect(translationCapacity(host)).not.toHaveProperty('maxOutputTokens')
  })
})
