import { describe, expect, it, vi } from "vitest"

import { appendPaperAnalysisRecord, readPaperAnalysisHistory } from "@/chat/paper-analysis-history"
import type { PdfAnalysisSnapshot, SavedAnalysisAnnotations } from "./reader-tools"
import type { ZoteroLike } from "./runtime"
import {
  PAPER_ANALYSIS_MISSING_SUMMARY,
  paperAnalysisModelState,
  runIndependentPaperAnalysis,
} from "./paper-analysis-runner"

function fakeZotero(options: { token?: string; analysisModel?: unknown; byok?: unknown } = {}) {
  const values = new Map<string, unknown>()
  if (options.token) values.set("extensions.jadenseInZotero.token", options.token)
  if (options.analysisModel !== undefined) values.set("extensions.jadenseInZotero.paperAnalysisModel", JSON.stringify(options.analysisModel))
  if (options.byok !== undefined) values.set("extensions.jadenseInZotero.byokConfig", JSON.stringify(options.byok))
  const zotero: ZoteroLike = {
    Prefs: {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
      clear: (key) => values.delete(key),
    },
  }
  return { zotero, values }
}

function snapshot(): PdfAnalysisSnapshot {
  return {
    itemID: 42,
    libraryID: 1,
    itemKey: "PDF00042",
    title: "A Useful Paper",
    metadata: {
      title: "A Useful Paper",
      authors: ["Ada Lovelace", "林徽因"],
      date: "2026-02-03",
      year: "2026",
      publicationTitle: "Journal of Useful Results",
      doi: "10.1000/useful",
    },
    passages: [{
      id: "p0-s0",
      text: "Evidence supports the result.",
      pageIndex: 0,
      pageLabel: "1",
      position: { pageIndex: 0, rects: [[1, 2, 3, 4]] },
      sortIndex: "00000|00000|00000",
    }],
    coverage: { pagesRead: 1, totalPages: 1, limited: false, pageNumbers: [1], warnings: [] },
  }
}

const emptySaved = (): SavedAnalysisAnnotations => ({ created: 0, skipped: 0, failed: 0, unprocessed: 0, warnings: [] })

function structured(summary = "总结") {
  return JSON.stringify({
    summary,
    sections: [{ category: "claim", summary: "核心论点" }],
    annotations: [{ passageId: "p0-s0", category: "claim", comment: "关键证据作用" }],
  })
}

describe("independent paper analysis", () => {
  it.each([{ kind: "default" }, { kind: "model", modelId: "analysis-model" }, { kind: "route", routeTier: "premium" }] as const)("dispatches the exact Jadense analysis selection $kind", async selection => {
    const { zotero } = fakeZotero({ token: "synthetic-token", analysisModel: { route: "jadense", selection } })
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      `data: ${JSON.stringify({ type: "text-delta", delta: structured() })}\n\ndata: {"type":"finish"}\n\n`, { status: 200 }))
    await runIndependentPaperAnalysis({ zotero, itemID: 42, fetchImpl, signal: new AbortController().signal,
      services: { readPdf: async () => snapshot(), saveAnnotations: async () => emptySaved() } })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.clientContext).toEqual({ version: expect.any(String), feature: "analysis" })
    expect(body).toMatchObject(selection.kind === "route" ? { routeTier: "premium" } : { modelId: selection.kind === "model" ? "analysis-model" : "deepseek-v4-flash-vision-exp" })
    expect(body).not.toHaveProperty(selection.kind === "route" ? "modelId" : "routeTier")
  })

  it("backs up readable analysis before writing annotations and updates the same record without touching Chat", async () => {
    const { zotero, values } = fakeZotero({ token: "jdx_token" })
    values.set("extensions.jadenseInZotero.localChatState", "unchanged-chat")
    const order: string[] = []
    const send = vi.fn(async (request) => {
      order.push("send")
      expect(request.messages).toHaveLength(1)
      expect(request.sources).toEqual([])
      expect(request.requireComplete).toBe(true)
      expect(request.messages[0]?.text).toContain("summary 是必填的独立顶层字符串")
      expect(request.messages[0]?.text).toContain("A Useful Paper")
      return structured("结构化总结")
    })
    const saveAnnotations = vi.fn(async () => {
      order.push("annotations")
      return { ...emptySaved(), created: 1 }
    })

    const result = await runIndependentPaperAnalysis({
      zotero,
      itemID: 42,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: new AbortController().signal,
      recordID: "analysis-1",
      createdAt: "2026-09-04T01:02:03.000Z",
      services: {
        readPdf: async () => snapshot(),
        send,
        appendHistory: (store, record) => {
          order.push("history")
          store.set("extensions.jadenseInZotero.paperAnalysisHistory", JSON.stringify({ version: 1, records: [record] }))
          return record
        },
        saveAnnotations,
      },
    })

    expect(order).toEqual(["send", "history", "annotations", "history"])
    expect(result).toMatchObject({ historySaved: true, annotations: { created: 1 } })
    expect(values.get("extensions.jadenseInZotero.localChatState")).toBe("unchanged-chat")
    const stored = readPaperAnalysisHistory(zotero.Prefs!).records[0]
    expect(stored).toEqual(expect.objectContaining({
      id: "analysis-1",
      summary: "结构化总结",
      source: expect.objectContaining({
        itemID: 42,
        libraryID: 1,
        itemKey: "PDF00042",
        title: "A Useful Paper",
        authors: ["Ada Lovelace", "林徽因"],
        publicationTitle: "Journal of Useful Results",
        doi: "10.1000/useful",
      }),
    }))
    expect(JSON.stringify(stored)).not.toContain("annotations")
    expect(JSON.stringify(stored)).not.toContain("sections")
    expect(JSON.stringify(stored)).not.toContain("model")
    expect(stored?.notes).toContain("关键证据作用")
    expect(stored?.notes).toContain("新增 1 条")
    expect(readPaperAnalysisHistory(zotero.Prefs!).records).toHaveLength(1)
  })

  it("uses the local placeholder when a valid structured response omits summary", async () => {
    const { zotero } = fakeZotero({ token: "jdx_token" })
    const result = await runIndependentPaperAnalysis({
      zotero,
      itemID: 42,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: new AbortController().signal,
      services: {
        readPdf: async () => snapshot(),
        send: async () => JSON.stringify({ sections: [{ category: "claim", summary: "仍可结构化" }], annotations: [] }),
        saveAnnotations: async () => emptySaved(),
      },
    })
    expect(result.record.summary).toBe(PAPER_ANALYSIS_MISSING_SUMMARY)
    expect(readPaperAnalysisHistory(zotero.Prefs!).records[0]?.summary).toBe(PAPER_ANALYSIS_MISSING_SUMMARY)
  })

  it("continues annotation writing after history persistence fails", async () => {
    const { zotero } = fakeZotero({ token: "jdx_token" })
    const saveAnnotations = vi.fn(async () => ({ ...emptySaved(), created: 1 }))
    const result = await runIndependentPaperAnalysis({
      zotero,
      itemID: 42,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: new AbortController().signal,
      services: {
        readPdf: async () => snapshot(),
        send: async () => structured(),
        appendHistory: () => { throw new Error("preference unavailable") },
        saveAnnotations,
      },
    })
    expect(result.historySaved).toBe(false)
    expect(result.historyError).toContain("仍会继续写入")
    expect(saveAnnotations).toHaveBeenCalledOnce()
  })

  it("keeps a saved history record when annotation writing fails", async () => {
    const { zotero } = fakeZotero({ token: "jdx_token" })
    const result = await runIndependentPaperAnalysis({
      zotero,
      itemID: 42,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: new AbortController().signal,
      services: {
        readPdf: async () => snapshot(),
        send: async () => structured("保留的总结"),
        saveAnnotations: async () => { throw new Error("native write failed") },
      },
    })
    expect(result.annotationError).toContain("原生批注未能全部写入")
    expect(readPaperAnalysisHistory(zotero.Prefs!).records[0]?.summary).toBe("保留的总结")
    expect(readPaperAnalysisHistory(zotero.Prefs!).records[0]).toMatchObject({
      notes: expect.stringContaining("关键证据作用"),
      warnings: expect.arrayContaining([expect.stringContaining("原生批注未能全部写入")]),
    })
  })

  it("retains the first backup if saving the final write report fails", async () => {
    const { zotero } = fakeZotero({ token: "jdx_token" })
    let saves = 0
    const saveAnnotations = vi.fn(async () => ({ ...emptySaved(), created: 1 }))
    const result = await runIndependentPaperAnalysis({
      zotero, itemID: 42, fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: new AbortController().signal,
      services: {
        readPdf: async () => snapshot(), send: async () => structured(), saveAnnotations,
        appendHistory: (store, record) => {
          if (++saves > 1) throw new Error("storage became unavailable")
          return appendPaperAnalysisRecord(store, record)
        },
      },
    })
    const stored = readPaperAnalysisHistory(zotero.Prefs!).records[0]
    expect(result.historySaved).toBe(true)
    expect(result.historyError).toContain("状态未能更新")
    expect(result.record.notes).toContain("新增 1 条")
    expect(stored.notes).toContain("关键证据作用")
    expect(stored.warnings?.join(" ")).toContain("尚未确认")
    expect(saveAnnotations).toHaveBeenCalledOnce()
  })

  it("preserves output when cancellation arrives just as the completed response returns", async () => {
    const { zotero } = fakeZotero({ token: "jdx_token" })
    const abort = new AbortController()
    const saveAnnotations = vi.fn()
    const result = await runIndependentPaperAnalysis({
      zotero, itemID: 42, fetchImpl: vi.fn() as unknown as typeof fetch, signal: abort.signal,
      services: {
        readPdf: async () => snapshot(),
        send: async () => { abort.abort(); return structured() }, saveAnnotations,
      },
    })
    expect(result.record.warnings?.join(" ")).toContain("生成已停止")
    expect(readPaperAnalysisHistory(zotero.Prefs!).records[0]?.notes).toContain("关键证据作用")
    expect(saveAnnotations).not.toHaveBeenCalled()
  })

  it("preserves a completed unstructured response as readable history without native writes", async () => {
    const { zotero } = fakeZotero({ token: "jdx_token" })
    const saveAnnotations = vi.fn()
    const result = await runIndependentPaperAnalysis({
      zotero, itemID: 42, fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: new AbortController().signal,
      services: { readPdf: async () => snapshot(), send: async () => "研究方法：先检索，再核对证据。", saveAnnotations },
    })
    expect(result.historySaved).toBe(true)
    expect(readPaperAnalysisHistory(zotero.Prefs!).records[0]).toMatchObject({
      notes: expect.stringContaining("研究方法：先检索，再核对证据。"),
    })
    expect(saveAnnotations).not.toHaveBeenCalled()
  })

  it.each([
    ["truncated", async () => { throw new Error("解析输出未完整结束") }],
  ])("does not persist or annotate a %s response", async (_kind, send) => {
    const { zotero } = fakeZotero({ token: "jdx_token" })
    const appendHistory = vi.fn()
    const saveAnnotations = vi.fn()
    await expect(runIndependentPaperAnalysis({
      zotero,
      itemID: 42,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: new AbortController().signal,
      services: { readPdf: async () => snapshot(), send, appendHistory, saveAnnotations },
    })).rejects.toThrow()
    expect(appendHistory).not.toHaveBeenCalled()
    expect(saveAnnotations).not.toHaveBeenCalled()
  })

  it("does not read or dispatch when the explicitly selected BYOK model is stale", async () => {
    const { zotero } = fakeZotero({
      analysisModel: { route: "byok", modelId: "deleted-model" },
      byok: {
        version: 2,
        activeProviderId: "provider-1",
        activeModelId: "ready-model",
        providers: [{ id: "provider-1", name: "Provider", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", apiKey: "key" }],
        models: [{ id: "ready-model", providerId: "provider-1", name: "Ready", model: "ready", maxOutputTokens: 4000 }],
      },
    })
    const readPdf = vi.fn()
    const send = vi.fn()
    expect(paperAnalysisModelState(zotero)).toMatchObject({ ready: false, selection: { route: "byok", modelId: "deleted-model" } })
    await expect(runIndependentPaperAnalysis({
      zotero,
      itemID: 42,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: new AbortController().signal,
      services: { readPdf, send },
    })).rejects.toThrow("已选择的 BYOK 模型已删除")
    expect(readPdf).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("cancellation before a complete response leaves both history and annotations unchanged", async () => {
    const { zotero } = fakeZotero({ token: "jdx_token" })
    const controller = new AbortController()
    const appendHistory = vi.fn()
    const saveAnnotations = vi.fn()
    await expect(runIndependentPaperAnalysis({
      zotero,
      itemID: 42,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      signal: controller.signal,
      services: {
        readPdf: async () => snapshot(),
        send: async () => {
          controller.abort()
          const error = new Error("stopped")
          error.name = "AbortError"
          throw error
        },
        appendHistory,
        saveAnnotations,
      },
    })).rejects.toMatchObject({ name: "AbortError" })
    expect(appendHistory).not.toHaveBeenCalled()
    expect(saveAnnotations).not.toHaveBeenCalled()
  })
})

// 模拟能力端点与本地磁盘，保留真实新版客户端的 SSE/终态判断；恢复幂等由专用测试覆盖。
vi.mock('@/chat/reliable-temporary-chat', async () => {
  const actual = await vi.importActual<typeof import('@/chat/reliable-temporary-chat')>('@/chat/reliable-temporary-chat')
  return { ReliableTemporaryChatClient: class extends actual.ReliableTemporaryChatClient {
    constructor(options: ConstructorParameters<typeof actual.ReliableTemporaryChatClient>[0]) {
      super({ ...options, fetchImpl: async (url, init) => {
        if (init?.method === 'HEAD') return new Response(null, { headers: { 'x-jadense-temporary-protocol': '1' } })
        const response = await options.fetchImpl!(url, init)
        response.headers.set('x-jadense-temporary-protocol', '1')
        if (response.ok) response.headers.set('content-type', 'text/event-stream')
        return response
      } }, { list: async () => [], save: async () => {} } as never)
    }
  } }
})
vi.mock('@/chat/reliable-byok-chat', async () => {
  const actual = await vi.importActual<typeof import('@/chat/reliable-byok-chat')>('@/chat/reliable-byok-chat')
  return { ReliableByokChatClient: class extends actual.ReliableByokChatClient {
    constructor(options: ConstructorParameters<typeof actual.ReliableByokChatClient>[0]) { super(options, { list: async () => [], save: async () => {} } as never) }
  } }
})