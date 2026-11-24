/** 系统浏览器完成账号授权。一次性 PKCE 回调、凭据更换和取消由同一 Zotero host 协调。 */
import { openAccountCallback } from './account-loopback'
import { credentialPointer, forgetStoredCredential, persistCredential, readAccountCredential, type AccountIdentity } from './account-credential'
import { clearAccountData, clearConnection, initializeAccountConnection, readConnection, rekeyAccountUploadAttempts, type ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

const SOURCE = 'jadense-in-zotero'
const INSTALL_ID = 'extensions.jadenseInZotero.accountInstallId'
type Connection = { baseUrl: string; token: string }
type Attempt = { controller: AbortController; promise: Promise<void> }
type Host = ZoteroLike & { launchURL?(url: string): void; __jadenseBrowserAuthorization?: Attempt }

function network(host: Host) {
  const win = host.getMainWindow?.()
  return win?.fetch?.bind(win) ?? globalThis.fetch.bind(globalThis)
}

function requiredString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }

async function verifyIdentity(connection: Connection, fetchImpl: typeof fetch, signal?: AbortSignal) {
  try {
    const response = await fetchImpl(connection.baseUrl + '/api/account-links/identity', {
      headers: { Authorization: 'Bearer ' + connection.token }, redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
    })
    if (response.status === 401) return { status: 'invalid' } as const
    if (!response.ok) return { status: 'unavailable' } as const
    const data: unknown = await response.json()
    const v = data as Record<string, unknown> | null
    if (v?.source !== SOURCE || !requiredString(v.sub) || !requiredString(v.site) || !requiredString(v.link_id)) return { status: 'unavailable' } as const
    return { status: 'valid', identity: { site: v.site, sub: v.sub, linkId: v.link_id } } as const
  } catch { return { status: 'unavailable' } as const }
}

export async function checkJadenseCredential(connection: Connection, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis), signal?: AbortSignal) {
  return (await verifyIdentity(connection, fetchImpl, signal ?? AbortSignal.timeout(10_000))).status
}

export function readJadenseAuthorizationState(host: Host) {
  const connection = readConnection(host)
  const pointer = credentialPointer(host)
  const credential = readAccountCredential(host, connection.baseUrl)
  const mode = credential?.mode ?? (pointer ? (pointer.includes(':legacy:') ? 'legacy' : 'browser') : 'disconnected')
  return { mode, available: Boolean(credential?.token), pending: Boolean(host.__jadenseBrowserAuthorization), scopes: credential?.scopes ?? [] }
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function stableInstallId(host: Host, platform: Crypto) {
  try {
    const previous = host.Prefs?.get(INSTALL_ID, true)
    if (typeof previous === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(previous)) return previous
    const value = platform.randomUUID()
    host.Prefs?.set(INSTALL_ID, value, true)
    return host.Prefs?.get(INSTALL_ID, true) === value ? value : undefined
  } catch { return undefined } // 安装标记仅供网站合并同一设备，不承担身份认证。
}

async function revokeDevice(connection: Connection, web: typeof fetch) {
  try {
    const response = await web(connection.baseUrl + '/api/extension/link/token', {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + connection.token }, redirect: 'error',
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    })
    return response.ok || response.status === 401
  } catch { return false }
}

function sameIdentity(old: AccountIdentity | undefined, next: AccountIdentity) {
  return Boolean(old && old.site === next.site && old.sub === next.sub)
}

async function authorize(host: Host, controller: AbortController) {
  const { signal } = controller
  const start = readConnection(host)
  const previous = credentialPointer(host)
  const previousCredential = readAccountCredential(host, start.baseUrl)
  const web = network(host)
  const platform = host.getMainWindow?.()?.crypto ?? globalThis.crypto
  const installId = stableInstallId(host, platform)
  const state = base64Url(platform.getRandomValues(new Uint8Array(32)))
  const verifier = base64Url(platform.getRandomValues(new Uint8Array(32)))
  const challenge = base64Url(new Uint8Array(await platform.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  signal.throwIfAborted()
  const callback = openAccountCallback(host, state, signal)
  let uncommitted: Connection | undefined
  try {
    const url = new URL('/account/link', start.baseUrl)
    url.search = new URLSearchParams({ source: SOURCE, redirect_uri: callback.redirectUri, state,
      code_challenge: challenge, code_challenge_method: 'S256', ...(installId ? { install_id: installId } : {}) }).toString()
    if (!host.launchURL) throw new Error(uiText('无法打开系统浏览器。', 'The system browser is unavailable.'))
    host.launchURL(url.href)
    const code = await callback.result
    const response = await web(start.baseUrl + '/api/extension/link/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      body: JSON.stringify({ source: SOURCE, redirectUri: callback.redirectUri, code, codeVerifier: verifier }),
    })
    if (!response.ok) throw new Error(uiText('未能兑换本次授权，请重新连接。', 'Could not exchange the authorization code. Connect again.'))
    const value = await response.json() as Record<string, unknown> | null
    if (!requiredString(value?.accessToken)) throw new Error(uiText('未收到有效的授权结果。', 'The authorization response is invalid.'))
    const next = { baseUrl: start.baseUrl, token: value.accessToken }
    if (next.token !== start.token) uncommitted = next
    if (!requiredString(value.linkId)) throw new Error(uiText('未收到有效的授权结果。', 'The authorization response is invalid.'))
    const verified = await verifyIdentity(next, web, signal)
    if (verified.status !== 'valid' || verified.identity.linkId !== value.linkId) throw new Error(uiText('未能核实授权账号，请重试。', 'Could not verify the account. Please try again.'))
    let oldIdentity = previousCredential?.identity
    if (!oldIdentity && start.token && start.token !== next.token) {
      const old = await verifyIdentity(start, web, AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
      if (old.status === 'valid') oldIdentity = old.identity
    }
    const sameAccount = start.token === next.token || sameIdentity(oldIdentity, verified.identity)
    const scopes = Array.isArray(value.scopes) ? value.scopes.filter(requiredString) : []
    const dataOwner = sameAccount ? previousCredential?.dataOwner : platform.randomUUID()
    await persistCredential(host, { ...next, mode: 'browser', scopes, identity: verified.identity, dataOwner }, previous,
      () => !signal.aborted && readConnection(host).baseUrl === start.baseUrl)
    uncommitted = undefined
    try {
      if (sameAccount) rekeyAccountUploadAttempts(host, start, verified.identity, previousCredential?.identity)
      else clearAccountData(host, true)
    } catch { /* 账号绑定的数据投影已切换；旧缓存无法被新账号读取。 */ }
    initializeAccountConnection(host)
  } finally {
    callback.close()
    if (uncommitted) await revokeDevice(uncommitted, web)
  }
}

/** 工作台、原生设置及菜单同时发起时，共享同一次浏览器授权。 */
export function authorizeJadenseAccount(host: Host): Promise<void> {
  if (host.__jadenseBrowserAuthorization) return host.__jadenseBrowserAuthorization.promise
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(uiText('浏览器授权已超时，请重新连接。', 'Browser authorization timed out. Connect again.'))), 5 * 60_000)
  const promise = Promise.resolve().then(() => authorize(host, controller)).finally(() => {
    clearTimeout(timer)
    if (host.__jadenseBrowserAuthorization?.controller === controller) delete host.__jadenseBrowserAuthorization
  })
  host.__jadenseBrowserAuthorization = { controller, promise }
  return promise
}

export function cancelJadenseAuthorization(host: Host) {
  const attempt = host.__jadenseBrowserAuthorization
  delete host.__jadenseBrowserAuthorization
  attempt?.controller.abort(new Error(uiText('浏览器授权已取消。', 'Browser authorization cancelled.')))
}

export async function disconnectJadenseAccount(host: Host): Promise<{ revocation: 'revoked' | 'unconfirmed' | 'local-only' }> {
  cancelJadenseAuthorization(host)
  const connection = readConnection(host)
  const pointer = credentialPointer(host)
  const mode = readJadenseAuthorizationState(host).mode
  clearConnection(host)
  try { forgetStoredCredential(host, pointer) } catch { /* 清除指针后无法再加载旧凭据。 */ }
  if (mode !== 'browser') return { revocation: 'local-only' }
  if (connection.token && await revokeDevice(connection, network(host))) return { revocation: 'revoked' }
  return { revocation: 'unconfirmed' }
}
