/** 驱动真实 bootstrap 生命周期，验证局部失败与等待期间卸载不会破坏其他入口。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ preferences: vi.fn(), panel: vi.fn(), menus: vi.fn(), tools: vi.fn(), figures: vi.fn(), jobs: vi.fn(), chat: vi.fn(), stopJobs: vi.fn(), stopChat: vi.fn(), unmenus: vi.fn(), restore: vi.fn(), stopAnalysis: vi.fn(), initializePDF: vi.fn() }))
vi.mock('./native-preferences', () => ({ registerPreferencesPane: mock.preferences, unregisterPreferencesPane: vi.fn(), openPreferencesPane: vi.fn() }))
vi.mock('./native-menus', () => ({ registerNativeMenus: mock.menus, unregisterNativeMenus: mock.unmenus }))
vi.mock('./sync-panel', () => ({ registerSyncPanel: mock.panel, unregisterSyncPanel: vi.fn() }))
vi.mock('./reader-tools', () => ({ registerReaderTools: mock.tools }))
vi.mock('./reader-figure-tools', () => ({ registerReaderFigureTools: mock.figures }))
vi.mock('./document-jobs', () => ({ documentJobs: mock.jobs, stopDocumentJobs: mock.stopJobs }))
vi.mock('./chat-runtime', () => ({ chatRuntime: mock.chat, stopChatRuntime: mock.stopChat }))
vi.mock('./analysis-runtime', () => ({ analysisRuntime: () => ({ restore: mock.restore }), stopAnalysisRuntime: mock.stopAnalysis }))
vi.mock('./pdf-translation-jobs', () => ({ pdfTranslationJobs: () => ({ initialize: mock.initializePDF }), stopPDFTranslationJobs: vi.fn() }))
vi.mock('./manager-window', () => ({ openManagerWindow: vi.fn(), closeManagerWindow: vi.fn() }))
vi.mock('./manager-help', () => ({ installedPluginVersion: async () => '0.4.10' }))
vi.mock('./chrome-registration', () => ({ registerChromeContent: () => ({}), ensureJadenseLocalization: () => true, unregisterChromeContent: vi.fn() }))
vi.mock('./ui-preferences', () => ({ initializeUiLocale: vi.fn(), uiText: (_cn: string, en: string) => en }))
type Boot = { startup(): Promise<void>; shutdown(): Promise<void> }
const boot = globalThis as unknown as Boot
let host: { uiReadyPromise: Promise<void>; debug: ReturnType<typeof vi.fn>; getMainWindow: () => unknown; getMainWindows: () => unknown[]; Prefs: { get: () => undefined } }
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks()
  mock.preferences.mockReset().mockResolvedValue('prefs'); mock.panel.mockReset().mockReturnValue('pane'); mock.menus.mockReset().mockReturnValue(['menu'])
  mock.jobs.mockReset().mockReturnValue({ ready: Promise.resolve() }); mock.chat.mockReset(); mock.stopChat.mockReset(); mock.tools.mockReset(); mock.figures.mockReset()
  mock.restore.mockReset().mockResolvedValue(undefined); mock.initializePDF.mockReset().mockResolvedValue(undefined); mock.stopAnalysis.mockReset()
  const win = { document: { readyState: 'complete' }, navigator: { platform: 'test' }, fetch }
  host = { uiReadyPromise: Promise.resolve(), debug: vi.fn(), getMainWindow: () => win, getMainWindows: () => [], Prefs: { get: () => undefined } }
  vi.stubGlobal('Zotero', host); await import('../bootstrap')
})
afterEach(async () => { await boot.shutdown(); vi.unstubAllGlobals(); vi.useRealTimers() })
it('continues registering Reader tools when document and chat runtime initialization fail', async () => {
  mock.jobs.mockImplementation(() => { throw new Error('documents unavailable') }); mock.chat.mockImplementation(() => { throw new Error('chat unavailable') })
  await expect(boot.startup()).resolves.toBeUndefined()
  expect(mock.tools).toHaveBeenCalledTimes(1); expect(mock.figures).toHaveBeenCalledTimes(1)
})
it('does not register late after shutdown while waiting for the UI', async () => {
  let ready!: () => void; host.uiReadyPromise = new Promise(resolve => { ready = resolve })
  const opening = boot.startup(); await boot.shutdown(); ready(); await opening
  expect(mock.preferences).not.toHaveBeenCalled(); expect(mock.tools).not.toHaveBeenCalled()
})
it('logs a slow host once and still initializes when it becomes ready', async () => {
  let ready!: () => void; host.uiReadyPromise = new Promise(resolve => { ready = resolve })
  const opening = boot.startup(); await vi.advanceTimersByTimeAsync(20000)
  expect(host.debug.mock.calls.filter(([message]) => String(message).includes('host_wait_slow'))).toHaveLength(1)
  expect(mock.tools).not.toHaveBeenCalled(); ready(); await opening; expect(mock.tools).toHaveBeenCalledTimes(1)
})
it('continues shutdown after one runtime disposal throws', async () => {
  await boot.startup(); mock.stopChat.mockImplementation(() => { throw new Error('closed window') })
  await expect(boot.shutdown()).resolves.toBeUndefined(); expect(mock.stopJobs).toHaveBeenCalled(); expect(mock.unmenus).toHaveBeenCalled()
})
it('cleans Reader and figure registrations independently, including a throwing figure cleanup', async () => {
  const reader = vi.fn(), figure = vi.fn(() => { throw new Error('figure cleanup') })
  mock.tools.mockReturnValue(reader); mock.figures.mockReturnValue(figure)
  await boot.startup(); await boot.shutdown()
  expect(figure).toHaveBeenCalledTimes(1); expect(reader).toHaveBeenCalledTimes(1)
  await boot.shutdown(); expect(reader).toHaveBeenCalledTimes(1)
})
it('unregisters a late preferences result without registering subsequent components', async () => {
  let resolve!: (id: string) => void
  mock.preferences.mockImplementation(() => new Promise<string>(done => { resolve = done }))
  const opening = boot.startup(); await vi.advanceTimersByTimeAsync(0)
  await boot.shutdown(); resolve('late'); await opening
  expect(mock.panel).not.toHaveBeenCalled(); expect(mock.tools).not.toHaveBeenCalled()
})
it('records registration failure without skipping the remaining components', async () => {
  mock.panel.mockReturnValue(null); mock.preferences.mockRejectedValue(new Error('preferences failed'))
  await boot.startup()
  expect(mock.tools).toHaveBeenCalledTimes(1)
  expect(host.debug).toHaveBeenCalledWith('[Jadense in Zotero] startup_degraded')
})
it('initializes even when diagnostics and the debug logger both throw', async () => {
  Object.defineProperty(host, '__jadenseDiagnostics', { configurable: true, get() { throw new Error('diagnostics unavailable') } })
  host.debug.mockImplementation(() => { throw new Error('logger unavailable') })
  mock.preferences.mockRejectedValue(new Error('preferences unavailable'))
  await expect(boot.startup()).resolves.toBeUndefined()
  expect(mock.tools).toHaveBeenCalledTimes(1); expect(mock.figures).toHaveBeenCalledTimes(1)
  await expect(boot.shutdown()).resolves.toBeUndefined()
})
it('starts persisted recovery without delaying Reader registration and awaits shutdown checkpoint writes', async () => {
  let finishRestore!: () => void, finishSaving!: () => void
  mock.restore.mockReturnValue(new Promise<void>(resolve => { finishRestore = resolve }))
  mock.initializePDF.mockRejectedValue(new Error('synthetic disk offline'))
  await boot.startup()
  expect(mock.restore).toHaveBeenCalledOnce(); expect(mock.initializePDF).toHaveBeenCalledOnce()
  expect(mock.tools).toHaveBeenCalledOnce()
  mock.stopAnalysis.mockReturnValue(new Promise<void>(resolve => { finishSaving = resolve }))
  let stopped = false
  const closing = boot.shutdown().then(() => { stopped = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(stopped).toBe(false)
  finishRestore(); finishSaving(); await closing
  expect(stopped).toBe(true)
})
