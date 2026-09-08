import { describe, expect, it, vi } from "vitest"

import {
  buildJadenseMenuRegistrations,
  registerNativeMenus,
  unregisterNativeMenus,
  type MenuCallbacks,
} from "./native-menus"
import type { ZoteroLike } from "./runtime"

function callbacks(): MenuCallbacks {
  return {
    openManager: vi.fn(),
    configureConnection: vi.fn(),
    exportSelectedItems: vi.fn(),
    exportSelectedCollection: vi.fn(),
    disconnect: vi.fn(),
  }
}

describe("native Zotero menus", () => {
  it("builds Tools and collection context menu registrations", () => {
    const registrations = buildJadenseMenuRegistrations("plugin@example.com", callbacks())

    expect(registrations.map((registration) => registration.target)).toEqual([
      "main/menubar/tools",
      "main/library/collection",
    ])
    expect(registrations[0]).toMatchObject({
      menuID: "jadense-in-zotero-tools-menu",
      pluginID: "plugin@example.com",
    })
    expect(registrations[0]?.menus[0]).toMatchObject({
      menuType: "submenu",
      l10nID: "jadense-in-zotero-menu-main",
    })
    expect(registrations[0]?.menus[0]?.menus?.map((menu) => menu.l10nID)).toEqual([
      "jadense-in-zotero-menu-open-manager",
      "jadense-in-zotero-menu-configure",
      undefined,
      "jadense-in-zotero-menu-export-collection",
      "jadense-in-zotero-menu-export-items",
      undefined,
      "jadense-in-zotero-menu-disconnect",
    ])
    expect(JSON.stringify(registrations)).not.toContain('"label"')
    expect(registrations[1]?.menus).toHaveLength(1)
    expect(registrations[1]?.menus[0]).toMatchObject({
      menuType: "submenu",
      l10nID: "jadense-in-zotero-menu-main",
    })
    expect(registrations[1]?.menus[0]?.menus?.map((menu) => menu.l10nID)).toEqual([
      "jadense-in-zotero-menu-open-manager",
      undefined,
      "jadense-in-zotero-menu-export-collection",
    ])
  })

  it("registers and unregisters through Zotero MenuManager", () => {
    const registerMenu = vi.fn()
      .mockReturnValueOnce("registered-tools")
      .mockReturnValueOnce("registered-collection")
    const unregisterMenu = vi.fn()
    const zotero: ZoteroLike = {
      MenuManager: {
        registerMenu,
        unregisterMenu,
      },
    }

    const registered = registerNativeMenus(zotero, "plugin@example.com", callbacks())
    expect(registered).toEqual(["registered-tools", "registered-collection"])
    expect(registerMenu).toHaveBeenCalledTimes(2)

    unregisterNativeMenus(zotero, registered)
    expect(unregisterMenu).toHaveBeenCalledWith("registered-tools")
    expect(unregisterMenu).toHaveBeenCalledWith("registered-collection")
  })

  it("tracks menu ids when Zotero registerMenu returns undefined", () => {
    const registerMenu = vi.fn().mockReturnValue(undefined)
    const unregisterMenu = vi.fn()
    const zotero: ZoteroLike = {
      MenuManager: {
        registerMenu,
        unregisterMenu,
      },
    }

    const registered = registerNativeMenus(zotero, "plugin@example.com", callbacks())
    expect(registered).toEqual([
      "plugin@example.com-jadense-in-zotero-tools-menu",
      "plugin@example.com-jadense-in-zotero-collection-menu",
    ])

    unregisterNativeMenus(zotero, registered, "plugin@example.com")
    expect(unregisterMenu).toHaveBeenCalledWith("plugin@example.com-jadense-in-zotero-tools-menu")
    expect(unregisterMenu).not.toHaveBeenCalledWith("jadense-in-zotero-tools-menu")
  })
})
