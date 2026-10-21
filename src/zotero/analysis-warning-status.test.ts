/** 解析状态回归：真实后台运行时区分范围提示、待恢复任务与交付错误，冷启动保持同一语义。 */
import { expect, it, vi } from 'vitest'
import { AnalysisRuntime } from './analysis-runtime'
import { newAnalysisTask, type AnalysisTask } from './analysis-task-store'
import type { PaperAnalysisRunResult, runIndependentPaperAnalysis } from './paper-analysis-runner'

vi.mock('./research-context', () => ({ collectSourceForItem: vi.fn(async (_host, itemID) => ({
  kind: 'file', itemID, libraryID: 1, itemKey: `PDF${itemID}`, title: 'Synthetic paper',
})) }))
vi.mock('./document-jobs', () => ({ documentJobs: () => ({
  start: async () => { throw new Error('Optional references unavailable') }, pause: vi.fn(),
}) }))

const coverageWarning = '为控制解析长度，均匀选取 1200/4931 个可定位原句；结论仅基于这些原句。'
const optionalWarning = 'Unknown optional quality notice'
const host = { Prefs: { get: () => undefined } }

/** 合成结果不访问真实文库、Provider、账号和磁盘。 */
function completedResult(): PaperAnalysisRunResult {
  return {
    record: { id: 'synthetic-result', createdAt: '2026-10-20T17:50:29.000Z',
      source: { itemID: 42, libraryID: 1, itemKey: 'PDF00042', title: 'Synthetic paper', authors: [] },
      summary: 'Completed summary', notes: 'Completed notes', warnings: [] },
    coverage: 'Read all 48 pages; selected 1200 passages', historySaved: true,
    annotations: { created: 31, skipped: 0, failed: 0, unprocessed: 0, warnings: [] },
  }
}

/** 只替换运行时的外部服务；状态投影、完成处理与持久恢复都使用实际源码。 */
async function observe(result: PaperAnalysisRunResult, saveAllowed: (task: AnalysisTask) => boolean = () => true) {
  const saved = new Map<string, AnalysisTask>()
  const run = vi.fn<typeof runIndependentPaperAnalysis>(async input => {
    if (input.task) { input.task.stage = result.continuation ? 'annotations' : 'complete'; input.task.generation = 'complete' }
    return result
  })
  const runtime = new AnalysisRuntime(host, run, {
    context: async () => ({ account: 'synthetic-account', configuration: 'synthetic-model', route: 'jadense' }),
    retryDelay: 60_000,
    store: { list: async () => [...saved.values()], save: async task => {
      if (!saveAllowed(task)) return false
      saved.set(task.id, structuredClone(task)); return true
    } },
  })
  try {
    await runtime.start(42)
    expect(run).toHaveBeenCalledOnce()
    return { view: structuredClone(runtime.get(42)), records: structuredClone(runtime.records()), tasks: structuredClone([...saved.values()]) }
  } finally { await runtime.dispose() }
}

/** JSON 往返模拟检查点重载，完成任务不允许再次发起解析。 */
async function restoredView(tasks: AnalysisTask[]) {
  const records: AnalysisTask[] = JSON.parse(JSON.stringify(tasks))
  const run = vi.fn<typeof runIndependentPaperAnalysis>()
  const runtime = new AnalysisRuntime(host, run, { store: { list: async () => records, save: async () => true } })
  try {
    await runtime.ready
    await runtime.restore()
    expect(run).not.toHaveBeenCalled()
    return { view: structuredClone(runtime.get(42)), records: structuredClone(runtime.records()) }
  } finally { await runtime.dispose() }
}

it.each([[], [coverageWarning], [optionalWarning], [coverageWarning, optionalWarning]])('keeps completed analysis successful with optional notices %j', async (...warnings: string[]) => {
  const result = completedResult(); result.record.warnings = warnings
  const live = await observe(result)
  expect(live.view).toMatchObject({ busy: false, error: false, retrying: false, resumable: false })
  expect(live.records[0].warnings).toEqual(warnings)
  expect(live.records[0].summary).toBe('Completed summary')
  const restored = await restoredView(live.tasks)
  expect(restored.view).toMatchObject({ busy: false, error: false, retrying: false, resumable: false, message: live.view?.message })
  expect(restored.records[0].warnings).toEqual(warnings)
})

it('reports needs_action even when no warning text exists', async () => {
  const { view } = await observe({ ...completedResult(), continuation: 'needs_action' })
  expect(view).toMatchObject({ busy: false, error: true, retrying: false, resumable: true })
  expect(view?.message).not.toMatch(/解析完成|Analysis complete/)
})

it('keeps waiting resumable and retains the operational error message without presenting terminal failure', async () => {
  const { view } = await observe({ ...completedResult(), continuation: 'waiting', annotationError: 'Synthetic write awaiting recovery' })
  expect(view).toMatchObject({ busy: false, error: false, retrying: true, resumable: true, message: 'Synthetic write awaiting recovery' })
})

it.each(['history', 'annotation', 'failed', 'unprocessed'] as const)('retains actual %s delivery failures across reload', async kind => {
  const result = completedResult()
  if (kind === 'history') { result.historySaved = false; result.historyError = 'Synthetic history failure' }
  if (kind === 'annotation') result.annotationError = 'Synthetic annotation failure'
  if (kind === 'failed') result.annotations.failed = 1
  if (kind === 'unprocessed') result.annotations.unprocessed = 1
  const live = await observe(result)
  expect(live.view).toMatchObject({ busy: false, error: true, retrying: false })
  expect(live.view?.message).not.toMatch(/解析完成|Analysis complete/)
  if (kind === 'history') expect(live.view?.message).toBe(result.historyError)
  if (kind === 'annotation') expect(live.view?.message).toBe(result.annotationError)
  const restored = await restoredView(live.tasks)
  expect(restored.view).toMatchObject({ busy: false, error: true, retrying: false, message: live.view?.message })
  expect(restored.records[0].notes).toBe('Completed notes')
})

it.each([null, 42, { future: true }, ['additive']])('ignores non-string optional deliveryError %j in a completed checkpoint', async deliveryError => {
  const task = Object.assign(newAnalysisTask(42), { status: 'complete', stage: 'complete', generation: 'complete', record: completedResult().record, deliveryError }) as AnalysisTask
  const restored = await restoredView([task])
  expect(restored.view).toMatchObject({ busy: false, error: false, retrying: false, resumable: false })
})

it('does not claim success when saving the terminal checkpoint fails', async () => {
  const { view, records } = await observe(completedResult(), task => task.status !== 'complete')
  expect(view).toMatchObject({ busy: false, error: false, retrying: true, resumable: true })
  expect(view?.message).not.toMatch(/解析完成|Analysis complete/)
  expect(view?.message).toMatch(/保存|sav|checkpoint/i)
  expect(records[0].summary).toBe('Completed summary')
})
