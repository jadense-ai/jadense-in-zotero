/** 翻译服务共享串行节奏；只排队，不自动重试已派发的请求。 */
type QueueHost = { __jadenseTranslationServices?: Map<string, { tail: Promise<unknown>; next: number }> }
export class TranslationRateLimitError extends Error {
  constructor(readonly retryAt: number) { super(`翻译服务限流 / Translation rate limited. ${new Date(retryAt).toLocaleTimeString()} 后可继续 / Resume after this time.`) }
}
export function retryAt(value: string | null) {
  const seconds = value === null ? NaN : Number(value)
  return Math.max(Date.now() + 1000, Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(value ?? '') || Date.now() + 60_000)
}
export async function queueTranslation<T>(host: object, key: string, signal: AbortSignal | undefined, operation: () => Promise<T>, interval = 1000): Promise<T> {
  const shared = host as QueueHost
  const map = shared.__jadenseTranslationServices ??= new Map()
  const queue = map.get(key) ?? { tail: Promise.resolve(), next: 0 }; map.set(key, queue)
  const run = queue.tail.catch(() => {}).then(async () => {
    const check = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError') }
    check()
    while (queue.next > Date.now()) { await new Promise(resolve => setTimeout(resolve, Math.min(100, queue.next - Date.now()))); check() }
    try { return await operation() }
    catch (error) { if (error instanceof TranslationRateLimitError) queue.next = error.retryAt; throw error }
    finally { queue.next = Math.max(queue.next, Date.now() + interval) }
  })
  queue.tail = run.catch(() => {})
  return run
}
