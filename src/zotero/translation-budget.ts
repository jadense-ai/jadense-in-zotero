/** 两种阅读翻译的独立手动上限；缺省自动使用同一模型能力与输出预留。 */
import type { ZoteroLike } from './runtime'
import { refreshModelCatalog } from './model-catalog'
import { translationModelBudget } from './model-budget'

export const DEFAULT_READING_CONTEXT = 131072
export const READING_BUDGET_PREF = 'extensions.jadenseInZotero.readingTranslationBudgets'
export type ReadingBudgetMode = 'pdf' | 'simple'
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

/** 请求目录不触发模型运行；短期共享、失败不阻断已有内容或本地预算。 */
export async function refreshTranslationLimits(host: ZoteroLike) {
  return refreshModelCatalog(host, 'fullTranslation')
}

/** 返回实际使用预算和可展示的上限；没有平台元数据时不臆造上限。 */
export function readingTranslationBudget(host: ZoteroLike, mode: ReadingBudgetMode) {
  let values: Record<string, unknown> = {}
  try { values = JSON.parse(String(host.Prefs?.get(READING_BUDGET_PREF, true) ?? '{}')) ?? {} } catch { /* 可选偏好降级。 */ }
  return translationModelBudget(host, positive(values[mode]) ? values[mode] : undefined)
}

/** 只写当前模式，未知扩展偏好保留；输入格式不合法时局部恢复默认。 */
export function saveReadingTranslationBudget(host: ZoteroLike, mode: ReadingBudgetMode, value?: number) {
  let values: Record<string, unknown> = {}
  try { const saved = JSON.parse(String(host.Prefs?.get(READING_BUDGET_PREF, true) ?? '{}')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) values = saved } catch { /* 可选偏好降级。 */ }
  const maximum = readingTranslationBudget(host, mode).maximum
  if (positive(value)) values[mode] = Math.min(Math.floor(value), maximum ?? Infinity)
  else delete values[mode]
  host.Prefs?.set?.(READING_BUDGET_PREF, JSON.stringify(values), true)
}
