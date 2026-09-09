import { uiText } from "@/zotero/ui-preferences"
/**
 * Zotero 本地对话存储层。
 * 上游由 Manager 对话界面调用，下游只写当前 Zotero profile 的 Prefs，绝不读取服务端会话历史。
 */

import { normalizeChatSources, type ChatSource } from "./research-context"
import { normalizeLocalChatImage, type LocalChatImage } from "./image-input"
import { normalizeResearchMessageContext, type ResearchMessageContext } from "./research-presentation"

export const LOCAL_CHAT_PREF_KEY = "extensions.jadenseInZotero.localChatState"

const LOCAL_CHAT_VERSION = 1 as const
const MAX_LOCAL_SESSIONS = 20
const MAX_MESSAGES_PER_SESSION = 200
const MAX_MESSAGE_TEXT_LENGTH = 20_000
const MESSAGE_TRUNCATION_NOTICE = "\n\n【本地消息长度受限，后续内容未保存】"
const MAX_SERIALIZED_LENGTH = 1_000_000

export type LocalChatMessageStatus = "complete" | "streaming" | "failed"

export type LocalChatMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  createdAt: string
  status: LocalChatMessageStatus
  research?: ResearchMessageContext
  image?: LocalChatImage
}

export type LocalChatSession = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: LocalChatMessage[]
  sources: ChatSource[]
}

export type LocalChatState = {
  version: typeof LOCAL_CHAT_VERSION
  activeSessionId: string | null
  sessions: LocalChatSession[]
}

export type LocalChatPreferenceStore = {
  get(key: string): unknown
  set(key: string, value: unknown): void
  clear(key: string): void
}

type NewSessionInput = {
  id?: string
  now?: string
  title?: string
}

type NewMessageInput = Omit<LocalChatMessage, "status"> & {
  status?: LocalChatMessageStatus
}

function emptyState(): LocalChatState {
  return { version: LOCAL_CHAT_VERSION, activeSessionId: null, sessions: [] }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, maxLength = MAX_MESSAGE_TEXT_LENGTH) {
  return typeof value === "string" ? value.slice(0, maxLength) : ""
}

/** 正文截断时在同一长度预算内提示缺失；已保存的正文再次读取不会重复添加尾注。 */
function messageText(value: unknown) {
  if (typeof value !== "string") return ""
  return value.length > MAX_MESSAGE_TEXT_LENGTH
    ? value.slice(0, MAX_MESSAGE_TEXT_LENGTH - MESSAGE_TRUNCATION_NOTICE.length) + MESSAGE_TRUNCATION_NOTICE
    : value
}

function nonEmptyText(value: unknown, maxLength = 200) {
  return text(value, maxLength).trim()
}

function timestamp(value: unknown) {
  const candidate = nonEmptyText(value, 64)
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null
}

function status(value: unknown): LocalChatMessageStatus {
  return value === "streaming" || value === "failed" ? value : "complete"
}

function normalizeMessage(value: unknown): LocalChatMessage | null {
  const row = record(value)
  if (!row) return null
  const id = nonEmptyText(row.id)
  const role = row.role === "user" || row.role === "assistant" ? row.role : null
  const createdAt = timestamp(row.createdAt)
  if (!id || !role || !createdAt) return null
  const research = normalizeResearchMessageContext(row.research)
  const image = normalizeLocalChatImage(row.image)
  return {
    id,
    role,
    text: messageText(row.text),
    createdAt,
    status: status(row.status),
    ...(research ? { research } : {}),
    ...(image ? { image } : {}),
  }
}

function normalizeSession(value: unknown): LocalChatSession | null {
  const row = record(value)
  if (!row) return null
  const id = nonEmptyText(row.id)
  const createdAt = timestamp(row.createdAt)
  const updatedAt = timestamp(row.updatedAt) ?? createdAt
  if (!id || !createdAt || !updatedAt) return null
  const messages = (Array.isArray(row.messages) ? row.messages : [])
    .map(normalizeMessage)
    .filter((message): message is LocalChatMessage => Boolean(message))
    .slice(-MAX_MESSAGES_PER_SESSION)
  return {
    id,
    title: nonEmptyText(row.title, 80) || "新对话",
    createdAt,
    updatedAt,
    messages,
    sources: normalizeChatSources(row.sources),
  }
}

function normalizeState(value: unknown): LocalChatState {
  const row = record(value)
  if (!row || row.version !== LOCAL_CHAT_VERSION) return emptyState()
  const seen = new Set<string>()
  const sessions = (Array.isArray(row.sessions) ? row.sessions : [])
    .map(normalizeSession)
    .filter((session): session is LocalChatSession => {
      if (!session || seen.has(session.id)) return false
      seen.add(session.id)
      return true
    })
    .slice(0, MAX_LOCAL_SESSIONS)
  const requestedActiveId = nonEmptyText(row.activeSessionId)
  return {
    version: LOCAL_CHAT_VERSION,
    activeSessionId: sessions.some((session) => session.id === requestedActiveId)
      ? requestedActiveId
      : sessions[0]?.id ?? null,
    sessions,
  }
}

function createId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.()
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`
}

function fitSerializedState(state: LocalChatState) {
  const next = structuredClone(state)
  let serialized = JSON.stringify(next)
  while (serialized.length > MAX_SERIALIZED_LENGTH) {
    const oldestSession = next.sessions[next.sessions.length - 1]
    if (!oldestSession) return JSON.stringify(emptyState())
    const messageWithResearch = oldestSession.messages.find((message) => message.research)
    const sourceWithText = oldestSession.sources.find((source) => source.text.length > 0)
    if (messageWithResearch) {
      // 页码导航是可选展示数据；超出总预算时先舍弃它，不因此删除原有解析正文。
      delete messageWithResearch.research
    } else if (sourceWithText) {
      // JSON 转义可放大正文；先缩减可重建的来源文本，且每轮都必须实际减小状态。
      sourceWithText.text = sourceWithText.text.slice(0, Math.floor(sourceWithText.text.length / 2))
      const warning = "受本地存储大小限制，来源文本已截断；未保留部分不可视为已读。"
      if (!sourceWithText.warning?.includes(warning)) {
        sourceWithText.warning = [warning, sourceWithText.warning].filter(Boolean).join(" ").slice(0, 600)
      }
    } else if (oldestSession.messages.length > 1) {
      oldestSession.messages.shift()
    } else if (next.sessions.length > 1) {
      next.sessions.pop()
    } else if (oldestSession.messages.length) {
      oldestSession.messages = []
    } else if (oldestSession.sources.length) {
      oldestSession.sources.shift()
    } else {
      return JSON.stringify(emptyState())
    }
    next.activeSessionId = next.sessions.some((session) => session.id === next.activeSessionId)
      ? next.activeSessionId
      : next.sessions[0]?.id ?? null
    serialized = JSON.stringify(next)
  }
  return serialized
}

function saveLocalChatState(preferences: LocalChatPreferenceStore, state: LocalChatState) {
  preferences.set(LOCAL_CHAT_PREF_KEY, fitSerializedState(normalizeState(state)))
}

export function readLocalChatState(preferences: LocalChatPreferenceStore): LocalChatState {
  const raw = preferences.get(LOCAL_CHAT_PREF_KEY)
  if (typeof raw !== "string" || !raw.trim()) return emptyState()
  try {
    return normalizeState(JSON.parse(raw))
  } catch {
    return emptyState()
  }
}

export function createLocalChatSession(
  preferences: LocalChatPreferenceStore,
  input: NewSessionInput = {},
): LocalChatSession {
  const state = readLocalChatState(preferences)
  const now = input.now ?? new Date().toISOString()
  const session: LocalChatSession = {
    id: input.id ?? createId("chat"),
    title: nonEmptyText(input.title, 80) || uiText("新对话", "New conversation"),
    createdAt: now,
    updatedAt: now,
    messages: [],
    sources: [],
  }
  state.sessions = [session, ...state.sessions.filter((item) => item.id !== session.id)]
    .slice(0, MAX_LOCAL_SESSIONS)
  state.activeSessionId = session.id
  saveLocalChatState(preferences, state)
  return session
}

export function selectLocalChatSession(preferences: LocalChatPreferenceStore, sessionId: string) {
  const state = readLocalChatState(preferences)
  if (!state.sessions.some((session) => session.id === sessionId)) return state
  state.activeSessionId = sessionId
  saveLocalChatState(preferences, state)
  return state
}

export function deleteLocalChatSession(preferences: LocalChatPreferenceStore, sessionId: string) {
  const state = readLocalChatState(preferences)
  state.sessions = state.sessions.filter((session) => session.id !== sessionId)
  if (state.activeSessionId === sessionId) state.activeSessionId = state.sessions[0]?.id ?? null
  saveLocalChatState(preferences, state)
  return state
}

export function renameLocalChatSession(
  preferences: LocalChatPreferenceStore,
  sessionId: string,
  title: string,
) {
  const state = readLocalChatState(preferences)
  const nextTitle = nonEmptyText(title, 80)
  if (!nextTitle) return state
  state.sessions = state.sessions.map((session) => session.id === sessionId
    ? { ...session, title: nextTitle }
    : session)
  saveLocalChatState(preferences, state)
  return state
}

export function appendLocalChatMessage(
  preferences: LocalChatPreferenceStore,
  sessionId: string,
  input: NewMessageInput,
) {
  const state = readLocalChatState(preferences)
  state.sessions = state.sessions.map((session) => {
    if (session.id !== sessionId) return session
    const research = normalizeResearchMessageContext(input.research)
    const image = normalizeLocalChatImage(input.image)
    const message: LocalChatMessage = {
      id: input.id,
      role: input.role,
      text: messageText(input.text),
      createdAt: input.createdAt,
      status: input.status ?? "complete",
      ...(research ? { research } : {}),
      ...(image ? { image } : {}),
    }
    return {
      ...session,
      updatedAt: message.createdAt,
      messages: [...session.messages.filter((item) => item.id !== message.id), message]
        .slice(-MAX_MESSAGES_PER_SESSION),
    }
  })
  saveLocalChatState(preferences, state)
  return state
}

export function updateLocalChatMessage(
  preferences: LocalChatPreferenceStore,
  sessionId: string,
  messageId: string,
  patch: Pick<Partial<LocalChatMessage>, "text" | "status" | "research">,
) {
  const state = readLocalChatState(preferences)
  state.sessions = state.sessions.map((session) => session.id === sessionId
    ? {
        ...session,
        messages: session.messages.map((message) => message.id === messageId
          ? {
              ...message,
              ...(patch.text !== undefined ? { text: messageText(patch.text) } : {}),
              ...(patch.status !== undefined ? { status: status(patch.status) } : {}),
              ...(Object.hasOwn(patch, "research") ? { research: normalizeResearchMessageContext(patch.research) } : {}),
            }
          : message),
      }
    : session)
  saveLocalChatState(preferences, state)
  return state
}

/** 关联明确选择的来源；重新关联刷新快照，并优先为新来源保留有限正文预算。 */
export function addLocalChatSources(
  preferences: LocalChatPreferenceStore,
  sessionId: string,
  sources: readonly ChatSource[],
) {
  const state = readLocalChatState(preferences)
  const session = state.sessions.find((item) => item.id === sessionId)
  const additions = normalizeChatSources(sources)
  if (!session || !additions.length) return state
  const addedIds = new Set(additions.map((source) => source.id))
  session.sources = normalizeChatSources([
    ...additions,
    ...session.sources.filter((source) => !addedIds.has(source.id)),
  ])
  session.updatedAt = new Date().toISOString()
  saveLocalChatState(preferences, state)
  return readLocalChatState(preferences)
}

/** 解除本会话的来源关联，不删除 Zotero 条目、附件或已有对话消息。 */
export function removeLocalChatSource(
  preferences: LocalChatPreferenceStore,
  sessionId: string,
  sourceId: string,
) {
  const state = readLocalChatState(preferences)
  const session = state.sessions.find((item) => item.id === sessionId)
  if (!session || !session.sources.some((source) => source.id === sourceId)) return state
  session.sources = session.sources.filter((source) => source.id !== sourceId)
  session.updatedAt = new Date().toISOString()
  saveLocalChatState(preferences, state)
  return readLocalChatState(preferences)
}
