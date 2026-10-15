/** 工作台窗口入口：接收 Reader 动作；窗口失效与焦点恢复不重放解析或其他业务操作。 */
import type { BootstrapPluginContext } from "./native-preferences"
import type { ZoteroLike } from "./runtime"
import { chromeContentUrl } from "./chrome-registration"
import type { ReaderAction } from "./reader-tools"
import { silentlyCheckForUpdates } from './update-notification'
import { diagnostics } from './diagnostics'

export type ManagerSection = "chat" | "translations" | "analysis" | "migrate" | "guide" | "settings" | "settings-ocr" | "settings-connection" | "settings-features" | "diagnostics"

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
type ManagerServices = {
  wm?: { getEnumerator(type: null): { hasMoreElements(): boolean; getNext(): OpenedManager } }
  focus?: { focusedWindow: Window | null }
}

/** 窗口异常只保存现有脱敏投影，诊断不可阻断恢复。 */
function recordWindowError(zotero: ZoteroLike, stage: string, error: unknown) {
  try { diagnostics(zotero)?.record('manager', stage, error) } catch { /* 本地诊断不可用。 */ }
}

/** 页面刷新会替换 Gecko 内层窗口；通过窗口管理器找回当前页面，避免继续使用失效回调或新开重复工作台。 */
function liveManager(zotero: ZoteroLike): OpenedManager | undefined {
  const cached = managerWindows.get(zotero)
  try {
    const services = (globalThis as typeof globalThis & { Services?: ManagerServices }).Services
    const windows = services?.wm?.getEnumerator(null)
    while (windows?.hasMoreElements()) {
      const candidate = windows.getNext()
      try {
        if (candidate.closed === false && String(candidate.location?.href).startsWith(chromeContentUrl(JADENSE_MANAGER_RESOURCE))) {
          void candidate.document?.readyState
          managerWindows.set(zotero, candidate); return candidate
        }
      } catch { /* 单个已销毁窗口不能阻断后续窗口查找。 */ }
    }
  } catch { /* 未出现过窗口时使用普通打开流程。 */ }
  // 新窗口可能仍在 about:blank/loading；保留可读的等待上下文，但绝不返回已销毁引用。
  try {
    if (cached?.closed === false) { void cached.document?.readyState; return cached }
  } catch { /* 内层窗口已销毁。 */ }
  managerWindows.delete(zotero)
  return undefined
}

/** 焦点失败只恢复窗口展示；动作此前已交接，不能因此新开窗口或再次派发。 */
function focusManager(zotero: ZoteroLike, manager: OpenedManager) {
  try { manager.focus(); return manager } catch (error) { recordWindowError(zotero, 'window_focus', error) }
  const current = liveManager(zotero) ?? manager
  try {
    if (current !== manager) { current.focus(); return current }
  } catch { /* 当前窗口的 DOM focus 也可能不可用，继续使用宿主焦点服务。 */ }
  try {
    const focus = (globalThis as typeof globalThis & { Services?: ManagerServices }).Services?.focus
    if (focus) focus.focusedWindow = current
  } catch (error) { recordWindowError(zotero, 'window_focus_recovery', error) }
  return current
}

/** 更新提示及其 document getter 都是可选展示，不影响窗口交接结果。 */
function checkManagerForUpdates(manager: OpenedManager, zotero: ZoteroLike, pluginID: string) {
  try { void silentlyCheckForUpdates(manager.document, zotero, pluginID) } catch { /* 窗口正在卸载。 */ }
}

/** 卸载时关闭本插件窗口，让正在生成的请求随窗口中止。 */
export function closeManagerWindow(zotero: ZoteroLike) {
  const manager = managerWindows.get(zotero)
  try { if (manager?.JadenseInZotero) manager.JadenseInZotero.actions = undefined } catch { /* 旧页面已销毁。 */ }
  try { manager?.close?.() } catch { /* 窗口已不可用，无需再次关闭。 */ }
  finally { managerWindows.delete(zotero) }
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

  const existing = liveManager(input.zotero)
  if (existing) {
    try {
      if (existing.receiveJadenseContext) {
        existing.receiveJadenseContext(managerContext)
      } else {
        const pending = existing.JadenseInZotero?.actions ?? []
        existing.JadenseInZotero = { ...managerContext, actions: [...pending, ...(managerContext.actions ?? [])] }
      }
    } catch (error) {
      // 回调可能已开始业务操作，异常不授权向另一个页面重发同一动作。
      recordWindowError(input.zotero, 'window_context', error)
      focusManager(input.zotero, existing)
      return false
    }
    // Gecko 原生 focus 会恢复最小化窗口；不主动 restore，以保留用户的最大化状态。
    const focused = focusManager(input.zotero, existing)
    checkManagerForUpdates(focused, input.zotero, input.context.pluginID)
    return true
  }

  // 三区域对话需要更宽的初始画布；只约束新窗口，保留已有窗口的用户尺寸与最大化状态。
  // width/height 是内容尺寸，需给原生边框与标题栏留出空间，避免小屏窗口超出可用工作区。
  const chromeWidth = win.outerWidth > win.innerWidth ? win.outerWidth - win.innerWidth : 16
  const chromeHeight = win.outerHeight > win.innerHeight ? win.outerHeight - win.innerHeight : 40
  const width = Math.min(1360, win.screen?.availWidth > 0 ? Math.max(1, Math.floor(win.screen.availWidth - chromeWidth)) : 1360)
  const height = Math.min(860, win.screen?.availHeight > 0 ? Math.max(1, Math.floor(win.screen.availHeight - chromeHeight)) : 860)
  const size = `width=${width},height=${height}`
  // 保留普通 chrome 窗口能力；已验收的 Windows 宿主由 Manager 设置 customtitlebar，其他组合保持系统标题栏。
  const features = `chrome,dialog=no,titlebar,toolbar,centerscreen,resizable,${size}`

  const remember = (opened: unknown) => {
    if (!opened || typeof opened !== "object") return
    const manager = opened as OpenedManager
    manager.JadenseInZotero = managerContext
    managerWindows.set(input.zotero, manager)
    const clearContext = () => {
      // openDialog 的 arguments 与窗口属性可能同时引用动作；关窗时主动断开图片字节引用。
      managerContext.actions = undefined
      try {
        if (manager.JadenseInZotero) manager.JadenseInZotero.actions = undefined
        manager.JadenseInZotero = undefined
      } catch { /* Gecko 已销毁内层窗口。 */ }
      finally { if (managerWindows.get(input.zotero) === manager) managerWindows.delete(input.zotero) }
    }
    const managerPageUrl = chromeContentUrl(JADENSE_MANAGER_RESOURCE)
    const attachUnloadAfterManagerLoad = () => {
      let href = ""
      try { href = String(manager.location?.href ?? "") } catch { /* loading window may not expose location yet */ }
      if (!href.startsWith(managerPageUrl)) return
      manager.removeEventListener?.("load", attachUnloadAfterManagerLoad)
      manager.addEventListener?.("unload", clearContext, { once: true })
      checkManagerForUpdates(manager, input.zotero, input.context.pluginID)
    }
    // 新 chrome 窗口会先卸载 about:blank；等 Manager 页面完成 load 后再监听，避免误删首个 Reader 动作。
    manager.addEventListener?.("load", attachUnloadAfterManagerLoad)
    attachUnloadAfterManagerLoad()
    focusManager(input.zotero, manager)
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
    return Boolean(opened)
  } catch {
    return false
  }
}
