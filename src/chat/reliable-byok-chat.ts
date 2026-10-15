import { traceRequest } from "@/zotero/diagnostics"
/** BYOK 本地执行日志：不冒充第三方幂等；不确定结果禁止自动再次派发。 */
import { ByokChatClient, ByokResponseError, type ByokConfig, type ByokSendInput } from './byok-chat'
import { TemporaryRequestStore, requestHash, type LocalTemporaryRequest } from './temporary-request-store'
import { uiText } from '@/zotero/ui-preferences'
import { reportProgress, executionResult, requestIssue, RequestExecutionError } from './request-feedback'
export class ReliableByokChatClient extends ByokChatClient {
  constructor(private options: { config: ByokConfig; fetchImpl?: typeof fetch }, private store = new TemporaryRequestStore()) { super(options) }
  async send(input: ByokSendInput): Promise<string> {
    return traceRequest(input, { provider: 'byok', protocol: this.options.config.protocol, model: this.options.config.model }, value => this.sendReliable(value))
  }
  private async sendReliable(input: ByokSendInput): Promise<string> {
    // 配置探针不属于文献/对话业务执行，保留已有有界连通性探针。
    if (input.acceptTruncated) return super.send(input)
    // BYOK 的本地执行身份不随密钥轮换失效；配置属于冻结指纹，不能借换 Key 重发旧执行。
    const account = await requestHash('jadense-profile-byok-executions')
    const fingerprint = await requestHash(JSON.stringify({ config: this.options.config, conversation: input.conversationId, messages: input.messages.map(({ role, text }) => ({ role, text })), sources: input.sources, images: input.images, ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}) }))
    const rows = await this.store.list({ account, conversation: input.conversationId })
    const completed = input.reuseCompletedOperation && input.operationId ? rows.find(row => row.account === account && row.body.operationId === input.operationId && row.status === 'completed' && row.fingerprint === fingerprint) : undefined
    if (completed) { reportProgress(input.onProgress, { stage: 'receiving', receivedCharacters: completed.text?.length ?? 0 }); return completed.text ?? '' }
    let previous = rows.find(row => row.account === account && input.operationId && row.body.operationId === input.operationId && row.status === 'pending')
      ?? rows.find(row => row.account === account && row.body.clientRequestId === input.clientRequestId)
    if (previous && previous.fingerprint !== fingerprint) throw new Error('BYOK request identity belongs to different input')
    if (previous?.status === 'completed') { input.onTextDelta?.(previous.text ?? '', previous.text ?? ''); return previous.text ?? '' }
    let replacement: string | undefined, predecessor: unknown
    if (previous && (previous.status === 'failed' && previous.issue?.status === 429 || previous.status === 'pending' && input.allowUnconfirmedRetry)) {
      replacement = crypto.randomUUID(); predecessor = previous.body.clientRequestId
      previous.status = 'failed'; previous.body.supersededBy = replacement; await this.store.save(previous); previous = undefined
    }
    if (previous) throw new RequestExecutionError(previous.error ?? uiText('BYOK 上次执行结果未确认。已有内容保留；请先核对提供商，不会自动重发。', 'The previous BYOK execution is unconfirmed. Check the provider; it will not be resent automatically.'), previous.resultState ?? 'unknown', previous.text ?? '', previous.issue ?? { code: 'BYOK_EXECUTION_UNCONFIRMED' })
    const prior = input.operationId ? rows.find(row => row.account === account && row.body.operationId === (input.previousOperationId ?? input.operationId) && row.status !== 'pending') : undefined
    const row: LocalTemporaryRequest = { id: crypto.randomUUID(), account, fingerprint, createdAt: new Date().toISOString(), status: 'pending',
      body: { clientRequestId: replacement ?? input.clientRequestId, temporaryConversationId: input.conversationId, taskId: input.taskId, operationId: input.operationId, previousRequestId: predecessor ?? input.previousRequestId ?? prior?.body.clientRequestId, byok: true } }
    await this.store.save(row)
    let result: string
    try { result = await super.send({ ...input, requireComplete: true }) } catch (error) {
      const execution = executionResult(error)
      row.text = execution.text; row.issue = requestIssue(error)
      if (execution.state === 'partial' || execution.state === 'failed') { row.status = 'failed'; row.resultState = execution.state }
      if (error instanceof ByokResponseError && [400,401,402,403,422,429].includes(error.status)) {
        row.status = 'failed'; row.error = error.message; await this.store.save(row)
      }
      if (execution.state === 'unknown' && row.status === 'pending') row.issue = { ...row.issue, causeCode: row.issue?.code, code: 'BYOK_EXECUTION_UNCONFIRMED' }
      await this.store.save(row)
      if (execution.state === 'unknown' && row.status === 'pending' && input.clientFeature === 'translation' && !input.signal?.aborted)
        throw new RequestExecutionError(uiText('BYOK 执行结果未确认；可核对后重新请求未确认段落，可能重复计费。', 'BYOK execution is unconfirmed. Check the provider before requesting missing passages again; duplicate charges are possible.'), 'unknown', execution.text, row.issue)
      throw error
    }
    row.status = 'completed'; row.text = result; await this.store.save(row)
    return result
  }
}
