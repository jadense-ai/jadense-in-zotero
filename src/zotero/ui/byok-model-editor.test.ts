import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { placeByokModelEditor, readByokModelEditorMode, setByokModelEditorMode } from './byok-model-editor'

/** 模型条目与展开表单在 Manager 和 Preferences 使用同一排列规则。 */
describe('BYOK model editor placement', () => {
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
})
