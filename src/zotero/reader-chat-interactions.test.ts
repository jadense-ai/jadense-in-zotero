// @vitest-environment jsdom
/** 通过 Reader 的真实输入框、会话选择和附件入口验证草稿与生成归属。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountReaderChat } from './reader-chat'
import { initializeUiLocale } from './ui-preferences'

const { runtime, sessions, model, openManager } = vi.hoisted(() => ({
  sessions: [] as { id: string; title: string; updatedAt: string; messages: never[]; sources: never[] }[],
  runtime: { preferences: {}, activeSessionID: '', status: '', statusKind: 'idle', busy: false, feature: () => 'chat',
    subscribe: () => () => {}, stop: vi.fn(), create: vi.fn(), send: vi.fn() },
  model: vi.fn(), openManager: vi.fn(),
}))
vi.mock('./chat-runtime', () => ({ chatRuntime: () => runtime }))
vi.mock('@/chat/local-chat-store', () => ({ readLocalChatState: () => ({ sessions }) }))
vi.mock('./research-context', () => ({ collectSourceForItem: async () => null }))
vi.mock('./ai-settings', () => ({ featureModelState: model, effectiveFeatureModelSelection: () => ({}), featureModelSelectionKey: () => 'default' }))
vi.mock('./ai-model-select', () => ({ buildFeatureModelSelectOptions: () => [], bindModelSelectToast() {}, configureFeatureModelThinking() {}, shouldRefreshModelCatalog: () => false }))
vi.mock('./manager-window', () => ({ openManagerWindow: openManager }))
vi.mock('./chat-files', () => ({ readChatUpload: async (file: File) => ({ name: file.name, size: file.size, mimeType: file.type, text: 'fixture' }) }))

let view: ReturnType<typeof mountReaderChat>
const field = <T extends HTMLElement>(suffix: string) => document.querySelector<T>(`[id$="-chat-${suffix}"]`)!
function mount() {
  document.body.innerHTML = '<header></header><main></main>'
  view = mountReaderChat(document.querySelector('main')!, document.querySelector('header')!, {}, 17)
}
function session(id: string, title: string) { return { id, title, updatedAt: '2026-11-01', messages: [], sources: [] } }
function type(text: string) {
  const input = field<HTMLTextAreaElement>('input')
  input.value = text; input.dispatchEvent(new Event('input'))
}
function choose(title: string) {
  document.querySelector<HTMLButtonElement>('header .jdx-select-trigger')!.click()
  const row = Array.from(document.querySelectorAll<HTMLElement>('.jdx-select-portal [role=option]')).find(node => node.textContent === title)
  expect(row).toBeDefined(); row!.click()
}
beforeEach(() => {
  initializeUiLocale({ locale: 'zh-CN' })
  sessions.length = 0; runtime.busy = false; runtime.activeSessionID = ''; runtime.status = ''
  vi.clearAllMocks()
  model.mockReturnValue({ ready: true, route: 'byok', selection: { route: 'byok' } })
  openManager.mockReturnValue(true)
})
afterEach(() => { view?.remove(); document.body.replaceChildren() })

it('names the empty draft and preserves its text, attachment and focus across New and history', async () => {
  mount()
  const input = field<HTMLTextAreaElement>('input'), file = field<HTMLInputElement>('image-input')
  expect(document.querySelector('.jdx-reader-draft-title')?.textContent).toBe('新对话')
  expect(document.querySelector('header .jdx-select')?.hasAttribute('hidden')).toBe(true)
  type('这段证据如何解释？')
  Object.defineProperty(file, 'files', { value: [new File(['sample'], '结果.txt', { type: 'text/plain' })] })
  file.dispatchEvent(new Event('change'))
  await vi.waitFor(() => expect(field('image-preview').textContent).toContain('结果.txt'))
  await view.newSession()
  expect(input.value).toBe('这段证据如何解释？')
  expect(document.activeElement).toBe(input)
  sessions.push(session('saved', '之前的对话')); view.refresh()
  expect(document.querySelector('header .jdx-select-value')?.textContent).toBe('新对话')
  choose('之前的对话'); type('历史会话草稿')
  await view.newSession()
  expect(input.value).toBe('这段证据如何解释？')
  expect(field('image-preview').textContent).toContain('结果.txt')
  choose('之前的对话')
  expect(input.value).toBe('历史会话草稿')
  expect(runtime.create).not.toHaveBeenCalled()
})

it('promotes the draft on its first send and starts the next draft empty', async () => {
  mount(); type('第一条问题')
  runtime.create.mockImplementation(async () => { sessions.push(session('new', '已发出的提问')); return 'new' })
  runtime.send.mockImplementation(async ({ onAccepted }) => { onAccepted(); return true })
  field<HTMLFormElement>('form').requestSubmit()
  await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'new', prompt: '第一条问题' })))
  await view.newSession()
  expect(field<HTMLTextAreaElement>('input').value).toBe('')
  expect(document.querySelector('header .jdx-select-value')?.textContent).toBe('新对话')
})

it('keeps the newly selected history open during a slow first send without resending its draft', async () => {
  sessions.push(session('old', '旧对话')); mount(); type('等待关联 PDF')
  let finish!: (id: string) => void
  runtime.create.mockImplementation(() => new Promise<string>(resolve => { finish = resolve }))
  runtime.send.mockImplementation(async ({ onAccepted }) => { onAccepted(); return true })
  field<HTMLFormElement>('form').requestSubmit()
  choose('旧对话'); await view.newSession()
  expect(field<HTMLButtonElement>('send').disabled).toBe(true)
  choose('旧对话'); type('现在编辑的草稿')
  sessions.push(session('new', '首次发送')); finish('new')
  await vi.waitFor(() => expect(runtime.send).toHaveBeenCalledOnce())
  expect(document.querySelector('main')?.dataset.chatSession).toBe('old')
  expect(field<HTMLTextAreaElement>('input').value).toBe('现在编辑的草稿')
  await view.newSession(); expect(field<HTMLTextAreaElement>('input').value).toBe('')
})

it('shows the owner of a background reply, returns to it and stops only that conversation', async () => {
  sessions.push(session('a', '论文 A'), session('b', '论文 B')); mount()
  choose('论文 B'); type('留给 B 的提问')
  runtime.busy = true; runtime.activeSessionID = 'a'; runtime.status = '正在准备消息…'; view.refresh()
  const stop = field<HTMLButtonElement>('stop'), send = field<HTMLButtonElement>('send')
  expect(send.disabled).toBe(true); expect(stop.hidden).toBe(true); stop.click()
  expect(runtime.stop).not.toHaveBeenCalled()
  expect(document.querySelector('.jdx-reader-other-generation')?.textContent).toContain('「论文 A」正在生成回复')
  document.querySelector<HTMLButtonElement>('.jdx-reader-return-chat')!.click()
  expect(document.querySelector('main')?.dataset.chatSession).toBe('a')
  expect(stop.hidden).toBe(false); stop.click()
  expect(runtime.stop).toHaveBeenCalledOnce()
  choose('论文 B'); expect(field<HTMLTextAreaElement>('input').value).toBe('留给 B 的提问')
  runtime.busy = false; view.refresh(); expect(send.disabled).toBe(false)
})

it('links a missing model to the chat selector and a missing account token to connection settings', () => {
  model.mockReturnValue({ ready: false, route: 'jadense', selection: { route: 'jadense' } })
  mount(); type('保留我的问题')
  const action = document.querySelector<HTMLButtonElement>('.jdx-reader-configure-model')!
  expect(action.textContent).toBe('配置对话模型'); action.click()
  expect(openManager).toHaveBeenCalledWith(expect.objectContaining({ section: 'settings-features', focusChatModel: true }))
  model.mockReturnValue({ ready: false, route: 'jadense', selection: { route: 'jadense', selection: { kind: 'default' } } }); view.refresh()
  expect(action.textContent).toBe('连接攻玉'); action.click()
  expect(openManager).toHaveBeenCalledWith(expect.objectContaining({ section: 'settings-connection' }))
  expect(field<HTMLTextAreaElement>('input').value).toBe('保留我的问题')
})

it('explains draft, background generation and setup in English', () => {
  initializeUiLocale({ locale: 'en-US' })
  model.mockReturnValue({ ready: false, route: 'jadense', selection: { route: 'jadense' } })
  mount()
  expect(document.querySelector('.jdx-reader-draft-title')?.textContent).toBe('New conversation')
  expect(document.querySelector('.jdx-reader-configure-model')?.textContent).toBe('Configure chat model')
  sessions.push(session('a', 'Paper A')); runtime.busy = true; runtime.activeSessionID = 'a'; view.refresh()
  expect(document.querySelector('.jdx-reader-other-generation')?.textContent).toContain('“Paper A” is generating a reply.')
})
