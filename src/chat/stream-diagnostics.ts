/** 流诊断只统计固定协议类别和长度，不保存远端字段名、正文或思考内容。 */
import type { RequestDiagnostic } from '@/zotero/diagnostics'

export function streamDiagnostics(trace?: RequestDiagnostic) {
  const counts: Record<string, number> = {}
  let last = 0
  const began = Date.now()
  const add = (key: string, n = 1) => { counts[key] = (counts[key] ?? 0) + n }
  const flush = () => {
    try { trace?.event('stream_summary', { elapsedMs: Date.now() - began, translation: { ...counts } }) } catch { /* 诊断不可阻断流。 */ }
    last = Date.now()
  }
  return {
    block(data: string, event: Record<string, unknown> | null) {
      if (!trace) return
      add('streamEvents')
      if (data.trim() === '[DONE]') add('doneEvents')
      else if (!data.trim()) add('emptyEvents')
      else if (!event) add('invalidEvents')
      else {
        const type = event.type
        if (type === 'reasoning-delta') {
          if (!counts.reasoningEvents) counts.firstReasoningMs = Date.now() - began
          add('reasoningEvents'); if (typeof event.delta === 'string') add('reasoningChars', event.delta.length)
        }
        else if (type === 'text-delta') {
          add('textEvents')
          if (typeof event.delta === 'string') add('textChars', event.delta.length)
          else add('invalidDeltaEvents')
        } else if (['start', 'start-step', 'finish-step', 'text-start', 'text-end', 'reasoning-start', 'reasoning-end', 'finish', 'error', 'abort'].includes(String(type))) add('controlEvents')
        else if (Array.isArray(event.choices)) add('openaiEvents')
        else add('unknownEvents')
      }
      if (Date.now() - last >= 5000) flush()
    },
    pending(length: number) { counts.pendingChars = length },
    flush,
  }
}
