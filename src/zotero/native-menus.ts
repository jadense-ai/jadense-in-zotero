/** 原生菜单保留宿主壳与 Fluent ID，只以启动语言参数选择插件文案。 */
import { getUiLocale } from "./ui-preferences"
import type {
  ZoteroLike,
  ZoteroMenuRegistration,
} from "./runtime"

export const JADENSE_TOOLS_MENU_ID = "jadense-in-zotero-tools-menu"
export const JADENSE_COLLECTION_MENU_ID = "jadense-in-zotero-collection-menu"

export type MenuCallbacks = {
  openManager: () => void
  configureConnection: () => void
  exportSelectedItems: () => void
  exportSelectedCollection: () => void
  disconnect: () => void
}

export function buildJadenseMenuRegistrations(
  pluginID: string,
  callbacks: MenuCallbacks,
): ZoteroMenuRegistration[] {
  return [
    {
      menuID: JADENSE_TOOLS_MENU_ID,
      pluginID,
      target: "main/menubar/tools",
      menus: [
        {
          menuType: "submenu",
          l10nArgs: JSON.stringify({ language: getUiLocale() }),
          l10nID: "jadense-in-zotero-menu-main",
          menus: [
            {
              menuType: "menuitem",
              l10nArgs: JSON.stringify({ language: getUiLocale() }),
              l10nID: "jadense-in-zotero-menu-open-manager",
              onCommand: callbacks.openManager,
            },
            {
              menuType: "menuitem",
              l10nArgs: JSON.stringify({ language: getUiLocale() }),
              l10nID: "jadense-in-zotero-menu-configure",
              onCommand: callbacks.configureConnection,
            },
            { menuType: "separator" },
            {
              menuType: "menuitem",
              l10nArgs: JSON.stringify({ language: getUiLocale() }),
              l10nID: "jadense-in-zotero-menu-export-collection",
              onCommand: callbacks.exportSelectedCollection,
            },
            {
              menuType: "menuitem",
              l10nArgs: JSON.stringify({ language: getUiLocale() }),
              l10nID: "jadense-in-zotero-menu-export-items",
              onCommand: callbacks.exportSelectedItems,
            },
            { menuType: "separator" },
            {
              menuType: "menuitem",
              l10nArgs: JSON.stringify({ language: getUiLocale() }),
              l10nID: "jadense-in-zotero-menu-disconnect",
              onCommand: callbacks.disconnect,
            },
          ],
        },
      ],
    },
    {
      menuID: JADENSE_COLLECTION_MENU_ID,
      pluginID,
      target: "main/library/collection",
      menus: [
        {
          menuType: "submenu",
          l10nArgs: JSON.stringify({ language: getUiLocale() }),
          l10nID: "jadense-in-zotero-menu-main",
          menus: [
            {
              menuType: "menuitem",
              l10nArgs: JSON.stringify({ language: getUiLocale() }),
              l10nID: "jadense-in-zotero-menu-open-manager",
              onCommand: callbacks.openManager,
            },
            { menuType: "separator" },
            {
              menuType: "menuitem",
              l10nArgs: JSON.stringify({ language: getUiLocale() }),
              l10nID: "jadense-in-zotero-menu-export-collection",
              onCommand: callbacks.exportSelectedCollection,
            },
          ],
        },
      ],
    },
  ]
}

function defaultMenuHandle(pluginID: string, menuID: string) {
  return `${pluginID}-${menuID}`
}

export function registerNativeMenus(
  zotero: ZoteroLike,
  pluginID: string,
  callbacks: MenuCallbacks,
) {
  if (!zotero.MenuManager?.registerMenu) return []
  const registeredIDs: string[] = []
  for (const registration of buildJadenseMenuRegistrations(pluginID, callbacks)) {
    const registeredID = zotero.MenuManager.registerMenu(registration)
    if (registeredID === false) continue
    registeredIDs.push(typeof registeredID === "string" && registeredID.length > 0
      ? registeredID
      : defaultMenuHandle(pluginID, registration.menuID))
  }
  return registeredIDs
}

export function unregisterNativeMenus(zotero: ZoteroLike, menuIDs: string[], _pluginID = "") {
  for (const id of menuIDs) {
    try {
      zotero.MenuManager?.unregisterMenu?.(id)
    } catch {
      // Continue unregistering the remaining menu handles.
    }
  }
}
