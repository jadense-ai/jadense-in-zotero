import { expect, it, vi } from 'vitest'
import { confirmFirstFullTranslation, TRANSLATION_WARNING_PREF } from './translation-warning'
it('warns independently of old analysis acceptance and remembers only acceptance', () => {
  const prefs = new Map<string, unknown>([['extensions.jadenseInZotero.analysisWarningAcknowledged', true]])
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
  const host = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) }, getMainWindow: () => ({ confirm }) } as never
  expect(confirmFirstFullTranslation(host)).toBe(false)
  expect(prefs.has(TRANSLATION_WARNING_PREF)).toBe(false)
  expect(confirmFirstFullTranslation(host)).toBe(true)
  expect(prefs.get(TRANSLATION_WARNING_PREF)).toBe(true)
  expect(confirmFirstFullTranslation(host)).toBe(true)
  expect(confirm).toHaveBeenCalledTimes(2)
  expect(confirm.mock.calls[0][0]).toMatch(/全文翻译|Full translation/)
  expect(confirm.mock.calls[0][0]).not.toMatch(/全文解析|document analysis/)
})
