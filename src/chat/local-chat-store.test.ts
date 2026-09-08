/**
 * 本文件验证 Zotero 本地对话状态的持久化契约，确保会话不依赖攻玉服务端历史。
 */
import { describe, expect, it } from "vitest"

import {
  addLocalChatSources,
  appendLocalChatMessage,
  createLocalChatSession,
  deleteLocalChatSession,
  readLocalChatState,
  removeLocalChatSource,
  renameLocalChatSession,
  selectLocalChatSession,
  updateLocalChatMessage,
  type LocalChatPreferenceStore,
} from "./local-chat-store"
import { createQuoteSource, normalizeChatSources } from "./research-context"
import { resolveResearchPage, type ResearchMessageContext } from "./research-presentation"

function preferences(initial?: string): LocalChatPreferenceStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  if (initial !== undefined) values.set("extensions.jadenseInZotero.localChatState", initial)
  return {
    values,
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    clear: (key) => values.delete(key),
  }
}

describe("local Zotero chat store", () => {
  it("creates, appends, updates, and reloads a local session", () => {
    const prefs = preferences()
    const session = createLocalChatSession(prefs, {
      id: "session-1",
      now: "2026-07-12T12:00:00.000Z",
      title: "论文讨论",
    })
    appendLocalChatMessage(prefs, session.id, {
      id: "message-user",
      role: "user",
      text: "这篇论文的主要贡献是什么？",
      createdAt: "2026-07-12T12:00:01.000Z",
    })
    appendLocalChatMessage(prefs, session.id, {
      id: "message-assistant",
      role: "assistant",
      text: "",
      status: "streaming",
      createdAt: "2026-07-12T12:00:02.000Z",
    })
    updateLocalChatMessage(prefs, session.id, "message-assistant", {
      text: "主要贡献包括……",
      status: "complete",
    })

    expect(readLocalChatState(prefs)).toMatchObject({
      activeSessionId: "session-1",
      sessions: [{
        id: "session-1",
        title: "论文讨论",
        messages: [
          { id: "message-user", role: "user" },
          { id: "message-assistant", text: "主要贡献包括……", status: "complete" },
        ],
      }],
    })
  })

  it("recovers from corrupt preference data", () => {
    const prefs = preferences("not-json")
    expect(readLocalChatState(prefs)).toEqual({ version: 1, activeSessionId: null, sessions: [] })
  })

  it("preserves exactly 20,000 message characters without a truncation notice", () => {
    const prefs = preferences()
    const session = createLocalChatSession(prefs, { id: "boundary" })
    const fullText = "原".repeat(20_000)
    const appended = appendLocalChatMessage(prefs, session.id, {
      id: "answer", role: "assistant", text: fullText, status: "streaming", createdAt: "2026-08-31T00:00:00.000Z",
    })
    expect(appended.sessions[0].messages[0].text).toBe(fullText)
    const completed = updateLocalChatMessage(prefs, session.id, "answer", { text: fullText, status: "complete" })
    expect(completed.sessions[0].messages[0].text).toBe(fullText)
    expect(readLocalChatState(prefs).sessions[0].messages[0]).toEqual(completed.sessions[0].messages[0])
  })

  it("keeps the same bounded prefix and explicit omission notice through streaming, completion, and reload", () => {
    const prefs = preferences()
    const session = createLocalChatSession(prefs, { id: "truncated" })
    const firstParagraph = "已保存的解析结果：此处保留首段、原始顺序与可用信息。\n\n"
    const longText = firstParagraph.padEnd(20_001, "正文")
    const appended = appendLocalChatMessage(prefs, session.id, {
      id: "answer", role: "assistant", text: longText, status: "streaming", createdAt: "2026-08-31T00:00:00.000Z",
    })
    const canonicalText = appended.sessions[0].messages[0].text
    expect(canonicalText).toHaveLength(20_000)
    expect(canonicalText.startsWith(firstParagraph)).toBe(true)
    expect(canonicalText.endsWith("\n\n【本地消息长度受限，后续内容未保存】")).toBe(true)
    const streaming = updateLocalChatMessage(prefs, session.id, "answer", { text: longText + "后续流式内容" })
    expect(streaming.sessions[0].messages[0].text).toBe(canonicalText)
    const completed = updateLocalChatMessage(prefs, session.id, "answer", { status: "complete" })
    expect(completed.sessions[0].messages[0]).toMatchObject({ text: canonicalText, status: "complete" })
    const reloaded = readLocalChatState(preferences(String(prefs.values.get("extensions.jadenseInZotero.localChatState"))))
    expect(reloaded.sessions[0].messages[0]).toEqual(completed.sessions[0].messages[0])
    expect(canonicalText.split("本地消息长度受限")).toHaveLength(2)

    // 旧版偏好中的超长正文与新增消息遵循同一规则，不需要更改状态版本或增加字段。
    reloaded.sessions[0].messages[0].text = longText
    const legacy = readLocalChatState(preferences(JSON.stringify(reloaded)))
    expect(legacy.version).toBe(1)
    expect(legacy.sessions[0].messages[0].text).toBe(canonicalText)
  })

  it("selects and deletes sessions without leaving a stale active id", () => {
    const prefs = preferences()
    createLocalChatSession(prefs, { id: "session-1", now: "2026-07-12T12:00:00.000Z" })
    createLocalChatSession(prefs, { id: "session-2", now: "2026-07-12T12:01:00.000Z" })
    selectLocalChatSession(prefs, "session-1")
    deleteLocalChatSession(prefs, "session-1")

    expect(readLocalChatState(prefs)).toMatchObject({
      activeSessionId: "session-2",
      sessions: [{ id: "session-2" }],
    })
  })

  it("renames a session and preserves the renamed title after reload", () => {
    const prefs = preferences()
    createLocalChatSession(prefs, { id: "session-1", now: "2026-07-12T12:00:00.000Z" })

    renameLocalChatSession(prefs, "session-1", "  有界对话标题  ")

    expect(readLocalChatState(prefs).sessions[0]?.title).toBe("有界对话标题")
  })

  it("bounds stored sessions and messages", () => {
    const sessions = Array.from({ length: 25 }, (_, sessionIndex) => ({
      id: `session-${sessionIndex}`,
      title: `会话 ${sessionIndex}`,
      createdAt: "2026-07-12T12:00:00.000Z",
      updatedAt: "2026-07-12T12:00:00.000Z",
      messages: Array.from({ length: 205 }, (_, messageIndex) => ({
        id: `session-${sessionIndex}-message-${messageIndex}`,
        role: "user",
        text: "x",
        status: "complete",
        createdAt: "2026-07-12T12:00:00.000Z",
      })),
    }))
    const prefs = preferences(JSON.stringify({
      version: 1,
      activeSessionId: "session-0",
      sessions,
    }))

    const state = readLocalChatState(prefs)
    expect(state.sessions).toHaveLength(20)
    expect(state.sessions.every((session) => session.messages.length <= 200)).toBe(true)
  })

  it("trims oldest messages until the serialized preference fits its size bound", () => {
    const largeText = "x".repeat(20_000)
    const prefs = preferences(JSON.stringify({
      version: 1,
      activeSessionId: "session-1",
      sessions: [{
        id: "session-1",
        title: "大对话",
        createdAt: "2026-07-12T12:00:00.000Z",
        updatedAt: "2026-07-12T12:00:00.000Z",
        messages: Array.from({ length: 60 }, (_, index) => ({
          id: `message-${index}`,
          role: "user",
          text: largeText,
          status: "complete",
          createdAt: "2026-07-12T12:00:00.000Z",
        })),
      }],
    }))

    selectLocalChatSession(prefs, "session-1")

    const serialized = String(prefs.values.get("extensions.jadenseInZotero.localChatState"))
    expect(serialized.length).toBeLessThanOrEqual(1_000_000)
    expect(readLocalChatState(prefs).sessions[0]?.messages.length).toBeLessThan(60)
  })

  it("reads version-one history without sources and retains additive session fields", () => {
    const prefs = preferences(JSON.stringify({
      version: 1,
      future: true,
      sessions: [{
        id: "legacy",
        createdAt: "2026-08-01T00:00:00.000Z",
        future: { enabled: true },
        messages: [{ id: "old", role: "user", text: "旧对话", createdAt: "2026-08-01T00:00:00.000Z" }],
      }],
    }))
    expect(readLocalChatState(prefs).sessions[0]).toMatchObject({
      id: "legacy", sources: [], messages: [{ id: "old", text: "旧对话" }],
    })
  })

  it("persists, refreshes, and removes sources only in their local session", () => {
    const prefs = preferences()
    createLocalChatSession(prefs, { id: "session-1" })
    createLocalChatSession(prefs, { id: "session-2" })
    const [source] = normalizeChatSources([{
      kind: "file", itemID: 2, libraryID: 1, itemKey: "PAPER001", title: "Paper", text: "old text",
      path: "C:\\private\\paper.pdf", token: "not-stored",
    }])
    addLocalChatSources(prefs, "session-1", [source])
    addLocalChatSources(prefs, "session-1", [{ ...source, text: "new text" }, createQuoteSource(source, { text: "Quote", pageIndex: 4 })])
    const reloaded = readLocalChatState(prefs)
    expect(reloaded.sessions.find((session) => session.id === "session-2")?.sources).toEqual([])
    expect(reloaded.sessions.find((session) => session.id === "session-1")?.sources).toHaveLength(2)
    expect(reloaded.sessions.find((session) => session.id === "session-1")?.sources[0]?.text).toBe("new text")
    expect(JSON.stringify(reloaded)).not.toMatch(/private|not-stored/)

    const result = removeLocalChatSource(prefs, "session-1", source.id)
    expect(result.sessions.find((session) => session.id === "session-1")?.sources).toMatchObject([{ kind: "quote", text: "Quote" }])
    expect(addLocalChatSources(prefs, "missing", [source])).toEqual(readLocalChatState(prefs))
  })

  it("shrinks JSON-escaped source bodies without looping or deleting the conversation", () => {
    const prefs = preferences()
    createLocalChatSession(prefs, { id: "session-1" })
    appendLocalChatMessage(prefs, "session-1", { id: "message", role: "user", text: "保留问题", createdAt: "2026-08-01T00:00:00.000Z" })
    const sources = normalizeChatSources(Array.from({ length: 24 }, (_, index) => ({
      kind: "file", itemID: index + 1, libraryID: 1, itemKey: `PAPER${index}`,
      title: "\u0000".repeat(500), citation: "\u0000".repeat(2_000), text: "\u0000".repeat(60_000),
    })))
    const result = addLocalChatSources(prefs, "session-1", sources)
    const serialized = String(prefs.values.get("extensions.jadenseInZotero.localChatState"))
    expect(serialized.length).toBeLessThanOrEqual(1_000_000)
    expect(result).toEqual(readLocalChatState(prefs))
    expect(result.sessions[0]?.messages).toMatchObject([{ id: "message", text: "保留问题" }])
    expect(result.sessions[0]?.sources).toHaveLength(24)
    expect(result.sessions[0]?.sources.some((source) => source.warning?.includes("本地存储"))).toBe(true)
  })

  it("persists optional research context on append/update and keeps it through ordinary streaming updates", () => {
    const prefs = preferences()
    createLocalChatSession(prefs, { id: "research-session" })
    const context = {
      source: { itemID: 2, libraryID: 1, itemKey: "PDF00002", title: "文献", path: "C:\\private\\paper.pdf", token: "not-saved" },
      pages: [{ pageIndex: 3, pageLabel: "i", href: "javascript:unexpected()" }],
      modelAction: "unexpected",
    }
    appendLocalChatMessage(prefs, "research-session", {
      id: "analysis", role: "assistant", text: "解析内容", status: "streaming", createdAt: "2026-08-31T00:00:00.000Z", research: context,
    })
    updateLocalChatMessage(prefs, "research-session", "analysis", { text: "完整解析内容", status: "complete" })
    const first = readLocalChatState(prefs).sessions[0].messages[0]
    expect(first).toMatchObject({ text: "完整解析内容", research: { source: { itemID: 2 }, pages: [{ pageIndex: 3, pageLabel: "i" }] } })
    expect(JSON.stringify(first.research)).not.toMatch(/private|not-saved|unexpected|href|path|token/)
    expect(resolveResearchPage(first.research, "i")?.pageIndex).toBe(3)
    updateLocalChatMessage(prefs, "research-session", "analysis", { research: { ...context, pages: [{ pageIndex: 8, pageLabel: "S1" }] } })
    expect(resolveResearchPage(readLocalChatState(prefs).sessions[0].messages[0].research, "S1")?.pageIndex).toBe(8)
    updateLocalChatMessage(prefs, "research-session", "analysis", { research: { ...context, pages: [] } })
    expect(readLocalChatState(prefs).sessions[0].messages[0].research).toEqual({ source: first.research?.source, pages: [] })
    updateLocalChatMessage(prefs, "research-session", "analysis", { research: undefined })
    expect(readLocalChatState(prefs).sessions[0].messages[0]).not.toHaveProperty("research")
  })

  it("retains version-one messages when optional research data is absent, corrupt, or ambiguous", () => {
    const research = { source: { itemID: 2, libraryID: 1, itemKey: "PDF00002", title: "文献" }, pages: [{ pageIndex: 0, pageLabel: "1" }, { pageIndex: 9, pageLabel: "1" }] }
    const prefs = preferences(JSON.stringify({
      version: 1,
      sessions: [{ id: "legacy", createdAt: "2026-08-31T00:00:00.000Z", messages: [
        { id: "old", role: "assistant", text: "旧解析文本", createdAt: "2026-08-31T00:00:00.000Z" },
        { id: "bad", role: "assistant", text: "保留损坏元数据的正文", createdAt: "2026-08-31T00:00:00.000Z", research: { source: null, pages: "bad" } },
        { id: "ambiguous", role: "assistant", text: "保留重复页标的解析正文", createdAt: "2026-08-31T00:00:00.000Z", research },
        { id: "empty", role: "assistant", text: "无批注时仍可打开原 PDF", createdAt: "2026-08-31T00:00:00.000Z", research: { ...research, pages: [] } },
      ] }],
    }))
    const state = readLocalChatState(prefs)
    expect(state.version).toBe(1)
    expect(state.sessions[0].messages.map((message) => message.text)).toEqual(["旧解析文本", "保留损坏元数据的正文", "保留重复页标的解析正文", "无批注时仍可打开原 PDF"])
    expect(state.sessions[0].messages.slice(0, 2).every((message) => message.research === undefined)).toBe(true)
    for (const message of state.sessions[0].messages.slice(2)) {
      expect(message.research).toEqual({ source: research.source, pages: [] })
      expect(resolveResearchPage(message.research, "1")).toBeUndefined()
    }
    selectLocalChatSession(prefs, "legacy")
    expect(readLocalChatState(prefs)).toEqual(state)
  })

  it("drops optional navigation before message bodies when their JSON exceeds the storage budget", () => {
    const research: ResearchMessageContext = {
      source: { itemID: 2, libraryID: 1, itemKey: "PDF00002", title: "\u0000".repeat(500) },
      pages: Array.from({ length: 32 }, (_, index) => ({ pageIndex: index, pageLabel: "\u0000".repeat(75) + index })),
    }
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: `message-${index}`, role: "assistant", text: `解析正文 ${index}`, createdAt: "2026-08-31T00:00:00.000Z", research,
    }))
    const prefs = preferences(JSON.stringify({ version: 1, sessions: [{ id: "research-session", createdAt: "2026-08-31T00:00:00.000Z", messages }] }))
    selectLocalChatSession(prefs, "research-session")
    expect(String(prefs.values.get("extensions.jadenseInZotero.localChatState")).length).toBeLessThanOrEqual(1_000_000)
    const reloaded = readLocalChatState(prefs).sessions[0].messages
    expect(reloaded.map((message) => message.text)).toEqual(messages.map((message) => message.text))
    expect(reloaded.filter((message) => message.research).length).toBeLessThan(messages.length)
  })
})
