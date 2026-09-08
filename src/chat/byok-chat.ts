/**
 * BYOK 文本生成客户端：把本地 Chat 投影为三种标准 HTTP/SSE 协议。
 * 上游只提供本地消息与来源，下游直接连接用户配置的 Provider，不经过攻玉服务器。
 */
import { localChatMessages, type TemporaryChatClientOptions, type TemporaryChatSendInput } from "./temporary-chat"
import { redactChatImageDataUrls, type ChatImageInput } from "./image-input"

export type ByokProtocol = "openai-chat-completions" | "anthropic-messages" | "openai-responses"

export type ByokConfig = {
  protocol: ByokProtocol
  baseUrl: string
  apiKey: string
  model: string
  maxOutputTokens: number
}

export type ByokSendInput = TemporaryChatSendInput & {
  /** 仅连接测试使用：已收到合法流但触发探针上限时仍证明连接可用。 */
  acceptTruncated?: boolean
}

export const DEFAULT_BYOK_PROTOCOL: ByokProtocol = "openai-chat-completions"
export const DEFAULT_BYOK_MAX_OUTPUT_TOKENS = 96_000
export const BYOK_TEST_MAX_OUTPUT_TOKENS = 3_000

const DEFAULT_BASE_URLS: Record<ByokProtocol, string> = {
  "openai-chat-completions": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
  "openai-responses": "https://api.openai.com/v1",
}

const ENDPOINT_PATHS: Record<ByokProtocol, string> = {
  "openai-chat-completions": "chat/completions",
  "anthropic-messages": "messages",
  "openai-responses": "responses",
}

export function defaultByokBaseUrl(protocol: ByokProtocol) {
  return DEFAULT_BASE_URLS[protocol]
}

export function defaultByokConfig(): ByokConfig {
  return {
    protocol: DEFAULT_BYOK_PROTOCOL,
    baseUrl: defaultByokBaseUrl(DEFAULT_BYOK_PROTOCOL),
    apiKey: "",
    model: "",
    maxOutputTokens: DEFAULT_BYOK_MAX_OUTPUT_TOKENS,
  }
}

export function isByokProtocol(value: unknown): value is ByokProtocol {
  return value === "openai-chat-completions" || value === "anthropic-messages" || value === "openai-responses"
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/g, "")
}

export function byokEndpoint(protocol: ByokProtocol, baseUrl: string) {
  return `${normalizeBaseUrl(baseUrl)}/${ENDPOINT_PATHS[protocol]}`
}

/** 只拒绝会改变凭据目标、授权或计费请求有效性的配置。 */
export function validateByokConfig(input: ByokConfig): ByokConfig {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error("请输入有效的 BYOK API Base URL。")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("BYOK API Base URL 仅支持 HTTP 或 HTTPS。")
  }
  const apiKey = input.apiKey.trim()
  if (!apiKey) throw new Error("请填写 BYOK API Key。")
  const model = input.model.trim()
  if (!model) throw new Error("请填写 BYOK 模型名称。")
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    throw new Error("最大输出 token 必须是正整数。")
  }
  return { protocol: input.protocol, baseUrl, apiKey, model, maxOutputTokens: input.maxOutputTokens }
}

export function byokConfigurationIssue(input: ByokConfig) {
  try {
    validateByokConfig(input)
    return ""
  } catch (error) {
    return error instanceof Error ? error.message : "BYOK 配置不完整。"
  }
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? value as JsonObject : null
}

function providerErrorMessage(value: unknown) {
  const row = object(value)
  const error = object(row?.error)
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim()
  if (typeof row?.message === "string" && row.message.trim()) return row.message.trim()
  return ""
}

function redactedError(message: string, apiKey: string, fallback: string) {
  const safe = redactChatImageDataUrls((message || fallback).replaceAll(apiKey, "[REDACTED]")).slice(0, 800)
  return new Error(safe)
}

async function responseError(response: Response, apiKey: string) {
  let message = ""
  try {
    message = providerErrorMessage(JSON.parse(await response.text()))
  } catch {
    // 不显示未知原始响应，避免 Provider 回显凭据或私有请求内容。
  }
  return redactedError(message, apiKey, `BYOK 请求失败（${response.status}）。`)
}

export async function consumeByokStream(
  response: Response,
  protocol: ByokProtocol,
  apiKey: string,
  onTextDelta?: (delta: string, accumulatedText: string) => void,
  requireComplete = false,
  acceptTruncated = false,
) {
  if (!response.ok) throw await responseError(response, apiKey)
  if (!response.body) throw new Error("BYOK 响应缺少数据流。")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let accumulatedText = ""
  let complete = false

  const incompleteError = (kind: "truncated" | "eof") => new Error(requireComplete
    ? kind === "truncated"
      ? "BYOK 输出未完整结束，未写入 PDF 批注。请重试。"
      : "BYOK 连接意外结束，未写入 PDF 批注。请重试。"
    : kind === "truncated"
      ? "BYOK 输出因 Provider 限制被截断。请提高输出上限后重试。"
      : "BYOK 连接在成功结束事件前意外中断。请重试。")

  const append = (delta: unknown) => {
    if (typeof delta !== "string" || !delta) return
    accumulatedText += delta
    onTextDelta?.(delta, accumulatedText)
  }

  const consumeBlock = (block: string) => {
    const data = block
      .split(/\r?\n/g)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim()
    if (!data) return
    if (data === "[DONE]" && protocol === "openai-chat-completions") {
      complete = true
      return
    }

    let event: JsonObject
    try {
      const parsed = JSON.parse(data)
      if (!object(parsed)) return
      event = parsed as JsonObject
    } catch {
      throw new Error("BYOK Provider 返回了无法解析的流事件。")
    }

    const errorMessage = providerErrorMessage(event)
    if (protocol === "openai-chat-completions") {
      if (event.error) throw redactedError(errorMessage, apiKey, "OpenAI Chat Completion 生成失败。")
      const choices = Array.isArray(event.choices) ? event.choices : []
      for (const choiceValue of choices) {
        const choice = object(choiceValue)
        append(object(choice?.delta)?.content)
        if (typeof choice?.finish_reason === "string") {
          complete = true
          if (choice.finish_reason !== "stop" && !acceptTruncated) throw incompleteError("truncated")
        }
      }
      return
    }

    if (protocol === "anthropic-messages") {
      if (event.type === "error") throw redactedError(errorMessage, apiKey, "Anthropic Messages 生成失败。")
      if (event.type === "content_block_delta") append(object(event.delta)?.text)
      if (event.type === "message_delta") {
        const stopReason = object(event.delta)?.stop_reason
        if (typeof stopReason === "string" && stopReason) {
          complete = true
          if (stopReason !== "end_turn" && stopReason !== "stop_sequence" && !acceptTruncated) throw incompleteError("truncated")
        }
      }
      if (event.type === "message_stop") complete = true
      return
    }

    if (event.type === "error" || event.type === "response.failed") {
      const nested = providerErrorMessage(event.response)
      throw redactedError(errorMessage || nested, apiKey, "OpenAI Responses 生成失败。")
    }
    if (event.type === "response.output_text.delta") append(event.delta)
    if (event.type === "response.completed") complete = true
    if (event.type === "response.incomplete") {
      complete = true
      if (!acceptTruncated) throw incompleteError("truncated")
    }
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
    if (!complete) throw incompleteError("eof")
    return accumulatedText
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (object(error)?.name === "AbortError") throw error
    throw redactedError(error instanceof Error ? error.message : "", apiKey, "BYOK 数据流处理失败。")
  } finally {
    reader.releaseLock()
  }
}

function providerMessages(
  protocol: ByokProtocol,
  messages: ReturnType<typeof localChatMessages>,
  images: readonly ChatImageInput[] = [],
) {
  if (!images.length) return messages
  const lastUser = messages.map((message) => message.role).lastIndexOf("user")
  return messages.map((message, index) => {
    if (index !== lastUser) return message
    if (protocol === "openai-chat-completions") {
      return {
        ...message,
        content: [
          { type: "text", text: message.content },
          ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
        ],
      }
    }
    if (protocol === "anthropic-messages") {
      return {
        ...message,
        content: [
          { type: "text", text: message.content },
          ...images.map((image) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: image.mimeType,
              data: image.dataUrl.replace(/^data:[^,]*,/, ""),
            },
          })),
        ],
      }
    }
    return {
      ...message,
      content: [
        { type: "input_text", text: message.content },
        ...images.map((image) => ({ type: "input_image", image_url: image.dataUrl })),
      ],
    }
  })
}

function request(
  config: ByokConfig,
  messages: ReturnType<typeof localChatMessages>,
  images: readonly ChatImageInput[] = [],
): {
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  const projected = providerMessages(config.protocol, messages, images)
  if (config.protocol === "openai-chat-completions") {
    return {
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: { model: config.model, messages: projected, stream: true, max_completion_tokens: config.maxOutputTokens },
    }
  }
  if (config.protocol === "anthropic-messages") {
    return {
      headers: { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: { model: config.model, messages: projected, stream: true, max_tokens: config.maxOutputTokens },
    }
  }
  return {
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: { model: config.model, input: projected, stream: true, store: false, max_output_tokens: config.maxOutputTokens },
  }
}

export class ByokChatClient {
  private readonly config: ByokConfig
  private readonly fetchImpl: typeof fetch

  constructor(options: { config: ByokConfig; fetchImpl?: TemporaryChatClientOptions["fetchImpl"] }) {
    this.config = validateByokConfig(options.config)
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async send(input: ByokSendInput) {
    const messages = localChatMessages(input.messages, input.sources)
    const outbound = request(this.config, messages, input.images)
    let response: Response
    try {
      response = await this.fetchImpl(byokEndpoint(this.config.protocol, this.config.baseUrl), {
        method: "POST",
        headers: outbound.headers,
        body: JSON.stringify(outbound.body),
        signal: input.signal,
      })
    } catch (error) {
      if (input.signal?.aborted || object(error)?.name === "AbortError") throw error
      throw redactedError(error instanceof Error ? error.message : "", this.config.apiKey, "BYOK 网络请求失败。")
    }
    return consumeByokStream(
      response,
      this.config.protocol,
      this.config.apiKey,
      input.onTextDelta,
      input.requireComplete,
      input.acceptTruncated,
    )
  }
}
