import type { ZoteroLike } from "./runtime"
import { pluginResourceUrl } from "./chrome-registration"

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
  return await zotero.PreferencePanes.register({
    pluginID: context.pluginID,
    id: JADENSE_PREFERENCES_PANE_ID,
    label: "Jadense in Zotero",
    image: pluginResourceUrl(context.rootURI, "content/icons/logo-padded.png"),
    src: pluginResourceUrl(context.rootURI, "content/preferences.xhtml"),
    scripts: [pluginResourceUrl(context.rootURI, "content/preferences.js")],
    stylesheets: [pluginResourceUrl(context.rootURI, "content/preferences.css")],
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
