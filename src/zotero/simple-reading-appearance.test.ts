/** 简阅文字大小的可选偏好故障、跨窗口同步和可访问控件回归。 */
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { createSimpleReadingAppearance, readSimpleReadingFontScale, SIMPLE_READING_FONT_SCALE_PREF } from './simple-reading-appearance'
import type { ZoteroLike } from './runtime'

it('normalizes optional values and keeps reading usable when preferences are missing or unreadable', () => {
  expect(readSimpleReadingFontScale({})).toBe(100)
  for (const value of [undefined, null, '', 'invalid', Infinity]) {
    expect(readSimpleReadingFontScale({ Prefs: { get: () => value } } as unknown as ZoteroLike)).toBe(100)
  }
  expect(readSimpleReadingFontScale({ Prefs: { get: () => { throw new Error('unavailable') } } } as unknown as ZoteroLike)).toBe(100)
  expect(readSimpleReadingFontScale({ Prefs: { get: () => '1000' } } as unknown as ZoteroLike)).toBe(200)
  expect(readSimpleReadingFontScale({ Prefs: { get: () => -10 } } as unknown as ZoteroLike)).toBe(80)
})

it('synchronizes both controls, resets, bounds button steps, and contains save and observer failures', () => {
  const window = new JSDOM('<main></main><aside></aside>').window, doc = window.document
  const changed = vi.fn(), set = vi.fn(() => { throw new Error('storage unavailable') }), unregister = vi.fn()
  let stored = '100', observe = () => {}
  const host = { Prefs: { get: () => stored, set, registerObserver: (key: string, callback: () => void) => { expect(key).toBe(SIMPLE_READING_FONT_SCALE_PREF); observe = callback; return 'font-observer' }, unregisterObserver: unregister } } as unknown as ZoteroLike
  const appearance = createSimpleReadingAppearance(host, changed), main = doc.querySelector('main')!, separate = doc.querySelector('aside')!
  const removeMain = appearance.mount(main), removeSeparate = appearance.mount(separate)
  const range = main.querySelector('input')!, other = separate.querySelector('input')!
  range.value = '200'; range.dispatchEvent(new window.Event('input'))
  expect(appearance.scale()).toBe(2); expect(other.value).toBe('200')
  expect(changed).toHaveBeenCalledOnce(); expect(set).toHaveBeenCalledWith(SIMPLE_READING_FONT_SCALE_PREF, '200', true)
  expect(main.querySelector<HTMLButtonElement>('[aria-label="增大文字"]')!.disabled).toBe(true)
  separate.querySelector<HTMLButtonElement>('[aria-label="减小文字"]')!.click()
  expect(appearance.scale()).toBe(1.9); expect(range.value).toBe('190')
  separate.querySelector<HTMLButtonElement>('[aria-label="恢复默认文字大小"]')!.click()
  expect(range.value).toBe('100'); expect(other.value).toBe('100')
  stored = '80'; observe()
  expect(appearance.scale()).toBe(.8); expect(range.value).toBe('80')
  expect(main.querySelector<HTMLButtonElement>('[aria-label="减小文字"]')!.disabled).toBe(true)
  removeMain(); removeSeparate(); appearance.remove()
  expect(unregister).toHaveBeenCalledWith('font-observer')
  window.close()
})
