/** 普通 Chat 的发送前文档准备：容量包括历史、来源、图片与输出预留，正文不经过来源快照截断。 */
import { buildSourceContext, type ChatSource } from '@/chat/research-context'
import { buildLongDocumentContext, documentTokenCost, type DocumentReading } from '@/chat/long-document-context'
import type { TemporaryChatMessage } from '@/chat/temporary-chat'
import { chatDocuments, type ChatDocument } from './chat-documents'
import { type AiFeature, type FeatureModelSelection } from './ai-settings'
import type { ZoteroLike } from './runtime'
import { requestHash } from '@/chat/temporary-request-store'
import { validateDocument, type DocumentHost } from './pdf-document'
import { readChatDocumentMode } from './chat-document-policy'
import { modelRequestBudget } from './model-budget'
import { fitTextContext } from '@/chat/token-budget'
import { uiText } from './ui-preferences'
import type { ChatEvidence } from '@/chat/evidence'

export function chatDocumentCapacity(host: ZoteroLike, feature: AiFeature, selection?: FeatureModelSelection) {
  const budget = modelRequestBudget(host, feature, { selection })
  return { ...budget, context: budget.contextWindow }
}

export async function prepareDocumentRequest(input: {
  host: ZoteroLike; feature: AiFeature; sources: readonly ChatSource[]; messages: TemporaryChatMessage[]; imageCount: number
  signal: AbortSignal; modelIdentity: string; progress(text: string): void
  evidenceEnabled?: boolean
  capacity?: ReturnType<typeof chatDocumentCapacity>
  update(source: ChatSource): void
  generate(prompt: string, requestId: string, conversationId: string): Promise<string>
}): Promise<{ messages: TemporaryChatMessage[]; sources: ChatSource[]; reading?: DocumentReading; evidence?: ChatEvidence }> {
  const sources = input.sources.map(source => ({ ...source }))
  const cache = chatDocuments(input.host), documents: ChatDocument[] = [], numbers: number[] = []
  for (const [index, source] of sources.entries()) {
    if (source.kind !== 'file' || source.contentType !== 'application/pdf') continue
    try {
      const document = await cache.ensure(input.host, source, input.signal, input.progress)
      input.signal.throwIfAborted()
      documents.push(document); numbers.push(index + 1); sources[index] = document.source; input.update(document.source)
    } catch {
      input.signal.throwIfAborted()
      sources[index] = { ...source, text: '', warning: 'PDF 当前不可读取或文件版本已变化；本轮仅提供来源信息，不得声称读过正文。' }
      input.update(sources[index])
    }
  }
  const capacity = input.capacity ?? chatDocumentCapacity(input.host, input.feature)
  const messages = input.messages.map(message => ({ ...message }))
  const last = messages.at(-1)
  if (!last) return { messages, sources }
  const imageBudget = input.imageCount * 4096
  const messageCost = () => documentTokenCost(JSON.stringify(messages.map(({ role, text }) => ({ role, content: text }))))
  let dropped = false
  // 当前用户指令不可静默截短；只对已知模型做本地容量提示，目录故障不能成为新准入条件。
  if (capacity.maximum && documentTokenCost(JSON.stringify(last.text)) + imageBudget + 64 > capacity.input) {
    throw Object.assign(new Error(uiText('当前消息超过所选模型的输入容量，请缩短指令或把长正文作为文件附加。', 'The current message exceeds this model’s input capacity. Shorten the instruction or attach the long text as a file.')), { code: 'AI_INPUT_CONTEXT_LIMIT' })
  }
  while (messages.length > 1 && messageCost() > Math.max(0, (capacity.input - imageBudget) / (documents.length ? 2 : 1) - 512)) {
    messages.shift(); dropped = true
    if (messages.length > 1 && messages[0].role === 'assistant') messages.shift()
  }
  // 可选来源过多时只裁减本轮附加正文，不改变保存的选区和元数据。
  for (const source of sources) {
    delete source.textRef // 本轮片段投影不能再从正文引用自动恢复全文。
    const fitted = fitTextContext(source.text, Math.max(0, (capacity.input - imageBudget - messageCost() - 768) / Math.max(1, sources.length) / (documents.length ? 2 : 1)), last.text)
    source.text = fitted.text
    if (fitted.limited) source.warning = `${source.warning ?? ''} 本轮仅附与问题相关的部分原文，不代表已读全文。`
  }
  if (!documents.length) return { messages, sources, ...(dropped ? { reading: { notice: uiText('本轮省略较早对话，完整历史仍保留。', 'Earlier turns were omitted from this request; full history is retained.'), sources: [] } } : {}) }
  const budget = capacity.input - imageBudget - messageCost() - documentTokenCost(buildSourceContext(sources)) - 256
  const question = last.text
  const recent = messages.slice(0, -1).slice(-4).map(row => row.text).join('\n').slice(-3000)
  const result = await buildLongDocumentContext({ documents, sourceNumbers: numbers, question, recent, budget,
    evidenceEnabled: input.evidenceEnabled,
    mode: readChatDocumentMode(input.host),
    summaryInputBudget: Math.max(256, capacity.input - documentTokenCost(question) - 1024),
    modelKey: await requestHash(input.modelIdentity), signal: input.signal, progress: input.progress,
    save: document => cache.save(document.state),
    generate: async (prompt, requestId, conversationId) => {
      // 只跳过放不下的可选整理，不新增普通对话准入限制。
      if (documentTokenCost(prompt) > capacity.input) throw new Error('文献整理输入超出当前模型预算。')
      return input.generate(prompt, requestId, conversationId)
    },
  })
  // 长时间分段生成后再次复核，替换/删除附件不能让过时原文继续冒充当前文件。
  let current = true
  for (const document of documents) {
    try { await validateDocument(input.host as unknown as DocumentHost, document.state.source) }
    catch { current = false }
  }
  input.signal.throwIfAborted()
  if (!current) {
    result.context = ''; result.reading = { notice: 'PDF 在准备期间已变化，本轮未附加原文；请重新关联后提问。', sources: [] }
    result.evidence = undefined
  }
  if (result.context) last.text += `\n\n${result.context}`
  if (dropped) result.reading.notice += ' 本轮省略较早对话，完整历史仍保留。'
  if (sources.some(source => source.contentType === 'application/pdf' && !documents.some(document => document.source.id === source.id))) result.reading.notice += ' 部分 PDF 当前不可读取。'
  return { messages, sources, reading: result.reading, ...(input.evidenceEnabled ? { evidence: result.evidence ?? { entries: [] } } : {}) }
}
