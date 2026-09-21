/** 诊断能力故障与敏感错误投影不能改变生命周期结果。 */
import { expect, it, vi } from 'vitest'
import { diagnostics, stopDiagnostics } from './diagnostics'
import { lifecycleTrace } from './lifecycle-diagnostics'

it('contains collector and logger failures', () => {
  const host = { get __jadenseDiagnostics(): never { throw new Error('storage unavailable') }, debug() { throw new Error('logger unavailable') } }
  expect(() => {
    const trace = lifecycleTrace(host, 'reader-sidebar', 'open'); trace.event('native_render'); trace.fail(new Error('secret'), 'native_failed'); trace.end('error')
  }).not.toThrow()
})
it('retains the native failure while reporting successful fallback, without error text or private paths', async () => {
  const host = {}, store = diagnostics(host)!, trace = lifecycleTrace(host, 'reader-sidebar', 'open', 'reader')
  const error = Object.assign(new TypeError('Bearer PRIVATE /user/private.pdf'), { stack: 'TypeError PRIVATE\nfile:///private/bootstrap.js:123:45' })
  trace.fail(error, 'native_failed', 'SIDEBAR_NATIVE_FAILED'); trace.event('dock_ready'); trace.end()
  const row = store.list()[0]
  expect(row).toMatchObject({ category: 'success', firstError: { stage: 'native_failed', code: 'SIDEBAR_NATIVE_FAILED', name: 'TypeError', stack: 'bootstrap.js:123:45' } })
  expect(store.export()).not.toMatch(/PRIVATE|private\.pdf|file:\/\//)
  await store.flush(); stopDiagnostics(host)
})
it('preserves successful opening when disk writes fail', async () => {
  const host = {}, store = diagnostics(host)!
  const fail = vi.spyOn(store, 'changed').mockImplementation(() => { throw new Error('disk failure') })
  const trace = lifecycleTrace(host, 'reader-sidebar', 'open'); expect(() => { trace.event('native_ready'); trace.end() }).not.toThrow()
  fail.mockRestore(); stopDiagnostics(host)
})
