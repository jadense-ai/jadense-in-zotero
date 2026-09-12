/**
 * 验证真实 Chat 客户端到文献解析历史的恢复链路。
 * 使用本地 SSE 代替 Provider，仅替换 PDF 读取和原生写入，确保协议失败不能变成批注写入。
 */
import { describe, expect, it, vi } from "vitest"

import { readPaperAnalysisHistory } from "@/chat/paper-analysis-history"
import { runIndependentPaperAnalysis } from "./paper-analysis-runner"
import type { PdfAnalysisSnapshot, SavedAnalysisAnnotations } from "./reader-tools"
import type { ZoteroLike } from "./runtime"
import { AUTO_FOLLOW_CHAT_MODEL_PREF_KEY } from "./ai-settings"

/** 两条请求通道均使用测试偏好，避免读取真实 Zotero 配置或凭据。 */
function fakeZotero(route: "jadense" | "byok"): ZoteroLike {
  const values = new Map<string, unknown>([
    [AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, false],
    ["extensions.jadenseInZotero.token", "fixture-token"],
    ["extensions.jadenseInZotero.baseUrl", "https://jadense.test"],
    ["extensions.jadenseInZotero.paperAnalysisModel", JSON.stringify(route === "jadense"
      ? { route, selection: { kind: "model", modelId: "fixture-model" } }
      : { route, modelId: "fixture-model" })],
    ["extensions.jadenseInZotero.byokConfig", JSON.stringify({
      version: 2,
      activeProviderId: "fixture-provider",
      activeModelId: "fixture-model",
      providers: [{
        id: "fixture-provider", name: "Fixture", protocol: "openai-chat-completions",
        baseUrl: "https://provider.test/v1", apiKey: "fixture-key",
      }],
      models: [{
        id: "fixture-model", providerId: "fixture-provider", name: "Fixture",
        model: "fixture-model", maxOutputTokens: 4000,
      }],
    })],
  ])
  return {
    Prefs: {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
      clear: (key) => values.delete(key),
    },
  }
}

/** 原句坐标由本地 PDF 快照提供，AI 仅引用其 ID。 */
function snapshot(): PdfAnalysisSnapshot {
  return {
    itemID: 42, libraryID: 1, itemKey: "PDF00042", title: "Recovery Fixture",
    metadata: { title: "Recovery Fixture", authors: ["Ada Lovelace"] },
    passages: [{
      id: "p0-s0", text: "Evidence supports the result.", pageIndex: 0, pageLabel: "1",
      position: { pageIndex: 0, rects: [[1, 2, 3, 4]] }, sortIndex: "00000|00000|00000",
    }],
    coverage: { pagesRead: 1, totalPages: 1, limited: false, pageNumbers: [1], warnings: [] },
  }
}

const structured = JSON.stringify({
  summary: "保留的总结",
  annotations: [{ passageId: "p0-s0", category: "claim", comment: "不能因流失败丢失的关键笔记" }],
})
const saved: SavedAnalysisAnnotations = { created: 1, skipped: 0, failed: 0, unprocessed: 0, warnings: [] }

describe.each(["jadense", "byok"] as const)("paper analysis recovery through %s SSE", (route) => {
  it.each(["eof", "length", "error"] as const)("keeps valid notes after %s without authorizing native writes", async (failure) => {
    const zotero = fakeZotero(route)
    const delta = route === "jadense"
      ? { type: "text-delta", delta: structured }
      : { choices: [{ delta: { content: structured } }] }
    const ending = failure === "eof" ? "" : `data: ${JSON.stringify(route === "jadense"
      ? failure === "length" ? { type: "finish", finishReason: "length" } : { type: "error", errorText: "fixture failure" }
      : failure === "length" ? { choices: [{ delta: {}, finish_reason: "length" }] } : { error: { message: "fixture failure" } })}\n\ndata: [DONE]\n\n`
    const response = new Response(`data: ${JSON.stringify(delta)}\n\n${ending}`)
    const fetchImpl = vi.fn(async () => response)
    const saveAnnotations = vi.fn(async () => saved)

    const result = await runIndependentPaperAnalysis({
      zotero, itemID: 42, fetchImpl, signal: new AbortController().signal,
      services: { readPdf: async () => snapshot(), saveAnnotations },
    })

    expect(result.historySaved).toBe(true)
    const records = readPaperAnalysisHistory(zotero.Prefs!).records
    expect(records).toHaveLength(1)
    expect(records[0]?.summary).toBe("保留的总结")
    expect(records[0]?.notes).toContain("不能因流失败丢失的关键笔记")
    expect(records[0]?.warnings?.join(" ")).toContain("未完整结束")
    expect(records[0]?.warnings?.join(" ")).toContain("未写入 PDF 批注")
    expect(saveAnnotations).not.toHaveBeenCalled()
    expect(result.annotations.created).toBe(0)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it("repairs malformed model JSON only after a successful protocol finish", async () => {
    const zotero = fakeZotero(route)
    const malformed = '{"summary":"保留的总结","annotations":[{"passageId":"p0-s0","category":"claim","comment":"完整且可定位的笔记"},]}'
    expect(() => JSON.parse(malformed)).toThrow()
    const delta = route === "jadense"
      ? { type: "text-delta", delta: malformed }
      : { choices: [{ delta: { content: malformed } }] }
    const finish = route === "jadense"
      ? { type: "finish", finishReason: "stop" }
      : { choices: [{ delta: {}, finish_reason: "stop" }] }
    const fetchImpl = vi.fn(async () => new Response(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`))
    const saveAnnotations = vi.fn(async () => saved)

    const result = await runIndependentPaperAnalysis({
      zotero, itemID: 42, fetchImpl, signal: new AbortController().signal,
      services: { readPdf: async () => snapshot(), saveAnnotations },
    })

    expect(result.annotations.created).toBe(1)
    expect(saveAnnotations).toHaveBeenCalledOnce()
    expect(saveAnnotations).toHaveBeenCalledWith(zotero, snapshot(), [
      expect.objectContaining({ passageId: "p0-s0", pageIndex: 0, comment: "完整且可定位的笔记" }),
    ], { signal: expect.any(AbortSignal) })
    const record = readPaperAnalysisHistory(zotero.Prefs!).records[0]
    expect(record?.notes).toContain("完整且可定位的笔记")
    expect(record?.warnings?.join(" ")).toContain("修复")
    expect(record?.warnings?.join(" ")).not.toContain("未完整结束")
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it("retains text received before cancellation and prevents native writes", async () => {
    const zotero = fakeZotero(route)
    const abort = new AbortController()
    const delta = route === "jadense"
      ? { type: "text-delta", delta: structured }
      : { choices: [{ delta: { content: structured } }] }
    let response: Response | undefined
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(abort.signal)
      response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta)}\n\n`))
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true })
        },
        // 首个块被取走后才取消，让真实客户端先交付已接收的文字。
        pull() { abort.abort() },
      }))
      return response
    })
    const saveAnnotations = vi.fn(async () => saved)

    const result = await runIndependentPaperAnalysis({
      zotero, itemID: 42, fetchImpl, signal: abort.signal,
      services: { readPdf: async () => snapshot(), saveAnnotations },
    })

    expect(abort.signal.aborted).toBe(true)
    expect(result.historySaved).toBe(true)
    const record = readPaperAnalysisHistory(zotero.Prefs!).records[0]
    expect(record?.notes).toContain("不能因流失败丢失的关键笔记")
    expect(record?.warnings?.join(" ")).toContain("生成已停止")
    expect(saveAnnotations).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(response?.body?.locked).toBe(false)
  })

  it("does not invent a history record when the stream fails before any text", async () => {
    const zotero = fakeZotero(route)
    const error = route === "jadense"
      ? { type: "error", errorText: "fixture failure before text" }
      : { error: { message: "fixture failure before text" } }
    const fetchImpl = vi.fn(async () => new Response(`data: ${JSON.stringify(error)}\n\n`))
    const saveAnnotations = vi.fn(async () => saved)

    await expect(runIndependentPaperAnalysis({
      zotero, itemID: 42, fetchImpl, signal: new AbortController().signal,
      services: { readPdf: async () => snapshot(), saveAnnotations },
    })).rejects.toThrow("fixture failure before text")

    expect(readPaperAnalysisHistory(zotero.Prefs!).records).toEqual([])
    expect(saveAnnotations).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledOnce()
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
