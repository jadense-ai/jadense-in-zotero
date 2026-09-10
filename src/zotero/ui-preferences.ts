import { createJdxSelect } from "./custom-select"

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
export const FONT_SIZE_PREF = "extensions.jadenseInZotero.fontSize"
export const TRANSLATION_STYLE_PREF = "extensions.jadenseInZotero.translationWindowStyle"
export const TRANSLATION_OPACITY_PREF = "extensions.jadenseInZotero.translationWindowOpacity"
export function readFontSize(zotero: UiPreferenceHost | null): number {
  const value = Number(preference(zotero, FONT_SIZE_PREF))
  return Number.isFinite(value) && value >= 12 && value <= 24 ? Math.round(value) : 13
}
export function saveFontSize(zotero: UiPreferenceHost | null, value: unknown) {
  const number = Number(value)
  return save(zotero, FONT_SIZE_PREF, String(Number.isFinite(number) ? Math.min(24, Math.max(12, Math.round(number))) : 13))
}
export function readTranslationStyle(zotero: UiPreferenceHost | null) { return preference(zotero, TRANSLATION_STYLE_PREF) === "glass" ? "glass" : "default" }
export function saveTranslationStyle(zotero: UiPreferenceHost | null, value: unknown) { return save(zotero, TRANSLATION_STYLE_PREF, value === "glass" ? "glass" : "default") }
/** 存储背景不透明度百分比；缺失/无效展示值局部回退，旧版毛玻璃首次获得可见透光。 */
function normalizeTranslationOpacity(value: unknown): number {
  const number = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 80
}
export function readTranslationOpacity(zotero: UiPreferenceHost | null): number { return normalizeTranslationOpacity(preference(zotero, TRANSLATION_OPACITY_PREF)) }
export function saveTranslationOpacity(zotero: UiPreferenceHost | null, value: unknown): boolean { return save(zotero, TRANSLATION_OPACITY_PREF, String(normalizeTranslationOpacity(value))) }
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
    root.style.setProperty?.("--jdx-font-scale", String(readFontSize(zotero) / 13))
    root.dataset.windowStyle = readTranslationStyle(zotero)
    root.style.setProperty?.("--jdx-window-opacity", `${readTranslationOpacity(zotero)}%`)
    root.style.setProperty?.("--jdx-translation-opacity", String(readTranslationOpacity(zotero) / 100))
    for (const select of Array.from(root.querySelectorAll?.<HTMLSelectElement>("select[data-jdx-translation-style]") || [])) select.value = root.dataset.windowStyle
    for (const range of Array.from(root.querySelectorAll?.<HTMLInputElement>("input[data-jdx-translation-opacity]") || [])) syncTranslationOpacityControl(zotero, range)
    onChange?.(dark)
  }
  const ids: unknown[] = []
  const prefs = zotero?.Prefs
  if (prefs?.registerObserver && prefs.unregisterObserver) {
    for (const key of [THEME_PREF, HOST_THEME_PREF, FONT_SIZE_PREF, TRANSLATION_STYLE_PREF, TRANSLATION_OPACITY_PREF]) {
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

/** 常规设置与原生设置使用相同控件及偏好；即时广播，失败仅显示保存提示。 */
export function wireReadingPreferences(host: UiPreferenceHost | null, container: HTMLElement) {
  const doc = container.ownerDocument
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K) => doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K]
  const root = element("div")
  root.className = "jdx-reading-preferences"
  const row = (label: string, description: string, control: HTMLElement) => {
    const item = element("div"); item.className = "jdx-reading-preference-row jdx-feature-model-row"
    const copy = element("div"), title = element("h3"), note = element("p")
    title.textContent = label; note.textContent = description; copy.append(title, note)
    item.append(copy, control); root.append(item)
  }
  const status = element("p")
  status.className = "jdx-reading-preferences-status"
  status.setAttribute("role", "status")
  const savedStatus = (saved: boolean) => { status.textContent = saved ? "" : uiText("设置未能保存，请重试。", "Could not save settings. Please try again.") }
  const fontControls = element("div"), stepper = element("div"), unit = element("span")
  fontControls.className = "jdx-reading-font-controls"; stepper.className = "jdx-reading-stepper"; unit.textContent = "px"
  const size = element("input")
  size.type = "number"; size.min = "12"; size.max = "24"; size.step = "1"; size.value = String(readFontSize(host))
  size.setAttribute("data-jdx-font-size", "")
  size.setAttribute("aria-label", uiText("界面字号", "Interface font size"))
  const update = (value: unknown) => { savedStatus(saveFontSize(host, value)); sync() }
  const fontButtons: HTMLButtonElement[] = []
  for (const [text, value] of [["−", -1], ["+", 1], [uiText("恢复默认", "Reset"), 0]] as const) {
    const button = element("button")
    button.type = "button"; button.textContent = text
    button.setAttribute("aria-label", value === 0 ? text : value > 0 ? uiText("增大字号", "Increase font size") : uiText("减小字号", "Decrease font size"))
    button.addEventListener("click", () => update(value === 0 ? 13 : readFontSize(host) + value))
    fontButtons.push(button)
  }
  stepper.append(fontButtons[0], size, unit, fontButtons[1]); fontControls.append(stepper, fontButtons[2])
  size.addEventListener("change", () => update(size.value))
  row(uiText("界面字号", "Interface font size"), uiText("调整插件文字大小，立即生效。", "Adjust text throughout the plugin. Changes apply immediately."), fontControls)
  const styleHost = element("div")
  styleHost.id = "jdx-reading-translation-style"; styleHost.setAttribute("data-jdx-translation-style", "")
  const select = createJdxSelect(styleHost, { ariaLabel: uiText("翻译浮窗样式", "Translation window style") })
  select.setOptions([{ value: "default", label: uiText("默认", "Default") }, { value: "glass", label: uiText("毛玻璃", "Frosted glass") }], readTranslationStyle(host))
  select.onChange(value => { savedStatus(saveTranslationStyle(host, value)); sync() })
  row(uiText("翻译浮窗样式", "Translation window style"), uiText("选文与全文翻译共用；毛玻璃可模糊背后的页面。", "Shared by selection and full-text translation. Frosted glass blurs the page behind it."), styleHost)
  const opacityControls = element("div"), opacityOutput = element("output")
  opacityControls.className = "jdx-reading-opacity-controls"
  const opacity = translationOpacityControl(host, doc, savedStatus)
  opacity.id = "jdx-reading-translation-opacity"
  opacityOutput.setAttribute("for", opacity.id); opacityOutput.setAttribute("data-jdx-translation-opacity-value", "")
  opacityControls.append(opacity, opacityOutput)
  row(uiText("浮窗背景透明度", "Window background transparency"), uiText("数值越高越通透，文字保持清晰。", "Higher values reveal more of the page. Text stays fully visible."), opacityControls)
  root.append(status)
  const target = container.querySelector<HTMLElement>(".jdx-manager-settings-card") ?? container
  target.insertBefore(root, target.querySelector<HTMLElement>("[role=status]"))
  function sync() {
    const value = readFontSize(host)
    size.value = String(value); fontButtons[0].disabled = value <= 12; fontButtons[1].disabled = value >= 24; fontButtons[2].disabled = value === 13
    select.setValue(readTranslationStyle(host)); syncTranslationOpacityControl(host, opacity)
  }
  sync()
  const observers: unknown[] = []
  for (const key of [FONT_SIZE_PREF, TRANSLATION_STYLE_PREF, TRANSLATION_OPACITY_PREF]) {
    try { observers.push(host?.Prefs?.registerObserver?.(key, sync, true)) } catch { /* 首次渲染仍有效。 */ }
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    for (const id of observers) if (id !== undefined) {
      try { host?.Prefs?.unregisterObserver?.(id) } catch { /* 窗口卸载后无需保留可选展示监听。 */ }
    }
    root.remove()
  }
}

function syncTranslationOpacityControl(host: UiPreferenceHost | null, range: HTMLInputElement) {
  range.value = String(100 - readTranslationOpacity(host))
  range.setAttribute("aria-valuetext", `${range.value}% ${uiText("透明", "transparent")}`)
  const output = range.parentElement?.querySelector<HTMLElement>("[data-jdx-translation-opacity-value]")
  if (output) output.textContent = `${range.value}%`
}

/** 滑块使用用户习惯的透明度方向；同一偏好同时更新设置页和已打开的翻译浮窗。 */
export function translationOpacityControl(host: UiPreferenceHost | null, doc: Document, onSave?: (saved: boolean) => void): HTMLInputElement {
  const range = doc.createElementNS("http://www.w3.org/1999/xhtml", "input") as HTMLInputElement
  range.type = "range"; range.min = "0"; range.max = "100"; range.step = "1"
  range.setAttribute("data-jdx-translation-opacity", "")
  range.setAttribute("aria-label", uiText("浮窗背景透明度", "Window background transparency"))
  syncTranslationOpacityControl(host, range)
  range.addEventListener("input", () => {
    const saved = saveTranslationOpacity(host, 100 - Number(range.value))
    onSave?.(saved)
    syncTranslationOpacityControl(host, range)
  })
  return range
}

export function translationStyleControl(host: UiPreferenceHost | null, doc: Document) {
  const select = doc.createElementNS("http://www.w3.org/1999/xhtml", "select") as HTMLSelectElement
  select.setAttribute("data-jdx-translation-style", "")
  select.setAttribute("aria-label", uiText("翻译浮窗样式", "Translation window style"))
  for (const [value, text] of [["default", uiText("默认", "Default")], ["glass", uiText("毛玻璃", "Frosted glass")]]) {
    const option = doc.createElementNS("http://www.w3.org/1999/xhtml", "option") as HTMLOptionElement
    option.value = value; option.textContent = text; select.append(option)
  }
  select.value = readTranslationStyle(host)
  select.addEventListener("change", () => { saveTranslationStyle(host, select.value); select.value = readTranslationStyle(host) })
  return select
}
