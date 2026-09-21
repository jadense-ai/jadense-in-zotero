/** 文献右键入口的独立原生窗口；不创建或依赖 Manager，配置按钮才显式打开设置。 */
import type { ZoteroLike } from './runtime'
import type { ZoteroManagerWindow } from './manager-window'
import { chromeContentUrl } from './chrome-registration'

export type ClassificationContext = { zotero: ZoteroLike; itemIDs: number[]; openSettings: () => void }
export type ClassificationWindow = Window & {
  arguments?: [ClassificationContext]
  JadenseClassification?: ClassificationContext
  receiveClassificationItems?: (ids: number[]) => void
}
const windows = new WeakMap<ZoteroLike, ClassificationWindow>()

export function openClassificationWindow(host: ZoteroLike, main: ZoteroManagerWindow | null, itemIDs: number[], openSettings: () => void) {
  if (!main?.openDialog) return false
  const context = { zotero: host, itemIDs: [...itemIDs], openSettings }
  const existing = windows.get(host)
  if (existing && !existing.closed) {
    existing.JadenseClassification = context
    existing.receiveClassificationItems?.(context.itemIDs)
    existing.focus(); return true
  }
  const width = Math.min(1080, (main.screen?.availWidth || 1280) - 40)
  const height = Math.min(720, (main.screen?.availHeight || 900) - 80)
  const opened = main.openDialog(chromeContentUrl('classification.xhtml'), 'jadense-in-zotero-classification', `chrome,dialog=no,titlebar,centerscreen,resizable,width=${width},height=${height}`, context) as ClassificationWindow | null
  if (!opened) return false
  opened.JadenseClassification = context
  windows.set(host, opened); opened.focus?.(); return true
}

export function closeClassificationWindow(host: ZoteroLike) {
  windows.get(host)?.close(); windows.delete(host)
}
