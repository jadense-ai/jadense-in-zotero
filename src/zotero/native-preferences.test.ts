import { describe, expect, it, vi } from "vitest"

import {
  JADENSE_PREFERENCES_PANE_ID,
  openPreferencesPane,
  registerPreferencesPane,
} from "./native-preferences"
import type { ZoteroLike } from "./runtime"

describe("native Zotero preferences", () => {
  it("registers the Jadense preferences pane", async () => {
    const register = vi.fn().mockResolvedValue("registered-pane")
    const zotero: ZoteroLike = {
      PreferencePanes: {
        register,
        unregister: vi.fn(),
      },
    }

    await expect(registerPreferencesPane(zotero, {
      pluginID: "plugin@example.com",
      rootURI: "jar:file:///plugin/",
    })).resolves.toBe("registered-pane")

    expect(register).toHaveBeenCalledWith({
      pluginID: "plugin@example.com",
      id: JADENSE_PREFERENCES_PANE_ID,
      label: "Jadense in Zotero",
      image: "jar:file:///plugin/content/icons/logo-padded.png",
      src: "jar:file:///plugin/content/preferences.xhtml",
      scripts: ["jar:file:///plugin/content/preferences.js"],
      stylesheets: ["jar:file:///plugin/content/preferences.css"],
    })
  })

  it("tries known Zotero preferences entry points", () => {
    const openPreferences = vi.fn()
    const zotero: ZoteroLike = {
      Utilities: {
        Internal: {
          openPreferences,
        },
      },
    }

    expect(openPreferencesPane(zotero, null)).toBe(true)
    expect(openPreferences).toHaveBeenCalledWith(JADENSE_PREFERENCES_PANE_ID)
  })

  it("returns false when no preferences entry point exists", () => {
    expect(openPreferencesPane({}, null)).toBe(false)
  })
})
