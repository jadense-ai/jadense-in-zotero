/** 独立窗口的 Gecko 标题栏适配；未知宿主组合保持系统外壳和完整内部布局。 */
import { uiText } from "./ui-preferences"

type NativeWindow = Window & {
  minimize(): void
  maximize(): void
  restore(): void
  windowState: number
  STATE_MAXIMIZED: number
  Services?: { appinfo: { OS: string; version: string }; sysinfo: { getProperty(name: string): unknown } }
  ChromeUtils?: { importESModule(url: string): { Services: { appinfo: { OS: string; version: string }; sysinfo: { getProperty(name: string): unknown } } } }
}

/** 仅在已验收的精确宿主启用，不持久化用户偏好。 */
export function supportsIntegratedTitlebar(os: string, version: string, build: string) {
  return os === "WINNT" && version === "10.0.2" && build === "26200"
}

export function wireManagerTitlebar(document: Document) {
  const win = document.defaultView as unknown as NativeWindow
  try {
    const services = win.Services ?? win.ChromeUtils?.importESModule("resource://gre/modules/Services.sys.mjs").Services
    if (!services || !supportsIntegratedTitlebar(services.appinfo.OS, services.appinfo.version, String(services.sysinfo.getProperty("build")))) return
    if (![win.minimize, win.maximize, win.restore].every(method => typeof method === "function")) return
    const root = document.documentElement
    const controls = document.getElementById("jadense-window-controls")!
    const maximize = document.getElementById("jadense-window-maximize")!
    const refresh = () => {
      const maximized = win.windowState === win.STATE_MAXIMIZED
      const label = maximized ? uiText("恢复窗口", "Restore window") : uiText("最大化", "Maximize")
      maximize.setAttribute("aria-label", label); maximize.setAttribute("title", label)
      maximize.textContent = maximized ? "❐" : "□"
    }
    document.getElementById("jadense-window-minimize")!.addEventListener("click", () => win.minimize())
    maximize.addEventListener("click", () => win.windowState === win.STATE_MAXIMIZED ? win.restore() : win.maximize())
    document.getElementById("jadense-window-close")!.addEventListener("click", () => win.close())
    win.addEventListener("sizemodechange", refresh)
    // Zotero 10 的宿主属性保留原生非客户区命中测试、系统拖动/双击和边缘缩放。
    // 不用 hidechrome，也不以 JS moveTo 模拟系统拖动。
    root.setAttribute("customtitlebar", "true")
    root.removeAttribute("drawtitle")
    controls.hidden = false
    refresh()
  } catch {
    document.documentElement.removeAttribute("customtitlebar")
    const controls = document.getElementById("jadense-window-controls")
    if (controls) controls.hidden = true
  }
}
