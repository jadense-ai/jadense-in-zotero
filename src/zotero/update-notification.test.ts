/** 静默检查与自动更新弹窗测试：覆盖跨窗口并发、失败恢复、三大下载渠道与状态反馈。 */
import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { showUpdateDialog, silentlyCheckForUpdates } from './update-notification'
import { checkLatestRelease, installedPluginVersion, openHelpLink } from './manager-help'
import { BAIDU_NETDISK_URL, QUARK_DRIVE_URL } from './update-channels'

vi.mock('./manager-help', async importOriginal => {
  const actual = await importOriginal<typeof import('./manager-help')>()
  return {
    ...actual,
    installedPluginVersion: vi.fn(),
    checkLatestRelease: vi.fn(),
    compareGeckoVersions: vi.fn(),
    openHelpLink: vi.fn(),
  }
})
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers() })

function fixture() {
  const win = { fetch: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), closed: false }
  const document = { defaultView: win, hasFocus: () => false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as Document
  const host = {}
  vi.mocked(installedPluginVersion).mockResolvedValue('0.4.7')
  return { document, host, win }
}

it('coalesces simultaneous entries and caches a successful check', async () => {
  const { document, host } = fixture()
  vi.mocked(checkLatestRelease).mockResolvedValue({ current: '0.4.7', latest: '0.4.7', state: 'latest', url: '', notes: { zhCN: [], enUS: [] } })
  await Promise.all([silentlyCheckForUpdates(document, host, 'id'), silentlyCheckForUpdates(document, host, 'id')])
  await silentlyCheckForUpdates(document, host, 'id')
  expect(checkLatestRelease).toHaveBeenCalledTimes(1)
})

it('contains failure without listeners or UI, and retries after a minute', async () => {
  vi.useFakeTimers()
  const { document, host, win } = fixture()
  vi.mocked(checkLatestRelease).mockRejectedValue(new Error('offline'))
  await silentlyCheckForUpdates(document, host, 'id')
  await silentlyCheckForUpdates(document, host, 'id')
  expect(checkLatestRelease).toHaveBeenCalledTimes(1)
  expect(win.addEventListener).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(60_000)
  await silentlyCheckForUpdates(document, host, 'id')
  expect(checkLatestRelease).toHaveBeenCalledTimes(2)
})

it('defers an available release in an inactive window, and never repeats a shown version', async () => {
  const { document, host, win } = fixture()
  vi.mocked(checkLatestRelease).mockResolvedValue({ current: '0.4.7', latest: '0.4.8', state: 'available', url: '', notes: { zhCN: ['修复更新弹窗。'], enUS: ['Improve the update dialog.'] } })
  await silentlyCheckForUpdates(document, host, 'id')
  expect(win.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function))
  const state = (host as Parameters<typeof silentlyCheckForUpdates>[1]).__jadenseReleaseCheck!
  state.shown.add('0.4.8')
  win.addEventListener.mockClear()
  await silentlyCheckForUpdates(document, host, 'id')
  expect(win.addEventListener).not.toHaveBeenCalled()
})

it('renders three channels with domestic guidance in showUpdateDialog and opens each link cleanly', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const doc = dom.window.document
  const proto = dom.window.HTMLDialogElement?.prototype ?? dom.window.HTMLElement.prototype
  const showModal = vi.fn(function (this: HTMLElement) { this.setAttribute('open', '') })
  const close = vi.fn(function (this: HTMLElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new dom.window.Event('close'))
  })
  Object.defineProperty(proto, 'showModal', { value: showModal, configurable: true })
  Object.defineProperty(proto, 'close', { value: close, configurable: true })

  const releaseUrl = 'https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.20'
  const host = { launchURL: vi.fn() }
  const opened = showUpdateDialog(doc, host, {
    current: '0.6.19',
    latest: '0.6.20',
    state: 'available',
    url: releaseUrl,
    notes: { zhCN: ['支持多渠道更新下载。'], enUS: ['Support multi-channel update downloads.'] },
  })
  expect(opened).toBe(true)

  const dialog = doc.getElementById('jadense-update-dialog')!
  expect(dialog).toBeTruthy()
  expect(dialog.querySelectorAll('.jdx-update-channel-row')).toHaveLength(3)
  expect(dialog.querySelector('.jdx-update-channels-tip')?.textContent).toContain('网盘')

  dialog.querySelector<HTMLButtonElement>('[data-channel-open="baidu"]')!.click()
  expect(openHelpLink).toHaveBeenCalledWith(host, BAIDU_NETDISK_URL)
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain('4sci')
  // 打开某个渠道后不立即关闭弹窗，方便用户复制提取码或切换其他镜像。
  expect(doc.getElementById('jadense-update-dialog')).toBe(dialog)

  dialog.querySelector<HTMLButtonElement>('[data-channel-open="quark"]')!.click()
  expect(openHelpLink).toHaveBeenCalledWith(host, QUARK_DRIVE_URL)

  dialog.querySelector<HTMLButtonElement>('[data-channel-open="github"]')!.click()
  expect(openHelpLink).toHaveBeenCalledWith(host, releaseUrl)

  vi.mocked(openHelpLink).mockImplementationOnce(() => { throw new Error('browser unavailable') })
  dialog.querySelector<HTMLButtonElement>('[data-channel-open="baidu"]')!.click()
  expect(dialog.querySelector<HTMLElement>('[role="status"]')?.dataset.kind).toBe('error')

  dialog.querySelector<HTMLButtonElement>('footer button')!.click()
  expect(doc.getElementById('jadense-update-dialog')).toBeNull()
})
