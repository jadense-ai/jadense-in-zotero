import { requestStageLabel, requestActivityText } from '@/chat/request-feedback'
/** PDF 对照翻译状态参数:集中计算徽章级别、单行摘要、详情行与进度,Reader 只套用结果。 */
import { pdfCoverageText, pdfFailureDetails } from './pdf-translation-policy'
import { translationSpeedText } from './translation-speed-settings'
import { uiText } from './ui-preferences'
import type { TranslationSnapshot } from '@/chat/translation-queue'
import type { PDFTranslationTask } from './pdf-translation-jobs'

export type PDFStatusKind = 'preparing' | 'working' | 'waiting' | 'interrupted' | 'cancelled' | 'partial' | 'error' | 'complete' | 'idle'
export type PDFStatusLed = 'busy' | 'warning' | 'error' | 'success' | 'muted'
/** 一次性瞬时提示:与现行"直接改写状态文本,下次 render 覆写"语义一致。 */
export type PDFStatusNotice = { text: string; tone: 'info' | 'error' }
export type PDFStatusInput = {
  task?: PDFTranslationTask
  windowError?: string
  notice?: PDFStatusNotice
  hasOutput?: boolean
  speed?: TranslationSnapshot | null
  now?: number
}
export type PDFStatusView = {
  kind: PDFStatusKind
  led: PDFStatusLed
  visible: boolean
  /** 徽章单行摘要:倒计时/恢复行优先,否则首行。 */
  label: string
  /** 浮层正文全部信息行。 */
  lines: string[]
  progress?: { value: number; max: number } | 'indeterminate'
  /** <details> 技术信息;空串表示无。 */
  details: string
  /** LED 呼吸动画开关(= 现行 is-working 语义)。 */
  working: boolean
}

const RECOVERY = /自动继续|自动恢复|automatically|continuing|等待翻译服务|Waiting for the translation service/u
const LEGACY_CHANGED_ERRORS = new Set([
  '原 PDF 或翻译配置已变化，请重新点击翻译按钮。',
  'The PDF or translation settings changed. Click Translate again.',
])

/** 只选择显式恢复按钮；兼容旧版固定错误文案，不据此授权执行或改写历史任务。 */
export function pdfTranslationNeedsRetranslation(task?: PDFTranslationTask): boolean {
  return Boolean(task && ['error', 'partial', 'interrupted', 'cancelled'].includes(task.status)
    && (task.blockedReason === 'configuration' || task.blockedReason === 'source' || LEGACY_CHANGED_ERRORS.has(task.error ?? '')))
}

/** 与 Reader 状态条逐行对齐的文本组成;状态级别由最终呈现决定。 */
export function pdfTranslationStatusView(input: PDFStatusInput): PDFStatusView {
  const now = input.now ?? Date.now()
  if (input.notice?.text) {
    const failed = input.notice.tone === 'error'
    return { kind: failed ? 'error' : 'preparing', led: failed ? 'error' : 'busy', visible: true,
      label: input.notice.text, lines: [input.notice.text], details: '', working: !failed }
  }
  const task = input.task, windowError = input.windowError || ''
  if (!task) {
    return windowError
      ? { kind: 'error', led: 'error', visible: true, label: windowError.split('\n')[0], lines: windowError.split('\n').filter(Boolean), details: windowError, working: false }
      : { kind: 'idle', led: 'muted', visible: false, label: '', lines: [], details: '', working: false }
  }
  const busy = task.status === 'queued' || task.status === 'running' || task.status === 'waiting', hasOutput = Boolean(input.hasOutput)
  const needsRetranslation = pdfTranslationNeedsRetranslation(task)
  const taskError = needsRetranslation && LEGACY_CHANGED_ERRORS.has(task.error ?? '')
    ? uiText('原 PDF 或翻译配置已变化。请点击「按当前设置重新翻译」开始新任务；旧成果仍保留。', 'The PDF or translation settings changed. Click “Translate again with current settings” to start a new task; existing results are retained.')
    : task.error
  const stages: Record<string, string> = { parse_missing: uiText('建立 PDF 版面缓存', 'Building PDF layout cache'), parse_invalid: uiText('版面缓存不可用，重新解析 PDF', 'Layout cache unavailable; parsing PDF again'), preparing_pdf: uiText('检查 PDF 与版面缓存', 'Checking PDF and layout cache'), finishing: uiText('正在保存已完成译文', 'Saving completed translations'), layout_cached: uiText('已复用 PDF 版面', 'Reusing PDF layout'), queued: uiText('等待其他 PDF 任务', 'Waiting for another PDF task'), dependencies: uiText('安装 PDF 翻译引擎', 'Installing PDF translation engine'), assets: uiText('准备模型和字体', 'Preparing models and fonts'), download: uiText('下载完整引擎包', 'Downloading engine package'), retry: uiText('下载中断，正在续传重试', 'Retrying interrupted download'), verify: uiText('校验引擎包', 'Verifying engine package'), extract: uiText('解压引擎', 'Extracting engine'), check: uiText('离线检测引擎', 'Checking engine offline'), installed: uiText('引擎已安装', 'Engine installed'), parse: uiText('解析 PDF', 'Parsing PDF') }
  const stage = stages[task.stage] || (/translat/iu.test(task.stage) ? uiText('翻译正文', 'Translating text') : /typeset|render|save|generate|write/iu.test(task.stage) ? uiText('生成译文 PDF', 'Typesetting translated PDF') : uiText('解析 PDF 版面', 'Parsing PDF layout'))
  let text = windowError || taskError || (hasOutput ? task.skipped.length ? uiText(`以下页无可翻译文字，已保留原页：${task.skipped.map(i => i + 1).join('、')}`, `Pages without text were preserved: ${task.skipped.map(i => i + 1).join(', ')}`) : '' : `${stage} · ${Math.round(task.percent)}%`)
  if (busy) text = task.stage === 'translation_repair' ? uiText('正在补译未完成段落…', 'Filling in the remaining passages…') : `${stage}…`
  if (busy && task.requestProgress) text = `${requestStageLabel(task.requestProgress.stage)} · ${Math.max(0, Math.floor((now - task.requestProgress.stageStartedAt) / 1000))}s · ${uiText('已接收正文', 'Text received')} ${task.requestProgress.receivedCharacters ?? 0}`
  if (task.status === 'interrupted') text = uiText('上次任务已中断，点击重试将复用已完成片段。', 'Previous task interrupted. Retry to reuse completed segments.')
  if (task.status === 'interrupted' && task.legacy) text = uiText('这是旧版未完成任务。点击重试以新聚合策略重新开始；旧缓存仍保留。', 'Unfinished legacy task. Retry starts the new batching strategy; the old cache is retained.')
  let waitSeconds = 0, recovering = false
  if (busy) {
    const speed = input.speed ?? undefined
    if (task.total !== undefined) text += uiText(` · 已完成 ${task.completed ?? 0} / ${task.total} 段`, ` · ${task.completed ?? 0} / ${task.total} passages completed`)
    const retries = Object.values(task.retrying ?? {})
    waitSeconds = Math.ceil(Math.max(0, ...retries.map(row => row.until - now), task.status === 'waiting' ? (task.recovery?.nextAt ?? now) - now : 0, speed?.queued ? speed.waitMs : 0) / 1000)
    recovering = retries.length > 0 || task.status === 'waiting'
    if (task.status === 'waiting' && task.phase === 'render') text = uiText('译文已保存，正在等待重新生成 PDF；不会重新翻译。', 'Translations are saved. Waiting to regenerate the PDF without translating again.')
    if (recovering) text += '\n' + (waitSeconds > 0
      ? uiText(`服务暂时繁忙，${waitSeconds} 秒后自动继续，无需重复点击。`, `The service is busy. Continuing automatically in ${waitSeconds}s; no action needed.`)
      : uiText('正在自动恢复未完成内容，无需重复点击。', 'Automatically recovering unfinished work; no action needed.'))
    else if (waitSeconds > 0) text += '\n' + uiText(`正在等待翻译服务，约 ${waitSeconds} 秒后继续。`, `Waiting for the translation service; continuing in about ${waitSeconds}s.`)
    if ((task.completed ?? task.artifact?.coverage?.translated ?? task.coverage?.translated ?? 0) > 0) text += '\n' + uiText('已有译文已保存，可以先阅读。', 'Completed translations are saved and ready to read.')
    if (task.requestProgress) { const activity = requestActivityText(task.requestProgress, now); if (activity) text += '\n' + activity }
  }
  if (task.stage === 'finishing' && busy) text = uiText('正在保存已完成译文', 'Saving completed translations')
  if (task.status === 'cancelled') text = (taskError ? taskError + '\n' : '') + uiText('已取消，点击重试可复用已完成片段。', 'Cancelled. Retry to reuse completed segments.')
  const coverageText = pdfCoverageText(task.artifact?.coverage ?? task.coverage)
  if (task.status === 'partial') text = uiText('部分段落暂未完成，已有译文已保存，可继续补译。', 'Some passages remain incomplete. Translations are saved; you can retry the remaining passages.') + (taskError ? '\n' + taskError : '')
  if (needsRetranslation && taskError) text = windowError || taskError
  if (coverageText && !busy) text += (text ? '\n' : '') + coverageText
  const speed = busy ? input.speed : undefined
  const details = [windowError, taskError, pdfFailureDetails(task), speed ? translationSpeedText(speed) : ''].filter(Boolean).join('\n')
  const lines = text.split('\n').filter(Boolean)
  if (!lines.length) return { kind: 'idle', led: 'muted', visible: false, label: '', lines: [], details, working: false }
  const label = (busy ? lines.find(line => RECOVERY.test(line)) : undefined) || lines[0]
  const progress: PDFStatusView['progress'] = busy
    ? /translat/iu.test(task.stage) && task.total && task.completed !== undefined ? { value: task.completed, max: task.total } : 'indeterminate'
    : undefined
  let kind: PDFStatusKind, led: PDFStatusLed
  if (busy) { const waiting = recovering || waitSeconds > 0; kind = waiting ? 'waiting' : 'working'; led = waiting ? 'warning' : 'busy' }
  else if (task.status === 'interrupted') { kind = 'interrupted'; led = 'warning' }
  else if (task.status === 'cancelled') { kind = 'cancelled'; led = 'muted' }
  else if (task.status === 'partial') { kind = 'partial'; led = 'warning' }
  else if (task.status === 'error' || windowError) { kind = 'error'; led = 'error' }
  else if (task.status === 'complete') { kind = 'complete'; led = 'success' }
  else { kind = 'preparing'; led = 'busy' }
  return { kind, led, visible: true, label, lines, progress, details, working: busy }
}
