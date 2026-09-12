import { beforeEach, describe, expect, it, vi } from "vitest"
import { initializeUiLocale } from "./ui-preferences"
beforeEach(() => initializeUiLocale({ locale: "zh-CN" }))

import { TRANSLATION_HISTORY_PREF_KEY, readTranslationHistory } from "@/chat/translation-history"
import { defaultByokConfig } from "@/chat/byok-chat"
import { AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, saveAiRoute, saveByokConfig, saveFeatureModelSelection } from "./ai-settings"
import { translateReaderSelection } from "./reader-translation"
import { ARTICLE_TRANSLATION_LANGUAGES_PREF_PREFIX, readArticleTranslationLanguages, writeArticleTranslationLanguages } from "./translation-settings"
import type { ZoteroLike } from "./runtime"

function zoteroWithPreferences(values: Map<string, unknown>, items?: ZoteroLike["Items"]): ZoteroLike {
  if (!values.has(AUTO_FOLLOW_CHAT_MODEL_PREF_KEY)) values.set(AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, false)
  return {
    Prefs: {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value),
      clear: (key) => values.delete(key),
    },
    ...(items ? { Items: items } : {}),
  }
}

function readerSourceItems(): NonNullable<ZoteroLike["Items"]> {
  const parent = {
    id: 3, key: "PAPER003", libraryID: 2,
    getField: (field: string) => field === "title" ? "Paper title" : "",
    getCreators: () => [{ firstName: "Ada", lastName: "Lovelace" }],
  }
  const attachment = {
    id: 17, key: "PDFKEY17", libraryID: 2, parentID: 3, itemType: "attachment",
    attachmentContentType: "application/pdf",
    getField: (field: string) => field === "title" ? "PDF" : "",
    isAttachment: () => true,
    isPDFAttachment: () => true,
  }
  return { get: (itemID) => Number(itemID) === 17 ? attachment : Number(itemID) === 3 ? parent : undefined }
}

describe("reader translation runtime", () => {
  it("uses the UI language for local validation without sending a translation request", async () => {
    initializeUiLocale({ locale: "en-US" })
    const fetchImpl = vi.fn()
    await expect(translateReaderSelection({
      zotero: {}, fetchImpl, action: { kind: "translate", itemID: 17, text: " " },
    })).rejects.toThrow("Select the text to translate first.")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each(["AI_MODEL_SELECTION_PLAN_REQUIRED", "AI_USER_ROUTE_PLAN_REQUIRED"])("explains %s from the sending endpoint without retries or catalog dependency", async code => {
    const values = new Map<string, unknown>([["extensions.jadenseInZotero.token", "synthetic-token"]])
    const zotero = zoteroWithPreferences(values, readerSourceItems())
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ code, error: "Request rejected" }), { status: 403 }))
    await expect(translateReaderSelection({ zotero, fetchImpl, action: { kind: "translate", itemID: 17, text: "Sentence" } })).rejects.toThrow("当前订阅不支持所选模型或路由。请在「设置 → 功能配置」更换可用模型")
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/chat")
    expect(values.has(TRANSLATION_HISTORY_PREF_KEY)).toBe(false)
  })

  it.each([{ kind: "model", modelId: "translation-model" }, { kind: "route", routeTier: "standard" }] as const)("dispatches its own Jadense $kind without inheriting Chat", async selection => {
    const values = new Map<string, unknown>([["extensions.jadenseInZotero.token", "synthetic-token"]])
    const zotero = zoteroWithPreferences(values, readerSourceItems())
    saveFeatureModelSelection(zotero, "chat", { route: "byok", modelId: "missing-chat-model" })
    saveFeatureModelSelection(zotero, "translation", { route: "jadense", selection })
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      'data: {"type":"text-delta","delta":"译文"}\n\ndata: {"type":"finish"}\n\n', { status: 200 }))
    await translateReaderSelection({ zotero, fetchImpl, action: { kind: "translate", itemID: 17, text: "Sentence" } })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body).toMatchObject(selection.kind === "model" ? { modelId: "translation-model" } : { routeTier: "standard" })
    expect(body).not.toHaveProperty(selection.kind === "model" ? "routeTier" : "modelId")
  })

  it("does not dispatch a deleted translation model or fall back to the working Chat model", async () => {
    const zotero = zoteroWithPreferences(new Map([["extensions.jadenseInZotero.token", "synthetic-token"]]), readerSourceItems())
    saveFeatureModelSelection(zotero, "translation", { route: "byok", modelId: "deleted" })
    const fetchImpl = vi.fn()
    await expect(translateReaderSelection({ zotero, fetchImpl, action: { kind: "translate", itemID: 17, text: "Sentence" } })).rejects.toThrow("已删除或配置不完整")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("uses an isolated AI request and archives source/result without creating chat history", async () => {
    const values = new Map<string, unknown>([
      ["extensions.jadenseInZotero.token", "test-token"],
      ["extensions.jadenseInZotero.baseUrl", "https://jadense.test"],
    ])
    const zotero = zoteroWithPreferences(values, readerSourceItems())
    const fetchImpl = vi.fn(async () => new Response([
      'data: {"type":"text-delta","delta":"译文"}',
      'data: {"type":"finish"}',
      "",
    ].join("\n\n"), { status: 200 })) as unknown as typeof fetch
    const onTextDelta = vi.fn()

    const record = await translateReaderSelection({
      zotero,
      action: { kind: "translate", itemID: 17, text: "Selected sentence", pageIndex: 2, pageLabel: "3" },
      fetchImpl,
      onTextDelta,
    })

    expect(record).toMatchObject({
      source: {
        text: "Selected sentence", itemID: 17, libraryID: 2, itemKey: "PDFKEY17",
        title: "Paper title", pageIndex: 2, pageLabel: "3",
      },
      result: { text: "译文", sourceLanguage: "英文", targetLanguage: "简体中文" },
    })
    expect(onTextDelta).toHaveBeenLastCalledWith("译文")
    const body = JSON.parse(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]?.body))
    expect(body).toMatchObject({ temporary: true, agentId: "browser-extension", modelId: "deepseek-v4-flash-vision-exp", clientContext: { version: expect.any(String), feature: "translation" } })
    expect(body).not.toHaveProperty("routeTier")
    expect(body.messages).toHaveLength(1)
    expect(JSON.stringify(body.messages)).toContain("源语言：英文")
    expect(JSON.stringify(body.messages)).toContain("翻译为简体中文")
    expect(values.has(TRANSLATION_HISTORY_PREF_KEY)).toBe(true)
    expect(readTranslationHistory(zotero.Prefs!).records).toHaveLength(1)
    expect(values.has("extensions.jadenseInZotero.localChatState")).toBe(false)
  })

  it.each(["jadense", "byok"] as const)("applies article defaults and sentence overrides to %s without changing article preferences", async (route) => {
    const values = new Map<string, unknown>([["extensions.jadenseInZotero.token", "test-token"]])
    const zotero = zoteroWithPreferences(values, readerSourceItems())
    saveAiRoute(zotero, route)
    if (route === "byok") saveByokConfig(zotero, {
      ...defaultByokConfig(), protocol: "openai-chat-completions",
      baseUrl: "https://provider.test/v1", apiKey: "fixture-key", model: "fixture-model",
    })
    if (route === "byok") saveFeatureModelSelection(zotero, "translation", { route: "byok", modelId: "default-model" })
    await writeArticleTranslationLanguages(zotero, 17, { sourceLanguage: "de", targetLanguage: "ja" })
    const fetchImpl = vi.fn(async () => new Response(route === "byok"
      ? 'data: {"choices":[{"delta":{"content":"译文"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
      : 'data: {"type":"text-delta","delta":"译文"}\n\ndata: {"type":"finish"}\n\n', { status: 200 }))
    const articleResult = await translateReaderSelection({
      zotero, fetchImpl,
      action: { kind: "translate", itemID: 17, text: "Text" },
    })
    expect(articleResult.result).toMatchObject({ sourceLanguage: "德语", targetLanguage: "日语" })
    const sentenceResult = await translateReaderSelection({
      zotero, fetchImpl,
      action: { kind: "translate", itemID: 17, text: "Bonjour", languages: { sourceLanguage: "auto", targetLanguage: "fr" } },
    })
    expect(sentenceResult.result).toMatchObject({ sourceLanguage: "自动识别", targetLanguage: "法语" })
    const requests = fetchImpl.mock.calls.map((call) => JSON.stringify(JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).messages))
    expect(requests[0]).toContain("源语言：德语")
    expect(requests[0]).toContain("翻译为日语")
    expect(requests[1]).toContain("源语言：自动识别")
    expect(requests[1]).toContain("翻译为法语")
    expect(requests[1]).toContain("行内公式统一写成 `$...$`")
    expect(await readArticleTranslationLanguages(zotero, 17)).toEqual({ sourceLanguage: "de", targetLanguage: "ja" })
    expect(readTranslationHistory(zotero.Prefs!).records).toHaveLength(2)
  })

  it("completes translation when the optional article preference cannot be read", async () => {
    const values = new Map<string, unknown>([["extensions.jadenseInZotero.token", "test-token"]])
    const zotero = zoteroWithPreferences(values, readerSourceItems())
    zotero.Prefs!.get = (key) => {
      if (key.startsWith(ARTICLE_TRANSLATION_LANGUAGES_PREF_PREFIX)) throw new Error("Preference unavailable")
      return values.get(key)
    }
    const fetchImpl = vi.fn(async () => new Response('data: {"type":"text-delta","delta":"译文"}\n\ndata: {"type":"finish"}\n\n'))
    const record = await translateReaderSelection({ zotero, fetchImpl, action: { kind: "translate", itemID: 17, text: "Text" } })
    expect(record.result).toMatchObject({ sourceLanguage: "英文", targetLanguage: "简体中文" })
    expect(readTranslationHistory(zotero.Prefs!).records).toHaveLength(1)
  })

  it("fails before dispatch when the active route has no credentials", async () => {
    const values = new Map<string, unknown>()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(translateReaderSelection({
      zotero: zoteroWithPreferences(values),
      action: { kind: "translate", itemID: 17, text: "Selected sentence" },
      fetchImpl,
    })).rejects.toThrow(/连接攻玉/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(values.has(TRANSLATION_HISTORY_PREF_KEY)).toBe(false)
  })

  it("does not dispatch or persist a new record when the physical attachment identity cannot be verified", async () => {
    const values = new Map<string, unknown>([
      ["extensions.jadenseInZotero.token", "test-token"],
      ["extensions.jadenseInZotero.baseUrl", "https://jadense.test"],
    ])
    const fetchImpl = vi.fn() as unknown as typeof fetch

    await expect(translateReaderSelection({
      zotero: zoteroWithPreferences(values, { get: () => undefined }),
      action: { kind: "translate", itemID: 17, text: "Selected sentence" },
      fetchImpl,
    })).rejects.toThrow(/无法确认当前 PDF 附件身份/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(values.has(TRANSLATION_HISTORY_PREF_KEY)).toBe(false)
  })

  it.each([
    [403, "insufficient_scope", /重新生成 Zotero 令牌/],
    [402, "POINTS_INSUFFICIENT", /攻玉学术主页.*签到领积分或补充积分/],
  ] as const)("turns structured %s failures into actionable translation guidance", async (status, code, expected) => {
    const values = new Map<string, unknown>([
      ["extensions.jadenseInZotero.token", "test-token"],
      ["extensions.jadenseInZotero.baseUrl", "https://jadense.test"],
    ])
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "request rejected", code }), {
      status,
    })) as unknown as typeof fetch

    await expect(translateReaderSelection({
      zotero: zoteroWithPreferences(values, readerSourceItems()),
      action: { kind: "translate", itemID: 17, text: "Selected sentence" },
      fetchImpl,
    })).rejects.toThrow(expected)
    expect(values.has(TRANSLATION_HISTORY_PREF_KEY)).toBe(false)
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
