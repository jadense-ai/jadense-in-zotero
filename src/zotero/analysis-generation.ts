/** 文献解析 AI 重试只覆盖生成阶段；从不重跑 PDF 读取或批注写入。 */
import { analysisStage } from './analysis-stage'
import { uiText } from './ui-preferences'

/** 明确限流可重发；攻玉不确定响应只能恢复原执行，BYOK 不确定响应立即交还用户。 */
export async function generateAnalysis(options: {
  signal: AbortSignal; route: 'byok' | 'jadense'
  send: (signal: AbortSignal, progress: () => void) => Promise<string>
  recover: (signal: AbortSignal, progress: () => void, error: unknown) => Promise<string>
  onProgress?: (message: string) => void
  onRetry?: (retrying: boolean) => void
}) {
  let recovering = false, previous: unknown
  try {
    for (let attempt = 0; ; attempt++) {
      options.signal.throwIfAborted()
      try {
        return await analysisStage(options.signal, uiText('AI 生成', 'AI generation'), 180_000,
          (signal, progress) => recovering ? options.recover(signal, progress, previous) : options.send(signal, progress), 900_000)
      } catch (error) {
        if (options.signal.aborted) throw error
        const { status, code, name, retryAfter } = (error ?? {}) as { status?: number; code?: string; name?: string; retryAfter?: string }
        const transient = (status !== undefined && status >= 500) || name === 'TypeError' || name === 'AbortError'
          || ['ANALYSIS_TIMEOUT', 'STREAM_EARLY_EOF', 'STREAM_INCOMPLETE', 'STREAM_FAILED', 'RECOVERY_PENDING'].includes(code ?? '')
        if (attempt >= 2 || (status !== 429 && !(options.route === 'jadense' && transient))) throw error
        recovering ||= status !== 429 && options.route === 'jadense'
        previous = error
        const seconds = retryAfter == null ? NaN : Number(retryAfter)
        const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter ?? '')
        const delay = status === 429 ? Math.max(1000, Number.isFinite(retryAt) ? retryAt - Date.now() : 60_000) : 2000 * 2 ** attempt
        if (delay > 300_000) throw error
        options.onRetry?.(true)
        options.onProgress?.(uiText(`AI 暂未完成，${Math.ceil(delay / 1000)} 秒后自动${recovering ? '恢复' : '重试'}（${attempt + 1}/2）…`, `AI incomplete. Automatic ${recovering ? 'recovery' : 'retry'} in ${Math.ceil(delay / 1000)}s (${attempt + 1}/2)…`))
        await analysisStage(options.signal, 'Retry wait', delay + 1000, signal => new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
          signal.addEventListener('abort', abort, { once: true })
        }))
        options.onProgress?.(uiText(`正在自动${recovering ? '恢复 AI 结果' : '重试 AI 生成'}（${attempt + 1}/2）…`, `Automatically ${recovering ? 'recovering AI result' : 'retrying AI generation'} (${attempt + 1}/2)…`))
      }
    }
  } finally { options.onRetry?.(false) }
}
