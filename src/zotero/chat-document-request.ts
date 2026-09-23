/** 普通 Chat 的发送前文档准备：容量包括历史、来源、图片与输出预留，正文不经过来源快照截断。 */
import { buildSourceContext, type ChatSource } from '@/chat/research-context'
import { buildLongDocumentContext, documentTokenCost, type DocumentReading } from '@/chat/long-document-context'
import type { TemporaryChatMessage } from '@/chat/temporary-chat'
import { chatDocuments, type ChatDocument } from './chat-documents'
import { featureModelState, readByokSettings, type AiFeature } from './ai-settings'
import type { ZoteroLike } from './runtime'
import { requestHash } from '@/chat/temporary-request-store'
import { validateDocument, type DocumentHost } from './pdf-document'
import { readChatDocumentMode } from './chat-document-policy'

export function chatDocumentCapacity(host: ZoteroLike, feature: AiFeature) {
  const ai = featureModelState(host, feature)
  const selection = ai.selection
  const model = selection.route === 'byok' ? readByokSettings(host).models.find(row => row.id === selection.modelId) : undefined
  const context = model?.contextWindow ?? 16384
  const output = Math.max(1, Math.min(model?.maxOutputTokens ?? 4096, Math.floor(context / 4)))
  return { context, output, input: Math.floor(context * .85) - output - 512 }
}

export async function prepareDocumentRequest(input: {
  host: ZoteroLike; feature: AiFeature; sources: readonly ChatSource[]; messages: TemporaryChatMessage[]; imageCount: number
  signal: AbortSignal; modelIdentity: string; progress(text: string): void
  update(source: ChatSource): void
  generate(prompt: string, requestId: string, conversationId: string): Promise<string>
}): Promise<{ messages: TemporaryChatMessage[]; sources: ChatSource[]; reading?: DocumentReading }> {
  const sources = input.sources.map(source => ({ ...source }))
  if (!sources.some(source => source.kind === 'file' && source.contentType === 'application/pdf')) return { messages: input.messages, sources }
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
  const capacity = chatDocumentCapacity(input.host, input.feature)
  const messages = input.messages.map(message => ({ ...message }))
  const last = messages.at(-1)
  if (!last) return { messages, sources }
  const imageBudget = input.imageCount * 4096
  const messageCost = () => documentTokenCost(JSON.stringify(messages.map(({ role, text }) => ({ role, content: text }))))
  let dropped = false
  while (messages.length > 1 && messageCost() > Math.max(0, (capacity.input - imageBudget) / 2)) {
    messages.shift(); dropped = true
    if (messages.length > 1 && messages[0].role === 'assistant') messages.shift()
  }
  // 可选来源过多时只裁减本轮附加正文，不改变保存的选区和元数据。
  for (const source of [...sources].reverse()) {
    if (documentTokenCost(buildSourceContext(sources)) + messageCost() + imageBudget < capacity.input / 2) break
    if (source.text) { source.text = ''; source.warning = `${source.warning ?? ''} 本轮容量有限，此来源正文未附加。` }
  }
  const budget = capacity.input - imageBudget - messageCost() - documentTokenCost(buildSourceContext(sources)) - 256
  const question = last.text
  const recent = messages.slice(0, -1).slice(-4).map(row => row.text).join('\n').slice(-3000)
  const result = await buildLongDocumentContext({ documents, sourceNumbers: numbers, question, recent, budget,
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
  }
  if (result.context) last.text += `\n\n${result.context}`
  if (dropped) result.reading.notice += ' 本轮省略较早对话，完整历史仍保留。'
  if (sources.some(source => source.contentType === 'application/pdf' && !documents.some(document => document.source.id === source.id))) result.reading.notice += ' 部分 PDF 当前不可读取。'
  return { messages, sources, reading: result.reading }
}
