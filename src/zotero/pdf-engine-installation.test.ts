/** 从插件准备入口验证安装器选择、部署与失败恢复，不访问真实 profile 或网络。 */
import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { preparePDFEngine } from './pdf-translation-runtime'
import type { ZoteroLike } from './runtime'

afterEach(() => vi.unstubAllGlobals())
async function fixture(arch = 'AMD64', failure?: { stdout: string; stderr?: string }, installed = false) {
  const files = new Map<string, string>(), calls: { command: string; arguments: string[] }[] = []
  let ready = installed
  const root = '/profile/jadense-pdf-translation'
  const host = { getMainWindow: () => ({ navigator: { platform: 'Win32' }, fetch: async (url: string) => new Response(await readFile('content/pdf-translation/' + url.split('/').pop(), 'utf8')) }) } as unknown as ZoteroLike
  const io = { makeDirectory: async () => {}, writeUTF8: async (path: string, text: string) => { files.set(path, text) }, readUTF8: async (path: string) => files.get(path)!, exists: async (path: string) => ready && path.endsWith('/runtime/python/python.exe'), remove: vi.fn(async () => {}) }
  vi.stubGlobal('IOUtils', io)
  vi.stubGlobal('PathUtils', { profileDir: '/profile', join: (...parts: string[]) => parts.join('/') })
  vi.stubGlobal('ChromeUtils', { importESModule: () => ({ Subprocess: {
    getEnvironment: () => ({ SystemRoot: 'C:/Windows', PROCESSOR_ARCHITECTURE: arch }),
    call: async (options: { command: string; arguments: string[] }) => {
      calls.push(options)
      const install = options.command.endsWith('powershell.exe'), fail = install && failure
      const stdout = [fail ? failure.stdout : '{"type":"complete"}\n', '']
      const stderr = [fail ? failure.stderr ?? '' : '', '']
      if (install && !fail) ready = true
      return { stdin: { write: async () => {}, close: async () => {} }, stdout: { readString: async () => stdout.shift() ?? '' }, stderr: { readString: async () => stderr.shift() ?? '' }, wait: async () => ({ exitCode: fail ? 1 : 0 }), kill: vi.fn() }
    },
  } }) })
  return { host, files, calls, io, root }
}
it('downloads the published x64 bundle, deploys the network helper with BOM, then checks offline', async () => {
  const f = await fixture()
  await preparePDFEngine(f.host, new AbortController().signal, () => {})
  expect(f.calls[0].arguments).toContain(f.root + '/install-bundle.ps1')
  expect(f.files.get(f.root + '/install-network.ps1')).toMatch(/^\uFEFF/u)
  expect(f.calls[1].command).toBe(f.root + '/runtime/python/python.exe')
  expect(f.io.remove.mock.calls.flat()).not.toContain(f.root + '/tasks')
})
it('reuses a healthy installed engine without starting an installer', async () => {
  const f = await fixture('AMD64', undefined, true)
  await preparePDFEngine(f.host, new AbortController().signal, () => {})
  expect(f.calls).toHaveLength(1); expect(f.calls[0].command).toContain('python.exe')
})
it('keeps the source installer for platforms without a verified complete package', async () => {
  const f = await fixture('ARM64')
  await preparePDFEngine(f.host, new AbortController().signal, () => {})
  expect(f.calls[0].arguments).toContain(f.root + '/install.ps1')
})
it('imports the chosen archive without starting an automatic download', async () => {
  const f = await fixture()
  await preparePDFEngine(f.host, new AbortController().signal, () => {}, false, '/downloads/engine.zip')
  expect(f.calls[0].arguments.slice(-2)).toEqual([f.root, '/downloads/engine.zip'])
})
it('reports the failed download stage and offline recovery without raw network credentials', async () => {
  const f = await fixture('AMD64', { stdout: '{"type":"install-error","stage":"download","category":"connect","future":true}\n', stderr: 'Cannot connect https://demo:private-password@example.invalid/a?token=hidden' })
  const promise = preparePDFEngine(f.host, new AbortController().signal, () => {})
  await expect(promise).rejects.toThrow(/下载完整 PDF 引擎包|Downloading the complete PDF engine/u)
  await expect(promise).rejects.toThrow(/离线包|offline package/u)
  await expect(promise).rejects.not.toThrow(/private-password|token=hidden/)
  expect(f.calls).toHaveLength(1)
  expect(f.files.get(f.root + '/install.log')).not.toMatch(/private-password|token=hidden/)
})
it('uses the last known stage when an older installer has no structured error', async () => {
  const f = await fixture('ARM64', { stdout: 'JADENSE_PDF_PROGRESS {"stage":"uv"}\n', stderr: 'Invoke-WebRequest : Cannot connect' })
  await expect(preparePDFEngine(f.host, new AbortController().signal, () => {})).rejects.toThrow(/下载安装工具 uv|Downloading the uv installer/u)
})
