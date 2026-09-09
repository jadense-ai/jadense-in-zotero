/** 插件展示偏好的唯一入口：跨 bundle 共享启动语言，主题只作用于调用方拥有的 UI 容器。 */
export type UiLocale = "zh-CN" | "en-US"
export type DisplayLanguage = "system" | "zh-CN" | "en-US"
export type UiTheme = "system" | "light" | "dark"
export type UiPreferenceHost = {
  locale?: string
  __jadenseInZoteroUiLocale?: UiLocale
  Prefs?: {
    get(key: string, global?: boolean): unknown
    set?(key: string, value: unknown, global?: boolean): void
    registerObserver?(key: string, handler: () => void, global?: boolean): unknown
    unregisterObserver?(id: unknown): void
  }
  getMainWindow?: () => (Window & typeof globalThis) | null
}

export const DISPLAY_LANGUAGE_PREF = "extensions.jadenseInZotero.displayLanguage"
export const THEME_PREF = "extensions.jadenseInZotero.theme"
const LEGACY_THEME_PREF = "extensions.jadenseInZotero.managerThemeDark"
const HOST_THEME_PREF = "browser.theme.toolbar-theme"
let activeLocale: UiLocale = "zh-CN"

function preference(zotero: UiPreferenceHost | null, key: string, global = true) {
  try { return zotero?.Prefs?.get(key, global) } catch { return undefined }
}

/** 无效展示偏好回退默认，不阻断连接、模型选择或任务执行。 */
export function readDisplayLanguage(zotero: UiPreferenceHost | null): DisplayLanguage {
  const value = preference(zotero, DISPLAY_LANGUAGE_PREF)
  return value === "zh-CN" || value === "en-US" ? value : "system"
}

/** 启动快照保存在 Zotero 单例；重开窗口、插件热重载均不会提前应用待重启语言。 */
export function initializeUiLocale(zotero: UiPreferenceHost | null): UiLocale {
  if (!zotero) return activeLocale
  if (zotero.__jadenseInZoteroUiLocale !== "zh-CN" && zotero.__jadenseInZoteroUiLocale !== "en-US") {
    const selected = readDisplayLanguage(zotero)
    zotero.__jadenseInZoteroUiLocale = selected === "system"
      ? zotero.locale?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"
      : selected
  }
  activeLocale = zotero.__jadenseInZoteroUiLocale
  return activeLocale
}

export function getUiLocale(): UiLocale { return activeLocale }
export function uiText(zh: string, en: string): string { return activeLocale === "zh-CN" ? zh : en }

function save(zotero: UiPreferenceHost | null, key: string, value: string): boolean {
  if (!zotero?.Prefs?.set) return false
  try { zotero.Prefs.set(key, value, true); return true } catch { return false }
}

/** 仅保存下次启动语言，不更新当前会话快照。 */
export function saveDisplayLanguage(zotero: UiPreferenceHost | null, value: unknown): boolean {
  return save(zotero, DISPLAY_LANGUAGE_PREF, value === "zh-CN" || value === "en-US" ? value : "system")
}

/** 设置窗口同步待重启的选项值；当前语言快照保持不变。 */
export function observeDisplayLanguage(zotero: UiPreferenceHost | null, onChange: (value: DisplayLanguage) => void): () => void {
  const update = () => onChange(readDisplayLanguage(zotero))
  update()
  const prefs = zotero?.Prefs
  if (!prefs?.registerObserver || !prefs.unregisterObserver) return () => undefined
  try {
    const id = prefs.registerObserver(DISPLAY_LANGUAGE_PREF, update, true)
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      try { prefs.unregisterObserver?.(id) } catch { /* 可选展示监听不阻断卸载。 */ }
    }
  } catch { return () => undefined }
}

export function readTheme(zotero: UiPreferenceHost | null): UiTheme {
  const value = preference(zotero, THEME_PREF)
  if (value === "system" || value === "light" || value === "dark") return value
  // 旧版调用省略 global=true，实际键在 extensions.zotero 分支；只在新偏好缺省时继承。
  if (value === undefined || value === null) {
    const old = preference(zotero, LEGACY_THEME_PREF, false)
    if (typeof old === "boolean") return old ? "dark" : "light"
  }
  return "system"
}

export function saveTheme(zotero: UiPreferenceHost | null, value: unknown): boolean {
  return save(zotero, THEME_PREF, value === "light" || value === "dark" ? value : "system")
}

/** 在自有容器即时应用主题，监听宿主/插件偏好并返回幂等清理函数。 */
export function observeTheme(zotero: UiPreferenceHost | null, root: HTMLElement, onChange?: (dark: boolean) => void): () => void {
  let media: MediaQueryList | undefined
  try {
    const win = zotero?.getMainWindow?.() ?? root.ownerDocument.defaultView
    media = win?.matchMedia?.("(prefers-color-scheme: dark)")
  } catch { /* 宿主主题检测是可选展示能力，缺失时使用浅色默认。 */ }
  const update = () => {
    const theme = readTheme(zotero)
    const hostTheme = preference(zotero, HOST_THEME_PREF)
    let systemDark = false
    try { systemDark = Boolean(media?.matches) } catch { /* 跨窗口媒体查询可能已销毁。 */ }
    const dark = theme === "dark" || (theme === "system" && (hostTheme === 0 || (hostTheme !== 1 && systemDark)))
    root.dataset.theme = dark ? "dark" : "light"
    root.style.colorScheme = dark ? "dark" : "light"
    onChange?.(dark)
  }
  const ids: unknown[] = []
  const prefs = zotero?.Prefs
  if (prefs?.registerObserver && prefs.unregisterObserver) {
    for (const key of [THEME_PREF, HOST_THEME_PREF]) {
      try { ids.push(prefs.registerObserver(key, update, true)) } catch { /* 可选监听不影响当前主题。 */ }
    }
  }
  try { media?.addEventListener?.("change", update) } catch { /* 保留当前主题，不能阻断 Reader/Manager。 */ }
  update()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    try { media?.removeEventListener?.("change", update) } catch { /* 宿主窗口可能已销毁。 */ }
    for (const id of ids) {
      try { prefs?.unregisterObserver?.(id) } catch { /* 宿主卸载时无需阻断清理。 */ }
    }
  }
}
