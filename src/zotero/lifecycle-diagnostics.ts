/** 启动和界面恢复的可选诊断边界；收集器、日志或磁盘失败不能改变主操作。 */
import { diagnostics, type RequestDiagnostic, type DiagnosticEvent } from './diagnostics'

export function lifecycleTrace(host: object, feature: string, operation: string, window = 'background', startedAt?: string) {
  let trace: RequestDiagnostic | undefined
  const safely = (action: () => void) => { try { action() } catch { /* 诊断始终可选。 */ } }
  safely(() => {
    trace = diagnostics(host)?.start({ feature, operation, window })
    if (trace) trace.identify({ operationId: trace.row.id })
    if (trace && startedAt) { trace.row.startedAt = startedAt; trace.row.events[0].at = startedAt }
  })
  return {
    get id() { return trace?.row.id },
    event(stage: string, fields?: Partial<DiagnosticEvent>) { safely(() => trace?.event(stage, fields)) },
    fail(error: unknown, stage: string, code?: string) {
      safely(() => {
        const wrapper = error as { name?: string; stack?: string; cause?: { name?: string; stack?: string } }
        const value = wrapper?.cause ?? wrapper
        trace?.fail(code ? { name: value?.name, stack: value?.stack, code } : error, stage)
      })
      safely(() => { (host as { debug?(text: string): void }).debug?.(`[Jadense in Zotero] ${feature}:${stage}${code ? ` ${code}` : ''}`) })
    },
    end(outcome: 'success' | 'error' | 'cancelled' = 'success') {
      safely(() => { if (trace) { trace.row.category = outcome; trace.end() } })
    },
  }
}
