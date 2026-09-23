/** 通过真实重试循环验证等待、上限、计费边界和取消。 */
import { afterEach, expect, it, vi } from 'vitest'
import { retryPDFTranslation } from './pdf-translation-retry'

afterEach(() => vi.useRealTimers())
it('recognizes network failures from another Gecko compartment', async () => {
  vi.useFakeTimers()
  const run = vi.fn().mockRejectedValueOnce({ name: 'TypeError', message: 'NetworkError' }).mockResolvedValue('translated')
  const result = retryPDFTranslation({ route: 'machine', signal: new AbortController().signal, run, recover: vi.fn(), progress: vi.fn() })
  await vi.runAllTimersAsync()
  expect(await result).toBe('translated'); expect(run).toHaveBeenCalledTimes(2)
})
it('retries a rate-limited batch and stops after three retries', async () => {
  vi.useFakeTimers()
  const failure = Object.assign(new Error('busy'), { status: 429, retryAfter: '2' })
  const run = vi.fn().mockRejectedValue(failure), progress = vi.fn(), recover = vi.fn()
  const result = retryPDFTranslation({ route: 'byok', signal: new AbortController().signal, run, recover, progress })
  const assertion = expect(result).rejects.toBe(failure)
  await vi.advanceTimersByTimeAsync(1999); expect(run).toHaveBeenCalledTimes(1)
  await vi.runAllTimersAsync(); await assertion
  expect(run).toHaveBeenCalledTimes(4); expect(recover).not.toHaveBeenCalled()
  expect(progress).toHaveBeenLastCalledWith()
})
it('recovers uncertain Jadense requests without another model submission, including recovery throttling', async () => {
  vi.useFakeTimers()
  const run = vi.fn().mockRejectedValue(new TypeError('network'))
  const recover = vi.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 429, retryAfter: '1' })).mockResolvedValue('translation')
  const result = retryPDFTranslation({ route: 'jadense', signal: new AbortController().signal, run, recover, progress: vi.fn() })
  await vi.runAllTimersAsync()
  expect(await result).toBe('translation'); expect(run).toHaveBeenCalledTimes(1); expect(recover).toHaveBeenCalledTimes(2)
})
it.each([new TypeError('network'), Object.assign(new Error('server'), { status: 503 }), Object.assign(new Error('auth'), { status: 401 })])('does not replay uncertain or unauthorized BYOK work', async error => {
  const run = vi.fn().mockRejectedValue(error)
  await expect(retryPDFTranslation({ route: 'byok', signal: new AbortController().signal, run, recover: vi.fn(), progress: vi.fn() })).rejects.toBe(error)
  expect(run).toHaveBeenCalledTimes(1)
})
it('cancels during the countdown without another request', async () => {
  vi.useFakeTimers()
  const controller = new AbortController(), run = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { status: 429 }))
  const result = retryPDFTranslation({ route: 'machine', signal: controller.signal, run, recover: vi.fn(), progress: vi.fn() })
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(1); controller.abort(); await assertion
  await vi.runAllTimersAsync(); expect(run).toHaveBeenCalledTimes(1)
})
