/** 通过真实 Reader 选文入口验证字号、Markdown、偏好和浮窗生命周期，不访问真实文库。 */
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerReaderTools, type ZoteroReaderHost } from './reader-tools'

const FONT_PREF = 'extensions.jadenseInZotero.selectionTranslationFontScale'
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function fixture(options: { saved?: unknown; broken?: boolean; locale?: string } = {}) {
  const values = new Map<string, unknown>([[FONT_PREF, options.saved], ['extensions.jadenseInZotero.fontScale', '150']])
  const observers = new Map<object, { key: string; update: () => void }>()
  const register = vi.fn()
  const host: ZoteroReaderHost = {
    locale: options.locale ?? 'zh-CN',
    Reader: { registerEventListener: register, unregisterEventListener: vi.fn() },
    Prefs: {
      get: key => { if (options.broken) throw new Error('Synthetic unavailable preferences'); return values.get(key) },
      set: (key, value) => {
        if (options.broken) throw new Error('Synthetic unavailable preferences')
        values.set(key, value)
        for (const observer of observers.values()) if (observer.key === key) observer.update()
      },
      registerObserver: (key, update) => {
        if (options.broken) throw new Error('Synthetic unavailable observer')
        const id = {}; observers.set(id, { key, update }); return id
      },
      unregisterObserver: id => { observers.delete(id as object) },
    },
  }
  const onAction = vi.fn(async () => ({ translation: '## 译文标题\n\n译文正文与 **强调**。\n\n- 列表\n\n`code`' }))
  const stop = registerReaderTools(host, 'selection-font-test', onAction)
  cleanups.push(stop)
  const open = async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
    cleanups.push(() => dom.window.close())
    const doc = dom.window.document
    const render = register.mock.calls.find(([type]) => type === 'renderTextSelectionPopup')![1]
    render({ reader: { itemID: 11 }, doc, append: (node: HTMLElement) => doc.body.append(node),
      params: { annotation: { text: 'Original source', position: { pageIndex: 0 }, pageLabel: '1' } } })
    const translate = doc.querySelector<HTMLButtonElement>('[data-jadense-reader-tools] button')!
    translate.click()
    const panel = doc.querySelector<HTMLElement>('[data-jadense-translation-panel]')!
    const result = panel.querySelector<HTMLElement>('.jadense-translation-result')!
    await vi.waitFor(() => expect(result.querySelector('h2')?.textContent).toBe('译文标题'))
    return { dom, doc, panel, result, translate,
      size: panel.querySelector<HTMLInputElement>('[data-jdx-selection-translation-font-size]') }
  }
  return { host, values, observers, onAction, open, stop }
}

describe('selected-text translation font size', () => {
  it('changes only translated Markdown without replacing its nodes and restores the saved size in another window', async () => {
    const context = fixture(), first = await context.open()
    expect(first.size).not.toBeNull()
    const size = first.size!
    expect([size.min, size.max, size.step, size.value]).toEqual(['80', '200', '10', '100'])
    const heading = first.result.querySelector('h2'), source = first.panel.querySelector<HTMLElement>('.jadense-translation-source .jadense-translation-text')!
    size.value = '160'; size.dispatchEvent(new first.dom.window.Event('input'))
    expect(first.result.style.fontSize).toBe('160%')
    expect(first.result.querySelector('h2')).toBe(heading)
    expect(source.style.fontSize).toBe('')
    expect(first.panel.style.getPropertyValue('--jdx-font-scale')).toBe('1.5')
    expect(size.getAttribute('aria-valuetext')).toBe('160%')
    expect(context.values.get(FONT_PREF)).toBe('160')
    expect(context.onAction).toHaveBeenCalledTimes(1)
    const second = await context.open()
    expect(second.size?.value).toBe('160')
    expect(second.result.style.fontSize).toBe('160%')
    second.panel.querySelector<HTMLButtonElement>('[data-jdx-selection-translation-font-reset]')!.click()
    expect(first.result.style.fontSize).toBe('100%')
    expect(second.result.style.fontSize).toBe('100%')
    context.stop()
    expect(context.observers.size).toBe(0)
  })

  it('keeps the chosen size and readable result when optional preference storage fails', async () => {
    const context = fixture({ broken: true }), window = await context.open()
    expect(window.size).not.toBeNull()
    window.size!.value = '180'; window.size!.dispatchEvent(new window.dom.window.Event('input'))
    expect(window.result.style.fontSize).toBe('180%')
    expect(window.result.textContent).toContain('译文正文')
    expect(window.panel.querySelector('[data-jdx-selection-translation-font-status]')?.textContent).toContain('未能保存')
    expect(context.onAction).toHaveBeenCalledTimes(1)
    window.panel.querySelector<HTMLButtonElement>('.jadense-translation-close')!.click()
    window.translate.click()
    await vi.waitFor(() => expect(context.onAction).toHaveBeenCalledTimes(2))
    expect(window.result.style.fontSize).toBe('180%')
  })

  it.each([[undefined, '100'], ['invalid', '100'], [{ future: true }, '100'], ['900', '200'], ['20', '80']])(
    'contains invalid presentation preferences %j without blocking translation', async (saved, expected) => {
      const window = await fixture({ saved }).open()
      expect(window.size?.value).toBe(expected)
      expect(window.result.style.fontSize).toBe(`${expected}%`)
    },
  )

  it('names the control and reset action in English', async () => {
    const window = await fixture({ locale: 'en-US' }).open()
    expect(window.size?.getAttribute('aria-label')).toBe('Translation text size')
    expect(window.panel.querySelector('[data-jdx-selection-translation-font-reset]')?.textContent).toBe('Reset')
  })
})
