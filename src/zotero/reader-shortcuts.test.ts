/** 快捷键回归：配置故障只影响自身，跨平台按键与输入焦点不会误触阅读操作。 */
import { describe, expect, it, vi } from "vitest"
import { formatReaderShortcut, matchesReaderShortcut, readReaderShortcut, readerShortcutFromEvent, READER_SHORTCUT_DEFAULTS, saveReaderShortcut } from "./reader-shortcuts"

function keyEvent(input: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "s", code: "KeyS", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false,
    repeat: false, isComposing: false, defaultPrevented: false, target: null,
    ...input,
  } as KeyboardEvent
}

describe("Reader shortcuts", () => {
  it("falls back for missing, corrupt and unavailable preferences, while retaining an explicit disabled shortcut", () => {
    expect(readReaderShortcut(null, "capture")).toBe("Mod+Alt+S")
    expect(readReaderShortcut({}, "translate")).toBe("Mod+Alt+T")
    for (const value of [undefined, 123, { future: true }, "Alt+", "mystery+T"]) {
      expect(readReaderShortcut({ Prefs: { get: () => value } }, "capture")).toBe(READER_SHORTCUT_DEFAULTS.capture)
    }
    expect(readReaderShortcut({ Prefs: { get: () => { throw new Error("unavailable") } } }, "translate")).toBe(READER_SHORTCUT_DEFAULTS.translate)
    expect(readReaderShortcut({ Prefs: { get: () => "" } }, "capture")).toBe("")
  })

  it("saves canonical chords and reads changes immediately without coupling the two actions", () => {
    const values = new Map<string, unknown>()
    const zotero = { Prefs: { get: (key: string) => values.get(key), set: (key: string, value: string) => values.set(key, value) } }
    expect(saveReaderShortcut(zotero, "capture", " Shift + Ctrl + y ")).toBe(true)
    expect(readReaderShortcut(zotero, "capture")).toBe("Ctrl+Shift+Y")
    expect(readReaderShortcut(zotero, "translate")).toBe("Mod+Alt+T")
    expect(matchesReaderShortcut(keyEvent(), readReaderShortcut(zotero, "capture"))).toBe(false)
    expect(matchesReaderShortcut(keyEvent({ key: "Y", code: "KeyY", altKey: false, shiftKey: true }), readReaderShortcut(zotero, "capture"))).toBe(true)
    saveReaderShortcut(zotero, "capture", "")
    expect(readReaderShortcut(zotero, "capture")).toBe("")
    expect(saveReaderShortcut({}, "capture", "Ctrl+Y")).toBe(false)
    expect(saveReaderShortcut({ Prefs: { get: vi.fn(), set: () => { throw new Error("unavailable") } } }, "capture", "Ctrl+Y")).toBe(false)
  })

  it("matches platform accelerators and the physical key even when Option changes its text", () => {
    expect(matchesReaderShortcut(keyEvent(), "Mod+Alt+S")).toBe(true)
    const mac = { navigator: { platform: "MacIntel" } } as Window
    const event = keyEvent({ key: "ß", ctrlKey: false, metaKey: true, view: mac })
    expect(matchesReaderShortcut(event, "Mod+Alt+S")).toBe(true)
    expect(readerShortcutFromEvent(event)).toBe("Meta+Alt+S")
    expect(formatReaderShortcut("Mod+Alt+S", "MacIntel")).toBe("Cmd + Alt + S")
    expect(formatReaderShortcut("Mod+Alt+S", "Win32")).toBe("Ctrl + Alt + S")
    expect(formatReaderShortcut("Ctrl+Alt+S", "MacIntel")).toBe("Ctrl + Alt + S")
  })

  it("ignores mismatched modifiers, consumed/repeated/composing events and editable targets", () => {
    for (const update of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: false }, { altKey: false }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) {
      expect(matchesReaderShortcut(keyEvent(update), "Mod+Alt+S")).toBe(false)
    }
    const input = { closest: () => ({ tagName: "INPUT" }) } as unknown as EventTarget
    const editor = { isContentEditable: true } as unknown as EventTarget
    expect(matchesReaderShortcut(keyEvent({ target: input }), "Mod+Alt+S")).toBe(false)
    expect(matchesReaderShortcut(keyEvent({ target: editor }), "Mod+Alt+S")).toBe(false)
    expect(matchesReaderShortcut(keyEvent(), "")).toBe(false)
    expect(readerShortcutFromEvent(keyEvent({ repeat: true }))).toBeNull()
    expect(readerShortcutFromEvent(keyEvent({ isComposing: true }))).toBeNull()
    expect(readerShortcutFromEvent(keyEvent({ key: "Control", code: "ControlLeft" }))).toBeNull()
    expect(readerShortcutFromEvent(keyEvent({ key: "F9", code: "F9", ctrlKey: false, altKey: false }))).toBe("F9")
  })
})
