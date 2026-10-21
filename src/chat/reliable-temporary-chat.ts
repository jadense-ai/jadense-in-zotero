import { structuredResponseReceipt } from './response-format'
import { reportProgress, requestIssue, thinkingReceipt, RequestExecutionError } from './request-feedback'
import { traceRequest, diagnosticFetch, markDiagnosticAbort } from "@/zotero/diagnostics"
/** 新版 Zotero 攻玉客户端：先确认协议，再持久化/认领；重发只复用稳定执行身份。 */
import { TemporaryChatClient, temporaryChatMessages, jadenseChatSelectionBody, consumeTemporaryChatStream, type TemporaryChatClientOptions, type TemporaryChatSendInput } from './temporary-chat'
import { readJadenseApiError, JadenseApiError } from '@/jadense/api'
import { TemporaryRequestStore, requestHash, type LocalTemporaryRequest } from './temporary-request-store'
import { version } from '../../package.json'
import { uiText } from '@/zotero/ui-preferences'
import type { TranslationFetch } from './translation-queue'
import { RESPONSE_FORMAT_HEADER, RESPONSE_FORMAT_PROMPT_HEADER, responseFormatMessages } from './response-format'
import { resolveTemporaryAccount, temporaryAccountCapability, forgetTemporaryAccount } from './temporary-account'

const HEADER = 'x-jadense-temporary-protocol'
/** 服务端已确认 partial 终态；文本仅供 PDF 本地段落校验，不代表完整执行成功。 */
export class TemporaryPartialOutputError extends RequestExecutionError {
  readonly code = 'OUTPUT_PARTIAL'
  constructor(message: string, partialText: string) { super(message, 'partial', partialText) }
}
export class ReliableTemporaryChatClient extends TemporaryChatClient {
  private options: TemporaryChatClientOptions
  constructor(options: TemporaryChatClientOptions, private store = new TemporaryRequestStore()) { super(options); this.options = { ...options, selection: options.selection ? { ...options.selection } : undefined } }
  private fetch(input: RequestInfo | URL, init?: RequestInit) { return this.options.fetchImpl ? this.options.fetchImpl(input, init) : globalThis.fetch(input, init) }
  private base() { return this.options.baseUrl.trim().replace(/\/+$/, '') }
  private headers(durable = false) { return { authorization: `Bearer ${this.options.token.trim()}`, [HEADER]: '1', ...(durable ? { 'x-jadense-temporary-durable': '1' } : {}) } }
  private async account(signal?: AbortSignal) { return (await resolveTemporaryAccount({ ...this.options, signal })).account }
  async pending() {
    const account = await this.account(), legacy = await requestHash(this.base() + '\n' + this.options.token.trim())
    return (await this.store.list()).filter(row => (row.account === account || row.account === legacy) && row.body.byok !== true && row.body.origin === this.base() && row.status === 'pending')
  }
  /** 显式用户停止才取消远端；关窗口/退出只断开传输，保留服务器执行及恢复身份。 */
  async cancelOperation(conversationId: string, operationId?: string) {
    const capability = await temporaryAccountCapability(this.options)
    if (capability.headers.get('x-jadense-temporary-durable') !== '1') return
    const rows = await this.pending()
    const cancellations = await Promise.allSettled(rows.filter(value => value.body.temporaryConversationId === conversationId && (!operationId || value.body.operationId === operationId)).map(async row => {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30_000)
      try {
        const response = await this.fetch(`${this.base()}/api/chat/temporary?conversationId=${encodeURIComponent(conversationId)}&requestId=${encodeURIComponent(String(row.body.clientRequestId))}`, { method: 'DELETE', headers: this.headers(true), signal: controller.signal })
        if (!response.ok && response.status !== 202) throw await readJadenseApiError(response, 'Could not confirm cancellation')
      } finally { clearTimeout(timeout) }
    }))
    const failure = cancellations.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }
  /** 已派发请求身份已在磁盘；回执保存失败保留内存并交给文档检查点，不重新请求模型。 */
  private async saveReceipt(row: LocalTemporaryRequest, input?: Pick<TemporaryChatSendInput, 'diagnostic' | 'onProgress'>) {
    try { await this.store.save(row) } catch {
      input?.diagnostic?.event('result_persistence_pending', { code: 'LOCAL_REQUEST_PERSISTENCE_FAILED' })
      reportProgress(input?.onProgress, { stage: 'saving', receivedCharacters: row.text?.length ?? 0 })
    }
  }
  /** 服务器检查点只是已收到正文，不是完整执行证明；不能据此授权补发模型。 */
  private async keepCheckpoint(row: LocalTemporaryRequest, text: unknown, input?: Pick<TemporaryChatSendInput, 'diagnostic' | 'onProgress' | 'onTextDelta'>) {
    if (typeof text !== 'string' || text.length <= (row.text?.length ?? 0)) return
    const before = row.text ?? ''
    row.text = text
    try { input?.onTextDelta?.(text.startsWith(before) ? text.slice(before.length) : text, text) } catch { /* 展示不影响保存。 */ }
    reportProgress(input?.onProgress, { stage: 'recovering', receivedCharacters: text.length })
    await this.saveReceipt(row, input)
  }

  /** 只读恢复不需要原始提示词或模型选择；当前令牌仍需同用户同插件授权。 */
  async recover(row: LocalTemporaryRequest, input?: Pick<TemporaryChatSendInput, 'signal' | 'onTextDelta' | 'diagnostic' | 'onProgress'>): Promise<string> {
    if (!input?.diagnostic) return traceRequest({ ...input, clientRequestId: String(row.body.clientRequestId), conversationId: String(row.body.temporaryConversationId), taskId: typeof row.body.taskId === 'string' ? row.body.taskId : undefined, operationId: typeof row.body.operationId === 'string' ? row.body.operationId : undefined }, { provider: 'jadense', feature: 'recovery' }, value => this.recoverRecorded(row, value))
    return this.recoverRecorded(row, input)
  }
  private async recoverRecorded(row: LocalTemporaryRequest, input?: Pick<TemporaryChatSendInput, 'signal' | 'onTextDelta' | 'diagnostic' | 'onProgress'>): Promise<string> {
    if (row.body.origin !== this.base()) throw new Error(uiText('请求属于其他服务器。', 'This request belongs to another server.'))
    let response: Response
    const began = Date.now(), queueClock = (this.options.fetchImpl as TranslationFetch | undefined)?.translationQueueTime
    const initialQueueTime = queueClock?.() ?? 0
    const elapsed = () => Date.now() - began - ((queueClock?.() ?? 0) - initialQueueTime)
    const deadline = new AbortController()
    const abort = () => { markDiagnosticAbort(deadline.signal, input?.signal?.aborted ? 'parent_cancel' : 'recovery_timeout'); input?.diagnostic?.event('abort', { source: input?.signal?.aborted ? 'parent_cancel' : 'recovery_timeout' }); deadline.abort() }
    input?.signal?.addEventListener('abort', abort, { once: true })
    if (input?.signal?.aborted) abort()
    const timeout = setInterval(() => { if (elapsed() >= 60_000) abort() }, 1000)
    try {
    do {
      reportProgress(input?.onProgress, { stage: 'recovering' })
      response = await diagnosticFetch(input?.diagnostic, this.fetch.bind(this), `${this.base()}/api/chat/temporary?conversationId=${encodeURIComponent(String(row.body.temporaryConversationId))}&requestId=${encodeURIComponent(String(row.body.clientRequestId))}`, { headers: this.headers(), signal: deadline.signal })
      if (response.status === 404 && response.headers.get('x-jadense-temporary-recover-or-admit') === '1') {
        const missing = await response.clone().json().catch(() => ({})) as Record<string, unknown>
        const owner = response.headers.get('x-jadense-temporary-account')
        const ownerAccount = owner ? await requestHash(this.base() + '\nowner:' + owner.trim()) : undefined
        const legacy = await requestHash(this.base() + '\n' + this.options.token.trim())
        // 仅已鉴权服务器的明确未派发事实允许原身份首次认领；普通404/换账户绝不触发生成。
        if (missing.code === 'TEMPORARY_REQUEST_NOT_FOUND' && missing.admissionState === 'never_dispatched'
          && ownerAccount && (row.account === ownerAccount || row.account === legacy)) {
          await this.store.save(row)
          response = await diagnosticFetch(input?.diagnostic, this.fetch.bind(this), `${this.base()}/api/chat/temporary`, {
            method: 'POST', headers: { ...this.headers(row.body.durableExecution === true), 'content-type': 'application/json' },
            body: JSON.stringify({ ...row.body, transportAttemptId: crypto.randomUUID() }), signal: deadline.signal,
          })
        }
      }
      if (response.status !== 202) return await this.consume(response, row, input)
      const checkpoint = await response.clone().json().catch(() => ({})) as Record<string, unknown>
      await this.keepCheckpoint(row, checkpoint.text, input)
      if (elapsed() >= 60_000) throw Object.assign(new Error(uiText('仍在执行，稍后点击“恢复结果”；不会重复请求模型。', 'Still running. Use Recover result later; the model will not run again.')), { code: 'RECOVERY_PENDING' })
      const delay = Math.min(5000, Math.max(1000, Number(response.headers.get('retry-after') ?? 2) * 1000))
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
        const timer = setTimeout(() => { deadline.signal.removeEventListener('abort', abort); resolve() }, delay)
        deadline.signal.addEventListener('abort', abort, { once: true }); if (deadline.signal.aborted) abort()
      })
    } while (elapsed() <= 65_000)
    throw Object.assign(new Error(uiText('仍在执行，请稍后恢复结果。', 'Still running. Recover the result later.')), { code: 'RECOVERY_PENDING' })
    } catch (error) {
      if (deadline.signal.aborted && !input?.signal?.aborted) throw Object.assign(new Error(uiText('恢复等待已达 60 秒，请稍后再次恢复结果。', 'Recovery waited for 60 seconds. Recover again later.')), { code: 'RECOVERY_PENDING' })
      throw error
    } finally { clearInterval(timeout); input?.signal?.removeEventListener('abort', abort) }
  }
  private async consume(response: Response, row: LocalTemporaryRequest, input?: Pick<TemporaryChatSendInput, 'signal' | 'onTextDelta' | 'diagnostic' | 'onProgress'>): Promise<string> {
    // 鉴权中间件可能在协议头附加前拒绝；保留 pending 并正确提示更新凭据。
    if ([401, 403].includes(response.status)) {
      await forgetTemporaryAccount(this.options)
      throw await readJadenseApiError(response, 'Check the current Zotero token and permissions.')
    }
    if (response.headers.get(HEADER) !== '1') { await forgetTemporaryAccount(this.options); throw new Error(uiText('服务器不支持安全恢复，请升级服务器。', 'Upgrade the server to support safe recovery.')) }
    if (response.status === 202) return this.recover(row, input)
    if (!response.ok) {
      const error = await readJadenseApiError(response, 'AI request failed')
      let terminal: Record<string, unknown> | undefined
      let unconfirmed: Record<string, unknown> | undefined
      if (error instanceof JadenseApiError) try {
        const value = JSON.parse(error.body)
        if (['failed','partial','cancelled'].includes(value.state)) terminal = value
        else if (value.state === 'unknown') unconfirmed = value
      } catch { /* 无权威终态则保留待恢复。 */ }
      if (unconfirmed) {
        await this.keepCheckpoint(row, unconfirmed.text, input)
        throw new RequestExecutionError(error.message, 'unknown', row.text ?? '', requestIssue(error))
      }
      // 未找到/不确定可恢复；明确业务终态允许用户开始新轮次，但不自动重发。
      if (error instanceof JadenseApiError && (terminal || [400,402,410,422,429].includes(error.status))) {
        row.status = 'failed'; row.error = error.message; row.issue = requestIssue(error)
        if (terminal) { row.resultState = terminal.state as 'partial' | 'failed' | 'cancelled'; row.text = typeof terminal.text === 'string' ? terminal.text : '' }
        await this.saveReceipt(row, input)
        if (terminal) { reportProgress(input?.onProgress, { stage: 'receiving', receivedCharacters: row.text?.length ?? 0 }); throw new RequestExecutionError(error.message, row.resultState!, row.text ?? '', row.issue) }
      }
      throw error
    }
    let output: string
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      let lastSaved = 0
      try { output = await consumeTemporaryChatStream(response, (delta, text) => {
        input?.onTextDelta?.(delta, text)
        if (Date.now() - lastSaved >= 1000) {
          lastSaved = Date.now(); row.text = text
          void this.saveReceipt({ ...row }, input)
        }
      }, true, input?.diagnostic, input?.onProgress) }
      catch (error) {
        const partial = (error as { partialText?: string }).partialText
        if (typeof partial === 'string' && partial.length > (row.text?.length ?? 0)) { row.text = partial; await this.saveReceipt(row, input) }
        throw error
      }
    } else {
      const result = await response.json() as { text?: string; complete?: boolean; error?: string; state?: string; finishReason?: string; thinking?: unknown; structuredResponse?: unknown }
      input?.diagnostic?.identify(result as Record<string, unknown>)
      input?.diagnostic?.identify(structuredResponseReceipt(result.structuredResponse, result.thinking))
      const receipt = thinkingReceipt(result.thinking)
      if (receipt) { input?.diagnostic?.identify({ ...receipt }); reportProgress(input?.onProgress, { stage: 'receiving', thinking: receipt }) }
      const state = ['completed', 'partial', 'failed', 'cancelled', 'running'].includes(result.state ?? '') ? result.state! : 'unknown'
      input?.diagnostic?.event('result_state', { source: state })
      input?.diagnostic?.event('result_finish', { source: ['stop', 'length', 'error', 'content-filter'].includes(result.finishReason ?? '') ? result.finishReason : 'unknown' })
      output = typeof result.text === 'string' ? result.text : ''
      reportProgress(input?.onProgress, { stage: 'receiving', receivedCharacters: output.length })
      input?.diagnostic?.text(output.length)
      input?.onTextDelta?.(output, output)
      if (!result.complete || state !== 'completed') {
        if (['partial', 'failed', 'cancelled'].includes(state)) row.status = 'failed'
        if (['partial', 'failed', 'cancelled'].includes(state)) { row.resultState = state as 'partial' | 'failed' | 'cancelled'; row.issue = requestIssue(result) }
        row.text = output; row.error = result.error ?? uiText('输出未完整结束，已有内容保留。', 'Output was incomplete; existing text is retained.'); await this.saveReceipt(row, input)
        if (state === 'partial') throw Object.assign(new TemporaryPartialOutputError(row.error, output), requestIssue(result))
        throw new RequestExecutionError(row.error, state === 'failed' || state === 'cancelled' ? state : 'unknown', output,
          requestIssue(result, { stage: 'recovery', code: state === 'failed' ? 'OUTPUT_FAILED' : state === 'cancelled' ? 'OUTPUT_CANCELLED' : 'TEMPORARY_RESULT_UNCONFIRMED' }))
      }
    }
    if (!output.trim()) {
      row.status = 'failed'; row.resultState = 'failed'; row.text = ''; row.issue = { code: 'EMPTY_OUTPUT', stage: 'recovery' }; await this.saveReceipt(row, input)
      throw new RequestExecutionError(uiText('模型未返回正文。', 'The model returned no text.'), 'failed', '', row.issue)
    }
    row.status = 'completed'; row.text = output; await this.saveReceipt(row, input)
    return output
  }
  async send(input: TemporaryChatSendInput): Promise<string> {
    return traceRequest(input, { provider: 'jadense', model: this.options.selection?.kind === 'model' ? this.options.selection.modelId : undefined, requestedThinkingEffort: this.options.selection?.kind === 'model' ? this.options.selection.thinkingEffort : undefined, configSource: 'aiModelSettings' }, value => this.sendRecordedReliable(value))
  }
  private async sendRecordedReliable(input: TemporaryChatSendInput) {
    const body: Record<string, unknown> = { temporary: true, temporaryConversationId: input.conversationId, agentId: 'browser-extension',
      clientContext: { version, feature: input.clientFeature ?? 'chat', ...(input.clientOperation ? { operation: input.clientOperation, taskId: input.taskId, chunkId: input.operationId, chunkIndex: input.chunkIndex, chunkTotal: input.chunkTotal } : {}) }, clientRequestId: input.clientRequestId,
      origin: this.base(), taskId: input.taskId ?? input.conversationId, operationId: input.operationId ?? input.clientRequestId,
      ...(input.durableExecution ? { durableExecution: true } : {}),
      ...(input.previousRequestId ? { previousRequestId: input.previousRequestId } : {}),
      messages: temporaryChatMessages(responseFormatMessages(input.messages, input.responseFormat), input.sources, input.images),
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}), ...jadenseChatSelectionBody(this.options.selection) }
    const capability = await temporaryAccountCapability({ ...this.options, signal: input.signal })
    const account = capability.account
    // UI 重新构造消息 UUID 不应使未完成的同一输入丢失身份；完成记录不会拦截主动再次执行。
    const fingerprint = await requestHash(JSON.stringify({ conversation: input.conversationId, feature: input.clientFeature ?? 'chat', selection: this.options.selection,
      messages: input.messages.map(({ role, text }) => ({ role, text })), sources: input.sources, images: input.images,
      ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}) }))
    const rows = await this.store.list({ account, conversation: input.conversationId })
    const legacyAccount = await requestHash(this.base() + '\n' + this.options.token.trim())
    if (capability.verified && legacyAccount !== account) {
      for (const legacy of await this.store.list({ account: legacyAccount, conversation: input.conversationId })) {
        if (rows.some(row => row.id === legacy.id)) continue
        const migrated = { ...legacy, account }
        await this.store.save(migrated); rows.push(migrated)
      }
    }
    if (input.previousOperationId && !body.previousRequestId) body.previousRequestId = rows.find(row => row.body.operationId === input.previousOperationId)?.body.clientRequestId
    const completed = input.reuseCompletedOperation && input.operationId ? rows.find(row => row.account === account && row.body.operationId === input.operationId && row.status === 'completed' && row.fingerprint === fingerprint) : undefined
    if (completed) { reportProgress(input.onProgress, { stage: 'receiving', receivedCharacters: completed.text?.length ?? 0 }); return completed.text ?? '' }
    // PDF 进程可能在接收结果后、保存段落前退出；复用已确认的部分文本，交回本地补缺。
    const partial = input.reuseCompletedOperation && input.operationId ? rows.find(row => row.account === account && row.body.operationId === input.operationId && row.status === 'failed' && row.resultState === 'partial' && row.fingerprint === fingerprint && typeof row.text === 'string') : undefined
    if (partial) { reportProgress(input.onProgress, { stage: 'receiving', receivedCharacters: partial.text!.length }); throw new TemporaryPartialOutputError(partial.error ?? 'Partial output retained', partial.text!) }
    const terminal = input.reuseCompletedOperation && input.operationId ? rows.find(row => row.account === account
      && row.body.operationId === input.operationId && row.status === 'failed' && row.resultState && row.issue?.status !== 429 && row.fingerprint === fingerprint) : undefined
    if (terminal) throw new RequestExecutionError(terminal.error ?? 'Previously confirmed output retained', terminal.resultState!, terminal.text ?? '', terminal.issue)
    // 服务端清理正文仍保留已派发墓碑；UI 的新 UUID 不能把同一子任务伪装成首次生成。
    const expired = rows.find(row => row.account === account && row.issue?.status === 410
      && (row.body.clientRequestId === input.clientRequestId || input.operationId && row.body.operationId === input.operationId))
    if (expired) throw new RequestExecutionError(expired.error ?? 'The saved result expired; the original operation will not be executed again.', 'unknown', expired.text ?? '', expired.issue)
    let exact = rows.find(row => row.account === account && row.body.clientRequestId === input.clientRequestId)
    if (exact && exact.fingerprint !== fingerprint) throw new Error(uiText('同一请求身份不能用于不同输入。', 'The request identity belongs to different input.'))
    if (exact?.status === 'completed') { reportProgress(input.onProgress, { stage: 'receiving', receivedCharacters: exact.text?.length ?? 0 }); input.onTextDelta?.(exact.text ?? '', exact.text ?? ''); return exact.text ?? '' }
    if (exact?.status === 'failed' && exact.issue?.status === 429) {
      body.previousRequestId = exact.body.clientRequestId; body.clientRequestId = crypto.randomUUID(); exact = undefined
    }
    if (exact?.status === 'failed' && exact.resultState) { reportProgress(input.onProgress, { stage: 'receiving', receivedCharacters: exact.text?.length ?? 0 }); throw new RequestExecutionError(exact.error ?? 'Request ended', exact.resultState, exact.text ?? '', exact.issue) }
    // 只有显式同一子任务可恢复，不能因内容相同而合并两个不同的正常请求。
    let row = exact ?? rows.find(row => row.account === account && input.operationId && row.body.operationId === input.operationId && row.status === 'pending')
    if (row && row.fingerprint !== fingerprint) throw new Error(uiText('待恢复子任务的输入或模型已变化，请先恢复原请求。', 'The pending operation has different input or model settings. Recover the original request first.'))
    if (row?.status === 'pending') return this.recover(row, input)
    const probe = async () => {
      if (!row && input.responseFormat && capability.headers.get(RESPONSE_FORMAT_PROMPT_HEADER) === 'gateway') {
        body.messages = temporaryChatMessages(input.messages, input.sources, input.images)
      }
      if (input.responseFormat && capability.headers.get(RESPONSE_FORMAT_HEADER) !== '1') {
        if (input.responseFormat.fallback !== 'text') throw new Error(uiText('服务器不支持本次请求所需的结构化输出，请升级服务器。', 'Upgrade the server to support the structured output required by this request.'))
        // 旧服务器仍接收同一完整 Schema 提示；已持久化的请求正文不得被能力变化改写。
        delete body.responseFormat
        input.diagnostic?.event('response_format_compatibility', { source: 'legacy_server' })
      }
    }
    await probe()
    if (!row) {
      const prior = input.operationId ? rows.find(previous => previous.body.operationId === input.operationId && previous.status !== 'pending') : undefined
      if (prior && !body.previousRequestId) body.previousRequestId = prior.body.clientRequestId
      row = { id: crypto.randomUUID(), account, fingerprint, body, createdAt: new Date().toISOString(), status: 'pending' }
      await this.store.save(row)
    }
    reportProgress(input.onProgress, { stage: 'sent' })
    const transportAttemptId = crypto.randomUUID()
    input.diagnostic?.identify({ transportAttemptId })
    try {
    const response = await diagnosticFetch(input?.diagnostic, this.fetch.bind(this), `${this.base()}/api/chat`, { method: 'POST', headers: { ...this.headers(row.body.durableExecution === true), 'content-type': 'application/json' },
      body: JSON.stringify({ ...row.body, transportAttemptId }), signal: input.signal })
    if ([401, 403].includes(response.status)) await forgetTemporaryAccount(this.options)
    return await this.consume(response, row, input)
    } catch (error) {
      if (input.clientFeature !== 'translation' || input.signal?.aborted || row.status !== 'pending'
        || [401, 402, 403, 429].includes(requestIssue(error).status ?? 0)) throw error
      // SSE 错误不是权威终态；查询同一执行后再决定是否补缺，不再提交模型。
      return this.recover(row, input)
    }
  }
}
