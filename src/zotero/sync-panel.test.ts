import { describe, expect, it, vi } from "vitest"

import {
  buildSyncPanelState,
  registerSyncPanel,
  summarizeZoteroSelection,
  unregisterSyncPanel,
} from "./sync-panel"
import type { ZoteroLike } from "./runtime"
import { initializeUiLocale } from "./ui-preferences"

function fakeZotero(input: {
  token?: string
  defaultFolderId?: string
  includePdf?: boolean
  selectedItems?: unknown[]
  selectedCollection?: unknown
  selectedCollections?: unknown[]
  singularCollectionThrows?: boolean
}): ZoteroLike {
  const prefs = new Map<string, unknown>([
    ["extensions.jadenseInZotero.baseUrl", "https://jadense.cn"],
  ])
  if (input.token) prefs.set("extensions.jadenseInZotero.token", input.token)
  if (input.defaultFolderId) prefs.set("extensions.jadenseInZotero.defaultFolderId", input.defaultFolderId)
  if (input.includePdf) prefs.set("extensions.jadenseInZotero.collectionUploadIncludePdf", true)

  return {
    Prefs: {
      get: (key) => prefs.get(key),
      set: (key, value) => prefs.set(key, value),
      clear: (key) => prefs.delete(key),
    },
    getActiveZoteroPane: () => ({
      getSelectedItems: () => input.selectedItems ?? [],
      ...(input.selectedCollections ? { getSelectedCollections: () => input.selectedCollections } : {}),
      getSelectedCollection: () => {
        if (input.singularCollectionThrows) throw new Error("Use getSelectedCollections")
        return input.selectedCollection ?? null
      },
    }),
  }
}

describe("sync panel state", () => {
  it("renders native panel content in the startup display language", () => {
    initializeUiLocale({ locale: "en-US" })
    expect(buildSyncPanelState(fakeZotero({}))).toMatchObject({
      managerActionLabel: "Open Jadense Workspace",
      connectionLabel: "No Jadense token. Open Connect Jadense.",
      selectionLabels: ["No collection selected", "No items selected"],
    })
    initializeUiLocale({ locale: "zh-CN" })
  })
  it("summarizes Zotero selection", () => {
    expect(summarizeZoteroSelection(fakeZotero({
      selectedItems: [{ id: 1 }, { id: 2 }],
      selectedCollection: { name: "Reading List" },
    }))).toEqual({
      selectedItemCount: 2,
      hasSelectedCollection: true,
      collectionName: "Reading List",
    })
  })

  it("uses Zotero 10's plural collection API without touching the throwing singular getter", () => {
    expect(summarizeZoteroSelection(fakeZotero({
      selectedCollections: [{ name: "One" }, { name: "Two" }],
      singularCollectionThrows: true,
    }))).toMatchObject({ hasSelectedCollection: true, collectionName: "2 个分类" })
  })

  it("disables actions when connection is missing", () => {
    expect(buildSyncPanelState(fakeZotero({}))).toMatchObject({
      managerActionLabel: "打开攻玉工作台",
      connected: false,
      canExportItems: false,
      canExportCollection: false,
      hintLabel: "在攻玉工作台中对话，或将 Zotero 文献单向上传到攻玉。",
      connectionLabel: "未配置攻玉令牌，请打开「连接攻玉」",
      folderLabel: "未设置默认收藏夹",
      selectionLabels: ["未选中分类", "未选中条目"],
    })
  })

  it("enables actions when connection and Zotero selection are ready", () => {
    expect(buildSyncPanelState(fakeZotero({
      token: "jdx_ext_secret",
      defaultFolderId: "folder-1",
      includePdf: true,
      selectedItems: [{ id: 1 }],
      selectedCollection: { name: "Root" },
    }))).toMatchObject({
      connected: true,
      defaultFolderId: "folder-1",
      includePdfDefault: true,
      canExportItems: true,
      canExportCollection: true,
    })
  })

  it("tracks the stable pane id when Zotero registerSection returns undefined", () => {
    const registerSection = vi.fn().mockReturnValue(undefined)
    const unregisterSection = vi.fn()
    const zotero: ZoteroLike = {
      ItemPaneManager: {
        registerSection,
        unregisterSection,
      },
    }

    const paneID = registerSyncPanel(zotero, {
      pluginID: "plugin@example.com",
      rootURI: "chrome://jadense-in-zotero/",
    })
    expect(paneID).toBe("plugin@example.com-jadense-in-zotero-sync-panel")
    expect(registerSection).toHaveBeenCalledWith(expect.objectContaining({
      header: {
        l10nArgs: JSON.stringify({ language: "zh-CN" }),
        l10nID: "jadense-in-zotero-panel-header",
        icon: "chrome://jadense-in-zotero/icons/jadense-16.svg",
      },
      sidenav: {
        l10nArgs: JSON.stringify({ language: "zh-CN" }),
        l10nID: "jadense-in-zotero-panel-sidenav",
        icon: "chrome://jadense-in-zotero/icons/jadense-20.svg",
      },
    }))

    unregisterSyncPanel(zotero, paneID, "plugin@example.com")
    expect(unregisterSection).toHaveBeenCalledWith("plugin@example.com-jadense-in-zotero-sync-panel")
    expect(unregisterSection).not.toHaveBeenCalledWith("jadense-in-zotero-sync-panel")
  })
})
