/** 汇总属于已有完整分段上的增强；局部容量、字段和执行问题不能抹去已完成成果。 */
import { describe, expect, it, vi } from 'vitest'
import { runIndependentPaperAnalysis } from './paper-analysis-runner'
import { newAnalysisTask } from './analysis-task-store'
import { RequestExecutionError } from '@/chat/request-feedback'
import type { PdfAnalysisSnapshot } from './reader-tools'
import type { AnalysisInputPlan } from './analysis-input'
import { attachAnalysisCandidates } from './analysis-summary'
import { parsePaperAnalysis } from '@/chat/paper-analysis'

function fixture() {
  const selection = { route: 'byok', modelId: 'm' }
  const prefs = new Map<string, unknown>([
    ['extensions.jadenseInZotero.aiModelSettings', JSON.stringify({ version: 1, followChatModel: false, models: { chat: selection, translation: selection, analysis: selection, figure: selection } })],
    ['extensions.jadenseInZotero.byokConfig', JSON.stringify({ version: 2, providers: [{ id: 'p', protocol: 'openai', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic' }], models: [{ id: 'm', providerId: 'p', model: 'synthetic', contextWindow: 8192 }] })],
  ])
  const host = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => { prefs.set(key, value) } } }
  const snapshot: PdfAnalysisSnapshot = { itemID: 42, libraryID: 1, itemKey: 'SYNTHETIC', title: 'Synthetic', metadata: { title: 'Synthetic', authors: [] },
    passages: [0, 1].map(i => ({ id: `p${i}`, text: `Source evidence ${i}`, pageIndex: i, pageLabel: String(i + 1), position: { pageIndex: i, rects: [[0, 0, 20, 20]] }, sortIndex: String(i) })),
    coverage: { pagesRead: 2, totalPages: 2, limited: false, pageNumbers: [1, 2], warnings: [] } }
  const batch = (i: number) => JSON.stringify({ summary: `Source finding ${i}`, sections: [{ category: 'evidence', summary: `Independent evidence ${i}` }], annotations: [{ passageId: `p${i}`, category: 'evidence', comment: `Evidence note ${i}` }] })
  const task = newAnalysisTask(42)
  task.snapshot = snapshot
  task.inputPlan = { version: 2, inputTokens: 5000, outputTokens: 2048, prompts: ['source batch 0', 'source batch 1'], results: [], level: 0 }
  const send = vi.fn(async input => input.messages[0].text.startsWith('Combine ALL') ? '{"summary":"Combined analysis","sections":[],"annotations":[]}' : batch(task.inputPlan!.results.length))
  const saveAnnotations = vi.fn(async (_host, _snapshot, annotations) => ({ created: annotations.length, skipped: 0, failed: 0, unprocessed: 0, warnings: [] }))
  const run = (signal = new AbortController().signal) => runIndependentPaperAnalysis({ zotero: host, itemID: 42, fetchImpl: vi.fn(), signal, task, checkpoint: async () => true,
    services: { readPdf: async () => snapshot, validateSource: async () => {}, send, saveAnnotations } })
  return { host, snapshot, batch, task, send, saveAnnotations, run }
}

describe('local summary recovery', () => {
  it('delivers every complete source batch when summary capacity cannot reduce the groups', async () => {
    const f = fixture()
    f.task.inputPlan!.inputTokens = 64
    const result = await f.run()
    expect(result.continuation).toBeUndefined()
    expect(result.record.warnings).toEqual([])
    expect(result.record.notes).toContain('Source finding 0')
    expect(result.record.notes).toContain('Source finding 1')
    expect(result.record.notes).toContain('Independent evidence 0')
    expect(result.record.notes).toContain('Independent evidence 1')
    expect(result.annotations.created).toBe(2)
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.task).toMatchObject({ generation: 'complete', stage: 'complete' })
    expect(f.task.inputPlan?.incomplete).toBeUndefined()
    // 冷启动只补本地交付，不重新收费生成，完整分段仍可读。
    f.task.inputPlan = JSON.parse(JSON.stringify(f.task.inputPlan)) as AnalysisInputPlan
    const restored = await f.run()
    expect(restored.record.notes).toContain('Independent evidence 1')
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it.each(['missing-summary', 'invalid-json', 'partial', 'unknown'] as const)('contains a %s summary without retrying source generation or losing annotations', async failure => {
    const f = fixture()
    f.send.mockImplementation(async input => {
      if (!input.messages[0].text.startsWith('Combine ALL')) return f.batch(f.task.inputPlan!.results.length)
      if (failure === 'missing-summary') return '{"summary":"","sections":[{"category":"claim","summary":"Usable combined observation"}],"annotations":[]}'
      if (failure === 'invalid-json') return 'Readable summary without JSON fields'
      if (failure === 'partial') throw new RequestExecutionError('Synthetic summary interrupted', 'partial', '{"summary":"Partial combined text"}')
      throw new TypeError('Synthetic summary connection lost')
    })
    const result = await f.run()
    expect(result.continuation).toBeUndefined()
    expect(result.record.warnings).toEqual([])
    expect(result.record.notes).toContain('Source finding 0')
    expect(result.record.notes).toContain('Independent evidence 1')
    expect(result.annotations.created).toBe(2)
    expect(f.send).toHaveBeenCalledTimes(3)
    expect(f.task).toMatchObject({ generation: 'complete', stage: 'complete' })
    expect(f.task.repair).toBeUndefined()
    if (failure === 'unknown') expect(f.task.inputPlan).toMatchObject({ summaryExecution: { state: 'unknown', requestID: f.task.requestID } })
  })

  it('does not convert a real source interruption into a complete task', async () => {
    const f = fixture()
    f.send.mockRejectedValue(new RequestExecutionError('Synthetic source interrupted', 'partial', f.batch(0)))
    const result = await f.run()
    expect(result.continuation).toBe('waiting')
    expect(f.saveAnnotations).not.toHaveBeenCalled()
    expect(f.task.generation).not.toBe('complete')
  })

  it('respects an explicit stop during summary generation', async () => {
    const f = fixture(), controller = new AbortController()
    f.send.mockImplementation(async input => {
      if (!input.messages[0].text.startsWith('Combine ALL')) return f.batch(f.task.inputPlan!.results.length)
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
    const stopped = await f.run(controller.signal)
    expect(f.saveAnnotations).not.toHaveBeenCalled()
    expect(stopped.record.notes).toContain('Independent evidence 1')
    expect(stopped.record.warnings?.join(' ')).toContain('已停止')
    expect(f.task.generation).not.toBe('complete')
  })

  it('finishes a saved legacy non-converging task locally when a combined prompt still cannot fit', async () => {
    const f = fixture()
    f.task.inputPlan = { version: 1, inputTokens: 64, outputTokens: 2048, prompts: ['a', 'b'], results: [f.batch(0), f.batch(1)], level: 0, incomplete: true }
    f.task.generation = 'terminal'; f.task.response = f.batch(0); f.task.resumeRequested = true
    const result = await f.run()
    expect(result.continuation).toBeUndefined()
    expect(result.record.warnings).toEqual([])
    expect(result.annotations.created).toBe(2)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('keeps harmless additive summary fields outside the completion decision', async () => {
    const f = fixture()
    f.send.mockImplementation(async input => input.messages[0].text.startsWith('Combine ALL')
      ? JSON.stringify({ summary: 'Combined analysis', sections: [], annotations: [], futureMetadata: { quality: 'unknown' } })
      : f.batch(f.task.inputPlan!.results.length))
    const result = await f.run()
    expect(result.record.summary).toBe('Combined analysis')
    expect(result.record.warnings).toEqual([])
    expect(result.continuation).toBeUndefined()
    expect(result.annotations.created).toBe(2)
  })

  it('recovers legacy in-flight summary sources from frozen prompts without replaying source requests', async () => {
    const f = fixture()
    f.task.inputPlan = { version: 1, inputTokens: 5000, outputTokens: 2048, prompts: [`Combine ALL supplied notes\n${JSON.stringify([f.batch(0), f.batch(1)])}`], results: [], level: 1 }
    f.task.generation = 'pending'
    f.send.mockRejectedValue(new TypeError('Legacy summary connection lost'))
    const result = await f.run()
    expect(f.send).toHaveBeenCalledOnce()
    expect(result.record.notes).toContain('Independent evidence 1')
    expect(result.annotations.created).toBe(2)
    expect(result.continuation).toBeUndefined()
  })

  it.each(['sections', 'annotations'] as const)('fills a missing display summary from complete %s without another AI request', async field => {
    const f = fixture()
    f.task.inputPlan!.prompts = ['single source']
    f.send.mockResolvedValue(field === 'sections'
      ? '{"sections":[{"category":"claim","summary":"Existing source finding"}],"annotations":[]}'
      : '{"summary":"","sections":[],"annotations":[{"passageId":"p0","category":"evidence","comment":"Existing source finding"}]}')
    const result = await f.run()
    expect(result.record.summary).toBe('Existing source finding')
    expect(result.record.warnings).toEqual([])
    expect(result.continuation).toBeUndefined()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.task.repair).toBeUndefined()
  })

  it('validates every retained annotation independently of the combined model-response size limit', () => {
    const f = fixture()
    const passages = Array.from({ length: 512 }, (_, i) => ({ id: `p${i}`, text: 'Synthetic source text '.repeat(100), pageIndex: i }))
    const candidates = passages.map(row => ({ passageId: row.id, category: 'evidence' as const, comment: '证'.repeat(800), ignoredPosition: { pageIndex: 999999 } }))
    expect(JSON.stringify({ annotations: candidates }).length).toBeGreaterThan(256000)
    const plan: AnalysisInputPlan = { ...f.task.inputPlan!, annotationCandidates: [...candidates, { passageId: 'unknown', category: 'evidence', comment: 'Cannot invent a source' }] }
    const result = attachAnalysisCandidates(parsePaperAnalysis('{"summary":"All evidence","annotations":[]}', passages), plan, passages)
    expect(result.annotations).toHaveLength(512)
    expect(result.annotations.at(-1)).toMatchObject({ passageId: 'p511', pageIndex: 511 })
    expect(result.warnings).toEqual([])
  })
})
