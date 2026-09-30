/** 两种阅读翻译的使用预算；平台目录只提供可选上限，BYOK 输入不与模型容量比较。 */
import { featureModelState } from './ai-settings'
import type { ZoteroLike } from './runtime'
import { featureModelMetadata, refreshModelCatalog } from './model-catalog'

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
  const requested = positive(values[mode]) ? Math.floor(values[mode]) : DEFAULT_READING_CONTEXT
  const model = featureModelState(host, 'fullTranslation'), option = featureModelMetadata(host, 'fullTranslation')
  const maximum = positive(option?.contextWindow) ? Math.floor(option.contextWindow) : undefined
  const contextWindow = maximum ? Math.min(requested, maximum) : requested
  const maxOutputTokens = model.route === 'byok' ? model.config?.maxOutputTokens : option?.maxOutputTokens
  const sourceTokens = Math.max(32, Math.floor(Math.min((contextWindow - 1024) / 4, positive(maxOutputTokens) ? (maxOutputTokens - 512) / 3 : Infinity)))
  return { requested, contextWindow, maximum, maxOutputTokens, sourceTokens, route: model.route }
}

/** 只写当前模式，未知扩展偏好保留；输入格式不合法时局部恢复默认。 */
export function saveReadingTranslationBudget(host: ZoteroLike, mode: ReadingBudgetMode, value: number) {
  let values: Record<string, unknown> = {}
  try { const saved = JSON.parse(String(host.Prefs?.get(READING_BUDGET_PREF, true) ?? '{}')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) values = saved } catch { /* 可选偏好降级。 */ }
  const maximum = readingTranslationBudget(host, mode).maximum
  values[mode] = Math.min(positive(value) ? Math.floor(value) : DEFAULT_READING_CONTEXT, maximum ?? Infinity)
  host.Prefs?.set?.(READING_BUDGET_PREF, JSON.stringify(values), true)
}
