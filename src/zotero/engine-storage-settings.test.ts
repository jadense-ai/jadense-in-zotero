/** 存储位置表单：浏览和恢复默认只改草稿，保存后才执行迁移。 */
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { ZoteroLike } from './runtime'
import { wireEngineStorageSettings } from './engine-storage-settings'

const state = vi.hoisted(() => ({ change: vi.fn(), root: '/profile/jadense-pdf-translation' }))
vi.mock('./engine-storage', () => ({
  changeEngineStorage: state.change,
  cleanupLegacyUVCache: async () => false,
  engineStorageParent: () => '/profile',
  engineStoragePrefKey: () => 'storage',
  engineStorageRoot: () => state.root,
  previewEngineStorageRoot: (_host: unknown, _kind: string, input: string) => `${input || '/profile'}/jadense-pdf-translation`,
  retryEngineStorageCleanup: async () => false,
  storageRecovery: async () => undefined,
}))
vi.mock('./local-ocr', () => ({ ocrStorageBusyReason: () => undefined }))
vi.mock('./pdf-translation-jobs', () => ({ pdfTranslationJobs: () => ({ storageBusyReason: () => undefined }) }))

afterEach(() => { vi.unstubAllGlobals(); state.change.mockReset(); state.root = '/profile/jadense-pdf-translation'; document.body.replaceChildren() })

it('keeps typed, browsed and default paths as drafts until Save', async () => {
  vi.stubGlobal('PathUtils', { profileDir: '/profile' })
  vi.stubGlobal('ChromeUtils', { importESModule: () => ({ FilePicker: class {
    modeGetFolder = 2; returnCancel = 1; file = '/selected'
    init() {}
    async show() { return 0 }
  } }) })
  state.change.mockImplementation(async (_host: unknown, _kind: string, value: string) => {
    state.root = `${value || '/profile'}/jadense-pdf-translation`
    return { moved: true, root: state.root }
  })
  const root = document.createElement('section'), host = { Prefs: { get: () => undefined } } as unknown as ZoteroLike
  document.body.append(root)
  const dispose = wireEngineStorageSettings(host, root, 'pdf', {})
  const input = root.querySelector<HTMLInputElement>('input')!, buttons = [...root.querySelectorAll('button')]
  const button = (label: string) => buttons.find(value => value.textContent?.includes(label))!
  input.value = '/typed/new'; input.dispatchEvent(new Event('input', { bubbles: true }))
  expect(state.change).not.toHaveBeenCalled()
  expect(root.textContent).toContain('/typed/new/jadense-pdf-translation')
  button('浏览').click()
  await vi.waitFor(() => expect(input.value).toBe('/selected'))
  expect(state.change).not.toHaveBeenCalled()
  button('保存').click()
  await vi.waitFor(() => expect(state.change).toHaveBeenCalledWith(host, 'pdf', '/selected', expect.anything()))
  button('默认').click()
  expect(input.value).toBe('')
  expect(state.change).toHaveBeenCalledTimes(1)
  button('保存').click()
  await vi.waitFor(() => expect(state.change).toHaveBeenCalledTimes(2))
  expect(state.change.mock.calls[1][2]).toBe('')
  dispose()
})
