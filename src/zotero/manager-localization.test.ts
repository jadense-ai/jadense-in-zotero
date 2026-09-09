/** 工作台的展示偏好行为测试：窗口联动不修改启动语言、内容或 AI 操作。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { localizeManagerStaticContent } from "./manager-localization"
import { buildJadensePointsView, friendlyChatError, observeManagerOperationPreferences, wireManagerAppearance } from "./manager-page"
import { DISPLAY_LANGUAGE_PREF, getUiLocale, initializeUiLocale, THEME_PREF } from "./ui-preferences"
import type { JdxSelect, JdxSelectOption } from "./custom-select"
import type { ZoteroLike } from "./runtime"

afterEach(() => { initializeUiLocale({ locale: "zh-CN" }) })

function host() {
  const values = new Map<string, unknown>()
  const observers = new Map<number, { key: string; listener: () => void }>()
  const mediaListeners = new Set<() => void>()
  const media = {
    matches: false,
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
  }
  let id = 0
  const zotero = {
    locale: "zh-CN",
    Prefs: {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => {
        values.set(key, value)
        for (const observer of observers.values()) if (observer.key === key) observer.listener()
      },
      registerObserver: (key: string, listener: () => void) => { observers.set(++id, { key, listener }); return id },
      unregisterObserver: (id: unknown) => observers.delete(id as number),
    },
    getMainWindow: () => ({ matchMedia: () => media }) as unknown as Window & typeof globalThis,
  }
  return {
    zotero, values, observers, mediaListeners,
    setSystemDark: (dark: boolean) => { media.matches = dark; for (const listener of mediaListeners) listener() },
  }
}

function select() {
  let value = ""
  let listener = (_value: string) => {}
  let options: JdxSelectOption[] = []
  return {
    element: {} as HTMLElement,
    getValue: () => value,
    setValue: (next: string) => { value = next },
    setOptions: (next: JdxSelectOption[], selected: string) => { options = next; value = selected },
    setDisabled: vi.fn(),
    onChange: (next: typeof listener) => { listener = next },
    choose: (next: string) => { expect(options.some(option => option.value === next)).toBe(true); value = next; listener(next) },
    labels: () => options.map(option => option.label),
  } satisfies JdxSelect & { choose(value: string): void; labels(): string[] }
}

function appearanceWindow() {
  const clicks = new Map<string, () => void>()
  const attributes = new Map<string, string>()
  const root = { dataset: {} as Record<string, string>, style: {}, replaceChildren: vi.fn(), draft: "尚未发送的中文草稿", messages: ["既有回答不翻译"] }
  const elements = {
    themeToggle: {
      title: "",
      addEventListener: (name: string, listener: () => void) => { clicks.set(name, listener) },
      setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    } as unknown as HTMLButtonElement,
    displayLanguage: select(),
    displayTheme: select(),
    generalStatus: { textContent: "", dataset: {} } as HTMLElement,
  }
  return { root, elements, clickTheme: () => clicks.get("click")!(), attributes }
}

describe("Manager appearance", () => {
  it("synchronizes pending language across windows while preserving the startup snapshot and restart hint", () => {
    const { zotero, values } = host()
    initializeUiLocale(zotero)
    const first = appearanceWindow()
    const second = appearanceWindow()
    const stopFirst = wireManagerAppearance(first.elements, zotero, first.root as unknown as HTMLElement)
    const stopSecond = wireManagerAppearance(second.elements, zotero, second.root as unknown as HTMLElement)
    expect(first.elements.displayLanguage.labels()).toEqual(["跟随 Zotero", "简体中文", "English"])
    first.elements.displayLanguage.choose("en-US")
    expect(values.get(DISPLAY_LANGUAGE_PREF)).toBe("en-US")
    expect(second.elements.displayLanguage.getValue()).toBe("en-US")
    expect(first.elements.generalStatus.textContent).toContain("重启 Zotero")
    expect(initializeUiLocale(zotero)).toBe("zh-CN")
    stopSecond()
    const reopened = appearanceWindow()
    const stopReopened = wireManagerAppearance(reopened.elements, zotero, reopened.root as unknown as HTMLElement)
    expect(reopened.elements.displayLanguage.getValue()).toBe("en-US")
    expect(getUiLocale()).toBe("zh-CN")
    expect(initializeUiLocale({ locale: "zh-CN", Prefs: zotero.Prefs })).toBe("en-US")
    stopFirst(); stopReopened()
  })

  it("applies theme changes, sidebar choices, and host changes to all windows without touching drafts or AI operations", () => {
    const { zotero, values, observers, mediaListeners, setSystemDark } = host()
    initializeUiLocale(zotero)
    const first = appearanceWindow()
    const second = appearanceWindow()
    const cancelOperation = vi.fn()
    const stopOperations = observeManagerOperationPreferences(zotero as ZoteroLike, cancelOperation)
    const stopFirst = wireManagerAppearance(first.elements, zotero, first.root as unknown as HTMLElement)
    const stopSecond = wireManagerAppearance(second.elements, zotero, second.root as unknown as HTMLElement)
    expect(first.root.dataset.theme).toBe("light")
    first.elements.displayTheme.choose("dark")
    expect([first.root.dataset.theme, second.root.dataset.theme]).toEqual(["dark", "dark"])
    expect(second.elements.displayTheme.getValue()).toBe("dark")
    second.clickTheme()
    expect(values.get(THEME_PREF)).toBe("light")
    expect([first.root.dataset.theme, second.root.dataset.theme]).toEqual(["light", "light"])
    first.elements.displayTheme.choose("system")
    setSystemDark(true)
    expect([first.root.dataset.theme, second.root.dataset.theme]).toEqual(["dark", "dark"])
    expect(first.attributes.get("aria-pressed")).toBe("true")
    expect(first.root.draft).toBe("尚未发送的中文草稿")
    expect(first.root.messages).toEqual(["既有回答不翻译"])
    expect(first.root.replaceChildren).not.toHaveBeenCalled()
    expect(cancelOperation).not.toHaveBeenCalled()
    stopFirst(); stopFirst()
    setSystemDark(false)
    expect(first.root.dataset.theme).toBe("dark")
    expect(second.root.dataset.theme).toBe("light")
    stopSecond(); stopOperations()
    expect(observers.size).toBe(0)
    expect(mediaListeners.size).toBe(0)
  })

  it("contains preference write failure to the general status", () => {
    const { zotero } = host()
    zotero.Prefs.set = () => { throw new Error("write unavailable") }
    initializeUiLocale(zotero)
    const win = appearanceWindow()
    const stop = wireManagerAppearance(win.elements, zotero, win.root as unknown as HTMLElement)
    expect(() => win.elements.displayLanguage.choose("en-US")).not.toThrow()
    expect(win.elements.generalStatus.dataset.kind).toBe("error")
    expect(getUiLocale()).toBe("zh-CN")
    expect(win.root.draft).toBe("尚未发送的中文草稿")
    stop()
  })
})

describe("Manager English content", () => {
  it("translates only explicitly marked text and accessibility attributes without touching user content", () => {
    const heading = { textContent: "你的攻玉", dataset: { uiEn: "Your Jadense" } }
    const history = { textContent: "用户原文与历史回答" }
    const attributes = new Map([["data-ui-en-title", "Go to Jadense"], ["data-ui-en-placeholder", "Ask Jadense…"], ["title", "前往攻玉"], ["placeholder", "向攻玉提问…"]])
    const control = { getAttribute: (key: string) => attributes.get(key) ?? null, setAttribute: (key: string, value: string) => attributes.set(key, value) }
    const doc = {
      documentElement: { lang: "" },
      querySelectorAll: (selector: string) => selector === "[data-ui-en]" ? [heading]
        : selector === "[data-ui-en-title]" || selector === "[data-ui-en-placeholder]" ? [control] : [],
    }
    initializeUiLocale({ locale: "zh-CN" })
    localizeManagerStaticContent(doc as unknown as Document)
    expect(heading.textContent).toBe("你的攻玉")
    initializeUiLocale({ locale: "en-US" })
    localizeManagerStaticContent(doc as unknown as Document)
    expect(doc.documentElement.lang).toBe("en-US")
    expect(heading.textContent).toBe("Your Jadense")
    expect(attributes.get("title")).toBe("Go to Jadense")
    expect(attributes.get("placeholder")).toBe("Ask Jadense…")
    expect(history.textContent).toBe("用户原文与历史回答")
  })

  it("formats points and errors in English while keeping effective balance semantics", () => {
    initializeUiLocale({ locale: "en-US" })
    expect(buildJadensePointsView({
      billing: { sourceKind: "team", balancePoints: 1234, primaryBalancePoints: 1234, fallbackBalancePoints: 50 },
      checkIn: { signedToday: true, currentStreakDays: 2, todayReward: { grantedPoints: 8 } },
    } as Parameters<typeof buildJadensePointsView>[0])).toMatchObject({ balance: "1,234 points", fallback: "50 points", streak: "2 days", reward: "+8 points" })
    const error = new Error("cancelled"); error.name = "AbortError"
    expect(friendlyChatError(error)).toBe("Generation stopped.")
  })
})
