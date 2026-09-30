/** 解析阶段的有界等待：底层忽略取消也能退出；迟到响应不能进入后续阶段。 */
import { uiText } from './ui-preferences'

export class AnalysisTimeoutError extends Error {
  readonly code = 'ANALYSIS_TIMEOUT'
  constructor(stage: string) { super(uiText(`${stage}超时，请重试；已有结果会保留。`, `${stage} timed out. Retry; existing results are retained.`)) }
}

/** 心跳仅由真实页数/文本进展触发，另有总时限防止无限缓慢响应。 */
export async function analysisStage<T>(parent: AbortSignal, stage: string, idleMs: number,
  work: (signal: AbortSignal, progress: () => void) => Promise<T>, maxMs = idleMs * 4): Promise<T> {
  parent.throwIfAborted()
  const controller = new AbortController()
  let idle: ReturnType<typeof setTimeout>
  let settled = false
  let rejectWait!: (error: unknown) => void
  const failure = new Promise<never>((_resolve, reject) => { rejectWait = reject })
  const fail = (error: unknown) => { if (!settled) { rejectWait(error); controller.abort(error) } }
  const abort = () => fail(new DOMException('Aborted', 'AbortError'))
  const progress = () => { if (!settled && !controller.signal.aborted) { clearTimeout(idle); idle = setTimeout(() => fail(new AnalysisTimeoutError(stage)), idleMs) } }
  parent.addEventListener('abort', abort, { once: true })
  progress()
  const total = setTimeout(() => fail(new AnalysisTimeoutError(stage)), maxMs)
  try { return await Promise.race([failure, work(controller.signal, progress)]) }
  finally { settled = true; clearTimeout(idle!); clearTimeout(total); parent.removeEventListener('abort', abort) }
}
