/** 真实解析入口的模型预算、全文覆盖及检查点恢复，生成只使用合成响应。 */
import { describe, expect, it, vi } from 'vitest'
import { runIndependentPaperAnalysis } from './paper-analysis-runner'
import { newAnalysisTask } from './analysis-task-store'
import { textTokenCost } from './model-budget'
import { responseFormatInstructions } from '@/chat/response-format'
import type { PdfAnalysisSnapshot } from './reader-tools'
import type { ZoteroLike } from './runtime'
import { ANALYSIS_ANNOTATION_SUGGESTION_PREF } from './analysis-settings'
import { LEGACY_PAPER_ANALYSIS_RESPONSE_FORMAT } from '@/chat/paper-analysis'
import { planAnalysisInput } from './analysis-input'
import { RequestExecutionError } from '@/chat/request-feedback'

function fixture(context: number) {
  const selection = { route: 'byok', modelId: 'm' }
  const prefs = new Map<string, unknown>([
    ['extensions.jadenseInZotero.aiModelSettings', JSON.stringify({ version: 1, followChatModel: false, models: { chat: selection, translation: selection, analysis: selection, figure: selection } })],
    ['extensions.jadenseInZotero.byokConfig', JSON.stringify({ version: 2, providers: [{ id: 'p', protocol: 'openai', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic' }], models: [{ id: 'm', providerId: 'p', model: 'synthetic', contextWindow: context, maxOutputTokens: 96000 }] })],
  ])
  const host = { Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) } } as unknown as ZoteroLike
  const snapshot: PdfAnalysisSnapshot = { itemID: 42, libraryID: 1, itemKey: 'SYNTHETIC', title: 'Synthetic', metadata: { title: 'Synthetic', authors: [] },
    passages: Array.from({ length: 192 }, (_, i) => ({ id: `p${i}-s0`, text: `PAGE-${i + 1} unique evidence. ` + 'Long paper passage. '.repeat(30), pageIndex: i, pageLabel: String(i + 1), position: { pageIndex: i, rects: [[0, 0, 20, 20]] }, sortIndex: String(i).padStart(5, '0') })),
    coverage: { pagesRead: 192, totalPages: 192, limited: false, pageNumbers: Array.from({ length: 192 }, (_, i) => i + 1), warnings: [] } }
  return { host, snapshot }
}

describe('model-aware independent analysis', () => {
  it.each([8192, 1048576])('covers every source passage within a %i-token model and writes only after aggregation', async context => {
    const { host, snapshot } = fixture(context), seen = new Set<string>()
    const saveAnnotations = vi.fn(async () => ({ created: 1, skipped: 0, failed: 0, unprocessed: 0, warnings: [] }))
    const send = vi.fn(async input => {
      const prompt = input.messages[0].text as string
      const estimate = textTokenCost(JSON.stringify(input.messages)) + textTokenCost(responseFormatInstructions(input.responseFormat))
      expect(estimate + input.maxOutputTokens + Math.max(256, Math.ceil(context * .02))).toBeLessThan(context)
      for (const match of prompt.matchAll(/"id":"(p\d+-s0)"/g)) seen.add(match[1])
      expect(saveAnnotations).not.toHaveBeenCalled()
      return JSON.stringify({ summary: 'Combined evidence', sections: [], annotations: [{ passageId: 'p0-s0', category: 'claim', comment: 'Supported observation' }] })
    })
    await runIndependentPaperAnalysis({ zotero: host, itemID: 42, fetchImpl: vi.fn(), signal: new AbortController().signal,
      services: { readPdf: async () => snapshot, send, saveAnnotations, validateSource: async () => {} } })
    expect(seen.size).toBe(192)
    expect(saveAnnotations).toHaveBeenCalledOnce()
    if (context === 8192) expect(send.mock.calls.length).toBeGreaterThan(2)
    else expect(send).toHaveBeenCalledOnce()
  })
  it('resumes after a local checkpoint failure without regenerating completed input batches', async () => {
    const { host, snapshot } = fixture(8192), task = newAnalysisTask(42), prompts: string[] = []
    host.Prefs!.set(ANALYSIS_ANNOTATION_SUGGESTION_PREF, '5', true)
    const readPdf = vi.fn(async () => snapshot)
    const send = vi.fn(async input => { prompts.push(input.messages[0].text); return '{"summary":"Evidence retained","sections":[],"annotations":[]}' })
    let rejectCheckpoint = true
    const options = { zotero: host, itemID: 42, fetchImpl: vi.fn(), signal: new AbortController().signal, task,
      checkpoint: async () => !(rejectCheckpoint && task.inputPlan?.results.length === 1 && task.generation === 'new'),
      services: { readPdf, send, validateSource: async () => {} } }
    await expect(runIndependentPaperAnalysis(options)).rejects.toMatchObject({ code: 'ANALYSIS_STORAGE' })
    task.inputPlan = JSON.parse(JSON.stringify(task.inputPlan))
    host.Prefs!.set(ANALYSIS_ANNOTATION_SUGGESTION_PREF, '80', true)
    rejectCheckpoint = false
    await runIndependentPaperAnalysis(options)
    expect(prompts.filter(value => value === prompts[0])).toHaveLength(1)
    expect(readPdf).toHaveBeenCalledOnce()
    expect(task.generation).toBe('complete')
    expect(task.inputPlan?.suggestedMaxAnnotations).toBe(5)
    expect(prompts.every(prompt => prompt.includes('最大建议数为 5 条') && !prompt.includes('最大建议数为 80 条'))).toBe(true)
  })

  it('keeps over 32 distinct annotations through real batch planning, aggregation and delivery without fault status', async () => {
    const { host, snapshot } = fixture(8192), task = newAnalysisTask(42)
    host.Prefs!.set(ANALYSIS_ANNOTATION_SUGGESTION_PREF, '12', true)
    let combined = false
    const send = vi.fn(async input => {
      const prompt = input.messages[0].text as string
      expect(prompt).not.toContain('at most 32')
      expect(prompt).not.toContain('至多 32')
      expect(prompt).toContain('最大建议数为 12 条')
      const material = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
      const annotations = Array.isArray(material)
        ? (combined = true, [])
        : material.passages.map((row: { id: string }) => ({ passageId: row.id, category: 'evidence', comment: `Evidence for ${row.id}` }))
      return JSON.stringify({ summary: 'All independent evidence', sections: [], annotations })
    })
    const saveAnnotations = vi.fn(async (_host, _snapshot, annotations) => ({ created: annotations.length, skipped: 0, failed: 0, unprocessed: 0, warnings: [] }))
    const result = await runIndependentPaperAnalysis({ zotero: host, itemID: 42, fetchImpl: vi.fn(), signal: new AbortController().signal, task, checkpoint: async () => true,
      services: { readPdf: async () => snapshot, send, saveAnnotations, validateSource: async () => {} } })
    expect(combined).toBe(true)
    expect(result.record.warnings).toEqual([])
    expect(saveAnnotations.mock.calls[0][2]).toHaveLength(192)
    expect(result.annotations.created).toBe(192)
    expect(result.continuation).toBeUndefined()
    expect(task.generation).toBe('complete')
    expect(task.stage).toBe('complete')
  })

  it('locally recovers an interrupted summary and delivers all completed source notes and annotations', async () => {
    const { host, snapshot } = fixture(8192), task = newAnalysisTask(42)
    const send = vi.fn(async input => {
      const prompt = input.messages[0].text as string, material = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
      if (Array.isArray(material)) throw new RequestExecutionError('Synthetic summary interrupted', 'partial', '{"summary":"Partial combined summary","annotations":[]}')
      return JSON.stringify({ summary: 'Batch evidence', annotations: material.passages.map((row: { id: string }) => ({ passageId: row.id, category: 'evidence', comment: `Unique evidence ${row.id}` })) })
    })
    const saveAnnotations = vi.fn(async (_host, _snapshot, annotations) => ({ created: annotations.length, skipped: 0, failed: 0, unprocessed: 0, warnings: [] }))
    const result = await runIndependentPaperAnalysis({ zotero: host, itemID: 42, fetchImpl: vi.fn(), signal: new AbortController().signal, task, checkpoint: async () => true,
      services: { readPdf: async () => snapshot, send, saveAnnotations, validateSource: async () => {} } })
    expect(saveAnnotations).toHaveBeenCalledOnce()
    expect(result.record.notes).toContain('关键句与批注（192 条）')
    expect(task.inputPlan?.annotationCandidates).toHaveLength(192)
    expect(task.inputPlan?.annotationCandidates?.at(-1)?.comment).toBe('Unique evidence p191-s0')
    expect(result.record.warnings).toEqual([])
    expect(result.continuation).toBeUndefined()
    expect(result.annotations.created).toBe(192)
    expect(task.generation).toBe('complete')
    expect(task.inputPlan?.summaryExecution?.state).toBe('partial')
  })

  it('preserves an already dispatched legacy batch prompt and response schema on resume', async () => {
    const { host, snapshot } = fixture(1048576), task = newAnalysisTask(42)
    task.snapshot = snapshot; task.generation = 'pending'
    task.inputPlan = { ...planAnalysisInput(snapshot, 1000000, 1000), version: 1, prompts: ['Frozen legacy prompt'] }
    // 使用攻玉路径观察实际传给请求层的 schema；所有网络仍是合成服务。
    host.Prefs!.set('extensions.jadenseInZotero.aiModelSettings', JSON.stringify({ version: 1, followChatModel: false, models: { analysis: { route: 'jadense', selection: { kind: 'default' } } } }), true)
    host.Prefs!.set('extensions.jadenseInZotero.token', 'synthetic-token', true)
    const send = vi.fn(async input => {
      expect(input.messages[0].text).toBe('Frozen legacy prompt')
      expect(input.responseFormat).toEqual(LEGACY_PAPER_ANALYSIS_RESPONSE_FORMAT)
      return '{"summary":"Legacy result","annotations":[]}'
    })
    await runIndependentPaperAnalysis({ zotero: host, itemID: 42, fetchImpl: vi.fn(), signal: new AbortController().signal, task,
      services: { send, validateSource: async () => {} } })
    expect(send).toHaveBeenCalledOnce()
  })

  it('continues an old non-converging aggregate with all saved batch annotations and a fresh summary identity', async () => {
    const { host, snapshot } = fixture(8192), task = newAnalysisTask(42), oldRequestID = task.requestID
    const batch = (start: number, end: number) => JSON.stringify({ summary: `Saved batch ${start}`, sections: [], annotations: snapshot.passages.slice(start, end).map(row => ({ passageId: row.id, category: 'evidence', comment: 'Important independent evidence '.repeat(10) })) })
    task.snapshot = snapshot; task.generation = 'terminal'; task.resumeRequested = true
    task.inputPlan = { version: 1, inputTokens: 5000, outputTokens: 2000, prompts: ['Old batch 1', 'Old batch 2'], results: [batch(0, 96), batch(96, 192)], level: 0, incomplete: true }
    task.response = batch(0, 32)
    const send = vi.fn(async input => {
      expect(input.clientRequestId).not.toBe(oldRequestID)
      expect(input.previousRequestId).toBe(oldRequestID)
      expect(input.messages[0].text).toContain('Saved batch 96')
      expect(input.messages[0].text).not.toContain('Important independent evidence')
      return '{"summary":"Recovered combined analysis","sections":[],"annotations":[]}'
    })
    const saveAnnotations = vi.fn(async (_host, _snapshot, annotations) => ({ created: annotations.length, skipped: 0, failed: 0, unprocessed: 0, warnings: [] }))
    const result = await runIndependentPaperAnalysis({ zotero: host, itemID: 42, fetchImpl: vi.fn(), signal: new AbortController().signal, task, checkpoint: async () => true,
      services: { readPdf: vi.fn(() => { throw new Error('Do not reread the PDF') }), send, saveAnnotations, validateSource: async () => {} } })
    expect(send).toHaveBeenCalledOnce()
    expect(result.annotations.created).toBe(192)
    expect(result.record.warnings).toEqual([])
    expect(result.continuation).toBeUndefined()
    expect(task.stage).toBe('complete')
  })

  it('restores separately retained annotations from a serialized checkpoint without regenerating source batches', async () => {
    const { host, snapshot } = fixture(8192), task = newAnalysisTask(42)
    let failCheckpoint = true, summaryRequests = 0, sourceRequests = 0
    const send = vi.fn(async input => {
      const prompt = input.messages[0].text as string, material = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
      if (Array.isArray(material)) { summaryRequests++; return '{"summary":"All evidence","annotations":[]}' }
      sourceRequests++
      return JSON.stringify({ summary: 'Batch evidence', annotations: material.passages.map((row: { id: string }) => ({ passageId: row.id, category: 'evidence', comment: 'Evidence' })) })
    })
    const saveAnnotations = vi.fn(async (_host, _snapshot, annotations) => ({ created: annotations.length, skipped: 0, failed: 0, unprocessed: 0, warnings: [] }))
    const options = { zotero: host, itemID: 42, fetchImpl: vi.fn(), signal: new AbortController().signal, task,
      checkpoint: async () => !(failCheckpoint && task.inputPlan?.level === 1),
      services: { readPdf: async () => snapshot, send, saveAnnotations, validateSource: async () => {} } }
    await expect(runIndependentPaperAnalysis(options)).rejects.toMatchObject({ code: 'ANALYSIS_STORAGE' })
    expect(summaryRequests).toBe(0)
    const batches = sourceRequests
    task.inputPlan = JSON.parse(JSON.stringify(task.inputPlan)); failCheckpoint = false
    const result = await runIndependentPaperAnalysis(options)
    expect(sourceRequests).toBe(batches)
    expect(summaryRequests).toBe(1)
    expect(result.annotations.created).toBe(192)
    expect(result.continuation).toBeUndefined()
  })
})
