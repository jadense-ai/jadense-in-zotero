import { describe, expect, it, vi } from "vitest"
import { JSDOM } from "jsdom"
import * as runtime from "./runtime"

import {
  buildSyncPanelState,
  registerSyncPanel,
  renderSyncPanel,
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
      connectionLabel: "Jadense is disconnected",
      selectionLabels: ["None selected", "None selected"],
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
      stage: "connect",
      hintLabel: "连接账号后即可上传选中的文献。",
      folderLabel: "尚未选择",
      selectionLabels: ["未选中", "未选中"],
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

  it("keeps the saved upload destination usable with an absent, outdated or damaged name cache", () => {
    const zotero = fakeZotero({ token: "fixture", defaultFolderId: "saved", selectedItems: [{}] })
    for (const cache of ["", "{broken", JSON.stringify({ folders: [{ id: "previous", name: "Old destination" }] })]) {
      zotero.Prefs!.set("extensions.jadenseInZotero.favoriteFoldersCache", cache)
      expect(buildSyncPanelState(zotero)).toMatchObject({ folderLabel: "saved", canExportItems: true })
    }
  })

  it("takes setup to the right window and updates the mounted panel when upload preferences change", async () => {
    const dom = new JSDOM("<div id='host'></div>")
    const doc = dom.window.document
    const body = doc.getElementById("host") as HTMLDivElement
    const zotero = fakeZotero({ selectedItems: [{}, {}], selectedCollection: { name: "Research" } })
    const observers = new Map<string, () => void>()
    zotero.Prefs!.registerObserver = (key, update) => { observers.set(key, update); return key }
    zotero.Prefs!.unregisterObserver = id => { observers.delete(String(id)) }
    const setPref = (key: string, value: unknown) => {
      const name = "extensions.jadenseInZotero." + key
      zotero.Prefs!.set(name, value); observers.get(name)?.()
    }
    const callbacks = { openConnection: vi.fn(), openUploadDestination: vi.fn(), openManager: vi.fn() }
    const itemsUpload = vi.spyOn(runtime, "pushSelectedItemsToJadense").mockRejectedValue(new Error("upload fixture"))
    const collectionUpload = vi.spyOn(runtime, "pushSelectedCollectionToJadense").mockRejectedValue(new Error("collection fixture"))
    const control = (key: string) => body.querySelector<HTMLButtonElement>(`[data-sync-action="${key}"]`)!
    try {
      renderSyncPanel({ doc, body, zotero, callbacks })
      const panel = body.querySelector<HTMLElement>(".jdx-sync-panel")!
      expect(panel.dataset.state).toBe("connect")
      control("connect").click()
      expect(callbacks.openConnection).toHaveBeenCalledOnce()
      setPref("token", "fixture")
      expect(panel.dataset.state).toBe("folder")
      expect(control("folder").textContent).toBe("选择目标收藏夹")
      control("folder").click()
      expect(callbacks.openUploadDestination).toHaveBeenCalledOnce()
      setPref("favoriteFoldersCache", JSON.stringify({ folders: [{ id: "saved", name: "研究方法" }] }))
      setPref("defaultFolderId", "saved")
      expect(panel.dataset.state).toBe("ready")
      expect(body.querySelector('[data-sync-field="destination"]')?.textContent).toBe("研究方法")
      expect(panel.querySelector("h2")?.textContent).toBe("已选 2 个条目")
      expect(panel.querySelectorAll("dl > div:not([hidden])")).toHaveLength(1)
      expect(panel.querySelector("dl > div:not([hidden])")?.getAttribute("data-row")).toBe("destination")
      expect(control("items").dataset.primary).toBe("true")
      expect(control("collection").dataset.primary).toBe("false")
      control("change-folder").click()
      expect(callbacks.openUploadDestination).toHaveBeenCalledTimes(2)
      setPref("collectionUploadIncludePdf", true)
      expect(body.querySelector('[data-sync-field="pdf"]')?.textContent).toContain("PDF")
      expect(control("items").textContent).toBe("上传 2 个条目（含 PDF）")
      expect(control("collection").textContent).toContain("含 PDF")
      control("items").click()
      await vi.waitFor(() => expect(body.querySelector('[role="status"]')?.textContent).toBe("upload fixture"))
      expect(itemsUpload).toHaveBeenCalledWith(zotero, { includePdf: true })
      setPref("collectionUploadIncludePdf", false)
      expect(body.querySelector('[data-sync-field="pdf"]')?.textContent).toBe("仅题录")
      expect(control("items").textContent).toBe("上传 2 个条目（仅题录）")
      expect(control("collection").textContent).toContain("仅题录")
      control("collection").click()
      await vi.waitFor(() => expect(body.querySelector('[role="status"]')?.textContent).toBe("collection fixture"))
      expect(collectionUpload).toHaveBeenCalledWith(zotero, { includePdf: false })
      expect(callbacks.openManager).not.toHaveBeenCalled()
      control("workspace").click()
      expect(callbacks.openManager).toHaveBeenCalledOnce()
      dom.window.dispatchEvent(new dom.window.Event("unload"))
      expect(observers.size).toBe(0)
    } finally {
      vi.restoreAllMocks()
      dom.window.close()
    }
  })

  it("emphasizes collection upload when only a collection is selected, and explains an empty selection", () => {
    const dom = new JSDOM("<div id='host'></div>")
    const doc = dom.window.document
    const body = doc.getElementById("host") as HTMLDivElement
    const ready = { token: "fixture", defaultFolderId: "saved" }
    renderSyncPanel({ doc, body, zotero: fakeZotero({ ...ready, selectedCollection: { name: "Research" } }) })
    expect(body.querySelector('[data-primary="true"]:enabled:not([hidden])')?.getAttribute("data-sync-action")).toBe("collection")
    expect(body.querySelector(".jdx-sync-actions")?.firstElementChild?.getAttribute("data-sync-action")).toBe("collection")
    renderSyncPanel({ doc, body, zotero: fakeZotero(ready) })
    expect(body.querySelector(".jdx-sync-panel")?.getAttribute("data-state")).toBe("no-selection")
    expect(body.querySelector("[data-sync-action=items]:disabled")).toBeTruthy()
    expect(body.querySelector("[data-sync-action=collection]:disabled")).toBeTruthy()
    expect(body.querySelector(".jdx-sync-hint")?.textContent).toContain("选择条目或分类")
    dom.window.dispatchEvent(new dom.window.Event("unload"))
    dom.window.close()
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
