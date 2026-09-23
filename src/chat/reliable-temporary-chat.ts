import { traceRequest, diagnosticFetch, markDiagnosticAbort } from "@/zotero/diagnostics"
/** 新版 Zotero 攻玉客户端：先确认协议，再持久化/认领；重发只复用稳定执行身份。 */
import { TemporaryChatClient, temporaryChatMessages, jadenseChatSelectionBody, consumeTemporaryChatStream, type TemporaryChatClientOptions, type TemporaryChatSendInput } from './temporary-chat'
import { readJadenseApiError, JadenseApiError } from '@/jadense/api'
import { TemporaryRequestStore, requestHash, type LocalTemporaryRequest } from './temporary-request-store'
import { version } from '../../package.json'
import { uiText } from '@/zotero/ui-preferences'
import type { TranslationFetch } from './translation-queue'

const HEADER = 'x-jadense-temporary-protocol'
// 只缓存翻译用途的成功能力探针；POST 仍执行服务端鉴权。
const translationCapabilities = new Map<string, { expires: number; pending?: Promise<void> }>()
/** 服务端已确认 partial 终态；文本仅供 PDF 本地段落校验，不代表完整执行成功。 */
export class TemporaryPartialOutputError extends Error {
  readonly code = 'OUTPUT_PARTIAL'
  readonly executionState = 'partial'
  constructor(message: string, readonly partialText: string) { super(message) }
}
export class ReliableTemporaryChatClient extends TemporaryChatClient {
  private options: TemporaryChatClientOptions
  constructor(options: TemporaryChatClientOptions, private store = new TemporaryRequestStore()) { super(options); this.options = options }
  private fetch(input: RequestInfo | URL, init?: RequestInit) { return this.options.fetchImpl ? this.options.fetchImpl(input, init) : globalThis.fetch(input, init) }
  private base() { return this.options.baseUrl.trim().replace(/\/+$/, '') }
  private headers() { return { authorization: `Bearer ${this.options.token.trim()}`, [HEADER]: '1' } }
  private async account() { return requestHash(this.base() + '\n' + this.options.token.trim()) }
  async pending() { return (await this.store.list()).filter(row => row.body.byok !== true && row.body.origin === this.base() && row.status === 'pending') }

  /** 只读恢复不需要原始提示词或模型选择；当前令牌仍需同用户同插件授权。 */
  async recover(row: LocalTemporaryRequest, input?: Pick<TemporaryChatSendInput, 'signal' | 'onTextDelta' | 'diagnostic'>): Promise<string> {
    if (!input?.diagnostic) return traceRequest({ ...input, clientRequestId: String(row.body.clientRequestId), conversationId: String(row.body.temporaryConversationId), taskId: typeof row.body.taskId === 'string' ? row.body.taskId : undefined, operationId: typeof row.body.operationId === 'string' ? row.body.operationId : undefined }, { provider: 'jadense', feature: 'recovery' }, value => this.recoverRecorded(row, value))
    return this.recoverRecorded(row, input)
  }
  private async recoverRecorded(row: LocalTemporaryRequest, input?: Pick<TemporaryChatSendInput, 'signal' | 'onTextDelta' | 'diagnostic'>): Promise<string> {
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
      response = await diagnosticFetch(input?.diagnostic, this.fetch.bind(this), `${this.base()}/api/chat/temporary?conversationId=${encodeURIComponent(String(row.body.temporaryConversationId))}&requestId=${encodeURIComponent(String(row.body.clientRequestId))}`, { headers: this.headers(), signal: deadline.signal })
      if (response.status !== 202) return await this.consume(response, row, input)
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
  private async consume(response: Response, row: LocalTemporaryRequest, input?: Pick<TemporaryChatSendInput, 'signal' | 'onTextDelta' | 'diagnostic'>): Promise<string> {
    if (response.headers.get(HEADER) !== '1') { translationCapabilities.delete(await this.account()); throw new Error(uiText('服务器不支持安全恢复，请升级服务器。', 'Upgrade the server to support safe recovery.')) }
    if (response.status === 202) return this.recover(row, input)
    if (!response.ok) {
      const error = await readJadenseApiError(response, 'AI request failed')
      let terminal = false
      if (error instanceof JadenseApiError) try { terminal = ['failed','partial','cancelled'].includes(JSON.parse(error.body).state) } catch { /* 无权威终态则保留待恢复。 */ }
      // 未找到/不确定可恢复；明确业务终态允许用户开始新轮次，但不自动重发。
      if (error instanceof JadenseApiError && (terminal || [400,401,402,403,410,422,429].includes(error.status))) { row.status = 'failed'; row.error = error.message; await this.store.save(row) }
      throw error
    }
    let output: string
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      output = await consumeTemporaryChatStream(response, input?.onTextDelta, true, input?.diagnostic)
    } else {
      const result = await response.json() as { text?: string; complete?: boolean; error?: string; state?: string; finishReason?: string }
      input?.diagnostic?.identify(result as Record<string, unknown>)
      const state = ['completed', 'partial', 'failed', 'cancelled', 'running'].includes(result.state ?? '') ? result.state! : 'unknown'
      input?.diagnostic?.event('result_state', { source: state })
      input?.diagnostic?.event('result_finish', { source: ['stop', 'length', 'error', 'content-filter'].includes(result.finishReason ?? '') ? result.finishReason : 'unknown' })
      output = typeof result.text === 'string' ? result.text : ''
      input?.diagnostic?.text(output.length)
      input?.onTextDelta?.(output, output)
      if (!result.complete || state !== 'completed') {
        if (['partial', 'failed', 'cancelled'].includes(state)) row.status = 'failed'
        if (state === 'partial') row.resultState = 'partial'
        row.text = output; row.error = result.error ?? uiText('输出未完整结束，已有内容保留。', 'Output was incomplete; existing text is retained.'); await this.store.save(row)
        if (state === 'partial') throw new TemporaryPartialOutputError(row.error, output)
        throw Object.assign(new Error(row.error), { code: state === 'failed' ? 'OUTPUT_FAILED' : state === 'cancelled' ? 'OUTPUT_CANCELLED' : 'TEMPORARY_RESULT_UNCONFIRMED' })
      }
    }
    row.status = 'completed'; row.text = output; await this.store.save(row)
    return output
  }
  async send(input: TemporaryChatSendInput): Promise<string> {
    return traceRequest(input, { provider: 'jadense', model: this.options.selection?.kind === 'model' ? this.options.selection.modelId : undefined }, value => this.sendRecordedReliable(value))
  }
  private async sendRecordedReliable(input: TemporaryChatSendInput) {
    const body: Record<string, unknown> = { temporary: true, temporaryConversationId: input.conversationId, agentId: 'browser-extension',
      clientContext: { version, feature: input.clientFeature ?? 'chat', ...(input.clientOperation ? { operation: input.clientOperation, taskId: input.taskId, chunkId: input.operationId, chunkIndex: input.chunkIndex, chunkTotal: input.chunkTotal } : {}) }, clientRequestId: input.clientRequestId,
      origin: this.base(), taskId: input.taskId ?? input.conversationId, operationId: input.operationId ?? input.clientRequestId,
      ...(input.previousRequestId ? { previousRequestId: input.previousRequestId } : {}),
      messages: temporaryChatMessages(input.messages, input.sources, input.images), ...jadenseChatSelectionBody(this.options.selection) }
    const account = await this.account()
    // UI 重新构造消息 UUID 不应使未完成的同一输入丢失身份；完成记录不会拦截主动再次执行。
    const fingerprint = await requestHash(JSON.stringify({ conversation: input.conversationId, feature: input.clientFeature ?? 'chat', selection: this.options.selection,
      messages: input.messages.map(({ role, text }) => ({ role, text })), sources: input.sources, images: input.images }))
    const rows = await this.store.list({ account, conversation: input.conversationId })
    const completed = input.reuseCompletedOperation && input.operationId ? rows.find(row => row.account === account && row.body.operationId === input.operationId && row.status === 'completed' && row.fingerprint === fingerprint) : undefined
    if (completed) return completed.text ?? ''
    // PDF 进程可能在接收结果后、保存段落前退出；复用已确认的部分文本，交回本地补缺。
    const partial = input.reuseCompletedOperation && input.operationId ? rows.find(row => row.account === account && row.body.operationId === input.operationId && row.status === 'failed' && row.resultState === 'partial' && row.fingerprint === fingerprint && typeof row.text === 'string') : undefined
    if (partial) throw new TemporaryPartialOutputError(partial.error ?? 'Partial output retained', partial.text!)
    const exact = rows.find(row => row.account === account && row.body.clientRequestId === input.clientRequestId)
    if (exact && exact.fingerprint !== fingerprint) throw new Error(uiText('同一请求身份不能用于不同输入。', 'The request identity belongs to different input.'))
    if (exact?.status === 'completed') { input.onTextDelta?.(exact.text ?? '', exact.text ?? ''); return exact.text ?? '' }
    // 只有显式同一子任务可恢复，不能因内容相同而合并两个不同的正常请求。
    let row = exact ?? rows.find(row => row.account === account && input.operationId && row.body.operationId === input.operationId && row.status === 'pending')
    if (row && row.fingerprint !== fingerprint) throw new Error(uiText('待恢复子任务的输入或模型已变化，请先恢复原请求。', 'The pending operation has different input or model settings. Recover the original request first.'))
    const probe = async () => {
      const capability = await diagnosticFetch(input.diagnostic, this.fetch.bind(this), `${this.base()}/api/chat/temporary`, { method: 'HEAD', headers: this.headers(), signal: input.signal })
      if (!capability.ok) throw await readJadenseApiError(capability, uiText('请检查当前 Zotero 令牌与对话权限。', 'Check the current Zotero token and chat permissions.'))
      if (capability.headers.get(HEADER) !== '1') throw new Error(uiText('服务器尚不支持安全的 AI 请求，请先升级服务器。', 'Upgrade the server before using safe AI requests.'))
    }
    if (input.clientFeature !== 'translation') await probe()
    else {
      const cached = translationCapabilities.get(account)
      if (cached?.pending) await cached.pending
      else if (!cached || cached.expires <= Date.now()) {
        const entry = { expires: 0, pending: undefined as Promise<void> | undefined }
        entry.pending = probe().then(() => { entry.expires = Date.now() + 300_000; entry.pending = undefined }).catch(error => { translationCapabilities.delete(account); throw error })
        translationCapabilities.set(account, entry); await entry.pending
      }
    }
    if (!row) {
      const prior = input.operationId ? rows.find(previous => previous.body.operationId === input.operationId && previous.status !== 'pending') : undefined
      if (prior && !body.previousRequestId) body.previousRequestId = prior.body.clientRequestId
      row = { id: crypto.randomUUID(), account, fingerprint, body, createdAt: new Date().toISOString(), status: 'pending' }
      await this.store.save(row)
    }
    const transportAttemptId = crypto.randomUUID()
    input.diagnostic?.identify({ transportAttemptId })
    const response = await diagnosticFetch(input?.diagnostic, this.fetch.bind(this), `${this.base()}/api/chat`, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ ...row.body, transportAttemptId }), signal: input.signal })
    if ([401, 403].includes(response.status)) translationCapabilities.delete(account)
    return this.consume(response, row, input)
  }
}
