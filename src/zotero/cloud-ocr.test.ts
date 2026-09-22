/** 云 OCR 协议与运行时回归：仅合成凭证/图片，不访问真实账号或云服务。 */
import { afterEach, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { CLOUD_OCR_SERVICES, cloudOCRConfig, saveCloudOCRConfig, OCR_ENGINE_PREF, ocrEngine, cloudEndpoint, type CloudOCRConfig } from './cloud-ocr-config'
import { cloudRequest, glmPage, mineruArchive, mineruRecognize, recognizeImage, cleanOCRText, type CloudIO } from './cloud-ocr-client'
import { readEngineDocument, readEngineSelection, ocrHash, projectCloudPage, renderOCRImage } from './cloud-ocr'
import type { PDFPageProxy } from 'pdfjs-dist'
import { ensureLocalOCR } from './local-ocr'
vi.mock('./local-ocr', async original => ({ ...await original<typeof import('./local-ocr')>(), ensureLocalOCR: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const config = (engine: CloudOCRConfig['engine'] = 'custom'): CloudOCRConfig => ({ engine, endpoint: CLOUD_OCR_SERVICES[engine].endpoint || 'https://ocr.example/v1', model: CLOUD_OCR_SERVICES[engine].model || 'ocr', key: 'synthetic-key', consent: true })
function io(...responses: Response[]): CloudIO & { fetch: ReturnType<typeof vi.fn> } {
  return { signal: new AbortController().signal, progress: vi.fn(), fetch: vi.fn(async () => responses.shift()!) }
}
const archive = () => zipSync({ 'result/doc_content_list.json': strToU8(JSON.stringify([{ type: 'text', text: 'First page', page_idx: 0, bbox: [0, 0, 1000, 100] }, { type: 'equation', text: 'x=1', page_idx: 1, extra: true }])) })

it.each(['http://example.com', 'https://user:key@example.com', 'https://example.com?key=abc', 'https://example.com#key'])('rejects unsafe credential destination %s', endpoint => {
  expect(() => cloudEndpoint(endpoint)).toThrow()
})
it('keeps defaults, one config per provider and session keys out of prefs', async () => {
  const prefs = new Map(), host = { Prefs: { get: (k: string) => prefs.get(k), set: (k: string, value: unknown) => { prefs.set(k, value) } } }
  expect(ocrEngine(host)).toBe('local')
  expect(await saveCloudOCRConfig(host, config())).toBe(false)
  await saveCloudOCRConfig(host, config('glm'))
  expect((await cloudOCRConfig(host, 'custom')).key).toBe('synthetic-key')
  expect(JSON.stringify([...prefs.values()])).not.toContain('synthetic-key')
  expect((await cloudOCRConfig(host, 'glm')).model).toBe('glm-ocr')
})
it.each(['global', 'module', 'window'])('stores keys through Gecko %s and retrieves them in another host session', async source => {
  const logins: Array<{ hostname: string; httpRealm: string; username: string; password: string }> = []
  const Services = { logins: { findLogins: (_: string, __: unknown, realm: string) => logins.filter(l => l.httpRealm === realm), addLoginAsync: async (login: typeof logins[number]) => { logins.push(login) }, removeLogin: vi.fn() } }
  const ChromeUtils = { importESModule: (uri: string) => uri.endsWith('Services.sys.mjs') ? { Services } : { nsLoginInfo: class { init(hostname: string, form: unknown, httpRealm: string, username: string, password: string) { Object.assign(this, { hostname, httpRealm, username, password }) } } } }
  vi.stubGlobal('Services', source === 'global' ? Services : undefined)
  vi.stubGlobal('ChromeUtils', source === 'window' ? undefined : ChromeUtils)
  const getMainWindow = () => (source === 'window' ? { Services, ChromeUtils } : {}) as unknown as Window & typeof globalThis
  const prefs = new Map(), Prefs = { get: (k: string) => prefs.get(k), set: (k: string, v: unknown) => { prefs.set(k, v) } }
  expect(await saveCloudOCRConfig({ Prefs, getMainWindow }, config())).toBe(true)
  expect((await cloudOCRConfig({ Prefs, getMainWindow }, 'custom')).key).toBe('synthetic-key')
})
it.each(['custom', 'siliconflow', 'aliyun', 'glm'] as const)('uses the %s wire contract and ignores additive fields', async engine => {
  const transport = io(response(engine === 'glm' ? { md_results: '# heading', additive: true } : engine === 'aliyun' ? { output: { choices: [{ message: { content: [{ text: '# heading' }] } }] } } : { choices: [{ message: { content: '# heading' }, finish_reason: 'stop' }], extra: true }))
  expect((await recognizeImage(config(engine), 'data:image/png;base64,AA==', transport)).blocks[0].text).toBe('# heading')
  const [, init] = transport.fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { Authorization: 'Bearer synthetic-key' } })
  const body = JSON.parse(String(init.body))
  if (engine === 'aliyun') expect(body.parameters.ocr_options.task).toBe('document_parsing')
  if (engine === 'glm') expect(body.file).toBe('data:image/png;base64,AA==')
  if (engine === 'siliconflow') expect(body.messages[0].content[1].text).toContain('<|grounding|>')
})
it('does not send anything without upload consent', async () => {
  const transport = io()
  await expect(recognizeImage({ ...config(), consent: false }, 'image', transport)).rejects.toThrow('Confirm')
  expect(transport.fetch).not.toHaveBeenCalled()
})
it.each([401, 403, 429, 500])('never automatically replays HTTP %s submissions or exposes response bodies', async status => {
  const transport = io(response({ error: 'synthetic-key private-paper' }, status))
  await expect(recognizeImage(config(), 'image', transport)).rejects.toMatchObject({ status })
  expect(transport.fetch).toHaveBeenCalledTimes(1)
})
it('rejects truncated output and malformed JSON', async () => {
  await expect(recognizeImage(config(), 'image', io(response({ choices: [{ finish_reason: 'length', message: { content: 'incomplete' } }] })))).rejects.toMatchObject({ code: 'OUTPUT_TRUNCATED' })
  await expect(recognizeImage(config(), 'image', io(new Response('{broken')))).rejects.toMatchObject({ code: 'INVALID_JSON' })
})
it('bounds downloads and preserves cancellation', async () => {
  await expect(cloudRequest(io(new Response('123456')), 'https://example.com', {}, 3)).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' })
  const transport = io(); const controller = new AbortController(); controller.abort()
  await expect(cloudRequest({ ...transport, signal: controller.signal }, 'https://example.com')).rejects.toMatchObject({ name: 'AbortError' })
  expect(transport.fetch).not.toHaveBeenCalled()
})
it('parses MinerU pages/formulas and prevents archive path traversal', () => {
  expect(mineruArchive(archive())[1].blocks[0].text).toBe('$$\nx=1\n$$')
  expect(() => mineruArchive(zipSync({ '../escape.png': new Uint8Array([0]) }))).toThrow('UNSAFE_ARCHIVE')
  expect(() => mineruArchive(zipSync({ 'full.md': strToU8('No page provenance') }))).toThrow('MISSING_PAGE_RESULTS')
})
it('keeps archive JPEG resources for local PNG conversion and GLM figure bounds', () => {
  const bytes = zipSync({ 'doc_content_list.json': strToU8(JSON.stringify([{ type: 'image', img_path: 'images/a.jpg', page_idx: 0 }])), 'images/a.jpg': new Uint8Array([255, 216, 255, 217]) })
  expect(mineruArchive(bytes)[0].blocks[0].image).toMatch(/^data:image\/jpeg;base64,/u)
  expect(glmPage({ layout_details: [[{ label: 'image', bbox_2d: [10, 20, 80, 90] }]] }).blocks).toHaveLength(1)
})
it('saves MinerU task ID before upload, strips credentials on storage URLs and resumes with GET', async () => {
  const saved: string[] = []
  const transport = io(response({ code: 0, data: { batch_id: 'batch', file_urls: ['https://storage.example/upload?signature=synthetic'] } }), new Response(''), response({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://storage.example/result' }] } }), new Response(archive()))
  transport.saveBatch = async id => { saved.push(id) }
  const result = await mineruRecognize(config('mineru'), new Uint8Array([1]), 'file.pdf', transport)
  expect(saved).toEqual(['batch']); expect(result).toHaveLength(2)
  expect(transport.fetch.mock.calls[1][1]).toMatchObject({ method: 'PUT' })
  expect((transport.fetch.mock.calls[1][1] as RequestInit).headers).toBeUndefined()
  expect((transport.fetch.mock.calls[3][1] as RequestInit).headers).toBeUndefined()
  const resume = io(response({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://storage.example/result' }] } }), new Response(archive()))
  await mineruRecognize(config('mineru'), new Uint8Array([1]), 'file.pdf', { ...resume, batchID: 'batch' })
  expect(resume.fetch.mock.calls[0][1]).toMatchObject({ method: 'GET' })
  expect(resume.fetch.mock.calls).toHaveLength(2)
})
it('preserves normalized GLM coordinates and strips active/remote markup', () => {
  expect(glmPage({ layout_details: [[{ content: 'text', label: 'text', bbox_2d: [10, 20, 100, 200], unused: 1 }]] }).blocks[0].bbox).toEqual([10, 20, 100, 200])
  expect(cleanOCRText('<script>secret()</script>![figure](https://remote) <img src="x">ok')).toBe('figure ok')
  const p = projectCloudPage({ blocks: [{ text: 'text' }] }, { pageIndex: 3, pageLabel: 'iv', lines: [], paragraphs: [] })
  expect(p.paragraphs[0].rects).toEqual([]); expect(p.pageLabel).toBe('iv')
})
function runtimeFixture() {
  const prefs = new Map<string, unknown>([[OCR_ENGINE_PREF, 'custom']])
  const canvas = () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => 'data:image/png;base64,AA==' })
  const viewport = { width: 600, height: 800, convertToViewportRectangle: (r: number[]) => r, convertToPdfPoint: (x: number, y: number) => [x, 800 - y] }
  const pdfPage = { getViewport: () => viewport, getTextContent: async () => ({ items: [] }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) }
  const pdf = { numPages: 3, getPage: vi.fn(async () => pdfPage) }
  const fetch = vi.fn(async () => response({ choices: [{ message: { content: 'Cloud text' }, finish_reason: 'stop' }] }))
  const host = { Prefs: { get: (k: string) => prefs.get(k), set: (k: string, v: unknown) => { prefs.set(k, v) } }, getMainWindow: () => ({ fetch }) as unknown as Window & typeof globalThis,
    Items: { get: () => ({ id: 1, libraryID: 1, key: 'ITEM', isPDFAttachment: () => true, getFilePathAsync: async () => 'synthetic.pdf' }) },
    Reader: { _readers: [{ itemID: 1, _internalReader: { _primaryView: { _iframeWindow: { document: { createElementNS: canvas }, PDFViewerApplication: { pdfDocument: pdf } } } } }] } }
  vi.stubGlobal('IOUtils', { read: async () => new Uint8Array([1, 2, 3]) })
  return { host, fetch, pdf }
}
it('runs cloud pages without local OCR, caches successful pages and isolates model changes', async () => {
  const { host, fetch } = runtimeFixture(); await saveCloudOCRConfig(host, config())
  const result = await readEngineDocument(host, 1, new AbortController().signal, () => {})
  expect(result.pages).toHaveLength(3); expect(result.pages[0].paragraphs[0].text).toBe('Cloud text')
  expect(result.ocr?.engine).toBe('custom'); expect(fetch).toHaveBeenCalledTimes(3)
  await readEngineDocument(host, 1, new AbortController().signal, () => {})
  expect(fetch).toHaveBeenCalledTimes(3)
  await saveCloudOCRConfig(host, { ...config(), model: 'other' })
  await readEngineDocument(host, 1, new AbortController().signal, () => {})
  expect(fetch).toHaveBeenCalledTimes(6); expect(ensureLocalOCR).not.toHaveBeenCalled()
})
it('retains failed page warnings and retries only failed pages', async () => {
  const { host, fetch } = runtimeFixture(); await saveCloudOCRConfig(host, config())
  fetch.mockImplementationOnce(async () => response({}, 500))
  const result = await readEngineDocument(host, 1, new AbortController().signal, () => {})
  expect(result.pages[0].warning).toContain('unrecognized')
  await readEngineDocument(host, 1, new AbortController().signal, () => {})
  expect(fetch).toHaveBeenCalledTimes(4)
})
it('sends only cropped images for cloud selection', async () => {
  const { host, fetch } = runtimeFixture(); await saveCloudOCRConfig(host, config())
  expect(await readEngineSelection(host, 1, [{ pageIndex: 0, rects: [[0, 0, 100, 80]] }], new AbortController().signal, () => {})).toBe('Cloud text')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(String(fetch.mock.calls[0][1])).not.toContain('synthetic.pdf')
  await readEngineSelection(host, 1, [{ pageIndex: 0, rects: [[0, 0, 100, 80]] }], new AbortController().signal, () => {})
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('includes recognition parameters in deterministic hashes', async () => {
  expect(await ocrHash('one')).not.toBe(await ocrHash('two'))
  expect(await ocrHash('one')).toMatch(/^[a-f0-9]{64}$/u)
})

it('creates render options in the Reader realm and unwraps Xray page methods', async () => {
  class ReaderObject {}
  const context = { drawImage: vi.fn() }, canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,AA==' }
  const doc = { defaultView: { Object: ReaderObject }, createElementNS: () => canvas } as unknown as Document
  const nativePage = {
    getViewport: (options: { scale: number }) => { expect(options).toBeInstanceOf(ReaderObject); return { width: 600, height: 800 } },
    render: (options: { canvasContext: unknown }) => { expect(options).toBeInstanceOf(ReaderObject); expect(options.canvasContext).toBe(context); return { promise: Promise.resolve(), cancel: vi.fn() } },
  }
  expect(await renderOCRImage({ wrappedJSObject: nativePage } as unknown as PDFPageProxy, doc, new AbortController().signal)).toContain('data:image/png')
})
it('retains equations and converts HTML tables into Markdown', () => {
  const result = cleanOCRText('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>\n$x<y$\n<|ref|>hello<|/ref|><|det|>[[1,2,3,4]]<|/det|>')
  expect(result).toContain('| --- | --- |'); expect(result).toContain('$x<y$'); expect(result).not.toContain('[[1,2,3,4]]')
})
it('bounds requests that time out without automatically replaying the POST', async () => {
  vi.useFakeTimers()
  const transport: CloudIO = { signal: new AbortController().signal, progress: vi.fn(), fetch: vi.fn((_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))) })) }
  const pending = expect(recognizeImage(config(), 'image', transport)).rejects.toMatchObject({ code: 'TIMEOUT_RESULT_UNCERTAIN' })
  await vi.advanceTimersByTimeAsync(120001); await pending
  expect(transport.fetch).toHaveBeenCalledTimes(1)
})
it('clears a terminal MinerU failure only for the next explicit retry', async () => {
  const transport = io(response({ code: 0, data: { extract_result: [{ state: 'failed' }] } }))
  const saveBatch = vi.fn(async () => {})
  await expect(mineruRecognize(config('mineru'), new Uint8Array(), 'file.pdf', { ...transport, batchID: 'old', saveBatch })).rejects.toMatchObject({ code: 'REMOTE_FAILED_MANUAL_RETRY' })
  expect(saveBatch).toHaveBeenCalledWith(''); expect(transport.fetch).toHaveBeenCalledTimes(1)
})

it('restores completed pages from profile storage after a fresh host session', async () => {
  const files = new Map<string, string>()
  const storage = { read: async () => new Uint8Array([1, 2, 3]), readUTF8: async (p: string) => { if (!files.has(p)) throw new Error('missing'); return files.get(p)! }, makeDirectory: async () => {}, writeUTF8: async (p: string, v: string) => { files.set(p, v) } }
  const first = runtimeFixture(); vi.stubGlobal('IOUtils', storage); vi.stubGlobal('PathUtils', { profileDir: '/synthetic', join: (...parts: string[]) => parts.join('/') })
  await saveCloudOCRConfig(first.host, config())
  await readEngineDocument(first.host, 1, new AbortController().signal, () => {})
  const next = runtimeFixture(); vi.stubGlobal('IOUtils', storage)
  await saveCloudOCRConfig(next.host, config())
  const result = await readEngineDocument(next.host, 1, new AbortController().signal, () => {})
  expect(result.pages[2].paragraphs[0].text).toBe('Cloud text'); expect(next.fetch).not.toHaveBeenCalled()
})
it('cancels in-flight page requests and does not dispatch the remaining page', async () => {
  const { host, fetch } = runtimeFixture(); await saveCloudOCRConfig(host, config()); const controller = new AbortController()
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
  fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    started(); (init as RequestInit).signal?.addEventListener('abort', () => reject(new Error('aborted')))
  }))
  const result = expect(readEngineDocument(host, 1, controller.signal, () => {})).rejects.toMatchObject({ name: 'AbortError' })
  await ready; controller.abort(); await result
  expect(fetch.mock.calls.length).toBeLessThanOrEqual(2)
})
it('splits PDFs above the MinerU 200-page limit into page images', async () => {
  const { host, fetch, pdf } = runtimeFixture()
  host.Prefs.set(OCR_ENGINE_PREF, 'mineru'); await saveCloudOCRConfig(host, config('mineru')); pdf.numPages = 201
  let submissions = 0
  fetch.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/file-urls/batch')) {
      const body = JSON.parse(String((init as RequestInit).body))
      expect(body.files[0].name).toBe('page.png'); submissions++
      return response({ code: 0, data: { batch_id: `page-${submissions}`, file_urls: ['https://store.example/upload'] } })
    }
    if (String(url).includes('extract-results/batch')) return response({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://store.example/result' }] } })
    return String(url).endsWith('/result') ? new Response(archive()) : new Response('')
  })
  const result = await readEngineDocument(host, 1, new AbortController().signal, () => {})
  expect(submissions).toBe(201); expect(result.pages).toHaveLength(201)
  expect(result.pages[200].paragraphs[0].pageIndex).toBe(200)
})
