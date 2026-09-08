import { describe, expect, it, vi } from "vitest"

import {
  chromeContentUrl,
  ensureJadenseLocalization,
  JADENSE_CHROME_ENTRIES,
  pluginResourceUrl,
  registerChromeContent,
  unregisterChromeContent,
} from "./chrome-registration"

describe("chrome content registration", () => {
  it("loads the Jadense Fluent resource into a Zotero main window", () => {
    const insertFTLIfNeeded = vi.fn()
    const window = {
      MozXULElement: { insertFTLIfNeeded },
    } as unknown as Window & typeof globalThis

    expect(ensureJadenseLocalization(window)).toBe(true)
    expect(ensureJadenseLocalization(window)).toBe(true)
    expect(insertFTLIfNeeded).toHaveBeenCalledTimes(2)
    expect(insertFTLIfNeeded).toHaveBeenNthCalledWith(1, "jadense-in-zotero.ftl")
    expect(insertFTLIfNeeded).toHaveBeenNthCalledWith(2, "jadense-in-zotero.ftl")
  })

  it("reports unavailable Fluent loading without throwing", () => {
    expect(ensureJadenseLocalization(null)).toBe(false)
    expect(ensureJadenseLocalization({} as Window & typeof globalThis)).toBe(false)
  })

  it("builds chrome content URLs", () => {
    expect(chromeContentUrl("manager.xhtml")).toBe("chrome://jadense-in-zotero/content/manager.xhtml")
    expect(chromeContentUrl("/preferences.js")).toBe("chrome://jadense-in-zotero/content/preferences.js")
  })

  it("builds plugin-root resource URLs when Zotero provides rootURI", () => {
    expect(pluginResourceUrl("jar:file:///plugin.xpi!/", "content/manager.xhtml"))
      .toBe("jar:file:///plugin.xpi!/content/manager.xhtml")
    expect(pluginResourceUrl("jar:file:///plugin.xpi!/", "/icons/jadense-24.svg"))
      .toBe("jar:file:///plugin.xpi!/icons/jadense-24.svg")
  })

  it("falls back to registered chrome content URLs when rootURI is unavailable", () => {
    expect(pluginResourceUrl("", "content/manager.xhtml"))
      .toBe("chrome://jadense-in-zotero/content/manager.xhtml")
    expect(pluginResourceUrl("", "icons/jadense-24.svg")).toBe("icons/jadense-24.svg")
  })

  it("registers the content package against the plugin manifest URI", () => {
    const handle = { destruct: vi.fn() }
    const registerChrome = vi.fn().mockReturnValue(handle)
    const manifestURI = { spec: "jar:file:///plugin.xpi!/manifest.json" }
    const newURI = vi.fn().mockReturnValue(manifestURI)

    expect(registerChromeContent("jar:file:///plugin.xpi!/", {
      Cc: {
        "@mozilla.org/addons/addon-manager-startup;1": {
          getService: vi.fn().mockReturnValue({ registerChrome }),
        },
      },
      Ci: { amIAddonManagerStartup: {} },
      Services: { io: { newURI } },
    })).toBe(handle)

    expect(newURI).toHaveBeenCalledWith("jar:file:///plugin.xpi!/manifest.json")
    expect(registerChrome).toHaveBeenCalledWith(manifestURI, JADENSE_CHROME_ENTRIES)
    expect(JADENSE_CHROME_ENTRIES).toEqual([
      ["content", "jadense-in-zotero", "content/"],
    ])

    unregisterChromeContent(handle)
    expect(handle.destruct).toHaveBeenCalled()
  })

  it("resolves Cc and Ci through Components when the sandbox omits the globals", () => {
    const handle = { destruct: vi.fn() }
    const registerChrome = vi.fn().mockReturnValue(handle)
    const manifestURI = { spec: "jar:file:///plugin.xpi!/manifest.json" }
    const newURI = vi.fn().mockReturnValue(manifestURI)

    expect(registerChromeContent("jar:file:///plugin.xpi!/", {
      Components: {
        classes: {
          "@mozilla.org/addons/addon-manager-startup;1": {
            getService: vi.fn().mockReturnValue({ registerChrome }),
          },
        },
        interfaces: { amIAddonManagerStartup: {} },
      },
      Services: { io: { newURI } },
    })).toBe(handle)

    expect(registerChrome).toHaveBeenCalledWith(manifestURI, JADENSE_CHROME_ENTRIES)
  })

  it("imports Services through ChromeUtils when Zotero does not expose it globally", () => {
    const handle = { destruct: vi.fn() }
    const registerChrome = vi.fn().mockReturnValue(handle)
    const manifestURI = { spec: "jar:file:///plugin.xpi!/manifest.json" }
    const newURI = vi.fn().mockReturnValue(manifestURI)
    const importESModule = vi.fn().mockReturnValue({ Services: { io: { newURI } } })

    expect(registerChromeContent("jar:file:///plugin.xpi!/", {
      Cc: {
        "@mozilla.org/addons/addon-manager-startup;1": {
          getService: vi.fn().mockReturnValue({ registerChrome }),
        },
      },
      Ci: { amIAddonManagerStartup: {} },
      ChromeUtils: { importESModule },
    })).toBe(handle)

    expect(importESModule).toHaveBeenCalledWith("resource://gre/modules/Services.sys.mjs")
    expect(registerChrome).toHaveBeenCalledWith(manifestURI, JADENSE_CHROME_ENTRIES)
  })
})
