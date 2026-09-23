/** 使用真实流消费和虚拟时间验证服务总量、并发及冷却边界。 */
import { afterEach, expect, it, vi } from 'vitest'
import { translationScheduler, saveTranslationSpeed, translationServiceKey } from './translation-queue'

afterEach(() => vi.useRealTimers())
const address = 'https://example.test/v1'
function host() { let value = '{}'; return { Prefs: { get: () => value, set: (_key: string, next: unknown) => { value = String(next) } } } }

it('counts HEAD, submissions and recovery in one sliding window without a burst', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const scheduler = translationScheduler(host()), starts: number[] = []
  const fetchImpl = vi.fn(async () => { starts.push(Date.now()); return new Response('ok') })
  const jobs = Array.from({ length: 24 }, (_, i) => scheduler.run({ address, task: String(i % 3), fetchImpl }, async (network, signal) => {
    await (await network(address, { method: i % 3 === 0 ? 'HEAD' : i % 3 === 1 ? 'POST' : 'GET', signal })).text()
  }))
  await vi.advanceTimersByTimeAsync(59_999); expect(starts).toHaveLength(20)
  await vi.advanceTimersByTimeAsync(20_000); await Promise.all(jobs)
  expect(starts.every((time, i) => !i || time - starts[i - 1] >= 3000)).toBe(true)
  expect(starts.every(time => starts.filter(other => other > time - 60_000 && other <= time).length <= 20)).toBe(true)
  expect(scheduler.snapshot(address)).toMatchObject({ active: 0, httpTotal: 24, submissions: 8 })
})

it('holds the concurrency permit until stream completion and fairly rotates tasks', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const scheduler = translationScheduler(host()), order: string[] = [], release: Array<() => void> = []
  const fetchImpl = vi.fn(async () => new Response('ok'))
  const run = (task: string) => scheduler.run({ address, task, fetchImpl }, async network => { await network(address); order.push(task); await new Promise<void>(resolve => release.push(resolve)) })
  const jobs = [run('pdf'), run('pdf'), run('pdf'), run('selection')]
  await vi.advanceTimersByTimeAsync(6000); expect(order).toEqual(['pdf', 'pdf']); expect(scheduler.snapshot(address).active).toBe(2)
  release.shift()!(); await vi.advanceTimersByTimeAsync(1); expect(order.at(-1)).toBe('selection')
  release.shift()!(); await vi.advanceTimersByTimeAsync(3000); expect(order.at(-1)).toBe('pdf')
  release.forEach(done => done()); await Promise.all(jobs)
})

it('cools every caller on 429, does not replay it, and reduces effective limits', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const scheduler = translationScheduler(host()), fetchImpl = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '90' } }))
  await scheduler.run({ address, task: 'pdf', fetchImpl }, network => network(address))
  const later = vi.fn(async () => new Response('ok'))
  const pending = scheduler.run({ address, task: 'selection', fetchImpl: later }, network => network(address))
  expect(scheduler.snapshot(address)).toMatchObject({ concurrency: 1, rpm: 10, rateLimits: 1 })
  await vi.advanceTimersByTimeAsync(89_999); expect(later).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); await pending; expect(fetchImpl).toHaveBeenCalledOnce()
})

it('cancels queued requests, deduplicates operations, and applies new limits without cancelling active work', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const h = host(), scheduler = translationScheduler(h), abort = new AbortController()
  let release!: () => void
  const fetchImpl = vi.fn(async () => new Response('ok'))
  const work = vi.fn(async (network: typeof fetch) => { await network(address); await new Promise<void>(resolve => { release = resolve }); return 'done' })
  const input = { address, task: 'pdf', operation: 'batch-1', fetchImpl }
  const a = scheduler.run(input, work), b = scheduler.run(input, work)
  await vi.advanceTimersByTimeAsync(1)
  saveTranslationSpeed(h, address, { concurrency: 1, rpm: 1, batchTokens: 1600 })
  const waiting = scheduler.run({ address, task: 'selection', signal: abort.signal, fetchImpl }, work)
  const check = expect(waiting).rejects.toMatchObject({ name: 'AbortError' }); abort.abort(); await check
  release(); expect(await a).toBe('done'); expect(await b).toBe('done'); expect(work).toHaveBeenCalledOnce()
  expect(scheduler.snapshot(address)).toMatchObject({ concurrency: 1, rpm: 1, active: 0 })
  expect(translationServiceKey(address + '/chat/completions')).toBe(address)
})

it('meets the simulated throughput target with six page batches and fixed five-second model latency', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const scheduler = translationScheduler(host())
  const fetchImpl = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 5000)); return new Response('translated') })
  // 六页 × 每页十个约 100 token 段落；旧 >200 阈值每页四批，新容量每页一批。
  const oldRequests = 24, oldMs = oldRequests * 5000
  const jobs = Array.from({ length: 6 }, (_, index) => scheduler.run({ address, task: 'six-page-fixture', operation: String(index), fetchImpl }, async network => (await network(address, { method: 'POST' })).text()))
  let completedAt = 0
  const done = Promise.all(jobs).then(() => { completedAt = Date.now() })
  await vi.advanceTimersByTimeAsync(30_000); await done
  expect(fetchImpl).toHaveBeenCalledTimes(6)
  expect(1 - 6 / oldRequests).toBeGreaterThanOrEqual(.7)
  expect(1 - completedAt / oldMs).toBeGreaterThanOrEqual(.5)
  expect(completedAt).toBe(20_000)
})

it('recovers the configured limits after five successes and five minutes without another 429', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const scheduler = translationScheduler(host())
  await scheduler.run({ address, task: 'rate-limited', fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '1' } }) }, network => network(address))
  const jobs = Array.from({ length: 5 }, (_, i) => scheduler.run({ address, task: String(i), fetchImpl: async () => new Response('ok') }, network => network(address)))
  await vi.advanceTimersByTimeAsync(31_000); await Promise.all(jobs)
  expect(scheduler.snapshot(address)).toMatchObject({ concurrency: 1, rpm: 10 })
  await vi.advanceTimersByTimeAsync(269_000)
  expect(scheduler.snapshot(address)).toMatchObject({ concurrency: 2, rpm: 20 })
})
