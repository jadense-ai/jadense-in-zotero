/** 新版真实调度契约：OCR 边界用有序块夹具，网络用可控流；不安装模型。 */
import { describe, expect, it, vi } from 'vitest'
import { DocumentJobs } from './document-jobs'
import { DocumentStore, type TaskIO } from './document-store'
import { renderChatMarkdown } from '@/chat/markdown'
import { capacitySlices, chunkTranslationDocument, formulasPreserved, tokenCost, translationCapacity } from './translation-chunks'
import { extractReferences } from '@/chat/reference-list'
import { projectOCR } from './local-ocr'
import type { ZoteroLike } from './runtime'

const mock = vi.hoisted(() => ({ read: vi.fn(), ensure: vi.fn() }))
vi.mock('./local-ocr', async original => ({ ...await original<typeof import('./local-ocr')>(), readOCRDocument: mock.read, ensureLocalOCR: mock.ensure, stopLocalOCR: () => {} }))
// 本文件验证文档调度；HTTP 时钟/并发边界由 translation-scheduler.test.ts 覆盖。
vi.mock('@/chat/translation-queue', async original => ({ ...await original<typeof import('@/chat/translation-queue')>(), translationScheduler: () => ({ run: (input: { fetchImpl: typeof fetch; signal?: AbortSignal }, run: (network: typeof fetch, signal: AbortSignal) => Promise<unknown>) => run(input.fetchImpl, input.signal ?? new AbortController().signal) }) }))

function fixture(texts = ['First sentence.', 'Second sentence.']) {
  mock.read.mockReset(); mock.ensure.mockReset(); mock.ensure.mockResolvedValue(undefined)
  const source = { itemID: 1, itemKey: 'PDF1', libraryID: 1, title: 'Synthetic paper', modificationTime: 1 }
  const document = projectOCR({ pages: texts.map((text, i) => ({ pageIndex: i, blocks: [{ text, locations: [{ pageIndex: i, rects: [[0, 0, 100, 100]] }] }] })) }, source)
  const prefs = new Map<string, unknown>([['extensions.jadenseInZotero.token', 'synthetic-test-only'], ['extensions.jadenseInZotero.documentOCR', true]])
  const host = { Items: { get: () => ({ id: 1, key: 'PDF1', libraryID: 1, isPDFAttachment: () => true, attachmentModificationTime: 1 }) }, Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) } } as unknown as ZoteroLike
  mock.read.mockResolvedValue(document)
  return { host, prefs, document }
}
const reply = (text: string) => new Response(`data: ${JSON.stringify({ type: 'text-delta', delta: text })}\n\ndata: {"type":"finish"}\n\n`)

function durableStore() {
  const files = new Map<string, string>()
  const io: TaskIO = { makeDirectory: async () => {}, writeUTF8: async (path, data) => { files.set(path, data) }, readUTF8: async path => { if (!files.has(path)) throw new Error('missing'); return files.get(path)! }, getChildren: async path => [...new Set([...files.keys()].filter(key => key.startsWith(path + '/')).map(key => path + '/' + key.slice(path.length + 1).split('/')[0]))], remove: async path => { files.delete(path) } }
  const paths = { profileDir: '/synthetic', join: (...parts: string[]) => parts.join('/'), filename: (path: string) => path.split('/').at(-1)! }
  return { files, io, create: () => new DocumentStore(io, paths) }
}

describe('independent Markdown extraction', () => {
  it('translates the persisted Markdown field rather than rebuilding source text from location metadata', () => {
    const { document } = fixture(['Location metadata text.'])
    const pages = chunkTranslationDocument({ ...document, markdown: '# Authoritative Markdown\n\nSaved source.' }, 1000)
    expect(pages.flatMap(page => page.pieces.map(piece => piece.text)).join('')).toBe('# Authoritative Markdown\n\nSaved source.')
  })
  it('extracts without AI configuration, persists images outside Markdown and makes zero translation requests', async () => {
    const { host, prefs, document } = fixture(['## Title', '| A | B |\n| --- | --- |\n| 1 | 2 |'])
    prefs.clear(); prefs.set('extensions.jadenseInZotero.documentOCR', true); const fetch = vi.fn(), disk = durableStore(), jobs = new DocumentJobs(host, fetch, disk.create())
    document.pages[0].paragraphs.push({ ...document.pages[0].paragraphs[0], id: 'image', text: '⟦I1⟧', formulas: { '⟦I1⟧': 'data:image/png;base64,AA==' } })
    const extraction = await jobs.start('extraction', 1); await jobs.idle()
    expect(extraction.status).toBe('complete'); expect(fetch).not.toHaveBeenCalled(); expect(jobs.list('translation')).toEqual([])
    const saved = await jobs.store.extraction(extraction.id)
    expect(saved?.markdown).toContain('![Figure](jdx-asset:image-0)'); expect(saved?.markdown).toContain('| A | B |')
    expect(JSON.stringify(saved)).not.toContain('base64'); expect(await jobs.store.assets(extraction.id)).toEqual({ 'jdx-asset:image-0': 'data:image/png;base64,AA==' })
    expect([...disk.files.keys()].some(path => path.endsWith('/image-0.json'))).toBe(true)
    jobs.dispose()
  })
  it('silently extracts once for concurrent translation starts and reuses the source', async () => {
    const { host } = fixture(), fetch = vi.fn(async () => reply('译文')), jobs = new DocumentJobs(host, fetch, new DocumentStore())
    const [first, duplicate] = await Promise.all([jobs.start('translation', 1, true), jobs.start('translation', 1, true)])
    await jobs.idle()
    expect(first.id).toBe(duplicate.id); expect(first.status).toBe('complete')
    const second = await jobs.start('translation', 1, true); await jobs.idle()
    expect(second.extractionID).toBe(first.extractionID); expect(mock.read).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(2); jobs.dispose()
  })
  it('does not replace an explicitly selected missing source with another OCR version', async () => {
    const { host } = fixture(), fetch = vi.fn(), jobs = new DocumentJobs(host, fetch, new DocumentStore())
    await expect(jobs.start('translation', 1, true, { extractionID: 'missing' })).rejects.toThrow()
    expect(mock.read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); jobs.dispose()
  })
  it('does not send translation when automatic extraction fails or is cancelled', async () => {
    const { host } = fixture(), fetch = vi.fn(), jobs = new DocumentJobs(host, fetch, new DocumentStore())
    mock.read.mockRejectedValueOnce(new Error('OCR unavailable'))
    await expect(jobs.start('translation', 1)).rejects.toThrow('PDF')
    const controller = new AbortController()
    mock.read.mockImplementationOnce(() => new Promise(() => {}))
    const pending = jobs.start('translation', 1, false, { signal: controller.signal })
    await vi.waitFor(() => expect(mock.read).toHaveBeenCalledTimes(2)); controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled(); expect(jobs.list('translation')).toEqual([]); jobs.dispose()
  })
  it('deduplicates concurrent explicit extraction and translation starts', async () => {
    const { host } = fixture(), fetch = vi.fn(async () => reply('译文')), jobs = new DocumentJobs(host, fetch, new DocumentStore())
    const extracts = await Promise.all([jobs.start('extraction', 1, true), jobs.start('extraction', 1, true)])
    expect(extracts[0].id).toBe(extracts[1].id); expect(mock.read).toHaveBeenCalledOnce()
    const translations = await Promise.all([jobs.start('translation', 1, true), jobs.start('translation', 1, true)])
    await jobs.idle(); expect(translations[0].id).toBe(translations[1].id); expect(fetch).toHaveBeenCalledOnce(); jobs.dispose()
  })
  it('binds immutable source versions and translates saved Markdown after PDF deletion', async () => {
    const { host, document } = fixture(['First version.']), disk = durableStore(), fetch = vi.fn(async () => reply('译文'))
    const jobs = new DocumentJobs(host, fetch, disk.create()), first = await jobs.start('extraction', 1)
    document.pages[0].paragraphs[0].text = 'Second version.'
    const second = await jobs.start('extraction', 1, true)
    expect(first.id).not.toBe(second.id); expect((await jobs.store.extraction(first.id))?.markdown).toBe('First version.')
    host.Items!.get = () => undefined
    const translation = await jobs.start('translation', 1, true, { extractionID: first.id }); await jobs.idle()
    expect(translation.extractionID).toBe(first.id); expect(translation.status).toBe('complete'); expect(mock.read).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('Second version.')
    jobs.dispose(); const restored = new DocumentJobs(host, fetch, disk.create()); await restored.ready
    expect(restored.list('extraction')).toHaveLength(2); expect((await restored.reading(translation.id))[0].text).toBe('译文')
    restored.resume(translation.id); await restored.idle(); expect(fetch).toHaveBeenCalledOnce(); restored.dispose()
  })
  it('creates a new translation record for each language without another OCR run', async () => {
    const { host, prefs } = fixture(), jobs = new DocumentJobs(host, vi.fn(async () => reply('Translated')), new DocumentStore())
    await jobs.start('extraction', 1)
    const first = await jobs.start('translation', 1); await jobs.idle()
    // 与真实附件偏好键相同的身份格式由现有设置函数维护。
    const { writeArticleTranslationLanguages } = await import('./translation-settings')
    await writeArticleTranslationLanguages(host, 1, { sourceLanguage: 'en', targetLanguage: 'ja' })
    const second = await jobs.start('translation', 1); await jobs.idle()
    expect(first.id).not.toBe(second.id); expect(second.languages?.targetLanguage).toBe('ja'); expect(prefs.size).toBeGreaterThan(1); expect(mock.read).toHaveBeenCalledOnce(); jobs.dispose()
  })
  it('keeps cancellation and extraction failure visible without dispatching a translation', async () => {
    const { host } = fixture(), fetch = vi.fn(), jobs = new DocumentJobs(host, fetch, new DocumentStore()), controller = new AbortController()
    let release!: (value: unknown) => void
    mock.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = jobs.start('extraction', 1, false, { signal: controller.signal }); await vi.waitFor(() => expect(mock.read).toHaveBeenCalledOnce())
    controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); release({ pages: [] })
    expect(jobs.list('extraction')[0].status).toBe('paused'); expect(fetch).not.toHaveBeenCalled()
    mock.read.mockRejectedValueOnce(new Error('OCR unavailable'))
    await expect(jobs.start('extraction', 1, true)).rejects.toThrow('PDF')
    expect(jobs.list('extraction').some(task => task.status === 'error')).toBe(true); jobs.dispose()
  })
  it('keeps readable source and translations when persistence fails', async () => {
    const { host } = fixture(), jobs = new DocumentJobs(host, vi.fn(async () => reply('译文')), new DocumentStore())
    const extraction = await jobs.start('extraction', 1), translation = await jobs.start('translation', 1); await jobs.idle()
    expect(extraction.storageWarning).toBe(true); expect(translation.storageWarning).toBe(true)
    expect((await jobs.store.extraction(extraction.id))?.markdown).toContain('First sentence.'); expect(await jobs.copy(translation.id)).toContain('译文'); jobs.dispose()
  })
  it('retains text when an image file is missing and never deletes a referenced source', async () => {
    const { host, document } = fixture(['Text ⟦I1⟧']), disk = durableStore(), jobs = new DocumentJobs(host, vi.fn(async () => reply('译文 ![Figure](jdx-asset:image-0)')), disk.create())
    document.pages[0].paragraphs[0].formulas = { '⟦I1⟧': 'data:image/png;base64,AA==' }
    const extraction = await jobs.start('extraction', 1)
    for (const path of disk.files.keys()) if (path.endsWith('image-0.json')) disk.files.delete(path)
    expect(await jobs.store.assets(extraction.id)).toEqual({})
    const translated = await jobs.start('translation', 1); await jobs.idle(); expect(translated.status).toBe('complete')
    await jobs.delete(extraction.id); expect(jobs.get(extraction.id)).toBeDefined(); jobs.dispose()
  })
  it('keeps all pages beyond 80 and treats layout blocks as Markdown rather than request boundaries', async () => {
    const { host } = fixture(Array.from({ length: 90 }, (_, i) => `Page ${i + 1}.`)), fetch = vi.fn(async () => reply('译文')), jobs = new DocumentJobs(host, fetch, new DocumentStore())
    const extraction = await jobs.start('extraction', 1); expect((await jobs.store.extraction(extraction.id))?.markdown).toContain('Page 90.')
    const translated = await jobs.start('translation', 1); await jobs.idle(); expect(translated.totalPages).toBe(90); expect(fetch).toHaveBeenCalledOnce(); jobs.dispose()
  })
  it('keeps image references intact through tiny chunk capacities and checks translated resource identity', () => {
    const text = 'Text ![Figure](jdx-asset:image-12) more.'
    const chunks = capacitySlices(text, 5, text => text.length)
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text); expect(chunks.some(chunk => chunk.text === '![Figure](jdx-asset:image-12)')).toBe(true)
    expect(formulasPreserved(text, '译文 ![Figure](jdx-asset:image-12)')).toBe(true)
    expect(formulasPreserved(text, '译文 ![Figure](jdx-asset:image-13)')).toBe(false)
  })
  it.each(['https://example.com/tracker.png', 'file:///private/secret.png', 'data:image/png;base64,AA==', 'jdx-asset:../../secret'])('does not load an unregistered image: %s', url => {
    expect(renderChatMarkdown(`![Image](${url})`, { 'jdx-asset:image-0': 'data:image/png;base64,AA==' })).not.toContain('<img')
  })
  it('renders only a registered local image and contains broken image metadata', () => {
    expect(renderChatMarkdown('![Figure](jdx-asset:image-0)', { 'jdx-asset:image-0': 'data:image/png;base64,AA==' })).toContain('<img')
    expect(renderChatMarkdown('![Figure](jdx-asset:image-0)', { 'jdx-asset:image-0': 'file:///secret' })).not.toContain('<img')
  })
})

describe('OCR continuous translation', () => {
  it('packs many blocks and pages into one request and preserves source offsets', () => {
    const { document } = fixture(Array.from({ length: 100 }, (_, i) => `Sentence ${i}.`))
    const pages = chunkTranslationDocument(document, 2000)
    const paragraphs = pages.flatMap(page => page.paragraphs)
    expect(paragraphs).toHaveLength(1)
    expect(paragraphs[0].locations).toHaveLength(100)
    expect(paragraphs[0].text).toBe(document.pages.flatMap(page => page.paragraphs.map(p => p.text)).join('\n\n'))
    expect(paragraphs[0].sourceRange).toEqual({ start: 0, end: paragraphs[0].text.length })
  })
  it('never splits Unicode or formula placeholders and fills capacity', () => {
    const source = ('😀 bilingual 汉字 ⟦F12⟧. ').repeat(300)
    for (const [limit, measure] of [[1000, (text: string) => text.length], [200, tokenCost]] as const) {
      const pieces = capacitySlices(source, limit, measure)
      expect(pieces.map(piece => piece.text).join('')).toBe(source)
      expect(pieces.every(piece => measure(piece.text) <= limit)).toBe(true)
      expect(pieces.every(piece => !/[\uD800-\uDBFF]$/u.test(piece.text))).toBe(true)
      expect(pieces.flatMap(piece => piece.text.match(/⟦F12⟧/gu) ?? [])).toHaveLength(300)
      expect(pieces.slice(0, -1).every(piece => measure(piece.text) >= limit * .8)).toBe(true)
    }
  })
  it('uses the configured model output limit even for a short translated passage', async () => {
    const { host, prefs } = fixture(['Short passage.'])
    prefs.set('extensions.jadenseInZotero.autoFollowChatModel', false)
    prefs.set('extensions.jadenseInZotero.fullTranslationModel', JSON.stringify({ route: 'byok', modelId: 'm' }))
    prefs.set('extensions.jadenseInZotero.byokConfig', JSON.stringify({ version: 2, activeProviderId: 'p', activeModelId: 'm', providers: [{ id: 'p', name: 'P', protocol: 'openai-chat-completions', baseUrl: 'https://test.invalid/v1', apiKey: 'synthetic' }], models: [{ id: 'm', providerId: 'p', name: 'M', model: 'model', contextWindow: 64000, maxOutputTokens: 16000 }] }))
    prefs.set('extensions.jadenseInZotero.translationCapacity', JSON.stringify({ maxOutputTokens: 1024 }))
    const network = vi.fn<typeof fetch>(async () => new Response('data: {"choices":[{"delta":{"content":"译文"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
    const jobs = new DocumentJobs(host, network, new DocumentStore())
    await jobs.start('extraction', 1)
    const task = await jobs.start('translation', 1); await jobs.idle()
    expect(task.status).toBe('complete')
    expect(JSON.parse(String(network.mock.calls[0][1]?.body)).max_completion_tokens).toBe(16000)
    jobs.dispose()
  })
  it('reserves context space and ignores the retired translation output budget', () => {
    const { host, prefs } = fixture()
    prefs.set('extensions.jadenseInZotero.translationCapacity', JSON.stringify({ contextWindow: 32000, maxOutputTokens: 4096, future: true }))
    const value = translationCapacity(host)
    expect(value).not.toHaveProperty('maxOutputTokens')
    expect(value.sourceTokens).toBe(Math.floor((32000 - 1024) / 4))
    expect(value.sourceTokens * 4 + 1024).toBeLessThanOrEqual(32000)
    expect(formulasPreserved('⟦F1⟧ then ⟦F2⟧', '⟦F2⟧ then ⟦F1⟧')).toBe(false)
  })
  it('streams Markdown before completion, fences cancellation and resumes only missing chunks', async () => {
    const { host } = fixture(['The first paragraph.'])
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let attempts = 0
    const fetch = vi.fn(async () => {
      if (++attempts > 1) return reply('完整译文')
      return new Response(new ReadableStream({ async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"正在生成的译文"}\n\n'))
        await waiting
        controller.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"迟到内容"}\n\ndata: {"type":"finish"}\n\n')); controller.close()
      } }))
    })
    const jobs = new DocumentJobs(host, fetch, new DocumentStore())
    await jobs.start('extraction', 1)
    const task = await jobs.start('translation', 1)
    await vi.waitFor(async () => expect((await jobs.reading(task.id))[0]?.text).toBe('正在生成的译文'))
    expect(task.completed).toBe(0)
    expect((await jobs.reading(task.id))[0].draft).toBe(true)
    jobs.pause(task.id); release(); await jobs.idle()
    expect(task.completed).toBe(0)
    expect((await jobs.reading(task.id))[0].text).not.toContain('迟到')
    jobs.resume(task.id); await jobs.idle()
    expect(task.completed).toBe(1); expect(task.status).toBe('complete')
    expect((await jobs.reading(task.id))[0].draft).toBeUndefined()
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(JSON.stringify(body)).not.toContain('"translations"')
    jobs.dispose()
  })
  it('runs traditional translation without AI credentials and packs small paragraphs', async () => {
    const { host, prefs } = fixture(Array.from({ length: 20 }, () => 'Hello.'))
    prefs.delete('extensions.jadenseInZotero.token')
    prefs.set('extensions.jadenseInZotero.translationInterface', '{"kind":"machine","service":"google"}')
    const fetch = vi.fn(async () => new Response('<div class="result-container">译文</div>'))
    const jobs = new DocumentJobs(host, fetch, new DocumentStore())
    await jobs.start('extraction', 1)
    const task = await jobs.start('translation', 1); await jobs.idle()
    expect(task.status).toBe('complete'); expect(fetch).toHaveBeenCalledOnce()
    expect(String(fetch.mock.calls[0]?.[0])).toContain('translate.google')
    jobs.dispose()
  })
  it('keeps completed chunks across failure and resume; missing formulas are not completed', async () => {
    const { host } = fixture(['Text '.repeat(4000)])
    let fail = true
    const fetch = vi.fn(async () => { if (fetch.mock.calls.length === 2 && fail) return new Response(null, { status: 400 }); return reply('译文') })
    const jobs = new DocumentJobs(host, fetch, new DocumentStore())
    await jobs.start('extraction', 1)
    const task = await jobs.start('translation', 1); await jobs.idle()
    expect(task.status).toBe('error'); expect(task.completed).toBe(1)
    expect(task.error).toContain('已完成内容已保留'); expect(task.issue?.stage).toBe('generation')
    const completed = task.completed, calls = fetch.mock.calls.length
    fail = false; jobs.resume(task.id); await jobs.idle()
    expect(task.status).toBe('complete')
    expect(fetch.mock.calls.length - calls).toBe(task.total - completed)
    jobs.dispose()
  })
  it('preserves formulas locally without translation requests and uses physical pages', async () => {
    const { host, document } = fixture([''])
    document.pages[0].paragraphs[0].text = '⟦F1⟧'
    document.pages[0].paragraphs[0].pageLabel = '600'
    const fetch = vi.fn()
    const jobs = new DocumentJobs(host, fetch, new DocumentStore())
    await jobs.start('extraction', 1)
    const task = await jobs.start('translation', 1); await jobs.idle()
    expect(fetch).not.toHaveBeenCalled(); expect(task.status).toBe('complete')
    expect((await jobs.reading(task.id))[0].paragraph?.pageLabel).toBe('1')
    jobs.dispose()
  })
  it('restores old history read-only without OCR or automatic retranslation', async () => {
    const { host, document } = fixture()
    const store = new DocumentStore()
    const old = { version: 1 as const, id: crypto.randomUUID(), kind: 'translation' as const, source: document.source, createdAt: new Date().toISOString(), status: 'partial' as const, totalPages: 2, completed: 1, total: 2, models: [], warnings: [], extractionVersion: 4 }
    await store.save(old)
    const fetch = vi.fn(); mock.read.mockClear()
    const jobs = new DocumentJobs(host, fetch, store); await jobs.ready
    jobs.resume(old.id); await jobs.idle()
    expect(mock.read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    expect(jobs.get(old.id)?.error).toContain('旧版历史')
    jobs.dispose()
  })
})


describe('full translation regression boundaries', () => {
  it('accepts translated image labels but rejects changed resources and formulas', () => {
    expect(formulasPreserved('Text ![Figure](jdx-asset:image-0)', '译文 ![图片](jdx-asset:image-0)')).toBe(true)
    expect(formulasPreserved('Text', '译文 ![Extra](https://example.test/track.png)')).toBe(false)
    expect(formulasPreserved('⟦F1⟧ ![Figure](jdx-asset:image-0)', '⟦F2⟧ ![图片](jdx-asset:image-0)')).toBe(false)
  })
  it.each(['translation', 'extraction', 'references'] as const)('attempts traditional extraction for %s when OCR is unavailable', async kind => {
    const { host } = fixture(); mock.ensure.mockRejectedValue(Object.assign(new Error('OCR not ready'), { code: 'OCR_NOT_READY' }))
    const fetch = vi.fn(), jobs = new DocumentJobs(host, fetch, new DocumentStore())
    await expect(jobs.start(kind, 1)).rejects.toThrow('PDF')
    expect(jobs.list().some(task => task.status === 'error')).toBe(true); expect(mock.read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    jobs.dispose()
  })
  it('does not pause when unrelated preferences or the same value are saved', async () => {
    const { host, prefs } = fixture(['Text '.repeat(4000)])
    const callbacks = new Map<string, () => void>()
    host.Prefs!.registerObserver = (key, callback) => { callbacks.set(key, callback); return key }
    const fetch = vi.fn(async () => {
      callbacks.get('extensions.jadenseInZotero.paperAnalysisModel')?.()
      callbacks.get('extensions.jadenseInZotero.translationInterface')?.()
      prefs.set('extensions.jadenseInZotero.byokConfig', '{}')
      callbacks.get('extensions.jadenseInZotero.byokConfig')?.()
      return reply('译文')
    })
    const jobs = new DocumentJobs(host, fetch, new DocumentStore())
    const task = await jobs.start('translation', 1); await jobs.idle()
    expect(task.status).toBe('complete'); expect(fetch.mock.calls.length).toBeGreaterThan(1)
    jobs.dispose()
  })
})


it('extracts OCR references across pages with raw headings, labels and coordinates', () => {
  const { document } = fixture(['unused'])
  const raw = projectOCR({ pages: [
    { pageIndex: 0, blocks: [{ text: 'References', kind: 'section_header', locations: [{ pageIndex: 0, rects: [[0, 0, 10, 10]] }] }, { text: '[1] Smith, J. (2024). First research title.', locations: [{ pageIndex: 0, rects: [[0, 0, 10, 10]] }] }] },
    { pageIndex: 1, blocks: [{ text: '[2] Brown, A. (2023). Second research title.', locations: [{ pageIndex: 1, rects: [[0, 0, 10, 10]] }] }] },
  ] }, document.source)
  const references = extractReferences(raw)
  expect(references).toHaveLength(2); expect(references.map(row => row.label)).toEqual(['1', '2'])
  expect(references[1].lines[0].pageIndex).toBe(1); expect(references[1].lines[0].rects).toHaveLength(1)
})

it('retains a points error and correlated chunk identity, then resumes only missing chunks', async () => {
  const { host } = fixture(['Text '.repeat(4000)])
  const fetch = vi.fn(async () => fetch.mock.calls.length === 2 ? Response.json({ code: 'POINTS_INSUFFICIENT', error: 'private provider data' }, { status: 402 }) : reply('译文'))
  const disk = durableStore(), jobs = new DocumentJobs(host, fetch, disk.create())
  const task = await jobs.start('translation', 1); await jobs.idle()
  expect(task.status).toBe('error'); expect(task.completed).toBe(1)
  expect(task.issue?.action).toBe('connection'); expect(task.error).toContain('积分不足'); expect(task.error).not.toContain('private')
  const body = JSON.parse(String(fetch.mock.calls[1][1]?.body))
  expect(body.clientContext).toMatchObject({ feature: 'translation', operation: 'full_translation', taskId: task.id, chunkIndex: 2, chunkTotal: task.total })
  expect(body.operationId).toBe(body.clientContext.chunkId)
  const reloaded = new DocumentJobs(host, fetch, disk.create()); await reloaded.ready
  expect(reloaded.get(task.id)?.issue?.id).toBe(task.issue?.id)
  jobs.resume(task.id); await jobs.idle(); expect(task.status).toBe('complete')
  jobs.dispose(); reloaded.dispose()
})

it('resumes saved Markdown without OCR when models are removed', async () => {
  const { host } = fixture(), jobs = new DocumentJobs(host, vi.fn(async () => reply('译文')), durableStore().create())
  const task = await jobs.start('translation', 1); await jobs.idle()
  mock.ensure.mockRejectedValue(Object.assign(new Error('missing'), { code: 'OCR_NOT_READY' }))
  jobs.resume(task.id); await jobs.idle()
  expect(task.status).toBe('complete'); expect(task.issue).toBeUndefined()
  expect(await jobs.copy(task.id)).toContain('译文'); jobs.dispose()
})

it('pauses when the active credential changes and retains a visible reason', async () => {
  const { host, prefs } = fixture(['Text '.repeat(4000)])
  const fetch = vi.fn(async () => { prefs.set('extensions.jadenseInZotero.token', 'changed-test-token'); return reply('译文') })
  const jobs = new DocumentJobs(host, fetch, durableStore().create())
  const task = await jobs.start('translation', 1); await jobs.idle()
  expect(task.status).toBe('paused'); expect(task.issue?.code).toBe('CONFIG_CHANGED'); expect(fetch).toHaveBeenCalledOnce()
  jobs.dispose()
})


it('keeps a running full translation when selection settings change, but pauses for its own effective model', async () => {
  const { host, prefs } = fixture(['Full source text.'])
  prefs.set('extensions.jadenseInZotero.autoFollowChatModel', false)
  prefs.set('extensions.jadenseInZotero.fullTranslationModel', JSON.stringify({ route: 'jadense', selection: { kind: 'model', modelId: 'full-model' } }))
  const callbacks = new Map<string, () => void>()
  host.Prefs!.registerObserver = (key, callback) => { callbacks.set(key, callback); return key }
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    prefs.set('extensions.jadenseInZotero.selectionTranslationInterface', JSON.stringify({ kind: 'machine', service: 'google' }))
    callbacks.get('extensions.jadenseInZotero.selectionTranslationInterface')?.()
    prefs.set('extensions.jadenseInZotero.selectionTranslationModel', JSON.stringify({ route: 'byok', modelId: 'selection-model' }))
    callbacks.get('extensions.jadenseInZotero.selectionTranslationModel')?.()
    expect(init?.signal?.aborted).toBe(false)
    prefs.set('extensions.jadenseInZotero.chatModel', JSON.stringify({ route: 'byok', modelId: 'unrelated-chat' }))
    callbacks.get('extensions.jadenseInZotero.chatModel')?.()
    expect(init?.signal?.aborted).toBe(false)
    prefs.set('extensions.jadenseInZotero.fullTranslationModel', JSON.stringify({ route: 'jadense', selection: { kind: 'model', modelId: 'changed-full' } }))
    callbacks.get('extensions.jadenseInZotero.fullTranslationModel')?.()
    expect(init?.signal?.aborted).toBe(true)
    throw new DOMException('Stopped', 'AbortError')
  })
  const jobs = new DocumentJobs(host, fetch, new DocumentStore())
  await jobs.start('extraction', 1)
  const task = await jobs.start('translation', 1)
  await jobs.idle()
  expect(fetch).toHaveBeenCalledOnce()
  expect(task.status).toBe('paused')
  expect(task.completed).toBe(0)
  jobs.dispose()
})


it('subscribes to global full-service preferences and namespaced model preferences', () => {
  const { host } = fixture()
  const observe = vi.fn(() => 'observer')
  host.Prefs!.registerObserver = observe
  const jobs = new DocumentJobs(host, vi.fn(), new DocumentStore())
  expect(observe).toHaveBeenCalledWith('extensions.jadenseInZotero.fullTranslationInterface', expect.any(Function), true)
  expect(observe).toHaveBeenCalledWith('extensions.jadenseInZotero.fullTranslationModel', expect.any(Function), false)
  expect(observe).not.toHaveBeenCalledWith('extensions.jadenseInZotero.selectionTranslationInterface', expect.any(Function), true)
  jobs.dispose()
})
