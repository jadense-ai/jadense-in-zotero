import { describe, expect, it } from "vitest"
import { markManagerQuickStartShown, QUICK_START_SHOWN_PREF_KEY, shouldShowManagerQuickStart } from "./manager-quick-start"
import type { ZoteroLike } from "./runtime"

function fakeZotero(value?: unknown) {
  const values = new Map<string, unknown>(value === undefined ? [] : [[QUICK_START_SHOWN_PREF_KEY, value]])
  return {
    values,
    Prefs: { get: (key: string) => values.get(key), set: (key: string, next: unknown) => values.set(key, next) },
  } as ZoteroLike & { values: Map<string, unknown> }
}

describe("manager quick start", () => {
  it("shows once per Zotero profile and stores a local dismissal", () => {
    const zotero = fakeZotero()
    expect(shouldShowManagerQuickStart(zotero)).toBe(true)
    markManagerQuickStartShown(zotero)
    expect(zotero.values.get(QUICK_START_SHOWN_PREF_KEY)).toBe(true)
    expect(shouldShowManagerQuickStart(zotero)).toBe(false)
  })

  it("accepts the string form used by older preference stores", () => {
    expect(shouldShowManagerQuickStart(fakeZotero("true"))).toBe(false)
  })
})
