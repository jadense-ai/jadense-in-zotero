/** 模型目录的可选元数据缓存：同账号共享容量与思考能力，不承担模型准入。 */
import { JadenseApiClient, type JadenseChatModelCatalog } from '@/jadense/api'
import { featureModelState, readByokSettings, rememberAiModelCapabilities, type AiFeature, type FeatureModelSelection } from './ai-settings'
import { readConnection, type ZoteroLike } from './runtime'

type Cache = { identity: string; catalog?: JadenseChatModelCatalog; fetchedAt?: number; pending?: Promise<void> }
const caches = new WeakMap<ZoteroLike, Cache>()
function identity(host: ZoteroLike) { const connection = readConnection(host); return JSON.stringify([connection.baseUrl, connection.token]) }

/** UI 已校验连接代次后可发布同一目录，预算无需重复请求。 */
export function rememberModelCatalog(host: ZoteroLike, catalog: JadenseChatModelCatalog) {
  rememberAiModelCapabilities(host, catalog)
  caches.set(host, { identity: identity(host), catalog, fetchedAt: Date.now() })
}

export function cachedModelCatalog(host: ZoteroLike) {
  const cache = caches.get(host)
  return cache?.identity === identity(host) ? cache.catalog : undefined
}

/** 失败只影响元数据显示，绝不把目录健康作为发送条件。 */
export async function refreshModelCatalog(host: ZoteroLike, feature: AiFeature, fetchImpl?: typeof fetch) {
  if (featureModelState(host, feature).route !== 'jadense') return
  const connection = readConnection(host)
  if (!connection.token) return
  const key = identity(host)
  let cache = caches.get(host)
  if (cache?.identity !== key) { cache = { identity: key }; caches.set(host, cache) }
  if (cache.pending) return cache.pending
  if (cache.fetchedAt && Date.now() - cache.fetchedAt < 60_000) return
  const current = cache
  current.pending = (async () => {
    try {
      const win = host.getMainWindow?.()
      current.catalog = await new JadenseApiClient({ ...connection, fetchImpl: fetchImpl ?? win?.fetch?.bind(win) }).getChatModels(AbortSignal.timeout(5000))
      if (identity(host) === key) rememberAiModelCapabilities(host, current.catalog)
    } catch { /* 可选元数据不可用时沿用同连接快照或调用方本地回退。 */ }
    finally { current.fetchedAt = Date.now(); current.pending = undefined }
  })()
  return current.pending
}

export function featureModelMetadata(host: ZoteroLike, feature: AiFeature) {
  return selectionModelMetadata(host, featureModelState(host, feature).selection)
}

/** 按实际选择读取能力，BYOK 与平台使用同一接缝；不回退到另一模型。 */
export function selectionModelMetadata(host: ZoteroLike, selection: FeatureModelSelection) {
  if (selection.route === 'byok') return readByokSettings(host).models.find(model => model.id === selection.modelId)
  const catalog = cachedModelCatalog(host)
  const selected = selection.selection?.kind === 'default' || !selection.selection ? catalog?.defaultSelection : selection.selection
  return catalog?.options.find(option => selected?.kind === 'model'
    ? option.kind === 'model' && option.modelId === selected.modelId
    : selected?.kind === 'route' && option.kind === 'route' && option.routeTier === selected.routeTier)
}
