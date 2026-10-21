/** PDF 请求恢复：只重发明确被限流的请求，攻玉不确定结果走只读恢复。 */
import { executionResult } from '@/chat/request-feedback'
export type PDFRetryState = { attempt: number; until: number; recovering: boolean }

/** 快速恢复耗尽后只保存等待计划；鉴权、未知 BYOK 和内容错误不自动产生新付费轮次。 */
export function pdfRecoveryDelay(error: unknown, attempt = 0): number | undefined {
  const issue = (error ?? {}) as { status?: number; code?: string; name?: string; retryAfter?: string | null }
  if ([400, 401, 402, 403, 404, 422].includes(issue.status ?? 0) || issue.code === 'BYOK_EXECUTION_UNCONFIRMED') return
  const transient = issue.status === 429 || (issue.status !== undefined && issue.status >= 500)
    || issue.name === 'TypeError' || issue.name === 'AbortError'
    || ['TRANSLATION_TIMEOUT', 'RECOVERY_PENDING', 'STREAM_EARLY_EOF', 'STREAM_INCOMPLETE', 'STREAM_FAILED', 'PDF_ENGINE_FAILED', 'PDF_LOCAL_SAVE_FAILED', 'PDF_RENDER_FAILED'].includes(issue.code ?? '')
  if (!transient) return
  const seconds = issue.retryAfter == null ? NaN : Number(issue.retryAfter)
  const at = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(issue.retryAfter ?? '')
  return Math.max(1000, issue.status === 429 && Number.isFinite(at) ? at - Date.now() : Math.min(300_000, 15_000 * 2 ** Math.min(attempt, 5)))
}

/** 等待可随用户取消立即结束，不占用共享服务的并发槽。 */
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  })
}

/** 每批最多三次恢复；不自动重试鉴权、余额、配置或不确定的 BYOK 执行。 */
export async function retryPDFTranslation<T>(options: {
  route: 'machine' | 'byok' | 'jadense'; signal: AbortSignal
  run: () => Promise<T>; recover: (error: unknown) => Promise<T>
  progress: (state?: PDFRetryState) => void
}) {
  let recovering = false
  let previous: unknown
  try {
    for (let attempt = 0; ; attempt++) {
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      try { return await (recovering ? options.recover(previous) : options.run()) }
      catch (error) {
        if (options.signal.aborted) throw error
        const { status, code, retryAfter, name } = (error ?? {}) as { status?: number; code?: string; retryAfter?: string; name?: string }
        if (status !== 429 && ['partial', 'failed', 'cancelled'].includes(executionResult(error).state)) throw error
        // Gecko fetch 的异常来自窗口 compartment，不能依赖 instanceof。
        const transient = (status !== undefined && status >= 500) || name === 'TypeError' || name === 'AbortError' || ['STREAM_EARLY_EOF', 'STREAM_INCOMPLETE', 'STREAM_FAILED', 'RECOVERY_PENDING'].includes(code ?? '')
        if (attempt >= 3 || (status !== 429 && !(transient && options.route !== 'byok'))) throw error
        // 恢复 GET 的限流不能把恢复切换成新的模型提交。
        recovering ||= status !== 429 && options.route === 'jadense'
        previous = error
        const seconds = retryAfter == null ? NaN : Number(retryAfter)
        const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter ?? '')
        const delay = status === 429 ? Math.max(1000, Number.isFinite(retryAt) ? retryAt - Date.now() : 60_000) : 2000 * 2 ** attempt + Math.floor(Math.random() * 500)
        // 超长服务冷却交还任务，避免无限后台等待；不会提前请求服务。
        if (delay > 300_000) throw error
        options.progress({ attempt: attempt + 1, until: Date.now() + delay, recovering })
        await wait(delay, options.signal)
      }
    }
  } finally { options.progress() }
}
