import { describe, expect, it } from "vitest"

import {
  applyStrings,
  formatRelativeTime,
  maskToken,
  selectPreferencesStrings,
  type PreferencesStrings,
} from "./connection-display"

describe("maskToken", () => {
  it("masks all but the last four characters", () => {
    expect(maskToken("jdx_ext_abcdef123456a3f9")).toBe("••••••••a3f9")
  })

  it("fully masks short tokens so the length stays hidden", () => {
    expect(maskToken("ab")).toBe("••••••••")
    expect(maskToken("abcd")).toBe("••••••••")
  })

  it("returns an empty mask for an empty token", () => {
    expect(maskToken("")).toBe("")
    expect(maskToken("   ")).toBe("")
  })
})

describe("formatRelativeTime", () => {
  const zh = "zh-CN"
  const en = "en-US"

  it("formats recent timestamps as just now", () => {
    expect(formatRelativeTime(new Date(Date.now() - 5_000).toISOString(), zh)).toBe("刚刚")
    expect(formatRelativeTime(new Date(Date.now() - 5_000).toISOString(), en)).toBe("just now")
  })

  it("formats minutes, hours, and days in both locales", () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString(), zh)).toBe("5 分钟前")
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString(), en)).toBe("5 min ago")
    expect(formatRelativeTime(new Date(Date.now() - 2 * 3_600_000).toISOString(), zh)).toBe("2 小时前")
    expect(formatRelativeTime(new Date(Date.now() - 2 * 3_600_000).toISOString(), en)).toBe("2 hr ago")
    expect(formatRelativeTime(new Date(Date.now() - 3 * 86_400_000).toISOString(), zh)).toBe("3 天前")
    expect(formatRelativeTime(new Date(Date.now() - 3 * 86_400_000).toISOString(), en)).toBe("3 d ago")
  })

  it("returns an empty string for unparseable input", () => {
    expect(formatRelativeTime("not-a-date", zh)).toBe("")
    expect(formatRelativeTime("", zh)).toBe("")
  })
})

describe("preferences strings", () => {
  it("selects the dictionary by locale", () => {
    expect(selectPreferencesStrings("zh-CN").copy).toBe("复制")
    expect(selectPreferencesStrings("en-US").copy).toBe("Copy")
    expect(selectPreferencesStrings(undefined).copy).toBe("Copy")
  })

  it("keeps zh and en dictionaries structurally aligned", () => {
    const zh = selectPreferencesStrings("zh-CN")
    const en = selectPreferencesStrings("en-US")
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(zh.helpSteps.length).toBe(en.helpSteps.length)
    expect(typeof zh.updatedAgo("x")).toBe("string")
    expect(typeof en.updatedAgo("x")).toBe("string")
  })
})

describe("applyStrings", () => {
  it("fills textContent for elements carrying data-i18n-key", () => {
    const first = { dataset: { i18nKey: "copy" }, textContent: "" }
    const second = { dataset: { i18nKey: "helpTitle" }, textContent: "" }
    const skipped = { dataset: { i18nKey: "helpSteps" }, textContent: "" }
    const root = {
      querySelectorAll: () => [first, second, skipped],
    } as unknown as ParentNode

    applyStrings(root, selectPreferencesStrings("zh-CN") as PreferencesStrings)

    expect(first.textContent).toBe("复制")
    expect(second.textContent).toBe("如何获取令牌")
    // 数组/函数型文案不由 applyStrings 填充,helpSteps 由页面单独渲染。
    expect(skipped.textContent).toBe("")
  })
})
