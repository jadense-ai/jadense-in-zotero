/** 静默检查覆盖跨窗口并发、失败恢复和正式版筛选后的展示条件。 */
import { afterEach, expect, it, vi } from 'vitest'
import { silentlyCheckForUpdates } from './update-notification'
import { checkLatestRelease, installedPluginVersion } from './manager-help'

vi.mock('./manager-help', () => ({ installedPluginVersion: vi.fn(), checkLatestRelease: vi.fn(), compareGeckoVersions: vi.fn(), openHelpLink: vi.fn() }))
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
  vi.mocked(checkLatestRelease).mockResolvedValue({ current: '0.4.7', latest: '0.4.7', state: 'latest', url: '' })
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
  vi.mocked(checkLatestRelease).mockResolvedValue({ current: '0.4.7', latest: '0.4.8', state: 'available', url: '' })
  await silentlyCheckForUpdates(document, host, 'id')
  expect(win.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function))
  const state = (host as Parameters<typeof silentlyCheckForUpdates>[1]).__jadenseReleaseCheck!
  state.shown.add('0.4.8')
  win.addEventListener.mockClear()
  await silentlyCheckForUpdates(document, host, 'id')
  expect(win.addEventListener).not.toHaveBeenCalled()
})
