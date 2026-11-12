/** 模型能力与本次请求预算：功能只拥有内容策略，目录缺失不成为新的发送准入条件。 */
import { featureModelState, readByokConfigForSelection, type AiFeature, type FeatureModelSelection } from './ai-settings'
import { selectionModelMetadata } from './model-catalog'
import type { ZoteroLike } from './runtime'
/** 与现有全文引擎以外的估算一致；不是 Provider 精确分词，预算另留安全余量。 */
export { textTokenCost } from '@/chat/token-budget'

export const FALLBACK_TRANSLATION_CONTEXT = 131072
export const positiveTokens = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && Math.floor(value) > 0 ? Math.floor(value) : undefined
/** 显式selection冻结本次目的地；缺字段只回退对应能力，不重选提供商或建立目录准入。 */
export function readModelLimits(host: ZoteroLike, feature: AiFeature, options: { fallbackContext?: number; selection?: FeatureModelSelection; structured?: boolean } = {}) {
  const model = featureModelState(host, feature), selection = options.selection ?? model.selection
  const metadata = selectionModelMetadata(host, selection)
  const maximum = positiveTokens(metadata?.contextWindow)
  const contextWindow = maximum ?? options.fallbackContext ?? 16384
  const maxOutputTokens = positiveTokens(metadata?.maxOutputTokens) ?? (selection.route === 'byok' ? readByokConfigForSelection(host, selection)?.maxOutputTokens : undefined)
  const outputLimit = Math.min(maxOutputTokens ?? (selection.route === 'byok' ? 96000 : 65536), selection.route === 'jadense' && !options.structured ? 65536 : Infinity)
  return { contextWindow, maximum, maxOutputTokens, outputLimit, selection, source: maximum ? 'model' as const : 'fallback' as const,
    safetyTokens: Math.max(256, Math.ceil(contextWindow * .02)) }
}

/** Chat/解析为输出预留窗口的四分之一；实际请求携带同一预算，不能只在本地扣减。 */
export function modelRequestBudget(host: ZoteroLike, feature: AiFeature, options: Parameters<typeof readModelLimits>[2] = {}) {
  const limits = readModelLimits(host, feature, options)
  const output = Math.max(1, Math.min(limits.outputLimit, Math.floor(limits.contextWindow / 4)))
  return { ...limits, output, input: Math.max(1, limits.contextWindow - output - limits.safetyTokens - 512) }
}

/** 连续翻译按原文三倍预留译文；上下文、手动上限与实际输出能力共同约束分片。 */
export function translationModelBudget(host: ZoteroLike, requested?: number) {
  const limits = readModelLimits(host, 'translation', { fallbackContext: FALLBACK_TRANSLATION_CONTEXT })
  const manual = positiveTokens(requested)
  const contextWindow = Math.min(manual ?? limits.contextWindow, limits.maximum ?? Infinity)
  const available = Math.max(1, contextWindow - Math.max(256, Math.ceil(contextWindow * .02)) - 1024)
  const maxOutputTokens = Math.max(1, Math.min(limits.outputLimit, Math.floor(available * .75)))
  const sourceTokens = Math.max(1, Math.floor(Math.min(available / 4, (maxOutputTokens - 512) / 3)))
  return { requested: manual ?? limits.contextWindow, contextWindow, maximum: limits.maximum, maxOutputTokens, sourceTokens,
    automatic: manual === undefined, source: limits.source, route: limits.selection.route }
}
