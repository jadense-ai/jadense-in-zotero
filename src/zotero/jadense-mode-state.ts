/** 模式与引擎偏好的唯一所有者；只在显式切换时写入，页面读取不改变用户选择。 */
import type { ZoteroLike } from './runtime'
export const MODE_PREF = 'extensions.jadenseInZotero.jadenseMode'
export const OCR_ENGINE_PREF = 'extensions.jadenseInZotero.ocrEngine'
export const LAST_OCR_PREF = 'extensions.jadenseInZotero.lastNonJadenseOCR'
export const MODE_CONSENT_PREF = 'extensions.jadenseInZotero.jadenseModeConsent'
export function modeEnabled(host: ZoteroLike) {
  try { return host.Prefs?.get(MODE_PREF, true) === true } catch { return false }
}
export function saveOCREngine(host: ZoteroLike, engine: string) {
  if (engine !== 'jadense') host.Prefs?.set(LAST_OCR_PREF, engine, true)
  host.Prefs?.set(OCR_ENGINE_PREF, engine, true)
}
/** 就绪 unknown 不代表没有引擎；自动选择只发生在 off → on。 */
export function saveJadenseMode(host: ZoteroLike, enabled: boolean, ready: boolean | null = null) {
  if (modeEnabled(host) === enabled) return
  const engine = String(host.Prefs?.get(OCR_ENGINE_PREF, true) || 'local')
  if (enabled) {
    if (engine !== 'jadense') host.Prefs?.set(LAST_OCR_PREF, engine, true)
    host.Prefs?.set(MODE_PREF, true, true)
    if (engine === 'local' && ready === false) saveOCREngine(host, 'jadense')
  } else {
    if (engine === 'jadense') saveOCREngine(host, String(host.Prefs?.get(LAST_OCR_PREF, true) || 'local'))
    host.Prefs?.set(MODE_PREF, false, true)
  }
}
export function observeJadenseMode(host: ZoteroLike, callback: () => void) {
  let id: unknown
  try { id = host.Prefs?.registerObserver?.(MODE_PREF, callback, true) } catch { /* 可选同步不阻断原生工具栏。 */ }
  callback()
  return () => { if (id !== undefined) host.Prefs?.unregisterObserver?.(id) }
}
