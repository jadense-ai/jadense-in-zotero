/** 独立窗口契约：右键入口只携带选择快照，不打开工作台或依赖其生命周期。 */
import { describe, expect, it, vi } from 'vitest'
import { closeClassificationWindow, openClassificationWindow } from './classification-window'
import type { ZoteroManagerWindow } from './manager-window'

describe('classification native window', () => {
  it('opens its own chrome page, reuses it and reopens after closure', () => {
    const host = {}, openSettings = vi.fn(), receiveClassificationItems = vi.fn()
    const opened = { closed: false, focus: vi.fn(), close: vi.fn(), receiveClassificationItems }
    const openDialog = vi.fn(() => opened)
    const main = { openDialog, screen: { availWidth: 1920, availHeight: 1080 } } as unknown as ZoteroManagerWindow
    expect(openClassificationWindow(host, main, [1, 2], openSettings)).toBe(true)
    expect(openDialog).toHaveBeenCalledWith('chrome://jadense-in-zotero/content/classification.xhtml', 'jadense-in-zotero-classification', expect.stringContaining('dialog=no'), { zotero: host, itemIDs: [1, 2], openSettings })
    expect(openSettings).not.toHaveBeenCalled()
    openClassificationWindow(host, main, [3], openSettings)
    expect(openDialog).toHaveBeenCalledTimes(1); expect(receiveClassificationItems).toHaveBeenCalledWith([3])
    opened.closed = true
    openClassificationWindow(host, main, [4], openSettings)
    expect(openDialog).toHaveBeenCalledTimes(2)
    closeClassificationWindow(host); expect(opened.close).toHaveBeenCalledTimes(1)
  })
})
