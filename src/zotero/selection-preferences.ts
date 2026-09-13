/** 选文交互偏好：仅保存展示配置与用户几何，不保存选文或自动触发状态。 */
import type { UiPreferenceHost } from './ui-preferences'

export const SELECTION_PREF = 'extensions.jadenseInZotero.selectionExperience'
export type SelectionPreferences = {
  placement: 'remember' | 'selection'
  behavior: 'wait' | 'translate' | 'quote'
  geometry?: { left: number; top: number; width: number; height: number }
}
export function readSelectionPreferences(host: UiPreferenceHost): SelectionPreferences {
  let value: Partial<SelectionPreferences> = {}
  try { value = JSON.parse(String(host.Prefs?.get(SELECTION_PREF, true) || '{}')) || {} } catch { /* 损坏偏好回到默认。 */ }
  const geometry = value.geometry
  return {
    placement: value.placement === 'selection' ? 'selection' : 'remember',
    behavior: value.behavior === 'translate' || value.behavior === 'quote' ? value.behavior : 'wait',
    ...(geometry && [geometry.left, geometry.top, geometry.width, geometry.height].every(Number.isFinite)
      && geometry.width > 0 && geometry.height > 0 ? { geometry } : {}),
  }
}
export function saveSelectionPreferences(host: UiPreferenceHost, patch: Partial<SelectionPreferences>) {
  try { host.Prefs?.set?.(SELECTION_PREF, JSON.stringify({ ...readSelectionPreferences(host), ...patch }), true) } catch { /* 展示偏好保存失败不阻断当前操作。 */ }
}
