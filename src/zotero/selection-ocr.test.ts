/** 选文增强回归：关闭零调用、成功保留公式、失败降级及取消不继续。 */
import { beforeEach, expect, it, vi } from 'vitest'
import { enhanceSelection } from './selection-ocr'
import { readOCRSelection, OCR_SELECTION_PREF, readSelectionOCR } from './local-ocr'
import type { ZoteroLike } from './runtime'
vi.mock('./local-ocr', async original => ({ ...await original<typeof import('./local-ocr')>(), readOCRSelection: vi.fn() }))
beforeEach(() => { vi.mocked(readOCRSelection).mockReset() })
const host = (value: unknown) => ({ Prefs: { get: (key: string) => key === OCR_SELECTION_PREF ? value : undefined } }) as unknown as ZoteroLike
const selection = { itemID: 1, text: 'broken fffff', extra: 'retained' }
const regions = [{ pageIndex: 0, rects: [[0, 0, 20, 10]] }]
it.each([false, undefined, 'true', { extra: 1 }])('disabled or unknown preference %s needs no OCR', async value => {
  expect(readSelectionOCR(host(value))).toBe(false)
  expect(await enhanceSelection(host(value), selection, regions, new AbortController().signal, vi.fn(), vi.fn())).toBe(selection)
  expect(readOCRSelection).not.toHaveBeenCalled()
})
it('uses OCR for the complete selection including formulas', async () => {
  vi.mocked(readOCRSelection).mockResolvedValue('The result is\n\n$$x^2$$')
  const result = await enhanceSelection(host(true), selection, regions, new AbortController().signal, vi.fn(), vi.fn())
  expect(result).toEqual({ ...selection, text: 'The result is\n\n$$x^2$$' })
  expect(selection.text).toBe('broken fffff')
})
it('warns and retains the original on missing scope or OCR failure', async () => {
  const warning = vi.fn()
  expect(await enhanceSelection(host(true), selection, undefined, new AbortController().signal, vi.fn(), warning)).toBe(selection)
  expect(readOCRSelection).not.toHaveBeenCalled()
  vi.mocked(readOCRSelection).mockRejectedValue(new Error('unavailable'))
  expect(await enhanceSelection(host(true), selection, regions, new AbortController().signal, vi.fn(), warning)).toBe(selection)
  expect(warning).toHaveBeenCalledTimes(2)
})
it('does not fall back or accept a result after cancellation', async () => {
  const controller = new AbortController(), warning = vi.fn()
  vi.mocked(readOCRSelection).mockImplementation(async () => { controller.abort(); return 'stale' })
  await expect(enhanceSelection(host(true), selection, regions, controller.signal, vi.fn(), warning)).rejects.toMatchObject({ name: 'AbortError' })
  expect(warning).not.toHaveBeenCalled()
})
