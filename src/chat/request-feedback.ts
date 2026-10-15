/** 请求反馈的公共投影：仅保留阶段、计数、档位和关联标识，不携带正文、推理或响应体。 */
import { uiText } from '@/zotero/ui-preferences'

export type RequestStage = 'queued' | 'sent' | 'reasoning' | 'receiving' | 'recovering' | 'repairing' | 'validating' | 'saving' | 'completed' | 'failed'
export type ThinkingReceipt = {
  version?: number; requestedThinkingEffort?: string; preparedThinkingEffort?: string; effectiveThinkingEffort?: string
  thinkingSource?: string; adjustmentReason?: string; requestContractHash?: string; modelId?: string
}
export type RequestProgress = { stage: RequestStage; receivedCharacters?: number; thinking?: ThinkingReceipt; operationId?: string; firstTextAt?: number; lastActivityAt?: number }
export type RequestProgressListener = (progress: RequestProgress) => void
export type RequestIssue = {
  code?: string; stage?: string; status?: number; requestId?: string; executionId?: string; diagnosticId?: string
  localDiagnosticId?: string; causeCode?: string
}

/** 执行事实与错误原因分离，正文只留在结果路径，不进入诊断投影。 */
export type ExecutionState = 'completed' | 'partial' | 'failed' | 'cancelled' | 'unknown'
export class RequestExecutionError extends Error {
  constructor(message: string, readonly executionState: ExecutionState, readonly partialText: string, issue: RequestIssue = {}) {
    super(message); Object.assign(this, issue)
  }
}
export function executionResult(error: unknown) {
  const value = error as { executionState?: ExecutionState; partialText?: string } | undefined
  return { state: value?.executionState ?? 'unknown', text: typeof value?.partialText === 'string' ? value.partialText : '' }
}
export function canRepairExecution(error: unknown) {
  const { state } = executionResult(error), issue = requestIssue(error)
  return (state === 'partial' || state === 'failed' || issue.code === 'OUTPUT_FAILED' && issue.stage === 'recovery')
    && ![401, 402, 403, 429].includes(issue.status ?? 0) && !(issue.status && issue.status >= 500)
}

/** 每个操作独立累计；GET 重放累计正文不加倍，新排队不能抹掉其他批次进度。 */
export class RequestProgressTracker {
  private rows = new Map<string, RequestProgress & { stageStartedAt: number }>()
  update(id: string, progress: RequestProgress) {
    const now = Date.now(), previous = this.rows.get(id)
    const receivedCharacters = Math.max(previous?.receivedCharacters ?? 0, progress.receivedCharacters ?? 0)
    const firstTextAt = previous?.firstTextAt ?? (receivedCharacters ? now : undefined)
    this.rows.set(id, { ...previous, ...progress, operationId: id, receivedCharacters, firstTextAt,
      lastActivityAt: progress.lastActivityAt ?? now, stageStartedAt: previous?.stage === progress.stage ? previous.stageStartedAt : now })
    return this.snapshot()
  }
  snapshot() {
    const rows = [...this.rows.values()], active = rows.filter(row => !['completed', 'failed'].includes(row.stage))
    const priority: RequestStage[] = ['receiving', 'recovering', 'repairing', 'reasoning', 'sent', 'saving', 'validating', 'queued']
    const chosen = [...active].sort((a, b) => priority.indexOf(a.stage) - priority.indexOf(b.stage))[0] ?? rows.at(-1)!
    return { ...chosen, receivedCharacters: rows.reduce((n, row) => n + (row.receivedCharacters ?? 0), 0),
      firstTextAt: rows.reduce<number | undefined>((n, row) => row.firstTextAt === undefined ? n : Math.min(n ?? Infinity, row.firstTextAt), undefined),
      lastActivityAt: Math.max(0, ...rows.map(row => row.lastActivityAt ?? 0)) }
  }
}

export function requestActivityText(progress: RequestProgress, now = Date.now()) {
  if (progress.lastActivityAt && now - progress.lastActivityAt >= 30_000)
    return uiText(`暂未收到新事件 · ${Math.floor((now - progress.lastActivityAt) / 1000)}s`, `No new events · ${Math.floor((now - progress.lastActivityAt) / 1000)}s`)
  return progress.stage === 'reasoning' ? (progress.receivedCharacters ? uiText('持续收到思考', 'Receiving reasoning') : uiText('持续收到思考，尚未收到正文', 'Receiving reasoning; waiting for text'))
    : progress.stage === 'recovering' ? uiText('正在查询原请求结果', 'Checking the original request') : ''
}
const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/u.test(value)
  && !/^(?:Bearer|sk-|eyJ)/iu.test(value) ? value : undefined
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** HTTP、SSE、恢复结果及 BYOK 使用同一个安全错误字段集合。 */
export function requestIssue(value: unknown, defaults: RequestIssue = {}): RequestIssue {
  const row = object(value), result: RequestIssue = { ...defaults }
  for (const key of ['code', 'stage', 'requestId', 'executionId', 'diagnosticId', 'localDiagnosticId', 'causeCode'] as const) {
    const found = identifier(row[key]); if (found) result[key] = found
  }
  const status = row.status ?? row.statusCode
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) result.status = status
  result.causeCode ??= identifier(object(row.cause).code)
  return result
}

export function requestError(message: string, value: unknown, defaults: RequestIssue = {}) {
  return Object.assign(new Error(message), requestIssue(value, defaults))
}

export function thinkingReceipt(value: unknown): ThinkingReceipt | undefined {
  const row = object(value)
  if (row.version !== 1) return undefined
  const receipt: ThinkingReceipt = { version: 1 }
  for (const key of ['requestedThinkingEffort', 'preparedThinkingEffort', 'effectiveThinkingEffort', 'thinkingSource', 'adjustmentReason', 'requestContractHash', 'modelId'] as const) {
    const found = identifier(row[key]); if (found) receipt[key] = found
  }
  return receipt
}

/** 视图与诊断都是可选观察者，不能使成功请求失败。 */
export function reportProgress(listener: RequestProgressListener | undefined, value: RequestProgress) {
  try { listener?.(value) } catch { /* 已关闭或损坏的视图不影响请求。 */ }
}

export function requestStageLabel(stage: RequestStage) {
  return ({ queued: uiText('排队中', 'Queued'), sent: uiText('请求已发送', 'Request sent'), reasoning: uiText('思考中', 'Thinking'),
    receiving: uiText('接收译文', 'Receiving translation'), recovering: uiText('恢复原请求', 'Recovering request'), repairing: uiText('补译缺失段落', 'Translating missing passages'),
    validating: uiText('整理译文', 'Preparing translation'), saving: uiText('保存译文', 'Saving'), completed: uiText('请求完成', 'Request completed'), failed: uiText('请求结束', 'Request ended') })[stage]
}

/** 持久化任务只保存可解释的固定摘要；供应商未经处理的 message 只留在受控服务端诊断。 */
export function requestIssueSummary(issue: RequestIssue) {
  const reason = issue.code === 'REASONING_ONLY' ? uiText('模型仅返回思考，未返回译文', 'The model finished reasoning without translation')
    : issue.code === 'EMPTY_OUTPUT' ? uiText('模型返回了空正文', 'The model returned empty text')
    : issue.code === 'STREAM_INCOMPLETE' ? uiText('模型输出被截断', 'The model output was truncated')
    : issue.code === 'STREAM_PARSE_FAILED' || issue.code === 'TRANSLATION_PARSE_FAILED' ? uiText('无法解析模型返回的译文', 'The model output could not be parsed')
    : issue.code === 'BLOCK_VALIDATION_FAILED' ? uiText('部分段落无法对应或没有可用译文', 'Some passages could not be matched or had no usable translation')
    : issue.code === 'STREAM_EARLY_EOF' ? uiText('数据流意外中断；原请求可恢复', 'The stream disconnected; the original request can be recovered')
    : issue.code === 'RECOVERY_PENDING' ? uiText('原请求仍在执行，请稍后恢复', 'The original request is still running; recover it later')
    : issue.code === 'BYOK_EXECUTION_UNCONFIRMED' ? uiText('BYOK 执行结果未确认；核对后可重新请求未确认段落，可能重复计费', 'BYOK execution is unconfirmed; check before requesting unconfirmed passages again, as duplicate charges are possible')
    : issue.code === 'TRANSLATION_TIMEOUT' ? uiText('AI 翻译超过 15 分钟，已停止等待；请核对或恢复原请求', 'AI translation exceeded 15 minutes; check or recover the original request')
    : issue.status === 401 || issue.status === 403 ? uiText('服务拒绝访问，请检查令牌或模型权限', 'Access denied; check the token or model permissions')
    : issue.status === 402 ? uiText('余额或订阅不足', 'Insufficient balance or subscription')
    : issue.status === 429 ? uiText('服务限流，请稍后恢复或重试', 'Rate limited; recover or retry later')
    : issue.status && issue.status >= 500 ? uiText('服务端或上游模型执行失败', 'The server or upstream model failed')
    : issue.code === 'NETWORK_ERROR' ? uiText('网络连接失败；执行结果需恢复确认', 'Network failure; recover to confirm the execution result')
    : uiText('翻译请求失败', 'Translation request failed')
  return `${reason}${issue.code || issue.status ? ` (${[issue.code, issue.status].filter(Boolean).join(', ')})` : ''}`
}
