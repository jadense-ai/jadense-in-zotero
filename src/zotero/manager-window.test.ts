import { describe, expect, it, vi } from "vitest"

import {
  managerWindowUrl,
  closeManagerWindow,
  openManagerWindow,
  type ZoteroManagerWindow,
} from "./manager-window"
import type { ZoteroLike } from "./runtime"

describe("manager window helpers", () => {
  it.each(["document", "closed"])("discards a cached window with dead %s and opens one replacement with the original action", property => {
    const dead = { closed: false, document: { readyState: "complete" }, focus: vi.fn(), receiveJadenseContext: vi.fn() }
    const replacement = { closed: false, focus: vi.fn() }
    const openDialog = vi.fn().mockReturnValueOnce(dead).mockReturnValue(replacement)
    const input = { zotero: {}, win: { openDialog } as unknown as ZoteroManagerWindow, context: { pluginID: "fixture", rootURI: "" } }
    openManagerWindow(input)
    Object.defineProperty(dead, property, { get() { throw new TypeError("Synthetic dead window property") } })
    dead.focus.mockImplementation(() => { throw new TypeError("Synthetic dead window") })
    const action = { kind: "analyze" as const, itemID: 2 }
    expect(openManagerWindow({ ...input, section: "analysis", action })).toBe(true)
    expect(openDialog).toHaveBeenCalledTimes(2)
    expect(openDialog.mock.calls[1][3].actions).toEqual([action])
    expect(dead.receiveJadenseContext).not.toHaveBeenCalled()
  })

  it("skips dead registry entries and uses the current native window instead of stale callbacks", () => {
    const stale = { closed: false, document: { readyState: "complete" }, focus: vi.fn(), receiveJadenseContext: vi.fn() }
    const current = { closed: false, location: { href: managerWindowUrl({ pluginID: "fixture", rootURI: "" }) }, focus: vi.fn(), receiveJadenseContext: vi.fn() }
    const dead = { get closed(): boolean { throw new TypeError("Synthetic dead registry window") } }
    const openDialog = vi.fn().mockReturnValue(stale)
    const input = { zotero: {}, win: { openDialog } as unknown as ZoteroManagerWindow, context: { pluginID: "fixture", rootURI: "" } }
    openManagerWindow(input)
    vi.stubGlobal("Services", { wm: { getEnumerator: () => { const entries = [dead, current]; return { hasMoreElements: () => entries.length > 0, getNext: () => entries.shift() } } } })
    try {
      expect(openManagerWindow({ ...input, action: { kind: "analyze", itemID: 2 } })).toBe(true)
      expect(current.receiveJadenseContext).toHaveBeenCalledOnce()
      expect(stale.receiveJadenseContext).not.toHaveBeenCalled()
      expect(openDialog).toHaveBeenCalledOnce()
    } finally { vi.unstubAllGlobals() }
  })

  it.each(["throws", "missing"])("recovers %s focus through the host without delivering the analysis twice", fault => {
    const manager = { closed: false, document: { readyState: "complete" }, focus: vi.fn(), receiveJadenseContext: vi.fn(), restore: vi.fn() }
    const openDialog = vi.fn().mockReturnValue(manager), nativeFocus = { focusedWindow: null as unknown }
    // Gecko 的 activeWindow 只读；只有 focusedWindow 能发起宿主焦点恢复。
    Object.defineProperty(nativeFocus, "activeWindow", { get: () => null })
    const input = { zotero: {}, win: { openDialog } as unknown as ZoteroManagerWindow, context: { pluginID: "fixture", rootURI: "" } }
    openManagerWindow(input)
    if (fault === "throws") manager.focus.mockImplementation(() => { throw new TypeError("Synthetic focus failure") })
    else Object.defineProperty(manager, "focus", { value: undefined })
    vi.stubGlobal("Services", { focus: nativeFocus })
    try {
      expect(openManagerWindow({ ...input, action: { kind: "analyze", itemID: 2 } })).toBe(true)
      expect(nativeFocus.focusedWindow).toBe(manager)
      expect(manager.receiveJadenseContext).toHaveBeenCalledOnce()
      expect(openDialog).toHaveBeenCalledOnce()
      expect(manager.restore).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it("does not open a second window when a newly created window cannot focus", () => {
    const manager = { closed: false, focus: vi.fn(() => { throw new TypeError("Synthetic focus failure") }) }
    const openDialog = vi.fn().mockReturnValue(manager), open = vi.fn()
    expect(openManagerWindow({ zotero: {}, win: { openDialog, open } as unknown as ZoteroManagerWindow,
      context: { pluginID: "fixture", rootURI: "" }, action: { kind: "analyze", itemID: 2 } })).toBe(true)
    expect(openDialog).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })

  it("keeps a delivered action successful when native focus and optional diagnostics both fail", () => {
    const manager = { closed: false, focus: vi.fn(), receiveJadenseContext: vi.fn() }
    const zotero = { __jadenseDiagnostics: { record: vi.fn(() => { throw new Error("Synthetic diagnostic failure") }) } }
    const openDialog = vi.fn().mockReturnValue(manager)
    const input = { zotero, win: { openDialog } as unknown as ZoteroManagerWindow, context: { pluginID: "fixture", rootURI: "" } }
    openManagerWindow(input)
    manager.focus.mockImplementation(() => { throw new TypeError("Synthetic focus failure") })
    const focus = Object.defineProperty({}, "focusedWindow", { set() { throw new TypeError("Synthetic host focus failure") } })
    vi.stubGlobal("Services", { focus })
    try {
      expect(openManagerWindow({ ...input, action: { kind: "analyze", itemID: 2 } })).toBe(true)
      expect(manager.receiveJadenseContext).toHaveBeenCalledOnce()
      expect(openDialog).toHaveBeenCalledOnce()
    } finally { vi.unstubAllGlobals() }
  })

  it("contains callback failure without replaying an action that may already have started", () => {
    const receiveJadenseContext = vi.fn(() => { throw new TypeError("Synthetic failure after handoff") })
    const manager = { closed: false, focus: vi.fn(), receiveJadenseContext }
    const openDialog = vi.fn().mockReturnValue(manager)
    const input = { zotero: {}, win: { openDialog } as unknown as ZoteroManagerWindow, context: { pluginID: "fixture", rootURI: "" } }
    openManagerWindow(input)
    expect(openManagerWindow({ ...input, action: { kind: "analyze", itemID: 2 } })).toBe(false)
    expect(receiveJadenseContext).toHaveBeenCalledOnce()
    expect(openDialog).toHaveBeenCalledOnce()
    expect(manager.focus).toHaveBeenCalledTimes(2)
  })

  it("clears dead cached windows on shutdown without throwing", () => {
    const manager = { closed: false, focus: vi.fn() }
    const openDialog = vi.fn().mockReturnValue(manager), zotero = {}
    openManagerWindow({ zotero, win: { openDialog } as unknown as ZoteroManagerWindow, context: { pluginID: "fixture", rootURI: "" } })
    Object.defineProperty(manager, "JadenseInZotero", { get() { throw new TypeError("Synthetic dead context") } })
    expect(() => closeManagerWindow(zotero)).not.toThrow()
    openDialog.mockReturnValue({ focus: vi.fn() })
    expect(openManagerWindow({ zotero, win: { openDialog } as unknown as ZoteroManagerWindow, context: { pluginID: "fixture", rootURI: "" } })).toBe(true)
    expect(openDialog).toHaveBeenCalledTimes(2)
  })

  it("recovers a reloaded Manager from the native window registry without opening another window", () => {
    const receiveJadenseContext = vi.fn(), opened = { closed: false, location: { href: "chrome://jadense-in-zotero/content/manager.xhtml?section=chat" }, focus: vi.fn(), receiveJadenseContext }
    const openDialog = vi.fn(); let read = false
    vi.stubGlobal("Services", { wm: { getEnumerator: () => ({ hasMoreElements: () => !read, getNext: () => { read = true; return opened } }) } })
    try {
      openManagerWindow({ zotero: {}, win: { openDialog } as unknown as ZoteroManagerWindow, context: { pluginID: "fixture", rootURI: "" }, section: "analysis", action: { kind: "references", itemID: 2 } })
      expect(openDialog).not.toHaveBeenCalled(); expect(receiveJadenseContext).toHaveBeenCalledWith(expect.objectContaining({ actions: [{ kind: "references", itemID: 2 }] }))
    } finally { vi.unstubAllGlobals() }
  })
  it("builds an internal manager resource URL with a section", () => {
    expect(managerWindowUrl({
      pluginID: "plugin@example.com",
      rootURI: "chrome://jadense-in-zotero/",
    }, "settings")).toBe("chrome://jadense-in-zotero/content/manager.xhtml?section=settings")
  })

  it("opens installed XPI manager windows through the registered chrome content URL", () => {
    expect(managerWindowUrl({
      pluginID: "plugin@example.com",
      rootURI: "jar:file:///plugin.xpi!/",
    }, "settings")).toBe("chrome://jadense-in-zotero/content/manager.xhtml?section=settings")
  })

  it("opens the manager as a resizable chrome window with native titlebar controls and runtime context", () => {
    const focus = vi.fn()
    const opened = { focus }
    const openDialog = vi.fn().mockReturnValue(opened)
    const zotero: ZoteroLike = {}
    const win = { openDialog } as unknown as ZoteroManagerWindow

    expect(openManagerWindow({
      zotero,
      win,
      context: {
        pluginID: "plugin@example.com",
        rootURI: "chrome://jadense-in-zotero/",
      },
      section: "settings",
    })).toBe(true)

    expect(openDialog).toHaveBeenCalledWith(
      "chrome://jadense-in-zotero/content/manager.xhtml?section=settings",
      "jadense-in-zotero-manager",
      expect.stringContaining("width=1360"),
      { zotero, section: "settings", pluginID: "plugin@example.com" },
    )
    expect(openDialog.mock.calls[0]?.[2].split(",")).toEqual(expect.arrayContaining([
      "chrome", "dialog=no", "titlebar", "resizable", "width=1360", "height=860",
    ]))
    expect(focus).toHaveBeenCalled()
  })

  it("falls back to a normal named window when openDialog is unavailable", () => {
    const focus = vi.fn()
    const open = vi.fn().mockReturnValue({ focus })
    const win = { open } as unknown as ZoteroManagerWindow

    expect(openManagerWindow({
      zotero: {},
      win,
      context: {
        pluginID: "plugin@example.com",
        rootURI: "",
      },
      section: "chat",
    })).toBe(true)

    expect(open).toHaveBeenCalledWith(
      "chrome://jadense-in-zotero/content/manager.xhtml?section=chat",
      "jadense-in-zotero-manager",
      expect.stringContaining("width=1360,height=860"),
    )
    expect(focus).toHaveBeenCalled()
  })

  it("keeps figure bytes across initial navigation and clears them only after the manager page unloads", () => {
    const dataUrl = "data:image/png;base64,private-figure-bytes"
    let onLoad: (() => void) | undefined
    let onUnload: (() => void) | undefined
    const opened = {
      location: { href: "about:blank" },
      focus: vi.fn(),
      addEventListener: vi.fn((name: string, listener: () => void) => {
        if (name === "load") onLoad = listener
        if (name === "unload") onUnload = listener
      }),
      removeEventListener: vi.fn(),
    }
    const openDialog = vi.fn().mockReturnValue(opened)
    const zotero: ZoteroLike = {}
    openManagerWindow({
      zotero,
      win: { openDialog } as unknown as ZoteroManagerWindow,
      context: { pluginID: "test", rootURI: "" },
      action: {
        kind: "interpretFigure",
        conversationTarget: "new",
        itemID: 8,
        pageIndex: 2,
        image: { dataUrl, mimeType: "image/png", name: "figure.png" },
      },
    })

    expect(openDialog.mock.calls[0][0]).toBe("chrome://jadense-in-zotero/content/manager.xhtml?section=chat")
    expect(openDialog.mock.calls[0][0]).not.toContain(dataUrl)
    expect(openDialog.mock.calls[0][3]).toMatchObject({
      actions: [{ kind: "interpretFigure", conversationTarget: "new", image: { dataUrl } }],
    })

    onUnload?.()
    expect(openDialog.mock.calls[0][3].actions).toMatchObject([
      { kind: "interpretFigure", conversationTarget: "new", image: { dataUrl } },
    ])

    opened.location.href = "chrome://jadense-in-zotero/content/manager.xhtml?section=chat"
    onLoad?.()
    onUnload?.()
    expect(openDialog.mock.calls[0][3].actions).toBeUndefined()
    expect((opened as typeof opened & { JadenseInZotero?: unknown }).JadenseInZotero).toBeUndefined()
  })

  it("keeps the migrate section id as the internal route for the visible connection page", () => {
    expect(managerWindowUrl({
      pluginID: "plugin@example.com",
      rootURI: "chrome://jadense-in-zotero/",
    }, "migrate")).toBe("chrome://jadense-in-zotero/content/manager.xhtml?section=migrate")
  })

  it("opens the independent paper-analysis section through its own internal route", () => {
    expect(managerWindowUrl({
      pluginID: "plugin@example.com",
      rootURI: "chrome://jadense-in-zotero/",
    }, "analysis")).toBe("chrome://jadense-in-zotero/content/manager.xhtml?section=analysis")
  })

  it.each(["openDialog", "open"] as const)("fits the new %s window and native chrome within the available screen", (method) => {
    const open = vi.fn().mockReturnValue({ focus: vi.fn() })
    openManagerWindow({
      zotero: {},
      win: {
        [method]: open, screen: { availWidth: 1024, availHeight: 740 },
        outerWidth: 1016, innerWidth: 1000, outerHeight: 608, innerHeight: 569,
      } as unknown as ZoteroManagerWindow,
      context: { pluginID: "test", rootURI: "" },
    })
    expect(open.mock.calls[0][2]).toContain("width=1008,height=701")
  })

  it("reserves native chrome space when host window dimensions are unavailable", () => {
    const openDialog = vi.fn().mockReturnValue({ focus: vi.fn() })
    openManagerWindow({
      zotero: {},
      win: { openDialog, screen: { availWidth: 1024, availHeight: 740 } } as unknown as ZoteroManagerWindow,
      context: { pluginID: "test", rootURI: "" },
    })
    expect(openDialog.mock.calls[0][2]).toContain("width=1008,height=700")
  })

  it("uses the default dimensions when optional screen metrics are unavailable", () => {
    const openDialog = vi.fn().mockReturnValue({ focus: vi.fn() })
    openManagerWindow({
      zotero: {},
      win: { openDialog, screen: { availWidth: 0, availHeight: Number.NaN } } as unknown as ZoteroManagerWindow,
      context: { pluginID: "test", rootURI: "" },
    })
    expect(openDialog.mock.calls[0][2]).toContain("width=1360,height=860")
  })

  it("reuses the manager and delivers a new reader selection without losing the current conversation", () => {
    const receiveJadenseContext = vi.fn()
    const opened = { closed: false, focus: vi.fn(), close: vi.fn(), resizeTo: vi.fn(), receiveJadenseContext }
    const openDialog = vi.fn().mockReturnValue(opened)
    const zotero: ZoteroLike = {}
    const input = { zotero, win: { openDialog } as unknown as ZoteroManagerWindow, context: { pluginID: "test", rootURI: "" } }
    expect(openManagerWindow(input)).toBe(true)
    expect(openManagerWindow({ ...input, action: { kind: "quote", itemID: 17, text: "Selected sentence", pageIndex: 2 } })).toBe(true)
    expect(openDialog).toHaveBeenCalledTimes(1)
    expect(opened.focus).toHaveBeenCalledTimes(2)
    expect(opened.resizeTo).not.toHaveBeenCalled()
    expect(receiveJadenseContext).toHaveBeenCalledWith(expect.objectContaining({
      section: "chat", actions: [{ kind: "quote", itemID: 17, text: "Selected sentence", pageIndex: 2 }],
    }))
    closeManagerWindow(zotero)
    expect(opened.close).toHaveBeenCalledOnce()
  })

  it("retains reader actions received before the manager finishes loading", () => {
    const opened = { closed: false, focus: vi.fn(), JadenseInZotero: undefined as unknown }
    const input = { zotero: {}, win: { openDialog: vi.fn().mockReturnValue(opened) } as unknown as ZoteroManagerWindow, context: { pluginID: "test", rootURI: "" } }
    openManagerWindow({ ...input, action: { kind: "quote", itemID: 1, text: "First selection" } })
    openManagerWindow({ ...input, action: { kind: "translate", itemID: 2, text: "Second selection" } })
    expect(opened.JadenseInZotero).toMatchObject({ actions: [
      { kind: "quote", itemID: 1, text: "First selection" },
      { kind: "translate", itemID: 2, text: "Second selection" },
    ] })
  })

})
