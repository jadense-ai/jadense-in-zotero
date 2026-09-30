/** 使用真实 Zotero 分支语义验证模型偏好迁移与共享翻译的外部行为。 */
import { describe, expect, it, vi } from 'vitest'
import { effectiveFeatureModelSelection, initializeFeatureModelSelections, readFeatureModelSelection, saveFeatureModelSelection, saveAutoFollowChatModel, observeAiModelSettings } from './ai-settings'
import type { JadenseChatModelCatalog } from '@/jadense/api'
import type { ZoteroLike } from './runtime'

const key = 'extensions.jadenseInZotero.aiModelSettings'
const model = (id: string, thinkingEffort = 'low') => ({ route: 'jadense' as const, selection: { kind: 'model' as const, modelId: id, thinkingEffort } })
function fixture() {
  const values = new Map<string, unknown>()
  const physical = (k: string, global = false) => (global ? '' : 'extensions.zotero.') + k
  const host = { Prefs: { get: (k: string, global?: boolean) => values.get(physical(k, global)), set: vi.fn((k: string, v: unknown, global?: boolean) => { values.set(physical(k, global), v) }) } } as ZoteroLike
  return { host, values }
}

describe('canonical AI model storage', () => {
  it('reads legacy effective translation without writes and migrates once to a global nonsecret record', () => {
    const { host, values } = fixture()
    host.Prefs!.set('extensions.jadenseInZotero.chatModel', JSON.stringify(model('chat', 'high')))
    host.Prefs!.set('extensions.jadenseInZotero.fullTranslationModel', JSON.stringify(model('document')))
    const before = values.size
    expect(effectiveFeatureModelSelection(host, 'fullTranslation')).toEqual(model('chat', 'high'))
    expect(values.size).toBe(before)
    initializeFeatureModelSelections(host)
    expect(values.has(key)).toBe(true)
    const canonical = values.get(key)
    initializeFeatureModelSelections(host)
    expect(values.get(key)).toBe(canonical)
    saveFeatureModelSelection(host, 'chat', model('another-chat'))
    expect(effectiveFeatureModelSelection(host, 'translation')).toEqual(model('chat', 'high'))
    expect(effectiveFeatureModelSelection(host, 'fullTranslation')).toEqual(model('chat', 'high'))
  })
  it('shares translation writes while following only analysis and figure', () => {
    const { host } = fixture()
    saveFeatureModelSelection(host, 'chat', model('chat'))
    saveFeatureModelSelection(host, 'translation', model('translation'))
    saveAutoFollowChatModel(host, true)
    expect(effectiveFeatureModelSelection(host, 'fullTranslation')).toEqual(model('translation'))
    expect(effectiveFeatureModelSelection(host, 'analysis')).toEqual(model('chat'))
    saveFeatureModelSelection(host, 'fullTranslation', model('revised'))
    expect(readFeatureModelSelection(host, 'translation')).toEqual(model('revised'))
  })
  it('keeps the saved value after a failed save and accepts additive fields', () => {
    const { host, values } = fixture()
    saveFeatureModelSelection(host, 'translation', model('original'))
    const record = JSON.parse(String(values.get(key)))
    values.set(key, JSON.stringify({ ...record, future: true }))
    host.Prefs!.set = () => { throw new Error('Synthetic disk failure') }
    expect(() => saveFeatureModelSelection(host, 'translation', model('lost'))).toThrow()
    expect(readFeatureModelSelection(host, 'translation')).toEqual(model('original'))
  })
  it('retains latest changes from another window and falls back read-only when migration fails', () => {
    const { host, values } = fixture()
    host.Prefs!.set('extensions.jadenseInZotero.autoFollowChatModel', false)
    host.Prefs!.set('extensions.jadenseInZotero.fullTranslationModel', JSON.stringify(model('legacy')))
    const set = host.Prefs!.set
    host.Prefs!.set = () => { throw new Error('Synthetic disk failure') }
    initializeFeatureModelSelections(host)
    expect(values.has(key)).toBe(false)
    expect(readFeatureModelSelection(host, 'translation')).toEqual(model('legacy'))
    host.Prefs!.set = set
    initializeFeatureModelSelections(host)
    const second = { Prefs: host.Prefs }
    saveFeatureModelSelection(second, 'analysis', model('analysis'))
    saveFeatureModelSelection(host, 'translation', model('new'))
    expect(readFeatureModelSelection(host, 'analysis')).toEqual(model('analysis'))
  })
})

it.each([
  [['high', 'minimal', 'low'], 'high', 'low'],
  [['high', 'minimal'], 'high', 'minimal'],
  [['high'], 'high', 'high'],
  [[], undefined, 'auto'],
  [['none'], 'none', 'auto'],
])('persists translation defaults from available strengths %j', (efforts, fallback, expected) => {
  const { host, values } = fixture()
  const catalog = { options: [{ kind: 'model', modelId: 'new', displayName: 'New', defaultThinkingEffort: fallback, reasoningConfig: { reasoningEfforts: efforts } }] } as JadenseChatModelCatalog
  saveFeatureModelSelection(host, 'translation', { route: 'jadense', selection: { kind: 'model', modelId: 'new' } }, catalog)
  expect(JSON.parse(String(values.get(key))).models.translation.selection.thinkingEffort).toBe(expected)
  saveFeatureModelSelection(host, 'translation', model('new', 'high'), catalog)
  expect(readFeatureModelSelection(host, 'translation')).toEqual(model('new', 'high'))
})
it('preserves valid canonical slots when optional fields are damaged and legacy branches conflict', () => {
  const { host, values } = fixture()
  host.Prefs!.set('extensions.jadenseInZotero.autoFollowChatModel', false)
  host.Prefs!.set('extensions.jadenseInZotero.fullTranslationModel', JSON.stringify(model('real-legacy')))
  host.Prefs!.set('extensions.jadenseInZotero.fullTranslationModel', JSON.stringify(model('wrong-global')), true)
  initializeFeatureModelSelections(host)
  expect(readFeatureModelSelection(host, 'translation')).toEqual(model('real-legacy'))
  const canonical = JSON.parse(String(values.get(key)))
  canonical.models.analysis = { invalid: true }
  canonical.models.translation = model('canonical')
  values.set(key, JSON.stringify(canonical))
  const writes = vi.mocked(host.Prefs!.set).mock.calls.length
  expect(readFeatureModelSelection({ Prefs: host.Prefs }, 'translation')).toEqual(model('canonical'))
  expect(vi.mocked(host.Prefs!.set).mock.calls).toHaveLength(writes)
})
it('observes the canonical physical key and reads fresh state in another window', () => {
  const { host } = fixture(), changed = vi.fn()
  const listeners = new Map<string, () => void>()
  host.Prefs!.registerObserver = vi.fn((k, callback, global) => { listeners.set(String(global) + k, callback); return k })
  host.Prefs!.unregisterObserver = vi.fn()
  const original = host.Prefs!.set
  host.Prefs!.set = (k, value, global) => { original(k, value, global); listeners.get(String(global) + k)?.() }
  const unsubscribe = observeAiModelSettings(host, changed)
  saveFeatureModelSelection({ Prefs: host.Prefs }, 'translation', model('cross-window'))
  expect(changed).toHaveBeenCalledOnce()
  expect(readFeatureModelSelection(host, 'translation')).toEqual(model('cross-window'))
  unsubscribe()
  expect(host.Prefs!.unregisterObserver).toHaveBeenCalledWith(key)
})
