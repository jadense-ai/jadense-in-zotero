/** PDF 翻译边界回归：排队取消、页内同步和可扩展进程消息。 */
import { describe, it, expect } from 'vitest'
import { PDFTaskQueue } from './pdf-translation-jobs'
import { normalizedPDFState } from './pdf-translation-reader'
import { parsePDFMessage, readPDFMessages } from './pdf-translation-runtime'

describe('PDF translation boundaries', () => {
  it('handles fragmented Unicode JSON, additional fields and Gecko empty-string EOF', async () => {
    const chunks = ['log\n{"type":"pro', 'gress","stage":"排版"}\n{"type":"complete"}', '']
    const messages = []
    for await (const message of readPDFMessages({ readString: async () => chunks.shift() ?? null })) messages.push(message)
    expect(messages).toEqual([{ type: 'progress', stage: '排版' }, { type: 'complete' }])
    expect(chunks).toHaveLength(0)
  })
  it('runs one task at a time and never starts a cancelled queued task', async () => {
    const queue = new PDFTaskQueue(), controller = new AbortController(), order: number[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = queue.enqueue(new AbortController().signal, async () => { order.push(1); await gate; order.push(2) })
    const skipped = queue.enqueue(controller.signal, async () => { order.push(9) }).catch(error => error.name)
    const last = queue.enqueue(new AbortController().signal, async () => { order.push(3) })
    controller.abort(); release(); await first; expect(await skipped).toBe('AbortError'); await last
    expect(order).toEqual([1, 2, 3])
  })
  it('continues after a failed worker', async () => {
    const queue = new PDFTaskQueue(), signal = new AbortController().signal
    await expect(queue.enqueue(signal, async () => { throw new Error('worker exited') })).rejects.toThrow('worker exited')
    await expect(queue.enqueue(signal, async () => 42)).resolves.toBe(42)
  })
  it('accepts additional message fields and ignores unstructured logs', () => {
    expect(parsePDFMessage('{"type":"progress","percent":24,"future":true}')).toMatchObject({ percent: 24 })
    expect(parsePDFMessage('loading model')).toBeNull()
    expect(parsePDFMessage('JADENSE_PDF_PROGRESS {"stage":"dependencies","future":true}')).toEqual({ type: 'progress', stage: 'dependencies', future: true })
  })
  it('counts ordinary installer output as activity without treating it as protocol', async () => {
    const chunks = ['Downloading Python\r', 'Downloaded 100 MB\n', ''], messages = []
    let activity = 0
    for await (const message of readPDFMessages({ readString: async () => chunks.shift() ?? null }, () => { activity++ })) messages.push(message)
    expect(activity).toBe(2); expect(messages).toEqual([])
  })
  it('keeps relative position independent of panel height and normalizes invalid geometry', () => {
    expect(normalizedPDFState({ page: 4, fraction: .4, scale: 1.5, rotation: -90 })).toEqual({ page: 4, fraction: .4, scale: 1.5, rotation: 270 })
    expect(normalizedPDFState({ page: -1, fraction: 8, scale: NaN, rotation: 450 })).toEqual({ page: 1, fraction: 1, scale: 1, rotation: 90 })
  })
})
