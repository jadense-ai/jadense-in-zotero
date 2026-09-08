import type { BootstrapPluginContext } from "./native-preferences"
import type { ZoteroLike } from "./runtime"
import { chromeContentUrl } from "./chrome-registration"
import type { ReaderAction } from "./reader-tools"

export type ManagerSection = "chat" | "translations" | "analysis" | "migrate" | "guide" | "settings"

export const JADENSE_MANAGER_WINDOW_NAME = "jadense-in-zotero-manager"
export const JADENSE_MANAGER_RESOURCE = "manager.xhtml"

export type ZoteroManagerWindow = Window & typeof globalThis & {
  openDialog?: (...args: unknown[]) => unknown
}

/** 阅读器动作通过本地窗口上下文传递，不经过网页消息或服务器。 */
export type ManagerContext = {
  zotero: ZoteroLike
  section: ManagerSection
  pluginID: string
  actions?: ReaderAction[]
}

type OpenedManager = Window & {
  JadenseInZotero?: ManagerContext
  receiveJadenseContext?: (context: ManagerContext) => void
}

const managerWindows = new WeakMap<ZoteroLike, OpenedManager>()

/** 卸载时关闭本插件窗口，让正在生成的请求随窗口中止。 */
export function closeManagerWindow(zotero: ZoteroLike) {
  const manager = managerWindows.get(zotero)
  if (manager?.JadenseInZotero) manager.JadenseInZotero.actions = undefined
  manager?.close?.()
  managerWindows.delete(zotero)
}

export function managerWindowUrl(_context: BootstrapPluginContext, section: ManagerSection = "chat") {
  return `${chromeContentUrl(JADENSE_MANAGER_RESOURCE)}?section=${encodeURIComponent(section)}`
}

export function openManagerWindow(input: {
  zotero: ZoteroLike
  win: ZoteroManagerWindow | null
  context: BootstrapPluginContext
  section?: ManagerSection
  action?: ReaderAction
}) {
  const win = input.win
  if (!win) return false

  const section = input.section ?? "chat"
  const url = managerWindowUrl(input.context, section)
  const managerContext: ManagerContext = {
    zotero: input.zotero,
    section,
    pluginID: input.context.pluginID,
    ...(input.action ? { actions: [input.action] } : {}),
  }

  const existing = managerWindows.get(input.zotero)
  if (existing && existing.closed === false) {
    if (existing.receiveJadenseContext) {
      existing.receiveJadenseContext(managerContext)
    } else {
      const pending = existing.JadenseInZotero?.actions ?? []
      existing.JadenseInZotero = { ...managerContext, actions: [...pending, ...(managerContext.actions ?? [])] }
    }
    // Gecko 原生 focus 会恢复最小化窗口；不主动 restore，以保留用户的最大化状态。
    existing.focus()
    return true
  }

  // 三区域对话需要更宽的初始画布；只约束新窗口，保留已有窗口的用户尺寸与最大化状态。
  // width/height 是内容尺寸，需给原生边框与标题栏留出空间，避免小屏窗口超出可用工作区。
  const chromeWidth = win.outerWidth > win.innerWidth ? win.outerWidth - win.innerWidth : 16
  const chromeHeight = win.outerHeight > win.innerHeight ? win.outerHeight - win.innerHeight : 40
  const width = Math.min(1360, win.screen?.availWidth > 0 ? Math.max(1, Math.floor(win.screen.availWidth - chromeWidth)) : 1360)
  const height = Math.min(860, win.screen?.availHeight > 0 ? Math.max(1, Math.floor(win.screen.availHeight - chromeHeight)) : 860)
  const size = `width=${width},height=${height}`
  // openDialog 默认隐藏最小化/最大化按钮；普通 chrome 窗口使用系统原生标题栏控件。
  const features = `chrome,dialog=no,titlebar,toolbar,centerscreen,resizable,${size}`

  const remember = (opened: unknown) => {
    if (!opened || typeof opened !== "object") return
    const manager = opened as OpenedManager
    manager.JadenseInZotero = managerContext
    managerWindows.set(input.zotero, manager)
    const clearContext = () => {
      // openDialog 的 arguments 与窗口属性可能同时引用动作；关窗时主动断开图片字节引用。
      managerContext.actions = undefined
      if (manager.JadenseInZotero) manager.JadenseInZotero.actions = undefined
      manager.JadenseInZotero = undefined
      if (managerWindows.get(input.zotero) === manager) managerWindows.delete(input.zotero)
    }
    const managerPageUrl = chromeContentUrl(JADENSE_MANAGER_RESOURCE)
    const attachUnloadAfterManagerLoad = () => {
      let href = ""
      try { href = String(manager.location?.href ?? "") } catch { /* loading window may not expose location yet */ }
      if (!href.startsWith(managerPageUrl)) return
      manager.removeEventListener?.("load", attachUnloadAfterManagerLoad)
      manager.addEventListener?.("unload", clearContext, { once: true })
    }
    // 新 chrome 窗口会先卸载 about:blank；等 Manager 页面完成 load 后再监听，避免误删首个 Reader 动作。
    manager.addEventListener?.("load", attachUnloadAfterManagerLoad)
    attachUnloadAfterManagerLoad()
    manager.focus?.()
  }

  try {
    if (typeof win.openDialog === "function") {
      const opened = win.openDialog(url, JADENSE_MANAGER_WINDOW_NAME, features, managerContext)
      remember(opened)
      if (opened !== false && opened !== null) return true
    }
  } catch {
    // Fall back to a plain popup only if Zotero's chrome dialog path is unavailable.
  }

  try {
    const opened = win.open(url, JADENSE_MANAGER_WINDOW_NAME, `popup,${size},resizable,centerscreen`)
    if (opened) {
      try {
        remember(opened)
      } catch {
        // The manager page can still fall back to opener.Zotero.
      }
    }
    opened?.focus?.()
    return Boolean(opened)
  } catch {
    return false
  }
}
