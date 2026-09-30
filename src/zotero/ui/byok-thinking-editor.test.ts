import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { createByokThinkingEditor } from './byok-thinking-editor'

/** 两处设置页使用同一无宿主依赖控件，检查多选、搜索和恢复默认。 */
describe('BYOK thinking editor', () => {
  it('offers common values, preserves arbitrary values, and restores the default three', () => {
    const dom = new JSDOM('<main><div id="thinking"></div></main>')
    const host = dom.window.document.getElementById('thinking')!
    const editor = createByokThinkingEditor(host)
    const trigger = host.querySelector<HTMLButtonElement>('.jdx-byok-thinking-trigger')!
    expect(editor.getValues()).toBeUndefined()
    expect(trigger.textContent).toContain('low, medium, high')
    trigger.click()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelectorAll<HTMLInputElement>('.jdx-byok-thinking-option input')).toHaveLength(8)
    const medium = [...host.querySelectorAll<HTMLInputElement>('.jdx-byok-thinking-option input')].find(input => input.dataset.effort === 'medium')!
    medium.checked = false
    medium.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    expect(editor.getValues()).toEqual(['low', 'high'])
    expect(dom.window.document.activeElement?.getAttribute('data-effort')).toBe('medium')
    const custom = host.querySelector<HTMLInputElement>('.jdx-byok-thinking-add input')!
    custom.value = ' custom-level '
    custom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(editor.getValues()).toEqual(['low', 'high', 'custom-level'])
    const search = host.querySelector<HTMLInputElement>('input[type=search]')!
    search.value = 'custom'
    search.dispatchEvent(new dom.window.Event('input'))
    expect(host.querySelectorAll('.jdx-byok-thinking-option')).toHaveLength(1)
    host.querySelector<HTMLButtonElement>('.jdx-byok-thinking-reset')!.click()
    expect(editor.getValues()).toBeUndefined()
    expect(trigger.textContent).toContain('low, medium, high')
    expect(search.value).toBe('')
    search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    dom.window.close()
  })

  it('reopens a saved single custom level without merging defaults', () => {
    const dom = new JSDOM('<div id="thinking"></div>')
    const host = dom.window.document.getElementById('thinking')!
    const editor = createByokThinkingEditor(host)
    editor.setValues([' ultra ', 'ultra', 'auto', ''])
    expect(editor.getValues()).toEqual(['ultra'])
    host.querySelector<HTMLButtonElement>('.jdx-byok-thinking-trigger')!.click()
    expect([...host.querySelectorAll<HTMLInputElement>('.jdx-byok-thinking-option input')].filter(input => input.checked).map(input => input.dataset.effort)).toEqual(['ultra'])
    const ultra = [...host.querySelectorAll<HTMLInputElement>('.jdx-byok-thinking-option input')].find(input => input.dataset.effort === 'ultra')!
    ultra.checked = false
    ultra.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    expect(editor.getValues()).toBeUndefined()
    expect(host.querySelector<HTMLButtonElement>('.jdx-byok-thinking-trigger')!.textContent).toContain('保存后恢复默认')
    dom.window.close()
  })
})
