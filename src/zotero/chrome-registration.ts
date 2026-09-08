export const JADENSE_CHROME_PACKAGE = "jadense-in-zotero"
export const JADENSE_CHROME_CONTENT_ROOT = `chrome://${JADENSE_CHROME_PACKAGE}/content/`
export const JADENSE_FTL_FILE = "jadense-in-zotero.ftl"

export type JadenseMainWindow = Window & typeof globalThis & {
  MozXULElement?: {
    insertFTLIfNeeded?: (fileName: string) => void
  }
}

type ChromeRegistrationHandle = {
  destruct(): void
}

type ChromeRegistrationPlatform = {
  Cc?: Record<string, { getService: (interfaceType: unknown) => { registerChrome: (manifestURI: unknown, entries: string[][]) => ChromeRegistrationHandle } }>
  Ci?: { amIAddonManagerStartup?: unknown }
  Components?: {
    classes?: Record<string, { getService: (interfaceType: unknown) => { registerChrome: (manifestURI: unknown, entries: string[][]) => ChromeRegistrationHandle } }>
    interfaces?: { amIAddonManagerStartup?: unknown }
  }
  Services?: { io?: { newURI: (value: string) => unknown } }
  ChromeUtils?: {
    importESModule?: (uri: string) => unknown
  }
}

function platformGlobals(): ChromeRegistrationPlatform {
  return globalThis as ChromeRegistrationPlatform
}

export function chromeContentUrl(resource: string) {
  return `${JADENSE_CHROME_CONTENT_ROOT}${resource.replace(/^\/+/g, "")}`
}

/**
 * registerChrome 注册的 chrome 内容包条目，承载 manager/preferences 的 chrome:// 页面。
 * 插件 Fluent 不走 chrome locale 注册：Zotero 9 会在加载插件时自动读取 XPI 内
 * locale/<locale>/*.ftl 并注册统一的 L10nRegistry 源。
 */
export const JADENSE_CHROME_ENTRIES = [
  ["content", JADENSE_CHROME_PACKAGE, "content/"],
] as string[][]

/**
 * 将 Jadense Fluent 资源幂等地挂载到 Zotero 主窗口。
 * 上游原生菜单和 Item Pane 使用 l10nID，下游依赖窗口级 Fluent 资源才能显示可见文字。
 */
export function ensureJadenseLocalization(win: JadenseMainWindow | null | undefined) {
  const mozXULElement = win?.MozXULElement
  const insertFTLIfNeeded = mozXULElement?.insertFTLIfNeeded
  if (typeof insertFTLIfNeeded !== "function") return false
  insertFTLIfNeeded.call(mozXULElement, JADENSE_FTL_FILE)
  return true
}

export function pluginResourceUrl(rootURI: string, resource: string) {
  const normalizedResource = resource.replace(/^\/+/g, "")
  const normalizedRoot = rootURI.trim()
  if (normalizedRoot) return `${normalizedRoot}${normalizedResource}`
  return normalizedResource.startsWith("content/")
    ? chromeContentUrl(normalizedResource.slice("content/".length))
    : normalizedResource
}

function servicesForPlatform(platform: ChromeRegistrationPlatform) {
  if (platform.Services) return platform.Services
  const imported = platform.ChromeUtils?.importESModule?.("resource://gre/modules/Services.sys.mjs")
  return imported && typeof imported === "object" && "Services" in imported
    ? (imported as { Services?: ChromeRegistrationPlatform["Services"] }).Services
    : undefined
}

export function registerChromeContent(rootURI: string, platform = platformGlobals()) {
  if (!rootURI) return null
  // Zotero 9 的 bootstrap 沙箱可能不暴露 Cc/Ci 全局，Components 始终可用作兜底。
  const serviceFactory = platform.Cc?.["@mozilla.org/addons/addon-manager-startup;1"]
    ?? platform.Components?.classes?.["@mozilla.org/addons/addon-manager-startup;1"]
  const startupInterface = platform.Ci?.amIAddonManagerStartup
    ?? platform.Components?.interfaces?.amIAddonManagerStartup
  const newURI = servicesForPlatform(platform)?.io?.newURI
  if (!serviceFactory || !startupInterface || !newURI) return null

  const addonManagerStartup = serviceFactory.getService(startupInterface)
  const manifestURI = newURI(`${rootURI}manifest.json`)
  return addonManagerStartup.registerChrome(manifestURI, JADENSE_CHROME_ENTRIES)
}

export function unregisterChromeContent(handle: ChromeRegistrationHandle | null) {
  if (!handle) return
  handle.destruct()
}
