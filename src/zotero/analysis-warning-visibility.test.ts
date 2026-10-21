/** 解析成果 DOM 回归：技术抽样说明不显示，实际错误只反馈一次，已有模型正文保持原样。 */
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaperAnalysisRecord } from '@/chat/paper-analysis-history'
import { mountAnalysisWorkspace } from './analysis-workspace'
import { initializeUiLocale } from './ui-preferences'

vi.mock('./document-jobs', () => ({ documentJobs: () => ({ list: () => [], get: () => undefined, subscribe: () => () => {}, ready: Promise.resolve() }) }))
vi.mock('./reference-workspace', () => ({ mountReferenceDetails: () => ({ update: () => {}, suspend: () => {}, pause: () => {}, remove: () => {} }) }))
vi.mock('./analysis-runtime', () => ({ analysisRuntime: () => ({ start: vi.fn() }) }))

const sampling = '为控制解析长度，均匀选取 1200/4931 个可定位原句；结论仅基于这些原句。'
const samplingEn = 'Analysis uses an evenly sampled 1200/4931 passages with usable coordinates; conclusions are limited to these passages.'
const pageFailure = '第 2 页的文字坐标读取失败，未纳入解析。'
const disposals: Array<() => void> = []

afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose())
  initializeUiLocale({ locale: 'zh-CN' })
})

/** 用隔离 DOM 挂载真实解析界面，仅替换无关引用任务和运行调度。 */
function mount(record: PaperAnalysisRecord, unsaved = false) {
  const dom = new JSDOM('<!doctype html><main></main>'), root = dom.window.document.querySelector('main')!
  const workspace = mountAnalysisWorkspace(root, {}, { records: () => [record], unsaved: () => unsaved,
    openSource: async () => true, stop: () => {}, onReferenceTask: () => {} })
  workspace.open(record.source)
  disposals.push(() => { workspace.remove(); dom.window.close() })
  return { root, workspace }
}

function record(warnings: string[]): PaperAnalysisRecord {
  return { id: 'analysis-fixture', createdAt: '2026-10-21T01:50:29Z', source: { itemID: 42, libraryID: 1, itemKey: 'PDF42', title: 'Synthetic paper', authors: [] },
    summary: '已有研究总结', notes: '已有解析笔记', warnings }
}

describe('analysis warning visibility', () => {
  it.each(['zh-CN', 'en-US'])('hides both legacy technical templates and marks saved analysis complete in %s', locale => {
    initializeUiLocale({ locale })
    const { root } = mount(record([sampling, samplingEn]))
    expect(root.textContent).not.toContain('1200/4931')
    expect(root.querySelector('.jdx-badge')?.textContent).toBe(locale === 'zh-CN' ? '已解析' : 'Analyzed')
    expect(root.querySelector('.jdx-badge')?.getAttribute('data-state')).toBe('success')
    expect(root.querySelector('.jdx-analysis-summary')?.textContent).toContain('已有研究总结')
  })

  it('retains a real page-read warning and avoids duplicating the same run feedback', () => {
    const fixture = record([sampling, pageFailure]), { root, workspace } = mount(fixture)
    expect(root.textContent).not.toContain(sampling)
    expect(root.querySelector('.jdx-badge')?.textContent).toBe('结果待核对')
    expect(root.textContent?.split(pageFailure)).toHaveLength(2)
    workspace.setRun({ source: fixture.source, message: pageFailure, busy: false, error: true, createdAt: fixture.createdAt })
    expect(root.textContent?.split(pageFailure)).toHaveLength(2)
    expect(root.querySelector('.jdx-detail-run')?.textContent).toContain(pageFailure)
  })

  it('preserves saved model prose and unsaved-result feedback while hiding separate technical warnings', () => {
    const fixture = record([sampling])
    fixture.summary = `保留模型原文：${sampling}`
    const { root } = mount(fixture, true)
    expect(root.querySelector('.jdx-analysis-summary')?.textContent).toContain(fixture.summary)
    expect(root.querySelector('.jdx-analysis-detail')?.textContent).toContain('最新结果尚未完整保存')
    expect([...root.querySelectorAll('.jdx-notice')].every(notice => !notice.textContent?.includes(sampling))).toBe(true)
  })
})
