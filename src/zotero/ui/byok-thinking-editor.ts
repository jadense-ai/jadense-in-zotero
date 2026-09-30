import { BYOK_THINKING_PRESETS, DEFAULT_BYOK_THINKING_EFFORTS, normalizeByokThinkingEfforts } from '../ai-settings'
import { uiText } from '../ui-preferences'

/** Manager HTML 与原生 Preferences XUL 共用的 BYOK 模型档位编辑控件。 */
export type ByokThinkingEditor = {
  setValues(value?: readonly string[]): void
  getValues(): string[] | undefined
}

const XHTML = 'http://www.w3.org/1999/xhtml'

export function createByokThinkingEditor(host: HTMLElement): ByokThinkingEditor {
  const doc = host.ownerDocument
  const make = <T extends HTMLElement>(tag: string) => doc.createElementNS(XHTML, tag) as T
  const label = make<HTMLSpanElement>('span')
  label.className = 'jdx-pref-field-label'
  label.textContent = uiText('思考档位', 'Thinking efforts')
  const trigger = make<HTMLButtonElement>('button')
  trigger.type = 'button'
  trigger.className = 'jdx-byok-thinking-trigger'
  trigger.setAttribute('aria-haspopup', 'true')
  trigger.setAttribute('aria-expanded', 'false')
  const control = make<HTMLDivElement>('div')
  control.className = 'jdx-byok-thinking-control'
  const popup = make<HTMLDivElement>('div')
  popup.className = 'jdx-byok-thinking-popup'
  popup.hidden = true
  popup.id = `${host.id}-popup`
  trigger.setAttribute('aria-controls', popup.id)
  const search = make<HTMLInputElement>('input')
  search.type = 'search'
  search.autocomplete = 'off'
  search.placeholder = uiText('搜索思考档位…', 'Search thinking efforts…')
  search.setAttribute('aria-label', search.placeholder)
  const choices = make<HTMLDivElement>('div')
  choices.className = 'jdx-byok-thinking-options'
  choices.setAttribute('role', 'group')
  choices.setAttribute('aria-label', uiText('可选思考档位', 'Available thinking efforts'))
  const addRow = make<HTMLDivElement>('div')
  addRow.className = 'jdx-byok-thinking-add'
  const customInput = make<HTMLInputElement>('input')
  customInput.type = 'text'
  customInput.autocomplete = 'off'
  customInput.placeholder = uiText('添加自定义档位', 'Add a custom effort')
  customInput.setAttribute('aria-label', customInput.placeholder)
  const add = make<HTMLButtonElement>('button')
  add.type = 'button'
  add.textContent = uiText('添加', 'Add')
  addRow.append(customInput, add)
  const reset = make<HTMLButtonElement>('button')
  reset.type = 'button'
  reset.className = 'jdx-byok-thinking-reset'
  reset.textContent = uiText('恢复默认：low、medium、high', 'Restore default: low, medium, high')
  const hint = make<HTMLParagraphElement>('p')
  hint.className = 'jdx-pref-card-note'
  hint.textContent = uiText('不自定义时使用 low、medium、high；请求档位仍在功能模型选择器中设置。', 'Without customization, low, medium, and high are available. Choose the request effort in the feature model selector.')
  popup.append(search, choices, addRow, reset)
  host.classList.add('jdx-byok-thinking-editor')
  control.append(trigger, popup)
  host.append(label, control, hint)

  let selected = new Set<string>(DEFAULT_BYOK_THINKING_EFFORTS)
  let customized = false
  const orderedValues = () => {
    const presets = BYOK_THINKING_PRESETS.filter(value => selected.has(value))
    const extras = [...selected].filter(value => !BYOK_THINKING_PRESETS.includes(value as typeof BYOK_THINKING_PRESETS[number]))
    return [...presets, ...extras]
  }
  const render = () => {
    const values = orderedValues()
    trigger.textContent = values.length ? `${values.join(', ')}${customized ? '' : uiText('（默认）', ' (default)')}`
      : uiText('未选档位（保存后恢复默认）', 'No efforts selected (saving restores defaults)')
    trigger.title = trigger.textContent
    trigger.setAttribute('aria-label', `${label.textContent}: ${trigger.textContent}`)
    const query = search.value.trim().toLowerCase()
    const candidates = [...BYOK_THINKING_PRESETS, ...values.filter(value => !BYOK_THINKING_PRESETS.includes(value as typeof BYOK_THINKING_PRESETS[number]))]
    choices.replaceChildren(...candidates.filter(value => value.toLowerCase().includes(query)).map(value => {
      const row = make<HTMLLabelElement>('label')
      row.className = 'jdx-byok-thinking-option'
      const checkbox = make<HTMLInputElement>('input')
      checkbox.type = 'checkbox'
      checkbox.dataset.effort = value
      checkbox.checked = selected.has(value)
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(value)
        else selected.delete(value)
        customized = true
        render()
        Array.from(choices.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(input => input.dataset.effort === value)?.focus()
      })
      const name = make<HTMLSpanElement>('span')
      name.textContent = value
      row.append(checkbox, name)
      return row
    }))
  }
  const close = () => { popup.hidden = true; trigger.setAttribute('aria-expanded', 'false') }
  trigger.addEventListener('click', () => {
    if (!popup.hidden) { close(); return }
    popup.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    search.focus()
  })
  host.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || popup.hidden) return
    event.preventDefault()
    close()
    trigger.focus()
  })
  host.addEventListener('focusout', () => {
    doc.defaultView?.setTimeout(() => { if (!host.contains(doc.activeElement)) close() }, 0)
  })
  const outside = (event: Event) => { if (!host.isConnected) { doc.removeEventListener('pointerdown', outside); return }; if (!host.contains(event.target as Node)) close() }
  doc.addEventListener('pointerdown', outside)
  search.addEventListener('input', render)
  const addCustom = () => {
    const value = customInput.value.trim()
    if (!value || value === 'auto') return
    selected.add(value)
    customized = true
    customInput.value = ''
    search.value = ''
    render()
    customInput.focus()
  }
  add.addEventListener('click', addCustom)
  customInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addCustom() } })
  reset.addEventListener('click', () => {
    selected = new Set(DEFAULT_BYOK_THINKING_EFFORTS)
    customized = false
    search.value = ''
    render()
  })
  render()
  return {
    setValues(value) {
      const normalized = normalizeByokThinkingEfforts(value)
      selected = new Set(normalized ?? DEFAULT_BYOK_THINKING_EFFORTS)
      customized = Boolean(normalized)
      search.value = ''
      customInput.value = ''
      close()
      render()
    },
    getValues: () => customized && selected.size ? orderedValues() : undefined,
  }
}
