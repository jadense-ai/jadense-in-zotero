/** 共享服务节奏和取消的时间回归，不实际等待限流窗口。 */
import { afterEach, expect, it, vi } from 'vitest'
import { queueTranslation, retryAt, TranslationRateLimitError } from './translation-queue'
afterEach(() => vi.useRealTimers())

it('honors Retry-After and never retries the rejected operation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10000)
  const host = {}, first = vi.fn(async () => { throw new TranslationRateLimitError(retryAt('5')) })
  await expect(queueTranslation(host, 'bing', undefined, first)).rejects.toBeInstanceOf(TranslationRateLimitError)
  const second = vi.fn(async () => 'ok'), waiting = queueTranslation(host, 'bing', undefined, second)
  await vi.advanceTimersByTimeAsync(4900); expect(second).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(101); expect(await waiting).toBe('ok'); expect(first).toHaveBeenCalledOnce()
})

it('cancels queued work without dispatch and keeps other services independent', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10000)
  const host = {}, controller = new AbortController()
  await queueTranslation(host, 'google', undefined, async () => 'first')
  const run = vi.fn(async () => 'late')
  const waiting = queueTranslation(host, 'google', controller.signal, run)
  const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await vi.advanceTimersByTimeAsync(200); await rejected
  expect(run).not.toHaveBeenCalled()
  expect(await queueTranslation(host, 'bing', undefined, async () => 'independent')).toBe('independent')
})
