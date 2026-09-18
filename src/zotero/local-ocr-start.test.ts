/** 首次全文任务经过真实 OCR 安装调度；仅替换 Zotero 平台、子进程和网络，避免下载模型。 */
import { afterEach, expect, it, vi } from 'vitest'
import { DocumentJobs } from './document-jobs'
import { DocumentStore } from './document-store'
import type { ZoteroLike } from './runtime'
import { checkLocalOCR, ensureLocalOCR, installLocalOCR, ocrFailureMessage, readOCRModelSource, readOCRSelection, prepareLocalOCRModels } from './local-ocr'

it('prepares full-document models independently of optional selection models', async () => {
  const f = coldProfile()
  f.files.set('/profile/jadense-ocr/v1/.venv/Scripts/python.exe', 'python')
  f.files.set('/profile/jadense-ocr/v1/ready-2.126.0-3.9.2', 'ready')
  f.host.Prefs!.set!('extensions.jadenseInZotero.ocrModelSource', 'modelscope', true)
  f.host.Prefs!.set!('extensions.jadenseInZotero.ocrSelection', true, true)
  f.spawn.mockImplementation(async () => ({
    stdout: { readString: vi.fn().mockResolvedValueOnce('{"modelsReady":true}').mockResolvedValue(null) },
    wait: async () => ({ exitCode: 0 }),
  }) as never)
  await prepareLocalOCRModels(f.host)
  expect(f.spawn).toHaveBeenCalledOnce()
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ arguments: expect.arrayContaining(['--prepare-models']), environment: expect.objectContaining({ JADENSE_OCR_MODEL_SOURCE: 'modelscope' }) }))
  expect(f.files.get('/profile/jadense-ocr/v1/models-prepare.log')).toContain('"modelsReady":true')
  f.jobs.dispose()
})

it('shares automatic status reads and verifies old caches offline', async () => {
  const f = coldProfile()
  f.installer.stdout.readString = vi.fn().mockResolvedValueOnce('ready=true\n').mockResolvedValue(null)
  f.finish()
  const values = await Promise.all([checkLocalOCR(f.host), checkLocalOCR(f.host)])
  expect(values.every(value => value.modelsReady)).toBe(true)
  expect(f.spawn).toHaveBeenCalledTimes(2)
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ arguments: expect.arrayContaining(['--verify-models']), environment: expect.objectContaining({ HF_HUB_OFFLINE: '1' }) }))
  f.jobs.dispose()
})

it('explicit repair synchronizes an old installation instead of trusting its ready marker', async () => {
  const f = coldProfile()
  f.files.set('/profile/jadense-ocr/v1/.venv/Scripts/python.exe', 'existing 0.4.7 Python')
  f.files.set('/profile/jadense-ocr/v1/ready-2.126.0-3.9.2', 'ready')
  f.finish()
  await installLocalOCR(f.host, undefined, true)
  expect(f.spawn).toHaveBeenCalledOnce()
  expect(f.files.get('/profile/jadense-ocr/v1/.venv/Scripts/python.exe')).toBe('existing 0.4.7 Python')
  f.jobs.dispose()
})

afterEach(() => vi.unstubAllGlobals())

it('keeps unrelated OCR errors intact and defaults unknown source preferences', () => {
  expect(ocrFailureMessage('OCR page 2 was not fully converted')).toBe('OCR page 2 was not fully converted')
  const f = coldProfile()
  f.host.Prefs!.set!('extensions.jadenseInZotero.ocrModelSource', { extra: 'ignored' }, true)
  expect(readOCRModelSource(f.host)).toBe('default')
})

it('sends selection scope to its own local job and returns recognized Markdown', async () => {
  const f = coldProfile(), original = f.network.getMockImplementation()!
  f.network.mockImplementation(async (url, init) => url.endsWith('/jobs/ocr-test')
    ? Response.json({ state: 'complete', result: { text: 'Text $x^2$', extra: true } }) : original(url, init))
  try {
    const regions = [{ pageIndex: 2, rects: [[10, 20, 30, 40]] }]
    const pending = readOCRSelection(f.host, 1, regions, new AbortController().signal, vi.fn())
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce()); f.finish()
    expect(await pending).toBe('Text $x^2$')
    const [url, init] = f.network.mock.calls.find(([, value]) => value?.method === 'POST')!
    expect(url).toBe('http://127.0.0.1:12345/selection-jobs')
    expect(JSON.parse(new Headers(init!.headers).get('X-Jadense-OCR-Selection')!)).toEqual(regions)
    expect(init!.credentials).toBe('omit')
    expect(f.translate).not.toHaveBeenCalled()
  } finally { f.jobs.dispose() }
})

/** 模拟尚未安装依赖的 profile，安装进程由测试显式放行。 */
function coldProfile() {
  const files = new Map<string, string>()
  let finish!: (value: { exitCode: number }) => void
  let installation = new Promise<{ exitCode: number }>(resolve => { finish = resolve })
  const installer = { stdout: { readString: async () => null }, wait: () => installation }
  const server = { stdin: { write: vi.fn(), close: vi.fn() }, stdout: { readString: vi.fn().mockResolvedValueOnce('{"port":12345}\n').mockResolvedValue(null) }, wait: () => new Promise(() => {}), kill: vi.fn() }
  const spawn = vi.fn(async (options: { command: string; arguments: string[] }) => options.arguments.includes('--verify-models') ? { stdout: { readString: vi.fn().mockResolvedValueOnce('{"modelsReady":true}').mockResolvedValue(null) }, wait: async () => ({ exitCode: 0 }) } : options.command.endsWith('python.exe') ? server : installer)
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

it.each(['translation', 'extraction', 'references'] as const)('%s rejects a cold profile without installing', async kind => {
  const f = coldProfile()
  f.finish()
  try {
    await expect(f.jobs.start(kind, 1)).rejects.toThrow(/OCR/u)
    expect(f.jobs.list()).toHaveLength(0)
    expect(f.translate).not.toHaveBeenCalled()
    expect(f.spawn.mock.calls.every(([options]) => options.arguments.includes('-CheckOnly'))).toBe(true)
  } finally { f.jobs.dispose() }
})

it('does not start a task while manual installation is running', async () => {
  const f = coldProfile()
  try {
    const manual = installLocalOCR(f.host)
    await expect(f.jobs.start('extraction', 1)).rejects.toThrow(/正在准备|being prepared/u)
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce()); f.finish(); await manual
    expect(f.translate).not.toHaveBeenCalled(); expect(f.jobs.list()).toHaveLength(0)
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


it.each([false, true])('requires verified models in addition to dependencies (models=%s)', async ready => {
  const f = coldProfile()
  f.installer.stdout.readString = vi.fn().mockResolvedValueOnce('ready=true\n').mockResolvedValue(null)
  const original = f.spawn.getMockImplementation()!
  f.spawn.mockImplementation(async options => options.arguments.includes('--verify-models') ? {
    stdout: { readString: vi.fn().mockResolvedValueOnce(JSON.stringify({ modelsReady: ready })).mockResolvedValue(null) },
    wait: async () => ({ exitCode: ready ? 0 : 2 }),
  } as never : original(options))
  f.finish()
  if (ready) await expect(ensureLocalOCR(f.host)).resolves.toBeUndefined()
  else await expect(ensureLocalOCR(f.host)).rejects.toThrow(/OCR/u)
  expect(f.translate).not.toHaveBeenCalled()
  f.jobs.dispose()
})
