/** 两处配置宿主共享文献解析偏好；覆盖默认值、保存、跨窗口同步与读写故障。 */
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ANALYSIS_ANNOTATION_SUGGESTION_PREF as KEY, ANALYSIS_REFERENCES_PREF,
  readAnalysisAnnotationSuggestion, readAnalysisReferencesEnabled, wireAnalysisSettings,
} from './analysis-settings'
import { initializeUiLocale } from './ui-preferences'

afterEach(() => initializeUiLocale(null))

function fixture() {
  const values = new Map<string, unknown>(), observers = new Set<() => void>()
  const host = { Prefs: {
    get: (key: string) => values.get(key),
    set: vi.fn((key: string, value: unknown) => { values.set(key, value); observers.forEach(fn => fn()) }),
    registerObserver: (_key: string, fn: () => void) => { observers.add(fn); return fn },
    unregisterObserver: (fn: unknown) => observers.delete(fn as () => void),
  } }
  return { host, values, observers }
}

it.each(['zh-CN', 'en-US'])('shares the optional setting across both hosts, restores automatic and cleans up in %s', locale => {
  initializeUiLocale({ locale })
  const { host, values, observers } = fixture(), dom = new JSDOM('<div id="manager"></div><div id="native"></div>')
  const roots = [...dom.window.document.querySelectorAll<HTMLElement>('div')], stops = roots.map(root => wireAnalysisSettings(host, root))
  const inputs = roots.map(root => root.querySelector<HTMLInputElement>('input')!)
  expect(inputs[0].labels?.[0].textContent).toContain(locale === 'zh-CN' ? '批注最大建议数' : 'Suggested maximum annotations')
  expect(inputs[0].value).toBe('')
  expect(inputs[0].max).toBe('')
  inputs[0].value = '85'; inputs[0].dispatchEvent(new dom.window.Event('change'))
  expect(readAnalysisAnnotationSuggestion(host)).toBe(85)
  expect(inputs[1].value).toBe('85')
  inputs[1].value = ''; inputs[1].dispatchEvent(new dom.window.Event('change'))
  expect(values.get(KEY)).toBe('')
  expect(readAnalysisAnnotationSuggestion(host)).toBeUndefined()
  expect(inputs[0].value).toBe('')
  stops.forEach(stop => stop()); expect(observers.size).toBe(0); expect(dom.window.document.querySelector('input')).toBeNull()
  dom.window.close()
})

it.each([undefined, null, '', 'bad', -1, 0, 2.5, Infinity, {}, Number.MAX_SAFE_INTEGER + 1])('ignores malformed optional suggestion %j', value => {
  const { host, values } = fixture(); values.set(KEY, value)
  expect(readAnalysisAnnotationSuggestion(host)).toBeUndefined()
})

it.each(['zh-CN', 'en-US'])('defaults reference extraction to off and persists changes from either host in %s', locale => {
  initializeUiLocale({ locale })
  const { host, values, observers } = fixture()
  const dom = new JSDOM('<div id="manager"></div><div id="native"></div>')
  const roots = [...dom.window.document.querySelectorAll<HTMLElement>('div')]
  const stops = roots.map(root => wireAnalysisSettings(host, root))
  const boxes = roots.map(root => root.querySelector<HTMLInputElement>('[data-analysis-references-enabled]')!)
  expect(boxes[0].labels?.[0].textContent).toBe(locale === 'zh-CN' ? '解析文献时自动提取参考文献' : 'Automatically extract references during analysis')
  expect(boxes.every(box => !box.checked)).toBe(true)
  expect(host.Prefs.set).not.toHaveBeenCalled()
  boxes[0].click()
  expect(values.get(ANALYSIS_REFERENCES_PREF)).toBe(true)
  expect(boxes[1].checked).toBe(true)
  stops[0]()
  stops[0] = wireAnalysisSettings(host, roots[0])
  const reopened = roots[0].querySelector<HTMLInputElement>('input[type=checkbox]')!
  expect(reopened.checked).toBe(true)
  boxes[1].click()
  expect(values.get(ANALYSIS_REFERENCES_PREF)).toBe(false)
  expect(reopened.checked).toBe(false)
  stops.forEach(stop => stop())
  expect(observers.size).toBe(0)
  dom.window.close()
})

it('contains unavailable preference reads and failed writes within the setting', () => {
  initializeUiLocale({ locale: 'zh-CN' })
  const { host } = fixture(); host.Prefs.get = () => { throw new Error('Unavailable') }
  expect(readAnalysisAnnotationSuggestion(host)).toBeUndefined()
  expect(readAnalysisReferencesEnabled(host)).toBe(false)
  const dom = new JSDOM('<div></div>'), root = dom.window.document.querySelector('div')!
  const stop = wireAnalysisSettings(host, root)
  host.Prefs.set.mockImplementation(() => { throw new Error('Unavailable') })
  const input = root.querySelector('input')!; input.value = '70'; input.dispatchEvent(new dom.window.Event('change'))
  expect(root.querySelector('[role=status]')?.textContent).toContain('保存失败')
  const checkbox = root.querySelector<HTMLInputElement>('input[type=checkbox]')!
  checkbox.click()
  expect(checkbox.checked).toBe(false)
  expect(checkbox.closest('.jdx-feature-model-row')?.querySelector('[role=status]')?.textContent).toContain('保存失败')
  stop(); dom.window.close()
})
