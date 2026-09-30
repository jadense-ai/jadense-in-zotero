/** 预算跨设置/目录/请求的接缝：真实偏好与目录解析，仅替换 HTTP 和宿主。 */
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { ZoteroLike } from './runtime'
import { readingTranslationBudget, READING_BUDGET_PREF, refreshTranslationLimits, saveReadingTranslationBudget } from './translation-budget'
import { wireReadingBudgetSettings } from './translation-budget-settings'
import { pdfTranslationBudget } from './pdf-translation-jobs'

function fixture(byok = false) {
  const prefs = new Map<string, unknown>([
    ['extensions.jadenseInZotero.baseUrl', 'http://127.0.0.1:1234'],
    ['extensions.jadenseInZotero.token', 'synthetic'],
    ['extensions.jadenseInZotero.autoFollowChatModel', false],
    ['extensions.jadenseInZotero.fullTranslationModel', JSON.stringify({ route: 'jadense', selection: { kind: 'model', modelId: 'large' } })],
  ])
  if (byok) {
    prefs.set('extensions.jadenseInZotero.byokConfig', JSON.stringify({ version: 2, activeProviderId: 'p', activeModelId: 'm', providers: [{ id: 'p', protocol: 'openai', baseUrl: 'https://provider.test/v1', apiKey: 'synthetic' }], models: [{ id: 'm', providerId: 'p', model: 'custom', contextWindow: 4096, maxOutputTokens: 96000 }] }))
    prefs.set('extensions.jadenseInZotero.fullTranslationModel', JSON.stringify({ route: 'byok', modelId: 'm' }))
  }
  const fetch = vi.fn(async () => Response.json({ options: [{ kind: 'model', modelId: 'large', displayName: 'Large', contextWindow: 262144, maxOutputTokens: 96000 }], defaultSelection: { kind: 'model', modelId: 'large' } }))
  const observers = new Set<() => void>()
  const host = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => { prefs.set(key, value); observers.forEach(fn => fn()) }, registerObserver: (_key: string, fn: () => void) => { observers.add(fn); return fn }, unregisterObserver: (fn: () => void) => observers.delete(fn) }, getMainWindow: () => ({ fetch }) } as unknown as ZoteroLike
  return { host, prefs, fetch, observers }
}

describe('reading translation budgets', () => {
  it('defaults both modes to 128K instead of filling a larger model context', async () => {
    const { host, fetch } = fixture()
    await Promise.all([refreshTranslationLimits(host), refreshTranslationLimits(host)])
    expect(fetch).toHaveBeenCalledOnce()
    expect(readingTranslationBudget(host, 'pdf')).toMatchObject({ requested: 131072, contextWindow: 131072, maximum: 262144, maxOutputTokens: 96000 })
    expect(readingTranslationBudget(host, 'simple').contextWindow).toBe(131072)
    expect(pdfTranslationBudget(host).batchTokens).toBeGreaterThan(30000)
  })
  it('uses platform recorded limits and preserves independent budgets and additive preferences', async () => {
    const { host, prefs } = fixture()
    await refreshTranslationLimits(host)
    prefs.set(READING_BUDGET_PREF, JSON.stringify({ future: true }))
    saveReadingTranslationBudget(host, 'pdf', 999999)
    saveReadingTranslationBudget(host, 'simple', 65536)
    expect(JSON.parse(String(prefs.get(READING_BUDGET_PREF)))).toEqual({ future: true, pdf: 262144, simple: 65536 })
    expect(readingTranslationBudget(host, 'pdf').contextWindow).toBe(262144)
    expect(readingTranslationBudget(host, 'simple').contextWindow).toBe(65536)
  })
  it('does not validate BYOK values against model metadata or fetch platform metadata', async () => {
    const { host, fetch } = fixture(true)
    await refreshTranslationLimits(host)
    saveReadingTranslationBudget(host, 'pdf', 2000000)
    expect(readingTranslationBudget(host, 'pdf')).toMatchObject({ route: 'byok', requested: 2000000, contextWindow: 2000000, maximum: undefined })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('contains missing or failed optional catalog data without replacing user budgets', async () => {
    const { host, fetch } = fixture()
    fetch.mockRejectedValue(new Error('offline'))
    saveReadingTranslationBudget(host, 'pdf', 192000)
    await refreshTranslationLimits(host)
    expect(readingTranslationBudget(host, 'pdf')).toMatchObject({ contextWindow: 192000, maximum: undefined })
  })
  it('ignores a stale catalog after switching the platform connection', async () => {
    const { host, prefs } = fixture()
    await refreshTranslationLimits(host)
    prefs.set('extensions.jadenseInZotero.baseUrl', 'http://127.0.0.1:4321')
    expect(readingTranslationBudget(host, 'pdf').maximum).toBeUndefined()
  })
  it('keeps editing and cross-window changes live without dispatching translation', async () => {
    const { host, fetch, observers } = fixture(true)
    const { window } = new JSDOM('<main></main>')
    const root = window.document.querySelector('main')!
    const stop = wireReadingBudgetSettings(host, root)
    const pdf = root.querySelector<HTMLInputElement>('[data-reading-budget="pdf"]')!
    const simple = root.querySelector<HTMLInputElement>('[data-reading-budget="simple"]')!
    expect(pdf.value).toBe('131072'); expect(simple.value).toBe('131072')
    expect(pdf.hasAttribute('max')).toBe(false)
    pdf.value = '999999'; pdf.dispatchEvent(new window.Event('change'))
    expect(readingTranslationBudget(host, 'pdf').contextWindow).toBe(999999)
    expect(simple.value).toBe('131072')
    saveReadingTranslationBudget(host, 'simple', 65536)
    expect(simple.value).toBe('65536')
    expect(fetch).not.toHaveBeenCalled()
    stop(); expect(observers.size).toBe(0); window.close()
  })
})
