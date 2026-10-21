/** 回归：OCR 页进展与模型思考事件均续租空闲观察窗口，仍保留绝对总时限。 */
import { afterEach, expect, it, vi } from 'vitest'
import { readPdfForAnalysis } from './reader-tools'
import { readDocument } from './document-extraction'
import { analysisStage } from './analysis-stage'
import { runIndependentPaperAnalysis } from './paper-analysis-runner'
import { AUTO_FOLLOW_CHAT_MODEL_PREF_KEY } from './ai-settings'
vi.mock('./document-extraction', () => ({ analysisOCREnabled: () => true, readDocument: vi.fn() }))
vi.mock('./cloud-ocr-config', () => ({ ocrEngine: () => 'local' }))
afterEach(() => vi.useRealTimers())

it('finishes an OCR extraction longer than 180 seconds while real page progress continues', async () => {
  vi.useFakeTimers()
  const activity = vi.fn()
  vi.mocked(readDocument).mockImplementation(async (_host, _id, _signal, progress) => await new Promise(resolve => {
    const timer = setInterval(() => progress?.('OCR page completed'), 30_000)
    setTimeout(() => { clearInterval(timer); resolve({ source: { itemID: 42, libraryID: 1, itemKey: 'PDF42', title: 'Fixture' }, pages: [{
      pageIndex: 0, pageLabel: '1', paragraphs: [{ id: 'p0', text: 'Synthetic OCR evidence', rects: [[1, 2, 3, 4]] }],
    }] } as never) }, 240_000)
  }))
  const host = { Items: { get: () => ({ id: 42, libraryID: 1, key: 'PDF42', isPDFAttachment: () => true, getField: () => 'Fixture' }) } }
  const pending = analysisStage(new AbortController().signal, 'Reading PDF', 180_000, (signal, heartbeat) =>
    readPdfForAnalysis(host, 42, { signal, onActivity: () => { activity(); heartbeat() } }), 1_800_000)
  await vi.advanceTimersByTimeAsync(240_001)
  expect((await pending).passages[0]?.text).toBe('Synthetic OCR evidence')
  expect(activity).toHaveBeenCalledTimes(8)
  expect(vi.getTimerCount()).toBe(0)
})

it('accepts active model reasoning beyond 180 seconds before receiving text', async () => {
  vi.useFakeTimers()
  const prefs = new Map<string, unknown>([[AUTO_FOLLOW_CHAT_MODEL_PREF_KEY, false], ['extensions.jadenseInZotero.token', 'synthetic']])
  const host = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => { prefs.set(key, value) } } }
  const send = vi.fn(async input => await new Promise<string>(resolve => {
    const timer = setInterval(() => input.onProgress?.({ stage: 'reasoning' }), 30_000)
    setTimeout(() => { clearInterval(timer); resolve('{"summary":"Completed after reasoning","annotations":[]}') }, 240_000)
  }))
  const result = runIndependentPaperAnalysis({ zotero: host, itemID: 42, fetchImpl: vi.fn(), signal: new AbortController().signal,
    services: { readPdf: async () => ({ itemID: 42, libraryID: 1, itemKey: 'PDF42', title: 'Fixture', metadata: { title: 'Fixture', authors: [] }, passages: [],
      coverage: { pagesRead: 1, totalPages: 1, limited: false, pageNumbers: [1], warnings: [] } }), send } })
  await vi.advanceTimersByTimeAsync(240_001)
  expect((await result).record.summary).toBe('Completed after reasoning')
  expect(send).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
