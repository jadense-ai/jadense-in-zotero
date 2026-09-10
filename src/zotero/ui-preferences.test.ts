/** 展示偏好回归：语言按进程快照隔离，主题跨窗口即时更新并释放监听。 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { DISPLAY_LANGUAGE_PREF, THEME_PREF, TRANSLATION_OPACITY_PREF, getUiLocale, initializeUiLocale, observeDisplayLanguage, observeTheme, readDisplayLanguage, readTheme, readTranslationOpacity, saveDisplayLanguage, saveTheme, saveTranslationOpacity, translationOpacityControl, uiText, type UiPreferenceHost } from "./ui-preferences"

function host(locale = "zh-CN") {
  const values = new Map<string, unknown>()
  const observers = new Map<symbol, { key: string; callback: () => void }>()
  const prefKey = (key: string, global?: boolean) => global ? key : `extensions.zotero.${key}`
  const zotero: UiPreferenceHost = {
    locale,
    Prefs: {
      get: (key, global) => values.get(prefKey(key, global)),
      set: (key, value, global) => {
        const full = prefKey(key, global)
        values.set(full, value)
        for (const observer of observers.values()) if (observer.key === full) observer.callback()
      },
      registerObserver: (key, callback, global) => {
        const id = Symbol()
        observers.set(id, { key: prefKey(key, global), callback })
        return id
      },
      unregisterObserver: id => { observers.delete(id as symbol) },
    },
  }
  return { zotero, values, observers }
}

afterEach(() => initializeUiLocale({ locale: "zh-CN" }))

describe("translation background transparency", () => {
  it("defaults old settings locally, normalizes numeric values, and contains unavailable persistence", () => {
    const { zotero, values } = host()
    expect(readTranslationOpacity(zotero)).toBe(80)
    for (const value of [undefined, null, "", " ", "invalid", { future: true }, false, Infinity, Symbol("future")]) {
      values.set(TRANSLATION_OPACITY_PREF, value)
      expect(readTranslationOpacity(zotero)).toBe(80)
    }
    for (const [value, expected] of [[0, 0], [100, 100], ["62.4", 62], [-12, 0], [120, 100]] as const) {
      expect(saveTranslationOpacity(zotero, value)).toBe(true)
      expect(values.get(TRANSLATION_OPACITY_PREF)).toBe(String(expected))
      expect(readTranslationOpacity(zotero)).toBe(expected)
    }
    const broken = { Prefs: { get: () => { throw Error("closed") }, set: () => { throw Error("closed") } } }
    expect(readTranslationOpacity(broken)).toBe(80)
    expect(saveTranslationOpacity(broken, 60)).toBe(false)
  })

  it("maps the transparency slider to background opacity and updates every owned window without fading text", () => {
    const { zotero, observers } = host()
    const makeWindow = () => {
      const attributes = new Map<string, string>(), events = new Map<string, () => void>(), properties = new Map<string, string>()
      const output = { textContent: "" }
      const range = { value: "", parentElement: { querySelector: () => output }, setAttribute: (key: string, value: string) => attributes.set(key, value), addEventListener: (event: string, callback: () => void) => events.set(event, callback) } as unknown as HTMLInputElement
      const doc = { createElementNS: () => range } as unknown as Document
      translationOpacityControl(zotero, doc)
      const root = { dataset: {}, style: { setProperty: (key: string, value: string) => properties.set(key, value) }, ownerDocument: {}, querySelectorAll: (selector: string) => selector === "input[data-jdx-translation-opacity]" ? [range] : [] } as unknown as HTMLElement
      return { range, attributes, events, properties, output, stop: observeTheme(zotero, root) }
    }
    const first = makeWindow(), second = makeWindow()
    expect(first.range.value).toBe("20")
    first.range.value = "65"; first.events.get("input")!()
    expect(readTranslationOpacity(zotero)).toBe(35)
    for (const window of [first, second]) {
      expect(window.range.value).toBe("65")
      expect(window.attributes.get("aria-valuetext")).toBe("65% 透明")
      expect(window.output.textContent).toBe("65%")
      expect(window.properties.get("--jdx-window-opacity")).toBe("35%")
      expect(window.properties.get("--jdx-translation-opacity")).toBe("0.35")
      expect(window.properties.has("opacity")).toBe(false)
      window.stop(); window.stop()
    }
    expect(observers.size).toBe(0)
  })
})

describe("display language", () => {
  it("synchronizes pending selections between settings windows without changing active UI copy", () => {
    const { zotero, observers } = host("en-US")
    initializeUiLocale(zotero)
    const first = vi.fn(), second = vi.fn()
    const stopFirst = observeDisplayLanguage(zotero, first), stopSecond = observeDisplayLanguage(zotero, second)
    saveDisplayLanguage(zotero, "zh-CN")
    expect(first).toHaveBeenLastCalledWith("zh-CN")
    expect(second).toHaveBeenLastCalledWith("zh-CN")
    expect(getUiLocale()).toBe("en-US")
    stopFirst(); stopFirst(); stopSecond()
    expect(observers.size).toBe(0)
  })
  it("shares one restart-only snapshot across independently loaded bundles and reopened windows", async () => {
    const { zotero } = host("en-US")
    expect(initializeUiLocale(zotero)).toBe("en-US")
    expect(saveDisplayLanguage(zotero, "zh-CN")).toBe(true)
    expect(readDisplayLanguage(zotero)).toBe("zh-CN")
    expect(initializeUiLocale(zotero)).toBe("en-US")
    vi.resetModules()
    const otherBundle = await import("./ui-preferences")
    expect(otherBundle.initializeUiLocale(zotero)).toBe("en-US")
    expect(otherBundle.uiText("中文", "English")).toBe("English")
    const restarted = { locale: zotero.locale, Prefs: zotero.Prefs }
    expect(initializeUiLocale(restarted)).toBe("zh-CN")
    expect(getUiLocale()).toBe("zh-CN")
    expect(uiText("中文", "English")).toBe("中文")
  })

  it("follows the effective host locale, accepts invalid preferences, and contains unavailable persistence", () => {
    for (const [locale, expected] of [["zh-TW", "zh-CN"], ["fr-FR", "en-US"], [undefined, "en-US"]] as const) {
      expect(initializeUiLocale({ locale })).toBe(expected)
    }
    const { zotero, values } = host()
    values.set(DISPLAY_LANGUAGE_PREF, { future: true })
    expect(readDisplayLanguage(zotero)).toBe("system")
    expect(saveDisplayLanguage(zotero, "future-locale")).toBe(true)
    expect(values.get(DISPLAY_LANGUAGE_PREF)).toBe("system")
    expect(saveDisplayLanguage({ Prefs: { get: () => undefined, set: () => { throw Error("unavailable") } } }, "en-US")).toBe(false)
  })
})

describe("theme", () => {
  it("contains optional host media and observer failures", () => {
    const unavailable = () => { throw Error("window unavailable") }
    const root = { dataset: {}, style: {}, ownerDocument: { defaultView: { matchMedia: unavailable } } } as unknown as HTMLElement
    const prefs = { get: unavailable, registerObserver: unavailable, unregisterObserver: unavailable }
    expect(() => observeTheme({ Prefs: prefs, getMainWindow: unavailable }, root)()).not.toThrow()
    expect(root.dataset.theme).toBe("light")
    const brokenMedia = { get matches() { throw Error("unavailable") }, addEventListener: unavailable, removeEventListener: unavailable }
    const win = { matchMedia: () => brokenMedia } as unknown as Window & typeof globalThis
    expect(() => observeTheme({ getMainWindow: () => win }, root)()).not.toThrow()
    expect(root.dataset.theme).toBe("light")
  })
  it("inherits the real legacy pref branch only before a new preference exists", () => {
    const { zotero, values } = host()
    values.set("extensions.zotero.extensions.jadenseInZotero.managerThemeDark", true)
    expect(readTheme(zotero)).toBe("dark")
    expect(saveTheme(zotero, "system")).toBe(true)
    expect(values.get(THEME_PREF)).toBe("system")
    expect(readTheme(zotero)).toBe("system")
    values.set(THEME_PREF, "future-theme")
    expect(readTheme(zotero)).toBe("system")
  })

  it("updates both windows, respects explicit overrides, follows host changes, and removes listeners", () => {
    const { zotero, observers } = host()
    const callbacks = new Set<() => void>()
    const media = { matches: false, addEventListener: (_: string, cb: () => void) => callbacks.add(cb), removeEventListener: (_: string, cb: () => void) => callbacks.delete(cb) }
    const root = () => ({ dataset: {}, style: {}, ownerDocument: { defaultView: { matchMedia: () => media } } }) as unknown as HTMLElement
    const first = root(), second = root()
    const changed = vi.fn()
    const stopFirst = observeTheme(zotero, first, changed), stopSecond = observeTheme(zotero, second)
    expect(first.dataset.theme).toBe("light")
    saveTheme(zotero, "dark")
    expect([first.dataset.theme, second.dataset.theme]).toEqual(["dark", "dark"])
    zotero.Prefs!.set!("browser.theme.toolbar-theme", 1, true)
    expect(first.dataset.theme).toBe("dark")
    saveTheme(zotero, "system")
    expect(first.dataset.theme).toBe("light")
    zotero.Prefs!.set!("browser.theme.toolbar-theme", 0, true)
    expect(first.dataset.theme).toBe("dark")
    zotero.Prefs!.set!("browser.theme.toolbar-theme", 2, true)
    media.matches = true
    for (const callback of callbacks) callback()
    expect(first.dataset.theme).toBe("dark")
    stopFirst(); stopFirst(); stopSecond()
    expect(observers.size).toBe(0)
    expect(callbacks.size).toBe(0)
    expect(changed).toHaveBeenLastCalledWith(true)
  })
})
