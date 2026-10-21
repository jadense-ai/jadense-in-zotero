/** 后台运行合同：按附件去重、停止与迟到读取隔离、保留未落盘结果。 */
import { expect, it, vi } from 'vitest'
import { AnalysisRuntime } from './analysis-runtime'
import { collectSourceForItem } from './research-context'
import type { runIndependentPaperAnalysis } from './paper-analysis-runner'
import type { AnalysisTask } from './analysis-task-store'
function options() {
  const tasks = new Map<string, AnalysisTask>()
  return { store: { list: async () => [...tasks.values()], save: async (task: AnalysisTask) => { tasks.set(task.id, structuredClone(task)); return true } },
    context: async () => ({ account: 'synthetic-account', configuration: 'synthetic-model', route: 'jadense' as const }) }
}
vi.mock('./research-context', () => ({ collectSourceForItem: vi.fn(async (_host, itemID) => ({ kind: 'file', itemID, libraryID: 1, itemKey: `PDF${itemID}`, title: 'Paper' })) }))
vi.mock('./document-jobs', () => ({ documentJobs: () => ({ start: async () => { throw new Error('Optional OCR unavailable') }, pause: vi.fn() }) }))
const result = (id: number) => ({ record: { id: `r${id}`, createdAt: new Date().toISOString(), source: { itemID: id, libraryID: 1, itemKey: `PDF${id}`, title: 'Paper', authors: [] }, summary: 'Retained summary', notes: 'Complete notes' }, historySaved: false, coverage: '', annotations: { created: 0, skipped: 0, failed: 0, unprocessed: 0 } })
it('starts analysis without a feature warning', async () => {
  const confirm = vi.fn(() => false)
  const host = { Prefs: { get: () => undefined }, getMainWindow: () => ({ confirm, fetch }) } as never
  const run = vi.fn<typeof runIndependentPaperAnalysis>(async input => result(input.itemID))
  const runtime = new AnalysisRuntime(host, run, options())
  await runtime.start(1)
  expect(confirm).not.toHaveBeenCalled()
  expect(run).toHaveBeenCalledOnce()
  runtime.dispose()
})
it('deduplicates one PDF, isolates another, and retains results despite optional failures', async () => {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const run = vi.fn<typeof runIndependentPaperAnalysis>(async input => { input.onProgress?.('Generating'); await gate; return result(input.itemID) })
  const runtime = new AnalysisRuntime({ Prefs: { get: () => true } }, run, options()), changed = vi.fn()
  const unsubscribe = runtime.subscribe(changed)
  const first = runtime.start(1)
  await runtime.start(1)
  const other = runtime.start(2)
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  expect(runtime.get(1)?.busy).toBe(true)
  expect(runtime.get(2)?.source.itemID).toBe(2)
  finish(); await Promise.all([first, other])
  expect(runtime.records()).toHaveLength(2)
  expect(runtime.unsaved('r1')).toBe(false) // 历史偏好失败时独立任务检查点仍已持久保存。
  expect(runtime.get(1)?.busy).toBe(false)
  unsubscribe(); runtime.dispose()
})
it('stops an unresponsive source read and never dispatches its late result', async () => {
  let finish!: (value: never) => void
  vi.mocked(collectSourceForItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const run = vi.fn<typeof runIndependentPaperAnalysis>()
  const runtime = new AnalysisRuntime({ Prefs: { get: () => true } }, run, options())
  const pending = runtime.start(1)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  runtime.stop(1); await pending
  expect(runtime.get(1)?.busy).toBe(false)
  finish(undefined as never); await Promise.resolve()
  expect(run).not.toHaveBeenCalled()
  runtime.dispose()
})
it('terminates a stalled preparation with a visible error instead of spinning forever', async () => {
  vi.useFakeTimers()
  try {
    vi.mocked(collectSourceForItem).mockImplementationOnce(() => new Promise(() => {}))
    const run = vi.fn<typeof runIndependentPaperAnalysis>()
    const runtime = new AnalysisRuntime({ Prefs: { get: () => true } }, run, options())
    void runtime.start(1)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(runtime.get(1)).toMatchObject({ busy: false, error: false, retrying: true, resumable: true })
    expect(runtime.get(1)?.message).toMatch(/自动继续|timed out/)
    expect(run).not.toHaveBeenCalled()
    runtime.dispose()
  } finally { vi.useRealTimers() }
})
it('retains a failed final history update and exposes provider failure without throwing into reader UI', async () => {
  const runtime = new AnalysisRuntime({ Prefs: { get: () => true } }, async input => ({ ...result(input.itemID), historySaved: true, historyError: 'Final update failed' }), options())
  await runtime.start(1)
  expect(runtime.get(1)?.error).toBe(true)
  expect(runtime.records()[0].notes).toBe('Complete notes')
  const failing = new AnalysisRuntime({ Prefs: { get: () => true } }, async () => { throw new Error('Provider failed') }, options())
  await failing.start(1)
  expect(failing.get(1)).toMatchObject({ busy: false, error: true, resumable: true })
  expect(failing.get(1)?.message).toContain('ANALYSIS_FAILED')
  runtime.dispose(); failing.dispose()
})

it('classifies network errors from another Gecko realm as resumable', async () => {
  const runtime = new AnalysisRuntime({ Prefs: { get: () => true } }, async () => { throw { name: 'TypeError', message: 'Synthetic other-realm fetch failure' } }, options())
  await runtime.start(1)
  expect(runtime.get(1)).toMatchObject({ busy: false, error: false, retrying: true, resumable: true })
  await runtime.dispose()
})

it('preserves shutdown intent while waiting for checkpoints to load', async () => {
  let finish!: (tasks: AnalysisTask[]) => void
  const saved: AnalysisTask[] = []
  const run = vi.fn<typeof runIndependentPaperAnalysis>()
  const runtime = new AnalysisRuntime({ Prefs: { get: () => true } }, run, {
    ...options(), store: { list: () => new Promise(resolve => { finish = resolve }), save: async task => { saved.push(structuredClone(task)); return true } },
  })
  const pending = runtime.start(1), disposing = runtime.dispose()
  finish([])
  await Promise.all([pending, disposing])
  expect(saved.at(-1)).toMatchObject({ status: 'waiting', pauseReason: 'shutdown' })
  expect(run).not.toHaveBeenCalled()
})

it('persists retry timing so a cold runtime does not dispatch before backoff expires', async () => {
  vi.useFakeTimers()
  const persistent = options(), failing = vi.fn<typeof runIndependentPaperAnalysis>(async () => { throw { name: 'TypeError' } })
  const first = new AnalysisRuntime({ Prefs: { get: () => true } }, failing, { ...persistent, retryDelay: 60_000 })
  let next: AnalysisRuntime | undefined
  try {
    await first.start(1)
    const saved = await persistent.store.list()
    expect(saved[0]).toMatchObject({ status: 'waiting', retries: 1, retryAt: Date.now() + 60_000 })
    await first.dispose()
    const resumed = vi.fn<typeof runIndependentPaperAnalysis>(async input => result(input.itemID))
    next = new AnalysisRuntime({ Prefs: { get: () => true } }, resumed, persistent)
    await next.restore()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(resumed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(resumed).toHaveBeenCalledOnce()
  } finally { await first.dispose(); await next?.dispose(); vi.useRealTimers() }
})
