/** 新版 Zotero 攻玉客户端：先确认协议，再持久化/认领；重发只复用稳定执行身份。 */
import { TemporaryChatClient, temporaryChatMessages, jadenseChatSelectionBody, consumeTemporaryChatStream, type TemporaryChatClientOptions, type TemporaryChatSendInput } from './temporary-chat'
import { readJadenseApiError, JadenseApiError } from '@/jadense/api'
import { TemporaryRequestStore, requestHash, type LocalTemporaryRequest } from './temporary-request-store'
import { version } from '../../package.json'
import { uiText } from '@/zotero/ui-preferences'

const HEADER = 'x-jadense-temporary-protocol'
export class ReliableTemporaryChatClient extends TemporaryChatClient {
  private options: TemporaryChatClientOptions
  constructor(options: TemporaryChatClientOptions, private store = new TemporaryRequestStore()) { super(options); this.options = options }
  private fetch(input: string, init: RequestInit) { return this.options.fetchImpl ? this.options.fetchImpl(input, init) : globalThis.fetch(input, init) }
  private base() { return this.options.baseUrl.trim().replace(/\/+$/, '') }
  private headers() { return { authorization: `Bearer ${this.options.token.trim()}`, [HEADER]: '1' } }
  private async account() { return requestHash(this.base() + '\n' + this.options.token.trim()) }
  async pending() { return (await this.store.list()).filter(row => row.body.byok !== true && row.body.origin === this.base() && row.status === 'pending') }

  /** 只读恢复不需要原始提示词或模型选择；当前令牌仍需同用户同插件授权。 */
  async recover(row: LocalTemporaryRequest, input?: Pick<TemporaryChatSendInput, 'signal' | 'onTextDelta'>): Promise<string> {
    if (row.body.origin !== this.base()) throw new Error(uiText('请求属于其他服务器。', 'This request belongs to another server.'))
    let response: Response
    const until = Date.now() + 60_000
    const deadline = new AbortController()
    const abort = () => deadline.abort()
    input?.signal?.addEventListener('abort', abort, { once: true })
    if (input?.signal?.aborted) abort()
    const timeout = setTimeout(abort, 60_000)
    try {
    do {
      response = await this.fetch(`${this.base()}/api/chat/temporary?conversationId=${encodeURIComponent(String(row.body.temporaryConversationId))}&requestId=${encodeURIComponent(String(row.body.clientRequestId))}`, { headers: this.headers(), signal: deadline.signal })
      if (response.status !== 202) return await this.consume(response, row, input)
      if (Date.now() >= until) throw new Error(uiText('仍在执行，稍后点击“恢复结果”；不会重复请求模型。', 'Still running. Use Recover result later; the model will not run again.'))
      const delay = Math.min(5000, Math.max(1000, Number(response.headers.get('retry-after') ?? 2) * 1000))
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
        const timer = setTimeout(() => { deadline.signal.removeEventListener('abort', abort); resolve() }, delay)
        deadline.signal.addEventListener('abort', abort, { once: true }); if (deadline.signal.aborted) abort()
      })
    } while (Date.now() <= until + 5000)
    throw new Error(uiText('仍在执行，请稍后恢复结果。', 'Still running. Recover the result later.'))
    } catch (error) {
      if (deadline.signal.aborted && !input?.signal?.aborted) throw new Error(uiText('恢复等待已达 60 秒，请稍后再次恢复结果。', 'Recovery waited for 60 seconds. Recover again later.'))
      throw error
    } finally { clearTimeout(timeout); input?.signal?.removeEventListener('abort', abort) }
  }
  private async consume(response: Response, row: LocalTemporaryRequest, input?: Pick<TemporaryChatSendInput, 'signal' | 'onTextDelta'>): Promise<string> {
    if (response.headers.get(HEADER) !== '1') throw new Error(uiText('服务器不支持安全恢复，请升级服务器。', 'Upgrade the server to support safe recovery.'))
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
      output = await consumeTemporaryChatStream(response, input?.onTextDelta, true)
    } else {
      const result = await response.json() as { text?: string; complete?: boolean; error?: string; state?: string }
      output = result.text ?? ''
      input?.onTextDelta?.(output, output)
      if (!result.complete || result.state !== 'completed') { row.status = 'failed'; row.text = output; row.error = result.error ?? uiText('输出未完整结束，已有内容保留。', 'Output was incomplete; existing text is retained.'); await this.store.save(row); throw new Error(row.error) }
    }
    row.status = 'completed'; row.text = output; await this.store.save(row)
    return output
  }
  async send(input: TemporaryChatSendInput) {
    const body: Record<string, unknown> = { temporary: true, temporaryConversationId: input.conversationId, agentId: 'browser-extension',
      clientContext: { version, feature: input.clientFeature ?? 'chat' }, clientRequestId: input.clientRequestId,
      origin: this.base(), taskId: input.taskId ?? input.conversationId, operationId: input.operationId ?? input.clientRequestId,
      ...(input.previousRequestId ? { previousRequestId: input.previousRequestId } : {}),
      messages: temporaryChatMessages(input.messages, input.sources, input.images), ...jadenseChatSelectionBody(this.options.selection) }
    const account = await this.account()
    // UI 重新构造消息 UUID 不应使未完成的同一输入丢失身份；完成记录不会拦截主动再次执行。
    const fingerprint = await requestHash(JSON.stringify({ conversation: input.conversationId, feature: input.clientFeature ?? 'chat', selection: this.options.selection,
      messages: input.messages.map(({ role, text }) => ({ role, text })), sources: input.sources, images: input.images }))
    const rows = await this.store.list({ account, conversation: input.conversationId })
    const exact = rows.find(row => row.account === account && row.body.clientRequestId === input.clientRequestId)
    if (exact && exact.fingerprint !== fingerprint) throw new Error(uiText('同一请求身份不能用于不同输入。', 'The request identity belongs to different input.'))
    if (exact?.status === 'completed') { input.onTextDelta?.(exact.text ?? '', exact.text ?? ''); return exact.text ?? '' }
    // 只有显式同一子任务可恢复，不能因内容相同而合并两个不同的正常请求。
    let row = exact ?? rows.find(row => row.account === account && input.operationId && row.body.operationId === input.operationId && row.status === 'pending')
    if (row && row.fingerprint !== fingerprint) throw new Error(uiText('待恢复子任务的输入或模型已变化，请先恢复原请求。', 'The pending operation has different input or model settings. Recover the original request first.'))
    const capability = await this.fetch(`${this.base()}/api/chat/temporary`, { method: 'HEAD', headers: this.headers(), signal: input.signal })
    if (capability.status === 401 || capability.status === 403) throw await readJadenseApiError(capability, uiText('请检查当前 Zotero 令牌与对话权限。', 'Check the current Zotero token and chat permissions.'))
    if (!capability.ok || capability.headers.get(HEADER) !== '1') throw new Error(uiText('服务器尚不支持安全的 AI 请求，请先升级服务器。', 'Upgrade the server before using safe AI requests.'))
    if (!row) {
      const prior = input.operationId ? rows.find(previous => previous.body.operationId === input.operationId && previous.status !== 'pending') : undefined
      if (prior && !body.previousRequestId) body.previousRequestId = prior.body.clientRequestId
      row = { id: crypto.randomUUID(), account, fingerprint, body, createdAt: new Date().toISOString(), status: 'pending' }
      await this.store.save(row)
    }
    const response = await this.fetch(`${this.base()}/api/chat`, { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ ...row.body, transportAttemptId: crypto.randomUUID() }), signal: input.signal })
    return this.consume(response, row, input)
  }
}
