/** 用最小宿主 DOM 驱动真实侧栏打开链路；只替换业务视图，不替换原生/停靠恢复逻辑。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ZoteroLike } from './runtime'

const mocks = vi.hoisted(() => ({ chat: vi.fn(), jobs: vi.fn(), traces: [] as string[] }))
vi.mock('./reader-chat', () => ({ mountReaderChat: mocks.chat }))
vi.mock('./document-jobs', () => ({ documentJobs: mocks.jobs }))
vi.mock('./document-results', () => ({ resultLabels: () => ({ source: 'Source', translation: 'Translation', selection: 'Selection' }), mountDocumentResults: vi.fn() }))
vi.mock('./translation-reader', () => ({ installTranslationReadingStyles: vi.fn() }))
vi.mock('./research-context', () => ({ collectSourceForItem: async () => null }))
vi.mock('./manager-window', () => ({ openManagerWindow: vi.fn() }))
vi.mock('./ui-preferences', () => ({ observeTheme: () => () => {}, uiText: (_cn: string, en: string) => en }))
vi.mock('./ui/select', () => ({ createJdxSelect: () => ({ setOptions() {}, setValue() {}, close() {}, destroy() {}, onChange() {} }) }))
vi.mock('./chat-message-ui', () => ({ messageAction: (doc: Document) => doc.createElement('button') }))
import { openChatSidebar, openTranslationSidebar, removeReaderSidebars, renderNativeReaderSidebar } from './reader-sidebar'

class Node extends EventTarget {
  children: Node[] = []; parentElement: Node | null = null; dataset: Record<string, string> = {}; attributes = new Map<string, string>()
  style = { width: '', minWidth: '', height: '', setProperty: (key: string, value: string) => this.attributes.set(key, value) }
  className = ''; id = ''; textContent = ''; hidden = false; clientWidth = 1000; tabID = ''; pinnedPane = ''; scrollTop = 0
  classList = { add: (...names: string[]) => { this.className += ` ${names.join(' ')}` }, remove: (...names: string[]) => { this.className = this.className.split(' ').filter(n => !names.includes(n)).join(' ') }, contains: (name: string) => this.className.split(' ').includes(name) }
  constructor(readonly ownerDocument: Doc, readonly tagName: string) { super() }
  get isConnected(): boolean { return this === this.ownerDocument.documentElement || Boolean(this.parentElement?.isConnected) }
  append(...nodes: Node[]) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this } }
  replaceChildren(...nodes: Node[]) { for (const child of [...this.children]) child.remove(); this.append(...nodes) }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null }
  setAttribute(key: string, value: string) { this.attributes.set(key, value) }
  getAttribute(key: string) { return this.attributes.get(key) ?? null }
  removeAttribute(key: string) { this.attributes.delete(key) }
  matches(selector: string) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : selector.startsWith('#') ? this.id === selector.slice(1) : selector === '[data-type="body"]' ? this.dataset.type === 'body' : this.tagName === selector }
  closest(selector: string): Node | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  querySelectorAll(selector: string): Node[] { if (selector.includes('item-pane-custom-section[')) selector = '[data-type="body"]'; return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  getBoundingClientRect() { return { top: 0, width: this.clientWidth, height: 600 } }
  focus() {} setPointerCapture() {}
}
class Doc extends EventTarget {
  defaultView = Object.assign(new EventTarget(), { innerWidth: 1200, closed: false })
  documentElement = new Node(this, 'html'); head = new Node(this, 'head'); body = new Node(this, 'body')
  constructor() { super(); this.documentElement.append(this.head, this.body) }
  createElement(tag: string) { return new Node(this, tag) }
  createElementNS(_ns: string, tag: string) { return this.createElement(tag) }
  getElementById(id: string) { return this.querySelector(`#${id}`) }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
}
const hosts: ZoteroLike[] = []
function fixture(native = false) {
  const doc = new Doc(), pdf = new Doc(), parent = doc.createElement('div'), browser = doc.createElement('browser')
  doc.body.append(parent); parent.append(browser)
  const detail = Object.assign(doc.createElement('item-details'), { tabID: 'tab-1', render: vi.fn(async () => {}), scrollToPane: vi.fn(async () => {}) })
  detail.classList.add('deck-selected')
  const contextPane = doc.createElement('context-pane'); contextPane.id = 'zotero-context-pane'
  Object.defineProperty(contextPane, 'collapsed', { get: () => contextPane.getAttribute('collapsed') === 'true', set: (value: boolean) => contextPane.setAttribute('collapsed', String(value)) })
  doc.body.append(contextPane); contextPane.append(detail)
  const body = doc.createElement('div'); body.dataset.type = 'body'
  if (native) { const section = doc.createElement('item-pane-custom-section'); section.dataset.pane = 'jadense-in-zotero-sync-panel'; section.append(body); detail.append(section) }
  const reader = { itemID: 1, tabID: 'tab-1', _window: { document: doc }, _iframeWindow: Object.assign(pdf.defaultView, { document: pdf }), _iframe: browser }
  const host = { Reader: { _readers: [reader] }, Prefs: { get: () => undefined, set: vi.fn() } } as unknown as ZoteroLike
  hosts.push(host)
  const open = () => openChatSidebar(host, pdf as unknown as Document, 1, reader as never)
  return { host, doc, pdf, reader, detail, body, parent, contextPane, open }
}
beforeEach(() => { vi.useFakeTimers(); mocks.chat.mockReset().mockImplementation(() => ({ refresh() {}, closeMenus() {}, newSession: vi.fn(async () => {}), remove: vi.fn() })); mocks.jobs.mockReset().mockImplementation(() => { throw new Error('synthetic document runtime failure') }) })
afterEach(() => { for (const host of hosts.splice(0)) removeReaderSidebars(host); vi.useRealTimers() })

it('falls back to a visible dock when native render rejects, without initializing document jobs', async () => {
  const f = fixture(); f.detail.render.mockRejectedValue(new Error('native render'))
  await f.open()
  expect(f.parent.querySelector('.jdx-reader-workspace')).not.toBeNull()
  expect(mocks.jobs).not.toHaveBeenCalled()
})
it('rolls back native activation before using a dock', async () => {
  const f = fixture(true); f.detail.pinnedPane = 'original'; f.detail.scrollToPane.mockRejectedValue(new Error('native scroll'))
  await f.open()
  expect(f.detail.pinnedPane).toBe('original')
  expect(f.detail.getAttribute('data-jdx-reading-active')).toBeNull()
  expect(f.doc.querySelectorAll('.jdx-reader-workspace')).toHaveLength(1)
  expect(f.parent.querySelector('.jdx-reader-workspace')).not.toBeNull()
})
it('deduplicates overlapping opens and keeps the latest navigation', async () => {
  const f = fixture(); let resolve!: () => void
  f.detail.render.mockImplementation(() => new Promise<void>(done => { resolve = done }))
  const first = f.open(), second = openTranslationSidebar(f.host, f.pdf as unknown as Document, 1, () => {}, f.reader as never)
  await Promise.resolve(); resolve(); await Promise.all([first, second])
  expect(mocks.chat).toHaveBeenCalledTimes(1)
  expect(f.doc.querySelector('.jdx-reader-workspace')?.dataset.page).toBe('translation')
})
it('does not fall back for shared content failures and retries without duplicate nodes', async () => {
  const f = fixture(true); mocks.chat.mockImplementationOnce(() => { throw new Error('synthetic content failure') })
  await f.open()
  expect(mocks.chat).toHaveBeenCalledTimes(1)
  expect(f.doc.querySelector('.jdx-sidebar-recovery')).not.toBeNull()
  await f.open()
  expect(f.doc.querySelectorAll('.jdx-reader-workspace')).toHaveLength(1)
  expect(f.doc.querySelector('.jdx-sidebar-recovery')).toBeNull()
})
it('cancels a pending render on shutdown and never mounts late', async () => {
  const f = fixture(); let resolve!: () => void
  f.detail.render.mockImplementation(() => new Promise<void>(done => { resolve = done }))
  const open = f.open(); await Promise.resolve(); removeReaderSidebars(f.host); resolve(); await open
  expect(f.doc.querySelector('.jdx-reader-workspace')).toBeNull()
  expect(mocks.chat).not.toHaveBeenCalled()
})
it('waits for the exact native Reader without showing an upload panel', async () => {
  const f = fixture(true), rows = (f.host.Reader as unknown as { _readers: unknown[] })._readers
  rows.length = 0
  renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  expect(f.body.querySelector('.jdx-sidebar-recovery')).not.toBeNull()
  rows.push(f.reader); await vi.advanceTimersByTimeAsync(100)
  expect(f.body.querySelector('.jdx-reader-workspace')).not.toBeNull()
})

it('times out once, then a native retry succeeds after the Reader appears', async () => {
  const f = fixture(true), rows = (f.host.Reader as unknown as { _readers: unknown[] })._readers
  rows.length = 0; renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  await vi.advanceTimersByTimeAsync(3000)
  expect(f.body.querySelectorAll('.jdx-sidebar-recovery')).toHaveLength(1)
  expect(f.body.querySelector('button')?.textContent).toBe('Retry')
  rows.push(f.reader)
  ;(f.body.querySelector('button') as unknown as HTMLButtonElement).onclick?.(new Event('click') as MouseEvent)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.body.querySelector('.jdx-reader-workspace')).not.toBeNull()
})
it('does not borrow another window Reader for the same PDF', async () => {
  const f = fixture(), other = fixture()
  ;(f.host.Reader as unknown as { _readers: unknown[] })._readers = [other.reader]
  const opened = openChatSidebar(f.host, f.pdf as unknown as Document, 1)
  await vi.advanceTimersByTimeAsync(3000); await opened
  expect(mocks.chat).not.toHaveBeenCalled()
  expect(f.pdf.querySelector('.jdx-sidebar-recovery')).not.toBeNull()
})
it('cancels native waiting when its attachment changes or body is removed', async () => {
  const f = fixture(true); (f.host.Reader as unknown as { _readers: unknown[] })._readers = []
  renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  f.detail.tabID = 'other-tab'; await vi.advanceTimersByTimeAsync(100)
  expect(f.body.querySelector('.jdx-sidebar-recovery')).toBeNull()
  expect(mocks.chat).not.toHaveBeenCalled()
})
it('shares repeated native renders and cleans all mounted content at shutdown', async () => {
  const f = fixture(true)
  renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  await f.open(); expect(mocks.chat).toHaveBeenCalledTimes(1)
  const view = mocks.chat.mock.results[0].value
  removeReaderSidebars(f.host)
  expect(view.remove).toHaveBeenCalledTimes(1)
  expect(f.doc.querySelector('.jdx-reader-workspace')).toBeNull()
})
it('keeps a zero-size dock preference and responds to the window resize fallback', async () => {
  const f = fixture(); f.parent.clientWidth = 0; await f.open()
  const root = f.parent.querySelector('.jdx-reader-workspace')!
  expect(f.host.Prefs?.set).not.toHaveBeenCalled()
  f.parent.clientWidth = 1000; f.doc.defaultView.dispatchEvent(new Event('resize'))
  expect(root.attributes.get('--jdx-dock-width')).toBe('480px')
})
it('reports content failures once when neither host can show content, then recovers', async () => {
  const f = fixture(); f.detail.render.mockRejectedValue(new Error('native failed'))
  mocks.chat.mockImplementationOnce(() => { throw new Error('content failed') })
  await f.open()
  expect(f.pdf.querySelectorAll('.jdx-sidebar-recovery')).toHaveLength(1)
  expect(f.doc.querySelector('.jdx-reader-workspace')).toBeNull()
  await f.open()
  expect(f.pdf.querySelector('.jdx-sidebar-recovery')).toBeNull()
  expect(f.parent.querySelector('.jdx-reader-workspace')).not.toBeNull()
})
it('cancels an opening when its PDF window closes', async () => {
  const f = fixture(); let resolve!: () => void
  f.detail.render.mockImplementation(() => new Promise<void>(done => { resolve = done }))
  const opened = f.open(); f.pdf.defaultView.dispatchEvent(new Event('pagehide')); await opened; resolve()
  await Promise.resolve()
  expect(mocks.chat).not.toHaveBeenCalled()
})
it('respects the host context pane collapse and reopens only on an explicit action', async () => {
  const f = fixture(true)
  await f.open()
  expect(f.detail.getAttribute('data-jdx-reading-active')).not.toBeNull()
  f.contextPane.collapsed = true
  f.doc.defaultView.dispatchEvent(new Event('resize'))
  await vi.advanceTimersByTimeAsync(1100)
  expect(f.contextPane.collapsed).toBe(true)
  expect(f.detail.getAttribute('data-jdx-reading-active')).toBeNull()
  expect(f.parent.querySelector('.jdx-reader-workspace')).toBeNull()
  f.doc.defaultView.dispatchEvent(new Event('resize'))
  expect(f.contextPane.collapsed).toBe(true)
  await f.open()
  expect(f.contextPane.collapsed).toBe(false)
  expect(f.detail.getAttribute('data-jdx-reading-active')).not.toBeNull()
})
it('releases a docked fallback when the user reopens the host context pane', async () => {
  const f = fixture(true)
  f.contextPane.classList.add('stacked')
  await f.open()
  expect(f.parent.querySelector('.jdx-reader-dock')).not.toBeNull()
  expect(f.contextPane.collapsed).toBe(true)
  f.contextPane.collapsed = false
  f.doc.defaultView.dispatchEvent(new Event('resize'))
  expect(f.contextPane.collapsed).toBe(false)
  expect(f.parent.querySelector('.jdx-reader-dock')).toBeNull()
})
it('recovers an activated native body that stays invisible without replaying new conversation', async () => {
  const f = fixture(true)
  Object.assign(f.doc, { visibilityState: 'hidden' }) // 实际 Zotero XUL 顶层窗口的值。
  f.doc.defaultView = Object.assign(f.doc.defaultView, { getComputedStyle: (node: Node) => ({ display: node.closest('[data-type="body"]') ? 'none' : 'flex', visibility: 'visible' }) })
  await f.open(); await vi.advanceTimersByTimeAsync(1100)
  expect(f.parent.querySelector('.jdx-reader-workspace')).not.toBeNull()
  expect(mocks.chat.mock.results[0].value.newSession).toHaveBeenCalledTimes(1)
  expect(mocks.chat).toHaveBeenCalledTimes(1)
})
it('does not recover an invisible background Reader until it is selected', async () => {
  const f = fixture(true)
  Object.assign(f.reader._window, { Zotero_Tabs: { selectedID: 'another-tab' } })
  f.doc.defaultView = Object.assign(f.doc.defaultView, { getComputedStyle: () => ({ display: 'none' }) })
  await f.open(); await vi.advanceTimersByTimeAsync(1100)
  expect(f.parent.querySelector('.jdx-reader-workspace')).toBeNull()
})
it('shows loading and a recovery action after ten seconds of pending results', async () => {
  const f = fixture(true)
  mocks.jobs.mockReturnValue({ ready: new Promise(() => {}), list: () => [] })
  const pending = openTranslationSidebar(f.host, f.pdf as unknown as Document, 1, () => {}, f.reader as never)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.doc.querySelector('.jdx-sidebar-loading')).not.toBeNull()
  await vi.advanceTimersByTimeAsync(10001)
  expect(f.doc.querySelector('.jdx-sidebar-recovery')).not.toBeNull()
  removeReaderSidebars(f.host); await pending
})
it('accepts Gecko wrappers only when they represent the same DOM document', async () => {
  const f = fixture()
  const wrapped = Object.assign(new Doc(), { isSameNode: (value: unknown) => value === f.pdf })
  f.reader._iframeWindow.document = wrapped
  await f.open()
  expect(mocks.chat).toHaveBeenCalledTimes(1)
})
it('replaces a native body reused for another attachment', () => {
  const f = fixture(true)
  renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  f.reader.itemID = 2
  renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  expect(f.body.querySelector('.jdx-reader-workspace')?.dataset.readerItem).toBe('2')
  expect(mocks.chat.mock.results[0].value.remove).toHaveBeenCalledTimes(1)
  expect(f.body.querySelectorAll('.jdx-reader-workspace')).toHaveLength(1)
})
it('restarts a pending native render for the new tab while cancelling the old wait', async () => {
  const f = fixture(true), rows = (f.host.Reader as unknown as { _readers: unknown[] })._readers
  rows.length = 0; renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  f.detail.tabID = 'tab-2'; f.reader.tabID = 'tab-2'; f.reader.itemID = 2
  renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  rows.push(f.reader); await vi.advanceTimersByTimeAsync(100)
  expect(f.body.querySelector('.jdx-reader-workspace')?.dataset.readerItem).toBe('2')
  expect(mocks.chat).toHaveBeenCalledTimes(1)
})
it('allows the native host to render a detached body before attaching it', () => {
  const f = fixture(true)
  f.detail.remove()
  renderNativeReaderSidebar(f.body as unknown as HTMLElement, f.host)
  f.doc.body.append(f.detail)
  expect(f.body.querySelector('.jdx-reader-workspace')).not.toBeNull()
})
it('abandons a pending open when the user switches tabs', async () => {
  const f = fixture(), tabs = { selectedID: f.reader.tabID }
  Object.assign(f.reader._window, { Zotero_Tabs: tabs })
  let resolve!: () => void
  f.detail.render.mockImplementation(() => new Promise<void>(done => { resolve = done }))
  const opened = f.open(); tabs.selectedID = 'other'; resolve(); await opened
  expect(mocks.chat).not.toHaveBeenCalled()
})
