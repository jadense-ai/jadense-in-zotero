/** 以稳定的 profile 偏好指向本机 Gecko 登录管理器。跨窗口共享缓存，旧版明文凭据可原样读取。 */
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

export const ACCOUNT_TOKEN_PREF = 'extensions.jadenseInZotero.token'
const POINTER = 'jadense-login:v1:'
const LOGIN_ORIGIN = 'chrome://jadense-in-zotero'
const LOGIN_REALM = 'jadense-account-v1'

export type AccountIdentity = { site: string; sub: string; linkId: string }
export type AccountCredential = {
  mode: 'legacy' | 'browser'
  baseUrl: string
  token: string
  scopes: string[]
  identity?: AccountIdentity
  dataOwner?: string
}

type Login = { username: string; password: string; init(origin: string, form: null, realm: string, user: string, password: string, usernameField: string, passwordField: string): void }
type Manager = { findLogins(origin: string, form: null, realm: string): Login[]; addLoginAsync(login: Login): Promise<unknown>; removeLogin(login: Login): void }
export type GeckoModules = { importESModule(path: string): Record<string, unknown> }
type Platform = { ChromeUtils?: GeckoModules; Services?: { logins?: Manager } }
type Host = ZoteroLike & { __jadenseAccountCredential?: { pointer: string; credential: AccountCredential } }

export function geckoModules(host: ZoteroLike) {
  return (globalThis as Platform).ChromeUtils ?? (host.getMainWindow?.() as Platform | undefined)?.ChromeUtils
}

function loginPlatform(host: ZoteroLike) {
  const chrome = geckoModules(host)
  const services = (globalThis as Platform).Services ?? (host.getMainWindow?.() as Platform | undefined)?.Services ??
    chrome?.importESModule('resource://gre/modules/Services.sys.mjs').Services as Platform['Services']
  return { chrome, manager: services?.logins }
}

export function credentialPointer(host: ZoteroLike) {
  const value = host.Prefs?.get(ACCOUNT_TOKEN_PREF)
  return typeof value === 'string' ? value.trim() : ''
}

export function isCredentialPointer(value: string) { return value.startsWith(POINTER) }

function loginFor(manager: Manager, pointer: string) {
  return manager.findLogins(LOGIN_ORIGIN, null, LOGIN_REALM).find(row => row.username === pointer)
}

function restoreCredential(host: Host, pointer: string) {
  try {
    const manager = loginPlatform(host).manager
    const login = manager && loginFor(manager, pointer)
    if (!login) return undefined
    const value = JSON.parse(login.password) as AccountCredential
    if (!value || !['browser', 'legacy'].includes(value.mode) || !value.token || !value.baseUrl) return undefined
    host.__jadenseAccountCredential = { pointer, credential: value }
    return value
  } catch { return undefined } // 主密码锁定、服务未就绪时保留指针，恢复后重读。
}

export function readAccountCredential(host: Host, baseUrl: string): AccountCredential | undefined {
  const pointer = credentialPointer(host)
  if (!pointer) return undefined
  if (!isCredentialPointer(pointer)) return { mode: 'legacy', baseUrl, token: pointer, scopes: [] }
  const cached = host.__jadenseAccountCredential
  const value = cached?.pointer === pointer ? cached.credential : restoreCredential(host, pointer)
  return value?.baseUrl === baseUrl ? value : undefined
}

/** 不透明本机归属标记，供同一个 Pref 键下的目录/映射隔离。安全库锁定时不显示上一账号数据。 */
export function accountDataOwner(host: Host) {
  const pointer = credentialPointer(host)
  if (!isCredentialPointer(pointer)) return undefined
  const cached = host.__jadenseAccountCredential
  const credential = cached?.pointer === pointer ? cached.credential : restoreCredential(host, pointer)
  return credential ? credential.dataOwner : 'unavailable:' + pointer
}

export function forgetStoredCredential(host: Host, pointer: string) {
  if (host.__jadenseAccountCredential?.pointer === pointer) delete host.__jadenseAccountCredential
  if (!isCredentialPointer(pointer)) return
  const manager = loginPlatform(host).manager
  const login = manager && loginFor(manager, pointer)
  if (login) manager!.removeLogin(login)
}

/** 先写新记录并回读，最后才替换旧指针。更新失败、取消、切换连接都不会覆盖有效的旧凭据。 */
export async function persistCredential(host: Host, credential: AccountCredential, expected: string, stillCurrent: () => boolean) {
  const { chrome, manager } = loginPlatform(host)
  const Crypto = host.getMainWindow?.()?.crypto ?? globalThis.crypto
  if (!manager || !chrome || !host.Prefs) throw new Error(uiText('无法访问 Zotero 密码管理器，请解锁后重试。', 'Unlock the Zotero password manager and try again.'))
  const pointer = POINTER + credential.mode + ':' + Crypto.randomUUID()
  const { nsLoginInfo } = chrome.importESModule('resource://gre/modules/LoginInfo.sys.mjs') as { nsLoginInfo: new () => Login }
  const login = new nsLoginInfo()
  const serialized = JSON.stringify(credential)
  login.init(LOGIN_ORIGIN, null, LOGIN_REALM, pointer, serialized, '', '')
  await manager.addLoginAsync(login)
  try {
    if (loginFor(manager, pointer)?.password !== serialized) throw new Error(uiText('未能验证保存的账号凭据。', 'Could not verify the saved account credential.'))
    if (!stillCurrent() || credentialPointer(host) !== expected) throw new Error(uiText('连接操作已被替换。', 'The connection changed.'))
    host.Prefs.set(ACCOUNT_TOKEN_PREF, pointer)
    host.__jadenseAccountCredential = { pointer, credential }
  } catch (error) {
    if (credentialPointer(host) !== pointer) manager.removeLogin(login)
    throw error
  }
  try { forgetStoredCredential(host, expected) } catch { /* 旧指针已经失效。 */ }
}
