/** 新版真实调度契约：OCR 边界用有序块夹具，网络用可控流；不安装模型。 */
import { describe, expect, it, vi } from 'vitest'
import { DocumentJobs } from './document-jobs'
import { DocumentStore, type TaskIO } from './document-store'
import { renderChatMarkdown } from '@/chat/markdown'
import { capacitySlices, chunkTranslationDocument, formulasPreserved, tokenCost, translationCapacity } from './translation-chunks'
import { projectOCR } from './local-ocr'
import type { ZoteroLike } from './runtime'

const mock = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./local-ocr', async original => ({ ...await original<typeof import('./local-ocr')>(), readOCRDocument: mock.read, stopLocalOCR: () => {} }))
vi.mock('@/chat/translation-queue', async original => ({ ...await original<typeof import('@/chat/translation-queue')>(), queueTranslation: async (_host: unknown, _key: string, _signal: unknown, run: () => Promise<unknown>) => run() }))

function fixture(texts = ['First sentence.', 'Second sentence.']) {
  mock.read.mockReset()
  const source = { itemID: 1, itemKey: 'PDF1', libraryID: 1, title: 'Synthetic paper', modificationTime: 1 }
  const document = projectOCR({ pages: texts.map((text, i) => ({ pageIndex: i, blocks: [{ text, locations: [{ pageIndex: i, rects: [[0, 0, 100, 100]] }] }] })) }, source)
  const prefs = new Map<string, unknown>([['extensions.jadenseInZotero.token', 'synthetic-test-only']])
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
    prefs.clear(); const fetch = vi.fn(), disk = durableStore(), jobs = new DocumentJobs(host, fetch, disk.create())
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
    await expect(jobs.start('translation', 1)).rejects.toThrow('OCR unavailable')
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
    await expect(jobs.start('extraction', 1, true)).rejects.toThrow('OCR unavailable')
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
  it('bounds input and output jointly and ignores additive capacity fields', () => {
    const { host, prefs } = fixture()
    prefs.set('extensions.jadenseInZotero.translationCapacity', JSON.stringify({ contextWindow: 32000, maxOutputTokens: 4096, future: true }))
    const value = translationCapacity(host)
    expect(value.sourceTokens * 3 + 256).toBeLessThanOrEqual(4096)
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
    expect(task.error).toContain('400'); expect(task.error).toContain('响应正文为空')
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
