/** 对话初始化在订阅后失败时必须回收资源；缺少 ResizeObserver 使用窗口布局事件。 */
import { beforeEach, expect, it, vi } from 'vitest'
import type { ZoteroLike } from './runtime'
const mocks = vi.hoisted(() => ({ unsubscribe: vi.fn(), destroy: vi.fn(), feature: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/chat/local-chat-store', () => ({ readLocalChatState: () => ({ sessions: [] }) }))
vi.mock('./chat-runtime', () => ({ chatRuntime: () => ({ preferences: {}, feature: () => 'chat', subscribe: mocks.subscribe }) }))
vi.mock('./chat-composer-ui', () => ({ mountChatComposer() {} }))
vi.mock('./chat-message-ui', () => ({ nearLatest: () => false, updateLatestButton() {} }))
vi.mock('./ui/select', () => ({ createJdxSelect: () => ({ destroy: mocks.destroy, setOptions() {}, setValue() {}, onChange() {}, close() {} }) }))
vi.mock('./research-context', () => ({ collectSourceForItem: async () => null }))
vi.mock('./ai-settings', () => ({ featureModelState: mocks.feature, effectiveFeatureModelSelection: () => ({}), featureModelSelectionKey: () => 'default' }))
vi.mock('./ai-model-select', () => ({ buildFeatureModelSelectOptions: () => [] }))
vi.mock('./runtime', () => ({ readConnection: () => ({ token: '' }) }))
import { mountReaderChat } from './reader-chat'

class TestNode extends EventTarget {
  classList = { add() {} }; dataset = {}; value = ''; style = { height: '', setProperty() {} }; scrollHeight = 48; clientHeight = 600; children: TestNode[] = []
  fields = new Map<string, TestNode>()
  constructor(readonly ownerDocument: TestDoc) { super() }
  setAttribute() {} append(...nodes: TestNode[]) { this.children.push(...nodes) } prepend() {} replaceChildren() { this.children = []; this.fields.clear() }
  querySelector(selector: string): TestNode { let node = this.fields.get(selector); if (!node) { node = new TestNode(this.ownerDocument); this.fields.set(selector, node) } return node }
  getBoundingClientRect() { return { height: 80 } }
}
class TestDoc {
  defaultView = Object.assign(new EventTarget(), { requestAnimationFrame() {} })
  createElementNS() { return new TestNode(this) }
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.subscribe.mockReturnValue(mocks.unsubscribe)
  mocks.feature.mockReset().mockReturnValue({ ready: false, route: 'byok', issue: 'Configure model' })
})
it('unsubscribes and destroys both selects after a late initialization error', () => {
  const doc = new TestDoc(), root = new TestNode(doc), selector = new TestNode(doc)
  const removed = vi.spyOn(doc.defaultView, 'removeEventListener')
  mocks.feature.mockImplementation(() => { throw new Error('synthetic late initialization') })
  expect(() => mountReaderChat(root as unknown as HTMLElement, selector as unknown as HTMLElement, {} as ZoteroLike, 1)).toThrow('synthetic late initialization')
  expect(mocks.unsubscribe).toHaveBeenCalledTimes(1); expect(mocks.destroy).toHaveBeenCalledTimes(2)
  expect(removed).toHaveBeenCalledWith('resize', expect.any(Function))
  expect(root.children).toHaveLength(0)
})
it('mounts without ResizeObserver and releases window resize and the subscription on removal', () => {
  const doc = new TestDoc(), root = new TestNode(doc), selector = new TestNode(doc)
  const removed = vi.spyOn(doc.defaultView, 'removeEventListener')
  const view = mountReaderChat(root as unknown as HTMLElement, selector as unknown as HTMLElement, {} as ZoteroLike, 1)
  expect(() => doc.defaultView.dispatchEvent(new Event('resize'))).not.toThrow()
  view.remove()
  expect(mocks.unsubscribe).toHaveBeenCalledTimes(1); expect(mocks.destroy).toHaveBeenCalledTimes(2)
  expect(removed).toHaveBeenCalledWith('resize', expect.any(Function))
})
