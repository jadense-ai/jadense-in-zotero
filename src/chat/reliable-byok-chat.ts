/** BYOK 本地执行日志：不冒充第三方幂等；不确定结果禁止自动再次派发。 */
import { ByokChatClient, ByokResponseError, type ByokConfig, type ByokSendInput } from './byok-chat'
import { TemporaryRequestStore, requestHash, type LocalTemporaryRequest } from './temporary-request-store'
import { uiText } from '@/zotero/ui-preferences'
export class ReliableByokChatClient extends ByokChatClient {
  constructor(private options: { config: ByokConfig; fetchImpl?: typeof fetch }, private store = new TemporaryRequestStore()) { super(options) }
  async send(input: ByokSendInput): Promise<string> {
    // 配置探针不属于文献/对话业务执行，保留已有有界连通性探针。
    if (input.acceptTruncated) return super.send(input)
    // BYOK 的本地执行身份不随密钥轮换失效；配置属于冻结指纹，不能借换 Key 重发旧执行。
    const account = await requestHash('jadense-profile-byok-executions')
    const fingerprint = await requestHash(JSON.stringify({ config: this.options.config, conversation: input.conversationId, messages: input.messages.map(({ role, text }) => ({ role, text })), sources: input.sources, images: input.images }))
    const rows = await this.store.list({ account, conversation: input.conversationId })
    const previous = rows.find(row => row.account === account && (row.body.clientRequestId === input.clientRequestId || (input.operationId && row.body.operationId === input.operationId && row.status === 'pending')))
    if (previous && previous.fingerprint !== fingerprint) throw new Error('BYOK request identity belongs to different input')
    if (previous?.status === 'completed') { input.onTextDelta?.(previous.text ?? '', previous.text ?? ''); return previous.text ?? '' }
    if (previous) throw new Error(previous.error ?? uiText('BYOK 上次执行结果未确认。已有内容保留；请先核对提供商，不会自动重发。', 'The previous BYOK execution is unconfirmed. Check the provider; it will not be resent automatically.'))
    const prior = input.operationId ? rows.find(row => row.account === account && row.body.operationId === input.operationId && row.status !== 'pending') : undefined
    const row: LocalTemporaryRequest = { id: crypto.randomUUID(), account, fingerprint, createdAt: new Date().toISOString(), status: 'pending',
      body: { clientRequestId: input.clientRequestId, temporaryConversationId: input.conversationId, taskId: input.taskId, operationId: input.operationId, previousRequestId: input.previousRequestId ?? prior?.body.clientRequestId, byok: true } }
    await this.store.save(row)
    let result: string
    try { result = await super.send({ ...input, requireComplete: true }) } catch (error) {
      if (error instanceof ByokResponseError && [400,401,402,403,422,429].includes(error.status)) {
        row.status = 'failed'; row.error = error.message; await this.store.save(row)
      }
      throw error
    }
    row.status = 'completed'; row.text = result; await this.store.save(row)
    return result
  }
}
