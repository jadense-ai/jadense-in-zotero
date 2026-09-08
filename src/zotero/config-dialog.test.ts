import { describe, expect, it } from "vitest"

import { openConnectionSettings } from "./config-dialog"

describe("openConnectionSettings", () => {
  it("returns false when the settings window cannot open so prompt fallback can run", () => {
    const win = {
      open: () => null,
    } as unknown as Window & typeof globalThis

    expect(openConnectionSettings({} as never, win)).toBe(false)
  })
})
