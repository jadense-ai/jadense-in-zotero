/** 共用展示辅助回归：界面语言覆盖动态说明，但不改用户内容和翻译请求语言。 */
import { afterEach, describe, expect, it } from "vitest"
import { initializeUiLocale } from "./ui-preferences"
import { AI_FEATURE_LABELS, featureModelState } from "./ai-settings"
import { buildJadenseChatModelSelectOptions } from "./ai-model-select"
import { formatJadenseSyncResult } from "./sync-result"
import { translationLanguageDisplayLabel, translationLanguageLabel } from "@/chat/translation-languages"
import { JadenseApiError, jadenseModelSubscriptionErrorMessage } from "@/jadense/api"

afterEach(() => initializeUiLocale({ locale: "zh-CN" }))

describe("shared plugin UI localization", () => {
  it("localizes feature and model messages while retaining provider names", () => {
    initializeUiLocale({ locale: "en-US" })
    expect(AI_FEATURE_LABELS.analysis).toBe("Literature analysis")
    expect(featureModelState({}, "chat").issue).toContain("Connect Jadense")
    const options = buildJadenseChatModelSelectOptions({ defaultSelection: null, options: [{ kind: "model", modelId: "custom", displayName: "用户模型", description: "", capabilities: ["text"], locked: false }] })
    expect(options[0].label).toBe("用户模型")
    expect(options[0].group).toBe("Jadense models")
  })

  it("localizes language choices without changing the request labels", () => {
    initializeUiLocale({ locale: "en-US" })
    expect(translationLanguageDisplayLabel("fr")).toBe("French")
    expect(translationLanguageDisplayLabel("auto")).toBe("Auto-detect")
    expect(translationLanguageLabel("fr")).toBe("法语")
  })

  it("formats upload summaries in the active language without translating collection names", () => {
    initializeUiLocale({ locale: "en-US" })
    expect(formatJadenseSyncResult({ collectionName: "我的资料", totalCount: 1234 })).toContain("Collection: 我的资料\nTotal items: 1,234")
    initializeUiLocale({ locale: "zh-CN" })
    expect(formatJadenseSyncResult({ collectionName: "我的资料", totalCount: 2 })).toContain("收藏夹：我的资料\n条目总数：2")
  })

  it("keeps subscription recovery distinct from buying points in English", () => {
    initializeUiLocale({ locale: "en-US" })
    const error = new JadenseApiError({ message: "Provider message", body: "", status: 403, code: "AI_MODEL_SELECTION_PLAN_REQUIRED" })
    expect(jadenseModelSubscriptionErrorMessage(error)).toContain("Buying points does not remove this restriction")
  })
})
