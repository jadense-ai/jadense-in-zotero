/** 真实解析入口的模型预算、全文覆盖及检查点恢复，生成只使用合成响应。 */
import { describe, expect, it, vi } from 'vitest'
import { runIndependentPaperAnalysis } from './paper-analysis-runner'
import { newAnalysisTask } from './analysis-task-store'
import { textTokenCost } from './model-budget'
import { responseFormatInstructions } from '@/chat/response-format'
import type { PdfAnalysisSnapshot } from './reader-tools'
import type { ZoteroLike } from './runtime'

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
    const readPdf = vi.fn(async () => snapshot)
    const send = vi.fn(async input => { prompts.push(input.messages[0].text); return '{"summary":"Evidence retained","sections":[],"annotations":[]}' })
    let rejectCheckpoint = true
    const options = { zotero: host, itemID: 42, fetchImpl: vi.fn(), signal: new AbortController().signal, task,
      checkpoint: async () => !(rejectCheckpoint && task.inputPlan?.results.length === 1 && task.generation === 'new'),
      services: { readPdf, send, validateSource: async () => {} } }
    await expect(runIndependentPaperAnalysis(options)).rejects.toMatchObject({ code: 'ANALYSIS_STORAGE' })
    rejectCheckpoint = false
    await runIndependentPaperAnalysis(options)
    expect(prompts.filter(value => value === prompts[0])).toHaveLength(1)
    expect(readPdf).toHaveBeenCalledOnce()
    expect(task.generation).toBe('complete')
  })
})
