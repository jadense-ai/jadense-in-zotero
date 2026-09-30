import { structuredResponseReceipt } from './response-format'
import { reportProgress, requestError, requestIssue, thinkingReceipt, type RequestProgressListener } from './request-feedback'
import { traceRequest, diagnosticFetch, type RequestDiagnostic } from "@/zotero/diagnostics"
import { uiText } from "@/zotero/ui-preferences"
import { streamDiagnostics } from './stream-diagnostics'
/**
 * 攻玉 temporary chat 客户端。
 * 上游接收 Zotero 本地消息，下游只调用无服务端会话历史的 `/api/chat` temporary 模式。
 */
import { buildSourceContext, type ChatSource } from "./research-context"
import type { ChatImageInput } from "./image-input"
import { readJadenseApiError, type JadenseChatSelection } from "@/jadense/api"
import { version as clientVersion } from "../../package.json"
import { RESPONSE_FORMAT_PROMPT_HEADER, responseFormatMessages, type ChatResponseFormat } from './response-format'

export type { ChatImageInput } from "./image-input"

export type TemporaryChatMessage = {
  id: string
  role: "user" | "assistant"
  text: string
}

export type TemporaryChatClientOptions = {
  baseUrl: string
  token: string
  selection?: JadenseChatSelection
  fetchImpl?: typeof fetch
}

export type TemporaryChatSendInput = {
  responseFormat?: ChatResponseFormat
  clientOperation?: "full_translation" | "selection_translation" | "reference_identification"
  chunkIndex?: number
  chunkTotal?: number
  diagnostic?: RequestDiagnostic
  taskId?: string
  operationId?: string
  previousRequestId?: string
  clientFeature?: "chat" | "translation" | "analysis" | "figure"
  clientRequestId: string
  conversationId: string
  messages: TemporaryChatMessage[]
  onProgress?: RequestProgressListener
  onTextDelta?: (delta: string, accumulatedText: string) => void
  signal?: AbortSignal
  sources?: readonly ChatSource[]
  images?: readonly ChatImageInput[]
  requireComplete?: boolean
  /** PDF 批次身份含持久化重试代次，可复用同一操作的完整回执。 */
  reuseCompletedOperation?: boolean
}

type StreamEvent = Record<string, unknown> & {
  type?: unknown
  delta?: unknown
  errorText?: unknown
  finishReason?: unknown
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/g, "")
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit) {
  // Gecko 140 要求 Window.fetch 保留原始 Window 接收者。
  return globalThis.fetch(input, init)
}

function parseEventData(value: string): StreamEvent | null {
  if (!value || value === "[DONE]") return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" ? parsed as StreamEvent : null
  } catch {
    return null
  }
}

export async function consumeTemporaryChatStream(
  response: Response,
  onTextDelta?: (delta: string, accumulatedText: string) => void,
  requireComplete = false,
  diagnostic?: RequestDiagnostic,
  onProgress?: RequestProgressListener,
) {
  if (!response.ok) {
    throw await readJadenseApiError(response, uiText("攻玉对话请求失败", "The Jadense chat request failed"), true)
  }
  if (!response.body) throw new Error(uiText("攻玉对话响应缺少数据流。", "The Jadense chat response has no stream."))

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let accumulatedText = ""
  let complete = false
  let reasoning = false, malformed = false
  reportProgress(onProgress, { stage: 'sent' })
  diagnostic?.identify({ requestId: response.headers.get('x-request-id'), executionId: response.headers.get('x-execution-id') })
  const streamTrace = streamDiagnostics(diagnostic)

  const consumeBlock = (block: string) => {
    const data = block
      .split(/\r?\n/g)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    const event = parseEventData(data)
    streamTrace.block(data, event)
    if (data.trim() === "[DONE]") {
      diagnostic?.event("DONE")
      complete = true
      return
    }
    if (!event) {
      if (data.trim()) { malformed = true; diagnostic?.event('invalid_event', { code: 'STREAM_PARSE_FAILED' }) }
      return
    }
    const metadata = event.messageMetadata as Record<string, unknown> | undefined
    diagnostic?.identify(structuredResponseReceipt(metadata?.structuredResponse, metadata?.thinking))
    const receipt = thinkingReceipt((event.messageMetadata as Record<string, unknown> | undefined)?.thinking)
    if (receipt) { diagnostic?.identify({ ...receipt }); reportProgress(onProgress, { stage: accumulatedText ? 'receiving' : reasoning ? 'reasoning' : 'sent', receivedCharacters: accumulatedText.length, thinking: receipt }) }
    if (event.type === 'reasoning-start' || event.type === 'reasoning-delta') {
      diagnostic?.reasoning()
      reasoning = true
      if (!accumulatedText) reportProgress(onProgress, { stage: 'reasoning', receivedCharacters: 0 })
    }
    if (["abort", "error", "finish"].includes(String(event.type))) diagnostic?.event(String(event.type), { source: typeof event.finishReason === "string" ? event.finishReason : undefined })
    if (event.type === "abort") throw Object.assign(requestError(uiText('请求已中止。', 'The request was stopped.'), event, { code: 'OUTPUT_CANCELLED', stage: 'stream' }), { name: 'AbortError' })
    if (event.type === "error") {
      throw requestError(typeof event.errorText === "string" && event.errorText.trim()
        ? event.errorText.trim()
        : uiText("攻玉对话生成失败，请稍后重试。", "Jadense chat generation failed. Please try again later."), event, { code: 'STREAM_FAILED', stage: 'provider_stream' })
    }
    if (event.type === "finish") {
      if (requireComplete && (event.finishReason === "error" || event.finishReason === "length")) {
        throw Object.assign(new Error(uiText("输出未完整结束，请重试。", "Output was incomplete. Please retry.")), { code: "STREAM_INCOMPLETE" })
      }
      complete = true
    }
    if (event.type !== "text-delta" || typeof event.delta !== "string") return
    accumulatedText += event.delta
    diagnostic?.text(event.delta.length)
    reportProgress(onProgress, { stage: 'receiving', receivedCharacters: accumulatedText.length })
    try { onTextDelta?.(event.delta, accumulatedText) } catch (error) { diagnostic?.fail(error, "callback_error"); throw error }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      diagnostic?.data(value?.byteLength ?? 0)
      pending += decoder.decode(value, { stream: !done })
      streamTrace.pending(pending.length)
      let boundary = pending.search(/\r?\n\r?\n/)
      while (boundary >= 0) {
        const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n"
        consumeBlock(pending.slice(0, boundary))
        pending = pending.slice(boundary + separator.length)
        streamTrace.pending(pending.length)
        boundary = pending.search(/\r?\n\r?\n/)
      }
      if (complete) { await reader.cancel().catch(() => undefined); break }
      if (done) break
    }
    if (!complete && pending.trim()) consumeBlock(pending)
    // 只有需要写 PDF 的动作要求终止事件；普通对话兼容原有文本流。
    if (!complete) diagnostic?.fail(Object.assign(new Error(), { code: "STREAM_EARLY_EOF" }), "early_eof")
    if (requireComplete && !complete) throw Object.assign(new Error(uiText("连接意外结束，已生成内容已保留，请重试。", "The connection ended unexpectedly. Generated content is retained. Please retry.")), { code: "STREAM_EARLY_EOF" })
    if (requireComplete && !accumulatedText.trim()) throw requestError(uiText('模型未返回译文。', 'The model returned no translation.'), {}, { code: malformed ? 'STREAM_PARSE_FAILED' : reasoning ? 'REASONING_ONLY' : 'EMPTY_OUTPUT', stage: 'stream' })
    return accumulatedText
  } catch (error) {
    if (error && typeof error === 'object') try { Object.assign(error, requestIssue(error, {
      code: (error as Error).name === 'AbortError' ? 'OUTPUT_CANCELLED' : 'NETWORK_ERROR', stage: 'stream',
      ...requestIssue({ requestId: response.headers.get('x-request-id'), executionId: response.headers.get('x-execution-id'), diagnosticId: response.headers.get('x-diagnostic-id') }),
    })) } catch { /* Frozen error. */ }
    diagnostic?.fail(error, "stream_error")
    diagnostic?.event("cleanup_cancel", { source: "stream_cleanup" })
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    streamTrace.flush()
    reader.releaseLock()
  }
}

/** 本地来源仅包装当前用户消息，不污染持久化历史或建立服务端附件。 */
export function localChatMessages(messages: TemporaryChatMessage[], sources: readonly ChatSource[] = []) {
  const context = buildSourceContext(sources)
  const lastUser = messages.map((message) => message.role).lastIndexOf("user")
  return messages.map((message, index) => ({
    role: message.role,
    content: index === lastUser && context ? `${message.text}\n\n${context}` : message.text,
  }))
}

export function temporaryChatMessages(
  messages: TemporaryChatMessage[],
  sources: readonly ChatSource[] = [],
  images: readonly ChatImageInput[] = [],
) {
  const projected = localChatMessages(messages, sources)
  const lastUser = messages.map((message) => message.role).lastIndexOf("user")
  return messages.map((message, index) => ({
    id: message.id,
    role: message.role,
    parts: [
      { type: "text", text: projected[index]!.content },
      ...(index === lastUser
        ? images.map((image) => ({
            type: "file",
            mimeType: image.mimeType,
            url: image.dataUrl,
            ...(image.name ? { name: image.name } : {}),
          }))
        : []),
    ],
  }))
}

export function jadenseChatSelectionBody(selection: JadenseChatSelection | undefined) {
  if (selection?.kind === "route") return { routeTier: selection.routeTier }
  if (selection?.kind === "model") return { modelId: selection.modelId, ...(selection.thinkingEffort?.trim() ? { thinkingEffort: selection.thinkingEffort.trim() } : {}) }
  return {}
}

export class TemporaryChatClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly selection: JadenseChatSelection | undefined
  private readonly fetchImpl: typeof fetch

  constructor(options: TemporaryChatClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.token = options.token.trim()
    this.selection = options.selection ? { ...options.selection } : undefined
    this.fetchImpl = options.fetchImpl ?? defaultFetch
  }

  async send(input: TemporaryChatSendInput): Promise<string> {
    return traceRequest(input, { provider: 'jadense', configSource: 'aiModelSettings', model: this.selection?.kind === 'model' ? this.selection.modelId : undefined, requestedThinkingEffort: this.selection?.kind === 'model' ? this.selection.thinkingEffort : undefined }, value => this.sendRecorded(value))
  }
  private async sendRecorded(input: TemporaryChatSendInput) {
    if (!this.baseUrl) throw new Error(uiText("请先配置攻玉服务器地址。", "Configure the Jadense server URL first."))
    if (!this.token) throw new Error(uiText("请先配置包含对话权限的 Zotero 令牌。", "Configure a Zotero token with chat permission first."))
    reportProgress(input.onProgress, { stage: 'sent' })
    // 新服务器拥有格式提示；旧服务器继续收到原有字段提示，普通文本调用不新增探测。
    let gatewayOwnsFormatPrompt = false
    if (input.responseFormat) {
      try {
        const capability = await this.fetchImpl(`${this.baseUrl}/api/chat/temporary`, { method: 'HEAD', headers: { authorization: `Bearer ${this.token}` }, signal: input.signal })
        gatewayOwnsFormatPrompt = capability.ok && capability.headers.get(RESPONSE_FORMAT_PROMPT_HEADER) === 'gateway'
      } catch { input.signal?.throwIfAborted() }
    }
    const response = await diagnosticFetch(input.diagnostic, this.fetchImpl, `${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        temporary: true,
        temporaryConversationId: input.conversationId,
        agentId: "browser-extension",
        clientContext: { version: clientVersion, feature: input.clientFeature ?? "chat", ...(input.clientOperation ? { operation: input.clientOperation, taskId: input.taskId, chunkId: input.operationId, chunkIndex: input.chunkIndex, chunkTotal: input.chunkTotal } : {}) },
        clientRequestId: input.clientRequestId,
        taskId: input.taskId, operationId: input.operationId,
        messages: temporaryChatMessages(gatewayOwnsFormatPrompt ? input.messages : responseFormatMessages(input.messages, input.responseFormat), input.sources, input.images),
        ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
        ...jadenseChatSelectionBody(this.selection),
      }),
      signal: input.signal,
    })
    return consumeTemporaryChatStream(response, input.onTextDelta, input.requireComplete, input.diagnostic, input.onProgress)
  }
}
