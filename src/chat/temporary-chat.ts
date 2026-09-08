/**
 * 攻玉 temporary chat 客户端。
 * 上游接收 Zotero 本地消息，下游只调用无服务端会话历史的 `/api/chat` temporary 模式。
 */
import { buildSourceContext, type ChatSource } from "./research-context"
import type { ChatImageInput } from "./image-input"
import { readJadenseApiError, type JadenseChatSelection } from "@/jadense/api"

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
  clientRequestId: string
  conversationId: string
  messages: TemporaryChatMessage[]
  onTextDelta?: (delta: string, accumulatedText: string) => void
  signal?: AbortSignal
  sources?: readonly ChatSource[]
  images?: readonly ChatImageInput[]
  requireComplete?: boolean
}

type StreamEvent = {
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
) {
  if (!response.ok) {
    throw await readJadenseApiError(response, "攻玉对话请求失败")
  }
  if (!response.body) throw new Error("攻玉对话响应缺少数据流。")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let accumulatedText = ""
  let complete = false

  const consumeBlock = (block: string) => {
    const data = block
      .split(/\r?\n/g)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data.trim() === "[DONE]") {
      complete = true
      return
    }
    const event = parseEventData(data)
    if (!event) return
    if (event.type === "abort") throw new Error("对话已中止，未写入 PDF 批注。")
    if (event.type === "error") {
      throw new Error(typeof event.errorText === "string" && event.errorText.trim()
        ? event.errorText.trim()
        : "攻玉对话生成失败，请稍后重试。")
    }
    if (event.type === "finish") {
      if (requireComplete && (event.finishReason === "error" || event.finishReason === "length")) {
        throw new Error("解析输出未完整结束，未写入 PDF 批注。请重试。")
      }
      complete = true
    }
    if (event.type !== "text-delta" || typeof event.delta !== "string") return
    accumulatedText += event.delta
    onTextDelta?.(event.delta, accumulatedText)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      let boundary = pending.search(/\r?\n\r?\n/)
      while (boundary >= 0) {
        const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n"
        consumeBlock(pending.slice(0, boundary))
        pending = pending.slice(boundary + separator.length)
        boundary = pending.search(/\r?\n\r?\n/)
      }
      if (done) break
    }
    if (pending.trim()) consumeBlock(pending)
    // 只有需要写 PDF 的动作要求终止事件；普通对话兼容原有文本流。
    if (requireComplete && !complete) throw new Error("解析连接意外结束，未写入 PDF 批注。请重试。")
    return accumulatedText
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
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
  if (selection?.kind === "model") return { modelId: selection.modelId }
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
    this.selection = options.selection
    this.fetchImpl = options.fetchImpl ?? defaultFetch
  }

  async send(input: TemporaryChatSendInput) {
    if (!this.baseUrl) throw new Error("请先配置攻玉服务器地址。")
    if (!this.token) throw new Error("请先配置包含对话权限的 Zotero 令牌。")
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        temporary: true,
        temporaryConversationId: input.conversationId,
        agentId: "browser-extension",
        clientRequestId: input.clientRequestId,
        messages: temporaryChatMessages(input.messages, input.sources, input.images),
        ...jadenseChatSelectionBody(this.selection),
      }),
      signal: input.signal,
    })
    return consumeTemporaryChatStream(response, input.onTextDelta, input.requireComplete)
  }
}
