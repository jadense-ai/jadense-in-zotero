/** 离线引导回归：公开渠道、中英说明、外部导航，以及两个安装入口失败后的恢复提示。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import type { ZoteroLike } from './runtime'
import { appendOnboardingEngineHelp, ONBOARDING_ENGINE_DOWNLOADS } from './onboarding-engine-help'
import { initializeUiLocale } from './ui-preferences'
import { wireOCRSettings } from './ocr-settings'
import { wirePDFEngineSettings } from './pdf-translation-settings'

const mocks = vi.hoisted(() => ({ ocrCheck: vi.fn(), ocrPrepare: vi.fn(), pdfPrepare: vi.fn(), pdfCheck: vi.fn() }))
vi.mock('./local-ocr', () => ({
  checkLocalOCR: mocks.ocrCheck, prepareLocalOCRModels: mocks.ocrPrepare, installLocalOCR: vi.fn(), removeLocalOCR: vi.fn(),
  observeOCRProgress: () => () => {}, isLocalOCRPreparing: () => false, registerOCRSettingsOperation: () => () => {}, cancelOCRSettingsOperations: vi.fn(),
  ocrStorageBusyReason: () => undefined, stopIdleOCRForStorage: vi.fn(), rebindOCRReady: vi.fn(), movedOCRNeedsHealthCheck: vi.fn(), validateMovedOCREngine: vi.fn(),
  OCR_MODEL_SOURCE_PREF: 'source', readOCRModelSource: () => 'default',
}))
vi.mock('./pdf-translation-runtime', () => ({
  PDF_ENGINE: 'pdf-engine', pdfRuntimeRoot: () => '/pdf', checkPDFEngine: vi.fn(), preparePDFEngine: vi.fn(),
  pdfPlatform: () => ({ IOUtils: { exists: async () => false }, PathUtils: { join: (...parts: string[]) => parts.join('/') } }),
}))
vi.mock('./pdf-translation-jobs', () => ({ pdfTranslationJobs: () => ({ prepare: mocks.pdfPrepare, checkEngine: mocks.pdfCheck, storageBusyReason: () => undefined }) }))
vi.mock('./engine-storage-settings', () => ({ wireEngineStorageSettings: () => () => {} }))
vi.mock('./custom-select', () => ({ createJdxSelect: () => ({ setOptions: () => {}, onChange: () => {}, setDisabled: () => {}, destroy: () => {} }) }))
vi.mock('./cloud-ocr-settings', () => ({ wireCloudOCRSettings: (_host: unknown, _root: unknown, onChange: (value: string) => void) => { onChange('local'); return () => {} } }))
vi.mock('./settings-navigation', () => ({ wireSettingsNavigation: () => () => {} }))

let dom: JSDOM
let root: HTMLElement
let host: ZoteroLike
let dispose = () => {}
beforeEach(() => {
  vi.clearAllMocks()
  initializeUiLocale({ locale: 'zh-CN' })
  dom = new JSDOM('<!doctype html><section id="root"></section>')
  root = dom.window.document.querySelector<HTMLElement>('#root')!
  host = { Prefs: { get: () => undefined, set: () => {} } } as unknown as ZoteroLike
  mocks.ocrCheck.mockResolvedValue({ ready: false, modelsReady: false, uvPath: '', uvVersion: '', uvSource: '', logPath: '/ocr/install.log' })
  mocks.ocrPrepare.mockResolvedValue(undefined)
  mocks.pdfPrepare.mockResolvedValue(undefined)
  mocks.pdfCheck.mockResolvedValue(undefined)
})
afterEach(() => { dispose(); dispose = () => {}; dom.window.close(); initializeUiLocale({ locale: 'zh-CN' }) })

it('shows every configured channel, access code and copyable URLs including the replacement Baidu share', () => {
  const help = appendOnboardingEngineHelp(dom.window.document, host, root); dispose = help.dispose
  expect(Array.from(root.querySelectorAll('[data-engine-download-channel]')).map(node => (node as HTMLElement).dataset.engineDownloadChannel)).toEqual(['github', 'quark', 'baidu'])
  for (const channel of ONBOARDING_ENGINE_DOWNLOADS.filter(value => value.url)) {
    expect(root.textContent).toContain(channel.url)
    expect(root.querySelector(`a[href="${channel.url}"]`)).not.toBeNull()
  }
  expect(root.textContent).toContain('提取码：H2RJ')
  expect(root.querySelector('[data-engine-download-channel="baidu"]')?.textContent).toContain('提取码：4sci')
  expect(root.querySelector('[data-engine-download-channel="baidu"] a')?.getAttribute('href')).toBe('https://pan.baidu.com/s/1YXrqXBao6uEA2BZKz1WlTw?pwd=4sci')
  expect(root.textContent).not.toContain('下载入口更新中')
  expect(root.textContent).toContain('两个引擎需要分别导入')
  expect(root.textContent).toContain('不要解压引擎 ZIP 本身')
  expect(root.textContent).toContain('Windows x64')
})

it('renders English instructions and opens fixed download URLs in the system browser only on a click', () => {
  initializeUiLocale({ locale: 'en-US' })
  const launchURL = vi.fn(); Object.assign(host, { launchURL })
  dispose = appendOnboardingEngineHelp(dom.window.document, host, root).dispose
  expect(root.textContent).toContain('Import each engine separately')
  expect(root.textContent).toContain('Access code: H2RJ')
  expect(root.textContent).toContain('Access code: 4sci')
  expect(launchURL).not.toHaveBeenCalled()
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
  root.querySelector<HTMLAnchorElement>('[data-engine-download-channel="quark"] a')!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(launchURL).toHaveBeenCalledTimes(1)
  expect(launchURL).toHaveBeenCalledWith(ONBOARDING_ENGINE_DOWNLOADS[1].url)
})

it('keeps a copyable URL when the system browser is unavailable and removes its own section on dispose', () => {
  const help = appendOnboardingEngineHelp(dom.window.document, host, root)
  root.querySelector<HTMLAnchorElement>('a')!.click()
  expect(root.querySelector('[role="status"]')?.textContent).toContain(ONBOARDING_ENGINE_DOWNLOADS[0].url)
  help.dispose()
  expect(root.querySelector('[data-onboarding-engine-help]')).toBeNull()
  dispose = appendOnboardingEngineHelp(dom.window.document, host, root).dispose
  expect(root.querySelectorAll('[data-onboarding-engine-help]')).toHaveLength(1)
})

it('reveals offline channels after OCR preparation fails and clears the help after successful recovery', async () => {
  mocks.ocrPrepare.mockRejectedValueOnce(new Error('Network unavailable'))
  dispose = wireOCRSettings(host, root)
  const install = root.querySelector<HTMLButtonElement>('[data-ocr-action="install"]')!
  const help = root.querySelector<HTMLElement>('[data-external-dependency="ocr"] [data-onboarding-engine-help]')!
  await vi.waitFor(() => expect(install.disabled).toBe(false))
  expect(help.hidden).toBe(true)
  install.click()
  await vi.waitFor(() => expect(help.hidden).toBe(false))
  expect(help.textContent).toContain('夸克网盘')
  await vi.waitFor(() => expect(install.disabled).toBe(false))
  mocks.ocrCheck.mockResolvedValue({ ready: true, modelsReady: true, uvPath: '', logPath: '/ocr/install.log' })
  install.click()
  await vi.waitFor(() => expect(help.hidden).toBe(true))
})

it('reveals offline channels after PDF preparation fails and clears the help after successful recovery', async () => {
  mocks.pdfPrepare.mockRejectedValueOnce(new Error('Network unavailable'))
  dispose = wirePDFEngineSettings(host, root)
  const prepare = root.querySelector<HTMLButtonElement>('button')!
  const help = root.querySelector<HTMLElement>('[data-onboarding-engine-help]')!
  expect(help.hidden).toBe(true)
  prepare.click()
  await vi.waitFor(() => expect(help.hidden).toBe(false))
  expect(help.textContent).toContain('GitHub Releases')
  await vi.waitFor(() => expect(prepare.disabled).toBe(false))
  prepare.click()
  await vi.waitFor(() => expect(help.hidden).toBe(true))
})
