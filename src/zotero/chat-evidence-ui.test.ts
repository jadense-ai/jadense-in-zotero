/** 消息 DOM 与宿主导航边界：使用真实共享渲染，合成 Zotero Reader。 */
import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { renderMessage } from './chat-message-ui'
import { mountChatComposer } from './chat-composer-ui'
import { bindChatEvidenceToggle, CHAT_EVIDENCE_PREF_KEY } from './chat-evidence-settings'
import type { ZoteroLike } from './runtime'
import type { LocalChatMessage } from '@/chat/local-chat-store'

function fixture() {
  const dom = new JSDOM('<!doctype html><main><div id="log"></div><div id="status"></div><button id="latest"></button></main>', { url: 'https://zotero-test.invalid/' })
  const doc = dom.window.document
  const item = { id: 2, libraryID: 7, key: 'PDF2', attachmentModificationTime: 12, isPDFAttachment: () => true }
  const navigate = vi.fn(), open = vi.fn(async () => ({ navigate }))
  const host = { Items: { get: () => item }, Reader: { open } } as unknown as ZoteroLike
  const elements = { messageList: doc.getElementById('log')!, chatStatus: doc.getElementById('status')!, chatLatest: doc.getElementById('latest') as HTMLButtonElement }
  const message: LocalChatMessage = { id: 'm1', role: 'assistant', text: '**Effect** [[evidence:s1b1]]', status: 'streaming', createdAt: '2026-11-04T00:00:00Z', evidence: { entries: [{
    id: 's1b1', sourceNumber: 1, source: { itemID: 2, libraryID: 7, itemKey: 'PDF2', title: '<script>paper</script>', modificationTime: 12 },
    pageIndex: 2, pageLabel: 'iii', quote: '<img src=x> is plain source text.', rects: [[10, 20, 300, 40]],
  }] } }
  const wrapper = renderMessage(elements, host, message); elements.messageList.append(wrapper)
  return { dom, doc, item, navigate, open, host, elements, message, wrapper }
}

describe('chat evidence UI', () => {
  it('numbers passages in first-citation order and lists unambiguous titles for PDFs with the same page label', async () => {
    const f = fixture(), title = 'Second paper with a very long title '.repeat(12)
    const second = { ...f.message.evidence!.entries[0], id: 's7b3', sourceNumber: 7, source: { ...f.message.evidence!.entries[0].source, itemID: 3, itemKey: 'PDF3', title } }
    f.host.Items!.get = id => ({ ...f.item, id, key: `PDF${id}` }) as never
    const message = { ...f.message, text: 'Second [[evidence:s7b3]] first [[evidence:s1b1]] repeated [[evidence:s7b3]]', evidence: { entries: [...f.message.evidence!.entries, second] } }
    renderMessage(f.elements, f.host, message, f.wrapper)
    const links = Array.from(f.wrapper.querySelectorAll<HTMLButtonElement>('.jdx-chat-message-body [data-evidence-id]'))
    expect(links.map(button => button.textContent)).toEqual(['1', '2', '1'])
    const trigger = f.wrapper.querySelector<HTMLButtonElement>('.jdx-chat-message-actions [data-evidence-sources-toggle]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(f.doc.querySelector('.jdx-evidence-sources')).toBeNull()
    trigger.click()
    const panel = f.doc.querySelector('.jdx-evidence-sources')!
    expect(panel.parentElement).toBe(f.doc.body)
    expect(f.wrapper.contains(panel)).toBe(false)
    const sources = Array.from(panel.querySelectorAll<HTMLButtonElement>('.jdx-evidence-source'))
    expect(sources.map(button => button.dataset.evidenceId)).toEqual(['s7b3', 's1b1'])
    expect(sources[0].querySelector('.jdx-evidence-source-title')?.textContent).toBe(title)
    expect(sources[0].title).toBe(title)
    expect(sources[0].textContent).not.toContain('iii')
    renderMessage(f.elements, f.host, { ...message, text: message.text + ' continued', evidence: structuredClone(message.evidence) }, f.wrapper)
    expect(f.doc.querySelector('.jdx-evidence-sources')).toBe(panel)
    expect(f.wrapper.querySelector('[data-evidence-sources-toggle]')).toBe(trigger)
    sources[0].click()
    await vi.waitFor(() => expect(f.open).toHaveBeenLastCalledWith(3, { pageIndex: 2 }))
    expect(f.doc.querySelector('.jdx-evidence-sources')).toBeNull()
    links[1].click()
    await vi.waitFor(() => expect(f.open).toHaveBeenLastCalledWith(2, { pageIndex: 2 }))
    f.dom.window.close()
  })
  it('keeps many sources outside the message and dismisses the panel with keyboard, toggle, outside click and removal', async () => {
    const f = fixture()
    const entries = Array.from({ length: 24 }, (_, index) => ({ ...f.message.evidence!.entries[0], id: `s1b${index + 1}` }))
    renderMessage(f.elements, f.host, { ...f.message, text: entries.map(entry => `Claim [[evidence:${entry.id}]]`).join(' '), evidence: { entries } }, f.wrapper)
    const trigger = f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-sources-toggle]')!
    const closedChildren = f.wrapper.children.length
    trigger.click()
    expect(f.doc.querySelectorAll('.jdx-evidence-source')).toHaveLength(24)
    expect(f.wrapper.children).toHaveLength(closedChildren)
    expect(f.wrapper.querySelector('.jdx-evidence-source-list')).toBeNull()
    f.dom.window.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(f.doc.activeElement).toBe(trigger)
    trigger.click(); trigger.click()
    expect(f.doc.querySelector('[role=dialog]')).toBeNull()
    trigger.click()
    f.doc.body.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { bubbles: true }))
    expect(f.doc.querySelector('[role=dialog]')).toBeNull()
    trigger.click(); f.wrapper.remove()
    await vi.waitFor(() => expect(f.doc.querySelector('[role=dialog]')).toBeNull())
    f.dom.window.close()
  })
  it('switches source panels between messages without leaving an old panel behind', () => {
    const f = fixture()
    const second = renderMessage(f.elements, f.host, { ...f.message, id: 'm2' }); f.elements.messageList.append(second)
    const firstTrigger = f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-sources-toggle]')!
    firstTrigger.click()
    second.querySelector<HTMLButtonElement>('[data-evidence-sources-toggle]')!.click()
    expect(f.doc.querySelectorAll('[role=dialog]')).toHaveLength(1)
    expect(firstTrigger.getAttribute('aria-expanded')).toBe('false')
    renderMessage(f.elements, f.host, { ...f.message, id: 'm2', evidence: { entries: [] } }, second)
    expect(f.doc.querySelector('[role=dialog]')).toBeNull()
    f.dom.window.close()
  })
  it('previews inert source text and navigates to saved physical page and rectangles during streaming', async () => {
    const f = fixture(), button = f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-id]')!
    button.focus()
    expect(f.doc.querySelector('[role=tooltip]')?.textContent).toContain('<img src=x>')
    expect(f.doc.querySelector('[role=tooltip] img')).toBeNull()
    button.click()
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith({ position: { pageIndex: 2, rects: [[10, 20, 300, 40]] } }))
    expect(f.open).toHaveBeenCalledWith(2, { pageIndex: 2 })
    expect(f.doc.querySelector('[role=tooltip]')).toBeNull()
    f.dom.window.close()
  })
  it('dismisses a hover preview after moving from its citation or excerpt to ordinary message text', () => {
    vi.useFakeTimers()
    const f = fixture(), button = f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-id]')!, text = f.wrapper.querySelector('strong')!
    try {
      button.dispatchEvent(new f.dom.window.MouseEvent('mouseover', { bubbles: true }))
      expect(f.doc.querySelector('[role=tooltip]')).not.toBeNull()
      button.dispatchEvent(new f.dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: text }))
      text.dispatchEvent(new f.dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: button }))
      vi.advanceTimersByTime(200)
      expect(f.doc.querySelector('[role=tooltip]')).toBeNull()

      button.dispatchEvent(new f.dom.window.MouseEvent('mouseover', { bubbles: true }))
      const preview = f.doc.querySelector('[role=tooltip]')!
      button.dispatchEvent(new f.dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: preview }))
      preview.dispatchEvent(new f.dom.window.MouseEvent('mouseenter'))
      vi.advanceTimersByTime(200)
      expect(f.doc.querySelector('[role=tooltip]')).toBe(preview)
      preview.dispatchEvent(new f.dom.window.MouseEvent('mouseleave', { relatedTarget: text }))
      text.dispatchEvent(new f.dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: preview }))
      vi.advanceTimersByTime(200)
      expect(f.doc.querySelector('[role=tooltip]')).toBeNull()
    } finally { f.dom.window.close(); vi.useRealTimers() }
  })
  it('dismisses a preview on outside pointer input without requiring the citation to lose keyboard focus', () => {
    const f = fixture(), button = f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-id]')!
    button.focus()
    f.wrapper.querySelector('strong')!.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { bubbles: true }))
    expect(f.doc.querySelector('[role=tooltip]')).toBeNull()
    expect(button.hasAttribute('aria-describedby')).toBe(false)
    f.dom.window.close()
  })
  it('closes both evidence surfaces when focus leaves the host for a PDF frame or another window', () => {
    const f = fixture(), button = f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-id]')!
    button.dispatchEvent(new f.dom.window.MouseEvent('mouseover', { bubbles: true }))
    f.dom.window.dispatchEvent(new f.dom.window.FocusEvent('blur'))
    expect(f.doc.querySelector('[role=tooltip]')).toBeNull()
    const trigger = f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-sources-toggle]')!
    trigger.click()
    f.dom.window.dispatchEvent(new f.dom.window.FocusEvent('blur'))
    expect(f.doc.querySelector('[role=dialog]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    f.dom.window.close()
  })
  it('cleans up a Reader preview when its native PDF tab is no longer selected', async () => {
    const f = fixture(), detail = f.doc.createElement('item-details')
    detail.className = 'deck-selected'; f.doc.body.append(detail); detail.append(f.elements.messageList)
    f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-id]')!.focus()
    detail.classList.remove('deck-selected')
    await vi.waitFor(() => expect(f.doc.querySelector('[role=tooltip]')).toBeNull())
    f.dom.window.close()
  })
  it('refuses stale attachment navigation locally and keeps the answer and preview', async () => {
    const f = fixture(); f.item.key = 'REPLACED'
    f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-id]')!.click()
    await vi.waitFor(() => expect(f.elements.chatStatus.dataset.state).toBe('error'))
    expect(f.open).not.toHaveBeenCalled(); expect(f.navigate).not.toHaveBeenCalled()
    expect(f.wrapper.textContent).toContain('Effect')
    f.dom.window.close()
  })
  it('updates only metadata when history loses optional locators and degrades to unavailable', () => {
    const f = fixture()
    renderMessage(f.elements, f.host, { ...f.message, evidence: { entries: [] } }, f.wrapper)
    expect(f.wrapper.querySelector('[data-evidence-id]')).toBeNull()
    expect(f.wrapper.textContent).toContain('来源不可用')
    f.dom.window.close()
  })
  it('uses an explicit page-only affordance when coordinates are absent', async () => {
    const f = fixture(); f.message.evidence!.entries[0].rects = []
    renderMessage(f.elements, f.host, { ...f.message, status: 'complete' }, f.wrapper)
    const button = f.wrapper.querySelector<HTMLButtonElement>('[data-evidence-id]')!
    expect(button.getAttribute('aria-label')).toContain('仅定位到页'); button.click()
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith({ pageIndex: 2 }))
    f.dom.window.close()
  })
  it('synchronizes toggles and restores the saved value without dispatching or stopping a chat', () => {
    const f = fixture(), values = new Map<string, unknown>(), observers = new Set<() => void>()
    f.host.Prefs = { get: key => values.get(key), set: (key, value) => { values.set(key, value); observers.forEach(fn => fn()) }, clear() {},
      registerObserver: (_key, fn) => { observers.add(fn); return fn }, unregisterObserver: id => { observers.delete(id as () => void) } }
    const first = f.doc.createElement('div'), second = f.doc.createElement('div')
    mountChatComposer(first); mountChatComposer(second, 'second')
    const cleanups = [bindChatEvidenceToggle(first, f.host), bindChatEvidenceToggle(second, f.host)]
    const button = first.querySelector<HTMLButtonElement>('[data-chat-evidence-toggle]')!
    expect(button.getAttribute('aria-pressed')).toBe('false'); button.click()
    expect(values.get(CHAT_EVIDENCE_PREF_KEY)).toBe(true)
    expect(second.querySelector('[data-chat-evidence-toggle]')?.getAttribute('aria-pressed')).toBe('true')
    cleanups.forEach(fn => fn()); expect(observers.size).toBe(0)
    f.dom.window.close()
  })
})
