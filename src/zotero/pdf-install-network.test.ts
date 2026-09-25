/** 使用真实 Windows PowerShell 和本地 HTTP 服务验证下载重试、代理与错误脱敏。 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const windows = process.platform === 'win32'
const helper = resolve('content/pdf-translation/install-network.ps1')
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function powershell(script: string, extra: Record<string, string> = {}) {
  // 只传递系统执行所需环境，避免读取/打印开发机的真实代理和凭据。
  const env: Record<string, string> = { ...extra }
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH']) if (process.env[name]) env[name] = process.env[name]!
  const command = join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  return new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; . " + quote(helper) + '; ' + script, 'utf16le').toString('base64')], { env, windowsHide: true })
    let output = ''
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    child.on('error', reject); child.on('close', code => done({ code, output }))
  })
}
async function server(handler: Parameters<typeof createServer>[0]) {
  const instance = createServer(handler); servers.push(instance)
  await new Promise<void>(done => instance.listen(0, '127.0.0.1', done))
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`
}
describe.skipIf(!windows)('PDF Windows bootstrap network', () => {
  it('retries transient failures and saves the complete download', async () => {
    let attempts = 0
    const url = await server((_req, res) => { attempts++; if (attempts < 3) { res.writeHead(503); res.end('temporary') } else res.end('complete') })
    const root = await mkdtemp(join(tmpdir(), 'pdf-download-')); roots.push(root)
    const file = join(root, 'uv.zip')
    const result = await powershell(`Initialize-PDFNetwork; Save-PDFBootstrapDownload -Url ${quote(url)} -Path ${quote(file)}`)
    expect(result.code, result.output).toBe(0); expect(attempts).toBe(3)
    expect(await readFile(file, 'utf8')).toBe('complete')
    expect(result.output).toContain('retry')
  }, 20_000)
  it('uses the configured proxy and does not retry proxy authentication failures or expose credentials', async () => {
    let attempts = 0
    const proxy = await server((_req, res) => { attempts++; res.writeHead(407); res.end('secret-response') })
    const root = await mkdtemp(join(tmpdir(), 'pdf-proxy-')); roots.push(root)
    const result = await powershell(`Initialize-PDFNetwork; Save-PDFBootstrapDownload -Url 'http://unreachable.invalid/uv.zip?token=hidden' -Path ${quote(join(root, 'uv.zip'))}`, { HTTPS_PROXY: proxy.replace('http://', 'http://demo:private-password@') })
    expect(result.code).not.toBe(0); expect(attempts).toBeGreaterThan(0)
    expect(result.output).toContain('proxy')
    expect(result.output).not.toMatch(/private-password|token=hidden|secret-response/)
  }, 15_000)
  it('honors NO_PROXY without contacting the configured proxy', async () => {
    let proxyRequests = 0
    const proxy = await server((_req, res) => { proxyRequests++; res.writeHead(502); res.end() })
    const url = await server((_req, res) => res.end('direct'))
    const root = await mkdtemp(join(tmpdir(), 'pdf-direct-')); roots.push(root)
    const result = await powershell(`Initialize-PDFNetwork; Save-PDFBootstrapDownload -Url ${quote(url)} -Path ${quote(join(root, 'uv.zip'))}`, { HTTPS_PROXY: proxy, NO_PROXY: '127.0.0.1' })
    expect(result.code, result.output).toBe(0); expect(proxyRequests).toBe(0)
  }, 15_000)
  it('reports invalid proxy configuration without silently using direct access', async () => {
    const result = await powershell('Initialize-PDFNetwork', { HTTPS_PROXY: 'socks5://demo:private-password@localhost:9' })
    expect(result.code).not.toBe(0); expect(result.output).toContain('proxy')
    expect(result.output).not.toContain('private-password')
  })
})
