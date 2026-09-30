/** 启动时固定旧翻译配置；只补缺失用途，失败保留旧键供运行时读取。 */
import type { ZoteroLike } from './runtime'
import { initializeFeatureModelSelections, aiModelMigrationFailed } from './ai-settings'
import { readTranslationInterface, TRANSLATION_INTERFACE_PREFS } from './translation-interface'

export const TRANSLATION_CONFIG_MIGRATION_PREF = 'extensions.jadenseInZotero.translationConfigVersion'
export function migrateTranslationConfiguration(host: ZoteroLike): boolean {
  initializeFeatureModelSelections(host)
  try {
    if (host.Prefs?.get(TRANSLATION_CONFIG_MIGRATION_PREF, true) === 1) return !aiModelMigrationFailed(host)
    if (!host.Prefs?.set) return false
    const legacy = readTranslationInterface(host)
    for (const key of Object.values(TRANSLATION_INTERFACE_PREFS)) {
      if (host.Prefs.get(key, true) == null) host.Prefs.set(key, JSON.stringify(legacy), true)
    }
    host.Prefs.set(TRANSLATION_CONFIG_MIGRATION_PREF, 1, true)
    return !aiModelMigrationFailed(host)
  } catch { return false }
}
