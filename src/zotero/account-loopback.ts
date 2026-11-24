/** 单次浏览器回调只绑定 IPv4 loopback，由系统选择端口；授权码只在 Zotero 内存中交给 PKCE 交换。 */
import { geckoModules } from './account-credential'
import type { ZoteroLike } from './runtime'
import { uiText } from './ui-preferences'

export const CALLBACK_PATH = '/jadense/zotero/callback'
type Incoming = { method: string; path: string; queryString: string; getHeader(name: string): string }
type Outgoing = { setStatusLine(httpVersion: string, code: number, reason: string): void; setHeader(name: string, value: string, merge: boolean): void; write(body: string): void }
type Listener = (req: Incoming, res: Outgoing) => void
type LocalServer = {
  identity: { primaryPort: number }
  registerPathHandler(path: string, handler: Listener): void
  start(port: number): void
  stop(callback: () => void): void
}

export function openAccountCallback(host: ZoteroLike, state: string, signal: AbortSignal) {
  const HttpServer = geckoModules(host)?.importESModule('chrome://remote/content/server/httpd.sys.mjs').HttpServer as (new () => LocalServer) | undefined
  if (!HttpServer) throw new Error(uiText('无法启动本机授权回调。', 'The local authorization callback is unavailable.'))
  const server = new HttpServer()
  let accept!: (code: string) => void
  let reject!: (error: unknown) => void
  const result = new Promise<string>((resolve, fail) => { accept = resolve; reject = fail })
  // 打开系统浏览器本身也可能中途失败；关闭监听时清理尚未被等待的 Promise。
  void result.catch(() => undefined)
  let consumed = false, closed = false
  function close() {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', close)
    reject(signal.reason ?? new Error(uiText('浏览器授权已取消。', 'Browser authorization cancelled.')))
    server.stop(() => {})
  }
  server.registerPathHandler(CALLBACK_PATH, (request, reply) => {
    const send = (status: number, message: string) => {
      reply.setStatusLine('1.1', status, status === 200 ? 'OK' : 'Bad Request')
      reply.setHeader('Content-Type', 'text/plain; charset=utf-8', false)
      reply.setHeader('Cache-Control', 'no-store', false)
      reply.setHeader('Referrer-Policy', 'no-referrer', false)
      reply.setHeader('X-Content-Type-Options', 'nosniff', false)
      // httpd.write 接收字节串，使用 ASCII 以兼容所有受支持的 Gecko 版本。
      reply.write(message)
    }
    let authority = ''
    try { authority = request.getHeader('Host') } catch { /* 拒绝没有 Host 的请求。 */ }
    const params = new URLSearchParams(request.queryString)
    if (closed || consumed || request.method !== 'GET' || request.path !== CALLBACK_PATH ||
      authority !== '127.0.0.1:' + server.identity.primaryPort || params.getAll('state').length !== 1 || params.get('state') !== state) {
      send(400, 'Invalid authorization callback.'); return
    }
    if (params.has('error')) {
      consumed = true
      send(200, 'Authorization cancelled. You can return to Zotero.')
      reject(new Error(uiText('浏览器授权未完成。', 'Browser authorization was not completed.')))
      return
    }
    const code = params.get('code')
    if (!code || params.getAll('code').length !== 1) { send(400, 'Missing authorization code.'); return }
    consumed = true
    send(200, 'Authorization received. Return to Zotero to see your connection status.')
    accept(code)
  })
  server.start(-1)
  signal.addEventListener('abort', close, { once: true })
  const redirectUri = 'http://127.0.0.1:' + server.identity.primaryPort + CALLBACK_PATH
  if (signal.aborted) close()
  return { redirectUri, result, close }
}
