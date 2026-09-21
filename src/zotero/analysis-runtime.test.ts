/** 后台运行合同：按附件去重、停止与迟到读取隔离、保留未落盘结果。 */
import { expect, it, vi } from 'vitest'
import { AnalysisRuntime, ANALYSIS_WARNING_PREF } from './analysis-runtime'
import { collectSourceForItem } from './research-context'
import type { runIndependentPaperAnalysis } from './paper-analysis-runner'
vi.mock('./research-context', () => ({ collectSourceForItem: vi.fn(async (_host, itemID) => ({ kind: 'file', itemID, libraryID: 1, itemKey: `PDF${itemID}`, title: 'Paper' })) }))
vi.mock('./document-jobs', () => ({ documentJobs: () => ({ start: async () => { throw new Error('Optional OCR unavailable') }, pause: vi.fn() }) }))
const result = (id: number) => ({ record: { id: `r${id}`, createdAt: new Date().toISOString(), source: { itemID: id, libraryID: 1, itemKey: `PDF${id}`, title: 'Paper', authors: [] }, summary: 'Retained summary', notes: 'Complete notes' }, historySaved: false, coverage: '', annotations: { created: 0, skipped: 0, failed: 0, unprocessed: 0 } })
it('warns before any work, allows cancellation, and persists acceptance across runtimes', async () => {
  const prefs = new Map(), confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
  const host = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) }, getMainWindow: () => ({ confirm, fetch }) } as never
  const run = vi.fn<typeof runIndependentPaperAnalysis>(async input => result(input.itemID))
  const runtime = new AnalysisRuntime(host, run)
  await runtime.start(1); expect(run).not.toHaveBeenCalled(); expect(runtime.list()).toEqual([])
  await runtime.start(1); expect(run).toHaveBeenCalledOnce(); expect(prefs.get(ANALYSIS_WARNING_PREF)).toBe(true)
  const reopened = new AnalysisRuntime(host, run)
  await reopened.start(2); expect(confirm).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledTimes(2)
  runtime.dispose(); reopened.dispose()
})
it('deduplicates one PDF, isolates another, and retains results despite optional failures', async () => {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const run = vi.fn<typeof runIndependentPaperAnalysis>(async input => { input.onProgress?.('Generating'); await gate; return result(input.itemID) })
  const runtime = new AnalysisRuntime({ Prefs: { get: () => true } }, run), changed = vi.fn()
  const unsubscribe = runtime.subscribe(changed)
  const first = runtime.start(1)
  await runtime.start(1)
  const other = runtime.start(2)
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  expect(runtime.get(1)?.busy).toBe(true)
  expect(runtime.get(2)?.source.itemID).toBe(2)
  finish(); await Promise.all([first, other])
  expect(runtime.records()).toHaveLength(2)
  expect(runtime.unsaved('r1')).toBe(true)
  expect(runtime.get(1)?.busy).toBe(false)
  unsubscribe(); runtime.dispose()
})
it('stops an unresponsive source read and never dispatches its late result', async () => {
  let finish!: (value: never) => void
  vi.mocked(collectSourceForItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const run = vi.fn<typeof runIndependentPaperAnalysis>()
  const runtime = new AnalysisRuntime({ Prefs: { get: () => true } }, run)
  const pending = runtime.start(1)
  runtime.stop(1); await pending
  expect(runtime.get(1)?.busy).toBe(false)
  finish(undefined as never); await Promise.resolve()
  expect(run).not.toHaveBeenCalled()
  runtime.dispose()
})
it('retains a failed final history update and exposes provider failure without throwing into reader UI', async () => {
  const runtime = new AnalysisRuntime({ Prefs: { get: () => true } }, async input => ({ ...result(input.itemID), historySaved: true, historyError: 'Final update failed' }))
  await runtime.start(1)
  expect(runtime.get(1)?.error).toBe(true)
  expect(runtime.records()[0].notes).toBe('Complete notes')
  const failing = new AnalysisRuntime({ Prefs: { get: () => true } }, async () => { throw new Error('Provider failed') })
  await failing.start(1)
  expect(failing.get(1)).toMatchObject({ busy: false, error: true, message: 'Provider failed' })
  runtime.dispose(); failing.dispose()
})
