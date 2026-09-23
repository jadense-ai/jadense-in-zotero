/** 提取策略回归：默认零 OCR、可选增强故障回退、取消隔离、PDF.js 兜底。 */
import { expect, it, vi } from 'vitest'
import { readDocument, DOCUMENT_OCR_PREF } from './document-extraction'
import { ensureLocalOCR, readOCRDocument } from './local-ocr'
import { readPdfForAnalysis, saveAnalysisAnnotations } from './reader-tools'
import { OCR_ENGINE_PREF } from './cloud-ocr-config'
import { snapshotPDFChars, textPage } from './pdf-document'
vi.mock('./local-ocr', async original => ({ ...await original<typeof import('./local-ocr')>(), ensureLocalOCR: vi.fn(), readOCRDocument: vi.fn() }))

function fixture(ocr = false) {
  vi.mocked(ensureLocalOCR).mockReset(); vi.mocked(readOCRDocument).mockReset()
  const pdf = { numPages: 1, getPage: vi.fn(async () => ({ view: [0, 0, 600, 800], getTextContent: async () => ({ items: [{ str: 'Traditional extraction preserves this sentence.', width: 240, height: 12, transform: [12, 0, 0, 12, 20, 100] }] }) })) }
  const host = { Prefs: { get: (key: string) => key === DOCUMENT_OCR_PREF && ocr }, Items: { get: () => ({ id: 1, libraryID: 1, key: 'PDF1', isPDFAttachment: () => true, getField: () => 'Paper' }) }, Reader: { _readers: [{ itemID: 1, _internalReader: { _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument: pdf } } } } }] } }
  return { host, pdf }
}
it('copies native glyphs through the Reader serializer without changing text or coordinates', () => {
  const chars = [{ c: 'Located text', rect: [1, 2, 30, 12], paragraphBreakAfter: true }]
  const stringify = vi.fn(JSON.stringify)
  const copied = snapshotPDFChars(chars, { JSON: { stringify } })
  expect(stringify).toHaveBeenCalledOnce()
  expect(copied).not.toBe(chars)
  expect(textPage(copied, 0, '1')).toEqual(textPage(chars, 0, '1'))
  expect(snapshotPDFChars(chars, { JSON: { stringify: () => { throw new Error('unavailable') } } })).toBe(chars)
})
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

it('falls back to located text when OCR has no coordinates and reports the reason', async () => {
  const { host } = fixture(true)
  vi.mocked(readOCRDocument).mockResolvedValue({ source: { itemID: 1, libraryID: 1, itemKey: 'PDF1', title: 'Paper' }, pages: [{ pageIndex: 0, pageLabel: '1', lines: [], paragraphs: [{ id: 'cloud-0', text: 'Cloud OCR passage without coordinates', pageIndex: 0, pageLabel: '1', rects: [], lineIDs: [] }] }] })
  const onNotice = vi.fn()
  const result = await readPdfForAnalysis(host, 1, { onNotice })
  expect(result.passages[0].text).toContain('Traditional extraction')
  expect(result.passages[0].position.rects).toEqual([[20, 100, 260, 112]])
  expect(result.coverage.warnings.join(' ')).toContain('有效位置')
  expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('传统'))
})

it.each(['siliconflow', 'aliyun', 'custom'])('skips unlocatable %s OCR before dispatch for analysis', async engine => {
  const { host } = fixture(true)
  const get = host.Prefs.get
  const configured = { ...host, Prefs: { get: (key: string) => key === OCR_ENGINE_PREF ? engine : get(key) } }
  const result = await readPdfForAnalysis(configured, 1)
  expect(result.passages[0].text).toContain('Traditional extraction')
  expect(result.coverage.warnings.join(' ')).toContain('传统')
  expect(readOCRDocument).not.toHaveBeenCalled()
})

it('explains failed traditional fallback on a scanned PDF without inventing coordinates', async () => {
  const { host, pdf } = fixture(true)
  vi.mocked(readOCRDocument).mockResolvedValue({ source: { itemID: 1, libraryID: 1, itemKey: 'PDF1', title: 'Paper' }, pages: [{ pageIndex: 0, pageLabel: '1', lines: [], paragraphs: [{ id: 'cloud-0', text: 'Scan text', pageIndex: 0, pageLabel: '1', rects: [], lineIDs: [] }] }] })
  pdf.getPage.mockResolvedValue({ view: [0, 0, 600, 800], getTextContent: async () => ({ items: [] }) })
  await expect(readPdfForAnalysis(host, 1)).rejects.toThrow(/有效位置.*传统/s)
})

it.each([false, true])('writes category tags from the actual %s extraction snapshot', async useOCR => {
  const { host } = fixture(useOCR)
  vi.mocked(readOCRDocument).mockResolvedValue({ source: { itemID: 1, libraryID: 1, itemKey: 'PDF1', title: 'Paper' }, pages: [{ pageIndex: 0, pageLabel: '1', lines: [], paragraphs: [{ id: 'ocr-1', text: 'Located OCR sentence.', pageIndex: 0, pageLabel: '1', rects: [[10, 20, 100, 40]], lineIDs: [] }] }] })
  const item = { ...host.Items.get(), isEditable: () => true, getAnnotations: () => [] }
  const saveFromJSON = vi.fn(async () => {})
  const writable = { ...host, Items: { get: () => item, getByLibraryAndKey: async () => null }, Annotations: { saveFromJSON }, DataObjectUtilities: { generateKey: () => 'NEWKEY01' } }
  const snapshot = await readPdfForAnalysis(writable, 1)
  const result = await saveAnalysisAnnotations(writable, snapshot, [{ passageId: snapshot.passages[0].id, category: 'claim', comment: 'Evidence' }])
  expect(result.created).toBe(1)
  expect(saveFromJSON).toHaveBeenCalledWith(item, expect.objectContaining({ position: snapshot.passages[0].position, tags: [{ name: 'Jadense AI/claim' }, { name: '核心论点' }] }))
})

it.each([true, false])('uses the per-extraction OCR choice (%s) instead of the global preference', async useOCR => {
  const { host, pdf } = fixture(!useOCR)
  vi.mocked(readOCRDocument).mockResolvedValue({ source: { itemID: 1, libraryID: 1, itemKey: 'PDF1', title: 'Paper' }, pages: [] })
  await readDocument(host, 1, new AbortController().signal, undefined, useOCR)
  expect(ensureLocalOCR).toHaveBeenCalledTimes(useOCR ? 1 : 0)
  expect(readOCRDocument).toHaveBeenCalledTimes(useOCR ? 1 : 0)
  expect(pdf.getPage).toHaveBeenCalledTimes(useOCR ? 0 : 1)
})
