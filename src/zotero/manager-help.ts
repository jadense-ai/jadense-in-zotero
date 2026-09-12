/** 工作台帮助与手动 Release 检查；仅显示信息，不参与业务请求或自动更新渠道。 */
import { uiText } from "./ui-preferences"

export const REPOSITORY_URL = "https://github.com/jadense-ai/jadense-in-zotero"
export const RELEASES_URL = `${REPOSITORY_URL}/releases`
export const LATEST_RELEASE_API = "https://api.github.com/repos/jadense-ai/jadense-in-zotero/releases/latest"
export const JADENSE_WORKBENCH_URL = "https://jadense.cn/app"

type GeckoModules = {
  ChromeUtils?: { importESModule(url: string): Record<string, unknown> }
  Services?: { vc: { compare(a: string, b: string): number } }
}

/** 版本来自实际安装的 AddonManager；缺失时不以源码版本冒充安装版本。 */
export async function installedPluginVersion(pluginID: string, platform: GeckoModules = globalThis as GeckoModules) {
  const manager = platform.ChromeUtils?.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager as
    { getAddonByID(id: string): Promise<{ version: string } | null> } | undefined
  const addon = await manager?.getAddonByID(pluginID)
  if (!addon?.version) throw new Error("Installed version unavailable")
  return addon.version
}

/** Gecko 原生比较器支持数字分段与预发布语义，不能降级为字符串比较。 */
export function compareGeckoVersions(current: string, latest: string, platform: GeckoModules = globalThis as GeckoModules) {
  const services = platform.Services ?? platform.ChromeUtils?.importESModule("resource://gre/modules/Services.sys.mjs").Services as GeckoModules["Services"]
  if (!services?.vc) throw new Error("Version comparator unavailable")
  return services.vc.compare(current, latest)
}

/** 只选取正式版本标签；忽略附加字段，并从固定仓库构造浏览器入口。 */
export function releaseSummary(payload: unknown, current: string, compare: (a: string, b: string) => number) {
  const release = payload as { tag_name?: unknown; draft?: unknown; prerelease?: unknown } | null
  if (!release || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") throw new Error("No stable release")
  const latest = release.tag_name.trim().replace(/^v/i, "")
  if (!/^\d+(?:\.\d+)*(?:[a-zA-Z][\w.+-]*)?$/.test(latest)) throw new Error("Unusable release version")
  const order = compare(current, latest)
  if (!Number.isFinite(order)) throw new Error("Unusable version comparison")
  return { current, latest, state: order < 0 ? "available" : order > 0 ? "ahead" : "latest", url: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}` } as const
}

/** 无凭证 GET；超时、限流和异常响应仅由帮助弹窗处理。 */
export async function checkLatestRelease(current: string, compare = compareGeckoVersions, request: typeof fetch = fetch, signal?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, 10_000)
  try {
    const response = await request(LATEST_RELEASE_API, { signal: controller.signal, credentials: "omit", headers: { Accept: "application/vnd.github+json" } })
    if (!response.ok) throw new Error(`GitHub ${response.status}`)
    return releaseSummary(await response.json(), current, compare)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

/** 所有帮助入口共用原生浏览器调用；失败只显示本地提示。 */
export function openHelpLink(host: { launchURL?: (url: string) => void } | null, url: string) {
  if (typeof host?.launchURL !== "function") throw new Error("System browser unavailable")
  host.launchURL(url)
}

/** 原生 dialog 管理模态焦点和 Escape，关闭后返回帮助按钮。 */
export function wireManagerHelp(document: Document, host: { launchURL?: (url: string) => void } | null, pluginID: string) {
  const win = document.defaultView!
  const get = <T extends HTMLElement>(id: string) => document.getElementById(`jadense-${id}`) as T
  const trigger = get<HTMLButtonElement>("help-toggle")
  const menu = get<HTMLElement>("help-menu")
  const dialog = get<HTMLDialogElement>("help-dialog")
  const title = get<HTMLElement>("help-title")
  const description = get<HTMLElement>("help-description")
  const version = get<HTMLElement>("help-version")
  const status = get<HTMLElement>("help-status")
  const retry = get<HTMLButtonElement>("help-retry")
  const releaseButton = get<HTMLButtonElement>("help-release")
  const website = get<HTMLButtonElement>("help-website")
  let releaseURL = RELEASES_URL
  let pending: AbortController | undefined
  const closeMenu = (focus = false) => {
    menu.hidden = true
    trigger.setAttribute("aria-expanded", "false")
    if (focus) trigger.focus()
  }
  const menuItems = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"))
  const showMenu = (last = false) => {
    menu.hidden = false
    trigger.setAttribute("aria-expanded", "true")
    menuItems[last ? menuItems.length - 1 : 0]?.focus()
  }
  trigger.addEventListener("click", () => menu.hidden ? showMenu() : closeMenu(true))
  trigger.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return
    event.preventDefault(); showMenu(event.key === "ArrowUp")
  })
  menu.addEventListener("keydown", event => {
    const index = menuItems.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === "Escape") { event.preventDefault(); closeMenu(true) }
    else if (event.key === "Tab") closeMenu(true)
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault()
      const next = event.key === "Home" ? 0 : event.key === "End" ? menuItems.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length
      menuItems[next]?.focus()
    }
  })
  document.addEventListener("pointerdown", event => {
    if (!menu.contains(event.target as Node) && !trigger.contains(event.target as Node)) closeMenu()
  })
  menu.addEventListener("click", () => closeMenu())
  get("manager-nav-guide").addEventListener("click", () => {
    get("manager-section-guide").tabIndex = -1
    get("manager-section-guide").focus()
  })
  const open = (url: string) => {
    try { openHelpLink(host, url) }
    catch { status.textContent = uiText("无法打开默认浏览器，请重试。", "Unable to open the default browser. Please retry."); if (!dialog.open) show(false) }
  }
  const loadVersion = () => installedPluginVersion(pluginID, win as unknown as GeckoModules)
  const show = (update: boolean) => {
    closeMenu()
    title.textContent = update ? uiText("检查更新", "Check for updates") : uiText("关于 Jadense in Zotero", "About Jadense in Zotero")
    description.hidden = update
    retry.hidden = !update
    releaseButton.hidden = !update
    website.hidden = update
    version.textContent = ""
    if (!dialog.open) dialog.showModal()
    if (!update) void loadVersion().then(value => { version.textContent = uiText(`安装版本：${value}`, `Installed version: ${value}`) }).catch(() => { version.textContent = uiText("安装版本暂不可用", "Installed version unavailable") })
  }
  const check = async () => {
    pending?.abort()
    const operation = new AbortController(); pending = operation
    show(true); releaseURL = RELEASES_URL
    status.textContent = uiText("检查中…", "Checking…")
    retry.disabled = true
    try {
      const current = await loadVersion()
      if (operation.signal.aborted) return
      version.textContent = uiText(`当前版本：${current}`, `Current version: ${current}`)
      const result = await checkLatestRelease(current, (a, b) => compareGeckoVersions(a, b, win as unknown as GeckoModules), win.fetch.bind(win), operation.signal)
      if (operation.signal.aborted) return
      releaseURL = result.url
      version.textContent = uiText(`当前版本：${current} · 最新正式版：${result.latest}`, `Current: ${current} · Latest stable: ${result.latest}`)
      status.textContent = result.state === "available" ? uiText("发现新版本", "New version available") : result.state === "ahead" ? uiText("本地版本高于最新正式版，无需降级。", "Your local version is newer than the latest stable release. No downgrade needed.") : uiText("已是最新版本", "You are up to date")
    } catch {
      if (!operation.signal.aborted) status.textContent = uiText("检查失败：网络超时、请求受限或暂无可读取的正式版本。请重试或打开发布页。", "Check failed: the network timed out, requests are limited, or no readable stable release is available. Retry or open releases.")
    } finally { if (pending === operation) retry.disabled = false }
  }
  get("help-about").addEventListener("click", () => { status.textContent = ""; show(false) })
  get("help-update").addEventListener("click", () => { void check() })
  retry.addEventListener("click", () => { void check() })
  releaseButton.addEventListener("click", () => open(releaseURL))
  website.addEventListener("click", () => open("https://jadense.cn"))
  get("help-repository").addEventListener("click", () => open(REPOSITORY_URL))
  get("github").addEventListener("click", () => open(REPOSITORY_URL))
  get("home").addEventListener("click", () => open("https://jadense.cn"))
  get("check-in").addEventListener("click", () => open(JADENSE_WORKBENCH_URL))
  get("help-close").addEventListener("click", () => dialog.close())
  dialog.addEventListener("close", () => { pending?.abort(); trigger.focus() })
  win.addEventListener("unload", () => pending?.abort(), { once: true })
}
