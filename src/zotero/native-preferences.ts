import type { ZoteroLike } from "./runtime"
import { pluginResourceUrl } from "./chrome-registration"
declare const __JADENSE_BUILD_ID__: string

export const JADENSE_PREFERENCES_PANE_ID = "jadense-in-zotero-preferences"

export type BootstrapPluginContext = {
  pluginID: string
  rootURI: string
}

type PreferencesWindow = Window & typeof globalThis & {
  ZoteroPane?: {
    openPreferences?: (...args: unknown[]) => unknown
  }
  openDialog?: (...args: unknown[]) => unknown
}

export async function registerPreferencesPane(zotero: ZoteroLike, context: BootstrapPluginContext) {
  if (!zotero.PreferencePanes?.register) return null
  // 同版本重建也更换宿主缓存地址，避免旧原生表单继续引用旧 CSS/JS。
  const revision = typeof __JADENSE_BUILD_ID__ === 'string' ? `?v=${encodeURIComponent(__JADENSE_BUILD_ID__)}` : ''
  return await zotero.PreferencePanes.register({
    pluginID: context.pluginID,
    id: JADENSE_PREFERENCES_PANE_ID,
    label: "Jadense in Zotero",
    image: pluginResourceUrl(context.rootURI, "content/icons/logo-padded.png"),
    src: pluginResourceUrl(context.rootURI, "content/preferences.xhtml") + revision,
    scripts: [pluginResourceUrl(context.rootURI, "content/preferences.js") + revision],
    stylesheets: [pluginResourceUrl(context.rootURI, "content/preferences.css") + revision],
  })
}

export function unregisterPreferencesPane(zotero: ZoteroLike, paneID: string | null) {
  if (!paneID) return
  zotero.PreferencePanes?.unregister?.(paneID)
}

export function openPreferencesPane(zotero: ZoteroLike, win: PreferencesWindow | null) {
  const attempts: Array<() => unknown> = []
  if (zotero.Utilities?.Internal?.openPreferences) {
    attempts.push(() => zotero.Utilities?.Internal?.openPreferences?.(JADENSE_PREFERENCES_PANE_ID))
  }
  if (win?.ZoteroPane?.openPreferences) {
    attempts.push(() => win.ZoteroPane?.openPreferences?.(JADENSE_PREFERENCES_PANE_ID))
  }
  if (win?.openDialog) {
    attempts.push(() => win.openDialog?.(
      "chrome://zotero/content/preferences/preferences.xhtml",
      "zotero-preferences",
      "chrome,titlebar,toolbar,centerscreen,resizable",
      JADENSE_PREFERENCES_PANE_ID,
    ))
  }

  for (const attempt of attempts) {
    try {
      const result = attempt()
      if (result !== undefined && result !== false) return true
      if (result === undefined) return true
    } catch {
      // Try the next known Zotero preferences entry point.
    }
  }
  return false
}
