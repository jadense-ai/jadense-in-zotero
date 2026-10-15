/** 攻玉模拟线协议贯穿真实可靠客户端、简阅任务和状态；不调用外部模型。 */
import { afterEach, expect, it, vi } from 'vitest'
import { SimpleReadingJobs, readingTransport } from './simple-reading-jobs'
import { SimpleReadingStore } from './simple-reading-store'
import { saveTranslationSpeed, stopTranslationScheduler } from '@/chat/translation-queue'
import type { ZoteroLike } from './runtime'
import { pdfTranslationStatusView } from './pdf-translation-status'
import type { PDFTranslationTask } from './pdf-translation-jobs'
const hosts: object[] = []
afterEach(() => { hosts.forEach(stopTranslationScheduler); hosts.length = 0; vi.unstubAllGlobals() })
const headers = { 'x-jadense-temporary-protocol': '1' }
const identity = { source: { itemID: 1, libraryID: 1, itemKey: 'K', title: 'Fixture' }, fingerprint: 'f', sdtHash: 's', contentHash: 'c' }
const languages = { sourceLanguage: 'en' as const, targetLanguage: 'zh-CN' as const }
function fixture(fetchImpl: typeof fetch) {
  const files = new Map<string, string>(), prefs = new Map<string, unknown>([
    ['extensions.jadenseInZotero.baseUrl', 'http://127.0.0.1:34567'], ['extensions.jadenseInZotero.token', 'synthetic'],
    ['extensions.jadenseInZotero.aiModelSettings', JSON.stringify({ version: 1, followChatModel: false, models: { translation: { route: 'jadense', selection: { kind: 'default' } } } })],
  ])
  vi.stubGlobal('PathUtils', { profileDir: '/fixture', join: (...parts: string[]) => parts.join('/'), filename: (p: string) => p.split('/').at(-1) })
  vi.stubGlobal('IOUtils', { exists: async () => true, makeDirectory: async () => {}, readUTF8: async (p: string) => files.get(p)!,
    writeUTF8: async (p: string, text: string) => { files.set(p, text) },
    getChildren: async (p: string) => [...new Set([...files.keys()].filter(f => f.startsWith(p + '/')).map(f => p + '/' + f.slice(p.length + 1).split('/')[0]))],
  })
  const host = { Prefs: { get: (k: string) => prefs.get(k), set: (k: string, v: unknown) => prefs.set(k, v) }, getMainWindow: () => ({ fetch: fetchImpl }) } as unknown as ZoteroLike
  hosts.push(host); saveTranslationSpeed(host, 'http://127.0.0.1:34567', { concurrency: 2, rpm: 60000, batchTokens: 1600 })
  return { host, jobs: new SimpleReadingJobs(new SimpleReadingStore()) }
}
it.each(['partial', 'failed'] as const)('recovers %s before translating only missing paragraphs with fresh identity', async state => {
  const sent: Record<string, unknown>[] = [], methods: string[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).includes('/models')) return Response.json({ options: [] })
    methods.push(init?.method ?? 'GET')
    if (init?.method === 'HEAD') return new Response(null, { headers })
    if (init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body)))
      if (sent.length === 1) return new Response('data: {"type":"reasoning-delta","delta":"synthetic"}\n\ndata: {"type":"error","code":"STREAM_INCOMPLETE"}\n\n', { headers: { ...headers, 'content-type': 'text/event-stream' } })
      return Response.json({ state: 'completed', complete: true, text: state === 'partial' ? '{"1":"第二段"}' : '{"1":"第一段"}\n{"2":"第二段"}' }, { headers })
    }
    return Response.json({ state, complete: false, code: state === 'partial' ? 'STREAM_INCOMPLETE' : 'REASONING_ONLY', stage: 'stream', text: state === 'partial' ? '{"1":"第一段"}\n{"2":"截断' : '' }, { headers })
  }
  const { host, jobs } = fixture(fetchImpl)
  const task = await jobs.start(identity, languages, [{ id: '0.12', text: 'First' }, { id: '1.4', text: 'Second' }], await readingTransport(host), () => new Set())
  await vi.waitFor(() => expect(jobs.active(task.id)).toBe(false), { timeout: 5000 })
  expect(task.status).toBe('complete'); expect(task.outputs).toEqual({ '0.12': '第一段', '1.4': '第二段' })
  expect(sent).toHaveLength(2); expect(methods).toContain('GET')
  expect(sent[0].operationId).not.toBe(sent[1].operationId)
  expect(sent[1].previousRequestId).toBe(sent[0].clientRequestId)
  expect(JSON.stringify(sent[0])).not.toContain('0.12')
  if (state === 'partial') expect(JSON.stringify(sent[1])).not.toContain('First')
  expect(task.progress!.receivedCharacters).toBeGreaterThan(0)
  const reopened = new SimpleReadingJobs(new SimpleReadingStore()); await reopened.load()
  expect(reopened.get(task.id)?.outputs).toEqual(task.outputs); expect(sent).toHaveLength(2)
})
it('does not call an original-only PDF artifact saved translation', () => {
  const task = { status: 'running', stage: 'translation', percent: 0, skipped: [], completed: 0, total: 193 } as unknown as PDFTranslationTask
  expect(pdfTranslationStatusView({ task, hasOutput: true }).lines.join('\n')).not.toMatch(/已有译文|Completed translations/)
})
