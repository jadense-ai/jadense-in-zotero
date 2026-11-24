import type { ByokProtocol } from '@/chat/byok-chat'
import type { ByokModel } from '../ai-settings'
import { uiText } from '../ui-preferences'

/** 两处 BYOK 设置页共用模型编辑器展开位置、模式、列表摘要、密钥图标与键盘导航。 */
export type ByokModelEditorMode = { kind: 'new' } | { kind: 'edit'; modelId: string }

const SVG_NS = 'http://www.w3.org/2000/svg'

const PROTOCOL_LABELS: Record<ByokProtocol, string> = {
  'openai-chat-completions': 'OpenAI Chat',
  'anthropic-messages': 'Anthropic',
  'openai-responses': 'OpenAI Responses',
}

export function formatByokProtocolLabel(protocol: ByokProtocol): string {
  return PROTOCOL_LABELS[protocol] ?? protocol
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000
    return `${Number.isInteger(thousands) ? thousands : Math.round(thousands)}K`
  }
  return String(tokens)
}

export function formatByokModelSummary(
  model: Pick<ByokModel, 'model' | 'contextWindow' | 'thinkingEfforts'>,
  emptyModelLabel: string,
): string {
  const parts = [model.model || emptyModelLabel]
  if (model.contextWindow && model.contextWindow > 0) {
    parts.push(uiText(`${formatCompactTokens(model.contextWindow)} 上下文`, `${formatCompactTokens(model.contextWindow)} ctx`))
  }
  if (model.thinkingEfforts?.length) {
    parts.push(uiText(`${model.thinkingEfforts.length} 档思考`, `${model.thinkingEfforts.length} efforts`))
  }
  return parts.join(' · ')
}

export function setByokSecretToggleIcon(button: HTMLButtonElement, revealed: boolean) {
  const doc = button.ownerDocument
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  if (revealed) {
    const eye = doc.createElementNS(SVG_NS, 'path')
    eye.setAttribute('d', 'M3 3l18 18M10.6 10.6a2.5 2.5 0 0 0 2.8 2.8M9.9 5.2A10.7 10.7 0 0 1 12 5c6.1 0 9.5 7 9.5 7a16.4 16.4 0 0 1-3.1 4.1M6.6 6.6A16.5 16.5 0 0 0 2.5 12s3.4 7 9.5 7a10.4 10.4 0 0 0 5.4-1.5')
    svg.append(eye)
  } else {
    const eye = doc.createElementNS(SVG_NS, 'path')
    eye.setAttribute('d', 'M2.5 12s3.4-5 9.5-5 9.5 5 9.5 5-3.4 5-9.5 5-9.5-5-9.5-5Z')
    const pupil = doc.createElementNS(SVG_NS, 'circle')
    pupil.setAttribute('cx', '12')
    pupil.setAttribute('cy', '12')
    pupil.setAttribute('r', '2.5')
    svg.append(eye, pupil)
  }
  button.replaceChildren(svg)
}

export function handleByokProviderListKeydown(
  list: HTMLElement,
  event: KeyboardEvent,
  onSelect: (providerId: string) => void,
) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const options = Array.from(list.querySelectorAll<HTMLButtonElement>('button[data-provider-id]'))
  if (!options.length) return
  const currentIndex = options.findIndex((button) => button === list.ownerDocument.activeElement || button.getAttribute('aria-selected') === 'true')
  const start = currentIndex >= 0 ? currentIndex : 0
  const nextIndex = event.key === 'Home' ? 0
    : event.key === 'End' ? options.length - 1
    : event.key === 'ArrowDown' ? (start + 1) % options.length
    : (start - 1 + options.length) % options.length
  const nextId = options[nextIndex]?.dataset.providerId
  if (!nextId) return
  event.preventDefault()
  onSelect(nextId)
  list.querySelector<HTMLButtonElement>(`button[data-provider-id="${nextId}"]`)?.focus()
}

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
