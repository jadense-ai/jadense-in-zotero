/**
 * 临时AI的账户与能力探针：使用服务端鉴权身份隔离本地任务，凭据轮换不改变归属。
 * 旧服务器保持原令牌摘要；能力缓存仅在同网络适配器/凭据内复用，不保存密钥到磁盘。
 */
import { readJadenseApiError } from '@/jadense/api'
import { uiText } from '@/zotero/ui-preferences'
import { requestHash } from './temporary-request-store'

export type TemporaryAccountOptions = { baseUrl: string; token: string; fetchImpl?: typeof fetch; signal?: AbortSignal }
type Capability = { account: string; verified: boolean; headers: Headers; expires: number }
const caches = new WeakMap<typeof fetch, Map<string, Capability>>()
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

/** 同令牌成功探针短期复用；不同令牌必须重新取得服务器确认，不能猜测同一用户。 */
export async function temporaryAccountCapability(options: TemporaryAccountOptions): Promise<Capability> {
  const base = options.baseUrl.trim().replace(/\/+$/u, ''), network = options.fetchImpl ?? defaultFetch
  const credential = await requestHash(base + '\n' + options.token.trim())
  let cache = caches.get(network)
  if (!cache) { cache = new Map(); caches.set(network, cache) }
  const cached = cache.get(credential)
  options.signal?.throwIfAborted()
  if (cached && cached.expires > Date.now()) return cached
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 30_000)
  try {
    const response = await network(`${base}/api/chat/temporary`, { method: 'HEAD',
      headers: { authorization: `Bearer ${options.token.trim()}`, 'x-jadense-temporary-protocol': '1' }, signal: controller.signal })
    if (!response.ok) throw await readJadenseApiError(response, uiText('请检查当前 Zotero 令牌与对话权限。', 'Check the current Zotero token and chat permissions.'))
    if (response.headers.get('x-jadense-temporary-protocol') !== '1')
      throw Object.assign(new Error(uiText('服务器不支持安全恢复，请升级服务器。', 'Upgrade the server to support safe recovery.')), { code: 'TEMPORARY_PROTOCOL_UNSUPPORTED' })
    const owner = response.headers.get('x-jadense-temporary-account')?.trim()
    const capability = { account: owner ? await requestHash(base + '\nowner:' + owner) : credential,
      verified: Boolean(owner), headers: response.headers, expires: Date.now() + 300_000 }
    cache.set(credential, capability)
    return capability
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
}

/** 任务只持久保存隔离摘要，不保存令牌或服务端原始用户标识。 */
export async function resolveTemporaryAccount(options: TemporaryAccountOptions): Promise<{ account: string; verified: boolean }> {
  const { account, verified } = await temporaryAccountCapability(options)
  return { account, verified }
}

export async function forgetTemporaryAccount(options: TemporaryAccountOptions) {
  const base = options.baseUrl.trim().replace(/\/+$/u, '')
  caches.get(options.fetchImpl ?? defaultFetch)?.delete(await requestHash(base + '\n' + options.token.trim()))
}
