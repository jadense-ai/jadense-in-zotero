import { describe, expect, it, vi } from "vitest"

import {
  JADENSE_PREFERENCES_PANE_ID,
  openPreferencesPane,
  registerPreferencesPane,
} from "./native-preferences"
import type { ZoteroLike } from "./runtime"

describe("native Zotero preferences", () => {
  it('versions native resources for a rebuilt package, including the CSS import owner', async () => {
    vi.stubGlobal('__JADENSE_BUILD_ID__', 'same-version-rebuild')
    const register = vi.fn().mockResolvedValue('pane')
    try {
      await registerPreferencesPane({ PreferencePanes: { register } } as ZoteroLike, { pluginID: 'fixture', rootURI: 'jar:file:///plugin/' })
      expect(register).toHaveBeenCalledWith(expect.objectContaining({
        src: 'jar:file:///plugin/content/preferences.xhtml?v=same-version-rebuild',
        scripts: ['jar:file:///plugin/content/preferences.js?v=same-version-rebuild'],
        stylesheets: ['jar:file:///plugin/content/preferences.css?v=same-version-rebuild'],
      }))
    } finally { vi.unstubAllGlobals() }
  })
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
