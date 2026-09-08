/**
 * Zotero 原生入口的 Fluent 契约测试。
 * 上游枚举真实菜单与面板注册，下游确保 XPI 的中英文资源都包含每个可见 l10nID。
 */
import { readFileSync } from "node:fs"

import { describe, expect, it, vi } from "vitest"

import { buildJadenseMenuRegistrations, type MenuCallbacks } from "./native-menus"
import type { ZoteroLike, ZoteroMenuItem } from "./runtime"
import { registerSyncPanel } from "./sync-panel"

const LOCALES = ["en-US", "zh-CN"] as const

function callbacks(): MenuCallbacks {
  return {
    openManager: vi.fn(),
    configureConnection: vi.fn(),
    exportSelectedItems: vi.fn(),
    exportSelectedCollection: vi.fn(),
    disconnect: vi.fn(),
  }
}

function collectMenuLocalizationIds(items: ZoteroMenuItem[]): string[] {
  return items.flatMap((item) => [
    ...(item.l10nID ? [item.l10nID] : []),
    ...collectMenuLocalizationIds(item.menus ?? []),
  ])
}

describe("native Zotero localization contract", () => {
  it("defines every registered menu and item-pane l10nID in both locales", () => {
    const menuIds = buildJadenseMenuRegistrations("plugin@example.com", callbacks())
      .flatMap((registration) => collectMenuLocalizationIds(registration.menus))
    const registerSection = vi.fn()
    const zotero: ZoteroLike = {
      ItemPaneManager: { registerSection },
    }
    registerSyncPanel(zotero, {
      pluginID: "plugin@example.com",
      rootURI: "chrome://jadense-in-zotero/",
    })
    const section = registerSection.mock.calls[0]?.[0] as {
      header: { l10nID: string }
      sidenav: { l10nID: string }
    }
    const expectedIds = new Set([
      ...menuIds,
      section.header.l10nID,
      section.sidenav.l10nID,
    ])

    for (const locale of LOCALES) {
      const source = readFileSync(
        new URL(`../../locale/${locale}/jadense-in-zotero.ftl`, import.meta.url),
        "utf8",
      )
      for (const id of expectedIds) {
        expect(source, `${locale} is missing ${id}`).toMatch(new RegExp(`^${id}\\s*=`, "m"))
      }
    }
  })
})
