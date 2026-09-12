/** 首次全文任务经过真实 OCR 安装调度；仅替换 Zotero 平台、子进程和网络，避免下载模型。 */
import { afterEach, expect, it, vi } from 'vitest'
import { DocumentJobs } from './document-jobs'
import { DocumentStore } from './document-store'
import type { ZoteroLike } from './runtime'
import { checkLocalOCR, installLocalOCR } from './local-ocr'

afterEach(() => vi.unstubAllGlobals())

/** 模拟尚未安装依赖的 profile，安装进程由测试显式放行。 */
function coldProfile() {
  const files = new Map<string, string>()
  let finish!: (value: { exitCode: number }) => void
  let installation = new Promise<{ exitCode: number }>(resolve => { finish = resolve })
  const installer = { stdout: { readString: async () => null }, wait: () => installation }
  const server = { stdin: { write: vi.fn(), close: vi.fn() }, stdout: { readString: vi.fn().mockResolvedValueOnce('{"port":12345}\n').mockResolvedValue(null) }, wait: () => new Promise(() => {}), kill: vi.fn() }
  const spawn = vi.fn(async (options: { command: string }) => options.command.endsWith('python.exe') ? server : installer)
  vi.stubGlobal('PathUtils', { profileDir: '/profile', join: (...parts: string[]) => parts.join('/') })
  vi.stubGlobal('IOUtils', { makeDirectory: async () => {}, exists: async (path: string) => files.has(path), writeUTF8: async (path: string, text: string) => { files.set(path, text) }, readUTF8: async (path: string) => files.get(path), getChildren: async () => [], read: async () => new Uint8Array([1]) })
  vi.stubGlobal('ChromeUtils', { importESModule: () => ({ Subprocess: { getEnvironment: () => ({}), call: spawn } }) })
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('chrome://')) return new Response('synthetic bundled resource')
    if (init?.method === 'POST') return Response.json({ id: 'ocr-test' })
    return Response.json({ state: 'complete', result: { pages: [{ pageIndex: 0, blocks: [{ text: 'Hello.', locations: [{ pageIndex: 0, rects: [[0, 0, 10, 10]] }] }] }] } })
  })
  const prefs = new Map<string, unknown>([['extensions.jadenseInZotero.translationInterface', '{"kind":"machine","service":"google"}']])
  const host = { getMainWindow: () => ({ navigator: { platform: 'Win32' }, fetch: network }), Items: { get: () => ({ id: 1, libraryID: 1, key: 'PDF1', getField: () => 'Paper', isPDFAttachment: () => true, getFilePathAsync: async () => '/paper.pdf' }) }, Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) } } as unknown as ZoteroLike
  const translate = vi.fn(async () => new Response('<div class="result-container">译文</div>'))
  const jobs = new DocumentJobs(host, translate, new DocumentStore())
  return { host, files, installer, jobs, spawn, translate, network, finish: (exitCode = 0) => finish({ exitCode }), retry: () => { installation = new Promise(resolve => { finish = resolve }) } }
}

it.each(['translation', 'extraction'] as const)('%s waits for first-time dependency installation before OCR', async kind => {
  const f = coldProfile(), progress = vi.fn()
  try {
    const pending = f.jobs.start(kind, 1, false, { onProgress: progress })
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
    expect(f.files.get('/profile/jadense-ocr/v1/install.ps1')).toMatch(/^\uFEFF/u)
    expect(progress.mock.calls.flat().join(' ')).toMatch(/Installing local OCR|正在安装本机 OCR/u)
    expect(f.translate).not.toHaveBeenCalled()
    expect(f.network.mock.calls.every(([url]) => url.startsWith('chrome://'))).toBe(true)
    f.finish()
    const task = await pending; await f.jobs.idle()
    expect(task.status).toBe('complete')
    expect(f.spawn).toHaveBeenCalledTimes(2)
    expect(f.translate).toHaveBeenCalledTimes(kind === 'translation' ? 1 : 0)
    if (kind === 'translation') {
      await f.jobs.start(kind, 1, true); await f.jobs.idle()
      expect(f.spawn).toHaveBeenCalledTimes(2)
    }
  } finally { f.jobs.dispose() }
})

it('keeps installation failure retryable without sending a translation', async () => {
  const f = coldProfile()
  try {
    const failure = expect(f.jobs.start('translation', 1)).rejects.toThrow(/installation failed|安装失败/u)
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce()); f.finish(1); await failure
    expect(f.translate).not.toHaveBeenCalled()
    f.retry()
    const retry = f.jobs.start('translation', 1)
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(2)); f.finish()
    const task = await retry; await f.jobs.idle()
    expect(task.status).toBe('complete'); expect(f.translate).toHaveBeenCalledOnce()
  } finally { f.jobs.dispose() }
})

it('shares manual installation with a first-time full-document task', async () => {
  const f = coldProfile()
  try {
    const manual = installLocalOCR(f.host)
    const automatic = f.jobs.start('extraction', 1)
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
    f.finish(); await manual; await automatic; await f.jobs.idle()
    expect(f.spawn).toHaveBeenCalledTimes(2)
  } finally { f.jobs.dispose() }
})

it('retains the full failed installation log and no ready marker', async () => {
  const f = coldProfile(), log = 'first diagnostic\n' + 'x'.repeat(2500) + '\nlast diagnostic'
  f.installer.stdout.readString = vi.fn().mockResolvedValueOnce(log).mockResolvedValue(null)
  const result = expect(installLocalOCR(f.host)).rejects.toThrow(/last diagnostic/u)
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce()); f.finish(1); await result
  expect(f.files.get('/profile/jadense-ocr/v1/install.log')).toBe(log)
  expect(f.files.has('/profile/jadense-ocr/v1/ready-2.126.0-3.9.2')).toBe(false)
})

it.each([true, false])('checks environment without installing or marking readiness (ready=%s)', async ready => {
  const f = coldProfile()
  f.installer.stdout.readString = vi.fn().mockResolvedValueOnce(`uvPath=C:\\User Space\\uv.exe\r\nuvVersion=uv 0.9.3\r\nuvSource=user\r\nready=${ready}\r\nextra=ignored\r\n`).mockResolvedValue(null)
  f.finish()
  expect(await checkLocalOCR(f.host)).toMatchObject({ uvPath: 'C:\\User Space\\uv.exe', uvSource: 'user', ready })
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ arguments: expect.arrayContaining(['-CheckOnly']) }))
  expect(f.files.has('/profile/jadense-ocr/v1/ready-2.126.0-3.9.2')).toBe(false)
  expect(f.files.has('/profile/jadense-ocr/v1/install.log')).toBe(false)
})
