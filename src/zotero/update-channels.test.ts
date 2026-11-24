/** 多渠道下载模块测试：覆盖渠道顺序、提取码复制、链接安全回退与中英文文案。 */
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BAIDU_NETDISK_PASSCODE,
  BAIDU_NETDISK_URL,
  createDownloadChannelsPanel,
  DEFAULT_RELEASES_URL,
  domesticChannelTip,
  getUpdateDownloadChannels,
  QUARK_DRIVE_PASSCODE,
  QUARK_DRIVE_URL,
} from './update-channels'

afterEach(() => { vi.useRealTimers() })

describe('update download channels', () => {
  it('orders domestic cloud drives first in zh-CN and GitHub first in en-US', () => {
    const tagUrl = 'https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.20'
    const zh = getUpdateDownloadChannels(tagUrl, 'zh-CN')
    expect(zh.map(item => item.id)).toEqual(['baidu', 'quark', 'github'])
    expect(zh[0]).toMatchObject({ url: BAIDU_NETDISK_URL, passcode: BAIDU_NETDISK_PASSCODE, domesticRecommended: true })
    expect(zh[1]).toMatchObject({ url: QUARK_DRIVE_URL, passcode: QUARK_DRIVE_PASSCODE, domesticRecommended: true })
    expect(zh[2]).toMatchObject({ url: tagUrl, domesticRecommended: false })

    const en = getUpdateDownloadChannels(tagUrl, 'en-US')
    expect(en.map(item => item.id)).toEqual(['github', 'baidu', 'quark'])
  })

  it('falls back to the fixed releases URL when githubUrl is outside the repository', () => {
    const channels = getUpdateDownloadChannels('https://evil.invalid/release', 'en-US')
    expect(channels[0].url).toBe(DEFAULT_RELEASES_URL)
  })

  it('includes target version folder guidance in domestic recommendation tip', () => {
    expect(domesticChannelTip('0.6.20', 'zh-CN')).toContain('v0.6.20')
    expect(domesticChannelTip('0.6.20', 'zh-CN')).toContain('网盘')
    expect(domesticChannelTip(undefined, 'zh-CN')).toContain('最新版本目录')
    expect(domesticChannelTip('0.6.20', 'en-US')).toContain('v0.6.20')
  })

  it('renders three channels, opens each target, and supports passcode copy with timer reset', async () => {
    vi.useFakeTimers()
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText }, configurable: true })

    const onOpen = vi.fn()
    const onCopyPasscode = vi.fn()
    const panel = createDownloadChannelsPanel(dom.window.document, {
      version: '0.6.20',
      githubUrl: 'https://github.com/jadense-ai/jadense-in-zotero/releases/tag/v0.6.20',
      locale: 'zh-CN',
      onOpen,
      onCopyPasscode,
    })
    dom.window.document.body.append(panel.element)

    const rows = panel.element.querySelectorAll('.jdx-update-channel-row')
    expect(rows).toHaveLength(3)
    expect(panel.element.querySelector('.jdx-update-channels-tip')?.textContent).toContain('中国大陆用户')

    const openButtons = Array.from(panel.element.querySelectorAll<HTMLButtonElement>('[data-channel-open]'))
    expect(openButtons).toHaveLength(3)
    for (const button of openButtons) button.click()
    expect(onOpen.mock.calls.map(([ch]) => ch.id)).toEqual(['baidu', 'quark', 'github'])

    const baiduCodeBtn = panel.element.querySelector<HTMLButtonElement>('button[data-passcode="4sci"]')!
    baiduCodeBtn.click()
    await vi.waitFor(() => expect(onCopyPasscode).toHaveBeenCalledWith(expect.objectContaining({ id: 'baidu', passcode: '4sci' }), true))
    expect(writeText).toHaveBeenCalledWith('4sci')
    expect(baiduCodeBtn.dataset.copied).toBe('true')

    await vi.advanceTimersByTimeAsync(2000)
    expect(baiduCodeBtn.dataset.copied).toBeUndefined()
    panel.cleanup()
  })
})
