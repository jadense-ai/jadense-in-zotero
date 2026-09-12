import type { ZoteroLike } from "./runtime"

/** 工作台首次打开的本地引导；只解释两种 AI 配置方式，不参与连接或模型请求。 */
export const QUICK_START_SHOWN_PREF_KEY = "extensions.jadenseInZotero.quickStartShown"

export function shouldShowManagerQuickStart(zotero: ZoteroLike) {
  try {
    const value = zotero.Prefs?.get(QUICK_START_SHOWN_PREF_KEY)
    return !(value === true || value === "true")
  } catch {
    return true
  }
}

export function markManagerQuickStartShown(zotero: ZoteroLike) {
  try { zotero.Prefs?.set(QUICK_START_SHOWN_PREF_KEY, true) } catch { /* 引导状态保存失败不影响工作台。 */ }
}

/** 首次关闭或跳转后记住已看过引导，避免每次打开工作台都打断用户。 */
export function wireManagerQuickStart(document: Document, zotero: ZoteroLike | null, openFeatureSettings: () => void) {
  if (!zotero || !shouldShowManagerQuickStart(zotero)) return
  const dialog = document.getElementById("jadense-quick-start-dialog") as HTMLDialogElement | null
  const close = document.getElementById("jadense-quick-start-close") as HTMLButtonElement | null
  const settings = document.getElementById("jadense-quick-start-settings") as HTMLButtonElement | null
  if (!dialog || !close || !settings) return
  const finish = () => {
    markManagerQuickStartShown(zotero)
    if (dialog.open) dialog.close()
  }
  close.addEventListener("click", finish)
  settings.addEventListener("click", () => {
    finish()
    openFeatureSettings()
  })
  dialog.addEventListener("close", () => markManagerQuickStartShown(zotero), { once: true })
  window.setTimeout(() => {
    if (!dialog.open) dialog.showModal()
  }, 0)
}
