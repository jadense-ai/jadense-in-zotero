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

/** 翻译用途共享调度：业务名额覆盖响应消费，HTTP 配额覆盖 HEAD/POST/GET。 */
export const TRANSLATION_SPEED_PREF = 'extensions.jadenseInZotero.translationSpeed'
export const DEFAULT_TRANSLATION_SPEED = { concurrency: 2, rpm: 20, batchTokens: 1600 }
export type TranslationSpeed = typeof DEFAULT_TRANSLATION_SPEED
type SpeedHost = object & { Prefs?: { get(key: string, global?: boolean): unknown; set?(key: string, value: unknown, global?: boolean): void }; __jadenseTranslationScheduler?: TranslationScheduler }

export function translationServiceKey(address: string) {
  if (address === 'google') return 'https://translate.google.com'
  if (address === 'bing') return 'https://www.bing.com'
  try {
    const url = new URL(address)
    return url.origin + url.pathname.replace(/\/(?:chat\/completions|responses|messages|api\/chat(?:\/temporary)?)\/?$/u, '').replace(/\/+$/u, '')
  } catch { return address.trim().replace(/\/+$/u, '') }
}
export function translationSpeed(host: object, address: string): TranslationSpeed {
  let saved: Partial<TranslationSpeed> = {}
  try { saved = JSON.parse(String((host as SpeedHost).Prefs?.get(TRANSLATION_SPEED_PREF, true) ?? '{}'))[translationServiceKey(address)] ?? {} } catch { /* 可选设置损坏回默认值。 */ }
  const valid = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
  return { concurrency: Math.min(8, valid(saved.concurrency, 2)), rpm: valid(saved.rpm, 20), batchTokens: valid(saved.batchTokens, 1600) }
}
export function saveTranslationSpeed(host: object, address: string, speed: TranslationSpeed) {
  let values: Record<string, unknown> = {}
  try { const parsed = JSON.parse(String((host as SpeedHost).Prefs?.get(TRANSLATION_SPEED_PREF, true) ?? '{}')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values = parsed } catch { /* 只替换损坏的可选配置。 */ }
  values[translationServiceKey(address)] = speed
  const prefs = (host as SpeedHost).Prefs
  if (!prefs?.set) throw new Error('Translation settings are unavailable')
  prefs.set(TRANSLATION_SPEED_PREF, JSON.stringify(values), true)
  translationScheduler(host).refresh()
}
type Waiter = { task: string; signal?: AbortSignal; start(): void; cancel(): void }
type ServiceState = {
  address: string; active: number; inFlight: number; queue: Waiter[]; http: Waiter[]; lastTask: string; lastHttpTask: string
  starts: number[]; lastStart: number; cooldown: number; limitedAt: number | null; successes: number; machine: boolean
  httpTotal: number; submissions: number; rateLimits: number; waitMs: number; modelMs: number; timer?: ReturnType<typeof setTimeout>
}
export type TranslationSnapshot = TranslationSpeed & { active: number; queued: number; httpMinute: number; waitMs: number; httpTotal: number; submissions: number; rateLimits: number; queueTimeMs: number; modelTimeMs: number }
export type TranslationFetch = typeof fetch & { translationQueueTime?: () => number }

/** 单宿主服务表，不按密钥或模型拆桶，避免跨窗口叠加额度。 */
export class TranslationScheduler {
  private services = new Map<string, ServiceState>()
  private operations = new Map<string, Promise<unknown>>()
  private controllers = new Set<AbortController>()
  private stopped = false
  constructor(private host: object) {}
  private state(address: string, machine = false) {
    const key = translationServiceKey(address)
    let state = this.services.get(key)
    if (!state) { state = { address: key, active: 0, inFlight: 0, queue: [], http: [], lastTask: '', lastHttpTask: '', starts: [], lastStart: -Infinity, cooldown: 0, limitedAt: null, successes: 0, machine, httpTotal: 0, submissions: 0, rateLimits: 0, waitMs: 0, modelMs: 0 }; this.services.set(key, state) }
    state.machine ||= machine || key === translationServiceKey('google') || key === translationServiceKey('bing')
    return state
  }
  private limits(state: ServiceState) {
    const limits = translationSpeed(this.host, state.address)
    if (state.limitedAt !== null && Date.now() - state.limitedAt >= 300_000 && state.successes >= 5) state.limitedAt = null
    if (state.limitedAt !== null) { limits.concurrency = 1; limits.rpm = Math.max(1, Math.floor(limits.rpm / 2)) }
    if (state.machine) limits.concurrency = 1
    return limits
  }
  private readyAt(state: ServiceState) {
    const { rpm } = this.limits(state), now = Date.now()
    state.starts = state.starts.filter(time => time > now - 60_000)
    return Math.max(state.cooldown, state.lastStart + 60_000 / rpm, state.starts.length >= rpm ? state.starts[state.starts.length - rpm] + 60_000 : 0)
  }
  snapshot(address: string): TranslationSnapshot {
    const state = this.state(address), limits = this.limits(state), ready = this.readyAt(state)
    return { ...limits, active: state.inFlight, queued: state.queue.length + state.http.length, httpMinute: state.starts.length, waitMs: Math.max(0, ready - Date.now()), httpTotal: state.httpTotal, submissions: state.submissions, rateLimits: state.rateLimits, queueTimeMs: state.waitMs, modelTimeMs: state.modelMs }
  }
  refresh() { for (const state of this.services.values()) this.pump(state) }
  stop() {
    this.stopped = true
    for (const state of this.services.values()) { clearTimeout(state.timer); for (const waiter of [...state.queue, ...state.http]) waiter.cancel() }
    for (const controller of this.controllers) controller.abort()
  }
  private take(queue: Waiter[], previous: string) {
    const index = queue.findIndex(row => row.task !== previous)
    return queue.splice(Math.max(0, index), 1)[0]
  }
  private pump(state: ServiceState) {
    clearTimeout(state.timer); state.timer = undefined
    if (this.stopped) return
    const now = Date.now(), limits = this.limits(state)
    if (state.cooldown <= now) while (state.active < limits.concurrency && state.queue.length) {
      const next = this.take(state.queue, state.lastTask); state.lastTask = next.task; state.active++; next.start()
    }
    if (state.http.length && state.inFlight < limits.concurrency && this.readyAt(state) <= now) {
      const next = this.take(state.http, state.lastHttpTask); state.lastHttpTask = next.task
      state.starts.push(now); state.lastStart = now; state.httpTotal++; next.start()
    }
    if ((state.http.length && state.inFlight < limits.concurrency) || (state.queue.length && state.cooldown > now)) {
      state.timer = setTimeout(() => this.pump(state), Math.max(1, Math.min(2_147_483_647, (state.http.length ? this.readyAt(state) : state.cooldown) - now)))
    }
  }
  private wait(state: ServiceState, queue: Waiter[], task: string, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const began = Date.now()
      const abort = () => { const index = queue.indexOf(row); if (index >= 0) queue.splice(index, 1); signal?.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')); this.pump(state) }
      const row: Waiter = { task, signal, cancel: abort, start: () => { signal?.removeEventListener('abort', abort); state.waitMs += Date.now() - began; resolve() } }
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      queue.push(row); signal?.addEventListener('abort', abort, { once: true }); this.pump(state)
    })
  }
  /** 已提交但结果不确定的操作由原客户端恢复；此处从不自动重发。 */
  run<T>(input: { address: string; task: string; operation?: string; signal?: AbortSignal; machine?: boolean; fetchImpl: typeof fetch }, work: (network: typeof fetch, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    const identity = input.operation ? JSON.stringify([translationServiceKey(input.address), input.task, input.operation]) : undefined
    const existing = identity && this.operations.get(identity)
    if (existing) return existing as Promise<T>
    const result = this.execute(input, work).finally(() => { if (identity) this.operations.delete(identity) })
    if (identity) this.operations.set(identity, result)
    return result
  }
  private async execute<T>(input: { address: string; task: string; signal?: AbortSignal; machine?: boolean; fetchImpl: typeof fetch }, work: (network: typeof fetch, signal: AbortSignal) => Promise<T>) {
    const state = this.state(input.address, input.machine)
    await this.wait(state, state.queue, input.task, input.signal)
    const controller = new AbortController(), abort = () => controller.abort()
    this.controllers.add(controller); if (this.stopped) abort()
    input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort()
    let deadline: ReturnType<typeof setTimeout> | undefined, dispatchedAt: number | undefined
    let queuedTime = 0, waitingSince: number | undefined
    const network: TranslationFetch = async (url, init) => {
      clearTimeout(deadline)
      if (dispatchedAt !== undefined) { state.modelMs += Date.now() - dispatchedAt; dispatchedAt = undefined; state.inFlight-- }
      const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
      waitingSince = Date.now()
      try { await this.wait(state, state.http, input.task, signal) }
      finally { queuedTime += Date.now() - waitingSince; waitingSince = undefined }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      dispatchedAt = Date.now(); state.inFlight++; deadline = setTimeout(abort, input.machine ? 30_000 : 180_000)
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') state.submissions++
      const response = await input.fetchImpl(url, { ...init, signal })
      if (response.status === 429) {
        state.cooldown = Math.max(state.cooldown, retryAt(response.headers.get('Retry-After')))
        state.limitedAt = Date.now(); state.successes = 0; state.rateLimits++; this.pump(state)
      }
      return response
    }
    network.translationQueueTime = () => queuedTime + (waitingSince === undefined ? 0 : Date.now() - waitingSince)
    const rateLimits = state.rateLimits
    try { if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError'); const result = await work(network, controller.signal); if (rateLimits === state.rateLimits) state.successes++; return result }
    finally { clearTimeout(deadline); this.controllers.delete(controller); if (dispatchedAt !== undefined) { state.modelMs += Date.now() - dispatchedAt; state.inFlight-- } input.signal?.removeEventListener('abort', abort); state.active--; this.pump(state) }
  }
}
export function translationScheduler(host: object) { return (host as SpeedHost).__jadenseTranslationScheduler ??= new TranslationScheduler(host) }
export function stopTranslationScheduler(host: object) { const shared = host as SpeedHost; shared.__jadenseTranslationScheduler?.stop(); delete shared.__jadenseTranslationScheduler }
