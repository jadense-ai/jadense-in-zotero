/** 功能模型偏好回归：旧配置迁移、独立目的地、目录故障与图片追问。 */
import { describe, expect, it } from "vitest"
import { createLocalChatSession } from "@/chat/local-chat-store"
import { buildFeatureModelSelectOptions } from "./ai-model-select"
import {
  AI_FEATURES, FEATURE_MODEL_PREF_KEYS, featureModelState, initializeFeatureModelSelections,
  readFeatureModelSelection, saveFeatureModelSelection, selectByokModel, deleteByokModel,
} from "./ai-settings"
import { activeAiState, createReaderFigureChatSession } from "./manager-page"
import type { ZoteroLike } from "./runtime"

function fixture(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries({
    "extensions.jadenseInZotero.token": "synthetic-token",
    "extensions.jadenseInZotero.byokConfig": JSON.stringify({
      version: 2, activeProviderId: "one", activeModelId: "one-model",
      providers: ["one", "two"].map(id => ({ id, name: id, protocol: "openai-chat-completions", baseUrl: `https://${id}.test/v1`, apiKey: `${id}-key` })),
      models: ["one", "two"].map(id => ({ id: `${id}-model`, providerId: id, name: `${id} display`, model: `${id}-api-model` })),
    }),
    ...initial,
  }))
  const zotero: ZoteroLike = { Prefs: { get: key => values.get(key), set: (key, value) => { values.set(key, value) }, clear: key => { values.delete(key) } } }
  return { zotero, values }
}

describe("independent feature models", () => {
  it.each(AI_FEATURES)("preserves an explicitly saved previous default for %s", feature => {
    const selection = { route: "jadense", selection: { kind: "model", modelId: "glm-5.3-flash" } } as const
    const { zotero } = fixture({ [FEATURE_MODEL_PREF_KEYS[feature]]: JSON.stringify(selection) })
    expect(readFeatureModelSelection(zotero, feature)).toEqual(selection)
  })

  it.each(AI_FEATURES)("uses DeepSeek V4 Flash Vision Exp for new and legacy default %s selections without overriding explicit choices", feature => {
    const expected = { route: "jadense", selection: { kind: "model", modelId: "deepseek-v4-flash-vision-exp" } }
    for (const stored of [undefined, { route: "jadense" }, { route: "jadense", selection: { kind: "default" } }]) {
      const { zotero } = fixture({ [FEATURE_MODEL_PREF_KEYS[feature]]: JSON.stringify(stored) })
      expect(featureModelState(zotero, feature)).toMatchObject({ ready: true, selection: expected })
      const options = buildFeatureModelSelectOptions(zotero, { options: [], defaultSelection: null }, readFeatureModelSelection(zotero, feature))
      expect(options.map(option => option.value)).toContain("model:deepseek-v4-flash-vision-exp")
      expect(options.map(option => option.value)).not.toContain("default")
      saveFeatureModelSelection(zotero, feature, { route: "jadense", selection: { kind: "model", modelId: "chosen-model" } })
      expect(readFeatureModelSelection(zotero, feature)).toEqual({ route: "jadense", selection: { kind: "model", modelId: "chosen-model" } })
    }
  })

  it("activates the default only after connecting, while retaining explicit BYOK choices on connection changes", () => {
    const { zotero, values } = fixture({ "extensions.jadenseInZotero.token": "" })
    expect(featureModelState(zotero, "chat").ready).toBe(false)
    saveFeatureModelSelection(zotero, "translation", { route: "byok", modelId: "two-model" })
    values.set("extensions.jadenseInZotero.token", "synthetic-token")
    expect(featureModelState(zotero, "chat")).toMatchObject({ ready: true, selection: { selection: { kind: "model", modelId: "deepseek-v4-flash-vision-exp" } } })
    expect(featureModelState(zotero, "translation")).toMatchObject({ ready: true, route: "byok", config: { model: "two-api-model" } })
    expect(featureModelState(zotero, "chat", "synthetic-token").ready).toBe(false)
    values.set("extensions.jadenseInZotero.token", "")
    expect(featureModelState(zotero, "chat").ready).toBe(false)
    expect(featureModelState(zotero, "translation").ready).toBe(true)
  })

  it("snapshots legacy BYOK once before the editor switches or deletes models", () => {
    const { zotero } = fixture({ "extensions.jadenseInZotero.aiRoute": "byok" })
    selectByokModel(zotero, "two-model")
    for (const feature of AI_FEATURES) expect(readFeatureModelSelection(zotero, feature)).toEqual({ route: "byok", modelId: "one-model" })
    deleteByokModel(zotero, "one-model")
    expect(featureModelState(zotero, "translation")).toMatchObject({ route: "byok", ready: false })
    expect(readFeatureModelSelection(zotero, "translation")).toEqual({ route: "byok", modelId: "one-model" })
  })

  it("preserves legacy Chat overrides for chat and images while leaving translation and analysis defaults intact", () => {
    const { zotero } = fixture({
      "extensions.jadenseInZotero.jadenseChatModel": JSON.stringify({ kind: "model", modelId: "legacy-model" }),
      [FEATURE_MODEL_PREF_KEYS.analysis]: JSON.stringify({ route: "byok", modelId: "two-model" }),
    })
    const selections = initializeFeatureModelSelections(zotero)
    expect(selections.chat).toEqual({ route: "jadense", selection: { kind: "model", modelId: "legacy-model" } })
    expect(selections.figure).toEqual(selections.chat)
    expect(selections.translation).toEqual({ route: "jadense", selection: { kind: "model", modelId: "deepseek-v4-flash-vision-exp" } })
    expect(selections.analysis).toEqual({ route: "byok", modelId: "two-model" })
  })

  it.each(AI_FEATURES)("keeps %s independent across save, reload, editor selection, and unrelated model deletion", feature => {
    const { zotero, values } = fixture()
    const before = initializeFeatureModelSelections(zotero)
    saveFeatureModelSelection(zotero, feature, { route: "byok", modelId: "two-model" })
    selectByokModel(zotero, "one-model")
    deleteByokModel(zotero, "one-model")
    const reloaded = fixture(Object.fromEntries(values)).zotero
    expect(featureModelState(reloaded, feature)).toMatchObject({ ready: true, config: { baseUrl: "https://two.test/v1", model: "two-api-model", apiKey: "two-key" } })
    for (const other of AI_FEATURES.filter(other => other !== feature)) expect(readFeatureModelSelection(reloaded, other)).toEqual(before[other])
  })

  it("accepts additive fields and preserves exact selections without needing a model catalog", () => {
    const { zotero } = fixture({ [FEATURE_MODEL_PREF_KEYS.translation]: JSON.stringify({ route: "jadense", selection: { kind: "route", routeTier: "premium", future: true }, extra: { modelId: "ignored" } }) })
    expect(featureModelState(zotero, "translation")).toMatchObject({ ready: true, selection: { route: "jadense", selection: { kind: "route", routeTier: "premium" } } })
    saveFeatureModelSelection(zotero, "chat", { route: "byok", modelId: "two-model" })
    const options = buildFeatureModelSelectOptions(zotero, { options: [], defaultSelection: null }, readFeatureModelSelection(zotero, "chat"))
    expect(options.map(option => option.value)).toEqual(["byok:one-model", "byok:two-model"])
    expect(options.find(option => option.value === "byok:two-model")).toMatchObject({ group: "BYOK 自配置模型", label: "two display" })
  })

  it("keeps migration usable when optional preference writes fail", () => {
    const { zotero } = fixture({ "extensions.jadenseInZotero.aiRoute": "byok" })
    zotero.Prefs!.set = () => { throw new Error("storage unavailable") }
    expect(featureModelState(zotero, "chat")).toMatchObject({ ready: true, config: { model: "one-api-model" } })
  })

  it("uses the image model for an image conversation and switches back for a text conversation", () => {
    const { zotero } = fixture()
    saveFeatureModelSelection(zotero, "figure", { route: "byok", modelId: "two-model" })
    createReaderFigureChatSession(zotero.Prefs!, {
      kind: "interpretFigure", conversationTarget: "new", itemID: 42, pageIndex: 0,
      image: { dataUrl: "data:image/png;base64,c3ludGhldGlj", mimeType: "image/png" },
    }, "Synthetic paper")
    expect(activeAiState(zotero)).toMatchObject({ route: "byok", config: { model: "two-api-model" } })
    saveFeatureModelSelection(zotero, "chat", { route: "jadense", selection: { kind: "model", modelId: "text-model" } })
    expect(activeAiState(zotero)).toMatchObject({ route: "byok", config: { model: "two-api-model" } })
    createLocalChatSession(zotero.Prefs!)
    expect(activeAiState(zotero)).toMatchObject({ route: "jadense", selection: { selection: { modelId: "text-model" } } })
  })
})
