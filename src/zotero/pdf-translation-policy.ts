/** PDF 翻译范围及成果投影；设置、任务和阅读器共用，不依赖 Provider。 */
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

export type PDFTranslationMode = 'concise' | 'full'
export type PDFCoverage = { total: number; translated: number; failed: number; preserved: number; failedPages: number[] }
export type PDFArtifact = { revision: string; pages: number; skipped: number[]; coverage?: PDFCoverage }
const modeKey = 'extensions.jadenseInZotero.pdfTranslationMode'
export function readPDFTranslationMode(host: ZoteroLike): PDFTranslationMode { return host.Prefs?.get(modeKey, true) === 'full' ? 'full' : 'concise' }
export function savePDFTranslationMode(host: ZoteroLike, value: PDFTranslationMode) { host.Prefs?.set(modeKey, value, true) }
export function pdfModeLabel(mode: PDFTranslationMode) { return mode === 'full' ? uiText('完整翻译', 'Full translation') : uiText('精简翻译', 'Concise translation') }

/** 可选统计损坏只丢弃统计，不影响有效文件读取。 */
export function readPDFCoverage(value: unknown): PDFCoverage | undefined {
  const row = value as PDFCoverage | undefined
  if (!row || ![row.total, row.translated, row.failed, row.preserved].every(n => Number.isSafeInteger(n) && n >= 0)) return
  return { total: row.total, translated: row.translated, failed: row.failed, preserved: row.preserved,
    failedPages: Array.isArray(row.failedPages) ? row.failedPages.filter(n => Number.isSafeInteger(n) && n >= 0) : [] }
}
export function pdfCoverageText(coverage?: PDFCoverage) {
  if (!coverage) return ''
  const { translated, failed, preserved, failedPages } = coverage
  return uiText(`已译 ${translated} 段 · 未译 ${failed} 段（保留原文） · 按范围保留 ${preserved} 段`, `${translated} translated · ${failed} untranslated (original retained) · ${preserved} preserved by scope`)
    + (failedPages.length ? uiText(` · 未完成页：${failedPages.map(n => n + 1).join('、')}`, ` · Incomplete pages: ${failedPages.map(n => n + 1).join(', ')}`) : '')
}

/** 恢复过程按事件累计，明确区别于最终覆盖；诊断关闭时仍能凭任务编号定位。 */
export function pdfFailureDetails(task: { id: string; status: string; diagnosticId?: string; failureCounts?: Record<string, number> }) {
  if (!['partial', 'error', 'interrupted'].includes(task.status)) return ''
  const labels: Record<string, string> = {
    OUTPUT_FAILED: uiText('模型批次失败', 'Model batch failed'),
    PLACEHOLDER_MISMATCH: uiText('公式或格式标记不匹配', 'Formula or formatting mismatch'),
    MISSING_ID: uiText('响应缺少段落', 'Missing passages'),
    INVALID_OUTPUT: uiText('补译后仍未完成', 'Incomplete after repair'),
    INVALID_JSON: uiText('响应格式无法解析', 'Unreadable response format'),
    LAYOUT_MAPPING: uiText('译文排版回填失败', 'Layout mapping failed'),
  }
  const counts = Object.entries(task.failureCounts ?? {}).filter(([code, count]) => /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) && Number.isSafeInteger(count) && count > 0)
  return [uiText('任务编号：', 'Task ID: ') + task.id,
    typeof task.diagnosticId === 'string' && task.diagnosticId ? uiText('诊断编号：', 'Diagnostic ID: ') + task.diagnosticId : '',
    counts.length ? uiText('恢复过程记录（含重复尝试，不等于最终未译段数）：', 'Recovery records (including repeated attempts, not final untranslated counts): ') + counts.map(([code, count]) => `${labels[code] ?? code} [${code}] ${count}`).join('；') : '',
  ].filter(Boolean).join('\n')
}

/** 未确认请求不由 PDF 层重放；服务级故障停止派发，但允许本地生成部分成果。 */
export function pdfProviderFailure(error: unknown) {
  const value = error as { code?: unknown; status?: unknown }
  const code = typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value.code) ? value.code : 'PROVIDER_FAILED'
  const status = typeof value?.status === 'number' ? value.status : undefined
  const local = ['STREAM_EARLY_EOF', 'EMPTY_TRANSLATION', 'OUTPUT_TRUNCATED', 'OUTPUT_EMPTY', 'STREAM_INCOMPLETE', 'OUTPUT_RESOURCES_CHANGED', 'OUTPUT_PARTIAL', 'OUTPUT_FAILED', 'OUTPUT_CANCELLED'].includes(code)
  return { code, status, stop: !local || status === 401 || status === 402 || status === 403 || status === 429 || (status !== undefined && status >= 500) }
}
