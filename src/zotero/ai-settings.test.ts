import { describe, expect, it } from "vitest"

import { defaultByokConfig } from "@/chat/byok-chat"
import {
  clearByokConfig,
  deleteByokProvider,
  JADENSE_CHAT_MODEL_PREF_KEY,
  jadenseChatSelectionFromKey,
  jadenseChatSelectionKey,
  PAPER_ANALYSIS_MODEL_PREF_KEY,
  readAiRoute,
  readByokConfig,
  readByokConfigForModel,
  readByokSettings,
  readJadenseChatSelection,
  readPaperAnalysisModelSelection,
  saveAiRoute,
  saveByokConfig,
  saveByokModel,
  saveByokProvider,
  saveJadenseChatSelection,
  savePaperAnalysisModelSelection,
  selectByokModel,
} from "./ai-settings"
import type { ZoteroLike } from "./runtime"

function fakeZotero(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    Prefs: {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
      clear: (key: string) => values.delete(key),
    },
  } as ZoteroLike & { values: Map<string, unknown> }
}

describe("AI route settings", () => {
  it("keeps existing users on Jadense and persists an explicit BYOK choice", () => {
    const zotero = fakeZotero()
    expect(readAiRoute(zotero)).toBe("jadense")
    saveAiRoute(zotero, "byok")
    expect(readAiRoute(zotero)).toBe("byok")
    zotero.Prefs?.set("extensions.jadenseInZotero.aiRoute", "future-route")
    expect(readAiRoute(zotero)).toBe("jadense")
  })

  it("defaults to DeepSeek V4 Flash Vision Exp and stores an explicit Jadense route or model", () => {
    const zotero = fakeZotero()
    expect(readJadenseChatSelection(zotero)).toEqual({ kind: "model", modelId: "deepseek-v4-flash-vision-exp" })

    saveJadenseChatSelection(zotero, { kind: "route", routeTier: "premium" })
    expect(readJadenseChatSelection(zotero)).toEqual({ kind: "route", routeTier: "premium" })
    expect(zotero.values.get(JADENSE_CHAT_MODEL_PREF_KEY)).toBe('{"kind":"route","routeTier":"premium"}')

    saveJadenseChatSelection(zotero, { kind: "model", modelId: "glm-5" })
    expect(readJadenseChatSelection(zotero)).toEqual({ kind: "model", modelId: "glm-5" })
    expect(jadenseChatSelectionKey(readJadenseChatSelection(zotero))).toBe("model:glm-5")
    expect(jadenseChatSelectionFromKey("route:standard")).toEqual({ kind: "route", routeTier: "standard" })
  })

  it("defaults malformed Jadense selections and ignores additive fields", () => {
    const zotero = fakeZotero({
      [JADENSE_CHAT_MODEL_PREF_KEY]: JSON.stringify({ kind: "model", modelId: " model-a ", future: true }),
    })
    expect(readJadenseChatSelection(zotero)).toEqual({ kind: "model", modelId: "model-a" })
    zotero.Prefs?.set(JADENSE_CHAT_MODEL_PREF_KEY, '{"kind":"route","routeTier":')
    expect(readJadenseChatSelection(zotero)).toEqual({ kind: "model", modelId: "deepseek-v4-flash-vision-exp" })
    expect(jadenseChatSelectionFromKey("model:")).toEqual({ kind: "model", modelId: "deepseek-v4-flash-vision-exp" })
  })
})

describe("paper analysis model settings", () => {
  it("inherits the global route and active model when the independent preference is absent or corrupt", () => {
    const zotero = fakeZotero()
    saveByokProvider(zotero, {
      id: "provider", name: "Provider", protocol: "openai-responses",
      baseUrl: "https://provider.test/v1", apiKey: "key",
    })
    saveByokModel(zotero, { id: "model", providerId: "provider", name: "Model", model: "model-name" })
    saveAiRoute(zotero, "byok")

    // 模拟旧版尚无功能偏好的存量配置。
    zotero.Prefs?.clear(PAPER_ANALYSIS_MODEL_PREF_KEY)
    expect(readPaperAnalysisModelSelection(zotero)).toEqual({ route: "byok", modelId: "model" })
    zotero.Prefs?.set(PAPER_ANALYSIS_MODEL_PREF_KEY, '{"route":"byok","modelId":')
    expect(readPaperAnalysisModelSelection(zotero)).toEqual({ route: "byok", modelId: "model" })
  })

  it("resolves an independent model with its own provider without changing global settings", () => {
    const zotero = fakeZotero()
    saveByokProvider(zotero, {
      id: "one", name: "One", protocol: "openai-chat-completions",
      baseUrl: "https://one.test/v1", apiKey: "one-key",
    })
    saveByokModel(zotero, {
      id: "one-model", providerId: "one", name: "One Model", model: "one-v1", maxOutputTokens: 12_000,
    })
    saveByokProvider(zotero, {
      id: "two", name: "Two", protocol: "anthropic-messages",
      baseUrl: "https://two.test/v1", apiKey: "two-key",
    })
    saveByokModel(zotero, { id: "two-model", providerId: "two", name: "Two Model", model: "two-v1" })
    saveAiRoute(zotero, "jadense")
    const globalSettings = readByokSettings(zotero)

    savePaperAnalysisModelSelection(zotero, { route: "byok", modelId: "one-model" })

    expect(readPaperAnalysisModelSelection(zotero)).toEqual({ route: "byok", modelId: "one-model" })
    expect(readByokConfigForModel(zotero, "one-model")).toEqual({
      protocol: "openai-chat-completions",
      baseUrl: "https://one.test/v1",
      apiKey: "one-key",
      model: "one-v1",
      maxOutputTokens: 12_000,
    })
    expect(readAiRoute(zotero)).toBe("jadense")
    expect(readByokSettings(zotero)).toEqual(globalSettings)
    expect(zotero.values.get(PAPER_ANALYSIS_MODEL_PREF_KEY)).toBe('{"route":"byok","modelId":"one-model"}')
  })

  it("keeps an explicitly selected stale model detectable without falling back or mutating global state", () => {
    const zotero = fakeZotero()
    saveByokProvider(zotero, {
      id: "active", name: "Active", protocol: "openai-responses",
      baseUrl: "https://active.test/v1", apiKey: "active-key",
    })
    saveByokModel(zotero, { id: "active-model", providerId: "active", name: "Active", model: "active-v1" })
    saveAiRoute(zotero, "byok")
    savePaperAnalysisModelSelection(zotero, { route: "byok", modelId: "deleted-model" })
    const globalSettings = readByokSettings(zotero)

    expect(readPaperAnalysisModelSelection(zotero)).toEqual({ route: "byok", modelId: "deleted-model" })
    expect(readByokConfigForModel(zotero, "deleted-model")).toBeNull()
    expect(readAiRoute(zotero)).toBe("byok")
    expect(readByokSettings(zotero)).toEqual(globalSettings)
  })

  it.each([
    { id: "missing-key", apiKey: "", model: "configured-model" },
    { id: "missing-model", apiKey: "configured-key", model: "" },
  ])("returns null for an incomplete $id instead of falling back to the active model", ({ id, apiKey, model }) => {
    const zotero = fakeZotero({
      "extensions.jadenseInZotero.byokConfig": JSON.stringify({
        version: 2,
        activeProviderId: "ready-provider",
        activeModelId: "ready-model",
        providers: [
          { id: "incomplete-provider", name: "Incomplete", protocol: "openai-responses", baseUrl: "https://incomplete.test/v1", apiKey },
          { id: "ready-provider", name: "Ready", protocol: "openai-responses", baseUrl: "https://ready.test/v1", apiKey: "ready-key" },
        ],
        models: [
          { id, providerId: "incomplete-provider", name: "Incomplete", model },
          { id: "ready-model", providerId: "ready-provider", name: "Ready", model: "ready-model" },
        ],
      }),
    })
    const globalSettings = readByokSettings(zotero)

    expect(readByokConfigForModel(zotero, id)).toBeNull()
    expect(readByokConfig(zotero).model).toBe("ready-model")
    expect(readByokSettings(zotero)).toEqual(globalSettings)
  })

  it("rejects an empty explicit BYOK target instead of persisting an ambiguous route", () => {
    const zotero = fakeZotero()
    expect(() => savePaperAnalysisModelSelection(zotero, { route: "byok", modelId: " " }))
      .toThrow("模型不能为空")
    expect(zotero.values.has(PAPER_ANALYSIS_MODEL_PREF_KEY)).toBe(false)
  })
})

describe("BYOK profile settings", () => {
  it("uses the canonical initial defaults", () => {
    expect(readByokConfig(fakeZotero())).toEqual(defaultByokConfig())
    expect(readByokConfig(fakeZotero()).maxOutputTokens).toBe(96_000)
    expect(readByokSettings(fakeZotero())).toMatchObject({
      version: 2,
      activeProviderId: "default-provider",
      activeModelId: "",
      providers: [{ id: "default-provider", name: "OpenAI", protocol: "openai-chat-completions" }],
      models: [],
    })
  })

  it("accepts additive fields and normalizes corrupt known values", () => {
    const zotero = fakeZotero({
      "extensions.jadenseInZotero.byokConfig": JSON.stringify({
        protocol: "anthropic-messages", baseUrl: "https://gateway.test/v1/", apiKey: " key ", model: " claude ",
        maxOutputTokens: -1, futureProviderMetadata: { harmless: true },
      }),
    })
    expect(readByokConfig(zotero)).toEqual({
      protocol: "anthropic-messages", baseUrl: "https://gateway.test/v1", apiKey: "key", model: "claude",
      maxOutputTokens: 96_000,
    })
  })

  it("retains the saved key across protocol and Base URL changes when replacement is blank", () => {
    const zotero = fakeZotero()
    saveByokConfig(zotero, { ...defaultByokConfig(), apiKey: "old-key", model: "gpt" })
    const saved = saveByokConfig(zotero, {
      protocol: "anthropic-messages", baseUrl: "https://gateway.example/v1", apiKey: "", model: "claude",
      maxOutputTokens: 12_000,
    })
    expect(saved.apiKey).toBe("old-key")
    expect(readByokConfig(zotero)).toEqual(saved)
  })

  it("migrates the legacy flat config into separate provider and model records", () => {
    const zotero = fakeZotero({
      "extensions.jadenseInZotero.byokConfig": JSON.stringify({
        protocol: "openai-chat-completions",
        baseUrl: "https://gateway.example/v1",
        apiKey: "secret",
        model: "mimo-v2.5",
        maxOutputTokens: 128_000,
        ignored: true,
      }),
    })
    const settings = readByokSettings(zotero)
    expect(settings.providers).toEqual([{
      id: "default-provider", name: "自定义提供商", protocol: "openai-chat-completions",
      baseUrl: "https://gateway.example/v1", apiKey: "secret",
    }])
    expect(settings.models).toEqual([{
      id: "default-model", providerId: "default-provider", name: "mimo-v2.5", model: "mimo-v2.5",
      maxOutputTokens: 128_000,
    }])
    expect(readByokConfig(zotero)).toMatchObject({ model: "mimo-v2.5", maxOutputTokens: 128_000 })
  })

  it("stores multiple providers and models and resolves the selected model with its provider", () => {
    const zotero = fakeZotero()
    saveByokProvider(zotero, {
      id: "mimo", name: "MiMo", protocol: "openai-chat-completions",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", apiKey: "mimo-key",
    })
    saveByokModel(zotero, {
      id: "mimo-25", providerId: "mimo", name: "MiMo 2.5", model: "mimo-v2.5",
      contextWindow: 1_000_000, maxOutputTokens: 128_000,
    })
    saveByokProvider(zotero, {
      id: "anthropic", name: "Anthropic", protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1", apiKey: "anthropic-key",
    })
    saveByokModel(zotero, {
      id: "claude", providerId: "anthropic", name: "Claude", model: "claude-sonnet", maxOutputTokens: 20_000,
    })
    selectByokModel(zotero, "mimo-25")
    expect(readByokConfig(zotero)).toEqual({
      protocol: "openai-chat-completions", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      apiKey: "mimo-key", model: "mimo-v2.5", maxOutputTokens: 128_000,
    })
    expect(readByokSettings(zotero).models).toHaveLength(2)
  })

  it("retains a blank replacement key only for the provider being edited", () => {
    const zotero = fakeZotero()
    saveByokProvider(zotero, {
      id: "one", name: "One", protocol: "openai-chat-completions", baseUrl: "https://one.test/v1", apiKey: "one-key",
    })
    saveByokProvider(zotero, {
      id: "two", name: "Two", protocol: "openai-responses", baseUrl: "https://two.test/v1", apiKey: "two-key",
    })
    saveByokProvider(zotero, {
      id: "one", name: "One edited", protocol: "anthropic-messages", baseUrl: "https://one.test/v2", apiKey: "",
    })
    const providers = readByokSettings(zotero).providers
    expect(providers.find((provider) => provider.id === "one")?.apiKey).toBe("one-key")
    expect(providers.find((provider) => provider.id === "two")?.apiKey).toBe("two-key")
  })

  it("cascades provider deletion and chooses a valid remaining active model", () => {
    const zotero = fakeZotero()
    saveByokProvider(zotero, {
      id: "one", name: "One", protocol: "openai-chat-completions", baseUrl: "https://one.test/v1", apiKey: "one",
    })
    saveByokModel(zotero, { id: "one-model", providerId: "one", name: "One", model: "one" })
    saveByokProvider(zotero, {
      id: "two", name: "Two", protocol: "openai-responses", baseUrl: "https://two.test/v1", apiKey: "two",
    })
    saveByokModel(zotero, { id: "two-model", providerId: "two", name: "Two", model: "two" })
    deleteByokProvider(zotero, "two")
    const settings = readByokSettings(zotero)
    expect(settings.models.some((model) => model.providerId === "two")).toBe(false)
    expect(settings.activeProviderId).toBe("one")
    expect(settings.activeModelId).toBe("one-model")
  })

  it("ignores additive fields and degrades malformed optional model metadata", () => {
    const zotero = fakeZotero({
      "extensions.jadenseInZotero.byokConfig": JSON.stringify({
        version: 2,
        activeProviderId: "p",
        activeModelId: "m",
        providers: [{ id: "p", name: "P", protocol: "openai-responses", baseUrl: "https://p.test/v1", apiKey: "k", future: 1 }],
        models: [{ id: "m", providerId: "p", name: "M", model: "model", contextWindow: -3, maxOutputTokens: "large", future: 2 }],
        futureRoot: true,
      }),
    })
    expect(readByokSettings(zotero).models).toEqual([{ id: "m", providerId: "p", name: "M", model: "model" }])
    expect(readByokConfig(zotero).maxOutputTokens).toBe(96_000)
  })

  it("clears BYOK without changing the active route or Jadense token", () => {
    const zotero = fakeZotero({ "extensions.jadenseInZotero.token": "jadense-token" })
    saveAiRoute(zotero, "byok")
    saveByokConfig(zotero, { ...defaultByokConfig(), apiKey: "key", model: "gpt" })
    clearByokConfig(zotero)
    expect(readByokConfig(zotero)).toEqual(defaultByokConfig())
    expect(readAiRoute(zotero)).toBe("byok")
    expect(zotero.values.get("extensions.jadenseInZotero.token")).toBe("jadense-token")
  })
})
