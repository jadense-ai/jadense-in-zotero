/** 阅读器快捷键契约：设置页录制并保存组合键，PDF 截图与翻译入口在每次按键时读取。 */
export type ReaderShortcutAction = "capture" | "translate"

type ShortcutHost = {
  Prefs?: {
    get(key: string): unknown
    set?(key: string, value: string): unknown
  }
}

export const READER_SHORTCUT_DEFAULTS: Record<ReaderShortcutAction, string> = {
  capture: "Mod+Alt+S",
  translate: "Mod+Alt+T",
}

const MODIFIERS = ["Mod", "Ctrl", "Meta", "Alt", "Shift"]
const NAMED_KEYS = ["Space", "Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backquote"]

function preferenceKey(action: ReaderShortcutAction) {
  return `extensions.jadenseInZotero.readerShortcut.${action}`
}

/** 字母、数字与物理标点键统一为可保存的名字，避免 macOS Option 改写 event.key。 */
function eventKey(event: KeyboardEvent): string {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3)
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  if (NAMED_KEYS.includes(event.code)) return event.code
  if (event.key === " ") return "Space"
  return event.key?.length === 1 ? event.key.toUpperCase() : event.key
}

function canonicalShortcut(value: unknown): string | null {
  if (typeof value !== "string") return null
  if (!value.trim()) return ""
  const parts = value.split("+").map(part => part.trim())
  const rawKey = parts.pop() ?? ""
  const key = /^[a-z0-9]$/i.test(rawKey) ? rawKey.toUpperCase() : rawKey
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(key) && !NAMED_KEYS.includes(key)) return null
  if (parts.some(part => !MODIFIERS.includes(part))) return null
  return [...MODIFIERS.filter(modifier => parts.includes(modifier)), key].join("+")
}

/** 缺失、损坏或不可读的可选首选项使用默认值；空字符串明确表示停用。 */
export function readReaderShortcut(zotero: ShortcutHost | null | undefined, action: ReaderShortcutAction): string {
  try {
    return canonicalShortcut(zotero?.Prefs?.get(preferenceKey(action))) ?? READER_SHORTCUT_DEFAULTS[action]
  } catch {
    return READER_SHORTCUT_DEFAULTS[action]
  }
}

/** 保存失败仅返回给设置页，不影响现有 Reader 工具或 AI 配置。 */
export function saveReaderShortcut(zotero: ShortcutHost | null | undefined, action: ReaderShortcutAction, shortcut: string): boolean {
  const value = canonicalShortcut(shortcut)
  if (value === null || !zotero?.Prefs?.set) return false
  try {
    zotero.Prefs.set(preferenceKey(action), value)
    return true
  } catch {
    return false
  }
}

function eventPlatform(event?: KeyboardEvent): string {
  return (event?.target as Node | null)?.ownerDocument?.defaultView?.navigator.platform
    ?? event?.view?.navigator.platform
    ?? (typeof navigator === "undefined" ? "" : navigator.platform)
}

/** 展示系统对应的修饰键；显式录制的 Ctrl/Meta 保持原语义。 */
export function formatReaderShortcut(shortcut: string, platform = eventPlatform()): string {
  return shortcut.replace(/\bMod\b/g, /mac/i.test(platform) ? "Meta" : "Ctrl")
    .replace(/\bMeta\b/g, /mac/i.test(platform) ? "Cmd" : "Meta")
    .split("+").join(" + ")
}

/** 录制完整组合键；修饰键本身、输入法与重复按键不会改写草稿。 */
export function readerShortcutFromEvent(event: KeyboardEvent): string | null {
  if (event.repeat || event.isComposing) return null
  const modifiers = [event.ctrlKey && "Ctrl", event.metaKey && "Meta", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean)
  return canonicalShortcut([...modifiers, eventKey(event)].join("+"))
}

/** 精确匹配全部修饰键并避开编辑区，确保一次按键只触发显式指定的阅读操作。 */
export function matchesReaderShortcut(event: KeyboardEvent, shortcut: string): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false
  const target = event.target as HTMLElement | null
  if (target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')) return false
  const canonical = canonicalShortcut(shortcut)
  if (!canonical) return false
  const parts = canonical.split("+")
  const key = parts.pop()
  const mac = /mac/i.test(eventPlatform(event))
  return eventKey(event) === key
    && event.ctrlKey === (parts.includes("Ctrl") || parts.includes("Mod") && !mac)
    && event.metaKey === (parts.includes("Meta") || parts.includes("Mod") && mac)
    && event.altKey === parts.includes("Alt")
    && event.shiftKey === parts.includes("Shift")
}
