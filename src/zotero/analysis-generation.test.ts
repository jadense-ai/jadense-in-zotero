/** 故障注入验证解析重试有界、取消及时、未知执行不重复派发。 */
import { afterEach, expect, it, vi } from 'vitest'
import { generateAnalysis } from './analysis-generation'
import { analysisStage } from './analysis-stage'

afterEach(() => vi.useRealTimers())

it('recovers a stalled Jadense generation without dispatching a second model request', async () => {
  vi.useFakeTimers()
  let attemptSignal!: AbortSignal
  const send = vi.fn((signal: AbortSignal) => { attemptSignal = signal; return new Promise<string>(() => {}) })
  const recover = vi.fn(async () => 'Recovered summary'), onRetry = vi.fn()
  const result = generateAnalysis({ signal: new AbortController().signal, route: 'jadense', send, recover, onRetry })
  await vi.advanceTimersByTimeAsync(182_001)
  expect(await result).toBe('Recovered summary')
  expect(send).toHaveBeenCalledOnce()
  expect(recover).toHaveBeenCalledOnce()
  expect(attemptSignal.aborted).toBe(true)
  expect(onRetry.mock.calls).toEqual([[true], [false]])
  expect(vi.getTimerCount()).toBe(0)
})

it('retries explicit throttling twice, honors Retry-After and stops after exhaustion', async () => {
  vi.useFakeTimers()
  const error = Object.assign(new Error('Limited'), { status: 429, retryAfter: '3' })
  const send = vi.fn(async () => { throw error }), recover = vi.fn()
  const result = expect(generateAnalysis({ signal: new AbortController().signal, route: 'byok', send, recover })).rejects.toThrow('Limited')
  await vi.advanceTimersByTimeAsync(2999)
  expect(send).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(3002)
  await result
  expect(send).toHaveBeenCalledTimes(3)
  expect(recover).not.toHaveBeenCalled()
})

it.each([401, 402, 403, 500])('does not replay BYOK status %s', async status => {
  const send = vi.fn(async () => { throw Object.assign(new Error('Failure'), { status }) }), recover = vi.fn()
  await expect(generateAnalysis({ signal: new AbortController().signal, route: 'byok', send, recover })).rejects.toThrow('Failure')
  expect(send).toHaveBeenCalledOnce()
  expect(recover).not.toHaveBeenCalled()
})

it('cancels retry backoff immediately and never dispatches again', async () => {
  vi.useFakeTimers()
  const controller = new AbortController(), send = vi.fn(async () => { throw Object.assign(new Error('Limited'), { status: 429 }) })
  const result = expect(generateAnalysis({ signal: controller.signal, route: 'byok', send, recover: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(1)
  controller.abort(); await result
  await vi.advanceTimersByTimeAsync(300_000)
  expect(send).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('uses real progress for idle timeout but always enforces the total deadline', async () => {
  vi.useFakeTimers()
  let heartbeat!: () => void
  const result = expect(analysisStage(new AbortController().signal, 'PDF', 1000, (_signal, progress) => {
    heartbeat = progress; return new Promise(() => {})
  }, 3000)).rejects.toMatchObject({ code: 'ANALYSIS_TIMEOUT' })
  for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(700); heartbeat() }
  await vi.advanceTimersByTimeAsync(201); await result
  expect(vi.getTimerCount()).toBe(0)
})
