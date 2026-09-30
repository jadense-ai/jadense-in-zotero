/** 文本客户端的可选输出契约；只描述生成格式，不承载权限、身份或工具执行配置。 */
export type ChatResponseFormat = {
  type: 'json_schema'
  name: string
  schema: Record<string, unknown>
  /** 默认保持结构要求；只有显式 text 才允许无原生格式的兼容生成。 */
  fallback?: 'text'
}
export const RESPONSE_FORMAT_HEADER = 'x-jadense-response-format'
export const RESPONSE_FORMAT_PROMPT_HEADER = 'x-jadense-response-format-prompt'

/** 仅投影固定枚举和摘要；不能把服务端附加字段、正文或 Schema 带入本地诊断。 */
export function structuredResponseReceipt(value: unknown, thinking?: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (row.requestedMode === 'json' || row.requestedMode === 'json-schema') result.requestedOutputMode = row.requestedMode
  if (row.effectiveMode === 'native-json-schema' || row.effectiveMode === 'json-object' || row.effectiveMode === 'text') result.effectiveOutputMode = row.effectiveMode
  if (row.fallbackReason === 'compatible-strategy' || row.fallbackReason === 'protocol-rejection') result.outputFallbackReason = row.fallbackReason
  if (typeof row.schemaHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(row.schemaHash)) result.outputSchemaHash = row.schemaHash
  const enabled = thinking && typeof thinking === 'object' ? (thinking as Record<string, unknown>).effectiveThinkingEnabled : undefined
  if (typeof enabled === 'boolean') result.effectiveThinkingMode = enabled ? 'enabled' : 'disabled'
  return result
}

/** 老服务器与 JSON-object Provider 仍收到完整字段契约，不依赖口头字段约定。 */
export function responseFormatInstructions(format?: ChatResponseFormat) {
  return format ? `\n\nReturn one JSON object matching this JSON Schema. No Markdown fences or extra explanation.\n${JSON.stringify(format.schema)}` : ''
}

/** 只增强本次最后一条用户消息，保留调用者原始消息与旧执行指纹。 */
export function responseFormatMessages<T extends { role: string; text: string }>(messages: T[], format?: ChatResponseFormat): T[] {
  if (!format) return messages
  const last = messages.map(message => message.role).lastIndexOf('user')
  return messages.map((message, index) => index === last ? { ...message, text: message.text + responseFormatInstructions(format) } : message)
}
