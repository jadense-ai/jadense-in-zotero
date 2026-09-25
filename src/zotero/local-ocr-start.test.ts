/** 首次全文任务经过真实 OCR 安装调度；仅替换 Zotero 平台、子进程和网络，避免下载模型。 */
import { afterEach, expect, it, vi } from 'vitest'
import { DocumentJobs } from './document-jobs'
import { DocumentStore } from './document-store'
import type { ZoteroLike } from './runtime'
import { checkLocalOCR, ensureLocalOCR, installLocalOCR, removeLocalOCR, ocrFailureMessage, readOCRModelSource, readOCRSelection, readOCRDocument, prepareLocalOCRModels, observeOCRProgress, startLocalOCR } from './local-ocr'

it('prepares bundled resources without AbortSignal.timeout', async () => {
  const f = coldProfile(); f.finish()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => { throw new TypeError('Unavailable') })
  await installLocalOCR(f.host)
  expect(f.network).toHaveBeenCalledTimes(8)
  vi.restoreAllMocks(); f.jobs.dispose()
})

it('downloads the published complete package and accepts additive catalog fields', async () => {
  const f = coldProfile(); f.finish()
  const original = f.network.getMockImplementation()!
  f.network.mockImplementation((url, init) => url.endsWith('/bundles.json') ? Promise.resolve(Response.json({ 'windows-x64': { published: true, future: 'ignored' }, future: {} })) : original(url, init))
  await installLocalOCR(f.host)
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ arguments: expect.arrayContaining(['/profile/jadense-ocr/v1/install-bundle.ps1']) }))
  f.jobs.dispose()
})

it('imports a local package without requiring a published download URL', async () => {
  const f = coldProfile(); f.finish()
  await installLocalOCR(f.host, () => {}, false, 'C:/离线 包/ocr.zip')
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ arguments: expect.arrayContaining(['-ArchivePath', 'C:/离线 包/ocr.zip', '/profile/jadense-ocr/v1/install-bundle.ps1']) }))
  f.jobs.dispose()
})

it('checks portable models offline without invoking uv and retains models on removal', async () => {
  const f = coldProfile(); f.finish()
  f.files.set('/profile/jadense-ocr/v1/runtime/python/python.exe', 'python')
  f.files.set('/profile/jadense-ocr/v1/runtime/models/weight.bin', 'model')
  expect(await checkLocalOCR(f.host, true)).toMatchObject({ ready: true, modelsReady: true, uvSource: 'bundle' })
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ command: '/profile/jadense-ocr/v1/runtime/python/python.exe', arguments: expect.arrayContaining(['--verify-models', '/profile/jadense-ocr/v1/runtime']) }))
  expect(f.spawn).toHaveBeenCalledOnce()
  await removeLocalOCR(f.host)
  expect(f.files.has('/profile/jadense-ocr/v1/runtime/python/python.exe')).toBe(false)
  expect(f.files.has('/profile/jadense-ocr/v1/runtime/models/weight.bin')).toBe(true)
  f.jobs.dispose()
})

it('does not replace an environment while recognition owns it', async () => {
  const f = coldProfile(); Object.assign(f.host, { __jadenseOCRUsers: 1 })
  await expect(installLocalOCR(f.host, () => {}, false, 'C:/ocr.zip')).rejects.toThrow(/OCR/u)
  expect(f.spawn).not.toHaveBeenCalled(); f.jobs.dispose()
})

it('does not repair over another window model preparation', async () => {
  const f = coldProfile(); Object.assign(f.host, { __jadenseOCRModels: new Promise(() => {}) })
  await expect(installLocalOCR(f.host, () => {}, true)).rejects.toThrow(/OCR/u)
  expect(f.spawn).not.toHaveBeenCalled(); f.jobs.dispose()
})

it('bounds a silent service startup and releases it for a retry', async () => {
  vi.useFakeTimers()
  const f = coldProfile(), kill = vi.fn(); f.finish()
  await installLocalOCR(f.host)
  f.files.set('/profile/jadense-ocr/v1/.venv/Scripts/python.exe', 'python')
  f.spawn.mockResolvedValue({ stdin: { write: async () => {} }, stdout: { readString: () => new Promise(() => {}) }, kill } as never)
  const pending = expect(startLocalOCR(f.host)).rejects.toMatchObject({ code: 'OCR_SERVICE_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(60001); await pending
  expect(kill).toHaveBeenCalledOnce()
  expect((f.host as unknown as { __jadenseOCR?: unknown }).__jadenseOCR).toBeUndefined()
  f.jobs.dispose()
})

it('cancels one waiting caller without terminating shared startup', async () => {
  const f = coldProfile(), controller = new AbortController()
  Object.assign(f.host, { __jadenseOCR: new Promise(() => {}) })
  const reading = expect(readOCRDocument(f.host, 1, controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
  await Promise.resolve(); controller.abort(); await reading
  expect((f.host as unknown as { __jadenseOCR?: unknown }).__jadenseOCR).toBeDefined()
  f.jobs.dispose()
})

it('bounds a hung status request even if fetch ignores cancellation', async () => {
  vi.useFakeTimers()
  const f = coldProfile()
  Object.assign(f.host, { __jadenseOCR: Promise.resolve({ url: 'http://127.0.0.1:1234', token: 'test' }) })
  const original = f.network.getMockImplementation()!
  f.network.mockImplementation((url, init) => init?.method === 'POST' || init?.method === 'DELETE' ? original(url, init) : new Promise(() => {}))
  const reading = expect(readOCRDocument(f.host, 1, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'OCR_REQUEST_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(30001); await reading
  expect(f.network.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
  f.jobs.dispose()
})

it('cancels promptly during submission and cleans its late acknowledgement without resubmitting', async () => {
  const f = coldProfile(), controller = new AbortController()
  Object.assign(f.host, { __jadenseOCR: Promise.resolve({ url: 'http://127.0.0.1:1234', token: 'test' }) })
  let acknowledge!: (response: Response) => void
  const original = f.network.getMockImplementation()!
  f.network.mockImplementation((url, init) => init?.method === 'POST' ? new Promise(resolve => { acknowledge = resolve }) : original(url, init))
  const reading = expect(readOCRDocument(f.host, 1, controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(acknowledge).toBeDefined()); controller.abort(); await reading
  acknowledge(Response.json({ id: 'late-job' }))
  await vi.waitFor(() => expect(f.network.mock.calls.some(([url, init]) => url.endsWith('/jobs/late-job') && init?.method === 'DELETE')).toBe(true))
  expect(f.network.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  f.jobs.dispose()
})

it('bounds an uncertain submission without automatically resubmitting', async () => {
  vi.useFakeTimers()
  const f = coldProfile()
  Object.assign(f.host, { __jadenseOCR: Promise.resolve({ url: 'http://127.0.0.1:1234', token: 'test' }) })
  f.network.mockImplementation(() => new Promise(() => {}))
  const reading = expect(readOCRDocument(f.host, 1, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'OCR_SUBMISSION_TIMEOUT' })
  await vi.advanceTimersByTimeAsync(120001); await reading
  expect(f.network).toHaveBeenCalledOnce()
  f.jobs.dispose()
})

it('warns on five minutes without page progress while keeping the task cancellable', async () => {
  vi.useFakeTimers()
  const f = coldProfile(), controller = new AbortController(), progress = vi.fn()
  Object.assign(f.host, { __jadenseOCR: Promise.resolve({ url: 'http://127.0.0.1:1234', token: 'test' }) })
  f.network.mockImplementation(async (_url, init) => Response.json(init?.method === 'POST' ? { id: 'slow' } : { state: 'running', page: 1, total: 300 }))
  const reading = expect(readOCRDocument(f.host, 1, controller.signal, progress)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(300001)
  expect(progress.mock.lastCall?.[0]).toMatch(/5 分钟|5 minutes/)
  controller.abort(); await reading
  expect(f.network.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
  f.jobs.dispose()
})

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
  await checkLocalOCR(f.host)
  await ensureLocalOCR(f.host)
  expect(f.spawn).toHaveBeenCalledTimes(2)
  const restarted = { ...f.host }
  await ensureLocalOCR(restarted)
  expect(f.spawn).toHaveBeenCalledTimes(2)
  await checkLocalOCR(restarted, true)
  expect(f.spawn).toHaveBeenCalledTimes(3)
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

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('reuses historical successful model credentials without spawning Python', async () => {
  const f = coldProfile()
  f.files.set('/profile/jadense-ocr/v1/models-ready.json', JSON.stringify({ revision: 5, versions: { docling: '2.126.0', rapidocr: '3.9.2' } }))
  await ensureLocalOCR(f.host)
  expect(f.spawn).not.toHaveBeenCalled()
  f.jobs.dispose()
})

it('invalidates persisted readiness after real OCR failure without trusting the old marker again', async () => {
  const f = coldProfile()
  f.files.set('/profile/jadense-ocr/v1/models-ready.json', JSON.stringify({ revision: 5, versions: { docling: '2.126.0', rapidocr: '3.9.2' } }))
  await ensureLocalOCR(f.host)
  const original = f.network.getMockImplementation()!
  f.network.mockImplementation(async (url, init) => url.endsWith('/jobs/ocr-test') ? Response.json({ state: 'error', error: 'Missing model weights' }) : original(url, init))
  await expect(readOCRDocument(f.host, 1, new AbortController().signal, vi.fn())).rejects.toThrow(/Missing model weights/u)
  f.finish()
  await expect(ensureLocalOCR({ ...f.host })).rejects.toThrow(/OCR/u)
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ arguments: expect.arrayContaining(['-CheckOnly']) }))
  f.jobs.dispose()
})

it('times out a silent check, terminates it and allows retry', async () => {
  vi.useFakeTimers()
  const f = coldProfile(), kill = vi.fn()
  f.spawn.mockResolvedValue({ stdout: { readString: () => new Promise(() => {}) }, kill } as never)
  const checked = expect(checkLocalOCR(f.host)).rejects.toThrow(/2 分钟|2 minutes/u)
  await vi.advanceTimersByTimeAsync(120001)
  await checked
  expect(kill).toHaveBeenCalledOnce()
  f.spawn.mockResolvedValue({ stdout: { readString: vi.fn().mockResolvedValueOnce('ready=false\n').mockResolvedValue(null) }, wait: async () => ({ exitCode: 0 }) } as never)
  expect((await checkLocalOCR(f.host)).ready).toBe(false)
  f.jobs.dispose()
})

it('shares fragmented download progress and bounds a silent model preparation', async () => {
  vi.useFakeTimers()
  const f = coldProfile(), kill = vi.fn(), progress = vi.fn()
  f.files.set('/profile/jadense-ocr/v1/.venv/Scripts/python.exe', 'python')
  f.files.set('/profile/jadense-ocr/v1/ready-2.126.0-3.9.2', 'ready')
  const stop = observeOCRProgress(f.host, progress)
  f.spawn.mockResolvedValue({ stdout: { readString: vi.fn().mockResolvedValueOnce('JADENSE_OCR_PRO').mockResolvedValueOnce('GRESS {"stage":"download","unit":"B","completed":512,"total":1024,"speed":256,"extra":true}\n').mockImplementation(() => new Promise(() => {})) }, kill } as never)
  const prepared = expect(prepareLocalOCRModels(f.host)).rejects.toThrow(/30 分钟|30 minutes/u)
  await vi.advanceTimersByTimeAsync(1800001)
  await prepared
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: 'download', completed: 512, speed: 256 }))
  expect(kill).toHaveBeenCalledOnce()
  expect(f.files.get('/profile/jadense-ocr/v1/models-prepare.log')).toContain('completed')
  stop(); f.jobs.dispose()
})

it('terminates the exact Windows installer process tree before returning a timeout', async () => {
  vi.useFakeTimers()
  const f = coldProfile()
  f.spawn.mockImplementation(async options => options.command.endsWith('taskkill.exe')
    ? { stdout: { readString: async () => null }, wait: async () => ({ exitCode: 0 }) } as never
    : { pid: 23456, stdout: { readString: () => new Promise(() => {}) }, kill: vi.fn() } as never)
  const result = expect(installLocalOCR(f.host)).rejects.toThrow(/30 分钟|30 minutes/u)
  await vi.advanceTimersByTimeAsync(1800001); await result
  expect(f.spawn).toHaveBeenCalledWith(expect.objectContaining({ command: expect.stringContaining('taskkill.exe'), arguments: ['/PID', '23456', '/T', '/F'] }))
  expect(f.files.has('/profile/jadense-ocr/v1/ready-2.126.0-3.9.2')).toBe(false)
  f.jobs.dispose()
})

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
  vi.stubGlobal('PathUtils', { profileDir: '/profile', join: (...parts: string[]) => parts.join('/'), normalize: (path: string) => path, parent: (path: string) => path.slice(0, path.lastIndexOf('/')) })
  const remove = vi.fn(async (path: string) => { for (const key of files.keys()) if (key === path || key.startsWith(path + '/')) files.delete(key) })
  vi.stubGlobal('IOUtils', { remove, makeDirectory: async () => {}, exists: async (path: string) => files.has(path), writeUTF8: async (path: string, text: string) => { files.set(path, text) }, readUTF8: async (path: string) => files.get(path), getChildren: async () => [], read: async () => new Uint8Array([1]) })
  vi.stubGlobal('ChromeUtils', { importESModule: () => ({ Subprocess: { getEnvironment: () => ({}), call: spawn } }) })
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/bundles.json')) return Response.json({})
    if (url.startsWith('chrome://')) return new Response('synthetic bundled resource')
    if (init?.method === 'POST') return Response.json({ id: 'ocr-test' })
    return Response.json({ state: 'complete', result: { pages: [{ pageIndex: 0, blocks: [{ text: 'Hello.', locations: [{ pageIndex: 0, rects: [[0, 0, 10, 10]] }] }] }] } })
  })
  const prefs = new Map<string, unknown>([['extensions.jadenseInZotero.translationInterface', '{"kind":"machine","service":"google"}']])
  const host = { getMainWindow: () => ({ navigator: { platform: 'Win32' }, fetch: network }), Items: { get: () => ({ id: 1, libraryID: 1, key: 'PDF1', getField: () => 'Paper', isPDFAttachment: () => true, getFilePathAsync: async () => '/paper.pdf' }) }, Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) } } as unknown as ZoteroLike
  Object.assign(host, { Reader: { _readers: [{ itemID: 1, _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument: { numPages: 1 } } }, _ensureBasicPageData: async () => {}, _pdfPages: { 0: { chars: [{ c: 'Traditional text remains available.', rect: [0, 0, 100, 10] }] } } } } }] } })
  const translate = vi.fn(async () => new Response('<div class="result-container">译文</div>'))
  const jobs = new DocumentJobs(host, translate, new DocumentStore())
  return { host, files, remove, installer, jobs, spawn, translate, network, finish: (exitCode = 0) => finish({ exitCode }), retry: () => { installation = new Promise(resolve => { finish = resolve }) } }
}

it.each([false, true])('removes only private dependencies, retaining results and optionally models (models=%s)', async models => {
  const f = coldProfile(), root = '/profile/jadense-ocr/v1'
  for (const name of ['.venv/Scripts/python.exe', 'python/runtime', 'models/weight', 'cache/result.json', 'install.log', 'models-ready.json']) f.files.set(`${root}/${name}`, 'fixture')
  f.files.set('/user/.local/bin/uv.exe', 'user installation')
  await removeLocalOCR(f.host, models)
  expect(f.files.has(`${root}/.venv/Scripts/python.exe`)).toBe(false)
  expect(f.files.has(`${root}/models-ready.json`)).toBe(false)
  expect(f.files.has(`${root}/models/weight`)).toBe(!models)
  expect(f.files.has(`${root}/cache/result.json`)).toBe(true)
  expect(f.files.has(`${root}/install.log`)).toBe(true)
  expect(f.files.has('/user/.local/bin/uv.exe')).toBe(true)
  expect(await checkLocalOCR(f.host)).toMatchObject({ ready: false, removed: true })
  const reinstalled = installLocalOCR(f.host)
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce()); f.finish(); await reinstalled
  expect(f.files.has(`${root}/ready-2.126.0-3.9.2`)).toBe(true)
  f.jobs.dispose()
})

it('does not delete while installing or recognizing, or claim success after a removal failure', async () => {
  const f = coldProfile()
  const installing = installLocalOCR(f.host)
  await expect(removeLocalOCR(f.host)).rejects.toThrow(/OCR/u)
  expect(f.remove).not.toHaveBeenCalled()
  f.finish(); await installing
  Object.assign(f.host, { __jadenseOCRUsers: 1 })
  await expect(removeLocalOCR(f.host)).rejects.toThrow(/OCR/u)
  Object.assign(f.host, { __jadenseOCRUsers: 0 })
  f.remove.mockRejectedValueOnce(new Error('File in use'))
  await expect(removeLocalOCR(f.host)).rejects.toThrow('File in use')
  expect(f.host.Prefs!.get('extensions.jadenseInZotero.ocrReady', true)).not.toBe('removed')
  await removeLocalOCR(f.host)
  expect((await checkLocalOCR(f.host)).removed).toBe(true)
  f.jobs.dispose()
})

it('waits for the idle service to stop and fences new setup until removal finishes', async () => {
  const f = coldProfile()
  let exited!: (value: { exitCode: number }) => void
  const wait = new Promise<{ exitCode: number }>(resolve => { exited = resolve })
  const close = vi.fn(async () => {})
  Object.assign(f.host, { __jadenseOCR: Promise.resolve({ process: { stdin: { close }, wait: () => wait } }) })
  const removing = removeLocalOCR(f.host)
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(f.remove).not.toHaveBeenCalled()
  await expect(installLocalOCR(f.host)).rejects.toThrow(/OCR/u)
  await expect(readOCRSelection(f.host, 1, [], new AbortController().signal, vi.fn())).rejects.toThrow(/OCR/u)
  exited({ exitCode: 0 }); await removing
  expect(f.remove).toHaveBeenCalled()
  f.jobs.dispose()
})

it('does not remove any files when the local service cannot stop', async () => {
  vi.useFakeTimers()
  const f = coldProfile()
  Object.assign(f.host, { __jadenseOCR: Promise.resolve({ process: { stdin: { close: async () => {} }, wait: () => new Promise(() => {}) } }) })
  const result = expect(removeLocalOCR(f.host)).rejects.toThrow(/尚未删除|No files were removed/u)
  await vi.advanceTimersByTimeAsync(30001); await result
  expect(f.remove).not.toHaveBeenCalled()
  f.jobs.dispose()
})

it.each(['translation', 'extraction', 'references'] as const)('%s uses a cold profile without installing OCR', async kind => {
  const f = coldProfile()
  f.finish()
  try {
    const task = await f.jobs.start(kind, 1); await f.jobs.idle()
    expect(task.status).not.toBe('error')
    expect(f.spawn).not.toHaveBeenCalled()
    if (kind !== 'translation') expect(f.translate).not.toHaveBeenCalled()
  } finally { f.jobs.dispose() }
})

it('extracts text while optional OCR installation is running', async () => {
  const f = coldProfile()
  try {
    const manual = installLocalOCR(f.host)
    expect((await f.jobs.start('extraction', 1)).status).toBe('complete')
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce()); f.finish(); await manual
    expect(f.translate).not.toHaveBeenCalled(); expect(f.jobs.list()).toHaveLength(1)
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
