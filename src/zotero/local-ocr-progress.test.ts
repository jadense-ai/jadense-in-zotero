/** 原生偏好可销毁其沙箱；旧进度对象不可读时仍须允许新窗口订阅。 */
import { expect, it, vi } from 'vitest'
import { observeOCRProgress, registerOCRSettingsOperation } from './local-ocr'
import type { ZoteroLike } from './runtime'

it('contains an expired pane snapshot and keeps shared subscriber collections in the main window realm', () => {
  class MainWindowSet<T> extends Set<T> {}
  const expired = Proxy.revocable({ stage: 'environment' }, {})
  expired.revoke()
  const host = {
    getMainWindow: () => ({ Set: MainWindowSet }),
    __jadenseOCRProgress: expired.proxy,
  } as unknown as ZoteroLike
  const listener = vi.fn(value => value.stage)
  const stop = observeOCRProgress(host, listener)
  const shared = host as unknown as { __jadenseOCRProgressObservers: Set<unknown>; __jadenseOCRSettingsOperations: Set<unknown> }
  expect(shared.__jadenseOCRProgressObservers).toBeInstanceOf(MainWindowSet)
  const unregister = registerOCRSettingsOperation(host, new AbortController())
  expect(shared.__jadenseOCRSettingsOperations).toBeInstanceOf(MainWindowSet)
  stop(); unregister()
  expect(shared.__jadenseOCRProgressObservers.size).toBe(0)
  expect(shared.__jadenseOCRSettingsOperations.size).toBe(0)
})
