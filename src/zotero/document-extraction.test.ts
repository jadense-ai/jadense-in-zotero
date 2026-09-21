/** 提取策略回归：默认零 OCR、可选增强故障回退、取消隔离、PDF.js 兜底。 */
import { expect, it, vi } from 'vitest'
import { readDocument, DOCUMENT_OCR_PREF } from './document-extraction'
import { ensureLocalOCR, readOCRDocument } from './local-ocr'
import { readPdfForAnalysis } from './reader-tools'
vi.mock('./local-ocr', async original => ({ ...await original<typeof import('./local-ocr')>(), ensureLocalOCR: vi.fn(), readOCRDocument: vi.fn() }))

function fixture(ocr = false) {
  vi.mocked(ensureLocalOCR).mockReset(); vi.mocked(readOCRDocument).mockReset()
  const pdf = { numPages: 1, getPage: vi.fn(async () => ({ view: [0, 0, 600, 800], getTextContent: async () => ({ items: [{ str: 'Traditional extraction preserves this sentence.', width: 240, height: 12, transform: [12, 0, 0, 12, 20, 100] }] }) })) }
  const host = { Prefs: { get: (key: string) => key === DOCUMENT_OCR_PREF && ocr }, Items: { get: () => ({ id: 1, libraryID: 1, key: 'PDF1', isPDFAttachment: () => true, getField: () => 'Paper' }) }, Reader: { _readers: [{ itemID: 1, _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument: pdf } } } } }] } }
  return { host, pdf }
}
it('uses PDF.js without OCR when native chars are unavailable, for Markdown and analysis', async () => {
  const { host } = fixture()
  const raw = await readDocument(host, 1, new AbortController().signal)
  expect(raw.pages[0].paragraphs[0].text).toContain('Traditional extraction')
  const analysis = await readPdfForAnalysis(host, 1)
  expect(analysis.passages[0].position.rects).toEqual([[20, 100, 260, 112]])
  expect(ensureLocalOCR).not.toHaveBeenCalled(); expect(readOCRDocument).not.toHaveBeenCalled()
})
it.each(['check', 'read'])('falls back when OCR %s fails without losing text', async stage => {
  const { host } = fixture(true)
  vi.mocked(stage === 'check' ? ensureLocalOCR : readOCRDocument).mockRejectedValue(new Error('OCR unavailable'))
  const raw = await readDocument(host, 1, new AbortController().signal)
  expect(raw.pages[0].paragraphs).toHaveLength(1); expect(raw.pages[0].warning).toContain('OCR')
})
it('does not fall back after cancellation', async () => {
  const { host, pdf } = fixture(true), controller = new AbortController()
  vi.mocked(ensureLocalOCR).mockImplementation(async () => { controller.abort() })
  await expect(readDocument(host, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(pdf.getPage).not.toHaveBeenCalled(); expect(readOCRDocument).not.toHaveBeenCalled()
})
it('marks scanned pages as needing OCR instead of a complete text extraction', async () => {
  const { host, pdf } = fixture()
  pdf.getPage.mockResolvedValue({ view: [0, 0, 600, 800], getTextContent: async () => ({ items: [] }) })
  const raw = await readDocument(host, 1, new AbortController().signal)
  expect(raw.pages[0].paragraphs).toHaveLength(0)
  expect(raw.pages[0].warning).toContain('OCR')
  expect(ensureLocalOCR).not.toHaveBeenCalled()
})
it('uses checked OCR text and real page coordinates for analysis when enabled', async () => {
  const { host, pdf } = fixture(true)
  vi.mocked(readOCRDocument).mockResolvedValue({ source: { itemID: 1, libraryID: 1, itemKey: 'PDF1', title: 'Paper' }, pages: [{ pageIndex: 0, pageLabel: '1', lines: [], paragraphs: [{ id: 'ocr-1', text: 'OCR extracted a scanned passage.', pageIndex: 0, pageLabel: '1', rects: [[10, 20, 100, 40]], lineIDs: [] }] }] })
  const result = await readPdfForAnalysis(host, 1)
  expect(ensureLocalOCR).toHaveBeenCalledOnce(); expect(pdf.getPage).not.toHaveBeenCalled()
  expect(result.passages[0]).toMatchObject({ text: 'OCR extracted a scanned passage.', position: { pageIndex: 0, rects: [[10, 20, 100, 40]] } })
})

it.each([true, false])('uses the per-extraction OCR choice (%s) instead of the global preference', async useOCR => {
  const { host, pdf } = fixture(!useOCR)
  vi.mocked(readOCRDocument).mockResolvedValue({ source: { itemID: 1, libraryID: 1, itemKey: 'PDF1', title: 'Paper' }, pages: [] })
  await readDocument(host, 1, new AbortController().signal, undefined, useOCR)
  expect(ensureLocalOCR).toHaveBeenCalledTimes(useOCR ? 1 : 0)
  expect(readOCRDocument).toHaveBeenCalledTimes(useOCR ? 1 : 0)
  expect(pdf.getPage).toHaveBeenCalledTimes(useOCR ? 0 : 1)
})
