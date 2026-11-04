/** 两个对话宿主共享证据预览与点击导航；事件委托保留流式渲染后的定位能力。 */
import type { ChatEvidence } from '@/chat/evidence'
import { navigateDocument, type DocumentHost } from './pdf-document'
import { uiText } from './ui-preferences'
import type { ZoteroLike } from './runtime'
import { actionIcon, element } from './ui/controls'

type EvidenceReference = { number: string; entry: ChatEvidence['entries'][number] }
const bindings = new WeakMap<HTMLElement, { set(evidence?: ChatEvidence): void; sources(button: HTMLButtonElement, references: EvidenceReference[]): void; close(): void }>()
const sourceLists = new WeakMap<HTMLElement, string>()
const activeSurfaces = new WeakMap<Document, () => void>()

/** 与 Web App 的 MessageSourceCapsule 一致：消息操作栏只挂触发按钮，列表按需在文档 portal 创建。 */
export function renderEvidenceSources(wrapper: HTMLElement, evidence: ChatEvidence | undefined, complete: boolean) {
  const body = wrapper.querySelector('.jdx-chat-message-body')!
  const references = new Map<string, EvidenceReference>()
  for (const button of Array.from(body.querySelectorAll<HTMLElement>('[data-evidence-id]'))) {
    const entry = evidence?.entries.find(row => row.id === button.dataset.evidenceId)
    if (entry && !references.has(entry.id)) references.set(entry.id, { number: button.dataset.evidenceNumber!, entry })
  }
  const key = JSON.stringify([Boolean(evidence), complete, [...references.values()]])
  if (sourceLists.get(wrapper) === key) return
  bindings.get(wrapper)?.close()
  wrapper.querySelector('[data-evidence-sources-toggle]')?.remove()
  wrapper.querySelector('.jdx-evidence-summary')?.remove()
  sourceLists.set(wrapper, key)
  if (!evidence || (!complete && !references.size)) return
  const doc = wrapper.ownerDocument
  if (!references.size) {
    wrapper.append(element(doc, 'div', 'jdx-evidence-summary', uiText('本次回答未提供可定位的原文引用', 'No traceable original passages cited in this answer')))
    return
  }
  const trigger = element(doc, 'button', 'jdx-evidence-sources-toggle')
  trigger.type = 'button'; trigger.dataset.evidenceSourcesToggle = 'true'
  actionIcon(trigger, 'read', uiText(`查看 ${references.size} 处原文来源`, `View ${references.size} original sources`))
  trigger.append(element(doc, 'span', '', uiText('来源', 'Sources')), element(doc, 'span', 'jdx-evidence-sources-count', String(references.size)))
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false')
  trigger.addEventListener('click', () => bindings.get(wrapper)?.sources(trigger, [...references.values()]))
  wrapper.querySelector('.jdx-chat-message-actions')!.append(trigger)
}

export function updateEvidenceInteractions(wrapper: HTMLElement, host: ZoteroLike, status: HTMLElement, evidence?: ChatEvidence) {
  let binding = bindings.get(wrapper)
  if (!binding) {
    const doc = wrapper.ownerDocument, win = doc.defaultView!
    let current: ChatEvidence | undefined, anchor: HTMLElement | undefined, popover: HTMLElement | undefined, sourceMode = false
    let observer: MutationObserver | undefined
    let dismissTimer: number | undefined
    const create = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') => element(doc, tag, className, text)
    const close = (restoreFocus = false) => {
      const previous = anchor
      win.clearTimeout(dismissTimer); dismissTimer = undefined
      if (sourceMode) { anchor?.setAttribute('aria-expanded', 'false'); anchor?.removeAttribute('aria-controls') }
      anchor?.removeAttribute('aria-describedby'); anchor = undefined
      popover?.remove(); popover = undefined; sourceMode = false
      if (activeSurfaces.get(doc) === close) activeSurfaces.delete(doc)
      observer?.disconnect(); observer = undefined
      win.removeEventListener('scroll', scroll, true); win.removeEventListener('resize', dismiss); win.removeEventListener('keydown', escape)
      win.removeEventListener('blur', dismiss); win.removeEventListener('pagehide', dismiss)
      doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('focusin', outside)
      if (restoreFocus && previous?.isConnected) previous.focus({ preventScroll: true })
    }
    const dismiss = () => close()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(sourceMode) } }
    // 跨 PDF frame 或窗口的事件目标不一定是 Node，不能直接传给 contains。
    const within = (node: Element | undefined | null, other: EventTarget | null) => Boolean(node && other && 'nodeType' in other && node.contains(other as Node))
    const outside = (event: Event) => { if (!within(popover, event.target) && !within(anchor, event.target)) close() }
    const scroll = (event: Event) => {
      if (within(popover, event.target)) return
      const bounds = anchor?.getBoundingClientRect()
      if (bounds && (Math.abs(bounds.top - anchorTop) > 1 || Math.abs(bounds.left - anchorLeft) > 1)) close()
    }
    let anchorTop = 0, anchorLeft = 0
    const scheduleClose = () => { win.clearTimeout(dismissTimer); dismissTimer = win.setTimeout(close, 180) }
    const target = (event: Event) => (event.target as Element | null)?.closest<HTMLElement>('[data-evidence-id]')
    // 两种证据浮层共用定位、主题和生命周期，且每个宿主最多打开一个。
    const mount = (button: HTMLElement, surface: HTMLElement, dialog = false) => {
      activeSurfaces.get(doc)?.(); close(); anchor = button; popover = surface; sourceMode = dialog
      activeSurfaces.set(doc, close)
      surface.id = `jdx-evidence-surface-${Math.random().toString(36).slice(2)}`
      if (dialog) { button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-controls', surface.id) }
      else button.setAttribute('aria-describedby', surface.id)
      const computed = win.getComputedStyle(wrapper)
      for (const token of ['surface', 'text', 'muted', 'line-strong', 'green', 'font-scale', 'subtle', 'active-bg', 'active-text']) surface.style.setProperty(`--jdx-${token}`, computed.getPropertyValue(`--jdx-${token}`))
      surface.style.fontFamily = computed.fontFamily
      ;(doc.body || doc.documentElement).append(surface)
      surface.style.maxWidth = `${Math.max(120, Math.min(dialog ? 400 : 344, win.innerWidth - 24))}px`
      const bounds = button.getBoundingClientRect(), card = surface.getBoundingClientRect()
      anchorTop = bounds.top; anchorLeft = bounds.left
      surface.style.left = `${Math.max(12, Math.min(dialog ? bounds.right - card.width : bounds.left, win.innerWidth - card.width - 12))}px`
      surface.style.top = `${Math.max(12, bounds.top > card.height + 20 ? bounds.top - card.height - 8 : Math.min(bounds.bottom + 8, win.innerHeight - card.height - 12))}px`
      win.addEventListener('scroll', scroll, true); win.addEventListener('resize', dismiss); win.addEventListener('keydown', escape)
      // 悬停预览与来源列表都响应外部输入；PDF frame 内的输入通过宿主失焦回收。
      win.addEventListener('blur', dismiss); win.addEventListener('pagehide', dismiss)
      doc.addEventListener('pointerdown', outside, true); doc.addEventListener('focusin', outside)
      observer = new (win as Window & typeof globalThis).MutationObserver(() => {
        const readerTab = wrapper.closest('item-details')
        if (!wrapper.isConnected || !anchor?.isConnected || !popover?.isConnected || wrapper.closest('[hidden], [collapsed="true"]')
          || (readerTab && !readerTab.classList.contains('deck-selected'))) close()
      })
      observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'collapsed', 'class'] })
    }
    const show = (event: Event) => {
      if (sourceMode) return
      const button = target(event), entry = current?.entries.find(row => row.id === button?.dataset.evidenceId)
      if (!button || !entry) return
      // 只有回到有效引用才取消关闭；普通正文的冒泡 mouseover 必须保留离开计时。
      win.clearTimeout(dismissTimer); dismissTimer = undefined
      if (anchor === button) return
      const preview = create('aside', 'jdx-evidence-preview')
      preview.setAttribute('role', 'tooltip')
      preview.addEventListener('mouseenter', () => win.clearTimeout(dismissTimer))
      preview.addEventListener('mouseleave', scheduleClose)
      const number = button.dataset.evidenceNumber
      preview.append(create('span', 'jdx-evidence-preview-label', uiText(`引用 ${number} · 第 ${entry.pageLabel} 页`, `Citation ${number} · Page ${entry.pageLabel}`)),
        create('strong', 'jdx-evidence-preview-title', entry.source.title),
        create('blockquote', 'jdx-evidence-preview-quote', entry.quote),
        create('span', 'jdx-evidence-preview-hint', entry.rects.length ? uiText('点击引用，前往原文段落', 'Click the citation to open the passage') : uiText('此来源无段落坐标，点击前往该页', 'Passage coordinates unavailable; click to open the page')))
      mount(button, preview)
    }
    wrapper.addEventListener('mouseover', show); wrapper.addEventListener('focusin', show)
    wrapper.addEventListener('mouseout', event => { if (!sourceMode && target(event) && !within(target(event), event.relatedTarget)) scheduleClose() })
    wrapper.addEventListener('focusout', event => { if (!sourceMode && target(event)) close() })
    const navigate = (button: HTMLElement) => {
      const entry = current?.entries.find(row => row.id === button.dataset.evidenceId)
      close(sourceMode)
      if (!entry) return
      button.setAttribute('aria-busy', 'true')
      void navigateDocument(host as unknown as DocumentHost, entry.source, { pageIndex: entry.pageIndex, rects: entry.rects }).then(() => {
        status.textContent = uiText(`已打开第 ${entry.pageLabel} 页${entry.rects.length ? '的原文段落' : '（仅页码定位）'}。`, `Opened page ${entry.pageLabel}${entry.rects.length ? ' at the original passage' : ' (page location only)'}.`)
        status.dataset.state = 'success'
      }).catch(() => {
        status.textContent = uiText('原 PDF 已变化或不可用，请重新关联后提问；历史引文仍可查看。', 'The original PDF changed or is unavailable. Link it again and ask; the saved excerpt remains readable.')
        status.dataset.state = 'error'
      }).finally(() => button.removeAttribute('aria-busy'))
    }
    wrapper.addEventListener('click', event => {
      const button = target(event)
      if (button) { event.preventDefault(); event.stopPropagation(); navigate(button) }
    })
    binding = {
      close,
      set(value) { if (JSON.stringify(current) !== JSON.stringify(value)) close(); current = value },
      sources(button, references) {
        if (sourceMode && anchor === button) { close(true); return }
        const panel = create('aside', 'jdx-evidence-sources')
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', uiText('来源列表', 'Sources'))
        const header = create('header', 'jdx-evidence-sources-heading')
        const title = create('strong', '', uiText('来源列表', 'Sources'))
        const dismissButton = create('button', 'jdx-evidence-sources-close')
        dismissButton.type = 'button'; actionIcon(dismissButton, 'close', uiText('关闭来源列表', 'Close sources'))
        dismissButton.addEventListener('click', () => close(true))
        header.append(title, create('span', 'jdx-evidence-sources-count', String(references.length)), dismissButton)
        const list = create('ol', 'jdx-evidence-source-list')
        for (const { number, entry } of references) {
          const item = create('li', 'jdx-evidence-source-item'), row = create('button', 'jdx-evidence-source')
          row.type = 'button'; row.dataset.evidenceId = entry.id; row.dataset.evidenceNumber = number; row.title = entry.source.title
          row.setAttribute('aria-label', uiText(`引用 ${number}：${entry.source.title}，打开原文`, `Citation ${number}: ${entry.source.title}, open original passage`))
          const content = create('span', 'jdx-evidence-source-content')
          content.append(create('span', 'jdx-evidence-source-title', entry.source.title), create('span', 'jdx-evidence-source-quote', entry.quote))
          row.append(create('span', 'jdx-evidence-source-number', number), content)
          row.addEventListener('click', () => navigate(row)); item.append(row); list.append(item)
        }
        panel.append(header, list); mount(button, panel, true); dismissButton.focus({ preventScroll: true })
      },
    }; bindings.set(wrapper, binding)
  }
  binding.set(evidence)
}
