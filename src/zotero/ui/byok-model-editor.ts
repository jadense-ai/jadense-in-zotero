/** 两处 BYOK 设置页共用模型编辑器展开位置和模式，保留原目录条目。 */
export type ByokModelEditorMode = { kind: 'new' } | { kind: 'edit'; modelId: string }

export function readByokModelEditorMode(editor: HTMLElement): ByokModelEditorMode | null {
  if (editor.dataset.mode === 'new') return { kind: 'new' }
  if (editor.dataset.mode === 'edit' && editor.dataset.modelId) return { kind: 'edit', modelId: editor.dataset.modelId }
  return null
}

export function setByokModelEditorMode(editor: HTMLElement, mode: ByokModelEditorMode | null) {
  if (!mode) {
    delete editor.dataset.mode
    delete editor.dataset.modelId
    return
  }
  editor.dataset.mode = mode.kind
  if (mode.kind === 'edit') editor.dataset.modelId = mode.modelId
  else delete editor.dataset.modelId
}

export function placeByokModelEditor(editor: HTMLElement, list: HTMLElement, mode: ByokModelEditorMode | null) {
  const panel = list.parentElement
  if (!panel) return
  editor.hidden = !mode
  panel.insertBefore(editor, list)
  if (mode?.kind !== 'edit') return
  const selected = Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-model-id]')).find(button => button.dataset.modelId === mode.modelId)
  if (selected) list.insertBefore(editor, selected.nextSibling)
}
