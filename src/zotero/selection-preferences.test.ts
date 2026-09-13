/** 选文偏好兼容性与展示存储失败隔离。 */
import { expect, it } from 'vitest'
import { readSelectionPreferences, saveSelectionPreferences } from './selection-preferences'

it('defaults to waiting and remembered position, preserves independent settings and ignores additive data', () => {
  let value = ''
  const host = { Prefs: { get: () => value, set: (_key: string, next: unknown) => { value = String(next) } } }
  expect(readSelectionPreferences(host)).toEqual({ placement: 'remember', behavior: 'wait' })
  saveSelectionPreferences(host, { behavior: 'quote' })
  saveSelectionPreferences(host, { placement: 'selection', geometry: { left: 30, top: 40, width: 500, height: 300 } })
  value = JSON.stringify({ ...JSON.parse(value), future: true })
  expect(readSelectionPreferences(host)).toMatchObject({ behavior: 'quote', placement: 'selection', geometry: { width: 500 } })
  value = '{broken'
  expect(readSelectionPreferences(host).behavior).toBe('wait')
  expect(() => saveSelectionPreferences({ Prefs: { get: () => { throw Error() }, set: () => { throw Error() } } }, { behavior: 'translate' })).not.toThrow()
})
