import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  formatByokModelSummary,
  formatByokProtocolLabel,
  handleByokProviderListKeydown,
  placeByokModelEditor,
  readByokModelEditorMode,
  setByokModelEditorMode,
  setByokSecretToggleIcon,
} from './byok-model-editor'

/** 模型条目与展开表单在 Manager 和 Preferences 使用同一排列规则与共用交互辅助。 */
describe('BYOK model editor placement and helpers', () => {
  it('keeps the selected row visible and places the form directly after it', () => {
    const dom = new JSDOM('<section><div id="editor" hidden></div><div id="list"><button data-model-id="one">One</button><button data-model-id="two">Two</button></div></section>')
    const doc = dom.window.document
    const editor = doc.getElementById('editor')!
    const list = doc.getElementById('list')!
    setByokModelEditorMode(editor, { kind: 'edit', modelId: 'one' })
    placeByokModelEditor(editor, list, readByokModelEditorMode(editor))
    const one = list.querySelector<HTMLButtonElement>('[data-model-id="one"]')!
    expect(one.hidden).toBe(false)
    expect(one.nextElementSibling).toBe(editor)
    expect(list.querySelector<HTMLButtonElement>('[data-model-id="two"]')).not.toBeNull()
    setByokModelEditorMode(editor, { kind: 'new' })
    placeByokModelEditor(editor, list, readByokModelEditorMode(editor))
    expect(editor.nextElementSibling).toBe(list)
    setByokModelEditorMode(editor, null)
    placeByokModelEditor(editor, list, readByokModelEditorMode(editor))
    expect(editor.hidden).toBe(true)
    dom.window.close()
  })

  it('formats readable protocol labels, model summaries, and toggles eye SVG icons', () => {
    expect(formatByokProtocolLabel('openai-chat-completions')).toBe('OpenAI Chat')
    expect(formatByokProtocolLabel('anthropic-messages')).toBe('Anthropic')
    expect(formatByokProtocolLabel('openai-responses')).toBe('OpenAI Responses')
    expect(formatByokModelSummary({ model: 'mimo-v2.5', contextWindow: 1_000_000, thinkingEfforts: ['low', 'high'] }, 'Empty')).toContain('mimo-v2.5')
    expect(formatByokModelSummary({ model: 'mimo-v2.5', contextWindow: 128_000 }, 'Empty')).toContain('128K')
    expect(formatByokModelSummary({ model: '' }, 'Empty')).toBe('Empty')

    const dom = new JSDOM('<button id="toggle"></button>')
    const button = dom.window.document.getElementById('toggle') as HTMLButtonElement
    setByokSecretToggleIcon(button, false)
    expect(button.querySelector('svg circle')).not.toBeNull()
    setByokSecretToggleIcon(button, true)
    expect(button.querySelector('svg circle')).toBeNull()
    expect(button.querySelector('svg path')?.getAttribute('d')).toContain('M3 3l18 18')
    dom.window.close()
  })

  it('supports ArrowDown, ArrowUp, Home, and End navigation on the provider listbox', () => {
    const dom = new JSDOM('<div id="list" role="listbox"><button data-provider-id="p1" aria-selected="true">P1</button><button data-provider-id="p2" aria-selected="false">P2</button><button data-provider-id="p3" aria-selected="false">P3</button></div>')
    const list = dom.window.document.getElementById('list')!
    const selected: string[] = []
    const onSelect = vi.fn((id: string) => {
      selected.push(id)
      list.querySelectorAll<HTMLButtonElement>('button[data-provider-id]').forEach((btn) => {
        btn.setAttribute('aria-selected', String(btn.dataset.providerId === id))
      })
    })
    const send = (key: string) => handleByokProviderListKeydown(list, new dom.window.KeyboardEvent('keydown', { key, cancelable: true }), onSelect)
    send('ArrowDown')
    send('End')
    send('ArrowUp')
    send('Home')
    expect(selected).toEqual(['p2', 'p3', 'p2', 'p1'])
    expect(dom.window.document.activeElement?.getAttribute('data-provider-id')).toBe('p1')
    dom.window.close()
  })
})
