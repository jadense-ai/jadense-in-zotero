/** 使用合成账号与宿主适配器，覆盖安全保存、浏览器握手及升级后重开。 */
import { describe, expect, it, vi } from 'vitest'
import { authorizeJadenseAccount, cancelJadenseAuthorization, checkJadenseCredential, disconnectJadenseAccount, readJadenseAuthorizationState } from './account-authorization'
import { ACCOUNT_TOKEN_PREF } from './account-credential'
import { CALLBACK_PATH } from './account-loopback'
import { readConnection, type ZoteroLike } from './runtime'

function fixture() {
  const prefs = new Map<string, unknown>()
  class Login {
    username = ''
    password = ''
    init(_origin: string, _form: unknown, _realm: string, user: string, password: string) { this.username = user; this.password = password }
  }
  const rows = new Map<string, Login>()
  const manager = {
    findLogins: () => Array.from(rows.values()),
    addLoginAsync: vi.fn(async (login: Login) => { rows.set(login.username, login) }),
    removeLogin: (login: Login) => { rows.delete(login.username) },
  }
  let listener: (request: unknown, reply: unknown) => void
  const stop = vi.fn()
  class HttpServer {
    registerPathHandler(path: string, run: typeof listener) { expect(path).toBe(CALLBACK_PATH); listener = run }
    start(port: number) { expect(port).toBe(-1) }
    stop = stop
    identity = { primaryPort: 20012 }
  }
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/identity')) {
      const legacy = new Headers(init.headers).get('authorization') === 'Bearer old'
      return Response.json({ site: 'cn', sub: 'account', source: 'jadense-in-zotero', link_id: legacy ? 'old-link' : 'new-link' })
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({ accessToken: 'synthetic-browser-value', linkId: 'new-link', scopes: ['profile:read'], extra: true })
  })
  const win = { crypto: globalThis.crypto, fetch, Services: { logins: manager },
    ChromeUtils: { importESModule: (path: string) => path.endsWith('/LoginInfo.sys.mjs') ? { nsLoginInfo: Login } : { HttpServer } } }
  const launch = vi.fn()
  const host: ZoteroLike & { launchURL: typeof launch } = {
    Prefs: { get: key => prefs.get(key), set: (key, value) => { prefs.set(key, value) }, clear: key => { prefs.delete(key) } },
    getMainWindow: () => win as unknown as Window & typeof globalThis,
    launchURL: launch,
  }
  const callback = (query: string, authority = '127.0.0.1:20012') => {
    const response = { setStatusLine: vi.fn(), setHeader: vi.fn(), write: vi.fn() }
    listener({ method: 'GET', path: CALLBACK_PATH, queryString: query, getHeader: () => authority }, response)
    return response.setStatusLine.mock.calls[0][1]
  }
  return { host, prefs, manager, rows, fetch, launch, stop, callback }
}

describe('Zotero account authorization', () => {
  it('reads the existing legacy credential after restart without silently changing its grant or storage', () => {
    const f = fixture()
    f.prefs.set(ACCOUNT_TOKEN_PREF, 'old')
    f.prefs.set('extensions.jadenseInZotero.defaultFolderId', 'existing-folder')
    expect(f.prefs.get(ACCOUNT_TOKEN_PREF)).toBe('old')
    expect(readConnection({ Prefs: f.host.Prefs, getMainWindow: f.host.getMainWindow })).toMatchObject({ token: 'old', defaultFolderId: 'existing-folder' })
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('revokes only an uncommitted replacement and preserves the old settings when saving it fails', async () => {
    const f = fixture(); f.prefs.set(ACCOUNT_TOKEN_PREF, 'old')
    f.prefs.set('extensions.jadenseInZotero.defaultFolderId', 'private-folder')
    const baseSet = f.host.Prefs!.set
    f.host.Prefs!.set = (key, value) => { if (key === ACCOUNT_TOKEN_PREF || key.endsWith('accountInstallId')) throw new Error('unwritable'); baseSet(key, value) }
    const completed = authorizeJadenseAccount(f.host)
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalled())
    const url = new URL(f.launch.mock.calls[0][0])
    expect(url.searchParams.has('install_id')).toBe(false)
    f.callback('code=synthetic&state=' + url.searchParams.get('state'))
    await expect(completed).rejects.toThrow()
    expect(f.prefs.get(ACCOUNT_TOKEN_PREF)).toBe('old')
    expect(readConnection(f.host).defaultFolderId).toBe('private-folder')
    expect(readJadenseAuthorizationState(f.host)).toMatchObject({ mode: 'legacy', available: true })
    expect(f.rows.size).toBe(0)
    expect(f.fetch.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'DELETE', headers: { Authorization: 'Bearer synthetic-browser-value' } })
  })

  it('binds one callback to state, host and PKCE, keeps same-account destinations and revokes only this device', async () => {
    const f = fixture()
    f.prefs.set(ACCOUNT_TOKEN_PREF, 'old')
    f.prefs.set('extensions.jadenseInZotero.defaultFolderId', 'existing-folder')
    const completed = authorizeJadenseAccount(f.host)
    expect(authorizeJadenseAccount(f.host)).toBe(completed)
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(1))
    const url = new URL(f.launch.mock.calls[0][0])
    expect(url.searchParams.has('code_verifier')).toBe(false)
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:20012' + CALLBACK_PATH)
    const query = 'code=synthetic-code&state=' + url.searchParams.get('state')
    expect(f.callback('code=synthetic-code&state=wrong')).toBe(400)
    expect(f.callback(query, 'unrelated.invalid')).toBe(400)
    expect(f.callback(query)).toBe(200)
    expect(f.callback(query)).toBe(400)
    await completed
    expect(f.stop).toHaveBeenCalledOnce()
    const exchange = f.fetch.mock.calls.find(([, init]) => init.method === 'POST')![1]
    const { codeVerifier } = JSON.parse(exchange.body as string)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
    expect(Buffer.from(digest).toString('base64url')).toBe(url.searchParams.get('code_challenge'))
    const reopened = { Prefs: f.host.Prefs, getMainWindow: f.host.getMainWindow }
    expect(readConnection(reopened)).toMatchObject({ token: 'synthetic-browser-value', defaultFolderId: 'existing-folder' })
    expect(readJadenseAuthorizationState(reopened)).toMatchObject({ available: true, mode: 'browser' })
    expect(await disconnectJadenseAccount(reopened)).toEqual({ revocation: 'revoked' })
    expect(f.rows.size).toBe(0)
    expect(readConnection(reopened).token).toBe('')
    expect(f.fetch.mock.calls.at(-1)?.[1].method).toBe('DELETE')
  })

  it('clears only the prior account projections when the new identity is different', async () => {
    const f = fixture()
    f.prefs.set(ACCOUNT_TOKEN_PREF, 'old')
    f.prefs.set('extensions.jadenseInZotero.defaultFolderId', 'private-folder')
    f.prefs.set('extensions.jadenseInZotero.byokConfig', 'keep-me')
    const observedFolders: string[] = []
    const baseSet = f.host.Prefs!.set
    f.host.Prefs!.set = (key, value) => {
      baseSet(key, value)
      if (key === ACCOUNT_TOKEN_PREF) observedFolders.push(readConnection(f.host).defaultFolderId)
    }
    const original = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (url, init) => {
      if (new Headers(init.headers).get('authorization') === 'Bearer old') return Response.json({ site: 'cn', sub: 'different', link_id: 'old-link', source: 'jadense-in-zotero' })
      return original(url, init)
    })
    const completed = authorizeJadenseAccount(f.host)
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalled())
    const state = new URL(f.launch.mock.calls[0][0]).searchParams.get('state')
    f.callback('code=synthetic&state=' + state)
    await completed
    expect(readConnection(f.host).defaultFolderId).toBe('')
    expect(observedFolders).toEqual([''])
    expect(f.prefs.get('extensions.jadenseInZotero.byokConfig')).toBe('keep-me')
  })

  it('retains the old connection on cancellation and distinguishes authoritative rejection from network failures', async () => {
    const f = fixture(); f.prefs.set(ACCOUNT_TOKEN_PREF, 'old')
    const completed = authorizeJadenseAccount(f.host)
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalled())
    cancelJadenseAuthorization(f.host)
    await expect(completed).rejects.toThrow()
    expect(f.stop).toHaveBeenCalledOnce()
    expect(readConnection(f.host).token).toBe('old')
    for (const [status, expected] of [[401, 'invalid'], [403, 'unavailable'], [503, 'unavailable']] as const) {
      expect(await checkJadenseCredential(readConnection(f.host), async () => new Response(null, { status }))).toBe(expected)
    }
  })
})
