/** OCR 设置交互回归：挂起的环境检查仍显示停止操作，停止后恢复可用按钮。 */
import { expect, it, vi } from 'vitest'
import type { ZoteroLike } from './runtime'
import { wireOCRSettings } from './ocr-settings'

const mocks = vi.hoisted(() => ({ check: vi.fn(), operations: new Set<AbortController>() }))
vi.mock('./local-ocr', () => ({
  checkLocalOCR: mocks.check,
  installLocalOCR: vi.fn(), prepareLocalOCRModels: vi.fn(), removeLocalOCR: vi.fn(),
  observeOCRProgress: () => () => {}, isLocalOCRPreparing: () => false,
  registerOCRSettingsOperation: (_host: unknown, controller: AbortController) => { mocks.operations.add(controller); return () => mocks.operations.delete(controller) },
  cancelOCRSettingsOperations: () => { for (const controller of mocks.operations) controller.abort() },
  OCR_MODEL_SOURCE_PREF: 'source', readOCRModelSource: () => 'default',
}))
vi.mock('./custom-select', () => ({ createJdxSelect: () => ({ setOptions: () => {}, onChange: () => {}, setDisabled: () => {}, destroy: () => {} }) }))
vi.mock('./cloud-ocr-settings', () => ({ wireCloudOCRSettings: (_host: unknown, _root: unknown, onChange: (value: string) => void) => { onChange('local'); return () => {} } }))
vi.mock('./pdf-translation-settings', () => ({ wirePDFEngineSettings: () => () => {} }))
vi.mock('./settings-navigation', () => ({ wireSettingsNavigation: () => () => {} }))

class TestDocument {
  defaultView = new EventTarget()
  createElementNS(_namespace: string, tag: string) { return new TestElement(this, tag) }
}
class TestElement extends EventTarget {
  children: TestElement[] = []
  parent?: TestElement
  dataset: Record<string, string> = {}
  hidden = false
  disabled = false
  checked = false
  textContent = ''
  className = ''
  type = ''
  title = ''
  id = ''
  open = false
  style = {}
  constructor(readonly ownerDocument: TestDocument, readonly tag: string) { super() }
  append(...children: TestElement[]) { for (const child of children) { this.children.push(child); child.parent = this } }
  before(child: TestElement) { const index = this.parent?.children.indexOf(this) ?? -1; if (index >= 0) { this.parent!.children.splice(index, 0, child); child.parent = this.parent } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this) }
  replaceChildren() { this.children = [] }
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  find(action: string): TestElement | undefined { return this.dataset.ocrAction === action ? this : this.children.map(child => child.find(action)).find(Boolean) }
}

it('shows Stop during a stalled OCR check and restores the action after cancellation', async () => {
  mocks.check.mockImplementation((_host: unknown, _force: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true })
  }))
  const doc = new TestDocument(), root = new TestElement(doc, 'section')
  const host = { Prefs: { get: () => undefined, set: () => {}, registerObserver: () => 1, unregisterObserver: () => {} } } as unknown as ZoteroLike
  const dispose = wireOCRSettings(host, root as unknown as HTMLElement)
  const stop = root.find('stop')!, install = root.find('install')!
  expect(stop.hidden).toBe(false)
  expect(install.disabled).toBe(true)
  stop.dispatchEvent(new Event('click'))
  await vi.waitFor(() => expect(stop.hidden).toBe(true))
  expect(install.disabled).toBe(false)
  expect(install.textContent).toBe('重新读取状态')
  expect(mocks.operations.size).toBe(0)
  dispose()
})
