/** 启动时固定旧翻译配置；只补缺失用途，失败保留旧键供运行时读取。 */
import type { ZoteroLike } from './runtime'
import { FEATURE_MODEL_PREF_KEYS, LEGACY_TRANSLATION_MODEL_PREF, normalizeFeatureModelSelection, readFeatureModelSelection } from './ai-settings'
import { readTranslationInterface, TRANSLATION_INTERFACE_PREFS } from './translation-interface'

export const TRANSLATION_CONFIG_MIGRATION_PREF = 'extensions.jadenseInZotero.translationConfigVersion'
export function migrateTranslationConfiguration(host: ZoteroLike): boolean {
  try {
    if (host.Prefs?.get(TRANSLATION_CONFIG_MIGRATION_PREF, true) === 1) return true
    if (!host.Prefs?.set) return false
    const legacy = readTranslationInterface(host)
    let model = null
    try { model = normalizeFeatureModelSelection(JSON.parse(String(host.Prefs.get(LEGACY_TRANSLATION_MODEL_PREF) || 'null'))) } catch { /* 旧模型无效时使用现有初始化策略。 */ }
    model ??= readFeatureModelSelection(host, 'fullTranslation')
    for (const key of Object.values(TRANSLATION_INTERFACE_PREFS)) {
      if (host.Prefs.get(key, true) == null) host.Prefs.set(key, JSON.stringify(legacy), true)
    }
    for (const key of [FEATURE_MODEL_PREF_KEYS.translation, FEATURE_MODEL_PREF_KEYS.fullTranslation]) {
      if (host.Prefs.get(key) == null && (model.route === 'byok' || model.selection)) host.Prefs.set(key, JSON.stringify(model))
    }
    host.Prefs.set(TRANSLATION_CONFIG_MIGRATION_PREF, 1, true)
    return true
  } catch { return false }
}
